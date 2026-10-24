import test from 'node:test';
import assert from 'node:assert/strict';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { validateInput, createApp } from '../server/app.mjs';
import { searchPlan } from '../server/search-plan.mjs';

const input = {
  country: 'Canada',
  region: '',
  product_scope: 'all',
  product: 'window coverings',
  products: [],
  audience: 'BC',
  acquisition_channel: 'dual',
  query_mode: 'auto',
  target_count: 1,
  customs_record_budget: 100,
};

test('渠道与服务商解耦；北美六类海关计划优先，官网发现保留独立通道', () => {
  const validated = validateInput(input);
  const plan = searchPlan(validated);
  assert.deepEqual(
    plan.slice(0, 6).map((s) => s.family),
    [
      'fabrics',
      'components',
      'plantation_shutters',
      'finished_blinds',
      'outdoor_shading',
      'samples',
    ],
  );
  assert.ok(plan.slice(6).every((s) => s.source_kind === 'web'));
  assert.equal(searchPlan({ ...validated, acquisition_channel: 'customs' }).length, 6);
  assert.ok(
    searchPlan({ ...validated, acquisition_channel: 'web' }).every(
      (s) => s.source_kind !== 'customs',
    ),
  );
  assert.throws(() => validateInput({ ...input, country: 'Australia' }), /美国和加拿大/);
  assert.throws(() => validateInput({ ...input, customs_record_budget: 301 }), /1–300/);
  assert.equal(
    searchPlan(
      validateInput({
        ...input,
        product_scope: 'specific',
        products: undefined,
        product: 'outdoor zip screens',
      }),
    )[0].family,
    'outdoor_shading',
  );
});

test('批量任务持久保留逐票来源、预算、待核实买家和新页，既有客户更新不充新增', async () => {
  const calls = [];
  let wroteNew = false;
  const manager = new BatchJobs({
    schedule: false,
    provider: 'native',
    discover: async (_input, search) => {
      calls.push(search);
      if (search.source_kind === 'customs') {
        if (search.family === 'fabrics' && (!search.page_no || search.page_no === 1))
          return {
            candidates: [
              {
                source_kind: 'customs',
                source_url: 'https://old.example.org/',
                target_record_id: 'old',
                customs_evidence: { id: 'buyer1' },
              },
            ],
            usage: { run_used_records: 50, charged_records: 50 },
            next_search: { ...search, page_no: 2 },
          };
        return {
          candidates: [],
          usage: { run_used_records: 100, charged_records: 50 },
          review_candidates: [{ name: 'Unknown Buyer', reason: '未核实官网' }],
        };
      }
      return { candidates: [{ source_url: 'https://new.example.org/' }] };
    },
    research: async (_input, item) => {
      if (!item.target_record_id) wroteNew = true;
      return item.target_record_id
        ? { 更新: 1, reason: '已有档案已更新' }
        : {
            新增: 1,
            明细: [{ source_url: item.source_url, result: 'inserted', record_id: 'new' }],
          };
    },
    status: async () => ({ settled: false }),
    readLeads: async () => (wroteNew ? [{ id: 'new', website: 'https://new.example.org/' }] : []),
  });
  try {
    const job = manager.create({ ...input, target_count: 2 }, 'dual-source-job-001');
    await manager.work(job.id);
    const finished = manager.get(job.id);
    assert.equal(finished.inserted, 1);
    assert.equal(finished.updated, 1);
    assert.equal(finished.review, 1);
    assert.equal(finished.customsUsedRecords, 100);
    assert.equal(calls.filter((s) => s.source_kind === 'customs').length, 2);
    assert.equal(calls[0].remaining_budget, 100);
    assert.equal(
      calls.find((s, index) => index > 0 && s.source_kind === 'customs').remaining_budget,
      50,
    );
    assert.equal(calls[0].run_id, job.id);
    assert.equal(finished.rows.find((r) => r.result === 'duplicate').target_record_id, 'old');
    assert.equal(finished.rows.find((r) => r.result === 'duplicate').customs_evidence.id, 'buyer1');
    assert.ok(finished.queryPlan.some((s) => s.page_no === 2));
  } finally {
    manager.close();
  }
});

test('发现失败后续跑同一查询与 run_id，避免跳过已付费但尚未交接的页面', async () => {
  let count = 0;
  const calls = [];
  const manager = new BatchJobs({
    schedule: false,
    provider: 'native',
    discover: async (_input, search) => {
      calls.push(search);
      if (count++ === 0) throw new Error('website lookup failed after customs');
      return { candidates: [] };
    },
    research: async () => {},
    status: async () => ({ settled: false }),
    readLeads: async () => [],
  });
  try {
    const job = manager.create({ ...input, acquisition_channel: 'customs' }, 'customs-retry-001');
    await manager.work(job.id);
    assert.equal(manager.get(job.id).status, 'paused');
    const pending = manager.get(job.id).pendingSearch;
    await manager.resume(job.id);
    await manager.work(job.id);
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(calls[1].family, pending.family);
    assert.equal(manager.get(job.id).pendingSearch, null);
  } finally {
    manager.close();
  }
});

test('海关连接状态不暴露凭证，未配置海关不影响官网但不能启动海关任务', async () => {
  const env = {
    ACQUISITION_PROVIDER: 'native',
    TAVILY_API_KEY: 'web-secret',
    DEEPSEEK_API_KEY: 'model-secret',
    FEISHU_APP_ID: 'app',
    FEISHU_APP_SECRET: 'feishu-secret',
    FEISHU_APP_TOKEN: 'base',
    FEISHU_TABLE_ID: 'table',
  };
  const app = createApp({
    env,
    fetchImpl: async () => {
      throw new Error('unexpected call');
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const root = 'http://127.0.0.1:' + app.address().port;
  try {
    const status = await (await fetch(root + '/api/v1/acquisition/status')).json();
    assert.equal(status.configured, true);
    assert.equal(status.customs.configured, false);
    assert.equal(JSON.stringify(status).includes('secret'), false);
    const response = await fetch(root + '/api/v1/acquisition/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'missing-customs-001' },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 503);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
