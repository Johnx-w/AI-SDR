import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCompanyResearch, researchFields } from '../server/company-research.mjs';
import { encodeResearchFields } from '../server/feishu-direct.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';
import { AcquisitionStore } from '../server/acquisition-store.mjs';
import { planWebsitePages } from '../server/website-metadata.mjs';
import vm from 'node:vm';
import { researchPolicyCode } from '../scripts/research-policy-code.mjs';

const source_url = 'https://screens.example.org/';
const fact = (value, quote) => ({ value, quote, source_url });
const parse = (raw, text) =>
  parseCompanyResearch(
    { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] },
    { source_url, research_pages: [{ source_url, text }] },
  );

test('真实引文不能为引文中不存在的公司名背书', () => {
  const text = 'We supply blinds to businesses nationwide.';
  const result = parse({ company_name: fact('Invented Imports LLC', text) }, text);
  assert.equal(result.company_name, null);
  assert.ok(!result.facts.some((f) => f.field === 'company_name'));
});

test('从产品伙伴、网站制作商和非关联声明中取得的名称不能成为公司名', () => {
  for (const text of [
    'We are an authorized dealer for Acme Screens.',
    'Website by Acme Screens.',
    'We are not affiliated with Acme Screens.',
    'Payment processed by Acme Screens.',
  ])
    assert.equal(parse({ company_name: fact('Acme Screens', text) }, text).company_name, null);
});

test('明确经营主体名称优先，品牌名作为别名保留并留原始出处', () => {
  const text = 'Bright Screens is a trading name of Example Imports LLC.';
  const result = parse(
    {
      company_name: fact('Bright Screens', text),
      legal_company_name: fact('Example Imports LLC', text),
      trading_names: [fact('Bright Screens', text)],
    },
    text,
  );
  assert.equal(result.company_name, 'Example Imports LLC');
  assert.equal(result.company_identity.legal_name, 'Example Imports LLC');
  assert.ok(result.company_identity.aliases.includes('Bright Screens'));
  assert.equal(result.company_identity.status, 'legal_name_self_reported');
  assert.equal(result.company_identity.customs_match_status, 'requires_identity_match');
});

test('有官网名称但没有明确法定名称时保留未知，不补猜法律后缀', () => {
  const text = 'Welcome to Bright Screens.';
  const result = parse({ company_name: fact('Bright Screens', text) }, text);
  assert.equal(result.company_name, 'Bright Screens');
  assert.equal(result.company_identity.legal_name, null);
  assert.equal(result.company_identity.status, 'website_name_only');
});

test('并列多个经营法人时保留冲突，不任选一个用于海关或自动发布匹配', () => {
  const text =
    'Bright Screens. Privacy: Example US LLC and Example Canada Ltd operate different regional websites.';
  const result = parse(
    {
      company_name: 'Bright Screens',
      facts: [
        { field: 'company_name', ...fact('Bright Screens', text) },
        { field: 'legal_company_name', ...fact('Example US LLC', text) },
        { field: 'legal_company_name', ...fact('Example Canada Ltd', text) },
      ],
    },
    text,
  );
  assert.equal(result.company_identity.status, 'identity_conflict');
  assert.equal(result.company_identity.legal_name, null);
  assert.deepEqual(result.company_identity.aliases, []);
  assert.equal(result.ok, false);
});

test('没有同一主体关系的供应商品牌不能进入公司别名', () => {
  const text = 'Bright Screens sells Partner Motors products.';
  const result = parse(
    { company_name: fact('Bright Screens', text), trading_names: [fact('Partner Motors', text)] },
    text,
  );
  assert.ok(!result.company_identity.aliases.includes('Partner Motors'));
  assert.ok(!result.facts.some((f) => f.field === 'trading_names'));
});

test('商标所有者与同行制造商不自动当作网站经营主体', () => {
  const text =
    'Bright Screens is a trademark of Example Imports LLC. Manufactured by Other Screens LLC.';
  const result = parse(
    {
      company_name: fact('Bright Screens', text),
      legal_company_name: fact('Example Imports LLC', text),
    },
    text,
  );
  assert.equal(result.company_name, 'Bright Screens');
  assert.equal(result.company_identity.legal_name, null);
});

test('不同域名引文不能支持当前公司身份，同名子串不能冒充完整名称', () => {
  const text = 'Welcome to Acmeology Screens.';
  const other = 'https://other.example.org/';
  const result = parseCompanyResearch(
    {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              company_name: { value: 'Other Company', quote: 'Other Company', source_url: other },
            }),
          },
        },
      ],
    },
    { source_url, research_pages: [{ source_url: other, text: 'Other Company' }] },
  );
  assert.equal(result.company_name, null);
  assert.equal(parse({ company_name: fact('Acme', text) }, text).company_name, null);
});

test('重命名后的飞书读写使用公司名称，并兼容旧表及旧操作快照', () => {
  const raw = { 公司名称: 'Example Imports LLC', 来源链接: source_url };
  const definitions = [
    '公司名称',
    '来源链接',
    'customer_id',
    '广告代码',
    '需求产品',
    '客户行业画像',
    '客户类型',
  ].map((field_name) => ({ field_name, type: 1 }));
  assert.equal(encodeResearchFields(raw, definitions)['公司名称'], raw['公司名称']);
  const legacy = definitions.map((f) => ({
    ...f,
    field_name: f.field_name === '公司名称' ? '客户名称' : f.field_name,
  }));
  assert.equal(encodeResearchFields(raw, legacy)['客户名称'], raw['公司名称']);
  assert.equal(
    encodeResearchFields({ 客户名称: raw['公司名称'], 来源链接: source_url }, definitions)[
      '公司名称'
    ],
    raw['公司名称'],
  );
  assert.equal(mapFeishuRecord({ fields: { 公司名称: 'New', 客户名称: 'Old' } }).name, 'New');
  assert.equal(mapFeishuRecord({ fields: { 客户名称: 'Legacy' } }).name, 'Legacy');
  assert.equal(
    researchFields({ company_name: 'Example Imports LLC' }, {}).公司名称,
    'Example Imports LLC',
  );
});

test('公司身份记录绑定飞书记录、官网与当前名称，旧核验结果不套用到新名称', () => {
  const store = new AcquisitionStore(':memory:', 'base/table');
  try {
    store.saveCompanyIdentity('record-1', source_url, 'Bright Screens', {
      name: 'Bright Screens',
      legal_name: null,
      aliases: [],
      status: 'website_name_only',
      evidence: [],
    });
    assert.equal(
      store.companyIdentity('record-1', source_url, 'Bright Screens').status,
      'website_name_only',
    );
    assert.equal(store.companyIdentity('record-1', source_url, 'Other Screens'), null);
    assert.equal(
      store.companyIdentity('record-1', 'https://other.example.org/', 'Bright Screens'),
      null,
    );
    assert.equal(store.companyIdentity('record-2', source_url, 'Bright Screens'), null);
  } finally {
    store.close();
  }
});

test('官网页面预算内补抓同站法律页，外站隐私页不当作公司证据', () => {
  const plan = planWebsitePages(
    source_url,
    '<a href="/contact">Contact</a><a href="/about">About</a><a href="/privacy-policy">Privacy</a><a href="/privacy-screens">Privacy screens</a><a href="https://other.example.org/legal">Legal</a>',
  );
  assert.ok(plan.includes(source_url + 'privacy-policy'));
  assert.ok(plan.includes(source_url + 'contact'));
  assert.ok(plan.includes(source_url + 'about'));
  assert.ok(plan.length <= 5);
  assert.ok(!plan.some((url) => url.includes('other.example.org')));
  assert.ok(!plan.includes(source_url + 'privacy-screens'));
});

test('兼容工作流的独立解析器执行相同名称证据校验', () => {
  const text = 'Bright Screens supplies roller blinds to trade businesses.';
  for (const name of ['Bright Screens', 'Invented Company LLC']) {
    const raw = { company_name: fact(name, text), products: [fact('roller blinds', text)] };
    const response = {
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }],
    };
    const result = vm.runInNewContext(
      researchPolicyCode +
        '\n' +
        parseCompanyResearch.toString() +
        '\nparseCompanyResearch(response,page,target)',
      {
        response,
        page: { source_url, research_pages: [{ source_url, text }] },
        target: { product: 'roller blinds' },
      },
    );
    assert.equal(result.company_name, name === 'Bright Screens' ? name : null);
  }
});
