import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeAcquisition, selectWebsiteCandidates } from '../server/native-acquisition.mjs';
import { AcquisitionStore } from '../server/acquisition-store.mjs';
import { FeishuClient } from '../server/feishu-direct.mjs';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { createApp } from '../server/app.mjs';

const site = 'https://acme.example.org/';
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
  country: 'United States',
  region: 'Florida',
  product: 'zip screens',
  audience: 'BC',
  customer_type: '',
  customer_profile: 'all',
  search_query: 'zip screens Florida',
  acquisition_channel: 'tavily_web',
};
const sourceText =
  'Acme Screens imports zip screens from independent factories. We supply dealers and installers nationwide, without our own factory.';
const definitions = [
  ...[
    '客户名称',
    '来源链接',
    'customer_id',
    '主体类型',
    '相关产品',
    '主营产品偏好',
    '广告代码',
    '需求产品',
    '客户行业画像',
    '服务客群',
    '电话',
    '邮箱',
    '国家',
    '州 / 城市',
    '详细地址',
    '服务地区',
    'Facebook',
    'Instagram',
    'LinkedIn',
    'WhatsApp',
  ].map((field_name) => ({ field_name, type: 1 })),
  { field_name: '首次发现时间', type: 5 },
  { field_name: '客户类型', type: 3 },
];
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

function fixture({
  initial = [],
  loseWrite = false,
  loseReadback = false,
  lateDuplicate = false,
  corruptReadback = false,
  tavilyError = false,
  pageText = sourceText,
  modelOverrides = {},
} = {}) {
  const calls = [],
    records = JSON.parse(JSON.stringify(initial));
  let lists = 0,
    loseRead = loseReadback;
  const fetchImpl = async (urlValue, options = {}) => {
    const url = String(urlValue),
      method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method, body, headers: options.headers });
    if (url.includes('/auth/v3/'))
      return json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    if (url.endsWith('/fields?page_size=100'))
      return json({ code: 0, data: { items: definitions, has_more: false } });
    if (url.includes('/records?page_size=')) {
      lists++;
      if (lateDuplicate && lists === 2)
        records.push({
          record_id: 'rec-other',
          fields: { 来源链接: site, 客户名称: 'Other' },
        });
      return json({ code: 0, data: { items: records, has_more: false } });
    }
    if (url.includes('/records?client_token=') && method === 'POST') {
      const record = { record_id: 'rec-native', fields: body.fields };
      records.push(record);
      if (loseWrite) throw new Error('upstream response lost');
      return json({ code: 0, data: { record } });
    }
    if (url.includes('/records/rec-') && method === 'PUT') {
      const record = records.find((r) => url.endsWith('/' + r.record_id));
      Object.assign(record.fields, body.fields);
      return json({ code: 0, data: { record } });
    }
    if (url.includes('/records/rec-') && method === 'GET') {
      if (loseRead) {
        loseRead = false;
        throw new Error('read unavailable');
      }
      const record = records.find((r) => url.endsWith('/' + r.record_id));
      return json({
        code: 0,
        data: {
          record: corruptReadback
            ? { ...record, fields: { ...record.fields, 客户名称: 'Wrong' } }
            : record,
        },
      });
    }
    if (url === 'https://api.tavily.com/search') {
      if (tavilyError) return json({ error: 'test-secret never expose' }, 401);
      return json({ results: [{ url: site, title: 'Acme Screens' }] });
    }
    if (url === 'https://api.tavily.com/extract') return json({ results: [] });
    if (url === 'https://api.deepseek.com/responses') {
      const evidence = (value, quote) => ({ value, quote, source_url: site });
      const data = {
        company_name: evidence('Acme Screens', sourceText),
        entity_type: evidence('business', sourceText),
        production_model: evidence('no_own_factory', sourceText),
        operating_model: evidence('beyond_local', sourceText),
        manufactured_products: [],
        actual_country: null,
        customer_type: evidence('distributor', sourceText),
        audience: evidence('B', sourceText),
        main_product_preference: evidence('主营 zip screens。', sourceText),
        industry_profile: evidence('窗饰进口经销企业', sourceText),
        products: [evidence('zip screens', sourceText)],
        demand_products: [],
        profile_tags: [evidence('trade', sourceText)],
        address: null,
        service_areas: [],
        ...modelOverrides,
      };
      return json({
        status: 'completed',
        model: 'deepseek-flash',
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
        usage: { input_tokens: 20, output_tokens: 20 },
      });
    }
    throw new Error('Unexpected API endpoint: ' + url);
  };
  const readPage = async (url) => ({
    html:
      url.pathname === '/'
        ? '<p>' + pageText + '</p><a href="/contact">Contact us</a>'
        : '<p>Contact our team</p><a href="mailto:sales@acme.example.org">Email</a>',
  });
  const make = (extra = {}) => new NativeAcquisition({ env, fetchImpl, readPage, ...extra });
  return { calls, records, fetchImpl, readPage, make };
}

const policyFact = (value, quote) => ({ value, quote, source_url: site });
for (const [scenarioIndex, scenario] of [
  {
    name: '个人装修求购账号，即使有公司名或选择 C 端也淘汰',
    text: 'I am John Smith, a homeowner looking for zip screens for my own house. This is a personal consumer account, not a trading business.',
    fields: {
      entity_type: 'individual',
      production_model: 'unknown',
      operating_model: 'unknown',
      audience: 'C',
    },
    target: { audience: 'C' },
    code: 'individual_consumer',
  },
  {
    name: '同属窗饰行业但目标品类不符',
    text: 'Acme Screens imports Roman blinds from other factories and sells them nationwide. We do not own a factory.',
    fields: {},
    products: ['Roman blinds'],
    productMismatch: true,
  },
  { name: '缺少主体证据', fields: { entity_type: null }, code: 'entity_unknown' },
].entries()) {
  test('明确硬冲突不新增飞书：' + scenario.name, async () => {
    const quote = scenario.text || sourceText;
    const facts = Object.fromEntries(
      Object.entries({
        entity_type: 'business',
        production_model: 'no_own_factory',
        operating_model: 'beyond_local',
        ...scenario.fields,
      }).map(([key, value]) => [key, value === null ? null : policyFact(value, quote)]),
    );
    const f = fixture({
      pageText: quote,
      modelOverrides: {
        ...facts,
        company_name: policyFact('Acme Screens', quote),
        products: (scenario.products || ['zip screens']).map((p) => policyFact(p, quote)),
        manufactured_products: [],
        profile_tags: ['trade'].map((p) => policyFact(p, quote)),
      },
    });
    const svc = f.make();
    try {
      const output = await svc.research(
        { ...input, ...scenario.target },
        { source_url: site, operation_id: 'policy-blocked-' + scenarioIndex },
      );
      assert.equal(output.新增, 0);
      assert.equal(output.更新, 0);
      assert.equal(output.research.ok, false);
      if (scenario.productMismatch) assert.equal(output.research.product_match, 'not_matched');
      else assert.equal(output.research.eligibility.code, scenario.code);
      assert.equal(
        f.calls.some((c) => c.url.includes('/records') && ['POST', 'PUT'].includes(c.method)),
        false,
      );
    } finally {
      svc.close();
    }
  });
}

test('工厂、本地服务和经营范围未知不再构成全局淘汰', async () => {
  for (const [index, scenario] of [
    {
      text: 'Acme Screens manufactures zip screens in our own factory and supplies dealers.',
      fields: { production_model: 'own_factory', customer_type: 'manufacturer' },
      manufactured: ['zip screens'],
    },
    {
      text: 'Acme Screens installs imported zip screens for local homeowners in Florida.',
      fields: { operating_model: 'local_only', customer_type: 'service_provider', audience: 'C' },
    },
    { text: sourceText, fields: { production_model: null, operating_model: null } },
  ].entries()) {
    const facts = Object.fromEntries(
      Object.entries({
        entity_type: 'business',
        production_model: 'no_own_factory',
        operating_model: 'beyond_local',
        ...scenario.fields,
      }).map(([key, value]) => [key, value === null ? null : policyFact(value, scenario.text)]),
    );
    const f = fixture({
      pageText: scenario.text,
      modelOverrides: {
        ...facts,
        company_name: policyFact('Acme Screens', scenario.text),
        products: [policyFact('zip screens', scenario.text)],
        manufactured_products: (scenario.manufactured || []).map((p) =>
          policyFact(p, scenario.text),
        ),
      },
    });
    const svc = f.make();
    try {
      const output = await svc.research(input, {
        source_url: site,
        operation_id: 'eligible-business-' + index,
      });
      assert.equal(output.research.eligibility.status, 'eligible');
      assert.equal(output.新增, 1);
    } finally {
      svc.close();
    }
  }
});

test('C 端经营企业可以入库：全国销售、进口渠道、兼营本地安装与个人经营账号', async () => {
  for (const text of [
    'Acme Screens imports zip screens from independent factories and sells to homeowners nationwide. We do not own a factory.',
    'I operate Acme Screens, importing zip screens from other manufacturers for homeowners nationwide. I install locally too, without my own factory.',
  ]) {
    const f = fixture({
      pageText: text,
      modelOverrides: {
        company_name: policyFact('Acme Screens', text),
        entity_type: policyFact('business', text),
        production_model: policyFact('no_own_factory', text),
        operating_model: policyFact('beyond_local', text),
        audience: policyFact('C', text),
        products: [policyFact('zip screens', text)],
      },
    });
    const svc = f.make();
    try {
      const output = await svc.research(
        { ...input, audience: 'C' },
        { source_url: site, operation_id: 'eligible-c-business' },
      );
      assert.equal(output.research.eligibility.status, 'eligible');
      assert.equal(output.新增, 1);
      assert.equal(f.records[0].fields.来源链接, site);
      assert.equal(f.records[0].fields.服务客群, 'C端');
    } finally {
      svc.close();
    }
  }
});

test('自产成品但明确采购目标配件的工厂可入库，不等同于同品类配件制造同行', async () => {
  const text =
    'Acme Screens manufactures outdoor zip screens in our own factory for dealers nationwide. We are seeking suppliers of zip screen motors.';
  const f = fixture({
      pageText: text,
      modelOverrides: {
        company_name: policyFact('Acme Screens', text),
        entity_type: policyFact('business', text),
        production_model: policyFact('own_factory', text),
        operating_model: policyFact('beyond_local', text),
        customer_type: policyFact('manufacturer', text),
        products: [policyFact('outdoor zip screens', text)],
        manufactured_products: [policyFact('outdoor zip screens', text)],
        demand_products: [
          policyFact('zip screen motors', 'We are seeking suppliers of zip screen motors.'),
        ],
      },
    }),
    svc = f.make();
  try {
    const out = await svc.research(
      { ...input, product: 'outdoor blinds awnings components and parts' },
      {
        source_url: site,
        operation_id: 'eligible-component-buyer',
      },
    );
    assert.equal(out.research.product_match, 'matched');
    assert.equal(out.research.eligibility.status, 'eligible');
    assert.equal(out.新增, 1);
    assert.match(f.records[0].fields.需求产品, /zip screen motors/);
  } finally {
    svc.close();
  }
});

test('伪造、缺失或其他 URL 的准入证据不允许放行', async () => {
  for (const badFact of [
    policyFact('business', 'invented business evidence'),
    { ...policyFact('business', sourceText), source_url: 'https://other.example.org/' },
    policyFact('business', sourceText + '\nThis invented policy fact must not be accepted.'),
  ]) {
    const f = fixture({ modelOverrides: { entity_type: badFact } }),
      svc = f.make();
    try {
      const out = await svc.research(input, {
        source_url: site,
        operation_id: 'invalid-policy-evidence',
      });
      assert.equal(out.research.eligibility.code, 'entity_unknown');
      assert.equal(out.新增, 0);
      assert.equal(
        f.calls.some((c) => c.url.includes('/records') && ['POST', 'PUT'].includes(c.method)),
        false,
      );
    } finally {
      svc.close();
    }
  }
});

test('已移除市场不能绕过 API 直接搜索、研究或使用旧搜索计划', async () => {
  const f = fixture(),
    svc = f.make();
  try {
    for (const country of ['Southeast Asia', 'Singapore', 'Thailand']) {
      await assert.rejects(
        svc.discover({ ...input, country }, { country, query: 'zip screens' }),
        /支持的国家/,
      );
      await assert.rejects(
        svc.research({ ...input, country }, { source_url: site, operation_id: 'retired-market' }),
        /支持的国家/,
      );
    }
    await assert.rejects(
      svc.discover(input, { country: 'Singapore', query: 'zip screens' }),
      /市场范围/,
    );
    await assert.rejects(
      svc.research({ ...input, product: '' }, { source_url: site, operation_id: 'empty-product' }),
      /product.*不能为空/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    svc.close();
  }
});

test('直连候选排除目录、社媒、招聘、私网、已收录域名，按官网去重', () => {
  const r = selectWebsiteCandidates(
    [
      { url: 'https://facebook.com/company' },
      { url: 'https://127.0.0.1/' },
      { url: 'https://local.internal/' },
      { url: 'https://www.yellowpages.com/company' },
      { url: 'https://company.example.org/jobs/' },
      { url: site },
      { url: site + 'contact' },
      { url: 'https://old.example.org/' },
    ],
    ['old.example.org'],
  );
  assert.equal(r.candidates.length, 1);
  assert.equal(r.skipped_existing_count, 1);
});

test('Feishu 直连缓存令牌并完整遍历分页；重复游标报错', async () => {
  let auth = 0,
    page = 0;
  const client = new FeishuClient({
    env,
    fetchImpl: async (url) => {
      if (url.includes('/auth/')) {
        auth++;
        return json({ code: 0, tenant_access_token: 'token', expire: 7200 });
      }
      page++;
      return json({
        code: 0,
        data: {
          items: [{ record_id: 'r' + page }],
          has_more: page === 1,
          page_token: page === 1 ? 'next' : '',
        },
      });
    },
  });
  assert.equal((await client.records()).length, 2);
  assert.equal(auth, 1);
  const bad = new FeishuClient({
    env,
    fetchImpl: async (url) =>
      url.includes('/auth/')
        ? json({ code: 0, tenant_access_token: 'token', expire: 7200 })
        : json({ code: 0, data: { items: [], has_more: true, page_token: 'repeat' } }),
  });
  await assert.rejects(bad.records(), /分页不完整/);
});

test('HTTP 首页失败后从 Tavily 正文发现联系页，仍限制同域与五页预算', async () => {
  const f = fixture(),
    reads = [];
  const svc = f.make({
    readPage: async (url) => {
      reads.push(url.href);
      if (url.href === site) throw new Error('blocked HTTP');
      return { html: '<p>Contact team</p><a href="mailto:public@acme.example.org">Email</a>' };
    },
    fetchImpl: async (url, options) => {
      if (url === 'https://api.tavily.com/extract')
        return json({
          results: [
            { url: site, raw_content: sourceText + '\n[Contact](' + site + 'contact)' },
            { url: 'https://other.example.org/', raw_content: 'Unrelated company evidence' },
          ],
        });
      return f.fetchImpl(url, options);
    },
  });
  try {
    const page = await svc.collect(site);
    assert.ok(reads.includes(site + 'contact'));
    assert.ok(page.website_metadata.contacts.some((c) => c.value === 'public@acme.example.org'));
    assert.ok(page.research_pages.every((p) => p.source_url.startsWith(site)));
    assert.ok(reads.length <= 5);
  } finally {
    svc.close();
  }
});

test('缺少直连凭证时禁止运行，但允许查看历史；不会退回 n8n', async () => {
  let calls = 0;
  const app = createApp({
    env: { ACQUISITION_PROVIDER: 'native' },
    fetchImpl: async () => {
      calls++;
      throw new Error('must not call');
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const root = 'http://127.0.0.1:' + app.address().port + '/api/v1/acquisition';
  try {
    const status = await (await fetch(root + '/status')).json();
    assert.equal(status.configured, false);
    assert.ok(status.missing.includes('FEISHU_APP_SECRET'));
    assert.equal((await fetch(root + '/jobs')).status, 200);
    assert.equal(
      (
        await fetch(root + '/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      503,
    );
    assert.equal(calls, 0);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('原生研究贯通官网补全、来源校验、飞书写入及读回；幂等操作不重复调用', async () => {
  const f = fixture(),
    svc = f.make();
  const item = { source_url: site, operation_id: 'native-success-01' };
  try {
    const output = await svc.research(input, item);
    assert.equal(output.新增, 1);
    assert.equal(output.明细[0].record_id, 'rec-native');
    assert.equal(f.records[0].fields.邮箱, 'sales@acme.example.org');
    assert.equal(f.records[0].fields.国家, undefined);
    assert.equal(f.records[0].fields.客户等级, undefined);
    const count = f.calls.length;
    assert.deepEqual(await svc.research(input, item), output);
    assert.equal(f.calls.length, count);
    await assert.rejects(svc.research({ ...input, product: 'changed' }, item), /不能更换/);
    assert.ok(f.calls.every((c) => !c.url.includes('n8n')));
    const modelCall = f.calls.find((c) => c.url.includes('deepseek'));
    assert.equal(modelCall.body.text.format.type, 'json_schema');
    assert.equal(modelCall.body.model, 'deepseek-flash');
    assert.ok(modelCall.body.input[1].content.includes('Contact our team'));
  } finally {
    svc.close();
  }
});

test('仅发现候选不调用 AI 或写入；平台错误不暴露响应正文', async () => {
  const f = fixture(),
    svc = f.make();
  try {
    assert.equal((await svc.discover(input, { query: input.search_query })).candidates.length, 1);
    assert.equal(
      f.calls.some((c) => c.url.includes('deepseek') || c.method === 'PUT'),
      false,
    );
  } finally {
    svc.close();
  }
  const bad = fixture({ tavilyError: true }),
    service = bad.make();
  try {
    await assert.rejects(
      service.discover(input, { query: input.search_query }),
      (e) => /HTTP 401/.test(e.message) && !e.message.includes('test-secret'),
    );
  } finally {
    service.close();
  }
});

test('已有客户与研究期间新收录的企业均跳过，重复域名转人工核对', async () => {
  for (const options of [
    { initial: [{ record_id: 'rec-old', fields: { 来源链接: site } }] },
    { lateDuplicate: true },
    { initial: ['rec-a', 'rec-b'].map((record_id) => ({ record_id, fields: { 来源链接: site } })) },
  ]) {
    const f = fixture(options),
      svc = f.make();
    try {
      const output = await svc.research(input, {
        source_url: site,
        operation_id: 'duplicate-test',
      });
      assert.equal(output.新增, 0);
      assert.ok(output.skipped_existing_count || output.待人工查重);
      assert.equal(
        f.calls.some((c) => c.url.includes('client_token=')),
        false,
      );
    } finally {
      svc.close();
    }
  }
});

test('定向复核只更新原记录的采集字段，保留人工跟进状态和首次发现时间', async () => {
  const f = fixture({
      initial: [
        {
          record_id: 'rec-old',
          fields: {
            来源链接: site,
            客户名称: 'Old',
            开发状态: '已联系',
            负责人: 'Sales',
            备注: '人工备注',
            首次发现时间: 1000,
            customer_id: 'old-customer',
          },
        },
      ],
    }),
    svc = f.make();
  try {
    const output = await svc.research(input, {
      source_url: site,
      operation_id: 'update-target-01',
      target_record_id: 'rec-old',
    });
    assert.equal(output.更新, 1);
    const write = f.calls.find((c) => c.method === 'PUT');
    for (const field of ['开发状态', '负责人', '备注', '首次发现时间', 'customer_id'])
      assert.equal(write.body.fields[field], undefined);
    assert.equal(f.records[0].fields.备注, '人工备注');
  } finally {
    svc.close();
  }
});

test('写请求响应丢失后按域名核对结果；重复请求及重启不再次新增', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'native-write-'));
  const path = join(folder, 'operations.sqlite'),
    f = fixture({ loseWrite: true });
  let svc = f.make({ store: new AcquisitionStore(path) });
  const item = { source_url: site, operation_id: 'uncertain-write-01' };
  try {
    await assert.rejects(svc.research(input, item), /待核对/);
    const recovered = await svc.status(item.operation_id);
    assert.equal(recovered.settled, true);
    assert.equal(recovered.output.新增, 1);
    svc.close();
    svc = f.make({ store: new AcquisitionStore(path) });
    const repeated = await svc.research(input, item);
    assert.equal(repeated.新增, 1);
    assert.equal(f.records.length, 1);
    assert.equal(
      f.calls.filter((c) => c.method === 'POST' && c.url.includes('client_token=')).length,
      1,
    );
  } finally {
    svc.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('已返回记录编号后读回短暂中断，由受控重试完成且不重复写入', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'native-read-'));
  const path = join(folder, 'operations.sqlite'),
    f = fixture({ loseReadback: true });
  let svc = f.make({ store: new AcquisitionStore(path) });
  try {
    const first = await svc.research(input, {
      source_url: site,
      operation_id: 'readback-recovery-01',
    });
    assert.equal(first.新增, 1);
    svc.close();
    svc = f.make({ store: new AcquisitionStore(path) });
    const result = await svc.status('readback-recovery-01');
    assert.equal(result.settled, true);
    assert.equal(result.output.新增, 1);
    assert.equal(f.records.length, 1);
  } finally {
    svc.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('读回字段不一致不宣称成功；跨域跳转与缺少正文不调用模型', async () => {
  const f = fixture({ corruptReadback: true }),
    svc = f.make();
  try {
    await assert.rejects(
      svc.research(input, {
        source_url: site,
        operation_id: 'corrupt-readback-01',
      }),
      /待核对/,
    );
    assert.equal((await svc.status('corrupt-readback-01')).settled, false);
  } finally {
    svc.close();
  }
  const redirected = fixture(),
    service = redirected.make({
      readPage: async () => ({ redirect: 'https://other.example.org/' }),
    });
  try {
    const out = await service.research(input, {
      source_url: site,
      operation_id: 'redirect-test-01',
    });
    assert.equal(out.新增, 0);
    assert.equal(
      redirected.calls.some((c) => c.url.includes('deepseek')),
      false,
    );
  } finally {
    service.close();
  }
});

test('迁移后旧引擎的暂停任务无法交给新引擎继续', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'native-provider-')),
    path = join(folder, 'jobs.sqlite');
  let manager = new BatchJobs({ path, schedule: false, provider: 'n8n' });
  const job = manager.create({ ...input, target_count: 1 }, 'provider-switch-test');
  manager.close();
  manager = new BatchJobs({ path, schedule: false, provider: 'native' });
  try {
    await assert.rejects(manager.resume(job.id), /其他执行引擎/);
  } finally {
    manager.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('统一获客接口以 native 引擎完成单家批量任务，无 n8n 请求且不泄露凭证', async () => {
  const f = fixture(),
    svc = f.make();
  const app = createApp({ env, fetchImpl: f.fetchImpl, nativeImpl: svc });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const root = 'http://127.0.0.1:' + app.address().port + '/api/v1/acquisition';
  try {
    const status = await (await fetch(root + '/status')).json();
    assert.equal(status.configured, true);
    assert.equal(status.provider, 'native');
    assert.equal(JSON.stringify(status).includes('test-secret'), false);
    const response = await fetch(root + '/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'native-batch-01' },
      body: JSON.stringify({ ...input, target_count: 1 }),
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    let final;
    for (let n = 0; n < 100; n++) {
      final = await (await fetch(root + '/jobs/' + created.id)).json();
      if (final.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(final.status, 'completed');
    assert.equal(final.inserted, 1);
    assert.equal(final.provider, 'native');
    assert.ok(f.calls.every((c) => !c.url.includes('n8n')));
    const history = await (await fetch(root + '/executions')).json();
    assert.equal(history.data[0].status, 'completed');
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
