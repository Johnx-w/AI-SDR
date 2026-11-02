import { parseCompanyResearch } from './company-research.mjs';
import { assessCompany, assessmentId, assessmentRating } from './customer-assessment.mjs';
import { assessmentSummaryFields, customerWebsite, fieldValue } from './customer-fields.mjs';
import { fieldText } from './feishu.mjs';
import { domainKey } from './website-identity.mjs';

const skipped = (reason) => ({ ok: false, reason });

export function planPriorityHistoryReplay({ operation, entry, lead, record, scope }) {
  const old = entry?.snapshot;
  const target = operation?.input?.input;
  if (
    !scope ||
    operation?.scope !== scope ||
    operation?.state !== 'completed' ||
    operation?.output?.outcome !== 'completed' ||
    !['insert', 'update'].includes(operation?.action) ||
    !old ||
    old.ruleVersion !== 'acquisition-v3.2' ||
    !old.id ||
    operation.assessment?.id !== old.id ||
    operation.output.assessment?.id !== old.id ||
    JSON.stringify(operation.assessment) !== JSON.stringify(old) ||
    operation.recordId !== entry.recordId ||
    lead?.id !== entry.recordId ||
    !target ||
    !Number.isFinite(Date.parse(old.evaluatedAt)) ||
    !Array.isArray(old.missing)
  )
    return skipped('source_incomplete');
  const domain = domainKey(old.website);
  if (
    !domain ||
    domain !== domainKey(operation.source_url) ||
    domain !== domainKey(lead.website) ||
    (record && (record.record_id !== lead.id || domain !== domainKey(customerWebsite(record)))) ||
    (record && fieldText(fieldValue(record.fields || {}, '公司名称')) !== lead.name) ||
    (old.companyName ? old.companyName !== lead.name : operation.research_response != null) ||
    ['product', 'country', 'product_scope', 'environment_preference'].some(
      (key) => (old.target?.[key] || '') !== (target[key] || ''),
    )
  )
    return skipped('identity_or_target_changed');
  const grade = assessmentRating(old);
  const previous = assessmentSummaryFields(old);
  const pending = [...(old.missing || []).map((value) => String(value).trim()).filter(Boolean)];
  if (old.incompleteReason) pending.push('研究限制：' + String(old.incompleteReason).trim());
  if (
    old.supplyOpportunity?.kind === 'potential_input' &&
    old.supplyOpportunity.procurementStatus !== 'confirmed'
  )
    pending.push(
      String(old.supplyOpportunity.note || '').trim() ||
        '材料或配件采购方式、规格、数量与负责人待沟通',
    );
  const generatedPending = [...new Set(pending)].join('；');
  const fields = lead.fields || {};
  const unchanged = (candidate) =>
    fieldText(fieldValue(candidate, '用户评级')) === grade &&
    (!Object.hasOwn(candidate, '评级依据') || fieldText(candidate['评级依据']) === old.reason) &&
    (!Object.hasOwn(candidate, '主要供货机会') ||
      fieldText(candidate['主要供货机会']) === previous['主要供货机会']) &&
    (!Object.hasOwn(candidate, '待确认事项') ||
      fieldText(candidate['待确认事项']) === generatedPending);
  if (
    lead.grade !== grade ||
    lead.ratingReason !== old.reason ||
    lead.assessment?.id !== old.id ||
    !unchanged(fields) ||
    (record && !unchanged(record.fields || {}))
  )
    return skipped('manual_override_or_changed_fields');
  let research;
  if (operation.research_response == null) {
    if (
      old.grade !== null ||
      old.status !== '待核实' ||
      old.entityType !== 'unknown' ||
      old.direction !== null ||
      old.assumed !== false ||
      !old.incompleteReason ||
      !Array.isArray(old.facts) ||
      old.facts.length ||
      !Array.isArray(old.opportunities) ||
      old.opportunities.length ||
      !operation.research ||
      operation.research.entity_type !== 'unknown' ||
      ['matched', 'not_matched'].includes(operation.research.product_match) ||
      !operation.research.incomplete_reason ||
      domain !== domainKey(operation.research.source_url) ||
      !Array.isArray(operation.research.facts) ||
      operation.research.facts.length ||
      !Array.isArray(operation.research.assessment_opportunities) ||
      operation.research.assessment_opportunities.length ||
      ['P', 'R', 'D', 'V'].some(
        (key) =>
          old.dimensions?.[key]?.score !== null ||
          !Array.isArray(old.dimensions?.[key]?.facts) ||
          old.dimensions[key].facts.length,
      )
    )
      return skipped('source_incomplete');
    research = {
      source_url: old.website,
      company_name: old.companyName,
      entity_type: 'unknown',
      product_match: 'unknown',
      review_required: true,
      incomplete_reason: '历史研究缺少可复核原始响应',
      assessment_opportunities: [],
      facts: [],
      checked_urls: [],
    };
  } else {
    if (!Array.isArray(operation.research_pages) || !operation.research_pages.length)
      return skipped('source_incomplete');
    try {
      research = parseCompanyResearch(
        operation.research_response,
        { source_url: operation.source_url, research_pages: operation.research_pages },
        target,
      );
    } catch {
      return skipped('evidence_replay_failed');
    }
    if (
      research.entity_type !== 'business' ||
      research.product_match === 'not_matched' ||
      research.eligibility?.status === 'rejected' ||
      [
        'country_match',
        'audience_match',
        'customer_type_match',
        'profile_match',
        'required_match',
      ].some((key) => research[key] === 'not_matched') ||
      domain !== domainKey(research.source_url) ||
      research.company_name !== old.companyName
    )
      return skipped('evidence_requires_review');
    research = {
      ...research,
      review_required:
        research.review_required ||
        research.product_match !== 'matched' ||
        research.required_match === 'unknown' ||
        research.eligibility?.status === 'insufficient_evidence',
      checked_urls: operation.checked_urls || [],
    };
  }
  let snapshot;
  try {
    snapshot = assessCompany({
      research,
      target,
      at: Date.parse(old.evaluatedAt),
      id: assessmentId(scope, 'history:' + old.id),
    });
  } catch {
    return skipped('evidence_replay_failed');
  }
  if (!['A', 'B', 'C'].includes(snapshot.grade)) return skipped('evidence_requires_review');
  return {
    ok: true,
    snapshot,
    fields: {
      [Object.hasOwn(fields, '初评结果') ? '初评结果' : '用户评级']: assessmentRating(snapshot),
      ...(Object.hasOwn(fields, '评级依据') || Object.hasOwn(record?.fields || {}, '评级依据')
        ? { 评级依据: snapshot.reason }
        : {}),
      ...assessmentSummaryFields(snapshot),
    },
  };
}
