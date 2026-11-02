import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractContacts } from '../server/contact-extractor.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';

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
  assert.equal(lead.phone, '');
  assert.equal(lead.email, 'sales@shadeboys.com');
  assert.equal(lead.fields['电话'], undefined);
});
