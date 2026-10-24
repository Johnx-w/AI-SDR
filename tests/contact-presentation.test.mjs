import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContactPresentation } from '../src/domain/contact-presentation.mjs';

const evidence = (
  kind,
  value,
  quote = 'Original public evidence.',
  source_url = 'https://buyer.example.org/contact',
) => ({ kind, value, quote, source_url });

test('当前邮箱按大小写和常用分隔符去重，电话仅规范可确定的格式并区分分机', () => {
  const result = buildContactPresentation({
    email:
      ' Sales@Buyer.example.org\nsales@buyer.example.org；info@buyer.example.org, info@buyer.example.org ',
    phone:
      '+1 (972) 696-0181\n001 972 696 0181\n+1-972-696-0181 ext. 22\n+19726960181;ext=22\n+19726960181 x 23\n(972) 696-0181',
  });
  assert.deepEqual(result.emails, [
    { value: 'Sales@Buyer.example.org', href: 'mailto:Sales@Buyer.example.org' },
    { value: 'info@buyer.example.org', href: 'mailto:info@buyer.example.org' },
  ]);
  assert.equal(result.phones.length, 4);
  assert.equal(result.phones[0].href, 'tel:+19726960181');
  assert.equal(result.phones[1].href, 'tel:+19726960181;ext=22');
  assert.equal(result.phones[2].href, 'tel:+19726960181;ext=23');
  assert.equal(result.phones[3].href, 'tel:9726960181', '不从另一条国际电话推断本地号码的国家');
});

test('人工清空后的联系方式不从历史采集记录中复活，原始证据仍可供展开核对', () => {
  const original = evidence('email', 'old@buyer.example.org');
  const result = buildContactPresentation({
    email: '',
    phone: '',
    contactEvidence: [original, evidence('phone', '+1 9726960181')],
  });
  assert.deepEqual(result.emails, []);
  assert.deepEqual(result.phones, []);
  assert.equal(result.evidenceGroups.length, 2);
  assert.deepEqual(result.evidenceGroups[0].records[0], {
    label: '邮箱',
    value: original.value,
    quote: original.quote,
    source_url: original.source_url,
  });
});

test('同一联系入口的重复证据合并，所有不同原文和出处保持原值', () => {
  const first = evidence(
    'email',
    'sales@buyer.example.org',
    'First exact quote.',
    'https://buyer.example.org/contact',
  );
  const second = evidence(
    'email',
    'SALES@buyer.example.org',
    'Second exact quote.\nNext line.',
    'https://buyer.example.org/about',
  );
  const result = buildContactPresentation({ contactEvidence: [first, { ...first }, second] });
  assert.equal(result.evidenceGroups.length, 1);
  assert.equal(result.evidenceGroups[0].records.length, 2);
  assert.equal(result.evidenceGroups[0].records[1].quote, second.quote);
  assert.equal(result.evidenceGroups[0].records[1].source_url, second.source_url);
});

test('有明确规范号码的历史电话可归并，本地号码没有规范记录时保持独立', () => {
  const result = buildContactPresentation({
    contactEvidence: [
      { ...evidence('phone', '(972) 696-0181'), normalized: '+19726960181' },
      evidence('phone', '+1 9726960181', 'Other quote.'),
      evidence('phone', '9726960181', 'Local number without country.'),
    ],
  });
  assert.equal(result.evidenceGroups.length, 2);
  assert.equal(result.evidenceGroups[0].records.length, 2);
});

test('社交账号仅按同平台及等价地址归并，保留路径大小写和不同出处', () => {
  const result = buildContactPresentation({
    social: [
      {
        platform: 'Facebook',
        url: 'https://facebook.com/Buyer/',
        quote: 'First social link.',
        source_url: 'https://buyer.example.org/',
      },
      {
        platform: 'facebook',
        url: 'https://FACEBOOK.com/Buyer',
        quote: 'Other page.',
        source_url: 'https://buyer.example.org/contact',
      },
      {
        platform: 'Facebook',
        url: 'https://facebook.com/buyer',
        quote: 'Different case profile.',
        source_url: '',
      },
      { platform: 'Other', url: 'https://facebook.com/Buyer/', quote: '', source_url: '' },
    ],
  });
  assert.equal(result.social.length, 3);
  assert.equal(result.social[0].records.length, 2);
  assert.equal(result.social[0].url, 'https://facebook.com/Buyer/');
  assert.equal(result.social[1].url, 'https://facebook.com/buyer');
  assert.equal(result.evidenceGroups.filter((group) => group.label.includes('社交账号')).length, 3);
});

test('来源缺失和危险地址原样保留，不生成无来源引用或危险联系链接', () => {
  const result = buildContactPresentation({
    email:
      'not-an-email\ngood@buyer.example.org?bcc=other@example.org\nname%0a@buyer.example.org\nsales+team@buyer.example.org',
    phone: '+1 9726960181?body=bad\n+1 9726960181',
    social: [
      { platform: 'Link', url: 'javascript:alert(1)', quote: '', source_url: '' },
      {
        platform: 'Secret',
        url: 'https://user:password@buyer.example.org/',
        quote: '',
        source_url: 'javascript:alert(2)',
      },
    ],
    contactEvidence: [
      evidence('form', 'javascript:alert(3)', 'Exact form evidence.', ''),
      evidence('other', 'unknown', '', 'javascript:alert(4)'),
    ],
  });
  assert.ok(result.emails.slice(0, 3).every((entry) => !entry.href));
  assert.equal(result.emails[3].href, 'mailto:sales%2Bteam@buyer.example.org');
  assert.equal(result.phones[0].href, undefined);
  assert.equal(result.phones[1].href, 'tel:+19726960181');
  assert.ok(result.social.every((entry) => !entry.href));
  assert.equal(result.social[1].records[0].source_url, 'javascript:alert(2)');
  assert.equal(
    result.evidenceGroups.find((group) => group.label === '业务联系表单').records[0].source_url,
    '',
  );
  assert.equal(
    result.evidenceGroups.find((group) => group.label === '其他联系线索').records[0].source_url,
    'javascript:alert(4)',
  );
});

test('地址与服务地区证据分别归组，精确重复合并，不把服务范围当企业地址', () => {
  const address = {
    street: '10 Main Street',
    city: 'Sydney',
    quote: 'Address quote.',
    source_url: 'https://buyer.example.org/contact',
  };
  const area = {
    name: 'Sydney',
    quote: 'Service area quote.',
    source_url: 'https://buyer.example.org/',
  };
  const result = buildContactPresentation({ locationEvidence: [address, { ...address }, area] });
  assert.equal(result.evidenceGroups.length, 2);
  assert.equal(result.evidenceGroups[0].label, '企业地址');
  assert.equal(result.evidenceGroups[0].records.length, 1);
  assert.equal(result.evidenceGroups[1].label, '服务地区');
});

test('展示归并不修改已有保存值、证据或输入对象，空输入保持为空', () => {
  const input = {
    email: 'Sales@buyer.example.org\nsales@buyer.example.org',
    phone: '',
    contactEvidence: [evidence('email', 'Sales@buyer.example.org')],
  };
  const before = structuredClone(input);
  buildContactPresentation(input);
  assert.deepEqual(input, before);
  for (const input of [undefined, null, {}])
    assert.deepEqual(buildContactPresentation(input), {
      emails: [],
      phones: [],
      social: [],
      evidenceGroups: [],
    });
});
