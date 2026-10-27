import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateHandoffReadiness } from '../server/handoff-readiness.mjs';
import { combineWebsiteEvidence } from '../server/website-metadata.mjs';
import { researchPageText } from '../server/research-pages.mjs';
import { BatchJobs } from '../server/batch-jobs.mjs';

const site = 'https://buyer.example.org/';
const research = {
  ok: true,
  source_url: site,
  company_name: 'Buyer LLC',
  entity_type: 'business',
  eligibility: { status: 'eligible' },
  required_match: 'unrestricted',
  checked_urls: [site],
  company_identity: {
    name: 'Buyer LLC',
    status: 'website_name_only',
    evidence: [{ source_url: site, quote: 'Buyer LLC supplies roller blinds.' }],
  },
};
const assessment = {
  grade: 'A',
  status: '优先开发',
  complete: false,
  dimensions: { P: { score: 40 }, R: { score: 25 }, D: { score: 10 }, V: { score: null } },
};

test('官网只有建站商邮件时不能把建站商当公司级联系入口', () => {
  const html =
    '<p>Buyer LLC supplies roller blinds.</p><footer>Website designed by Design Agency. Website support: <a href="mailto:hello@designagency.com">hello@designagency.com</a></footer>';
  const evidence = combineWebsiteEvidence([{ url: site, content: html }]);
  const handoff = calculateHandoffReadiness({
    research,
    assessment,
    contacts: evidence.contacts,
    researchPages: [{ source_url: site, text: researchPageText(html) }],
  });
  assert.equal(handoff.contact_verified, false);
  assert.equal(handoff.ready, false);
});

test('有效业务联系表单可满足公司级入口而不强求公开邮箱电话', () => {
  const html =
    '<p>Buyer LLC supplies roller blinds.</p><h1>Contact our sales team</h1><form action="/contact" method="post"><label>Your email<input type="email" name="email" required></label><label>Your enquiry<textarea name="message" required></textarea></label><button type="submit">Send enquiry</button></form>';
  const handoff = calculateHandoffReadiness({
    research,
    assessment,
    researchPages: [{ source_url: site, content: html }],
  });
  assert.equal(handoff.ready, true);
  assert.equal(
    handoff.contacts.some((contact) => contact.kind === 'form'),
    true,
  );
});

test('同企业不同操作重放旧新增结果不会重复计入新增', async () => {
  const ready = {
    policy: 'sales-handoff-v1',
    ready: true,
    reasons: [],
    identity_verified: true,
    opportunity_qualified: true,
    contact_verified: true,
    contacts: [
      {
        kind: 'email',
        value: 'sales@buyer.example.org',
        source_url: site,
        quote: 'sales@buyer.example.org',
      },
    ],
  };
  const records = [];
  const manager = new BatchJobs({
    provider: 'native',
    schedule: false,
    discover: async () => ({ candidates: [{ source_url: site }] }),
    research: async () => {
      if (!records.length) records.push({ id: 'rec-one', website: site, name: 'Buyer LLC' });
      return {
        新增: 1,
        handoff: ready,
        明细: [{ result: 'inserted', source_url: site, record_id: 'rec-one' }],
      };
    },
    readLeads: async () => records,
    status: async () => ({ settled: false }),
  });
  const target = {
    country: 'United States',
    product: 'roller blinds',
    audience: 'B',
    acquisition_channel: 'web',
    target_count: 1,
    research_budget: 1,
  };
  try {
    const first = manager.create(target, 'edge-replayed-first');
    await manager.work(first.id);
    assert.equal(manager.get(first.id).inserted, 1);
    const second = manager.create(target, 'edge-replayed-second');
    await manager.work(second.id);
    assert.equal(manager.get(second.id).inserted, 0);
  } finally {
    manager.close();
  }
});
