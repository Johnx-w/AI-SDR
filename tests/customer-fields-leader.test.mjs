import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  CUSTOMER_FIELD_ALIASES,
  CUSTOMER_TABLE_FIELD_ALIASES,
  canonicalCustomerFields,
  customerFieldHelpers,
  customerWebsite,
  customerProfileSummary,
  customerOpportunitySummary,
  encodeCustomerFields,
  fieldValue,
  resolveCustomerField,
} from '../server/customer-fields.mjs';

const definition = (field_name, type = 1) => ({ field_name, type });
const leaderDefinitions = [
  definition('国家/地区'),
  definition('城市/区域'),
  definition('官网链接'),
  definition('最新客户评级', 3),
  definition('客户画像摘要'),
  definition('客户类型', 4),
  definition('主营产品偏好', 18),
  definition('主营产品概况'),
  definition('企业经营产品'),
];

test('领导T2同义列读写兼容，现行标准列优先，不改变历史迁移字段清单', () => {
  for (const [canonical, names] of Object.entries(CUSTOMER_TABLE_FIELD_ALIASES)) {
    const alternate = names[0];
    assert.equal(fieldValue({ [alternate]: '保存原值' }, canonical), '保存原值');
    assert.equal(fieldValue({ [canonical]: '现行值', [alternate]: '另一值' }, alternate), '现行值');
    assert.equal(resolveCustomerField([definition(alternate)], canonical), alternate);
    assert.equal(
      resolveCustomerField([definition(canonical), definition(alternate)], alternate),
      canonical,
    );
    assert(!Object.hasOwn(CUSTOMER_FIELD_ALIASES, alternate));
  }
  const fields = {
    '国家/地区': 'Australia',
    '城市/区域': 'Sydney',
    最新客户评级: 'A',
    客户画像摘要: '原文依据',
  };
  assert.deepEqual(canonicalCustomerFields(fields), {
    国家: 'Australia',
    '州 / 城市': 'Sydney',
    用户评级: 'A',
    客户行业画像: '原文依据',
  });
  assert.equal(customerWebsite({ 官网链接: 'https://example.org/' }), 'https://example.org/');
  assert.equal(fields['国家/地区'], 'Australia');
});

test('领导T2仅客户类型多选转换为完整标签数组，不重分类、不改源对象', () => {
  const fields = {
    国家: 'Australia',
    '州 / 城市': 'Sydney',
    企业官网: { text: '企业官网', link: 'https://example.org/' },
    用户评级: 'A',
    客户行业画像: '保留来源依据',
    客户类型: '零售商、经销商; 服务商，零售商\nwholesaler',
    获客渠道: 'Google网页搜索;LinkedIn',
    未知字段: '不可静默丢弃',
  };
  const before = structuredClone(fields);
  const encoded = encodeCustomerFields(fields, [...leaderDefinitions, definition('获客渠道', 4)]);
  assert.deepEqual(encoded, {
    '国家/地区': 'Australia',
    '城市/区域': 'Sydney',
    官网链接: 'https://example.org/',
    最新客户评级: 'A',
    客户画像摘要: '保留来源依据',
    客户类型: ['零售商', '经销商', '服务商', 'wholesaler'],
    获客渠道: fields.获客渠道,
    未知字段: fields.未知字段,
  });
  assert.deepEqual(fields, before);
  assert.deepEqual(encodeCustomerFields({ 客户类型: '' }, leaderDefinitions), { 客户类型: [] });
  assert.deepEqual(
    encodeCustomerFields({ 客户类型: ['零售商', '经销商'] }, [definition('客户类型')]),
    { 客户类型: '零售商、经销商' },
  );
  assert.throws(() => encodeCustomerFields({ 客户类型: [42] }, leaderDefinitions), /文本标签/);
});

test('标准T2保持字符串字段与超链接显示文本，不改变清空和未知字段', () => {
  const link = { text: '查看官网', link: 'https://example.org/' };
  const definitions = [
    definition('国家'),
    definition('客户类型'),
    definition('企业官网', 15),
    definition('初评结果', 3),
  ];
  assert.deepEqual(
    encodeCustomerFields(
      {
        国家: 'Australia',
        客户类型: '零售商、服务商',
        企业官网: link,
        初评结果: null,
        其他: '原值',
      },
      definitions,
    ),
    {
      国家: 'Australia',
      客户类型: '零售商、服务商',
      企业官网: link,
      初评结果: null,
      其他: '原值',
    },
  );
  assert.deepEqual(encodeCustomerFields({ 官网链接: 'https://example.org/' }, definitions), {
    企业官网: { text: 'https://example.org/', link: 'https://example.org/' },
  });
  assert.throws(() => encodeCustomerFields({ 企业官网: { link: 42 } }, definitions), /格式不兼容/);
});

test('主营产品偏好关联字段永不被当成主营产品文本，新增文本列单独承接', () => {
  const references = [{ record_ids: ['recProduct'], table_id: 't5', text: '产品标题' }];
  assert.equal(resolveCustomerField([definition('主营产品偏好', 18)], '主营产品概况'), undefined);
  assert.equal(resolveCustomerField(leaderDefinitions, '主营产品偏好'), '主营产品概况');
  assert.equal(fieldValue({ 主营产品偏好: references }, '主营产品概况'), undefined);
  assert.equal(
    fieldValue({ 主营产品偏好: references, 主营产品概况: '企业经营事实' }, '主营产品偏好'),
    '企业经营事实',
  );
  const original = { 主营产品偏好: references, 主营产品概况: '企业经营事实' };
  assert.deepEqual(canonicalCustomerFields(original), original);
  assert.deepEqual(encodeCustomerFields({ 主营产品偏好: '企业经营事实' }, leaderDefinitions), {
    主营产品概况: '企业经营事实',
  });
  assert.deepEqual(encodeCustomerFields({ 主营产品偏好: references }, leaderDefinitions), {
    主营产品偏好: references,
  });
  assert.deepEqual(encodeCustomerFields({ 主营产品偏好: [] }, leaderDefinitions), {
    主营产品偏好: [],
  });
  assert.throws(
    () => encodeCustomerFields({ 主营产品偏好: '企业经营事实' }, [definition('主营产品偏好', 18)]),
    /不能写入/,
  );
  assert.equal(
    resolveCustomerField([definition('主营产品偏好', 1)], '主营产品概况'),
    '主营产品偏好',
  );
  assert.equal(
    fieldValue({ 主营产品偏好: [{ text: '旧文本值' }] }, '主营产品概况')[0].text,
    '旧文本值',
  );
});

test('序列化研究字段辅助函数兼容领导列名并保留独立产品关联', () => {
  const fields = {
    '国家/地区': 'Australia',
    最新客户评级: 'A',
    主营产品偏好: [{ record_ids: ['recProduct'], table_id: 't5' }],
  };
  const sandbox = runInNewContext(customerFieldHelpers + '\ncanonicalCustomerFields(fields)', {
    fields,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox)),
    JSON.parse(JSON.stringify(canonicalCustomerFields(fields))),
  );
});

test('原T2复用自动客户ID，删除的技术列不再写入，摘要只展示最新一段', () => {
  const definitions = [
    ...leaderDefinitions,
    definition('客户ID', 1005),
    definition('主要供货机会'),
    definition('评级依据摘要'),
  ];
  const profile =
    '旧摘要\n依据：old quote\n来源：https://example.org/\n' +
    '最新企业摘要\n依据：new quote\n换行证据\n来源：https://example.org/about';
  const fields = {
    customer_id: 'web_example.org',
    来源链接: 'https://directory.example/company',
    企业官网: 'https://example.org/',
    需求产品: '原始采购证据',
    客户行业画像: profile,
    主要供货机会: '成品 · E ZIP Blinds（潜在供货机会）\n成品 · Other（适配待核实，潜在供货机会）',
    评级依据摘要: '主营产品已核实',
  };
  const encoded = encodeCustomerFields(fields, definitions);
  assert.deepEqual(encoded, {
    官网链接: 'https://example.org/',
    客户画像摘要: '最新企业摘要',
    主要供货机会: '成品 · E ZIP Blinds\n成品 · Other（适配待核实，潜在供货机会）',
    评级依据摘要: '主营产品已核实',
  });
  assert.equal(fields.客户行业画像, profile, '原始证据不变');
  assert(!Object.hasOwn(encoded, '客户ID'), '不能写入自动编号');
  assert.equal(customerProfileSummary('只保留一段\n\n其他补充'), '只保留一段 其他补充');
  assert.equal(
    customerProfileSummary('查看[企业介绍](https://example.org/about) https://example.org/'),
    '查看企业介绍',
  );
  assert.equal(customerOpportunitySummary('成品 · ZIP（潜在供货机会）'), '成品 · ZIP');
  assert.equal(customerProfileSummary(''), '');
});
