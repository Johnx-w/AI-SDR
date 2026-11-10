import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { AcquisitionSchedules } from '../server/acquisition-schedules.mjs';
import { createApp } from '../server/app.mjs';
import { loadModule } from './helpers/modules.mjs';
import { createModuleLoader } from './helpers/modules.mjs';
import React from 'react';

const { acquisitionApi } = loadModule(new URL('../src/services/acquisition.ts', import.meta.url));

test('展开摘要才读取详情，更新时间变化后刷新，旧请求不能覆盖新任务', async () => {
  const states = [];
  const effects = [];
  const reads = [];
  let index = 0;
  const load = createModuleLoader((specifier, path) => {
    if (!path.pathname.endsWith('/BatchProgress.tsx')) return;
    if (specifier === 'react')
      return {
        ...React,
        useState(initial) {
          const current = index++;
          if (!(current in states)) states[current] = initial;
          return [
            states[current],
            (value) => {
              states[current] = typeof value === 'function' ? value(states[current]) : value;
            },
          ];
        },
        useEffect(effect, deps) {
          effects.push({ effect, deps });
        },
      };
    if (specifier === '../services/acquisition')
      return {
        acquisitionApi: {
          job(id, signal) {
            return new Promise((resolve, reject) => reads.push({ id, signal, resolve, reject }));
          },
        },
      };
  });
  const { BatchProgress } = load(new URL('../src/components/BatchProgress.tsx', import.meta.url));
  const render = (job) => {
    index = 0;
    return BatchProgress({ job, busy: false, control() {} });
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const first = { id: 'first', summary: true, updatedAt: 'v1', rows: [] };
  render(first);
  assert.equal(reads.length, 0);
  const cleanup = effects.at(-1).effect();
  assert.equal(reads[0].id, 'first');
  render({ ...first, updatedAt: 'v2' });
  assert.notDeepEqual(effects[0].deps, effects[1].deps);
  cleanup();
  assert.equal(reads[0].signal.aborted, true);
  render({ ...first, id: 'second' });
  const cleanupSecond = effects.at(-1).effect();
  reads[1].resolve({ id: 'second', rows: [{ result: 'inserted' }] });
  await flush();
  reads[0].resolve({ id: 'first', rows: [] });
  await flush();
  assert.equal(states[0].id, 'second');
  assert.equal(states[0].rows.length, 1);
  cleanupSecond();
  render({ id: 'full', rows: [] });
  effects.at(-1).effect();
  assert.equal(reads.length, 2, '完整任务沿用原数据，不重复读取');
});

test('获客列表拒绝无效 JSON 和缺少列表的成功响应，避免页面白屏', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const body of ['<html>连接中断</html>', '{}', 'null']) {
      globalThis.fetch = async () => new Response(body);
      await assert.rejects(acquisitionApi.schedules(), /JSON|列表/);
      await assert.rejects(acquisitionApi.jobs(), /JSON|列表/);
    }
    for (const name of ['schedules', 'jobs']) {
      globalThis.fetch = async (path) => {
        assert.equal(path, `/api/v1/acquisition/${name}?summary=1`);
        return Response.json({ [name]: [] });
      };
      assert.deepEqual(await acquisitionApi[name](), { [name]: [] });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('计划与执行摘要不携带历史明细，完整接口和原始数据保持不变', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'acquisition-loading-'));
  const env = {
    BATCH_DB_PATH: join(folder, 'jobs.sqlite'),
    SCHEDULE_DB_PATH: join(folder, 'schedules.sqlite'),
  };
  const manager = new BatchJobs({ path: env.BATCH_DB_PATH, schedule: false });
  const job = {
    id: 'large-history',
    input: { country: 'United States', product: 'blinds', target_count: 20 },
    status: 'completed',
    reason: 'target_reached',
    inserted: 20,
    target: 20,
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T01:00:00Z',
    rows: Array.from({ length: 200 }, (_, index) => ({
      result: 'inserted',
      domain: `company${index}.example`,
      handoff: { evidence: 'x'.repeat(10000) },
    })),
    queue: [],
    seen: [],
    queryPlan: [{ query: 'x'.repeat(10000) }],
    searchStats: [{ query: 'blinds', inserted: 20 }],
  };
  manager.db
    .prepare('INSERT INTO jobs VALUES(?,?,?,?)')
    .run(job.id, 'fixture-history', 'fixture', JSON.stringify(job));
  const schedules = new AcquisitionSchedules({ path: env.SCHEDULE_DB_PATH, jobs: () => manager });
  const plan = { id: 'plan-history', status: 'paused', input: job.input, lastJobId: job.id };
  schedules.db
    .prepare('INSERT INTO schedules VALUES(?,?,?,?)')
    .run(plan.id, 'fixture-plan', 'fixture', JSON.stringify(plan));
  schedules.close();
  manager.close();
  const app = createApp({ env });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}/api/v1/acquisition`;
  try {
    for (const name of ['jobs', 'schedules']) {
      const response = await fetch(`${base}/${name}?summary=1`);
      assert.equal(response.status, 200);
      const raw = await response.text();
      assert.ok(Buffer.byteLength(raw) < 10000, '首屏大小不随历史证据增长');
      const record = JSON.parse(raw)[name][0];
      const summary = name === 'jobs' ? record : record.lastJob;
      assert.equal(summary.summary, true);
      assert.equal(summary.inserted, 20);
      assert.deepEqual(summary.rows, []);
      assert.equal(summary.searchStats, undefined);
      assert.equal(summary.queryPlan, undefined);
      const full = await (await fetch(`${base}/${name}`)).json();
      const detail = name === 'jobs' ? full.jobs[0] : full.schedules[0].lastJob;
      assert.equal(detail.rows.length, 200);
      assert.equal(detail.rows[199].handoff.evidence.length, 10000);
      assert.deepEqual(detail.searchStats, job.searchStats);
    }
    const detail = await (await fetch(`${base}/jobs/${job.id}`)).json();
    assert.equal(detail.rows.length, 200);
    assert.equal(detail.summary, undefined);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  }
});
