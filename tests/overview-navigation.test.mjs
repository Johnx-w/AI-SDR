import test from 'node:test';
import assert from 'node:assert/strict';
import {
  businessNavigation,
  matchesTaskNavigation,
  updateBusinessNavigation,
} from '../src/domain/business-navigation.mjs';

const at = '2026-10-25T02:00:00.000Z';
const navigation = (query) => businessNavigation(new URLSearchParams(query), Date.parse(at));
const task = (id, dueAt, status = 'pending') => ({ id, dueAt, status });
const tasks = [
  task('yesterday', '2026-10-24T15:59:59.000Z'),
  task('earlier-today', '2026-10-25T01:59:59.000Z'),
  task('at-cutoff', at),
  task('later-today', '2026-10-25T15:59:59.999Z'),
  task('tomorrow', '2026-10-25T16:00:00.000Z'),
  task('skipped', '2026-10-20T00:00:00.000Z', 'skipped'),
  task('done', '2026-10-20T00:00:00.000Z', 'completed'),
];

test('total due drilldown uses the overview cutoff and disjoint overdue/today buckets', () => {
  const ids = (bucket) =>
    tasks
      .filter((row) =>
        matchesTaskNavigation(row, navigation(`tab=tasks&bucket=${bucket}&asOf=${at}`)),
      )
      .map((row) => row.id);
  assert.deepEqual(ids('overdue'), ['yesterday', 'earlier-today']);
  assert.deepEqual(ids('today'), ['at-cutoff', 'later-today']);
  assert.deepEqual(ids('due'), ['yesterday', 'earlier-today', 'at-cutoff', 'later-today']);
  assert.deepEqual(
    tasks
      .filter((row) => matchesTaskNavigation(row, navigation('tab=tasks&state=skipped')))
      .map((row) => row.id),
    ['skipped'],
  );
});

test('a frozen link is stable as the operator opens it later and crosses Beijing midnight', () => {
  const params = new URLSearchParams(`tab=tasks&bucket=today&asOf=${at}`);
  const first = businessNavigation(params, Date.parse(at));
  const later = businessNavigation(params, Date.parse('2026-10-26T08:00:00Z'));
  assert.deepEqual(first.range, later.range);
  assert.equal(later.frozen, true);
  assert.equal(later.range.todayStart, '2026-10-24T16:00:00.000Z');
});

test('choosing another status clears an incompatible bucket and frozen time', () => {
  const params = new URLSearchParams(
    `tab=tasks&bucket=overdue&asOf=${at}&task=one&customerId=customer-one`,
  );
  const next = updateBusinessNavigation(params, 'state', 'completed');
  assert.equal(next.get('state'), 'completed');
  assert.equal(next.has('bucket'), false);
  assert.equal(next.has('asOf'), false);
  assert.equal(next.has('task'), false);
  assert.equal(next.get('customerId'), 'customer-one');
  assert.equal(params.get('bucket'), 'overdue');
});

test('choosing a bucket clears previous task status and specific-record focus', () => {
  const next = updateBusinessNavigation(
    new URLSearchParams('tab=tasks&state=completed&task=one'),
    'bucket',
    'today',
  );
  assert.equal(next.toString(), 'tab=tasks&bucket=today');
  const cleared = updateBusinessNavigation(
    new URLSearchParams(`tab=tasks&bucket=today&asOf=${at}`),
    'bucket',
    '',
  );
  assert.equal(cleared.toString(), 'tab=tasks');
});

test('任务页拒绝旧需求筛选及无效时间，始终使用只读任务状态', () => {
  const result = navigation('tab=demands&state=quoting&asOf=bad');
  assert.equal(result.tab, 'tasks');
  assert.equal(result.state, 'all');
  assert.equal(result.frozen, false);
});
