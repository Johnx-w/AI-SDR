import test from 'node:test';
import assert from 'node:assert/strict';
import { OverviewService } from '../server/overview.mjs';
import { BatchJobs } from '../server/batch-jobs.mjs';

const asOf = '2026-10-25T02:00:00.000Z';
const customer = (id, grade = 'A', status = '待开发') => ({
  id,
  name: '企业' + id,
  market: '英国',
  grade,
  status,
});
const task = (id, customerId, dueAt, status = 'pending', demandIds = []) => ({
  id,
  customerId,
  dueAt,
  status,
  demandIds,
  title: '跟进' + id,
});
const demand = (id, customerId, stage = 'new') => ({ id, customerId, stage, title: '需求' + id });
function fixture(overrides = {}) {
  const graph = {
    conversations: [],
    messages: [],
    customerContexts: [],
    demands: [
      demand('d1', '1'),
      demand('d2', '2', 'quoting'),
      demand('d3', '3', 'won'),
      demand('d4', '3', 'lost'),
      demand('d5', '3', 'closed'),
    ],
    tasks: [
      task('t1', '1', '2026-10-24T23:00:00.000Z'),
      task('t2', '1', '2026-10-25T03:00:00.000Z'),
      task('t3', '2', '2026-10-24T00:00:00.000Z', 'paused', ['d2']),
      task('t4', '3', '2026-10-24T00:00:00.000Z', 'completed'),
      task('t5', '3', '2026-10-25T16:00:00.000Z'),
      task('t6', '3', '2026-10-24T00:00:00.000Z', 'cancelled'),
    ],
  };
  const config = {
    customers: async () => ({
      leads: [customer('1', 'C'), customer('2'), customer('3')],
      syncedAt: asOf,
      sync: { stale: false },
    }),
    business: () => graph,
    acquisition: () => ({
      scope: 'scope',
      jobs: [],
      schedules: [],
      captures: [
        {
          customerId: '1',
          domain: 'one.example',
          capturedAt: '2026-10-18T16:00:00.000Z',
          jobId: 'old-job',
        },
        {
          customerId: 'deleted',
          domain: 'deleted.example',
          capturedAt: '2026-10-25T01:00:00.000Z',
          jobId: 'new-job',
        },
        {
          customerId: 'outside',
          domain: 'outside.example',
          capturedAt: '2026-10-18T15:59:59.999Z',
          jobId: 'old',
        },
        { customerId: 'at-cutoff', domain: 'cutoff.example', capturedAt: asOf, jobId: 'new' },
      ],
    }),
    products: () => [
      { status: 'draft' },
      { status: 'draft' },
      { status: 'approved' },
      { status: 'archived' },
    ],
    scope: () => 'one',
    now: () => Date.parse(asOf),
    ...overrides,
  };
  return { graph, config, service: new OverviewService(config) };
}

test('客户复查按北京时间跨日到期，读取不确认、未来日期及已恢复客户不提醒', async () => {
  const graph = {
    conversations: [],
    messages: [],
    demands: [],
    tasks: [],
    customerContexts: [
      {
        customerId: '1',
        development: { paused: true, reviewDate: '2026-10-25', reason: '我方暂缓' },
      },
      { customerId: '2', development: { paused: true, reviewDate: '2026-10-26', reason: '其他' } },
      { customerId: '3', development: { paused: false, reviewDate: '2026-10-25', reason: '其他' } },
      { customerId: '4', development: { paused: true, reviewDate: '', reason: '其他' } },
    ],
  };
  const { service } = fixture({ business: () => graph });
  assert.deepEqual((await service.read({ asOf: '2026-10-24T15:59:59Z' })).developmentReviews, []);
  for (let i = 0; i < 2; i++) {
    const result = await service.read({ asOf: '2026-10-24T16:00:00Z' });
    assert.equal(result.developmentReviews.length, 1);
    assert.equal(result.developmentReviews[0].customerId, '1');
    assert.equal(result.developmentReviews[0].to, '/leads?lead=1');
  }
});

test('总览按实际收录时间统计新增，待办不随成果范围改变且暂停不催办', async () => {
  const { service } = fixture();
  const result = await service.read();
  assert.deepEqual(result.metrics, {
    companies: 3,
    newCompanies: 2,
    activeDemands: 2,
    dueTasks: 2,
  });
  assert.deepEqual(result.work, { overdue: 1, today: 1, paused: 1 });
  assert.equal(result.trend.length, 7);
  assert.equal(
    result.trend.reduce((sum, row) => sum + row.count, 0),
    result.captures.length,
  );
  assert.equal(result.trend[0].date, '2026-10-19');
  assert.equal(result.captures.find((row) => row.customerId === 'deleted').available, false);
  assert.equal(result.captures.find((row) => row.customerId === 'deleted').name, 'deleted.example');
  assert.equal(result.products.draft, 2);
  assert.equal(result.products.syncIssues, null);
  assert.equal(result.priority[0].customerId, '1', 'C级逾期事项优先于A级开发候选');
  assert.equal(result.priority.filter((row) => row.customerId === '1').length, 1);
  assert.equal(
    result.priority.some((row) => row.customerId === '2'),
    false,
    '暂停任务已安排下一步，不能再次推为无安排需求',
  );
  const today = await service.read({ period: 'today' });
  assert.deepEqual(today.work, result.work);
  assert.equal(today.metrics.newCompanies, 1);
  assert.equal(today.trend.length, 1);
  assert.equal(
    new URL(result.links.newCompanies, 'http://example.test').searchParams.get('asOf'),
    asOf,
  );
  assert.equal(
    new URL(result.links.dueTasks, 'http://example.test').searchParams.get('bucket'),
    'due',
  );
});

test('需求优先于高评级开发，拒绝联系和已有沟通客户不作为新开发推荐', async () => {
  const graph = {
    conversations: [{ customerId: 'contacted' }],
    messages: [],
    customerContexts: [{ customerId: 'refused', doNotContact: true }],
    tasks: [],
    demands: [
      demand('d', 'need'),
      demand('refused-demand', 'refused'),
      demand('paused-demand', 'paused'),
    ],
  };
  const { service } = fixture({
    customers: () => ({
      leads: [
        customer('new'),
        customer('unknown', 'A', '未记录'),
        customer('need', 'C'),
        customer('refused'),
        customer('contacted'),
        customer('paused', 'A', '暂停开发'),
      ],
      syncedAt: asOf,
    }),
    business: () => graph,
  });
  const result = await service.read();
  assert.equal(result.priority[0].customerId, 'need');
  assert.equal(
    result.priority.find((row) => row.customerId === 'unknown').reason,
    'A 级待开发客户',
  );
  for (const id of ['refused', 'paused'])
    assert.equal(
      result.priority.find((row) => row.customerId === id).reason,
      '进行中需求需人工核对联系限制',
    );
  assert.equal(
    result.priority.some((row) => row.customerId === 'contacted'),
    false,
  );
});

test('联系限制保留到期内部行动并提示沟通核对，只抑制新开发候选', async () => {
  const customers = ['review', 'other', 'sample', 'communication', 'candidate'].map((id) =>
    customer(id),
  );
  const graph = {
    conversations: [],
    messages: [],
    demands: [],
    customerContexts: customers.map((row) => ({ customerId: row.id, doNotContact: true })),
    tasks: [
      { ...task('review-task', 'review', '2026-10-24T00:00:00.000Z'), kind: 'manual_review' },
      { ...task('other-task', 'other', '2026-10-24T00:00:00.000Z'), kind: 'other' },
      { ...task('sample-task', 'sample', '2026-10-24T00:00:00.000Z'), kind: 'sample' },
      {
        ...task('communication-task', 'communication', '2026-10-24T00:00:00.000Z'),
        kind: 'quote_followup',
      },
    ],
  };
  const { service } = fixture({
    customers: () => ({ leads: customers, syncedAt: asOf }),
    business: () => graph,
  });
  const result = await service.read();
  assert.equal(result.metrics.dueTasks, 4);
  assert.equal(result.priority.length, 4);
  for (const id of ['review', 'other', 'sample'])
    assert.equal(result.priority.find((row) => row.customerId === id).reason, '跟进任务已逾期');
  assert.equal(
    result.priority.find((row) => row.customerId === 'communication').reason,
    '跟进任务已逾期，需先核对联系限制',
  );
  assert.equal(
    result.priority.some((row) => row.customerId === 'candidate'),
    false,
  );
});

test('单源故障保留同范围旧事实，首次缺失返回null且错误不泄露凭证', async () => {
  let broken = false;
  const { config } = fixture();
  const unavailable = () => {
    throw new Error('token=secret-and-private');
  };
  const service = new OverviewService({
    ...config,
    business: () => (broken ? unavailable() : config.business()),
  });
  const good = await service.read();
  broken = true;
  const stale = await service.read();
  assert.equal(stale.sources.business.state, 'stale');
  assert.deepEqual(stale.work, good.work);
  assert.equal(stale.sources.customers.state, 'ready');
  assert.equal(JSON.stringify(stale).includes('secret-and-private'), false);
  const failed = await new OverviewService({
    ...config,
    business: unavailable,
    acquisition: unavailable,
  }).read();
  assert.equal(failed.sources.business.state, 'unavailable');
  assert.equal(failed.metrics.activeDemands, null);
  assert.equal(failed.metrics.dueTasks, null);
  assert.equal(failed.metrics.companies, 3);
  assert.equal(failed.metrics.newCompanies, null);
  assert(failed.trend.every((point) => point.count === null));
  assert.deepEqual(failed.captures, []);
});

test('切换客户表清空旧来源缓存，初次远端失败可读已有客户副本', async () => {
  let currentScope = 'one',
    broken = false;
  const { config } = fixture();
  const service = new OverviewService({
    ...config,
    scope: () => currentScope,
    business: () => {
      if (broken) throw new Error('offline');
      return config.business();
    },
  });
  await service.read();
  broken = true;
  currentScope = 'two';
  const result = await service.read();
  assert.equal(result.sources.business.state, 'unavailable');
  assert.equal(result.metrics.activeDemands, null);
  const replica = await new OverviewService({
    ...config,
    customers: () => {
      throw new Error('offline');
    },
    customerSnapshot: () => ({ leads: [customer('saved')], syncedAt: asOf }),
  }).read();
  assert.equal(replica.sources.customers.state, 'stale');
  assert.equal(replica.metrics.companies, 1);
});

test('客户源缺失时保留真实业务待办，名称明确资料暂不可用', async () => {
  const { service } = fixture({
    customers: () => {
      throw new Error('offline');
    },
  });
  const result = await service.read();
  assert.equal(result.metrics.companies, null);
  assert.equal(result.metrics.dueTasks, 2);
  assert(result.captures.every((capture) => capture.available === null));
  assert.match(result.priority[0].name, /企业资料暂不可用/u);
});

test('读取期间切换客户表拒绝旧响应，并防止旧请求覆盖新范围缓存', async () => {
  let currentScope = 'one',
    release,
    failed = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { config } = fixture();
  const service = new OverviewService({
    ...config,
    scope: () => currentScope,
    customers: async () => {
      const requested = currentScope;
      if (failed) throw new Error('offline');
      if (requested === 'one') await gate;
      return { leads: [customer(requested)], syncedAt: asOf };
    },
  });
  const oldRead = service.read();
  const rejected = assert.rejects(oldRead, { status: 409 });
  currentScope = 'two';
  const current = await service.read();
  assert.equal(current.metrics.companies, 1);
  assert(current.priority.some((row) => row.customerId === 'two'));
  release();
  await rejected;
  failed = true;
  const stale = await service.read();
  assert.equal(stale.sources.customers.state, 'stale');
  assert.equal(
    stale.priority.some((row) => row.customerId === 'one'),
    false,
  );
  assert(stale.priority.some((row) => row.customerId === 'two'));
});

test('单源永久等待在deadline后降级，其它本地业务保持可读', async () => {
  const { service } = fixture({ customers: () => new Promise(() => {}), timeoutMs: 10 });
  const result = await service.read();
  assert.equal(result.sources.customers.state, 'unavailable');
  assert.equal(result.metrics.companies, null);
  assert.equal(result.sources.business.state, 'ready');
  assert.equal(result.metrics.activeDemands, 2);
  assert.equal(result.metrics.dueTasks, 2);
  assert.equal(result.metrics.newCompanies, 2);
  assert.equal(result.products.draft, 2);
});

test('来源超时保留旧快照，晚到的reader结果不能覆盖总览缓存', async () => {
  let mode = 'ready',
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { config } = fixture();
  const service = new OverviewService({
    ...config,
    timeoutMs: 10,
    customers: () => {
      if (mode === 'ready') return config.customers();
      if (mode === 'pending') return gate;
      throw new Error('offline');
    },
  });
  await service.read();
  mode = 'pending';
  const timedOut = await service.read();
  assert.equal(timedOut.sources.customers.state, 'stale');
  assert.equal(timedOut.metrics.companies, 3);
  release({ leads: [customer('late')], syncedAt: asOf });
  await gate;
  mode = 'failed';
  const stale = await service.read();
  assert.equal(stale.metrics.companies, 3);
  assert.equal(
    stale.priority.some((row) => row.customerId === 'late'),
    false,
  );
});

test('旧scope的pending读超时后不能污染新scope缓存', async () => {
  let scope = 'old',
    failed = false;
  const { config } = fixture();
  const service = new OverviewService({
    ...config,
    timeoutMs: 10,
    scope: () => scope,
    customers: () => {
      if (scope === 'old') return new Promise(() => {});
      if (failed) throw new Error('offline');
      return { leads: [customer('current')], syncedAt: asOf };
    },
  });
  const rejected = assert.rejects(service.read(), { status: 409 });
  scope = 'new';
  await service.read();
  await rejected;
  failed = true;
  const stale = await service.read();
  assert.equal(stale.sources.customers.state, 'stale');
  assert.equal(stale.metrics.companies, 1);
  assert(stale.priority.some((row) => row.customerId === 'current'));
});

test('新增账本隔离客户表、忽略存量和旧资格认领，统计不受最近100条任务限制', () => {
  const manager = new BatchJobs({ scope: 'current', schedule: false });
  try {
    for (let n = 0; n < 105; n++)
      manager.db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(
        'job-' + n,
        'key-' + n,
        'hash',
        JSON.stringify({
          id: 'job-' + n,
          scope: 'current',
          status: 'completed',
          input: {},
          createdAt: asOf,
        }),
      );
    const insert = manager.db.prepare('INSERT INTO handoff_entities VALUES(?,?,?,?)');
    insert.run(
      'current',
      'new-one',
      'new.example',
      JSON.stringify({
        count_policy: 'broad-business-v1',
        captured_at: asOf,
        created_job: 'job-0',
      }),
    );
    insert.run('current', 'baseline', 'base.example', JSON.stringify({ baseline: true }));
    insert.run(
      'current',
      'legacy',
      'legacy.example',
      JSON.stringify({ qualified_job: 'old', qualified_at: asOf }),
    );
    insert.run(
      'other',
      'other-new',
      'other.example',
      JSON.stringify({
        count_policy: 'broad-business-v1',
        captured_at: asOf,
        created_job: 'foreign',
      }),
    );
    manager.db
      .prepare('INSERT INTO jobs VALUES(?,?,?,?)')
      .run(
        'foreign',
        'foreign-key',
        'hash',
        JSON.stringify({ id: 'foreign', scope: 'other', status: 'completed' }),
      );
    manager.db
      .prepare('INSERT INTO jobs VALUES(?,?,?,?)')
      .run(
        'unknown',
        'unknown-key',
        'hash',
        JSON.stringify({ id: 'unknown', status: 'completed' }),
      );
    const snapshot = manager.overview();
    assert.equal(manager.list().length, 100);
    assert.equal(snapshot.jobs.length, 105);
    assert.equal(snapshot.captures.length, 1);
    assert.equal(snapshot.captures[0].customerId, 'new-one');
    assert.equal(
      snapshot.jobs.some((row) => ['foreign', 'unknown'].includes(row.id)),
      false,
    );
  } finally {
    manager.close();
  }
});

test('旧交接目标不冒充新收录进度，当前口径执行与计划保持可定位', async () => {
  const { service } = fixture({
    acquisition: () => ({
      scope: 'current',
      captures: [],
      jobs: [
        {
          id: 'legacy',
          status: 'completed',
          inserted: 100,
          target: 5,
          input: { country: '英国' },
          createdAt: asOf,
        },
        {
          id: 'current-job',
          countPolicy: 'broad-business-v1',
          status: 'running',
          inserted: 2,
          target: 20,
          input: { country: '英国', product: '百叶窗' },
          createdAt: asOf,
        },
      ],
      schedules: [
        {
          id: 'current-plan',
          scope: 'current',
          name: '当前计划',
          status: 'enabled',
          nextRunAt: asOf,
        },
        { id: 'legacy-plan', name: '旧计划但已证实归属', status: 'paused', lastJobId: 'legacy' },
        { id: 'unknown-plan', name: '来源不明', status: 'enabled', nextRunAt: asOf },
        {
          id: 'foreign-plan',
          scope: 'other',
          name: '其它表计划',
          status: 'enabled',
          nextRunAt: asOf,
        },
      ],
    }),
  });
  const result = await service.read();
  assert.deepEqual(
    result.jobs.map((job) => job.id),
    ['current-job'],
  );
  assert.equal(result.jobs[0].inserted, 2);
  assert.equal(result.jobs[0].target, 20);
  assert.equal(
    new URL(result.jobs[0].to, 'http://example.test').searchParams.get('job'),
    'current-job',
  );
  assert.deepEqual(
    result.schedules.map((plan) => plan.id),
    ['current-plan', 'legacy-plan'],
  );
});

test('非法总览范围和时间在读取来源前拒绝', async () => {
  const { service } = fixture({
    customers: () => {
      assert.fail('无效参数不应读取任何来源');
    },
  });
  await assert.rejects(service.read({ period: 'all' }), { status: 400 });
  await assert.rejects(service.read({ asOf: 'not-a-date' }), { status: 400 });
});
