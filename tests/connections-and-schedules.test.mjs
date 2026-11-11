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
  repeat: 'weekly',
  weekdays: [1, 2, 3, 4, 5, 6, 7],
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

test('多时间点按北京时间排序，拒绝重复时间和无效日期', () => {
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
  assert.equal(
    nextOccurrence({ ...timing, weekdays: [2] }, Date.parse('2030-01-01T18:00:00+08:00')),
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

test('发布维护不改计划或启动新轮次，解除后跳过错过时点且不补跑', () => {
  let maintaining = true;
  const h = harness({ isMaintaining: () => maintaining });
  try {
    const plan = h.schedules.create(
      { name: '维护保留计划', input, timing },
      'maintenance-schedule',
    );
    h.advance('2030-01-01T09:00:00+08:00');
    h.schedules.tick();
    assert.deepEqual(h.schedules.get(plan.id), plan);
    assert.equal(h.jobs.list().length, 0);
    h.advance('2030-01-01T09:02:00+08:00');
    maintaining = false;
    h.schedules.tick();
    assert.equal(h.jobs.list().length, 0);
    assert.equal(h.schedules.get(plan.id).status, 'enabled');
    assert.equal(h.schedules.get(plan.id).nextRunAt, '2030-01-01T06:30:00.000Z');
  } finally {
    h.schedules.close();
    h.jobs.close();
  }
});

test('每周多选校验、排序，拒绝空选和非法星期', () => {
  const weekly = { ...timing, repeat: 'weekly', weekdays: [5, 1, 3] };
  assert.deepEqual(validateTiming(weekly).weekdays, [1, 3, 5]);
  assert.equal(scheduleRepeatLabel(weekly), '每周一、三、五');
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
  assert.equal(scheduleRepeatLabel(allDays), '每天');
  for (const [after, expected] of [
    ['2026-11-06T18:00:00+08:00', '2026-11-07T00:15:00+08:00'],
    ['2026-11-08T18:00:00+08:00', '2026-11-09T00:15:00+08:00'],
  ])
    assert.equal(nextOccurrence(allDays, Date.parse(after)), new Date(expected).toISOString());
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

test('恢复调度跳过过期时点但执行当前分钟，已创建的旧任务先恢复记账且不重复', () => {
  for (const time of ['14:30:00', '14:30:20', '14:30:59.999']) {
    for (const recoverCreated of [false, true]) {
      const { jobs, schedules, advance } = harness();
      try {
        const plan = schedules.create(
          { name: '恢复当前时点', input, timing },
          'schedule-current-minute',
        );
        if (recoverCreated) {
          const job = jobs.create(input, `schedule-${plan.id}-${Date.parse(plan.nextRunAt)}`);
          jobs.finish(job, 'target_reached');
        }
        advance(`2030-01-01T${time}+08:00`);
        schedules.tick();
        const current = schedules.get(plan.id);
        assert.equal(current.lastScheduledAt, '2030-01-01T06:30:00.000Z');
        assert.equal(current.nextRunAt, '2030-01-01T10:00:00.000Z');
        assert.equal(current.runs, recoverCreated ? 2 : 1);
        assert.equal(current.lastError, '');
        schedules.tick();
        assert.equal(jobs.list().length, recoverCreated ? 2 : 1);
      } finally {
        schedules.close();
        jobs.close();
      }
    }
  }
});

test('定时参数拒绝旧 daily、单 time 及缺少星期的格式', () => {
  const weekly = { ...timing, repeat: 'weekly', weekdays: [1, 3, 5] };
  for (const changes of [
    { repeat: 'daily' },
    { times: undefined, time: '09:00' },
    { weekdays: undefined },
  ])
    assert.throws(() => validateTiming({ ...weekly, ...changes }), { status: 400 });
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

test('关闭计划恢复后保留历史且只执行未来时点', () => {
  const { jobs, schedules, advance } = harness();
  try {
    const plan = schedules.create({ name: '可恢复计划', input, timing }, 'restore-plan-history');
    schedules.save({
      ...plan,
      status: 'closed',
      nextRunAt: null,
      lastJobId: 'archived-job',
      lastRunAt: '2030-01-01T01:00:00.000Z',
      runs: 3,
    });
    advance('2030-01-02T15:00:00+08:00');
    const restored = schedules.control(plan.id, 'resume');
    assert.equal(restored.status, 'enabled');
    assert.equal(restored.nextRunAt, '2030-01-02T10:00:00.000Z');
    assert.equal(restored.timing.repeat, 'weekly');
    assert.deepEqual(restored.timing.weekdays, timing.weekdays);
    assert.equal(restored.lastJobId, 'archived-job');
    assert.equal(restored.runs, 3);
    assert.equal(restored.lastRunAt, '2030-01-01T01:00:00.000Z');
    schedules.tick();
    assert.equal(jobs.list().length, 0, '恢复不补跑或重启旧任务');
    schedules.control(plan.id, 'close');
  } finally {
    schedules.close();
    jobs.close();
  }
});

test('过期单次计划和已达上限的关闭计划恢复失败，保持关闭状态', () => {
  const { jobs, schedules, advance } = harness();
  try {
    const once = schedules.create(
      {
        name: '单次计划',
        input,
        timing: {
          ...timing,
          repeat: 'once',
          times: ['09:00'],
        },
      },
      'restore-expired-once',
    );
    schedules.control(once.id, 'close');
    advance('2030-01-02T15:00:00+08:00');
    assert.throws(() => schedules.control(once.id, 'resume'), /没有未到的执行时间/);
    assert.equal(schedules.get(once.id).status, 'closed');
    const closed = schedules.create({ name: '关闭计划', input, timing }, 'restore-limit-closed');
    schedules.control(closed.id, 'close');
    for (let i = 0; i < 100; i++)
      schedules.create({ name: `计划${i}`, input, timing }, `restore-limit-${i}`);
    assert.throws(() => schedules.control(closed.id, 'resume'), /最多保留 100/);
    assert.equal(schedules.get(closed.id).status, 'closed');
  } finally {
    schedules.close();
    jobs.close();
  }
});

test('修改计划只影响后续轮次，保留执行历史与当前任务配置', () => {
  const { jobs, schedules, advance } = harness();
  try {
    const plan = schedules.create({ name: '原计划', input, timing }, 'schedule-edit-01');
    advance('2030-01-01T09:00:00+08:00');
    schedules.tick();
    const first = jobs.get(schedules.get(plan.id).lastJobId);
    const updatedInput = {
      ...input,
      product_scope: 'specific',
      products: [
        {
          value: 'roller blinds',
          label: '卷帘',
          direction: 'finished',
          group: 'indoor',
          aliases: [],
        },
      ],
      product: 'roller blinds',
      target_count: 5,
    };
    const updatedTiming = { ...timing, times: ['20:00'] };
    const updated = schedules.update(plan.id, {
      name: '新计划',
      input: updatedInput,
      timing: updatedTiming,
    });
    assert.equal(updated.name, '新计划');
    assert.equal(updated.runs, 1);
    assert.equal(updated.lastJobId, first.id);
    assert.equal(updated.nextRunAt, '2030-01-01T12:00:00.000Z');
    assert.equal(jobs.get(first.id).input.product, input.product);
    assert.equal(jobs.get(first.id).input.target_count, 1);
    jobs.finish(first, 'target_reached');
    advance('2030-01-01T14:30:00+08:00');
    schedules.tick();
    assert.equal(jobs.list().length, 1);
    advance('2030-01-01T20:00:00+08:00');
    schedules.tick();
    const second = jobs.get(schedules.get(plan.id).lastJobId);
    assert.equal(second.input.product_scope, 'specific');
    assert.deepEqual(second.input.products, updatedInput.products);
    assert.equal(second.input.product, 'roller blinds');
    assert.equal(second.input.target_count, 5);
    schedules.control(plan.id, 'pause');
    const paused = schedules.update(plan.id, {
      name: '暂停时修改',
      input: updatedInput,
      timing: { ...updatedTiming, times: ['21:00'] },
    });
    assert.equal(paused.nextRunAt, null);
    schedules.control(plan.id, 'close');
    assert.throws(() => schedules.update(plan.id, { name: '不可修改', input, timing }), {
      status: 409,
    });
  } finally {
    schedules.close();
    jobs.close();
  }
});

test('HTTP 保存连接即时生效；计划接口校验和幂等生效', async () => {
  await withApp(
    {
      env: nativeEnv,
      fetchImpl: async () => {
        throw new Error('Unexpected external request');
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
      const edited = await write(
        `/api/v1/acquisition/schedules/${weeklyPlan.id}`,
        {
          ...body,
          name: '修改后的计划',
          input: { ...input, target_count: 5 },
          timing: weeklyPlan.timing,
        },
        'PUT',
      );
      assert.equal(edited.status, 200);
      assert.equal((await edited.json()).input.target_count, 5);
      assert.equal(
        (
          await write(
            `/api/v1/acquisition/schedules/${weeklyPlan.id}`,
            { ...body, input: { ...input, target_count: 0 } },
            'PUT',
          )
        ).status,
        400,
      );
      const listed = await (await fetch(base + '/api/v1/acquisition/schedules')).json();
      assert.deepEqual(
        listed.schedules.find((item) => item.id === weeklyPlan.id).timing.weekdays,
        [1, 3, 5],
      );
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
      const resumed = await fetch(base + `${path}/${plan.id}/resume`, { method: 'POST' });
      assert.equal(resumed.status, 200);
      const restored = await resumed.json();
      assert.equal(restored.status, 'enabled');
      assert.equal(restored.runs, 1);
      assert.equal(restored.lastJob.rows[0].review_resolution.status, 'inserted');
      const changed = await fetch(base + '/api/v1/connections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { WEB_SEARCH_PROVIDER: 'deepseek' } }),
      });
      assert.equal(changed.status, 200);
      const after = await fetch(base + path);
      assert.equal(after.status, 200);
      assert.equal(
        (await after.json()).schedules.find((item) => item.id === plan.id).lastJob.rows[0]
          .review_resolution.status,
        'inserted',
      );
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
