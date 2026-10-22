import { createHash } from 'node:crypto';
import { domainKey } from './website-identity.mjs';

export const ASSESSMENT_RULE_VERSION = 'acquisition-v2.1';
export const directionNames = { finished: '成品', materials: '材料配件', samples: '样本展示' };
export const ASSESSMENT_HISTORY_FORMAT = 'evidence-v1';
export function assessmentRating(snapshot) {
  return (
    snapshot.grade ||
    (['待核实', '待补全', '暂不开发'].includes(snapshot.status) ? snapshot.status : '待核实')
  );
}
const labels = {
  P: '产品契合',
  R: '采购角色',
  D: '持续经营',
  V: '供货能力需求',
  I: '海关采购表现',
};
const maximums = { P: 35, R: 25, D: 15, V: 10, I: 15 };
const compact = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const group = (score, facts, missing = '') => ({ score, maximum: 0, facts, missing });

export function assessmentId(scope, operationId) {
  return (
    'ev_' +
    createHash('sha256')
      .update(JSON.stringify([scope, operationId, ASSESSMENT_RULE_VERSION]))
      .digest('hex')
      .slice(0, 36)
  );
}

function dimensionScore(opportunity, at) {
  const facts = opportunity.facts || [];
  const of = (...kinds) => facts.filter((f) => kinds.includes(f.kind));
  const best = (tiers, missing) => {
    for (const [kind, score] of tiers) if (of(kind).length) return group(score, of(kind));
    return group(null, [], missing);
  };
  const P = best(
    [
      ['core_product', 35],
      ['secondary_product', 25],
      ['adjacent_product', 10],
      ['unrelated_product', 0],
    ],
    '产品主营/副线关联资料不足',
  );
  const R = best(
    [
      ['specialist_supply', 25],
      ['general_supply', 20],
      ['installation_only', 10],
      ['no_supply_role', 0],
    ],
    '是否承担该品类供货尚待核实',
  );
  const productConflict =
    (of('unrelated_product').length &&
      of('core_product', 'secondary_product', 'adjacent_product').length) ||
    (of('adjacent_product').length && of('core_product', 'secondary_product').length);
  const roleConflict =
    (of('no_supply_role').length &&
      of('specialist_supply', 'general_supply', 'installation_only').length) ||
    (of('installation_only').length && of('specialist_supply', 'general_supply').length);
  if (productConflict)
    Object.assign(
      P,
      { conflict: true },
      group(
        null,
        of('core_product', 'secondary_product', 'adjacent_product', 'unrelated_product'),
        '同一产品的经营事实相互冲突，需核实',
      ),
    );
  if (roleConflict)
    Object.assign(
      R,
      { conflict: true },
      group(
        null,
        of('specialist_supply', 'general_supply', 'installation_only', 'no_supply_role'),
        '同一产品的供货角色相互冲突，需核实',
      ),
    );
  const D = group(null, [], '持续经营或当前供货流程资料不足');
  const current = of('current_supply_process');
  if (current.length) {
    const distinct = (kinds) => {
      const byName = new Map();
      for (const fact of of(...kinds)) if (fact.value) byName.set(compact(fact.value), fact);
      return [...byName.values()];
    };
    const outlets = distinct(['operating_outlet']);
    const dealers = distinct(['active_dealer']);
    const commercial = distinct(['completed_commercial_project']);
    const projects = distinct(['completed_project', 'completed_commercial_project']);
    const since = of('company_since').filter((f) => {
      // A year without month/day is only certain by its latest possible anniversary.
      const value = /^\d{4}$/.test(f.value) ? f.value + '-12-31' : f.value;
      const date = new Date(value + 'T00:00:00Z');
      if (!Number.isFinite(date.getTime()) || date.getTime() > at) return false;
      date.setUTCFullYear(date.getUTCFullYear() + 5);
      return date.getTime() <= at;
    });
    const years = of('company_years').filter((f) => Number(f.value) >= 5 && Number(f.value) < 200);
    if (outlets.length >= 5 || dealers.length >= 10 || commercial.length >= 3) {
      D.score = 15;
      D.facts = [
        ...current,
        ...(outlets.length >= 5 ? outlets : dealers.length >= 10 ? dealers : commercial),
      ];
    } else if (since.length || years.length || projects.length >= 2) {
      D.score = 10;
      D.facts = [...current, ...(since.length ? since : years.length ? years : projects)];
    } else {
      D.score = 5;
      D.facts = current;
    }
    D.missing = '';
  }
  const custom = of('custom_made');
  const advanced = of('motorized_system', 'commercial_specification');
  const V = group(
    custom.length || advanced.length ? (custom.length ? 5 : 0) + (advanced.length ? 5 : 0) : null,
    [...custom, ...advanced],
    custom.length || advanced.length ? '' : '定制/电动或工程配套特征尚未取得依据',
  );
  // File import is a separate module. Public webpages and query terms never supply customs points.
  const I = group(null, [], '海关数据尚未接入或未关联，不代表没有进口');
  I.components = { scale: null, frequency: null, recency: null };
  const dimensions = { P, R, D, V, I };
  for (const [key, dimension] of Object.entries(dimensions)) dimension.maximum = maximums[key];
  return dimensions;
}

function gradeOpportunity(opportunity, dimensions, research) {
  const { P, R, D } = dimensions;
  const supported = Object.values(dimensions).reduce((sum, d) => sum + (d.score ?? 0), 0);
  const has = (...kinds) => (opportunity.facts || []).some((f) => kinds.includes(f.kind));
  let grade = null,
    status;
  if (P.conflict || R.conflict || has('identity_conflict', 'mandatory_requirement'))
    status = '待核实';
  else if (research.entity_type === 'individual' || P.score === 0 || R.score === 0)
    status = '暂不开发';
  else if (research.entity_type !== 'business') status = '待核实';
  else if (P.score === null || R.score === null) status = '待核实';
  else if (P.score < 25 || R.score < 20) {
    grade = 'C';
    status = '暂缓开发';
  } else if (D.score === null) status = '待补全';
  else if (supported >= 75) {
    grade = 'A';
    status = '优先开发';
  } else if (supported >= 60) {
    grade = 'B';
    status = '可开发';
  } else {
    grade = 'C';
    status = '暂缓开发';
  }
  return { grade, status, score: supported };
}

export function assessCompany({ research, target, at = Date.now(), id }) {
  const opportunities = (research.assessment_opportunities || []).map((opportunity) => {
    const dimensions = dimensionScore(opportunity, at);
    const result = gradeOpportunity(opportunity, dimensions, research);
    const missing = Object.values(dimensions)
      .filter((d) => d.missing)
      .map((d) => d.missing);
    if (research.entity_type !== 'business') missing.unshift('经营主体尚未核实');
    const requirements = (opportunity.facts || []).filter((f) =>
      ['identity_conflict', 'mandatory_requirement'].includes(f.kind),
    );
    return {
      ...opportunity,
      ...result,
      dimensions,
      missing,
      requirements,
      complete: Object.values(dimensions).every((d) => d.score !== null),
    };
  });
  // Invalid/blocked directions never outrank an eligible A/B opportunity at this enterprise.
  const rank = (o) =>
    o.grade === 'A'
      ? 4
      : o.grade === 'B'
        ? 3
        : o.grade === 'C'
          ? 2
          : o.status === '暂不开发'
            ? 0
            : 1;
  opportunities.sort((a, b) => rank(b) - rank(a) || b.score - a.score);
  const best = opportunities[0];
  const snapshot = {
    id,
    ruleVersion: ASSESSMENT_RULE_VERSION,
    evaluatedAt: new Date(at).toISOString(),
    source: research.incomplete_reason ? 'research_incomplete' : 'verified_website_research',
    website: research.source_url,
    companyName: research.company_name,
    target: { product: target.product, country: target.country },
    grade: best?.grade || null,
    status: best?.status || (research.entity_type === 'individual' ? '暂不开发' : '待核实'),
    score: best?.score ?? 0,
    complete: best?.complete || false,
    direction: best?.direction || null,
    product: best?.product || target.product,
    dimensions:
      best?.dimensions ||
      Object.fromEntries(
        Object.entries(maximums).map(([key, maximum]) => [
          key,
          {
            score: null,
            maximum,
            facts: [],
            missing:
              key === 'I' ? '海关数据尚未接入或未关联' : '本轮未取得可用于规则评分的结构化证据',
          },
        ]),
      ),
    missing: best?.missing || ['本轮未取得对应产品的可验证评分事实', '海关数据尚未接入或未关联'],
    opportunities,
    facts: research.facts || [],
    entityType: research.entity_type,
    checkedUrls: research.checked_urls || [],
    assumed: false,
    incompleteReason: research.incomplete_reason || null,
  };
  snapshot.reason = formatAssessmentReason(snapshot);
  return snapshot;
}

export function formatAssessmentReason(snapshot) {
  const lines = [
    '[自动评估 ' + snapshot.id + ']',
    '规则版本：' + snapshot.ruleVersion,
    '评估时间：' + snapshot.evaluatedAt,
    '拟供方向：' + (directionNames[snapshot.direction] || '待核实') + ' · ' + snapshot.product,
    '用户评级：' + assessmentRating(snapshot) + '；' + snapshot.status,
    '已支持分数：' +
      snapshot.score +
      '/100；' +
      (snapshot.complete ? '资料完整' : '部分数据缺失，未按比例补满'),
    ...Object.entries(snapshot.dimensions).map(
      ([key, d]) =>
        key + ' ' + labels[key] + '：' + (d.score === null ? '未知' : d.score) + '/' + d.maximum,
    ),
    '海关：规模5/频率6/新近性4；当前未接入或未关联，不假设15分。',
  ];
  if (snapshot.incompleteReason) lines.push('本轮研究限制：' + snapshot.incompleteReason);
  if (snapshot.missing.length) lines.push('待补充：' + snapshot.missing.join('；'));
  const facts = snapshot.opportunities[0]?.facts || [];
  const used = new Set();
  for (const fact of facts) {
    const key = fact.source_url + '\n' + fact.quote;
    if (used.has(key)) continue;
    used.add(key);
    lines.push('依据：' + fact.quote + '\n来源：' + fact.source_url);
    if (used.size >= 18) break;
  }
  if (snapshot.opportunities.length > 1) {
    lines.push('其他方向（不与主方向拼分）：');
    for (const other of snapshot.opportunities.slice(1))
      lines.push(
        (directionNames[other.direction] || other.direction) +
          ' · ' +
          other.product +
          '：' +
          (other.grade || other.status) +
          '，已支持' +
          other.score +
          '分',
      );
  }
  return lines.join('\n');
}

export function formatAssessmentEvidence(snapshot) {
  const factLabels = {
    core_product: '主营产品',
    secondary_product: '明确经营品类',
    adjacent_product: '邻近品类',
    unrelated_product: '不匹配依据',
    specialist_supply: '专业供货角色',
    general_supply: '综合供货角色',
    installation_only: '仅安装服务',
    no_supply_role: '无适用采购角色',
    current_supply_process: '当前供货流程',
    custom_made: '定制能力需求',
    motorized_system: '电动系统需求',
    commercial_specification: '工程规格需求',
    company_since: '企业经营起始',
    company_years: '企业持续经营',
    operating_outlet: '现营网点',
    active_dealer: '实际经销商',
    completed_project: '已交付项目',
    completed_commercial_project: '已交付商业项目',
    identity_conflict: '主体冲突',
    mandatory_requirement: '强制条件',
  };
  const lines = [];
  if (snapshot.incompleteReason) lines.push('研究限制：' + snapshot.incompleteReason);
  const seen = new Set();
  for (const opportunity of snapshot.opportunities || []) {
    lines.push(
      (directionNames[opportunity.direction] || opportunity.direction) +
        ' · ' +
        opportunity.product,
    );
    for (const fact of opportunity.facts || []) {
      const key = fact.kind + '\n' + fact.source_url + '\n' + fact.quote;
      if (seen.has(key) || seen.size >= 30) continue;
      seen.add(key);
      lines.push(
        (factLabels[fact.kind] || '业务事实') + '：' + fact.value,
        '原文：' + fact.quote,
        '来源：' + fact.source_url,
      );
    }
  }
  if (!seen.size) lines.push('本轮未取得足以确定产品契合和供货角色的可验证依据。');
  if (snapshot.missing?.length)
    lines.push('待补充依据：' + [...new Set(snapshot.missing)].join('；'));
  return lines.join('\n');
}

export function readAssessmentSummary(value) {
  const reason = String(value || '');
  const id = reason.match(/^\[自动评估 (ev_[a-f0-9]{36})\]/)?.[1];
  if (!id) return null;
  const score = Number(reason.match(/(?:^|\n)已支持分数：(\d+)\/100；/)?.[1]);
  const ruleVersion = reason.match(/(?:^|\n)规则版本：([^\n]+)/)?.[1];
  const evaluatedAt = reason.match(/(?:^|\n)评估时间：([^\n]+)/)?.[1];
  if (!Number.isFinite(score) || score < 0 || score > 100 || !ruleVersion) return null;
  return {
    id,
    score,
    ruleVersion,
    evaluatedAt,
    complete: reason.includes('；资料完整'),
    assumed: false,
  };
}

export function assertAssessmentIdentity(snapshot, record) {
  const expected = domainKey(snapshot.website);
  const actual = domainKey(record.fields?.['来源链接']?.[0]?.text || record.fields?.['来源链接']);
  if (!snapshot.id || snapshot.assumed || !expected || !actual || expected !== actual)
    throw Object.assign(new Error('评估与客户官网主体不一致，停止同步'), { status: 409 });
}
