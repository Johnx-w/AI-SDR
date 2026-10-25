import test from 'node:test';
import assert from 'node:assert/strict';
import { AcquisitionSchedules } from '../server/acquisition-schedules.mjs';
import { BatchJobs } from '../server/batch-jobs.mjs';

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
  times: ['09:00'],
  timezone: 'Asia/Shanghai',
};

test('显式绑定客户表的计划只在当前范围派发，切回原表可继续原计划', () => {
  let scope = 'one',
    clock = Date.parse('2030-01-01T08:00:00+08:00');
  const managers = new Map(
    ['one', 'two'].map((value) => [
      value,
      new BatchJobs({ scope: value, schedule: false, now: () => clock }),
    ]),
  );
  const schedules = new AcquisitionSchedules({
    scope: () => scope,
    jobs: () => managers.get(scope),
    ready: () => true,
    available: () => true,
    now: () => clock,
  });
  try {
    const first = schedules.create({ name: '第一张表的计划', input, timing }, 'scope-one-plan');
    scope = 'two';
    const second = schedules.create({ name: '第二张表的计划', input, timing }, 'scope-two-plan');
    clock = Date.parse('2030-01-01T09:05:00+08:00');
    schedules.tick();
    assert.equal(managers.get('one').list().length, 0);
    assert.equal(managers.get('two').list().length, 1);
    assert.equal(schedules.get(first.id).runs, 0);
    assert.equal(schedules.get(first.id).status, 'enabled');
    assert.equal(schedules.get(first.id).nextRunAt, first.nextRunAt);
    assert.equal(schedules.get(second.id).runs, 1);
    assert.equal(managers.get('two').list()[0].scope, 'two');
    scope = 'one';
    schedules.tick();
    assert.equal(managers.get('one').list().length, 1);
    assert.equal(schedules.get(first.id).runs, 1);
    assert.equal(schedules.get(first.id).status, 'completed');
    assert.equal(managers.get('one').list()[0].scope, 'one');
    assert.equal(managers.get('two').list().length, 1, '切回不重复执行另一表已派发计划');
  } finally {
    schedules.close();
    for (const manager of managers.values()) manager.close();
  }
});

test('没有scope的历史计划保留原有派发语义', () => {
  let scope = 'one',
    clock = Date.parse('2030-01-01T08:00:00+08:00');
  const manager = new BatchJobs({ scope: 'two', schedule: false, now: () => clock });
  const schedules = new AcquisitionSchedules({
    scope: () => scope,
    jobs: () => manager,
    ready: () => true,
    available: () => true,
    now: () => clock,
  });
  try {
    const legacy = schedules.create({ name: '历史计划', input, timing }, 'legacy-scope-plan');
    delete legacy.scope;
    schedules.save(legacy);
    scope = 'two';
    clock = Date.parse('2030-01-01T09:05:00+08:00');
    schedules.tick();
    assert.equal(manager.list().length, 1);
    assert.equal(schedules.get(legacy.id).runs, 1);
  } finally {
    schedules.close();
    manager.close();
  }
});
