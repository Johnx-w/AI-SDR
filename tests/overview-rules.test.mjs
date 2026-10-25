import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { overviewRange, taskBucket, activeDemand } from '../src/domain/overview-rules.mjs';

test('总览按北京时间自然日统计，近7天包括今天且不包含未来', () => {
  const range = overviewRange('7d', '2026-10-24T16:15:00.000Z');
  assert.equal(range.start, '2026-10-18T16:00:00.000Z');
  assert.equal(range.todayStart, '2026-10-24T16:00:00.000Z');
  assert.equal(range.todayEnd, '2026-10-25T16:00:00.000Z');
  assert.equal(range.end, '2026-10-24T16:15:00.000Z');
  assert.equal(overviewRange('today', range.asOf).start, range.todayStart);
  assert.equal(overviewRange('30d', range.asOf).start, '2026-09-25T16:00:00.000Z');
  const script = `import {overviewRange} from ${JSON.stringify(new URL('../src/domain/overview-rules.mjs', import.meta.url).href)}; process.stdout.write(JSON.stringify(overviewRange('7d','2026-10-24T16:15:00Z')));`;
  const processResult = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/Los_Angeles' },
  });
  assert.equal(processResult.status, 0);
  assert.deepEqual(JSON.parse(processResult.stdout), range);
});

test('逾期和今日互斥，暂停、已完成、取消和未来任务不计入催办', () => {
  const range = overviewRange('7d', '2026-10-25T02:00:00Z');
  const bucket = (dueAt, status = 'pending') => taskBucket({ dueAt, status }, range);
  assert.equal(bucket('2026-10-24T02:00:00Z'), 'overdue');
  assert.equal(bucket('2026-10-25T01:59:59Z'), 'overdue');
  assert.equal(bucket('2026-10-25T02:00:00Z'), 'today');
  assert.equal(bucket('2026-10-25T15:59:59Z'), 'today');
  assert.equal(bucket('2026-10-25T16:00:00Z'), '');
  assert.equal(bucket('2026-10-24T02:00:00Z', 'paused'), 'paused');
  assert.equal(bucket('2026-10-24T02:00:00Z', 'completed'), '');
  assert.equal(bucket('2026-10-24T02:00:00Z', 'cancelled'), '');
  assert.equal(bucket('not-a-date'), '');
});

test('进行中需求仅计五种未结束阶段，拒绝未知周期和无效统计时间', () => {
  for (const stage of ['new', 'clarifying', 'quoting', 'sampling', 'negotiating'])
    assert.equal(activeDemand({ stage }), true);
  for (const stage of ['won', 'lost', 'closed', 'unknown'])
    assert.equal(activeDemand({ stage }), false);
  assert.throws(() => overviewRange('all'), { status: 400 });
  assert.throws(() => overviewRange('7d', 'invalid'), { status: 400 });
});
