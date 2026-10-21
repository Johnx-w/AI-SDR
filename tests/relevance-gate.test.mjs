import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeAcquisition, selectWebsiteCandidates } from '../server/native-acquisition.mjs';

const env = {
  ACQUISITION_PROVIDER: 'native',
  TAVILY_API_KEY: 'test-tavily',
  DEEPSEEK_API_KEY: 'test-deepseek',
  DEEPSEEK_MODEL: 'deepseek-flash',
  FEISHU_APP_ID: 'test-app',
  FEISHU_APP_SECRET: 'test-secret',
  FEISHU_APP_TOKEN: 'test-base',
  FEISHU_TABLE_ID: 'test-table',
};
const input = {
  country: 'Australia',
  region: '',
  market_countries: ['Australia'],
  product: 'outdoor zip screens, folding arm awnings',
  audience: 'BC',
  customer_type: 'distributor',
  customer_profile: 'all',
  search_query: 'outdoor screens',
  acquisition_channel: 'tavily_web',
};
const site = 'https://camping.example.org/';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

function fixture({ pageText, modelData, existingRecords = [] } = {}) {
  const calls = [];
  const records = JSON.parse(JSON.stringify(existingRecords));
  const fetchImpl = async (urlValue, options = {}) => {
    const url = String(urlValue),
      method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method, body });
    if (url.includes('/auth/v3/'))
      return json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    if (url.endsWith('/fields?page_size=100')) return json({ code: 0, data: { items: [] } });
    if (url.includes('/records?page_size='))
      return json({ code: 0, data: { items: records, has_more: false } });
    if (url === 'https://api.tavily.com/search')
      return json({ results: [{ url: site, title: 'Camping Store' }] });
    if (url === 'https://api.tavily.com/extract') return json({ results: [] });
    if (url === 'https://api.deepseek.com/responses') {
      return json({
        status: 'completed',
        model: 'deepseek-flash',
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(modelData) }] }],
        usage: { input_tokens: 20, output_tokens: 20 },
      });
    }
    throw new Error('Unexpected API endpoint: ' + url);
  };
  const readPage = async () => ({ html: '<p>' + pageText + '</p>' });
  return { calls, records, make: () => new NativeAcquisition({ env, fetchImpl, readPage }) };
}

test('AI 研究前预筛：与目标产品无关的官网直接排除，不调用模型不写飞书', async () => {
  const f = fixture({
    pageText:
      "BCF is Australia's greatest boating, camping and fishing store. Shop tents, kayaks and 4x4 gear with club membership discounts.",
  }),
    svc = f.make();
  try {
    const output = await svc.research(input, {
      source_url: site,
      operation_id: 'relevance-gate-01',
    });
    assert.equal(output.新增, 0);
    assert.ok(JSON.stringify(output).includes('不相关'));
    assert.equal(f.calls.some((c) => c.url.includes('deepseek')), false);
    assert.equal(
      f.calls.some((c) => (c.method === 'POST' && c.url.includes('client_token=')) || c.method === 'PUT'),
      false,
    );
  } finally {
    svc.close();
  }
});

test('AI 研究后审计：国家与目标市场不符时拒绝入库', async () => {
  const evidence = (value, quote) => ({ value, quote, source_url: site });
  const f = fixture({
    pageText:
      'Ziptrak dealer centre for outdoor zip screens and folding arm awnings in Auckland, New Zealand.',
    modelData: {
      company_name: evidence('Auckland Screens', 'Ziptrak dealer centre'),
      actual_country: evidence('New Zealand', 'Auckland, New Zealand'),
      customer_type: evidence('distributor', 'Ziptrak dealer centre'),
      audience: evidence('B', 'dealer centre'),
      main_product_preference: evidence('户外拉链帘经销', 'outdoor zip screens'),
      industry_profile: evidence('窗饰经销企业', 'Ziptrak dealer centre'),
      products: [evidence('outdoor zip screens', 'outdoor zip screens')],
      demand_products: [],
      profile_tags: [evidence('dealer', 'dealer centre')],
      address: null,
      service_areas: [],
    },
  }),
    svc = f.make();
  try {
    const output = await svc.research(input, {
      source_url: site,
      operation_id: 'relevance-audit-01',
    });
    assert.equal(output.新增, 0);
    assert.ok(JSON.stringify(output).includes('国家与目标市场不符'));
    assert.equal(f.calls.some((c) => c.method === 'POST' && c.url.includes('client_token=')), false);
  } finally {
    svc.close();
  }
});

test('候选过滤：新闻站、公报域名与文档文件链接不进入研究队列', () => {
  const r = selectWebsiteCandidates(
    [
      { url: 'https://www.theherald.com.au/business/story' },
      { url: 'https://fginsight.com/news/article' },
      { url: 'https://example.com/brochure.pdf' },
      { url: 'https://example.com/uploads/catalog.xlsx' },
      { url: 'https://news.com.au/press-release' },
      { url: 'https://shades.example.org/' },
    ],
    [],
  );
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].domain, 'shades.example.org');
});
