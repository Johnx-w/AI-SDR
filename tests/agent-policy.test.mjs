import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  evaluateOutreachReadiness,
  prepareOutreachDispatch,
  runOutreachAutomation,
} from '../agents/export-sales/outreach-automation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sales = path.join(root, 'agents', 'export-sales');
const readJson = (relative) => JSON.parse(readFileSync(path.join(sales, relative), 'utf8'));

function baseInput() {
  return {
    contract_version: '1.1',
    evaluation_time: '2026-10-23T15:00:00+08:00',
    agent_id: 'venetian',
    campaign: {
      id: 'test-plan',
      status: 'active',
      sending_mode: 'automatic',
      revision: 5,
      approved_automatic_revision: 5,
    },
    operation_id: 'first-touch-test-001',
    event: { type: 'first_touch', sequence_step: 1 },
    lead_snapshot: {
      customer_id: 'company-test-001',
      revision: 2,
      company_name: 'Fictional Wholesale Inc.',
      website: 'https://example.invalid',
      country: 'US',
      customer_type: 'wholesaler',
      buyer_status: 'b2b',
      development_status: 'pending_outreach',
      contact_readiness: 'ready',
      contact: {
        id: 'contact-test-001',
        email: 'buyer@example.invalid',
        kind: 'named_business',
        source_id: 'source-test-001',
        verification_status: 'verified',
      },
      opportunity_ids: ['opportunity-test-001'],
      relevance_evidence: [
        {
          id: 'evidence-test-001',
          content: 'Fictional fit',
          source_url: 'https://example.invalid',
        },
      ],
      open_conversation: false,
      human_owned: false,
      suppression: {
        do_not_contact: false,
        unsubscribed: false,
        hard_bounced: false,
        complaint: false,
        duplicate_owner: false,
        reason: null,
      },
    },
    sender_identity: {
      id: 'identity-test-001',
      company_name: 'Fictional Exporter Ltd.',
      display_name: 'Fictional Sales',
      email: 'sales@example.invalid',
      reply_to: 'sales@example.invalid',
      approved: true,
    },
    product_knowledge: {
      catalog_version: 'test-v1',
      status: 'ready',
      records: [
        {
          id: 'claim-test-001',
          agent_id: 'venetian',
          product_name: 'Fictional PVC blind',
          statement: 'Fictional approved product scope for a schema fixture.',
          claim_type: 'product_scope',
          approved: true,
          usage: ['outreach'],
          markets: ['US'],
          customer_types: ['wholesaler'],
          source_ref: 'fixture-only',
          approved_by: 'fixture-reviewer',
          approved_at: '2026-10-22T15:00:00+08:00',
          valid_until: null,
        },
      ],
    },
    policy: {
      outreach_enabled: true,
      company_policy_approved: true,
      policy_revision: 'test-v1',
      allowed_markets: ['US'],
      within_send_window: true,
      send_window: { start: '09:00', end: '17:00', timezone: 'America/New_York' },
      daily_limit: 10,
      sent_today: 0,
      per_domain_daily_limit: 1,
      sent_to_domain_today: 0,
      approved_footer: 'Fictional footer',
      unsubscribe_instruction: 'Reply to opt out.',
      sequence_follow_up_enabled: false,
    },
    delivery_history: {
      sent_operation_ids: [],
      last_sent_at: null,
      reply_received: false,
      first_touch_sent: false,
    },
  };
}

function baseDraft() {
  return {
    contract_version: '1.1',
    agent_id: 'venetian',
    campaign_id: 'test-plan',
    operation_id: 'first-touch-test-001',
    customer_id: 'company-test-001',
    based_on_customer_revision: 2,
    action: 'draft_ready',
    subject: 'Fictional supply enquiry',
    body_text: 'Fictional relevant product introduction.',
    personalization_source_ids: ['evidence-test-001'],
    product_claim_ids: ['claim-test-001'],
    reason_codes: [],
    internal_note: '',
  };
}

test('会话 1.3 示例显式区分单封审核和接管范围', () => {
  const inputSchema = readJson('turn-input.schema.json');
  const outputSchema = readJson('turn-output.schema.json');
  assert.equal(inputSchema.properties.contract_version.const, '1.3');
  assert.equal(outputSchema.properties.contract_version.const, '1.3');
  for (const name of ['quote', 'mixed', 'drawing', 'catalog-fallback']) {
    const input = readJson(`examples/${name}-input.json`);
    const output = readJson(`examples/${name}-output.json`);
    assert.equal(input.contract_version, '1.3');
    assert.equal(output.contract_version, '1.3');
    assert.ok(['ai', 'pending_human', 'human'].includes(input.conversation.ownership));
    assert.equal(typeof input.conversation.handoff_ack_sent, 'boolean');
    for (const item of input.demand_context) {
      assert.equal(typeof item.repeated_negotiation, 'boolean');
      assert.ok(Number.isInteger(item.nonprogress_exchanges));
      assert.equal(typeof item.large_order_match.matched, 'boolean');
      assert.ok(item.knowledge_resolution.retrieval_state);
    }
    for (const item of output.items) {
      assert.ok(['none', 'per_message'].includes(item.approval_gate));
      if (item.action !== 'request_handoff') assert.equal(item.handoff_scope, null);
      if (item.approval_gate === 'per_message') {
        assert.equal(item.action, 'reply');
        assert.equal(item.approval_reason, 'commercial_commitment');
      }
    }
  }
  const quote = readJson('examples/quote-output.json');
  assert.equal(quote.items[0].action, 'clarify');
  assert.equal(quote.items[0].handoff_reason, null);
});

test('产品资料缺失时不生成开发信草稿或发送', async () => {
  const input = baseInput();
  input.product_knowledge.status = 'awaiting_reviewed_product_data';
  input.product_knowledge.records = [];
  assert.ok(evaluateOutreachReadiness(input).reasons.includes('product_knowledge_unavailable'));
  let generated = false;
  let sent = false;
  const result = await runOutreachAutomation({
    input,
    generateDraft: () => {
      generated = true;
      return baseDraft();
    },
    transport: {
      send: () => {
        sent = true;
      },
    },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(generated, false);
  assert.equal(sent, false);
});

test('同企业已经发过首封或已有会话时阻止再次首次开发', () => {
  const input = baseInput();
  input.delivery_history.first_touch_sent = true;
  assert.ok(evaluateOutreachReadiness(input).reasons.includes('first_touch_already_sent'));
  input.delivery_history.first_touch_sent = false;
  input.lead_snapshot.open_conversation = true;
  assert.ok(evaluateOutreachReadiness(input).reasons.includes('existing_conversation'));
  input.lead_snapshot.open_conversation = false;
  input.lead_snapshot.suppression.unsubscribed = true;
  assert.ok(evaluateOutreachReadiness(input).reasons.includes('suppressed_contact'));
});

test('自动发送只接受当前触达计划版本的明确批准', () => {
  const input = baseInput();
  assert.equal(prepareOutreachDispatch(input, baseDraft()).status, 'ready_to_send');
  input.campaign.approved_automatic_revision = 4;
  const stale = prepareOutreachDispatch(input, baseDraft());
  assert.equal(stale.status, 'blocked');
  assert.ok(stale.reasons.includes('campaign_automatic_approval_missing_or_stale'));
  delete input.campaign.approved_automatic_revision;
  delete input.campaign.revision;
  const missing = prepareOutreachDispatch(input, baseDraft());
  assert.equal(missing.status, 'blocked');
  assert.ok(missing.reasons.includes('campaign_automatic_approval_missing_or_stale'));
});

test('非回复追信序列在首轮试点中始终关闭', () => {
  const input = baseInput();
  input.event = { type: 'sequence_follow_up', sequence_step: 2 };
  input.lead_snapshot.development_status = 'contacted';
  input.policy.sequence_follow_up_enabled = true;
  assert.ok(evaluateOutreachReadiness(input).reasons.includes('sequence_follow_up_not_launched'));
});
