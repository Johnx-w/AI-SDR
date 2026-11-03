import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeAcquisition } from '../server/native-acquisition.mjs';
import { AcquisitionStore } from '../server/acquisition-store.mjs';
import { researchCacheKey } from '../server/research-reuse.mjs';
import { companyResearchSchema } from '../server/company-research.mjs';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { exclusionConditionsKey } from '../server/exclusion-conditions.mjs';

const source = 'https://blinds.example.org/';
const text =
  'Example Blinds supplies zip screens to dealers nationwide in the United States. We are a window coverings business with a showroom and product catalogue for trade customers.';
const env = {
  TAVILY_API_KEY: 'fixture-search',
  DEEPSEEK_API_KEY: 'fixture-model',
  FEISHU_APP_ID: 'fixture-app',
  FEISHU_APP_SECRET: 'fixture-secret',
  FEISHU_APP_TOKEN: 'fixture-table',
  FEISHU_TABLE_ID: 'fixture-id',
};
const input = {
  country: 'United States',
  product: 'zip screens',
  audience: 'BC',
  customer_type: '',
  customer_profile: 'all',
  acquisition_channel: 'tavily_web',
};

function fixture({
  identity = { provider: 'fixture', model: 'text-v1' },
  path = ':memory:',
  scope = 'cost-test',
} = {}) {
  const state = {
    text,
    calls: 0,
    reads: 0,
    writes: 0,
    invalid: false,
    request: null,
    records: [],
    assessments: [],
    searchResults: [{ url: source, title: 'Example Blinds' }],
    searches: 0,
  };
  const store = new AcquisitionStore(path, scope);
  const raw = {
    assessment_opportunities: [],
    company_name: { value: 'Example Blinds', quote: text, source_url: source },
    legal_company_name: null,
    trading_names: [],
    entity_type: { value: 'business', quote: text, source_url: source },
    production_model: null,
    operating_model: null,
    manufactured_products: [],
    actual_country: { value: 'United States', quote: text, source_url: source },
    customer_type: null,
    customer_types: [],
    preference_evidence: [],
    requirement_checks: [],
    audience: null,
    main_product_preference: null,
    industry_profile: null,
    demand_products: [],
    profile_tags: [],
    products: [],
    service_areas: [],
    address: null,
  };
  const providers = {
    model: {
      cacheIdentity: identity,
      async research(request) {
        state.calls++;
        state.request = request;
        return {
          status: state.invalid ? 'incomplete' : 'completed',
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(raw) }] }],
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    },
    web: {
      provider: 'fixture',
      extract: async () => ({ results: [] }),
      search: async () => {
        state.searches++;
        return { results: state.searchResults };
      },
    },
  };
  const service = new NativeAcquisition({
    env,
    store,
    providers,
    assessments: {
      scope,
      save: (snapshot) => {
        state.assessments.push(structuredClone(snapshot));
      },
      close() {},
    },
    feishu: {
      records: async () => state.records,
      record: async (id) => state.records.find((record) => record.record_id === id),
      fields: async () => [
        { field_name: '公司名称', type: 1 },
        { field_name: '来源链接', type: 1 },
        { field_name: 'customer_id', type: 1 },
        { field_name: '首次发现时间', type: 5 },
        { field_name: '开发状态', type: 3 },
        { field_name: '需求产品', type: 1 },
        { field_name: '客户行业画像', type: 1 },
        { field_name: '客户类型', type: 1 },
        { field_name: '用户评级', type: 3 },
        { field_name: '评级依据', type: 1 },
        { field_name: '最近研究时间', type: 5 },
      ],
      write: async (action, fields, id) => {
        state.writes++;
        const record =
          action === 'insert'
            ? { record_id: 'rec-cost', fields: {} }
            : state.records.find((record) => record.record_id === id);
        if (action === 'insert') state.records.push(record);
        Object.assign(record.fields, fields);
        return record;
      },
    },
    readPage: async () => {
      state.reads++;
      return { html: '<p>' + state.text + '</p>' };
    },
  });
  const research = (id, target = input) =>
    service.research(target, { source_url: source, operation_id: id });
  return { service, store, providers, state, research, raw };
}

test('合格结果复用后仍重新核对并更新原档案、重新评分和读回，不重放新增动作', async () => {
  const f = fixture();
  try {
    f.raw.products = [{ value: 'zip screens', quote: text, source_url: source }];
    const first = await f.research('positive-first');
    assert.equal(first.新增, 1, JSON.stringify({ reason: first.reason, research: first.research }));
    f.state.records[0].fields['开发状态'] = '人工跟进中';
    const second = await f.service.research(input, {
      source_url: source,
      target_record_id: 'rec-cost',
      operation_id: 'positive-second',
    });
    assert.equal(second.更新, 1);
    assert.equal(second.新增, 0);
    assert.equal(second.research_usage.cache_hits, 1);
    assert.equal(f.state.calls, 1);
    assert.equal(f.state.writes, 2);
    assert.equal(f.state.records.length, 1);
    assert.equal(f.state.records[0].fields['开发状态'], '人工跟进中');
    assert.equal(f.state.assessments.length, 2);
    assert.notEqual(f.state.assessments[0].id, f.state.assessments[1].id);
  } finally {
    f.service.close();
  }
});

test('相同研究正文和条件跨操作复用模型响应，仍新抓官网和核验，不把旧token重复计费', async () => {
  const f = fixture();
  try {
    const first = await f.research('reuse-first');
    const second = await f.research('reuse-second');
    assert.equal(f.state.calls, 1);
    assert.equal(f.state.reads, 2);
    assert.equal(f.state.writes, 0);
    assert.equal(first.research_usage.model_calls, 1);
    assert.equal(first.research_usage.cache_hits, 0);
    assert.equal(first.research_usage.input_tokens, 100);
    assert.equal(second.research_usage.model_calls, 0);
    assert.equal(second.research_usage.cache_hits, 1);
    assert.equal(second.research_usage.input_tokens, 0);
    assert.equal(second.research_usage.output_tokens, 0);
    assert.deepEqual(second.research.facts, first.research.facts);
    assert.equal(second.新增, 0);
  } finally {
    f.service.close();
  }
});

test('明确不匹配跨操作跳过官网和模型，操作只保留判定摘要', async () => {
  const f = fixture();
  try {
    f.state.text = text + ' We sell camping tents to households.';
    f.raw.products = [
      {
        value: 'camping tents',
        quote: 'We sell camping tents to households.',
        source_url: source,
      },
    ];
    const first = await f.research('rejected-first');
    const second = await f.research('rejected-second');
    assert.equal(first.outcome, 'rejected');
    assert.equal(second.outcome, 'rejected');
    assert.equal(f.state.calls, 1);
    assert.equal(first.research_usage.cache_hits, 0);
    assert.equal(second.research_usage.cache_hits, 0);
    assert.equal(f.state.writes, 0);
    const stored = f.store.get('rejected-first');
    assert.equal(stored.state, 'completed');
    assert.equal(stored.research_response, undefined);
    assert.equal(stored.research_pages, undefined);
    assert.equal(stored.research.product_match, 'not_matched');
    assert.equal(stored.input.item.source_url, source);
    assert.equal(stored.evidence, undefined);
    assert.equal(stored.output.handoff.contacts.length, 0);
    const key = researchCacheKey({
      ...f.state.request,
      schema: companyResearchSchema,
      identity: f.providers.model.cacheIdentity,
    });
    assert.equal(f.store.modelResponse(key), null);
    f.store.saveModelResponse(key, {
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(f.raw) }] }],
    });
    const cached = await f.research('rejected-cache-hit');
    assert.equal(cached.outcome, 'rejected');
    assert.equal(cached.research_usage.cache_hits, 0);
    assert.equal(f.state.calls, 1);
    assert.ok(f.store.modelResponse(key));
    assert.deepEqual(await f.research('rejected-first'), first);
  } finally {
    f.service.close();
  }
});

test('正文、目标条件或模型身份变化触发新研究，而不是沿用旧模型结果', async () => {
  const f = fixture();
  try {
    await f.research('change-first');
    f.state.text += ' We also supply roller blinds.';
    await f.research('change-page');
    await f.research('change-target', { ...input, audience: 'B' });
    f.providers.model.cacheIdentity = { provider: 'fixture', model: 'text-v2' };
    await f.research('change-model', { ...input, audience: 'B' });
    assert.equal(f.state.calls, 4);
    assert.equal(f.state.writes, 0);
  } finally {
    f.service.close();
  }
});

test('未声明缓存身份的适配器不复用，未完成或损坏的响应不成为缓存依据', async () => {
  const unknown = fixture({ identity: null });
  try {
    await unknown.research('unknown-first');
    await unknown.research('unknown-second');
    assert.equal(unknown.state.calls, 2);
  } finally {
    unknown.service.close();
  }
  const f = fixture();
  try {
    f.state.invalid = true;
    const failed = await f.research('invalid-first');
    assert.equal(failed.research_usage.model_calls, 1);
    f.state.invalid = false;
    await f.research('valid-second');
    assert.equal(f.state.calls, 2);
    const key = researchCacheKey({
      ...f.state.request,
      schema: companyResearchSchema,
      identity: f.providers.model.cacheIdentity,
    });
    f.store.saveModelResponse(key, { status: 'incomplete', output: [] });
    const refreshed = await f.research('corrupt-third');
    assert.equal(f.state.calls, 3);
    assert.equal(refreshed.research_usage.cache_hits, 0);
  } finally {
    f.service.close();
  }
});

test('模型前规则预筛不发生成请求，幂等读取也不重复研究', async () => {
  const f = fixture();
  try {
    f.state.text = 'We sell camping tents and outdoor cooking equipment. '.repeat(4);
    const result = await f.research('pre-screen');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.research_usage.model_calls, 0);
    assert.equal(result.research_usage.input_chars, 0);
    assert.equal(f.state.calls, 0);
    assert.equal(f.store.get('pre-screen').research.product_match, 'not_matched');
    await f.research('pre-screen');
    assert.equal(f.state.reads, 1);
    assert.equal(f.state.calls, 0);
  } finally {
    f.service.close();
  }
});

test('缓存存储不可用不丢失当前有效响应，也不重试已经发出的模型请求', async () => {
  const f = fixture();
  try {
    f.raw.products = [{ value: 'zip screens', quote: text, source_url: source }];
    f.store.saveModelResponse = () => {
      throw new Error('cache unavailable');
    };
    const result = await f.research('cache-unavailable');
    assert.equal(f.state.calls, 1);
    assert.equal(result.research_usage.model_calls, 1);
    assert.equal(result.research_usage.cache_unavailable, true);
    assert.equal(result.research.company_name, 'Example Blinds');
  } finally {
    f.service.close();
  }
});

test('collect的正文预算约束实际模型输入，完整HTML联系证据不被预算覆盖', async () => {
  const f = fixture();
  try {
    f.state.text =
      text + 'x'.repeat(30000) + ' <a href="mailto:public@blinds.example.org">Contact</a>';
    const collected = await f.service.collect(source);
    assert.equal(collected.research_pages.length, 1);
    assert.ok(collected.research_pages[0].text.length <= 16000);
    assert.equal(collected.input_stats.truncatedPages, 1);
    assert.ok(
      collected.website_metadata.contacts.some(
        (contact) => contact.value === 'public@blinds.example.org',
      ),
    );
    const result = await f.research('bounded-input');
    const sent = JSON.parse(f.state.request.messages[1].content).pages;
    assert.ok(sent.reduce((sum, page) => sum + page.text.length, 0) <= 80000);
    assert.ok(result.research_usage.input_chars <= 80000);
    assert.equal(result.research_usage.truncated_pages, 1);
  } finally {
    f.service.close();
  }
});

test('明确预筛排除跨任务和重启命中，发现过滤且幂等重放不再抓取', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'exclusion-restart-'));
  const path = join(folder, 'operations.sqlite');
  try {
    const first = fixture({ path });
    first.state.text = 'We sell camping tents and outdoor cooking equipment. '.repeat(4);
    const original = await first.research('exclusion-first');
    assert.equal(original.outcome, 'rejected');
    const found = await first.service.discover(input, { query: 'zip screens' });
    assert.equal(found.candidates.length, 0);
    assert.equal(found.skipped_existing_count, 0);
    assert.match(found.filtered_sources[0].reason, /历史排除/);
    const next = await first.research('exclusion-second');
    assert.equal(next.outcome, 'rejected');
    assert.match(next.reason, /exclusion-first/);
    assert.equal(next.research_usage.cache_hits, 0);
    assert.equal(next.research_usage.model_calls, 0);
    assert.equal(next.research_usage.input_chars, 0);
    assert.deepEqual(await first.research('exclusion-second'), next);
    assert.equal(first.state.reads, 1);
    assert.equal(first.state.calls, 0);
    assert.equal(first.state.writes, 0);
    first.service.close();

    const reopened = fixture({ path });
    reopened.state.text = first.state.text;
    const afterRestart = await reopened.research('exclusion-third');
    assert.equal(afterRestart.outcome, 'rejected');
    assert.equal(reopened.state.reads, 0);
    assert.equal(reopened.state.calls, 0);
    assert.equal(reopened.state.writes, 0);
    reopened.service.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('排除按客户库和业务条件隔离，任务预算搜索词与产品排列不改变命中', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'exclusion-conditions-'));
  const path = join(folder, 'operations.sqlite');
  const product = (value, direction, aliases = []) => ({
    value,
    label: value,
    direction,
    group: 'fixture',
    aliases,
  });
  const target = {
    ...input,
    products: [
      product('zip screens', 'finished', ['outdoor screens', 'zip blinds']),
      product('roller blinds', 'finished', ['roller shades']),
    ],
    required_requirements: ['trade supply', 'United States'],
  };
  try {
    const f = fixture({ path });
    f.state.text = 'We sell camping tents and outdoor cooking equipment. '.repeat(4);
    assert.equal((await f.research('conditions-first', target)).outcome, 'rejected');
    const rearranged = {
      ...target,
      products: [...target.products].reverse().map((p) => ({
        ...p,
        aliases: [...p.aliases].reverse(),
      })),
      required_requirements: [...target.required_requirements].reverse(),
      target_count: 50,
      budget: 100,
      search_query: 'different',
      task_id: 'another',
    };
    assert.equal((await f.research('conditions-same', rearranged)).research_usage.model_calls, 0);
    assert.equal(f.state.reads, 1);
    for (const [id, changed] of [
      [
        'direction',
        {
          products: [
            product('zip screens', 'materials', target.products[0].aliases),
            target.products[1],
          ],
        },
      ],
      [
        'alias',
        { products: [product('zip screens', 'finished', ['another name']), target.products[1]] },
      ],
      ['required', { required_requirements: ['trade supply'] }],
    ]) {
      await f.research('conditions-' + id, { ...target, ...changed });
    }
    assert.equal(f.state.reads, 4);
    f.service.close();
    const other = fixture({ path, scope: 'another-library' });
    other.state.text = f.state.text;
    await other.research('conditions-scope', target);
    assert.equal(other.state.reads, 1);
    other.service.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('主动研究有效待核实结论清除旧排除，技术失败保留旧排除', async () => {
  const f = fixture();
  try {
    f.state.text = 'We sell camping tents and outdoor cooking equipment. '.repeat(4);
    assert.equal((await f.research('clear-first')).outcome, 'rejected');
    f.state.text = text;
    f.state.invalid = true;
    const failed = await f.service.research(
      input,
      { source_url: source, operation_id: 'clear-failed' },
      { bypassExclusion: true },
    );
    assert.equal(failed.outcome, 'failed');
    f.state.text = 'We sell camping tents and outdoor cooking equipment. '.repeat(4);
    assert.match((await f.research('clear-still-blocked')).reason, /clear-first/);
    f.state.invalid = false;
    f.state.text = text;
    f.raw.company_name = null;
    const reviewed = await f.service.research(
      input,
      { source_url: source, operation_id: 'clear-reviewed' },
      { bypassExclusion: true },
    );
    assert.equal(reviewed.outcome, 'review');
    const reads = f.state.reads;
    await f.research('clear-after-review');
    assert.equal(f.state.reads, reads + 1);
  } finally {
    f.service.close();
  }
});

test('发现过滤后批任务继续研究其他网站，历史排除不占研究预算', async () => {
  const f = fixture();
  const second = 'https://another.example.org/';
  let researched = 0;
  let manager;
  try {
    f.state.text = 'We sell camping tents and outdoor cooking equipment. '.repeat(4);
    await f.research('batch-excluded');
    f.state.searchResults = [{ url: source }, { url: second }];
    manager = new BatchJobs({
      schedule: false,
      discover: (...args) => f.service.discover(...args),
      research: async (_input, item) => {
        researched++;
        assert.equal(item.source_url, second);
        return {
          outcome: 'rejected',
          reason: 'fixture result',
          research_usage: { model_calls: 0, cache_hits: 0, input_chars: 0 },
        };
      },
      status: async () => ({ settled: false }),
      readLeads: async () => [],
    });
    const job = manager.create(
      { ...input, search_query: 'zip screens', target_count: 1, research_budget: 1 },
      'exclusion-batch',
    );
    await manager.work(job.id);
    const completed = manager.get(job.id);
    assert.equal(researched, 1);
    assert.equal(completed.researched, 1);
    assert.equal(completed.searchStats[0].filtered, 1);
    assert.equal(completed.searchStats[0].queued, 1);
    assert.equal(completed.searchStats[0].researched, 1);
    assert.equal(
      completed.searchStats[0].filterReasons['历史排除：官网内容与目标产品不相关，已预筛排除'],
      1,
    );
  } finally {
    manager?.close();
    f.service.close();
  }
});

test('带指定客户记录的研究绕过排除', async () => {
  const f = fixture();
  try {
    f.state.text = 'We sell camping tents and outdoor cooking equipment. '.repeat(4);
    await f.research('target-excluded');
    f.state.records.push({
      record_id: 'rec-target',
      fields: {
        企业官网: source,
        公司名称: 'Example Blinds',
      },
    });
    f.state.text = text;
    f.raw.products = [{ value: 'zip screens', quote: text, source_url: source }];
    await f.service.research(input, {
      source_url: source,
      target_record_id: 'rec-target',
      operation_id: 'target-research',
    });
    assert.equal(f.state.reads, 2);
    assert.equal(f.state.calls, 1);
  } finally {
    f.service.close();
  }
});

test('主动复核重新抓取并复用模型响应后清除旧排除', async () => {
  const f = fixture();
  try {
    f.raw.company_name = null;
    assert.equal((await f.research('cache-clear-review-first')).outcome, 'review');
    f.state.text = text + ' We sell camping tents to households.';
    f.raw.products = [
      { value: 'camping tents', quote: 'We sell camping tents to households.', source_url: source },
    ];
    assert.equal((await f.research('cache-clear-excluded')).outcome, 'rejected');
    assert.equal(
      f.store.exclusion(exclusionConditionsKey(input), source)?.operation_id,
      'cache-clear-excluded',
    );
    f.state.text = text;
    f.raw.products = [];
    const reads = f.state.reads;
    const calls = f.state.calls;
    const reviewed = await f.service.research(
      input,
      { source_url: source, operation_id: 'cache-clear-reviewed' },
      { bypassExclusion: true },
    );
    assert.equal(reviewed.outcome, 'review');
    assert.equal(reviewed.research_usage.cache_hits, 1);
    assert.equal(reviewed.research_usage.model_calls, 0);
    assert.equal(f.state.reads, reads + 1);
    assert.equal(f.state.calls, calls);
    assert.equal(f.store.exclusion(exclusionConditionsKey(input), source), null);
    await f.research('cache-clear-after-review');
    assert.equal(f.state.reads, reads + 2);
  } finally {
    f.service.close();
  }
});

test('已结算的同一操作重放不清除后来更新的排除', async () => {
  const f = fixture();
  try {
    f.state.text = 'We sell camping tents and outdoor cooking equipment. '.repeat(4);
    await f.research('replay-old-exclusion');
    f.state.text = text;
    f.raw.company_name = null;
    const reviewed = await f.service.research(
      input,
      { source_url: source, operation_id: 'replay-reviewed' },
      { bypassExclusion: true },
    );
    assert.equal(reviewed.outcome, 'review');
    f.state.text = 'We sell camping tents and outdoor cooking equipment. '.repeat(4);
    await f.research('replay-new-exclusion');
    assert.deepEqual(
      await f.service.research(
        input,
        { source_url: source, operation_id: 'replay-reviewed' },
        { bypassExclusion: true },
      ),
      reviewed,
    );
    assert.match((await f.research('replay-still-excluded')).reason, /replay-new-exclusion/);
  } finally {
    f.service.close();
  }
});
