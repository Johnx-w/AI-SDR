import test from 'node:test';
import assert from 'node:assert/strict';
import {
  businessNavigation,
  matchesDemandNavigation,
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
  task('paused', '2026-10-20T00:00:00.000Z', 'paused'),
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
  assert.deepEqual(ids('paused'), ['paused']);
});

test('a frozen link is stable as the operator opens it later and crosses Beijing midnight', () => {
  const params = new URLSearchParams(`tab=tasks&bucket=today&asOf=${at}`);
  const first = businessNavigation(params, Date.parse(at));
  const later = businessNavigation(params, Date.parse('2026-10-26T08:00:00Z'));
  assert.deepEqual(first.range, later.range);
  assert.equal(later.frozen, true);
  assert.equal(later.range.todayStart, '2026-10-24T16:00:00.000Z');
});

test('active demand drilldown counts demands and excludes won, lost and closed', () => {
  const filter = navigation('tab=demands&state=active');
  const stages = [
    'new',
    'clarifying',
    'quoting',
    'sampling',
    'negotiating',
    'won',
    'lost',
    'closed',
  ];
  assert.deepEqual(
    stages.filter((stage) => matchesDemandNavigation({ id: stage, stage }, filter)),
    stages.slice(0, 5),
  );
  assert.equal(
    matchesDemandNavigation(
      { id: 'one', stage: 'quoting' },
      navigation('tab=demands&state=quoting'),
    ),
    true,
  );
  assert.equal(
    matchesDemandNavigation({ id: 'one', stage: 'new' }, navigation('tab=demands&state=quoting')),
    false,
  );
});

test('specific task or demand links identify one record without changing its editability or status', () => {
  const taskFilter = navigation('tab=tasks&task=paused');
  assert.deepEqual(
    tasks.filter((row) => matchesTaskNavigation(row, taskFilter)).map((row) => row.id),
    ['paused'],
  );
  assert.equal(
    matchesDemandNavigation(
      { id: 'wanted', stage: 'closed' },
      navigation('tab=demands&demand=wanted'),
    ),
    true,
  );
  assert.equal(
    matchesDemandNavigation({ id: 'other', stage: 'new' }, navigation('tab=demands&demand=wanted')),
    false,
  );
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

test('switching tabs drops unrelated record and state filters while preserving customer scope', () => {
  const next = updateBusinessNavigation(
    new URLSearchParams(
      `tab=tasks&state=paused&bucket=due&asOf=${at}&task=one&q=hello&customerId=c1&productId=p1`,
    ),
    'tab',
    'demands',
  );
  assert.equal(next.toString(), 'tab=demands&customerId=c1&productId=p1');
  assert.equal(navigation(next.toString()).state, 'all');
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

test('invalid or cross-tab filters fall back without hiding all business records', () => {
  const invalid = navigation('tab=invalid&state=paused&bucket=overdue&asOf=bad');
  assert.equal(invalid.tab, 'demands');
  assert.equal(invalid.state, 'all');
  assert.equal(invalid.bucket, '');
  assert.equal(invalid.frozen, false);
  assert.equal(navigation('tab=messages&state=received').state, 'all');
  assert.equal(navigation('tab=messages&state=inbound').state, 'inbound');
});
