import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ApiConnections } from '../server/api-connections.mjs';
import { createResearchProviders } from '../server/research-providers.mjs';
import { AcquisitionReviews } from '../server/acquisition-reviews.mjs';
import {
  AcquisitionSchedules,
  validateTiming,
  nextOccurrence,
} from '../server/acquisition-schedules.mjs';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { withApp } from './helpers/http.mjs';
import { scheduleRepeatLabel } from '../src/domain/schedule-timing.mjs';

const input = {
  country: 'United States',
  region: 'Florida',
  product: 'outdoor zip screens',
  acquisition_channel: 'tavily_web',
  search_query: 'outdoor zip screens Florida United States',
  target_count: 1,
};
const timing = {
  repeat: 'daily',
  startDate: '2030-01-01',
  times: ['09:00', '14:30', '18:00'],
  timezone: 'Asia/Shanghai',
};
const nativeEnv = {
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

test('模型配置无需读取目录，HTTP 保存和重载后研究请求使用配置的模型及原密钥', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'connection-model-config-'));
  const path = join(dir, 'connections.json');
  const requests = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/responses');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer ' + nativeEnv.DEEPSEEK_API_KEY);
    requests.push(JSON.parse(options.body).model);
    return Response.json({});
  };
  try {
    await withApp({ env: { ...nativeEnv, CONNECTIONS_PATH: path }, fetchImpl }, async (base) => {
      const removed = await fetch(base + '/api/v1/connections/models', { method: 'POST' });
      assert.equal(removed.status, 404);
      const response = await fetch(base + '/api/v1/connections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { RESEARCH_MODEL_MODEL: 'replacement-model' }, clear: [] }),
      });
      assert.equal(response.status, 200);
      const view = await response.json();
      assert.equal(
        view.fields.find((field) => field.key === 'RESEARCH_MODEL_MODEL').effectiveValue,
        'replacement-model',
      );
      assert.deepEqual(requests, [], '配置读取和保存不请求模型服务');
      const restored = new ApiConnections({ env: nativeEnv, path });
      const research = createResearchProviders({ env: restored.environment(), fetchImpl });
      await research.model.research({
        messages: [{ role: 'user', content: 'fixture evidence' }],
        schema: { type: 'object', properties: {} },
      });
      assert.deepEqual(requests, ['replacement-model']);
      assert.equal(restored.environment().DEEPSEEK_API_KEY, nativeEnv.DEEPSEEK_API_KEY);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    { repeat: 'once', times: ['09:00', '18:00'] },
    { repeat: 'once', times: ['07:00'] },
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

test('每周多选校验、排序及旧计划兼容，拒绝空选和非法星期', () => {
  const weekly = { ...timing, repeat: 'weekly', weekdays: [5, 1, 3] };
  assert.deepEqual(validateTiming(weekly).weekdays, [1, 3, 5]);
  assert.equal(scheduleRepeatLabel(weekly), '每周一、三、五');
  assert.deepEqual(validateTiming({ ...timing, repeat: 'weekly' }).weekdays, [2]);
  assert.equal(scheduleRepeatLabel({ ...timing, repeat: 'weekly' }), '每周二');
  for (const weekdays of [[], null, '1', [0], [8], [1.5], ['1'], [1, 1], [1, 2, 3, 4, 5, 6, 7, 8]])
    assert.throws(() => validateTiming({ ...weekly, weekdays }), { status: 400 });
});

test('所选星期与开始日期独立，按北京时间跨日、跨周、跨年推进多个时间点', () => {
  const weekly = {
    repeat: 'weekly',
    startDate: '2026-11-05',
    times: ['00:15', '18:00'],
    weekdays: [1, 3, 5],
  };
  for (const [after, expected] of [
    ['2026-11-03T00:00:00+08:00', '2026-11-06T00:15:00+08:00'],
    ['2026-11-06T00:15:00+08:00', '2026-11-06T18:00:00+08:00'],
    ['2026-11-06T18:00:00+08:00', '2026-11-09T00:15:00+08:00'],
    ['2026-12-31T23:59:00+08:00', '2027-01-01T00:15:00+08:00'],
  ])
    assert.equal(nextOccurrence(weekly, Date.parse(after)), new Date(expected).toISOString());
  const allDays = { ...weekly, weekdays: [1, 2, 3, 4, 5, 6, 7] };
  let after = Date.parse('2026-11-05T00:00:00+08:00');
  for (let i = 0; i < 20; i++) {
    const next = nextOccurrence(allDays, after);
    assert.equal(next, nextOccurrence({ ...allDays, repeat: 'daily' }, after));
    after = Date.parse(next);
  }
});

test('每周多选保存重载后只触发所选星期，暂停恢复跳过已过时间', () => {
  const folder = mkdtempSync(join(tmpdir(), 'shadeflow-weekdays-'));
  const path = join(folder, 'schedules.sqlite');
  const fixture = harness({ path });
  let schedules = fixture.schedules;
  let clock = Date.parse('2030-01-02T09:00:00+08:00');
  try {
    const plan = schedules.create(
      { name: '每周多天', input, timing: { ...timing, repeat: 'weekly', weekdays: [1, 3, 5] } },
      'schedule-weekdays-01',
    );
    assert.equal(plan.nextRunAt, '2030-01-02T01:00:00.000Z');
    schedules.close();
    schedules = new AcquisitionSchedules({
      path,
      jobs: () => fixture.jobs,
      ready: () => true,
      available: () => true,
      now: () => clock,
    });
    assert.deepEqual(schedules.get(plan.id).timing.weekdays, [1, 3, 5]);
    schedules.tick();
    assert.equal(schedules.get(plan.id).runs, 1);
    assert.equal(schedules.get(plan.id).nextRunAt, '2030-01-02T06:30:00.000Z');
    schedules.tick();
    assert.equal(fixture.jobs.list().length, 1);
    fixture.jobs.finish(fixture.jobs.get(schedules.get(plan.id).lastJobId), 'target_reached');
    schedules.control(plan.id, 'pause');
    clock = Date.parse('2030-01-04T18:00:00+08:00');
    assert.equal(schedules.control(plan.id, 'resume').nextRunAt, '2030-01-07T01:00:00.000Z');
  } finally {
    schedules.close();
    fixture.jobs.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('计划分钟内正常执行且不重复，多个时点逐次推进', () => {
  const { jobs, schedules, advance } = harness();
  try {
    const plan = schedules.create({ name: '多时点计划', input, timing }, 'schedule-slots-01');
    for (const slot of timing.times) {
      advance(`2030-01-01T${slot}:20+08:00`);
      schedules.tick();
      const current = schedules.get(plan.id);
      assert.equal(current.lastScheduledAt, new Date(`2030-01-01T${slot}:00+08:00`).toISOString());
      const count = jobs.list().length;
      schedules.tick();
      assert.equal(jobs.list().length, count);
      jobs.finish(jobs.get(current.lastJobId), 'target_reached');
    }
    assert.equal(schedules.get(plan.id).status, 'enabled');
    assert.equal(schedules.get(plan.id).runs, 3);
    assert.equal(schedules.get(plan.id).nextRunAt, '2030-01-02T01:00:00.000Z');
  } finally {
    schedules.close();
    jobs.close();
  }
});

test('错过一分钟或多天的时点不补跑；忙碌时跳过且不打断正在执行的任务', () => {
  const { jobs, schedules, advance } = harness();
  try {
    const plan = schedules.create({ name: '跳过时点', input, timing }, 'schedule-skip-01');
    advance('2030-01-01T09:01:00+08:00');
    schedules.tick();
    assert.equal(jobs.list().length, 0);
    assert.equal(schedules.get(plan.id).nextRunAt, '2030-01-01T06:30:00.000Z');
    advance('2030-01-01T14:30:00+08:00');
    schedules.tick();
    const active = jobs.active();
    assert.ok(active);
    advance('2030-01-01T18:00:00+08:00');
    schedules.tick();
    assert.equal(jobs.list().length, 1);
    assert.equal(jobs.active().id, active.id);
    assert.match(schedules.get(plan.id).lastError, /跳过/);
    jobs.finish(jobs.get(active.id), 'target_reached');
    advance('2030-01-04T19:00:00+08:00');
    schedules.tick();
    schedules.tick();
    assert.equal(jobs.list().length, 1);
    assert.equal(schedules.get(plan.id).nextRunAt, '2030-01-05T01:00:00.000Z');
  } finally {
    schedules.close();
    jobs.close();
  }
});

test('单次任务只允许一个时点，错过后结束且不伪造已执行次数', () => {
  const { jobs, schedules, advance } = harness();
  try {
    const plan = schedules.create(
      { name: '单次计划', input, timing: { ...timing, repeat: 'once', times: ['09:00'] } },
      'schedule-once-01',
    );
    advance('2030-01-01T09:01:00+08:00');
    schedules.tick();
    const current = schedules.get(plan.id);
    assert.equal(current.status, 'completed');
    assert.equal(current.runs, 0);
    assert.equal(current.nextRunAt, null);
    assert.match(current.lastError, /错过/);
    assert.equal(jobs.list().length, 0);
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

test('API 未配置时跳过该时点；暂停后恢复跳过暂停期间时间点，关闭保留历史', () => {
  let ready = false;
  const { jobs, schedules, advance } = harness({ ready: () => ready });
  try {
    const plan = schedules.create({ name: '等待计划', input, timing }, 'schedule-pause-01');
    advance('2030-01-01T09:00:00+08:00');
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
  await withApp(
    {
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
    },
    async (base) => {
      const write = (path, body, method = 'POST', key = 'http-schedules-01') =>
        fetch(base + path, {
          method,
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
          body: JSON.stringify(body),
        });
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
      const repeat = await write('/api/v1/acquisition/schedules', body);
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
      const weekly = await write(
        '/api/v1/acquisition/schedules',
        { ...body, timing: { ...timing, repeat: 'weekly', weekdays: [5, 1, 3] } },
        'POST',
        'http-weekdays-01',
      );
      assert.equal(weekly.status, 201);
      const weeklyPlan = await weekly.json();
      assert.deepEqual(weeklyPlan.timing.weekdays, [1, 3, 5]);
      const listed = await (await fetch(base + '/api/v1/acquisition/schedules')).json();
      assert.deepEqual(
        listed.schedules.find((item) => item.id === weeklyPlan.id).timing.weekdays,
        [1, 3, 5],
      );
      assert.equal((await write('/api/v1/acquisition/runs', input)).status, 409);
      assert.equal((await write('/api/v1/connections', { values: {} }, 'PUT')).status, 409);
    },
  );
});

test('HTTP 读取已执行计划及最近任务，保留核实结果并可关闭计划', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'shadeflow-schedule-read-'));
  const env = {
    ...nativeEnv,
    BATCH_DB_PATH: join(folder, 'jobs.sqlite'),
    SCHEDULE_DB_PATH: join(folder, 'schedules.sqlite'),
  };
  const scope = createHash('sha256')
    .update(JSON.stringify([env.FEISHU_APP_TOKEN, env.FEISHU_TABLE_ID]))
    .digest('hex');
  const jobs = new BatchJobs({ path: env.BATCH_DB_PATH, scope, schedule: false });
  const schedules = new AcquisitionSchedules({
    path: env.SCHEDULE_DB_PATH,
    jobs: () => jobs,
    scope,
  });
  try {
    const job = jobs.create(input, 'schedule-read-job');
    job.queue = [{ domain: 'example.com' }];
    job.rows = [{ result: 'review', domain: 'example.com' }];
    jobs.finish(job, 'stopped');
    new AcquisitionReviews(jobs.db, scope).save(job.id, 0, { status: 'inserted' });
    const plan = schedules.create({ name: '已执行计划', input, timing }, 'schedule-read-plan');
    schedules.save({ ...plan, status: 'paused', lastJobId: job.id, runs: 1 });
    const fresh = schedules.create({ name: '未执行计划', input, timing }, 'schedule-read-fresh');
    schedules.save({ ...fresh, status: 'paused' });
    const archived = schedules.create(
      { name: '历史任务归档', input, timing },
      'schedule-read-archived',
    );
    schedules.save({ ...archived, status: 'paused', lastJobId: 'archived-job' });
    schedules.close();
    jobs.close();
    await withApp({ env }, async (base) => {
      const path = '/api/v1/acquisition/schedules';
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      const { schedules: listed } = await response.json();
      assert.equal(listed.length, 3);
      const recent = listed.find((item) => item.id === plan.id).lastJob;
      assert.equal(recent.queued, 0);
      assert.equal(recent.rows[0].review_resolution.status, 'inserted');
      assert.equal('queue' in recent, false);
      assert.equal(listed.find((item) => item.id === fresh.id).lastJob, null);
      assert.equal(listed.find((item) => item.id === archived.id).lastJob, null);
      const closed = await fetch(base + `${path}/${plan.id}/close`, { method: 'POST' });
      assert.equal(closed.status, 200);
      assert.equal((await closed.json()).lastJob.queued, 0);
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
