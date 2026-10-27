import { test } from 'node:test';
import assert from 'node:assert/strict';
import { obviousLogisticsBuyer } from '../server/customs-products.mjs';
import { NativeAcquisition, selectWebsiteCandidates } from '../server/native-acquisition.mjs';
import { CustomsDiscovery, customsSearchPlan } from '../server/customs-discovery.mjs';
import { normalizeShipment } from '../server/customs-provider.mjs';

const researchEnv = {
  ACQUISITION_PROVIDER: 'native',
  TAVILY_API_KEY: 'fixture-search',
  DEEPSEEK_API_KEY: 'fixture-model',
  FEISHU_APP_ID: 'fixture-app',
  FEISHU_APP_SECRET: 'fixture-secret',
  FEISHU_APP_TOKEN: 'fixture-table',
  FEISHU_TABLE_ID: 'fixture-id',
};

test('逐票买方中明确的 transportation 经营名在查官网前排除', () => {
  assert.equal(obviousLogisticsBuyer('HECNY TRANSPORTATION INC.'), true);
  assert.equal(obviousLogisticsBuyer('Maxxmar Inc.'), false);
  assert.equal(obviousLogisticsBuyer('Express Blinds'), false);
});

test('监管注册查询与物流目录不是企业官网，但不泛排政府采购机构', () => {
  const result = selectWebsiteCandidates([
    {
      url: 'https://safer.fmcsa.dot.gov/query.asp?query_type=queryCarrierSnapshot',
      title: 'SAFER Company Snapshot',
    },
    {
      url: 'https://www.freightglobal.com/company/sun-track-express',
      title: 'Freight Forwarder Directory',
    },
    { url: 'https://buyer.example.org/', title: 'Buyer official website' },
    { url: 'https://procurement.example.gov/', title: 'Government procurement office' },
  ]);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.source_url),
    ['https://buyer.example.org/', 'https://procurement.example.gov/'],
  );
});

async function discoverBuyer(
  name,
  results,
  { country = 'Canada', address, onSearch, usages = [], buyerNames = [name] } = {},
) {
  const customs = new CustomsDiscovery({
    now: () => new Date('2026-10-24T00:00:00Z'),
    provider: {
      id: 'fixture-customs',
      searchShipments: async () => ({
        records: buyerNames.map((buyerName, index) =>
          normalizeShipment(
            {
              id: 'record-' + index,
              date: '2026-10-01',
              description: 'BLIND COMPONENTS',
              buyer: { id: 'buyer-' + index, name: buyerName, address },
            },
            'fixture-customs',
          ),
        ),
        total: buyerNames.length,
      }),
    },
  });
  let searchCalls = 0;
  const service = new NativeAcquisition({
    env: {},
    customs,
    feishu: { records: async () => [] },
    providers: {
      web: {
        provider: 'fixture-web',
        search: async (body) => {
          onSearch?.(body);
          const usage = usages[searchCalls++];
          return { results, ...(usage !== undefined ? { usage } : {}) };
        },
      },
      model: {
        provider: 'fixture-model',
        research: async () => {
          throw new Error('No model request permitted');
        },
      },
    },
    fetchImpl: async () => {
      throw new Error('No external request permitted');
    },
  });
  try {
    const input = { country, product: 'blind components' };
    const search = { ...customsSearchPlan(input)[0], run_id: 'fixture-run' };
    return await service.discoverShipments(input, search, []);
  } finally {
    service.close();
  }
}

test('ZMC 的同业搜索结果 Z Blinds 不能冒充该海关买方官网', async () => {
  const found = await discoverBuyer('ZMC', [
    {
      url: 'https://zblinds.com/',
      title: 'Z Blinds Co',
      content: 'Custom window blinds and shades.',
    },
  ]);
  assert.equal(found.candidates.length, 0);
  assert.equal(found.review_candidates.length, 1);
});

test('TETAKAWI BLINDS TO GO 不能仅凭零售品牌名称自动对应 Blinds To Go', async () => {
  const found = await discoverBuyer('TETAKAWI BLINDS TO GO', [
    {
      url: 'https://www.blindstogo.com/',
      title: 'Blinds To Go',
      content: 'Custom blinds and shades retailer.',
    },
  ]);
  assert.equal(found.candidates.length, 0);
  assert.equal(found.review_candidates.length, 1);
});

test('已有五个搜索结果内跳过错名同业，仍可选后续带买方名称依据的官网', async () => {
  const found = await discoverBuyer('ZMC', [
    { url: 'https://zblinds.com/', title: 'Z Blinds Co', content: 'Custom blinds and shades.' },
    { url: 'https://zmc.example.org/', title: 'ZMC | Window Covering Components' },
  ]);
  assert.deepEqual(
    found.candidates.map((candidate) => candidate.source_url),
    ['https://zmc.example.org/'],
  );
  assert.equal(found.review_candidates.length, 0);
});

test('有辨识力的品牌名称证据可来自域名、标题或摘要，不按.com推断经营国', async () => {
  for (const [name, result] of [
    ['MAXXMAR INC.', { url: 'https://www.maxxmar.com/', title: 'Window Fashions' }],
    [
      'SIGNATURE WINDOW COVERINGS INC.',
      { url: 'https://signaturewindowcoverings.com/', title: 'Signature Window Coverings' },
    ],
    [
      'TRIBUTE WINDOW COVERINGS',
      {
        url: 'https://www.twcltd.ca/',
        title: 'Home',
        content: 'Tribute Window Coverings: custom window fashions.',
      },
    ],
    ['COULISSE DISTRIBUTION LLC', { url: 'https://www.coulisse.com/', title: 'Coulisse' }],
  ]) {
    const found = await discoverBuyer(name, [result]);
    assert.equal(found.candidates.length, 1, name);
    assert.equal(found.review_candidates.length, 0, name);
    assert.equal(found.candidates[0].source_kind, 'customs');
  }
});

test('明确地图、评价、贸易聚合资料域名不作为官网，提及它们的企业官网仍保留', () => {
  const result = selectWebsiteCandidates([
    ...[
      'mapquest.com',
      'trustpilot.com',
      'bloomberg.com',
      'panjiva.com',
      'importinfo.com',
      'eximagent.ai',
      'importkey.com',
      'importyeti.com',
      'importgenius.com',
    ].map((host) => ({
      url: 'https://www.' + host + '/company/buyer',
      title: 'Buyer company profile',
    })),
    {
      url: 'https://buyer.example.org/contact?directions=mapquest.com',
      title: 'Buyer contact and map',
    },
    { url: 'https://reviews-dealer.example.org/', title: 'Our Trustpilot customer reviews' },
    { url: 'https://importkey-blinds.example.org/', title: 'ImportKey Blinds official website' },
  ]);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.source_url),
    [
      'https://buyer.example.org/contact?directions=mapquest.com',
      'https://reviews-dealer.example.org/',
      'https://importkey-blinds.example.org/',
    ],
  );
});

test('海关官网定位只用买方名称地址与目标国家，不追加行业搜索词或增加请求', async () => {
  const requests = [];
  await discoverBuyer('ZMC WINDOW COVERING', [], {
    country: 'United States',
    address: 'Fixture office address',
    onSearch: (body) => requests.push(body),
  });
  assert.deepEqual(requests, [
    {
      query: '"ZMC WINDOW COVERING" Fixture office address United States official website',
      search_depth: 'basic',
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      auto_parameters: false,
    },
  ]);
});

test('品牌独立域名优先于仅在摘要提及该品牌的经销商，不把提及当成主体身份', async () => {
  const found = await discoverBuyer('MAXXMAR INC.', [
    {
      url: 'https://blindinfusion.com/',
      title: 'Blind Infusion',
      content: 'We are a dealer for Maxxmar window fashions.',
    },
    { url: 'https://www.maxxmar.com/', title: 'Window Fashions' },
  ]);
  assert.deepEqual(
    found.candidates.map((candidate) => candidate.source_url),
    ['https://www.maxxmar.com/'],
  );
});

test('逐票官网搜索按实际调用汇总供应商 credits，0 也是有效账单读数', async () => {
  const found = await discoverBuyer('MAXXMAR INC.', [], {
    buyerNames: ['MAXXMAR INC.', 'COULISSE DISTRIBUTION LLC'],
    usages: [{ credits: 0 }, { credits: 1.5 }],
  });
  assert.equal(found.usage.web_search_calls, 2);
  assert.equal(found.usage.web_search_credits, 1.5);
});

test('任一搜索请求未返回合法 credits 时总价未知，不能把缺失当 0', async () => {
  for (const usage of [
    undefined,
    {},
    { credits: '1' },
    { credits: -1 },
    { credits: NaN },
    { credits: Infinity },
  ]) {
    const found = await discoverBuyer('MAXXMAR INC.', [], {
      buyerNames: ['MAXXMAR INC.', 'COULISSE DISTRIBUTION LLC'],
      usages: [{ credits: 1 }, usage],
    });
    assert.equal(found.usage.web_search_calls, 2);
    assert.equal(Object.hasOwn(found.usage, 'web_search_credits'), false);
  }
});

test('海关供应商已给名称相符官网时不虚增 web search 调用或生成账单读数', async () => {
  const service = new NativeAcquisition({
    env: {},
    customs: {
      discover: async () => ({
        buyers: [
          {
            id: 'fixture-maxxmar',
            name: 'MAXXMAR INC.',
            product_family: 'blind_components',
            source_url: 'https://www.maxxmar.com/',
            shipments: [],
          },
        ],
        usage: {},
      }),
    },
    feishu: { records: async () => [] },
    providers: {
      web: { search: async () => assert.fail('Search should not be called') },
      model: {},
    },
  });
  try {
    const found = await service.discoverShipments({ country: 'Canada' }, {}, []);
    assert.equal(found.candidates.length, 1);
    assert.equal(found.usage.web_search_calls, 0);
    assert.equal(Object.hasOwn(found.usage, 'web_search_credits'), false);
  } finally {
    service.close();
  }
});

function collectionFixture({ readPage, extract }) {
  return new NativeAcquisition({
    env: researchEnv,
    readPage,
    feishu: { records: async () => [] },
    providers: {
      web: { extract },
      model: { research: async () => assert.fail('No model request permitted') },
    },
    fetchImpl: async () => assert.fail('No external request permitted'),
  });
}

test('官网两轮补采按真实 extract 请求和 credits 汇总，不按 URL 个数计费', async () => {
  let calls = 0;
  const service = collectionFixture({
    readPage: async () => {
      throw new Error('Dynamic page');
    },
    extract: async (body) => ({
      results: [
        {
          url: body.urls[0],
          raw_content:
            calls++ === 0 ? 'Camping tents. [Contact](/contact)' : 'Contact us for camping tents.',
        },
      ],
      usage: { credits: calls === 1 ? 1 : 0 },
    }),
  });
  try {
    const page = await service.collect('https://buyer.example.org/');
    assert.equal(calls, 2);
    assert.deepEqual(page.web_usage, { web_extract_calls: 2, web_extract_credits: 1 });
  } finally {
    service.close();
  }
});

test('采集成功但未用 extract 时只记录 0 次调用，不伪造 credits', async () => {
  const service = collectionFixture({
    readPage: async () => ({ html: '<p>Camping tents and outdoor cooking equipment.</p>' }),
    extract: async () => assert.fail('Extract should not be called'),
  });
  try {
    const page = await service.collect('https://buyer.example.org/');
    assert.deepEqual(page.web_usage, { web_extract_calls: 0 });
  } finally {
    service.close();
  }
});

test('extract 无用量或失败后仍有正文时保留实际调用数，费用未知', async () => {
  for (const usage of [
    undefined,
    { credits: '1' },
    { credits: -1 },
    { credits: Infinity },
    'throw',
  ]) {
    const service = collectionFixture({
      readPage: async (url) => {
        if (url.pathname === '/')
          return { html: '<p>Camping tents.</p><a href="/contact">Contact</a>' };
        throw new Error('Dynamic page');
      },
      extract: async () => {
        if (usage === 'throw') throw new Error('Provider unavailable');
        return { results: [], usage };
      },
    });
    try {
      const page = await service.collect('https://buyer.example.org/');
      assert.deepEqual(page.web_usage, { web_extract_calls: 1 });
    } finally {
      service.close();
    }
  }
});

test('模型前规则拒绝仍将补采账单读数保存到企业研究 operation', async () => {
  const service = collectionFixture({
    readPage: async () => {
      throw new Error('Dynamic page');
    },
    extract: async (body) => ({
      results: [{ url: body.urls[0], raw_content: 'Camping tents and outdoor cooking equipment.' }],
      usage: { credits: 0.5 },
    }),
  });
  try {
    const result = await service.research(
      { country: 'United States', product: 'zip screens', audience: 'BC' },
      {
        source_url: 'https://buyer.example.org/',
        operation_id: 'persist-web-usage',
      },
    );
    assert.equal(result.research_usage.model_calls, 0);
    assert.deepEqual(service.store.get('persist-web-usage').web_usage, {
      web_extract_calls: 1,
      web_extract_credits: 0.5,
    });
  } finally {
    service.close();
  }
});

test('已排队的 ImportKey 贸易档案直接研究也只能待核实，不采集、不调用模型或写远端', async () => {
  const calls = { read: 0, extract: 0, model: 0, write: 0 };
  const service = new NativeAcquisition({
    env: researchEnv,
    readPage: async () => {
      calls.read++;
      return { html: '<p>Window blinds and roller blind fabrics for trade suppliers.</p>' };
    },
    feishu: {
      records: async () => [],
      write: async () => {
        calls.write++;
        throw new Error('No remote write permitted');
      },
    },
    providers: {
      web: {
        extract: async () => {
          calls.extract++;
          return { results: [] };
        },
      },
      model: {
        research: async () => {
          calls.model++;
          return {
            status: 'completed',
            output: [{ content: [{ type: 'output_text', text: '{}' }] }],
          };
        },
      },
    },
    fetchImpl: async () => assert.fail('No external request permitted'),
  });
  try {
    const result = await service.research(
      { country: 'Canada', product: 'roller blind fabrics', audience: 'BC' },
      {
        source_url: 'https://importkey.com/i/2557697-ontario-corp-blind-and-shu',
        source_kind: 'customs',
        operation_id: 'queued-importkey-source',
      },
    );
    assert.equal(result.outcome, 'review');
    assert.equal(result.新增, 0);
    assert.equal(result.research_usage.model_calls, 0);
    assert.deepEqual(calls, { read: 0, extract: 0, model: 0, write: 0 });
    assert.match(result.reason, /第三方|独立官网/);
  } finally {
    service.close();
  }
});

test('已有第三方贸易档案只更新待核实评级与最新依据，保留公司与销售业务字段', async () => {
  const sourceUrl = 'https://importkey.com/i/fixture-ontario-corp';
  const businessFields = {
    公司名称: 'Fixture Ontario Corp',
    来源链接: sourceUrl,
    国家: 'Canada',
    相关产品: 'roller blind fabrics',
    邮箱: 'sales@buyer.example.org',
    开发状态: '人工跟进中',
    人工备注: 'Preserve this sales note',
    首次发现时间: 1,
  };
  const record = { record_id: 'fixture-existing', fields: { ...businessFields, 用户评级: 'A' } };
  const histories = [],
    writes = [];
  const calls = { read: 0, extract: 0, model: 0 };
  const service = new NativeAcquisition({
    env: {
      ...researchEnv,
      FEISHU_ASSESSMENT_TABLE_ID: 'fixture-t12',
    },
    readPage: async () => {
      calls.read++;
      return { html: '<p>Window blinds and roller blind fabrics for trade suppliers.</p>' };
    },
    feishu: {
      records: async (tableId) => (tableId === 'fixture-t12' ? histories : [record]),
      record: async (id, tableId) =>
        tableId === 'fixture-t12' ? histories.find((row) => row.record_id === id) : record,
      fields: async (tableId) =>
        tableId === 'fixture-t12'
          ? [
              ...Object.entries({
                评估ID: 1,
                评估时间: 5,
                用户评级: 3,
                评分: 2,
                评级依据: 1,
                规则版本: 1,
              }).map(([field_name, type]) => ({ field_name, type })),
              { field_name: '客户', type: 18, property: { table_id: 'fixture-id' } },
            ]
          : [
              { field_name: '用户评级', type: 3 },
              { field_name: '最近研究时间', type: 5 },
              { field_name: '评级依据', type: 1 },
            ],
      write: async (action, fields, id, clientToken, tableId) => {
        writes.push({ action, fields: structuredClone(fields), id, tableId });
        if (tableId === 'fixture-t12') {
          const history = { record_id: 'fixture-history', fields: structuredClone(fields) };
          histories.push(history);
          return history;
        }
        assert.equal(action, 'update');
        assert.equal(id, record.record_id);
        Object.assign(record.fields, fields);
        return record;
      },
    },
    providers: {
      web: {
        extract: async () => {
          calls.extract++;
          return { results: [] };
        },
      },
      model: {
        research: async () => {
          calls.model++;
          throw new Error('No model request permitted');
        },
      },
    },
    fetchImpl: async () => assert.fail('No external request permitted'),
  });
  try {
    const result = await service.research(
      { country: 'Canada', product: 'roller blind fabrics', audience: 'BC' },
      {
        source_url: sourceUrl,
        target_record_id: record.record_id,
        operation_id: 'existing-importkey-source',
      },
    );
    assert.equal(result.新增, 0);
    assert.equal(result.更新, 1);
    assert.equal(result.assessment.score, 0);
    assert.equal(result.assessment.complete, false);
    assert.deepEqual(calls, { read: 0, extract: 0, model: 0 });
    assert.match(record.fields['用户评级'], /待核实/);
    assert.match(record.fields['评级依据'], /第三方贸易\/平台档案.*不是企业官网/);
    assert.deepEqual(
      Object.fromEntries(Object.keys(businessFields).map((key) => [key, record.fields[key]])),
      businessFields,
    );
    assert.deepEqual(
      Object.keys(writes.find((write) => !write.tableId).fields).sort(),
      ['最近研究时间', '用户评级', '评级依据'].sort(),
    );
    assert.equal(histories.length, 0, '不再写入飞书评估历史');
    const current = service.assessmentHistory(record.record_id).assessment;
    assert.equal(current.score, 0);
    assert.match(current.evidenceReason, /第三方贸易\/平台档案.*不是企业官网/);
  } finally {
    service.close();
  }
});
