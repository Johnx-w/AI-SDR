import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupWebsiteEvidence,
  websiteEvidenceFieldLabel,
} from '../src/domain/website-evidence.mjs';

const home = 'https://buyer.example.org/';
const fact = (field, value, quote = 'Exact original quotation.', source_url = home) => ({
  field,
  value,
  quote,
  source_url,
});

test('企业身份与研究中的同一事实合并，所有不同引文和来源仍完整保留', () => {
  const name = fact('company_name', 'Acme Screens', 'Acme Screens', home);
  const identity = fact(
    'company_name',
    'Acme Screens',
    'Acme Screens legal notice',
    home + 'privacy',
  );
  const groups = groupWebsiteEvidence([name, name, identity], [identity]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].category, '企业名称');
  assert.equal(groups[0].records.length, 2);
  assert.deepEqual(groups[0].records, [identity, name]);
  assert.match(groups[0].summary, /Acme Screens/);
});

test('客户类型字段别名及同一经营产品合并，主营与副线原分类保留在记录中', () => {
  const groups = groupWebsiteEvidence([
    fact('customer_type', 'retailer'),
    fact('customer_types', 'retailer'),
    fact('products', 'Roller Blinds'),
    fact('core_product', 'roller blinds'),
    fact('secondary_product', 'Roller-Blinds 产品线'),
  ]);
  assert.equal(groups.length, 2);
  assert.match(groups[0].summary, /零售商/);
  assert.equal(groups[0].records.length, 2);
  assert.equal(groups[1].summary, '经营产品：卷帘');
  assert.deepEqual(
    groups[1].records.map((record) => record.field),
    ['products', 'core_product', 'secondary_product'],
  );
  assert.equal(websiteEvidenceFieldLabel('core_product'), '主营产品');
  assert.equal(websiteEvidenceFieldLabel('secondary_product'), '明确经营品类');
});

test('矛盾的值与不同业务命题不会因共用原文或来源被合并', () => {
  const groups = groupWebsiteEvidence([
    fact('production_model', 'own_factory'),
    fact('production_model', 'no_own_factory'),
    fact('products', 'Roller Shades'),
    fact('manufactured_products', 'Roller Shades'),
    fact('profile_tags', 'trade'),
    fact('customer_type', 'wholesaler'),
  ]);
  assert.equal(groups.length, 6);
  assert.match(groups[0].summary, /自有工厂/);
  assert.match(groups[1].summary, /无自有工厂/);
  assert.doesNotMatch(groups[4].summary, /采购|进口|采购意向/);
});

test('摘要为简短中文展示，完整的长文本、换行和链接逐字保留', () => {
  const longEnglish =
    'This is an unfamiliar English business statement whose details must not be guessed. '.repeat(
      8,
    );
  const chinese = '经营窗饰产品并提供安装服务。'.repeat(20);
  const quote = 'First line\n  Second line with whitespace.\n';
  const groups = groupWebsiteEvidence([
    fact('industry_profile', longEnglish, quote, home + 'detail?at=2026-10-24T10:00:00Z'),
    fact('main_product_preference', chinese),
    fact('service_areas', 'Greater Melbourne and suburbs'),
    fact('actual_country', 'Australia'),
  ]);
  for (const group of groups) {
    assert.ok(group.summary.length <= 100);
    assert.match(group.summary, /[\u3400-\u9fff]/);
  }
  assert.doesNotMatch(groups[0].summary, /unfamiliar|whose details/);
  assert.equal(groups[0].records[0].value, longEnglish);
  assert.equal(groups[0].records[0].quote, quote);
  assert.equal(groups[0].records[0].source_url, home + 'detail?at=2026-10-24T10:00:00Z');
  assert.match(groups[2].summary, /大墨尔本及周边/);
  assert.match(groups[3].summary, /澳大利亚/);
});

test('不猜测未知枚举或未知英文字段，不把原型属性误认为业务分类', () => {
  const groups = groupWebsiteEvidence([
    fact('production_model', 'partner_network'),
    fact('customer_types', 'constructor'),
    fact('__proto__', 'some arbitrary sentence'),
    fact('customer_types', '__proto__'),
    fact('future_business_field', 'unknown code'),
  ]);
  assert.equal(groups.length, 5);
  for (const group of groups) {
    assert.match(group.summary, /已记录/);
    assert.doesNotMatch(group.summary, /自有工厂|零售商|批发商|function|\[object Object\]/);
  }
  assert.equal(websiteEvidenceFieldLabel('future_business_field'), '其他官网事实');
  assert.equal(websiteEvidenceFieldLabel('constructor'), '其他官网事实');
});

test('缺失或不安全的来源保持原值，空值命题的不同引文不被误合并', () => {
  const groups = groupWebsiteEvidence([
    fact('company_name', 'Acme', 'Public name', ''),
    fact('company_name', 'Acme', 'Name on supplied page', 'javascript:alert(1)'),
    fact('preference_evidence', '', 'Different claim A', home),
    fact('preference_evidence', '', 'Different claim B', home),
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].records[0].source_url, '');
  assert.equal(groups[0].records[1].source_url, 'javascript:alert(1)');
  assert.equal(groups[1].category, '补充要求相关证据');
  assert.equal(groups[1].records[0].quote, 'Different claim A');
  assert.equal(groups[2].records[0].quote, 'Different claim B');
});

test('旧结构数组和对象安全展示，规范对象键顺序去重但保留原始值', () => {
  const role = ['retailer', 'service_provider'];
  const one = { street: '12 Main St', city: 'Sydney' };
  const two = { city: 'Sydney', street: '12 Main St' };
  const groups = groupWebsiteEvidence([
    fact('customer_types', role),
    fact('address', one),
    fact('address', two),
    { kind: 'custom_made', value: '按尺寸定制', quote: 'Made to measure' },
  ]);
  assert.equal(groups.length, 3);
  assert.match(groups[0].summary, /零售商、服务商/);
  assert.equal(groups[0].records[0].value, JSON.stringify(role));
  assert.equal(groups[1].records.length, 2);
  assert.equal(groups[1].records[0].value, JSON.stringify(one));
  assert.equal(groups[2].category, '定制特征');
});

test('呈现分组不修改输入，空或异常记录保持空结果', () => {
  const input = [fact('entity_type', 'business'), fact('company_years', '25')];
  const before = structuredClone(input);
  const groups = groupWebsiteEvidence(input);
  assert.deepEqual(input, before);
  assert.match(groups[0].summary, /企业经营主体/);
  assert.match(groups[1].summary, /官网自述持续经营 25 年/);
  assert.equal(groups[0].id, groupWebsiteEvidence(input)[0].id);
  assert.deepEqual(groupWebsiteEvidence(null, null), []);
  assert.deepEqual(groupWebsiteEvidence([null, false, 1, {}, { field: 'products' }]), []);
});
