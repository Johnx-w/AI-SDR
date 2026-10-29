import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeAcquisition, selectWebsiteCandidates } from '../server/native-acquisition.mjs';
import { verifyCompanyIdentity } from '../server/company-identity.mjs';

const env = {
  ACQUISITION_PROVIDER: 'native',
  TAVILY_API_KEY: 'fixture-search',
  DEEPSEEK_API_KEY: 'fixture-model',
  FEISHU_APP_ID: 'fixture-app',
  FEISHU_APP_SECRET: 'fixture-secret',
  FEISHU_APP_TOKEN: 'fixture-table',
  FEISHU_TABLE_ID: 'fixture-id',
};

test('未列黑名单的贸易买方档案也不能由搜索标题摘要冒充企业官网', () => {
  const result = selectWebsiteCandidates([
    {
      url: 'https://trade-data.example.org/importer/acme-screens',
      title: 'Acme Screens - US Customs Import Data | Bill of Lading Records',
      content:
        'Search importers and suppliers. View shipment history. Subscribe to unlock trade data.',
    },
    { url: 'https://acmescreens.example.org/', title: 'Acme Screens | Window Screens' },
  ]);
  assert.deepEqual(
    result.candidates.map((row) => row.domain),
    ['acmescreens.example.org'],
  );
});

test('监管与统计资料在研究前过滤，企业新闻和政府采购候选仍保留', () => {
  const result = selectWebsiteCandidates([
    {
      url: 'https://www.cpsc.gov/Safety-Education/Safety-Education-Centers/Window-Covering',
      title: 'Window Covering Cords | Consumer Product Safety Commission',
    },
    {
      url: 'https://www.census.gov/naics/',
      title: 'North American Industry Classification System',
    },
    {
      url: 'https://supplier.example.com/news/new-roller-blinds',
      title: 'New Roller Blinds | Example Window Supplier',
    },
    { url: 'https://procurement.example.gov/', title: 'Government procurement office' },
    { url: 'https://parts.example.org/catalog', title: 'Window blind components supplier' },
  ]);
  assert.deepEqual(
    result.candidates.map((row) => row.domain),
    ['supplier.example.com', 'procurement.example.gov', 'parts.example.org'],
  );
  assert.deepEqual(
    result.filtered_sources.map((row) => row.reason),
    ['监管或统计资料', '监管或统计资料'],
  );
});

test('直接研究已知监管资料时不抓网页、不调用模型或写客户', async () => {
  const service = new NativeAcquisition({
    env,
    readPage: async () => assert.fail('Regulatory source must not be collected'),
    feishu: {
      records: async () => [],
      write: async () => assert.fail('No remote write permitted'),
    },
    providers: {
      web: { extract: async () => assert.fail('No extraction permitted') },
      model: { research: async () => assert.fail('No model request permitted') },
    },
    fetchImpl: async () => assert.fail('No network request permitted'),
  });
  try {
    for (const item of [
      {
        source_url:
          'https://www.cpsc.gov/Safety-Education/Safety-Education-Centers/Window-Covering',
        operation_id: 'regulatory-source-filter',
      },
      {
        source_url: 'https://www.census.gov/',
        source_title: 'North American Industry Classification System',
        operation_id: 'statistical-source-filter',
      },
    ]) {
      const result = await service.research(
        { country: 'United States', product: 'window coverings', audience: 'BC' },
        item,
      );
      assert.equal(result.outcome, 'review');
      assert.match(result.reason, /非官网页面/);
    }
  } finally {
    service.close();
  }
});

test('企业介绍自身进口和货运业务、或引用第三方评价时不被平台特征误杀', () => {
  const result = selectWebsiteCandidates([
    {
      url: 'https://acmescreens.example.org/',
      title: 'Acme Screens | Window Screens',
      content:
        'We import zip screens and manage shipment records for our orders. Read our Trustpilot reviews.',
    },
  ]);
  assert.equal(result.candidates.length, 1);
});

test('旧队列中的未知贸易平台由正式研究入口正文识别，不能请求模型或写飞书', async () => {
  let modelCalls = 0;
  let writes = 0;
  const service = new NativeAcquisition({
    env,
    readPage: async () => ({
      html: '<title>Acme Screens - US Customs Import Data</title><h1>Acme Screens</h1><p>Search importers and suppliers. Bill of lading records and shipment history. Subscribe to unlock trade data. Product: zip screens.</p>',
    }),
    feishu: {
      records: async () => [],
      write: async () => {
        writes++;
        assert.fail('No remote write permitted');
      },
    },
    providers: {
      web: { extract: async () => assert.fail('No extraction needed') },
      model: {
        research: async () => {
          modelCalls++;
          throw new Error('No model request permitted');
        },
      },
    },
    fetchImpl: async () => assert.fail('No network request permitted'),
  });
  try {
    const result = await service.research(
      { country: 'United States', product: 'zip screens', audience: 'BC' },
      {
        source_url: 'https://trade-data.example.org/importer/acme-screens',
        operation_id: 'unknown-third-party-profile',
      },
    );
    assert.equal(modelCalls, 0);
    assert.equal(writes, 0);
    assert.equal(result.outcome, 'review');
    assert.match(result.reason, /第三方|独立官网/);
  } finally {
    service.close();
  }
});

test('只在经销商摘要提及品牌时不排队为该海关买方官网', async () => {
  const service = new NativeAcquisition({
    env,
    customs: {
      discover: async () => ({
        buyers: [{ id: 'maxxmar', name: 'MAXXMAR INC.', shipments: [], product_family: 'fabrics' }],
        usage: {},
      }),
    },
    feishu: { records: async () => [] },
    providers: {
      web: {
        search: async () => ({
          results: [
            {
              url: 'https://localdealer.example.org/',
              title: 'Local Dealer Blinds',
              content: 'We are an authorized dealer for Maxxmar window fashions.',
            },
          ],
        }),
      },
      model: {},
    },
  });
  try {
    const found = await service.discoverShipments({ country: 'Canada' }, {}, []);
    assert.equal(found.candidates.length, 0);
    assert.equal(found.review_candidates.length, 1);
  } finally {
    service.close();
  }
});

test('产品品牌和客户/贸易记录主体不是网页自身经营者', () => {
  const source = 'https://localdealer.example.org/';
  for (const quote of [
    'We sell Maxxmar window fashions.',
    'Our brands include Maxxmar.',
    'Shipment records for Maxxmar.',
    'Our customers include Maxxmar.',
  ]) {
    const result = verifyCompanyIdentity(
      [{ field: 'company_name', value: 'Maxxmar', quote, source_url: source }],
      [{ source_url: source, text: quote }],
      source,
    );
    assert.equal(result.name, null, quote);
  }
});

test('同一海关买方保留有界的多个官网候选，后续主体冲突时还能继续核实', async () => {
  const service = new NativeAcquisition({
    env,
    customs: {
      discover: async () => ({
        buyers: [
          {
            id: 'acme',
            name: 'ACME WINDOW COVERINGS INC.',
            shipments: [],
            product_family: 'fabrics',
          },
        ],
        usage: {},
      }),
    },
    feishu: { records: async () => [] },
    providers: {
      web: {
        search: async () => ({
          results: ['ca', 'us', 'uk', 'au'].map((country) => ({
            url: `https://acme-${country}.example.org/`,
            title: 'Acme Window Coverings',
          })),
        }),
      },
      model: {},
    },
  });
  try {
    const found = await service.discoverShipments({ country: 'United States' }, {}, []);
    assert.deepEqual(
      found.candidates.map((row) => row.domain),
      ['acme-ca.example.org', 'acme-us.example.org', 'acme-uk.example.org'],
    );
    assert.equal(new Set(found.candidates.map((row) => row.customs_buyer_key)).size, 1);
    assert.ok(found.candidates[0].customs_buyer_key);
  } finally {
    service.close();
  }
});
