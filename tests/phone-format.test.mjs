import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { normalizePhone, normalizePhoneLines, phoneHelpers } from '../server/phone-format.mjs';
import { extractContacts } from '../server/contact-extractor.mjs';
import { researchFields, mergeResearchFields } from '../server/company-research.mjs';
import { combineWebsiteEvidence } from '../server/website-metadata.mjs';

test('国家区号与本地号码只以空格分隔，去除国内拨号前缀并保留意大利零开头区号', () => {
  for (const [input, country, expected] of [
    ['(972) 696-0181', 'United States', '+1 9726960181'],
    ['19726960181', 'US', '+1 9726960181'],
    ['13800138000', 'China', '+86 13800138000'],
    ['+86 13800138000', '', '+86 13800138000'],
    ['02 9834 2920', 'Australia', '+61 298342920'],
    ['020 7946 0958', 'United Kingdom', '+44 2079460958'],
    ['+44 (0)20 7946 0958', '', '+44 2079460958'],
    ['030 12345678', 'Germany', '+49 3012345678'],
    ['06 69883229', 'Italy', '+39 0669883229'],
    ['6123 4567', 'Singapore', '+65 61234567'],
    ['+1800 552 5100', '', '+1 8005525100'],
    ['tel:+1-972-696-0181;ext=123', '', '+1 9726960181 ext. 123'],
  ])
    assert.equal(normalizePhone(input, country)?.value, expected, input);
  assert.equal(normalizePhone('(972) 696-0181', ''), null);
  assert.equal(normalizePhone('+999 12345678', ''), null);
  assert.equal(normalizePhone('1234567890', 'United States'), null);
});

test('地区未确认时仍收集 Phone 标签的原文候选；确认企业实际国家后再写入国际格式', async () => {
  const html = await fs.readFile(
    new URL('./fixtures/usmotions-phone.html', import.meta.url),
    'utf8',
  );
  const sourceUrl = 'https://www.usmotions.com/';
  const contacts = extractContacts({ content: html, sourceUrl });
  assert.ok(contacts.some((c) => c.value === '(972) 696-0181' && c.quote.includes('Phone:')));
  const evidence = combineWebsiteEvidence([{ url: sourceUrl, content: html }]);
  assert.equal(researchFields({}, evidence)['电话'], undefined);
  assert.equal(
    researchFields({ actual_country: 'United States' }, evidence)['电话'],
    '+1 8885833361\n+1 9726960181',
  );
  // Even old evidence with an empty contact array is repaired from the captured page text.
  assert.equal(
    researchFields({ actual_country: 'United States' }, {}, {}, [
      { source_url: sourceUrl, text: html },
    ])['电话'],
    '+1 8885833361\n+1 9726960181',
  );
});

test('紧邻右括号的电话可抓取，传真、日期、跟踪脚本及没有联系电话标签的数字不误入库', () => {
  const found = extractContacts({
    content:
      'Phone: (972)696-0181. Fax: (972) 696-0182. Updated 2026-10-21. ID 9726960183. <script>var n="972-696-0184"</script>',
    sourceUrl: 'https://www.usmotions.com/',
    country: 'US',
  });
  assert.deepEqual(
    found.filter((x) => x.kind === 'phone').map((x) => x.value),
    ['+1 9726960181'],
  );
});

test('飞书更新合并按规范号码去重，旧格式不会重新追加，分机保留', () => {
  const old = {
    国家: 'United States',
    电话: '9726960181\n(972) 696-0181\n+19726960181',
    客户等级: 'A',
  };
  const merged = mergeResearchFields(old, { 电话: '+1 9726960181\n+1-888-583-3361' });
  assert.equal(merged['电话'], '+1 9726960181\n+1 8885833361');
  assert.equal(merged['客户等级'], undefined);
  assert.equal(
    normalizePhoneLines(['972-696-0181 ext. 1', '+19726960181;ext=1', '+19726960181;ext=2'], 'US'),
    '+1 9726960181 ext. 1\n+1 9726960181 ext. 2',
  );
  assert.equal(normalizePhoneLines('020 7946 0958', '', true), '020 7946 0958');
});
