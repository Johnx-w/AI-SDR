import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiConnections } from '../server/api-connections.mjs';
import {
  AcquisitionSchedules,
  validateTiming,
  nextOccurrence,
} from '../server/acquisition-schedules.mjs';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { createApp } from '../server/app.mjs';

const input = {
  country: 'United States',
  region: 'Florida',
  product: 'outdoor zip screens',
  acquisition_channel: 'tavily_web',
  search_query: 'outdoor zip screens Florida United States',
  target_count: 1,
};
const timing = {
  repeat: 'once',
  startDate: '2030-01-01',
  times: ['09:00', '14:30', '18:00'],
  timezone: 'Asia/Shanghai',
};
const nativeEnv = {
  ACQUISITION_PROVIDER: 'native',
  TAVILY_API_KEY: 'fixture-search-key',
  DEEPSEEK_API_KEY: 'fixture-model-key',
  FEISHU_APP_ID: 'fixture-app',
  FEISHU_APP_SECRET: 'fixture-app-secret',
  FEISHU_APP_TOKEN: 'fixture-table-token',
  FEISHU_TABLE_ID: 'fixture-table',
};

test('连接配置持久化、重载、空值保留与显式清除；读取不回传密钥且拒绝任意配置', () => {
  const folder = mkdtempSync(join(tmpdir(), 'shadeflow-connections-'));
  const path = join(folder, 'connections.json');
  try {
    const connections = new ApiConnections({ env: nativeEnv, path });
    const view = connections.update({ values: { TAVILY_API_KEY: 'replacement-secret' } });
    for (const secret of [
      'replacement-secret',
      nativeEnv.FEISHU_APP_SECRET,
      nativeEnv.FEISHU_APP_TOKEN,
    ])
      assert.equal(JSON.stringify(view).includes(secret), false);
    let restored = new ApiConnections({ env: nativeEnv, path });
    restored.update({ values: { TAVILY_API_KEY: '' } });
    assert.equal(restored.environment().TAVILY_API_KEY, 'replacement-secret');
    assert.throws(() => restored.update({ values: { CONNECTIONS_PATH: 'other.json' } }), {
      status: 400,
    });
    restored.update({ values: {}, clear: ['TAVILY_API_KEY'] });
    restored = new ApiConnections({ env: nativeEnv, path });
    assert.equal(restored.environment().TAVILY_API_KEY, '');
    assert.equal(restored.view().ready, false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('多时间点按北京时间排序，拒绝重复时间和无效日期；兼容旧单时间与每周计划', () => {
  const now = Date.parse('2030-01-01T08:00:00+08:00');
  assert.deepEqual(validateTiming({ ...timing, times: ['18:00', '09:00'] }, now).times, [
    '09:00',
    '18:00',
  ]);
  for (const changes of [
    { times: ['09:00', '09:00'] },
    { times: ['24:00'] },
    { startDate: '2030-02-30' },
    { timezone: 'UTC' },
    { times: ['07:00', '18:00'] },
  ])
    assert.throws(() => validateTiming({ ...timing, ...changes }, now), { status: 400 });
  const { times, ...legacy } = timing;
  assert.deepEqual(validateTiming({ ...legacy, time: '09:00' }, now).times, ['09:00']);
  assert.equal(
    nextOccurrence({ ...timing, repeat: 'weekly' }, Date.parse('2030-01-01T18:00:00+08:00')),
    '2030-01-08T01:00:00.000Z',
  );
});

function harness(extra = {}) {
  let clock = Date.parse('2030-01-01T08:00:00+08:00');
  const jobs = new BatchJobs({ schedule: false, now: () => clock });
  const schedules = new AcquisitionSchedules({
    jobs: () => jobs,
    ready: () => true,
    available: () => true,
    now: () => clock,
    ...extra,
  });
  return {
    jobs,
    schedules,
    advance: (value) => {
      clock = Date.parse(value);
    },
  };
}

test('延迟启动按原时间点排队，活跃任务阻止下一轮，重复 tick 不创建额外任务', () => {
  const { jobs, schedules, advance } = harness();
  try {
    const plan = schedules.create({ name: '多时点计划', input, timing }, 'schedule-slots-01');
    advance('2030-01-01T19:00:00+08:00');
    for (const slot of timing.times) {
      schedules.tick();
      const current = schedules.get(plan.id);
      assert.equal(current.lastScheduledAt, new Date(`2030-01-01T${slot}:00+08:00`).toISOString());
      const count = jobs.list().length;
      schedules.tick();
      assert.equal(jobs.list().length, count);
      jobs.finish(jobs.get(current.lastJobId), 'target_reached');
    }
    assert.equal(schedules.get(plan.id).status, 'completed');
    assert.equal(schedules.get(plan.id).runs, 3);
    assert.equal(jobs.list().length, 3);
  } finally {
    schedules.close();
    jobs.close();
  }
});

test('创建任务后计划记账中断，重启按固定幂等键关联原任务而不重建', () => {
  const folder = mkdtempSync(join(tmpdir(), 'shadeflow-schedules-'));
  const path = join(folder, 'schedules.sqlite');
  const fixture = harness({ path });
  let schedules = fixture.schedules;
  try {
    const plan = schedules.create({ name: '恢复计划', input, timing }, 'schedule-recovery-01');
    const key = `schedule-${plan.id}-${Date.parse(plan.nextRunAt)}`;
    const priorJob = fixture.jobs.create(input, key);
    schedules.close();
    schedules = new AcquisitionSchedules({
      path,
      jobs: () => fixture.jobs,
      ready: () => true,
      available: () => true,
      now: () => Date.parse('2030-01-01T09:05:00+08:00'),
    });
    schedules.tick();
    assert.equal(schedules.get(plan.id).lastJobId, priorJob.id);
    assert.equal(schedules.get(plan.id).runs, 1);
    assert.equal(fixture.jobs.list().length, 1);
  } finally {
    schedules.close();
    fixture.jobs.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('API 未配置时计划等待；暂停后恢复跳过暂停期间时间点，关闭保留历史', () => {
  let ready = false;
  const { jobs, schedules, advance } = harness({ ready: () => ready });
  try {
    const plan = schedules.create({ name: '等待计划', input, timing }, 'schedule-pause-01');
    advance('2030-01-01T09:05:00+08:00');
    schedules.tick();
    assert.equal(jobs.list().length, 0);
    assert.match(schedules.get(plan.id).lastError, /尚未配置/);
    schedules.control(plan.id, 'pause');
    ready = true;
    advance('2030-01-01T15:00:00+08:00');
    const resumed = schedules.control(plan.id, 'resume');
    assert.equal(resumed.nextRunAt, '2030-01-01T10:00:00.000Z');
    schedules.tick();
    assert.equal(jobs.list().length, 0);
    schedules.control(plan.id, 'close');
    assert.equal(schedules.list().length, 1);
    assert.equal(schedules.get(plan.id).status, 'closed');
  } finally {
    schedules.close();
    jobs.close();
  }
});

test('HTTP 保存连接即时生效；计划接口校验和幂等生效，未知单次结果阻止更换连接', async () => {
  const app = createApp({
    env: nativeEnv,
    fetchImpl: async () => {
      throw new Error('Unexpected external request');
    },
    nativeImpl: {
      run: async () => {
        throw Object.assign(new Error('结果待核对'), { status: 409 });
      },
      close() {},
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const write = (path, body, method = 'POST', key = 'http-schedules-01') =>
    fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    });
  try {
    const saved = await write(
      '/api/v1/connections',
      { values: { DEEPSEEK_MODEL: 'fixture-model' } },
      'PUT',
    );
    assert.equal(saved.status, 200);
    assert.equal(
      (await saved.json()).fields.find((f) => f.key === 'DEEPSEEK_MODEL').value,
      'fixture-model',
    );
    const body = { name: '接口计划', input, timing };
    const created = await write('/api/v1/acquisition/schedules', body);
    assert.equal(created.status, 201);
    const plan = await created.json();
    const repeat = await write('/api/v1/integrations/n8n/schedules', body);
    assert.equal((await repeat.json()).id, plan.id);
    assert.equal(
      (await write('/api/v1/acquisition/schedules', { ...body, name: '冲突计划' })).status,
      409,
    );
    assert.equal(
      (
        await write(
          '/api/v1/acquisition/schedules',
          { ...body, input: { ...input, target_count: 0 } },
          'POST',
          'invalid-count-01',
        )
      ).status,
      400,
    );
    assert.equal((await write('/api/v1/acquisition/runs', input)).status, 409);
    assert.equal((await write('/api/v1/connections', { values: {} }, 'PUT')).status, 409);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
