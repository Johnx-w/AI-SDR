import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { extractContacts } from '../server/contact-extractor.mjs';
import { discoverContacts } from '../server/contacts.mjs';
import { improveContactNode } from '../server/n8n-contacts.mjs';
import { removeCityTarget } from '../server/n8n-search-target.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';
import { createApp } from '../server/app.mjs';

const sourceUrl = 'https://shadeboys.com/cities/florida/miami/outdoor-zip-track-blinds';
const markdown =
  '[888-477-4202](tel:8884774202)\n\nCall your local specialist (Miami, FL): 305-853-9120. Toll-free: +1-888-477-4202.\nEmail: sales@shadeboys.com';

test('美国电话不再漏采，tel / 正文 / 国际格式规范去重，保留来源证据', () => {
  const result = extractContacts({ content: markdown, sourceUrl, country: 'United States' });
  assert.equal(result.filter((c) => c.kind === 'phone').length, 2);
  assert.deepEqual(
    result
      .filter((c) => c.kind === 'phone')
      .map((c) => c.normalized)
      .sort(),
    ['+13058539120', '+18884774202'],
  );
  assert.equal(result.find((c) => c.normalized === '+13058539120').quote.includes('Miami'), true);
  assert.equal(
    result.every((c) => c.source_url === sourceUrl),
    true,
  );
  assert.equal(
    result.some((c) => c.value === 'sales@shadeboys.com'),
    true,
  );
});
test('支持 HTML tel、JSON-LD、公开邮件编码，忽略脚本、SVG及传真字段', () => {
  const email = 'sales@shadeboys.com';
  const key = 42;
  const encoded =
    key.toString(16).padStart(2, '0') +
    [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  const html = `<a href="tel:8884774202"><svg>1234567890</svg><span>888-477-4202</span></a><script type="application/ld+json">{"@graph":[{"telephone":"+1-888-477-4202","email":"sales@shadeboys.com","faxNumber":"+1-555-222-3344"}]}</script><span data-cfemail="${encoded}">[email protected]</span><script>const tracking='310-444-5555';</script><style>.x{width:310-444-5555}</style>`;
  const result = extractContacts({ content: html, sourceUrl, country: 'US' });
  assert.equal(result.filter((c) => c.kind === 'phone').length, 1);
  assert.equal(result[0].value, '+1 8884774202');
  assert.equal(result[0].method, 'tel_link');
  assert.equal(
    result.some((c) => c.quote.includes('<svg')),
    false,
  );
  assert.equal(result.filter((c) => c.kind === 'email').length, 1);
  const protectedOnly = extractContacts({
    content: `<a href="/cdn-cgi/l/email-protection#${encoded}">email</a>`,
    sourceUrl,
    country: 'US',
  });
  assert.equal(protectedOnly[0].value, email);
});
test('澳洲、英国、阿联酋及国际号码规则保留，不把日期与资源路径识别为号码', () => {
  for (const [country, content, normalized] of [
    ['Australia', 'Call 02 9834 2920 or +61 2 9834 2920', '+61298342920'],
    ['United Kingdom', 'Call 020 7946 0958 or +44 20 7946 0958', '+442079460958'],
    ['United Arab Emirates', 'Call 050 123 4567 or +971 50 123 4567', '+971501234567'],
  ]) {
    const result = extractContacts({ content, sourceUrl, country }).filter(
      (c) => c.kind === 'phone',
    );
    assert.equal(result.length, 1, country);
    assert.equal(result[0].normalized, normalized);
  }
  const noContacts = extractContacts({
    content:
      'Updated 2026-10-19. ID 8884774202. https://example.com/assets/305-853-9120.png <script>var x="888-477-4202";</script>',
    sourceUrl,
    country: 'US',
  });
  assert.equal(noContacts.length, 0);
});
test('补全读取当前页、首页、同站联系页，保留部分失败及去重，不访问外站', async () => {
  const urls = [];
  const result = await discoverContacts(
    { website: sourceUrl, market: 'United States' },
    {
      readPage: async (url) => {
        urls.push(url.href);
        if (url.pathname.includes('/cities/'))
          return {
            html: `<a href="/contact">Contact us</a><a href="https://unrelated.com/contact">contact</a>${markdown}`,
          };
        if (url.pathname === '/') throw new Error('blocked');
        return { html: 'Contact our team: sales@shadeboys.com' };
      },
    },
  );
  assert.equal(urls.length, 3);
  assert.equal(
    urls.every((u) => new URL(u).hostname === 'shadeboys.com'),
    true,
  );
  assert.equal(result.contacts.filter((c) => c.kind === 'phone').length, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.persisted, false);
  await assert.rejects(
    discoverContacts(
      { website: sourceUrl },
      {
        readPage: async () => {
          throw new Error('failed');
        },
      },
    ),
    /无法读取官网/,
  );
});
test('飞书字段为空时读取已有画像联系证据；原始字段保留', () => {
  const lead = mapFeishuRecord({
    record_id: 'rec',
    fields: {
      画像JSON: JSON.stringify({
        latest_research: {
          contact_evidence: [
            { kind: 'phone', value: '888-477-4202' },
            { kind: 'email', value: 'sales@shadeboys.com' },
          ],
        },
      }),
    },
  });
  assert.equal(lead.phone, '888-477-4202');
  assert.equal(lead.email, 'sales@shadeboys.com');
  assert.equal(lead.fields['电话'], undefined);
});
test('真实客户补全接口限制为已知客户，缓存只读结果且不修改飞书字段', async () => {
  let calls = 0;
  const app = createApp({
    env: {
      N8N_BASE_URL: 'https://vynox.app.n8n.cloud',
      FEISHU_READ_WEBHOOK_URL: 'https://vynox.app.n8n.cloud/webhook/read-test',
      N8N_WEBHOOK_SECRET: 'test-only',
    },
    fetchImpl: async () =>
      Response.json({
        code: 0,
        data: {
          items: [
            {
              record_id: 'rec-test',
              fields: { 客户名称: 'Shade Boys', 来源链接: sourceUrl, 国家: 'United States' },
            },
          ],
          has_more: false,
        },
      }),
    contactsImpl: async () => {
      calls++;
      return {
        contacts: extractContacts({ content: markdown, sourceUrl, country: 'US' }),
        persisted: false,
      };
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    for (let i = 0; i < 2; i++) {
      const r = await fetch(base + '/api/v1/leads/real/rec-test/contacts');
      assert.equal(r.status, 200);
      assert.equal((await r.json()).persisted, false);
    }
    assert.equal(calls, 1);
    await fetch(base + '/api/v1/leads/real/rec-test/contacts?refresh=1');
    assert.equal(calls, 2);
    assert.equal((await fetch(base + '/api/v1/leads/real/unknown/contacts')).status, 404);
    assert.equal(
      (await fetch(base + '/api/v1/leads/real/rec-test/contacts', { method: 'POST' })).status,
      404,
    );
    const saved = await (await fetch(base + '/api/v1/leads/real')).json();
    assert.equal(saved.leads[0].phone, '');
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
test('n8n 入库节点回归：修复美国漏采，保持原画像、去重键、字段映射和失败分支', async () => {
  const original = await readFile(
    new URL('./fixtures/n8n-build-record-original.txt', import.meta.url),
    'utf8',
  );
  const improved = removeCityTarget(improveContactNode(original));
  const fieldNames = [
    'customer_id',
    '客户名称',
    '来源链接',
    '来源渠道',
    '主体类型',
    '国家',
    '客户类型',
    '相关产品',
    '画像JSON',
    '邮箱',
    '电话',
    '匹配状态',
    '首次发现时间',
  ];
  const nodes = {
    最终结果: [
      {
        ok: true,
        source_url: sourceUrl,
        company_name: 'Shade Boys',
        actual_country: 'United States',
        customer_type: 'installer',
        products: ['zip screens'],
        fit_status: 'matched',
        facts: [{ field: 'product', value: 'zip screens' }],
      },
    ],
    获取飞书Token: { body: { code: 0, tenant_access_token: 'test-token' } },
    配置搜索目标: {
      country: 'United States',
      region: 'Florida',
      city: 'Miami',
      product: 'pergolas, motors',
      search_query: 'pergolas, motors Florida',
    },
    'Tavily Extract': {
      results: [
        { url: sourceUrl, raw_content: markdown },
        { url: 'https://unrelated.com', raw_content: 'Contact 212-555-1234' },
      ],
    },
  };
  function run(code, missingField = false) {
    return JSON.parse(
      JSON.stringify(
        vm.runInNewContext(
          '(function(){' + code + '})()',
          {
            $: (name) => ({
              first: () => ({ json: nodes[name] }),
              all: () => nodes[name].map((json) => ({ json })),
            }),
            $input: {
              first: () => ({
                json: {
                  code: 0,
                  data: {
                    items: fieldNames
                      .filter((x) => !missingField || x !== '电话')
                      .map((field_name) => ({
                        field_name,
                        type: field_name === '首次发现时间' ? 5 : 1,
                      })),
                  },
                },
              }),
            },
          },
          { timeout: 2000 },
        ),
      ),
    );
  }
  assert.equal(run(original)[0].json.insert_fields['电话'], undefined);
  const output = run(improved)[0].json;
  assert.equal(output.ready, true);
  assert.equal(output.website_key, 'shadeboys.com');
  assert.equal(output.new_customer_id, 'web_shadeboys.com');
  assert.equal(output.insert_fields['国家'], 'United States');
  assert.equal(output.insert_fields['匹配状态'], '匹配');
  assert.equal(output.insert_fields['电话'].split('\n').length, 2);
  const profile = JSON.parse(output.insert_fields['画像JSON']);
  assert.equal('city' in profile.task_target, false);
  assert.equal(profile.task_target.region, 'Florida');
  assert.equal(profile.task_target.product, 'pergolas, motors');
  assert.equal(profile.actual_country, 'United States');
  assert.equal(profile.latest_research.contact_extraction_version, 'multi-market-v2');
  assert.equal(
    profile.latest_research.contact_evidence.every((c) => c.source_url === sourceUrl),
    true,
  );
  assert.equal(run(improved, true)[0].json.ready, false);
  assert.throws(() => improveContactNode(improved), /已升级/);
});
