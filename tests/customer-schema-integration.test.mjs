import test from 'node:test';
import assert from 'node:assert/strict';
import { mapFeishuRecord } from '../server/feishu.mjs';
import { FeishuClient, encodeResearchFields, recordsForDomain } from '../server/feishu-direct.mjs';
import { assertAssessmentIdentity } from '../server/customer-assessment.mjs';
import { mergeResearchFields, researchFields } from '../server/company-research.mjs';

const official = 'https://buyer.example.org/';
const discovery = 'https://trade.example.org/buyers/window-company';
const demandBefore =
  'blind motors\n依据：We are seeking suppliers of blind motors.\n来源：https://buyer.example.org/sourcing';
const demandAfter =
  'screen fabrics\n依据：We are seeking screen fabric suppliers.\n来源：https://buyer.example.org/sourcing';

const definitions = [
  ['公司名称', 1],
  ['customer_id', 1],
  ['来源链接', 15],
  ['企业官网', 15],
  ['国家', 1],
  ['客户类型', 1],
  ['企业经营产品', 1],
  ['主营产品概况', 1],
  ['公开采购需求', 1],
  ['企业服务客群', 1],
  ['广告代码', 1],
  ['客户行业画像', 1],
  ['初评结果', 3],
  ['最近研究时间', 5],
  ['主要供货机会', 1],
  ['待确认事项', 1],
  ['邮箱', 1],
].map(([field_name, type]) => ({ field_name, type }));

const rawResearch = {
  公司名称: 'Window Company LLC',
  customer_id: 'web_buyer.example.org',
  来源链接: discovery,
  企业官网: official,
  客户类型: '批发商',
  用户评级: 'A',
  相关产品: '定制卷帘',
  主营产品偏好: '面向渠道销售定制卷帘',
  需求产品: demandAfter,
  服务客群: 'B端',
  主要供货机会: '成品 · 卷帘（潜在供货机会）',
  待确认事项: '采购量和负责人待沟通',
};

function fixture(initial, tableDefinitions = definitions) {
  const record = structuredClone(initial);
  const writes = [];
  const calls = [];
  const client = new FeishuClient({
    env: {
      FEISHU_APP_ID: 'fixture-app',
      FEISHU_APP_SECRET: 'fixture-secret',
      FEISHU_APP_TOKEN: 'fixture-base',
      FEISHU_TABLE_ID: 't2-table',
    },
    fetchImpl: async (value, options = {}) => {
      const url = new URL(value);
      const method = options.method || 'GET';
      calls.push({ pathname: url.pathname, method });
      if (url.pathname.endsWith('/tenant_access_token/internal'))
        return Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 });
      if (url.pathname.endsWith('/tables/t2-table/fields') && method === 'GET')
        return Response.json({ code: 0, data: { items: tableDefinitions, has_more: false } });
      if (
        /\/tables\/(?:t2-table|t5-table)\/records\/fixture-record$/.test(url.pathname) &&
        method === 'PUT'
      ) {
        const { fields } = JSON.parse(options.body);
        writes.push(fields);
        record.fields = { ...record.fields, ...fields };
        return Response.json({ code: 0, data: { record } });
      }
      throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
    },
  });
  return { client, record, calls, writes };
}

test('迁移后的企业档案读取新字段，并区分企业官网、发现来源和公开采购需求', () => {
  const lead = mapFeishuRecord({
    record_id: 'fixture-record',
    fields: {
      公司名称: 'Window Company LLC',
      初评结果: 'A',
      用户评级: 'C',
      企业经营产品: '定制卷帘',
      相关产品: '旧产品描述',
      主营产品概况: '面向渠道销售定制卷帘',
      公开采购需求: demandBefore,
      企业服务客群: 'B端',
      企业官网: { text: '企业独立官网', link: official },
      来源链接: discovery,
      主要供货机会: '成品 · 卷帘（潜在供货机会）',
      待确认事项: '采购量待沟通',
      开发状态: '人工跟进中',
    },
  });
  assert.equal(lead.grade, 'A');
  assert.match(lead.product, /定制卷帘/);
  assert.doesNotMatch(lead.product, /旧产品描述/);
  assert.equal(lead.mainProductPreference, '面向渠道销售定制卷帘');
  assert.equal(lead.demandProducts, demandBefore);
  assert.equal(lead.audience, 'B端');
  assert.equal(lead.website, official);
  assert.equal(lead.domain, 'buyer.example.org');
  assert.equal(lead.source, discovery);
  assert.equal(lead.supplyOpportunity, '成品 · 卷帘（潜在供货机会）');
  assert.equal(lead.pendingQuestions, '采购量待沟通');
  assert.equal(lead.status, '人工跟进中');
});

test('同一第三方来源不会合并不同官网的企业，旧记录仍可按原官网去重', () => {
  const buyer = {
    record_id: 'buyer',
    fields: { 企业官网: { text: 'Buyer', link: official }, 来源链接: discovery },
  };
  const other = {
    record_id: 'other',
    fields: { 企业官网: 'https://other.example.org/', 来源链接: discovery },
  };
  const legacy = { record_id: 'legacy', fields: { 来源链接: official + 'contact' } };
  assert.deepEqual(
    recordsForDomain([buyer, other, legacy], 'buyer.example.org').map((row) => row.record_id),
    ['buyer', 'legacy'],
  );
  assert.deepEqual(recordsForDomain([buyer, other], 'trade.example.org'), []);
});

test('评估身份按企业官网链接核对，不把第三方发现页或链接标题作为客户主体', () => {
  const customer = {
    fields: { 企业官网: { text: '企业独立官网', link: official }, 来源链接: discovery },
  };
  assert.doesNotThrow(() =>
    assertAssessmentIdentity(
      { id: 'fixture-evaluation', website: official + 'products' },
      customer,
    ),
  );
  assert.throws(
    () => assertAssessmentIdentity({ id: 'fixture-evaluation', website: discovery }, customer),
    { status: 409 },
  );
  assert.throws(
    () =>
      assertAssessmentIdentity(
        { id: 'fixture-evaluation', website: 'https://other.example.org/' },
        customer,
      ),
    { status: 409 },
  );
});

test('旧研究结果经过迁移字段编码后仅写新名称，并保持URL字段类型', () => {
  const encoded = encodeResearchFields(rawResearch, definitions);
  assert.equal(encoded['初评结果'], 'A');
  assert.equal(encoded['企业经营产品'], '定制卷帘');
  assert.equal(encoded['主营产品概况'], '面向渠道销售定制卷帘');
  assert.equal(encoded['公开采购需求'], demandAfter);
  assert.equal(encoded['企业服务客群'], 'B端');
  assert.deepEqual(encoded['企业官网'], { text: official, link: official });
  assert.deepEqual(encoded['来源链接'], { text: discovery, link: discovery });
  for (const oldName of ['用户评级', '相关产品', '主营产品偏好', '需求产品', '服务客群'])
    assert.equal(Object.hasOwn(encoded, oldName), false);
  assert.throws(
    () =>
      encodeResearchFields(
        rawResearch,
        definitions.filter((field) => field.field_name !== '公开采购需求'),
      ),
    /缺少迁移必需字段/,
  );
  assert.throws(
    () =>
      encodeResearchFields(
        rawResearch,
        definitions.map((field) =>
          field.field_name === '公开采购需求' ? { ...field, type: 3 } : field,
        ),
      ),
    /必须为文本/,
  );
  const alreadyCurrent = encodeResearchFields(
    {
      公司名称: 'Current Company',
      企业官网: official,
      初评结果: 'B',
      企业经营产品: '卷帘',
      公开采购需求: demandAfter,
    },
    definitions,
  );
  assert.equal(alreadyCurrent['公开采购需求'], demandAfter);
  assert.equal(alreadyCurrent['初评结果'], 'B');
});

test('研究更新追加公开采购证据，保留已有证据和销售人工维护的信息', async () => {
  const existing = {
    record_id: 'fixture-record',
    fields: {
      公司名称: 'Window Company LLC',
      企业官网: { text: official, link: official },
      来源链接: { text: discovery, link: discovery },
      公开采购需求: demandBefore,
      邮箱: 'buyer@buyer.example.org',
      开发状态: '已寄样，等待客户反馈',
      主责业务员: 'Johnson',
      客户固定邮箱: 'sales@our-brand.example.org',
      下次跟进时间: 1793001600000,
    },
  };
  const before = structuredClone(existing);
  const incoming = researchFields(
    {
      company_name: 'Window Company LLC',
      demand_products: ['screen fabrics'],
      facts: [
        {
          field: 'demand_products',
          value: 'screen fabrics',
          quote: 'We are seeking screen fabric suppliers.',
          source_url: official + 'sourcing',
        },
      ],
    },
    { contacts: [{ kind: 'email', value: 'trade@buyer.example.org' }] },
  );
  const merged = mergeResearchFields(existing.fields, incoming);
  const encoded = encodeResearchFields({ ...merged, 企业官网: official }, definitions);
  for (const field of ['开发状态', '主责业务员', '客户固定邮箱', '下次跟进时间'])
    assert.equal(Object.hasOwn(encoded, field), false, `研究不应提交人工字段：${field}`);
  const remote = fixture(existing);
  await remote.client.write('update', encoded, existing.record_id);
  assert.equal(remote.record.fields['公开采购需求'], demandBefore + '\n' + demandAfter);
  assert.equal(remote.record.fields['邮箱'], 'buyer@buyer.example.org\ntrade@buyer.example.org');
  for (const field of ['开发状态', '主责业务员', '客户固定邮箱', '下次跟进时间'])
    assert.deepEqual(remote.record.fields[field], before.fields[field]);
  assert.deepEqual(existing, before, '研究合并不应原地修改原始档案');
});

test('本轮没有找到采购需求时不清空既有公开采购证据', () => {
  const existing = {
    公司名称: 'Window Company LLC',
    企业官网: official,
    公开采购需求: demandBefore,
    开发状态: '人工跟进中',
  };
  const incoming = researchFields(
    { company_name: 'Window Company LLC', products: ['roller blinds'] },
    {},
  );
  const encoded = encodeResearchFields(
    { ...mergeResearchFields(existing, incoming), 企业官网: official },
    definitions,
  );
  assert.equal(Object.hasOwn(encoded, '公开采购需求'), false);
  const persisted = { ...existing, ...encoded };
  assert.equal(persisted['公开采购需求'], demandBefore);
  assert.equal(persisted['开发状态'], '人工跟进中');
});

test('恢复中的旧T2写入按实时表定义转为新字段，不再提交已改名的字段', async () => {
  const remote = fixture({
    record_id: 'fixture-record',
    fields: { 公司名称: 'Window Company LLC' },
  });
  await remote.client.write(
    'update',
    {
      用户评级: 'A',
      相关产品: '卷帘',
      主营产品偏好: '定制窗饰供货',
      需求产品: demandBefore,
      服务客群: 'B端',
    },
    'fixture-record',
  );
  assert.deepEqual(remote.writes, [
    {
      初评结果: 'A',
      企业经营产品: '卷帘',
      主营产品概况: '定制窗饰供货',
      公开采购需求: demandBefore,
      企业服务客群: 'B端',
    },
  ]);
  assert.equal(remote.calls.filter((call) => call.pathname.endsWith('/t2-table/fields')).length, 1);
  assert.equal(mapFeishuRecord(remote.record).grade, 'A');
});

test('显式写入T5时不会套用T2的字段迁移规则', async () => {
  const remote = fixture({ record_id: 'fixture-record', fields: {} });
  const fields = { 产品名称: '卷帘资料', 相关产品: '该表自行定义的同名字段' };
  await remote.client.write('update', fields, 'fixture-record', undefined, 't5-table');
  assert.deepEqual(remote.writes, [fields]);
  assert.equal(
    remote.calls.some((call) => call.pathname.endsWith('/t2-table/fields')),
    false,
  );
});
