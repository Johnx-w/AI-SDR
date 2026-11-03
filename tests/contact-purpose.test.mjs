import test from 'node:test';
import assert from 'node:assert/strict';
import { emailPurpose } from '../src/domain/email-purpose.mjs';
import { buildContactPresentation } from '../src/domain/contact-presentation.mjs';

const website = 'https://buyer.example.org';
const evidence = (kind, value, quote, source_url = website + '/contact') => ({
  kind,
  value,
  quote,
  source_url,
});

test('邮箱展示区分官网说明、地址推测以及首封适用性', () => {
  const lead = {
    website,
    email:
      'alice@buyer.example.org\ninfo@buyer.example.org\nsales@buyer.example.org\naccounts@buyer.example.org',
    contactEvidence: [
      evidence(
        'email',
        'alice@buyer.example.org',
        'Alice, Purchasing Manager: alice@buyer.example.org',
      ),
      evidence(
        'email',
        'info@buyer.example.org',
        'General business enquiries: info@buyer.example.org',
      ),
      evidence('email', 'sales@buyer.example.org', 'Residential sales: sales@buyer.example.org'),
    ],
  };
  const purposes = buildContactPresentation(lead).emails.map(({ purpose }) => purpose);
  assert.deepEqual(
    purposes.map(({ type }) => type),
    ['procurement', 'general', 'sales', 'finance'],
  );
  assert.deepEqual(
    purposes.map(({ eligible }) => eligible),
    [true, true, false, false],
  );
  assert.equal(purposes[0].basis, '官网说明');
  assert.equal(purposes[3].basis, '邮箱名称推测');
  assert.equal(purposes[0].namedBuyer, true);
});

test('官网销售、技术支持和外域邮箱不会因一般联系信息而成为供货开发信收件人', () => {
  const sharedSupportQuote =
    'Email support for Audiovisual and Shading: drapertechgroup@draperinc.com Email support for Gymnasium Equipment: lolson@draperinc.com';
  const draper = {
    website: 'https://www.draperinc.com',
    email:
      'draperathome@draperinc.com\nj.yeung@draperinc.com\ndrapertechgroup@draperinc.com\nlolson@draperinc.com',
    contactEvidence: [
      evidence(
        'email',
        'draperathome@draperinc.com',
        'Residential sales: draperathome@draperinc.com',
        'https://www.draperinc.com/contact',
      ),
      evidence(
        'email',
        'j.yeung@draperinc.com',
        'Regional sales representative: j.yeung@draperinc.com',
        'https://www.draperinc.com/contact',
      ),
      evidence(
        'email',
        'drapertechgroup@draperinc.com',
        sharedSupportQuote,
        'https://www.draperinc.com/support',
      ),
      evidence(
        'email',
        'lolson@draperinc.com',
        sharedSupportQuote,
        'https://www.draperinc.com/support',
      ),
    ],
  };
  assert.deepEqual(
    buildContactPresentation(draper).emails.map(({ purpose }) => [purpose.type, purpose.eligible]),
    [
      ['sales', false],
      ['sales', false],
      ['support', false],
      ['support', false],
    ],
  );
  assert.equal(
    emailPurpose(
      'info@other.example.org',
      [
        evidence(
          'email',
          'info@other.example.org',
          'General enquiries: info@other.example.org',
          'https://directory.example.org/list',
        ),
      ],
      website,
    ).eligible,
    false,
  );
  assert.equal(emailPurpose('NWFSalesSupport@buyer.example.org', [], website).type, 'support');
});

test('电话逐号显示用途；没有逐号证据及多号码混合引文保持未识别', () => {
  const result = buildContactPresentation({
    phone: '+1 7659877999\n+1 8002387999 ext 3\n+1 85298765432\n+1 2125550100',
    contactEvidence: [
      evidence('phone', '+1 7659877999', 'Main office telephone: +1 7659877999'),
      evidence('phone', '+1 8002387999 ext 3', 'Technical support: +1 8002387999 ext 3'),
      evidence('phone', '+1 2125550100', 'Sales: +1 2125550100; Procurement: +1 2125550199'),
    ],
  });
  assert.deepEqual(
    result.phones.map(({ purpose }) => purpose.type),
    ['general', 'support', 'unknown', 'unknown'],
  );
  assert.equal(result.phones[1].href, 'tel:+18002387999;ext=3');
});
