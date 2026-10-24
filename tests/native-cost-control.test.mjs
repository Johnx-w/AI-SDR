import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeAcquisition } from '../server/native-acquisition.mjs';
import { AcquisitionStore } from '../server/acquisition-store.mjs';
import { researchCacheKey } from '../server/research-reuse.mjs';
import { companyResearchSchema } from '../server/company-research.mjs';

const source = 'https://blinds.example.org/';
const text =
  'Example Blinds supplies zip screens to dealers nationwide in the United States. We are a window coverings business with a showroom and product catalogue for trade customers.';
const env = {
  ACQUISITION_PROVIDER: 'native',
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

function fixture({ identity = { provider: 'fixture', model: 'text-v1' } } = {}) {
  const state = {
    text,
    calls: 0,
    reads: 0,
    writes: 0,
    invalid: false,
    request: null,
    records: [],
    assessments: [],
  };
  const store = new AcquisitionStore(':memory:', 'cost-test');
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
    web: { extract: async () => ({ results: [] }) },
  };
  const service = new NativeAcquisition({
    env,
    store,
    providers,
    assessments: {
      scope: 'cost-test',
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
        { field_name: '广告代码', type: 1 },
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
    assert.equal(result.research_usage.model_calls, 0);
    assert.equal(result.research_usage.input_chars, 0);
    assert.equal(f.state.calls, 0);
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
