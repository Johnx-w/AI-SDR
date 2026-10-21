import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAdvertisingCodes } from '../server/advertising-codes.mjs';
import { parseCompanyResearch, researchFields } from '../server/company-research.mjs';
import { validateTarget } from '../server/search-target.mjs';
import { searchPlan } from '../server/batch-jobs.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';
const url = 'https://company.example.org/';
test('广告代码只从追踪配置提取；去重并保留来源，不读取查询参数或普通正文', () => {
  const html = `<p>AW-99999999</p><a href="?gclid=1234">ad</a>
    <script>gtag('config', 'AW-123456789');fbq('init', '123456789012345');</script>
    <script>fbq('init', '123456789012345');ttq.load('ABCDEFGHIJKLMNOPQRST');</script>`;
  const codes = extractAdvertisingCodes(html, url);
  assert.deepEqual(
    codes.map((c) => c.id),
    ['AW-123456789', '123456789012345', 'ABCDEFGHIJKLMNOPQRST'],
  );
  assert.ok(codes.every((c) => c.source_url === url && html.includes(c.quote)));
  assert.deepEqual(extractAdvertisingCodes('fbq init 123456789', url), []);
});
const text =
  'Acme is a wholesale distributor of imported shades, with no own factory. We supply dealers nationwide. We are seeking suppliers of blind motors. Looking for blinds? Shop our range.';
const fact = (value, quote) => ({ value, quote, source_url: url });
const raw = {
  company_name: fact('Acme', 'Acme'),
  entity_type: fact(
    'business',
    'Acme is a wholesale distributor of imported shades, with no own factory.',
  ),
  production_model: fact('no_own_factory', 'imported shades, with no own factory'),
  operating_model: fact('beyond_local', 'We supply dealers nationwide.'),
  customer_type: fact('wholesaler', 'wholesale distributor of imported shades'),
  industry_profile: fact('面向渠道批发窗饰的企业', 'wholesale distributor of imported shades'),
  profile_tags: [fact('trade', 'wholesale distributor of imported shades')],
  demand_products: [
    fact('blind motors', 'We are seeking suppliers of blind motors.'),
    fact('blinds', 'Looking for blinds? Shop our range.'),
    fact('fabric', 'We buy fabric, invented text'),
  ],
  products: [fact('shades', 'wholesale distributor of imported shades')],
};
const response = (data) => ({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }],
});
const page = { source_url: url, research_pages: [{ source_url: url, text }] };
test('需求产品需要企业自身公开采购证据；行业画像和客户类型来自原文', () => {
  const r = parseCompanyResearch(response(raw), page, {
    customer_type: 'wholesaler',
    customer_profile: 'trade',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.demand_products, ['blind motors']);
  assert.equal(r.customer_type, 'wholesaler');
  const fields = researchFields(r, {
    advertising_codes: [{ platform: 'Meta Pixel', id: '123456789', source_url: url }],
  });
  assert.equal(fields['客户类型'], '批发商');
  assert.match(fields['需求产品'], /blind motors\n依据：We are seeking/);
  assert.match(fields['客户行业画像'], /批发窗饰/);
  assert.match(fields['广告代码'], /Meta Pixel: 123456789/);
  assert.equal(fields['客户等级'], undefined);
  assert.equal(researchFields({}, {})['需求产品'], undefined);
});
test('选择类型或画像后不符合条件、无法核实的企业不能计作匹配', () => {
  assert.equal(
    parseCompanyResearch(response(raw), page, { customer_type: 'manufacturer' }).ok,
    false,
  );
  assert.equal(
    parseCompanyResearch(response(raw), page, { customer_profile: 'project' }).ok,
    false,
  );
  assert.equal(
    parseCompanyResearch(response({ ...raw, customer_type: null }), page, {
      customer_type: 'manufacturer',
    }).customer_type_match,
    'unknown',
  );
  assert.equal(
    parseCompanyResearch(response({ ...raw, profile_tags: [] }), page, {
      customer_profile: 'project',
    }).ok,
    false,
  );
});
test('欧洲搜索不含英国，客户类型与画像贯穿校验、搜索计划和飞书读回', () => {
  const t = validateTarget({
    country: 'Europe',
    product: 'shades',
    customer_type: 'wholesaler',
    customer_profile: 'trade',
  });
  assert.equal(t.customer_type, 'wholesaler');
  assert.ok(!t.market_countries.includes('United Kingdom'));
  assert.ok(
    searchPlan(t).every((p) => p.country !== 'United Kingdom' && p.query.includes('wholesaler')),
  );
  assert.throws(() => validateTarget({ ...t, customer_type: 'invalid' }));
  assert.throws(() => validateTarget({ ...t, customer_profile: 'invalid' }));
  const lead = mapFeishuRecord({
    record_id: 'rec-test',
    fields: { 广告代码: 'Meta Pixel: 123', 需求产品: 'motors', 客户行业画像: '窗饰批发' },
  });
  assert.equal(lead.demandProducts, 'motors');
  assert.equal(lead.industryProfile, '窗饰批发');
  assert.equal(lead.advertisingCodes, 'Meta Pixel: 123');
});
