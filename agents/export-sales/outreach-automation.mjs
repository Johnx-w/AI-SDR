const AGENT_IDS = new Set(['shutter', 'venetian', 'indoor', 'outdoor']);
const ALLOWED_CONTACT_KINDS = new Set(['company_public', 'named_business']);
const SUPPRESSION_FLAGS = [
  'do_not_contact',
  'unsubscribed',
  'hard_bounced',
  'complaint',
  'duplicate_owner',
];

function add(reasons, reason, condition) {
  if (condition) reasons.push(reason);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeEmail(value) {
  return (
    nonEmpty(value) && !/[\r\n]/.test(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  );
}

function unique(values) {
  return [...new Set(values)];
}

function effectiveTime(input) {
  const parsed = Date.parse(input?.evaluation_time || '');
  return Number.isFinite(parsed) ? parsed : NaN;
}

function claimIsEligible(claim, input) {
  if (!claim || claim.agent_id !== input.agent_id || claim.approved !== true) return false;
  if (!Array.isArray(claim.usage) || !claim.usage.includes('outreach')) return false;
  const country = input.lead_snapshot?.country;
  if (
    !Array.isArray(claim.markets) ||
    !(claim.markets.includes('*') || claim.markets.includes(country))
  )
    return false;
  const customerType = input.lead_snapshot?.customer_type;
  if (
    !Array.isArray(claim.customer_types) ||
    !(claim.customer_types.includes('*') || claim.customer_types.includes(customerType))
  )
    return false;
  if (claim.valid_until === null) return true;
  const validUntil = Date.parse(claim.valid_until || '');
  const now = effectiveTime(input);
  return Number.isFinite(validUntil) && Number.isFinite(now) && validUntil >= now;
}

export function eligibleProductClaims(input) {
  if (input?.product_knowledge?.status !== 'ready') return [];
  return Array.isArray(input.product_knowledge.records)
    ? input.product_knowledge.records.filter((claim) => claimIsEligible(claim, input))
    : [];
}

export function evaluateOutreachReadiness(input) {
  const reasons = [];
  add(reasons, 'invalid_contract_version', input?.contract_version !== '1.1');
  add(reasons, 'invalid_agent', !AGENT_IDS.has(input?.agent_id));
  add(reasons, 'invalid_evaluation_time', !Number.isFinite(effectiveTime(input)));
  add(reasons, 'missing_operation_id', !nonEmpty(input?.operation_id));
  add(reasons, 'missing_campaign_id', !nonEmpty(input?.campaign?.id));

  const draftOnly = input?.campaign?.sending_mode === 'draft_only';
  add(
    reasons,
    'campaign_inactive',
    draftOnly
      ? !['draft', 'active'].includes(input?.campaign?.status)
      : input?.campaign?.status !== 'active',
  );
  add(reasons, 'outreach_disabled', input?.policy?.outreach_enabled !== true);

  const lead = input?.lead_snapshot;
  add(reasons, 'missing_customer_id', !nonEmpty(lead?.customer_id));
  add(reasons, 'prospect_not_b2b', lead?.buyer_status !== 'b2b');
  add(reasons, 'contact_not_ready', lead?.contact_readiness !== 'ready');
  add(reasons, 'contact_not_authoritative', !ALLOWED_CONTACT_KINDS.has(lead?.contact?.kind));
  add(reasons, 'contact_email_invalid', !safeEmail(lead?.contact?.email));
  add(reasons, 'contact_source_missing', !nonEmpty(lead?.contact?.source_id));
  add(reasons, 'existing_conversation', lead?.open_conversation === true);
  add(reasons, 'human_owned', lead?.human_owned === true);
  add(
    reasons,
    'suppressed_contact',
    SUPPRESSION_FLAGS.some((flag) => lead?.suppression?.[flag] === true),
  );

  const event = input?.event;
  if (event?.type === 'first_touch') {
    add(reasons, 'invalid_sequence_step', event.sequence_step !== 1);
    add(reasons, 'already_contacted', lead?.development_status !== 'pending_outreach');
    add(reasons, 'first_touch_already_sent', input?.delivery_history?.first_touch_sent !== false);
  } else if (event?.type === 'sequence_follow_up') {
    add(
      reasons,
      'invalid_sequence_step',
      !Number.isInteger(event.sequence_step) || event.sequence_step < 2,
    );
    reasons.push('sequence_follow_up_not_launched');
    add(reasons, 'sequence_state_invalid', lead?.development_status !== 'contacted');
  } else {
    reasons.push('unsupported_event');
  }

  add(reasons, 'reply_received', input?.delivery_history?.reply_received === true);
  add(
    reasons,
    'duplicate_operation',
    input?.delivery_history?.sent_operation_ids?.includes(input?.operation_id) === true,
  );

  const evidence = lead?.relevance_evidence;
  add(
    reasons,
    'insufficient_relevance_evidence',
    !Array.isArray(evidence) || evidence.length === 0,
  );
  add(
    reasons,
    'market_not_allowed',
    !Array.isArray(input?.policy?.allowed_markets) ||
      !input.policy.allowed_markets.includes(lead?.country),
  );

  const claims = eligibleProductClaims(input);
  add(reasons, 'product_knowledge_unavailable', claims.length === 0);

  return {
    ready: reasons.length === 0,
    reasons: unique(reasons),
    eligibleProductClaimIds: claims.map((claim) => claim.id),
    relevanceEvidenceIds: Array.isArray(evidence) ? evidence.map((item) => item.id) : [],
  };
}

function validateDraftIdentity(input, output, reasons) {
  add(reasons, 'output_contract_mismatch', output?.contract_version !== '1.1');
  add(reasons, 'output_agent_mismatch', output?.agent_id !== input.agent_id);
  add(reasons, 'output_campaign_mismatch', output?.campaign_id !== input.campaign.id);
  add(reasons, 'output_operation_mismatch', output?.operation_id !== input.operation_id);
  add(reasons, 'output_customer_mismatch', output?.customer_id !== input.lead_snapshot.customer_id);
  add(
    reasons,
    'stale_customer_revision',
    output?.based_on_customer_revision !== input.lead_snapshot.revision,
  );
}

function automaticReasons(input) {
  const reasons = [];
  const sender = input.sender_identity;
  const policy = input.policy;
  add(
    reasons,
    'campaign_automatic_approval_missing_or_stale',
    !Number.isInteger(input.campaign?.revision) ||
      !Number.isInteger(input.campaign?.approved_automatic_revision) ||
      input.campaign.approved_automatic_revision !== input.campaign.revision,
  );
  add(reasons, 'sender_identity_unapproved', sender?.approved !== true);
  add(reasons, 'sender_company_missing', !nonEmpty(sender?.company_name));
  add(reasons, 'sender_name_missing', !nonEmpty(sender?.display_name));
  add(reasons, 'sender_email_invalid', !safeEmail(sender?.email));
  add(reasons, 'reply_to_invalid', !safeEmail(sender?.reply_to));
  add(reasons, 'company_policy_unapproved', policy?.company_policy_approved !== true);
  add(reasons, 'policy_revision_missing', !nonEmpty(policy?.policy_revision));
  add(reasons, 'outside_send_window', policy?.within_send_window !== true);
  add(reasons, 'send_window_unconfigured', !policy?.send_window);
  add(reasons, 'daily_limit_unconfigured', !Number.isInteger(policy?.daily_limit));
  add(
    reasons,
    'daily_limit_reached',
    Number.isInteger(policy?.daily_limit) && policy.sent_today >= policy.daily_limit,
  );
  add(reasons, 'domain_limit_unconfigured', !Number.isInteger(policy?.per_domain_daily_limit));
  add(
    reasons,
    'domain_limit_reached',
    Number.isInteger(policy?.per_domain_daily_limit) &&
      policy.sent_to_domain_today >= policy.per_domain_daily_limit,
  );
  add(reasons, 'footer_unapproved_or_missing', !nonEmpty(policy?.approved_footer));
  add(reasons, 'unsubscribe_instruction_missing', !nonEmpty(policy?.unsubscribe_instruction));
  add(
    reasons,
    'contact_not_verified_for_automatic_send',
    input.lead_snapshot?.contact?.verification_status !== 'verified',
  );
  return unique(reasons);
}

function composeBody(input, body) {
  return [
    body.trim(),
    input.policy.approved_footer?.trim(),
    input.policy.unsubscribe_instruction?.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function prepareOutreachDispatch(input, output) {
  const readiness = evaluateOutreachReadiness(input);
  if (!readiness.ready) return { status: 'blocked', reasons: readiness.reasons };

  const reasons = [];
  validateDraftIdentity(input, output, reasons);
  add(
    reasons,
    'unsupported_output_action',
    !['draft_ready', 'suppress', 'needs_review'].includes(output?.action),
  );
  if (reasons.length) return { status: 'blocked', reasons: unique(reasons) };

  if (output.action === 'suppress') {
    return { status: 'suppressed', reasons: output.reason_codes || ['agent_suppressed'] };
  }
  if (output.action === 'needs_review') {
    return { status: 'needs_review', reasons: output.reason_codes || ['agent_requested_review'] };
  }

  add(reasons, 'subject_missing', !nonEmpty(output.subject));
  add(reasons, 'subject_header_injection', /[\r\n]/.test(output.subject || ''));
  add(reasons, 'body_missing', !nonEmpty(output.body_text));
  add(
    reasons,
    'unknown_product_claim',
    !Array.isArray(output.product_claim_ids) ||
      output.product_claim_ids.length === 0 ||
      output.product_claim_ids.some((id) => !readiness.eligibleProductClaimIds.includes(id)),
  );
  add(
    reasons,
    'unknown_personalization_source',
    !Array.isArray(output.personalization_source_ids) ||
      output.personalization_source_ids.length === 0 ||
      output.personalization_source_ids.some((id) => !readiness.relevanceEvidenceIds.includes(id)),
  );
  add(
    reasons,
    'unexpected_reason_codes',
    !Array.isArray(output.reason_codes) || output.reason_codes.length > 0,
  );
  if (reasons.length) return { status: 'blocked', reasons: unique(reasons) };

  const draft = {
    subject: output.subject.trim(),
    bodyText: composeBody(input, output.body_text),
    productClaimIds: [...output.product_claim_ids],
    personalizationSourceIds: [...output.personalization_source_ids],
  };
  if (input.campaign.sending_mode === 'draft_only') return { status: 'draft_only', draft };
  if (input.campaign.sending_mode === 'review_required')
    return { status: 'awaiting_review', draft };
  if (input.campaign.sending_mode !== 'automatic')
    return { status: 'blocked', reasons: ['unsupported_sending_mode'] };

  const sendReasons = automaticReasons(input);
  if (sendReasons.length) return { status: 'blocked', reasons: sendReasons, draft };

  return {
    status: 'ready_to_send',
    draft,
    message: {
      idempotencyKey: input.operation_id,
      campaignId: input.campaign.id,
      customerId: input.lead_snapshot.customer_id,
      contactId: input.lead_snapshot.contact.id,
      from: input.sender_identity.email.trim(),
      fromName: input.sender_identity.display_name.trim(),
      replyTo: input.sender_identity.reply_to.trim(),
      to: input.lead_snapshot.contact.email.trim(),
      subject: draft.subject,
      text: draft.bodyText,
    },
  };
}

export async function runOutreachAutomation({ input, generateDraft, transport }) {
  if (typeof generateDraft !== 'function') throw new TypeError('generateDraft 必须是函数');
  const readiness = evaluateOutreachReadiness(input);
  if (!readiness.ready) return { status: 'blocked', reasons: readiness.reasons };

  const output = await generateDraft(input);
  const prepared = prepareOutreachDispatch(input, output);
  if (prepared.status !== 'ready_to_send') return prepared;
  if (!transport || typeof transport.send !== 'function') {
    return { status: 'blocked', reasons: ['email_transport_unavailable'], draft: prepared.draft };
  }

  try {
    const result = await transport.send(prepared.message);
    if (result?.status !== 'sent' || !nonEmpty(result?.messageId)) {
      return {
        status: 'delivery_unknown',
        operationId: input.operation_id,
        retryAutomatically: false,
      };
    }
    return {
      status: 'sent',
      operationId: input.operation_id,
      messageId: result.messageId,
      sentAt: result.sentAt || null,
    };
  } catch (error) {
    return {
      status: 'send_failed',
      operationId: input.operation_id,
      retryAutomatically: false,
      retryable: error?.retryable === true,
    };
  }
}
