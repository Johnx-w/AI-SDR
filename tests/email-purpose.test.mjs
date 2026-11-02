import test from 'node:test';
import assert from 'node:assert/strict';
import { emailPurpose } from '../src/domain/email-purpose.mjs';
import { buildContactPresentation } from '../src/domain/contact-presentation.mjs';

const website = 'https://buyer.example.org';
const entry = (value, quote) => ({ kind: 'email', value, quote, source_url: website + '/team' });

test('官网用途与地址推测分开，具名邮箱不猜采购职责', () => {
  const address = 'john@buyer.example.org';
  assert.equal(emailPurpose(address).type, 'unknown');
  assert.equal(emailPurpose('purchasing@buyer.example.org').inferred, true);
  const result = emailPurpose(
    address,
    [entry(address, `John, purchasing manager: ${address}`)],
    website,
  );
  assert.equal(result.type, 'procurement');
  assert.equal(result.basis, '官网说明');
  assert.equal(result.namedBuyer, true);
  assert.equal(result.inferred, false);
  assert.equal(
    emailPurpose(address, [entry(address, `John, founder: ${address}`)], website).type,
    'management',
  );
});

test('第三方、猜测和混合邮箱的用途不冒充官网确定职责', () => {
  const address = 'john@buyer.example.org';
  const known = entry(address, `Purchasing manager: ${address}`);
  for (const evidence of [
    { ...known, source_url: 'https://directory.example.org/team' },
    { ...known, method: 'guessed' },
    { ...known, quote: `Purchasing: mary@buyer.example.org Sales: ${address}` },
  ])
    assert.equal(emailPurpose(address, [evidence], website).type, 'unknown');
  assert.equal(
    emailPurpose(
      address,
      [{ ...known, quote: `Purchasing: mary@buyer.example.org; Sales enquiries: ${address}` }],
      website,
    ).type,
    'sales',
  );
});

test('受限制用途、地址无效和归属冲突都不能用于开发', () => {
  for (const local of ['support', 'accounts', 'jobs', 'privacy', 'noreply', 'legal']) {
    assert.equal(emailPurpose(`${local}@buyer.example.org`).eligible, false, local);
  }
  const address = 'john@buyer.example.org';
  assert.equal(
    emailPurpose(address, [entry(address, `Customer support: ${address}`)], website).eligible,
    false,
  );
  for (const verification_status of ['invalid', 'identity_conflict']) {
    assert.equal(
      emailPurpose(
        address,
        [{ ...entry(address, 'Purchasing manager'), verification_status }],
        website,
      ).eligible,
      false,
    );
  }
});

test('外部来源的明确退订用途仍被排除，不因来源不能证明采购职责而放行', () => {
  const address = 'marketing@buyer.example.org';
  const result = emailPurpose(
    address,
    [
      {
        ...entry(address, `For unsubscribe requests, contact ${address}`),
        source_url: 'https://policy.example.org/page?name=privacy',
      },
    ],
    website,
  );
  assert.equal(result.type, 'privacy');
  assert.equal(result.eligible, false);
  assert.equal(result.basis, '来源说明');
});

test('联系方式展示使用相同分类且保留公开出处', () => {
  const address = 'john@buyer.example.org';
  const evidence = entry(address, `Purchasing manager: ${address}`);
  const result = buildContactPresentation({ website, email: address, contactEvidence: [evidence] });
  assert.equal(result.emails[0].purpose.type, 'procurement');
  assert.equal(result.emails[0].purpose.sourceUrl, evidence.source_url);
  assert.equal(result.evidenceGroups[0].records[0].quote, evidence.quote);
});
