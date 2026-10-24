import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCapturedCompany } from '../scripts/verify-dual-handoff-live.mjs';

const domain = 'buyer.example';
const row = {
  result: 'inserted',
  inserted_new: true,
  record_id: 'rec-new',
  source_url: `https://${domain}/products`,
};
const research = {
  company_name: 'Buyer Inc.',
  entity_type: 'business',
  actual_country: 'Canada',
  country_match: 'matched',
  product_match: 'matched',
  company_identity: {
    name: 'Buyer Inc.',
    status: 'website_name_only',
    evidence: [
      { source_url: `https://${domain}/about`, quote: 'Buyer Inc. operates this company.' },
    ],
  },
};
const job = { input: { country: 'Canada' } };

test('broad live acceptance counts a verified business without requiring contact or complete rating', () => {
  const result = verifyCapturedCompany({
    row,
    research,
    assessment: { grade: 'B', score: 70, missing: ['持续经营或当前供货流程资料不足'] },
    job,
    baseline: { records: [] },
  });
  assert.equal(result.passed, true, JSON.stringify(result.checks));
  assert.equal(result.grade, 'B');
  assert.deepEqual(result.missing, ['持续经营或当前供货流程资料不足']);
});

test('an existing domain, third party listing, country mismatch, or unrelated company is not counted', () => {
  const baseline = { records: [{ id: 'old', domain }] };
  assert.equal(
    verifyCapturedCompany({ row, research, job, baseline }).checks.outside_preexisting_baseline,
    false,
  );
  assert.equal(
    verifyCapturedCompany({
      row: { ...row, source_url: 'https://importkey.com/company' },
      research,
      job,
      baseline: { records: [] },
    }).checks.official_website_domain,
    false,
  );
  assert.equal(
    verifyCapturedCompany({
      row,
      research: { ...research, actual_country: 'United States' },
      job,
      baseline: { records: [] },
    }).passed,
    false,
  );
  assert.equal(
    verifyCapturedCompany({
      row,
      research: { ...research, product_match: 'not_matched' },
      job,
      baseline: { records: [] },
    }).passed,
    false,
  );
});
