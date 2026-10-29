import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { createApp } from '../server/app.mjs';

const input = {
  country: 'United States',
  product_scope: 'all',
  product: 'window coverings',
  audience: 'BC',
  acquisition_channel: 'web',
  query_mode: 'auto',
  target_count: 20,
};
const env = {
  ACQUISITION_PROVIDER: 'native',
  TAVILY_API_KEY: 'fixture-search',
  DEEPSEEK_API_KEY: 'fixture-model',
  FEISHU_APP_ID: 'fixture-app',
  FEISHU_APP_SECRET: 'fixture-secret',
  FEISHU_APP_TOKEN: 'fixture-token',
  FEISHU_TABLE_ID: 'fixture-table',
};

test('待核实企业改正官网后走研究写入、刷新后保留结果且不改历史任务计数', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'acquisition-review-'));
  const settings = { ...env, BATCH_DB_PATH: join(folder, 'acquisition.sqlite') };
  const scope = createHash('sha256')
    .update(JSON.stringify([env.FEISHU_APP_TOKEN, env.FEISHU_TABLE_ID]))
    .digest('hex');
  const manager = new BatchJobs({
    path: settings.BATCH_DB_PATH,
    scope,
    provider: 'native',
    schedule: false,
  });
  const job = {
    id: 'review-job',
    scope,
    provider: 'native',
    input,
    status: 'partial',
    reason: 'stopped',
    target: 20,
    inserted: 0,
    updated: 0,
    skipped: 0,
    rejected: 0,
    failed: 0,
    pending: 0,
    review: 1,
    searches: 1,
    researched: 1,
    createdAt: new Date().toISOString(),
    queue: [],
    seen: [],
    skippedDomains: [],
    searchSignatures: [],
    rows: [
      {
        result: 'review',
        source_url: 'https://old.example.org/',
        domain: 'old.example.org',
        source_title: '旧候选页面标题',
        operation_id: 'old-operation',
        reason: '官网主体尚未核实',
      },
    ],
  };
  manager.db
    .prepare('INSERT INTO jobs VALUES(?,?,?,?)')
    .run(job.id, 'review-fixture', 'fixture', JSON.stringify(job));
  manager.close();
  let researchCalls = 0;
  let statusCalls = 0;
  const outputs = new Map();
  const evidence = new Map([
    ['old-operation', { research: { company_name: '旧候选', products: [] } }],
  ]);
  const nativeImpl = {
    store: { get: (id) => evidence.get(id) },
    async research(_target, item) {
      researchCalls++;
      assert.equal(item.operation_id.startsWith('review-'), true);
      assert.equal(item.source_title, '');
      evidence.set(item.operation_id, {
        research: {
          company_name: item.source_url.includes('old.') ? '旧候选' : '更正后企业',
          products: ['blinds'],
        },
      });
      const output =
        item.source_url === 'https://old.example.org/'
          ? { outcome: 'review', reason: '官网仍缺少主体证据' }
          : {
              新增: 1,
              明细: [
                {
                  result: 'inserted',
                  source_url: 'https://www.new.example.org/',
                  record_id: 'rec-new',
                },
              ],
              reason: '飞书新增并读回核验成功',
            };
      outputs.set(item.operation_id, output);
      return output;
    },
    async status(id) {
      statusCalls++;
      return outputs.has(id)
        ? { settled: true, output: outputs.get(id) }
        : { settled: false, reason: '操作记录不存在，未自动重放' };
    },
    close() {},
  };
  const start = async () => {
    const app = createApp({
      env: settings,
      nativeImpl,
      fetchImpl: async () => {
        throw new Error('external request');
      },
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    return { app, root: `http://127.0.0.1:${app.address().port}/api/v1/acquisition` };
  };
  let server;
  try {
    server = await start();
    const post = (url, key) =>
      fetch(`${server.root}/jobs/review-job/reviews/0`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ source_url: url }),
      });
    assert.equal((await post('https://old.example.org/', 'review-first')).status, 200);
    assert.equal(
      (await (await post('https://old.example.org/', 'review-first')).json()).resolution.status,
      'review',
    );
    assert.equal(researchCalls, 1);
    assert.equal((await post('http://127.0.0.1/private', 'review-bad-url')).status, 400);
    const corrected = await post('https://new.example.org/', 'review-second');
    assert.equal(corrected.status, 200);
    assert.equal((await corrected.json()).resolution.status, 'inserted');
    assert.equal(researchCalls, 2);
    assert.equal(
      (await (await fetch(`${server.root}/jobs/review-job/reviews/0`)).json()).evidence
        .company_name,
      '更正后企业',
    );
    let snapshot = await (await fetch(`${server.root}/jobs/review-job`)).json();
    assert.equal(snapshot.inserted, 0);
    assert.equal(snapshot.review, 1);
    assert.equal(snapshot.rows[0].review_resolution.record_id, 'rec-new');
    assert.equal((await post('https://new.example.org/', 'review-third')).status, 409);
    await new Promise((resolve) => server.app.close(resolve));
    server = await start();
    snapshot = await (await fetch(`${server.root}/jobs/review-job`)).json();
    assert.equal(snapshot.rows[0].review_resolution.status, 'inserted');
    assert.equal(snapshot.inserted, 0);
    assert.equal(statusCalls, 0);
  } finally {
    if (server?.app.listening) await new Promise((resolve) => server.app.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  }
});

test('结果不明只能核对原操作，换编号不会重复写入', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'acquisition-review-uncertain-'));
  const settings = { ...env, BATCH_DB_PATH: join(folder, 'acquisition.sqlite') };
  const scope = createHash('sha256')
    .update(JSON.stringify([env.FEISHU_APP_TOKEN, env.FEISHU_TABLE_ID]))
    .digest('hex');
  const manager = new BatchJobs({
    path: settings.BATCH_DB_PATH,
    scope,
    provider: 'native',
    schedule: false,
  });
  const job = {
    id: 'uncertain-job',
    scope,
    provider: 'native',
    input,
    status: 'partial',
    reason: 'stopped',
    target: 20,
    inserted: 0,
    updated: 0,
    skipped: 0,
    rejected: 0,
    failed: 0,
    pending: 0,
    review: 1,
    searches: 1,
    researched: 1,
    createdAt: new Date().toISOString(),
    queue: [],
    seen: [],
    skippedDomains: [],
    searchSignatures: [],
    rows: [
      {
        result: 'review',
        source_url: 'https://company.example.org/',
        domain: 'company.example.org',
      },
    ],
  };
  manager.db
    .prepare('INSERT INTO jobs VALUES(?,?,?,?)')
    .run(job.id, 'uncertain-fixture', 'fixture', JSON.stringify(job));
  manager.close();
  let calls = 0;
  let settled = false;
  const app = createApp({
    env: settings,
    nativeImpl: {
      async research() {
        calls++;
        throw new Error('remote outcome unknown');
      },
      async status() {
        return settled
          ? { settled: true, output: { outcome: 'review', reason: '仍缺少证据' } }
          : { settled: false, reason: '写入尚未确认' };
      },
      close() {},
    },
    fetchImpl: async () => {
      throw new Error('external request');
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${app.address().port}/api/v1/acquisition/jobs/uncertain-job/reviews/0`;
  const post = (key) =>
    fetch(root, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ source_url: 'https://company.example.org/' }),
    });
  try {
    await fetch(root);
    const check = new DatabaseSync(settings.BATCH_DB_PATH);
    const runningJob = JSON.parse(
      check.prepare('SELECT data FROM jobs WHERE id=?').get(job.id).data,
    );
    runningJob.status = 'running';
    check.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(runningJob), job.id);
    assert.equal((await post('while-running')).status, 409);
    assert.equal((await (await fetch(`${root.split('/reviews/')[0]}`)).json()).status, 'running');
    runningJob.status = 'partial';
    check.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(runningJob), job.id);
    check.close();
    assert.equal((await post('uncertain-one')).status, 409);
    assert.equal((await post('uncertain-two')).status, 409);
    assert.equal(calls, 1);
    assert.equal((await (await fetch(root)).json()).resolution.status, 'uncertain');
    assert.equal((await post('uncertain-one')).status, 409);
    settled = true;
    assert.equal((await (await post('uncertain-one')).json()).resolution.status, 'review');
    assert.equal(calls, 1);
    assert.equal((await post('uncertain-two')).status, 409);
    assert.equal(calls, 2);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  }
});
