import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTarget, locationOptions } from '../server/search-target.mjs';
import { generateSearchQuery } from '../server/deepseek.mjs';
import { parseCompanyResearch, researchFields } from '../server/company-research.mjs';
import {
  extractWebsiteMetadata,
  extractCatalogProducts,
  planWebsitePages,
} from '../server/website-metadata.mjs';
import { recoveryPlanCode } from '../server/n8n-recovery.mjs';
import vm from 'node:vm';
import { extractContacts } from '../server/contact-extractor.mjs';
const target = { country: 'Southeast Asia', region: '', product: 'screens', audience: 'BC' };
test('加拿大省区和东南亚全区有效；分组范围不可混入州或城市', () => {
  assert.equal(locationOptions('Canada').regions.length, 13);
  assert.equal(validateTarget(target).market_countries.length, 11);
  assert.equal(locationOptions('Germany').regions.length, 0);
  assert.throws(() => validateTarget({ ...target, region: 'Florida' }));
  assert.throws(() => validateTarget({ ...target, audience: 'both' }));
});
test('B+C 不加客群限制，B/C 搜索限定由服务端追加', async () => {
  const make = (audience) =>
    generateSearchQuery(
      { ...target, audience },
      {
        env: { DEEPSEEK_API_KEY: 'test' },
        fetchImpl: async () =>
          Response.json({
            choices: [{ finish_reason: 'stop', message: { content: '{"keywords":"screens"}' } }],
          }),
      },
    );
  assert.doesNotMatch((await make('BC')).search_query, /wholesale|homeowners/);
  assert.match((await make('B')).search_query, /wholesale/);
  assert.match((await make('C')).search_query, /homeowners/);
});
test('AI 逐字证据校验会剔除无依据事实；BC 目标不要求企业兼营', () => {
  const source_url = 'https://business.example.org/';
  const page = {
    source_url,
    research_pages: [{ source_url, text: 'Acme supplies residential shades to homeowners.' }],
  };
  const raw = {
    company_name: 'Acme',
    actual_country: 'United States',
    audience: 'C',
    products: ['shades', 'motors'],
    main_product_preference: '以住宅遮阳帘为主',
    facts: [
      { field: 'company_name', value: 'Acme', quote: 'Acme', source_url },
      { field: 'audience', value: 'C', quote: 'residential shades to homeowners', source_url },
      { field: 'products', value: 'shades', quote: 'residential shades', source_url },
      { field: 'products', value: 'motors', quote: 'invented quote', source_url },
      {
        field: 'main_product_preference',
        value: '以住宅遮阳帘为主',
        quote: 'supplies residential shades',
        source_url,
      },
    ],
  };
  const response = {
    status: 'completed',
    output: [{ content: [{ type: 'output_text', text: raw }] }],
  };
  const r = parseCompanyResearch(response, page, { audience: 'BC' });
  assert.equal(r.ok, true);
  assert.equal(r.audience_match, 'unrestricted');
  assert.equal(r.actual_country, null);
  assert.deepEqual(r.products, ['shades']);
  assert.equal(parseCompanyResearch(response, page, { audience: 'B' }).ok, false);
  const fields = researchFields(r, { addresses: [], contacts: [], social: [], service_areas: [] });
  assert.equal(fields['主营产品偏好'], '以住宅遮阳帘为主');
  assert.equal(fields['客户等级'], undefined);
  assert.equal(fields['画像JSON'], undefined);
  assert.equal(fields['社媒JSON'], undefined);
});
test('电话尾行不会拼入邮政地址；禁用平台不参与社媒解析', () => {
  const e = extractWebsiteMetadata({
    sourceUrl: 'https://business.example.org/',
    content:
      'Phone 817-502-6200\n535 S. Nolen Drive Ste 200, Southlake, TX 76092 <a href="https://youtube.com/@acme">YouTube</a><a href="https://x.com/acme">X</a><a href="https://www.instagram.com/acme">Instagram</a>',
  });
  assert.equal(e.addresses[0].street, '535 S. Nolen Drive Ste 200');
  assert.deepEqual(
    e.social.map((s) => s.platform),
    ['Instagram'],
  );
});

test('卡片式服务城市只从明确服务标题中提取，后续产品区不混入', () => {
  const e = extractWebsiteMetadata({
    sourceUrl: 'https://business.example.org/',
    content:
      '<h2>Service Areas We Cover</h2><div><a href="/service/frisco">Frisco</a><a href="/service/plano">Plano</a></div><h2>Products</h2><a href="/products/shutters">Shutters</a>',
  });
  assert.deepEqual(
    e.service_areas.map((x) => x.name),
    ['Frisco', 'Plano'],
  );
});

test('未通过引文校验的公司名和分析不覆盖原值；可从已验证产品归纳', () => {
  const source_url = 'https://business.example.org/';
  const response = {
    status: 'completed',
    output: [
      {
        content: [
          {
            type: 'output_text',
            text: {
              company_name: { value: 'Invented Company', quote: 'No such company', source_url },
              main_product_preference: {
                value: '无依据分析',
                quote: 'No such statement',
                source_url,
              },
              products: [{ value: 'solar screens', quote: 'We supply solar screens.', source_url }],
            },
          },
        ],
      },
    ],
  };
  const r = parseCompanyResearch(
    response,
    { source_url, research_pages: [{ source_url, text: 'We supply solar screens.' }] },
    { audience: 'BC' },
  );
  assert.equal(r.company_name, null);
  assert.match(r.main_product_preference, /solar screens/);
  assert.ok(r.facts.some((f) => f.method === 'summary_of_verified_products'));
  const fields = researchFields(
    r,
    { addresses: [], contacts: [], social: [], service_areas: [] },
    { 客户名称: 'Existing Company', 客户等级: 'A' },
  );
  assert.equal(fields['客户名称'], undefined);
  assert.equal(fields['客户等级'], undefined);
});

test('从 HTML 补充产品证据，只收录本站实际产品链接', () => {
  const e = extractCatalogProducts(
    '<a href="/e-zip-blinds">E ZIP Blinds</a><a href="/awnings">Awnings</a><a href="/blog/roller-blinds">Roller Blinds</a><a href="https://external.org/curtains">Curtains</a>',
    'https://business.example.org/',
  );
  assert.deepEqual(
    e.map((x) => x.value),
    ['E ZIP Blinds', 'Awnings'],
  );
  assert.deepEqual(
    extractCatalogProducts(
      'We do not install interior blinds.<a href="/blinds">Blinds</a>',
      'https://business.example.org/',
    ),
    [],
  );
});

test('补抓只发现同站正文页面，忽略联系表单插件 CSS 和 oEmbed', () => {
  const source_url = 'https://business.example.org/';
  const html =
    '<link href="/wp-content/plugins/contact-form/styles.css"><link href="/wp-json/oembed?url=contact"><a href="/about/">About</a><a href="https://other.org/contact">Contact</a>';
  assert.deepEqual(planWebsitePages(source_url, html), [source_url, source_url + 'about/']);
  const data = {
    Plans: [{ json: { url: source_url } }],
    HTML: [{ json: { statusCode: 200, html } }],
    Page: [{ json: { source_url } }],
  };
  const r = vm.runInNewContext(
    '(function(){' + recoveryPlanCode('Plans', 'HTML', 'Page') + '})()',
    {
      $: (name) => ({ all: () => data[name], first: () => data[name][0] }),
    },
  )[0].json;
  assert.equal(r.needs_recovery, true);
  assert.deepEqual([...r.fallback_urls], [source_url + 'about/']);
});

test('加拿大本地格式电话可提取，欧洲和东南亚地址国家代码保存为英文国家名', () => {
  assert.equal(
    extractContacts({
      content: 'Call 416-555-0123',
      sourceUrl: 'https://business.example.org/',
      country: 'Canada',
    })[0].normalized,
    '+14165550123',
  );
  for (const [code, name] of [
    ['DE', 'Germany'],
    ['SG', 'Singapore'],
    ['FR', 'France'],
    ['VN', 'Vietnam'],
  ]) {
    const content =
      '<script type="application/ld+json">' +
      JSON.stringify({
        '@type': 'LocalBusiness',
        name: 'Acme',
        address: {
          streetAddress: '1 Business St',
          addressLocality: 'Office City',
          addressCountry: code,
        },
      }) +
      '</script>';
    assert.equal(
      extractWebsiteMetadata({ content, sourceUrl: 'https://business.example.org/' }).addresses[0]
        .country,
      name,
    );
  }
});
