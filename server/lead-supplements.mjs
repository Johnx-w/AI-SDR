import { assessCompany, formatAssessmentReason } from './customer-assessment.mjs';

export const SUPPLEMENT_FACT_KINDS = Object.freeze({
  P: Object.freeze(['core_product', 'secondary_product', 'adjacent_product', 'unrelated_product']),
  R: Object.freeze(['specialist_supply', 'general_supply', 'installation_only', 'no_supply_role']),
  D: Object.freeze([
    'current_supply_process',
    'company_since',
    'company_years',
    'operating_outlet',
    'active_dealer',
    'completed_project',
    'completed_commercial_project',
  ]),
  V: Object.freeze(['custom_made', 'motorized_system', 'commercial_specification']),
});

const allowedKeys = new Set([
  'expectedAssessmentId',
  'category',
  'dimension',
  'direction',
  'product',
  'content',
  'evidence',
  'sourceUrl',
  'confirmedBy',
  'facts',
  'pendingItem',
  'sourceMessageId',
]);
const categories = new Set(['assessment', 'legal_name', 'purchase_need', 'profile']);
const directions = new Set(['finished', 'materials', 'samples']);
const normalize = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function text(value, label, maximum, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw invalid(label + '必须是文字');
  const result = value.trim();
  if (required && !result) throw invalid('请填写' + label);
  if (result.length > maximum) throw invalid(label + '过长');
  return result;
}

function validateSince(value, at) {
  if (!/^\d{4}(?:-\d{2}-\d{2})?$/.test(value))
    throw invalid('经营起始时间请填写年份或日期，例如 2012 或 2012-05-01');
  const date = /^\d{4}$/.test(value) ? value + '-01-01' : value;
  const parsed = new Date(date + 'T00:00:00Z');
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date ||
    parsed.getTime() > at ||
    Number(value.slice(0, 4)) < 1800
  )
    throw invalid('经营起始时间须为有效的已发生日期');
}

// This validates human facts, never accepts a score or a caller supplied audit
// identity/time. The server supplies those after checking the current customer.
export function validateSupplement(body, { at = Date.now() } = {}) {
  if (!plainObject(body)) throw invalid('补充资料格式不正确');
  if (Object.keys(body).some((key) => !allowedKeys.has(key)))
    throw invalid('补充资料包含不支持的字段');
  if (!Object.hasOwn(body, 'expectedAssessmentId')) throw invalid('缺少当前评估版本，请刷新后重试');
  const expectedAssessmentId =
    body.expectedAssessmentId === null
      ? null
      : text(body.expectedAssessmentId, '当前评估版本', 150, true);
  if (!categories.has(body.category)) throw invalid('请选择补充资料类型');
  const result = {
    expectedAssessmentId,
    category: body.category,
    content: text(body.content, '确认内容', 2000, true),
    evidence: text(body.evidence, '确认依据', 10000, true),
    confirmedBy: text(body.confirmedBy, '确认人', 100, true),
    sourceUrl: text(body.sourceUrl, '来源链接', 2000),
    pendingItem: text(body.pendingItem, '对应待确认事项', 1000),
    sourceMessageId: text(body.sourceMessageId, '沟通记录', 150),
  };
  if (result.sourceUrl) {
    let url;
    try {
      url = new URL(result.sourceUrl);
    } catch {
      throw invalid('来源链接须为有效的 HTTP 或 HTTPS 地址');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw invalid('来源链接须为有效的 HTTP 或 HTTPS 地址');
  }
  const scoped = body.category === 'assessment' || body.category === 'purchase_need';
  result.product = text(body.product, '对应产品', 500, scoped);
  result.direction = text(body.direction, '供货方向', 20, scoped);
  if ((result.product || result.direction) && !directions.has(result.direction))
    throw invalid('请选择有效的供货方向');
  if (result.direction && !result.product) throw invalid('请填写对应产品');
  if (body.category === 'assessment') {
    if (!Object.hasOwn(SUPPLEMENT_FACT_KINDS, body.dimension)) throw invalid('请选择评分维度');
    result.dimension = body.dimension;
    if (!Array.isArray(body.facts) || !body.facts.length || body.facts.length > 30)
      throw invalid('请填写 1 至 30 条已确认的评分事实');
    const seen = new Set();
    result.facts = body.facts.map((fact) => {
      if (
        !plainObject(fact) ||
        Object.keys(fact).some((key) => !['kind', 'value'].includes(key)) ||
        !SUPPLEMENT_FACT_KINDS[result.dimension].includes(fact.kind)
      )
        throw invalid('评分事实与所选维度不一致');
      const value = text(fact.value, '事实内容', 1000, true);
      if (fact.kind === 'company_since') validateSince(value, at);
      if (fact.kind === 'company_years' && (!/^\d{1,3}$/.test(value) || Number(value) >= 200))
        throw invalid('持续经营年数须为 0 至 199 的整数');
      const key = fact.kind + ':' + normalize(value);
      if (seen.has(key)) throw invalid('相同评分事实无需重复填写');
      seen.add(key);
      return { kind: fact.kind, value };
    });
  } else if (body.facts !== undefined || body.dimension !== undefined) {
    throw invalid('非评分资料不能携带评分事实');
  }
  if (body.category === 'purchase_need' && !result.sourceMessageId)
    throw invalid('采购需求需关联客户实际沟通记录');
  return result;
}

function opportunityKey(opportunity) {
  return opportunity.direction + '\n' + normalize(opportunity.product);
}

// All confirmations are replayed over the latest website facts. Older manual
// facts embedded in an assessment are removed first so a refresh/reassessment
// neither duplicates them nor silently promotes them to website evidence.
export function applySupplementsToResearch(research, confirmations = []) {
  const result = structuredClone(research);
  result.assessment_opportunities = (result.assessment_opportunities || []).map((opportunity) => ({
    ...opportunity,
    facts: (opportunity.facts || []).filter((fact) => fact.origin !== 'manual'),
  }));
  const byOpportunity = new Map(
    result.assessment_opportunities.map((opportunity) => [
      opportunityKey(opportunity),
      opportunity,
    ]),
  );
  const manual = new Map();
  for (const confirmation of confirmations) {
    if (confirmation.category !== 'assessment') continue;
    const key = opportunityKey(confirmation);
    const opportunity = byOpportunity.get(key);
    // Research may change the company's product line. Never carry a confirmed
    // role/capability across to a different product merely because it is newest.
    if (!opportunity) continue;
    for (const fact of confirmation.facts || []) {
      if (!SUPPLEMENT_FACT_KINDS[confirmation.dimension]?.includes(fact.kind)) continue;
      manual.set(key + '\n' + fact.kind + '\n' + normalize(fact.value), {
        opportunity,
        fact: {
          kind: fact.kind,
          value: fact.value,
          quote: confirmation.evidence,
          source_url: confirmation.sourceUrl || '',
          origin: 'manual',
          confirmationId: confirmation.id,
          confirmedBy: confirmation.confirmedBy,
          confirmedAt: confirmation.confirmedAt,
        },
      });
    }
  }
  for (const { opportunity, fact } of manual.values()) opportunity.facts.push(fact);
  return result;
}

export function assertSupplementScope(snapshot, confirmation) {
  if (confirmation?.category !== 'assessment') return;
  const opportunities = snapshot.opportunities?.length
    ? snapshot.opportunities
    : snapshot.direction && snapshot.product
      ? [{ direction: snapshot.direction, product: snapshot.product }]
      : [];
  if (
    !opportunities.some(
      (opportunity) => opportunityKey(opportunity) === opportunityKey(confirmation),
    )
  )
    throw invalid('对应产品已变化，请刷新档案并选择当前评估产品', 409);
}

export function recomputeFromSnapshot(
  snapshot,
  confirmations,
  { id, at = Date.now(), currentConfirmation = confirmations.at(-1) } = {},
) {
  if (!snapshot?.website || !snapshot?.target?.product)
    throw invalid('客户缺少可重算的评估资料，请先完成官网研究', 409);
  if (!id || !Number.isFinite(Number(at))) throw invalid('评估标识或时间不正确');
  const opportunities = snapshot.opportunities?.length
    ? snapshot.opportunities
    : snapshot.direction && snapshot.product
      ? [{ direction: snapshot.direction, product: snapshot.product, facts: [] }]
      : [];
  // Validate the submission being saved, while keeping older product-scoped
  // confirmations in the audit trail even if a newer website study dropped it.
  assertSupplementScope(snapshot, currentConfirmation);
  const research = applySupplementsToResearch(
    {
      source_url: snapshot.website,
      company_name: snapshot.companyName,
      entity_type: snapshot.entityType,
      facts: snapshot.facts || [],
      assessment_opportunities: opportunities,
      checked_urls: snapshot.checkedUrls || [],
      incomplete_reason: snapshot.incompleteReason || undefined,
      ...(snapshot.supplyOpportunity?.kind === 'potential_input'
        ? {
            product_relation: {
              kind: 'potential_input',
              basis_product: snapshot.supplyOpportunity.basisProduct,
            },
          }
        : {}),
    },
    confirmations,
  );
  const result = assessCompany({ research, target: snapshot.target, id, at });
  result.source = 'manual_supplement';
  result.manualConfirmationIds = confirmations.map((confirmation) => confirmation.id);
  result.reason = formatAssessmentReason(result);
  return result;
}
