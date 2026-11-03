import { buildAssessmentDimensions } from '../domain/assessment-dimensions.mjs';
import { directionLabels } from '../domain/acquisition-products.mjs';
import { formatBeijingText, formatBeijingTime } from '../domain/date-time.mjs';
import type {
  AssessmentFact,
  AssessmentOpportunity,
  AssessmentSummary,
} from '../services/customerAssessment';

export function evidenceUrl(value?: string) {
  try {
    const url = new URL(value || '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function opportunityAnalysis(opportunity: AssessmentOpportunity, facts: AssessmentFact[]) {
  const has = (...kinds: string[]) => facts.some((fact) => kinds.includes(fact.kind));
  if (
    Object.values(opportunity.dimensions || {}).some((d) => d.conflict) ||
    opportunity.missing?.some((item) => /冲突|不一致/.test(item))
  )
    return '此方向的依据仍有待核实事项，先解决相关冲突，再确定适合的供货切入点。';
  if (opportunity.status === '待核实')
    return '此方向的产品或经营角色尚未核实，先核对经营关联，再确定适合的供货切入点。';
  if (has('unrelated_product', 'no_supply_role') || opportunity.status === '暂不开发')
    return '现有产品或经营角色证据不支持此方向，当前不宜据此安排供货开发。';
  if (!has('core_product', 'secondary_product', 'adjacent_product'))
    return '当前记录尚缺少能说明产品与客户经营关联的逐条依据，可先核对产品范围。';
  if (opportunity.relationship === 'potential_input')
    return `客户已经营${opportunity.basisProduct || opportunity.product || '相关成品'}，可进一步询问是否需要${opportunity.targetProduct || '对应材料或配件'}。成品经营提供了业务切入点，具体外购安排、采购形态与规格仍需沟通确认。`;
  const product = opportunity.product || '相关产品';
  if (opportunity.direction === 'materials')
    return `客户已经营${product}相关材料或配件，存在同类产品供货关联，可围绕适用规格、采购形态与外部供货安排进一步沟通。`;
  if (opportunity.direction === 'samples')
    return `客户已有${product}相关样本或展示业务，可围绕产品展示用途探讨样本配套合作，具体形式与需求需在沟通中确认。`;
  return has('specialist_supply', 'general_supply')
    ? `客户已经营${product}，并具备对应产品的销售或供货角色，可围绕现有经营品类探讨成品供货合作，再确认采购形态、规格及合作方式。`
    : `客户已有${product}相关业务，可作为介绍该类产品的切入点；先核实其采购或供货角色，再判断合适的合作方式。`;
}

function Opportunity({
  opportunity,
  assessment,
}: {
  opportunity: AssessmentOpportunity;
  assessment: AssessmentSummary;
}) {
  const main =
    opportunity.direction === assessment.direction && opportunity.product === assessment.product;
  const dimensions = buildAssessmentDimensions({
    ...opportunity,
    dimensions: opportunity.dimensions || (main ? assessment.dimensions : undefined),
  });
  const facts = opportunity.facts?.length ? opportunity.facts : dimensions.flatMap((d) => d.facts);
  const reasons = dimensions
    .filter((d) => d.facts.length && !d.conflict)
    .sort((a, b) => ['P', 'R', 'V', 'D'].indexOf(a.key) - ['P', 'R', 'V', 'D'].indexOf(b.key))
    .slice(0, 3);
  const direction =
    opportunity.relationship === 'potential_input'
      ? '材料配件'
      : directionLabels[opportunity.direction as keyof typeof directionLabels] ||
        opportunity.direction ||
        '供货方向';
  const product = opportunity.targetProduct || opportunity.product || '产品待核实';
  return (
    <article className="profile-opportunity" aria-label={`供货机会：${direction} · ${product}`}>
      <div className="profile-opportunity-heading">
        <h4>
          {direction} · {product}
        </h4>
      </div>
      <p className="profile-opportunity-analysis">
        <strong>供货分析：</strong>
        {opportunityAnalysis(opportunity, facts)}
      </p>
      <ul className="profile-opportunity-reasons">
        {reasons.map((dimension) => (
          <li key={dimension.key}>
            <p>
              <strong>
                {['P', 'R'].includes(dimension.key) ? dimension.conclusion : '补充经营特征'}
              </strong>
              ：
              {formatBeijingText(
                dimension.facts
                  .slice(0, 2)
                  .map((f) => f.value)
                  .join('；'),
              )}
            </p>
            {dimension.facts
              .filter((fact) => fact.origin === 'manual')
              .map((fact, index) => (
                <small className="profile-manual-source" key={index}>
                  人工确认{fact.confirmedBy && ' · ' + fact.confirmedBy}
                  {fact.confirmedAt && ' · ' + formatBeijingTime(fact.confirmedAt)}
                </small>
              ))}
          </li>
        ))}
      </ul>
      {opportunity.missing
        ?.filter((item) => /冲突|强制|不一致|必需/.test(item))
        .map((item) => (
          <p className="profile-opportunity-limitation" key={item}>
            {item}
          </p>
        ))}
    </article>
  );
}

export function ProfileOpportunities({ assessment }: { assessment: AssessmentSummary }) {
  const opportunities: AssessmentOpportunity[] = assessment.opportunities?.length
    ? [...assessment.opportunities]
    : [assessment];
  const mainIndex = opportunities.findIndex(
    (o) => o.direction === assessment.direction && o.product === assessment.product,
  );
  if (mainIndex > 0) opportunities.unshift(...opportunities.splice(mainIndex, 1));
  if (mainIndex < 0 && assessment.product) opportunities.unshift(assessment);
  return (
    <div className="profile-opportunities">
      {opportunities.map((opportunity, index) =>
        index === 0 ? (
          <Opportunity
            key={`${opportunity.direction}-${opportunity.product}`}
            opportunity={{
              ...opportunity,
              dimensions:
                opportunity.dimensions ||
                (opportunity.product === assessment.product &&
                opportunity.direction === assessment.direction
                  ? assessment.dimensions
                  : undefined),
              targetProduct:
                opportunity.targetProduct ||
                (opportunity.relationship === 'potential_input'
                  ? assessment.supplyOpportunity?.targetProduct
                  : undefined),
            }}
            assessment={assessment}
          />
        ) : (
          <details
            className="profile-other-opportunity"
            key={`${opportunity.direction}-${opportunity.product}`}
          >
            <summary>
              {opportunity.relationship === 'potential_input'
                ? '材料配件'
                : directionLabels[opportunity.direction as keyof typeof directionLabels] ||
                  opportunity.direction}{' '}
              · {opportunity.targetProduct || opportunity.product}{' '}
              <span>
                {opportunity.grade || opportunity.status || '未评级'}
                {opportunity.matchLevel && ' · ' + opportunity.matchLevel}
              </span>
            </summary>
            <Opportunity opportunity={opportunity} assessment={assessment} />
          </details>
        ),
      )}
    </div>
  );
}

export function assessmentLimitations(assessment?: AssessmentSummary | null) {
  return [
    ...new Set(
      [
        assessment?.incompleteReason || '',
        ...(assessment?.evidenceReason || '')
          .split('\n')
          .filter((line) => /^(?:本轮)?研究限制[:：]/.test(line))
          .map((line) => line.replace(/^(?:本轮)?研究限制[:：]\s*/, '')),
      ]
        .flatMap((value) => value.split(/[；;]/))
        .map((value) =>
          /^(?:本次仅按新规则重算|仅用已保存事实按)/.test(value)
            ? '沿用已有官网证据重算，本次未重新抓取官网。'
            : value.trim(),
        )
        .filter(Boolean),
    ),
  ];
}

export function InitialAssessmentRecord({ assessment }: { assessment?: AssessmentSummary | null }) {
  if (!assessment) return null;
  return (
    <details className="profile-more-details profile-assessment-record">
      <summary>初评记录</summary>
      <p>
        评估编号：{assessment.id} · 规则版本：{assessment.ruleVersion}
      </p>
      {assessmentLimitations(assessment).map((item) => (
        <p key={item}>研究限制：{formatBeijingText(item)}</p>
      ))}
      {assessment.evidenceReason && <pre>{formatBeijingText(assessment.evidenceReason)}</pre>}
    </details>
  );
}
