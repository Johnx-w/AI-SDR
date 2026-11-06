import { ArrowUpRight } from 'lucide-react';
import { Badge } from './ui';
import { formatBeijingText, formatBeijingTime } from '../domain/date-time.mjs';
import type { AssessmentSummary } from '../services/customerAssessment';
import {
  ProfileOpportunities,
  InitialAssessmentRecord,
  assessmentLimitations,
  evidenceUrl,
} from './ProfileOpportunities';
import type { ManualConfirmation, SupplementContext } from '../services/leadSupplements';
import './CustomerProfile.css';

interface ProfileLead {
  id?: string;
  name: string;
  grade: string;
  score: number | null;
  type: string;
  product: string;
  status: string;
  companyIdentity?: {
    legal_name: string | null;
    website_name: string | null;
    aliases: string[];
    status?: string;
    notes?: string[];
  } | null;
  mainProductPreference?: string;
  industryProfile?: string;
  evidence: string;
  supplyOpportunity?: string;
  demandProducts?: string;
  pendingQuestions?: string;
  serviceAreas?: string;
  address?: string;
  audience?: string;
  source: string;
  updatedAt: string | number | null;
  assessment?: AssessmentSummary | null;
  ratingReason?: string;
  confirmations?: ManualConfirmation[];
  manualPurchaseNeed?: string;
}
const lines = (value = '') => [
  ...new Set(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];
const businessLines = (value = '') =>
  lines(value).filter(
    (line) =>
      !/^(依据|原文|来源|研究限制|本轮研究限制|规则版本|评估时间)[:：]|^\[自动评估|^https?:\/\//.test(
        line,
      ),
  );
const meaningful = (value = '') =>
  value && !/^(尚无|尚未|暂无|未提供|待核实|待确认|未确认|未发现)/.test(value);
const identityKey = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');

export function CustomerProfile({
  lead,
  typeLabel,
  onSupplement,
}: {
  lead: ProfileLead;
  typeLabel: string;
  onSupplement?: (context: SupplementContext) => void;
}) {
  if (lead.assessment && lead.assessment.ruleVersion !== 'acquisition-v5.0')
    lead = { ...lead, assessment: null };
  const overview = [lead.mainProductPreference, lead.evidence, lead.industryProfile].find(
    (value) => value && meaningful(value),
  );
  const fullDescription = businessLines(overview)[0] || '尚无已核实企业概况';
  const description =
    fullDescription.length > 140 ? fullDescription.slice(0, 140) + '…' : fullDescription;
  const products = lines(lead.product);
  const opportunities = businessLines(lead.supplyOpportunity).map((line) =>
    line.replace(/（潜在供货机会）|\(潜在供货机会\)/g, '').replace(/[，,]潜在供货机会/g, ''),
  );
  const demand = businessLines(lead.demandProducts).filter((line) => meaningful(line));
  const industryProfile = lines(lead.industryProfile)
    .filter((line) => !/^来源[:：]/.test(line))
    .join('\n');
  const scopedDimensions = [lead.assessment, ...(lead.assessment?.opportunities || [])].flatMap(
    (opportunity) =>
      Object.entries(opportunity?.dimensions || {}).map(([key, dimension]) => ({
        key,
        dimension,
        opportunity,
      })),
  );
  const needsReview = (item: string) => /冲突|强制|不一致|必需/.test(item);
  const pending = [
    ...new Set(
      [
        ...[
          ...(lead.assessment?.missing || []),
          ...(lead.assessment?.opportunities || []).flatMap((o) => o.missing || []),
        ].filter(needsReview),
        ...scopedDimensions.flatMap(({ dimension }) =>
          dimension.conflict ? [dimension.missing || '经营事实存在冲突'] : [],
        ),
        ...businessLines(lead.pendingQuestions)
          .flatMap((line) => line.split(/[；;]/))
          .filter(needsReview),
      ]
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  const supplementContext = (item: string): SupplementContext => {
    const match = scopedDimensions.find(
      ({ dimension }) => dimension.conflict && dimension.missing === item,
    );
    if (match && ['P', 'R', 'D', 'V'].includes(match.key))
      return {
        category: 'assessment',
        dimension: match.key as 'P' | 'R' | 'D' | 'V',
        product: match.opportunity?.product,
        direction: match.opportunity?.direction,
        pendingItem: item,
      };
    if (/经营法人名称/.test(item)) return { category: 'legal_name', pendingItem: item };
    if (/采购需求|采购方式/.test(item))
      return {
        category: 'purchase_need',
        pendingItem: item,
        ...(item === lead.assessment?.supplyOpportunity?.note &&
        lead.assessment.supplyOpportunity.targetProduct
          ? { product: lead.assessment.supplyOpportunity.targetProduct, direction: 'materials' }
          : {}),
      };
    return { category: 'profile', pendingItem: item };
  };
  const aliases = [
    ...new Set(
      [lead.companyIdentity?.website_name, ...(lead.companyIdentity?.aliases || [])].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ].filter((value) => identityKey(value) !== identityKey(lead.name));
  const extra = [
    ...(description !== fullDescription ? [['完整企业概况', fullDescription]] : []),
    ...(aliases.length ? [['官网名称／别名', aliases.join('、')]] : []),
    ...(lead.companyIdentity?.legal_name
      ? [
          [
            '经营法人名称',
            lead.companyIdentity.legal_name +
              (lead.companyIdentity.status === 'legal_name_self_reported'
                ? '（官网自述）'
                : lead.companyIdentity.status === 'legal_name_manual_confirmed'
                  ? '（人工确认）'
                  : ''),
          ],
        ]
      : []),
    ...(lead.address ? [['企业实际地址', lead.address]] : []),
    ...(lead.serviceAreas ? [['服务地区', lead.serviceAreas]] : []),
    ...(lead.source ? [['发现来源', lead.source]] : []),
  ];
  const audience =
    (
      { B: '企业客户', C: '个人客户', BC: '企业与个人客户', 'B+C': '企业与个人客户' } as Record<
        string,
        string
      >
    )[lead.audience || ''] || lead.audience;
  return (
    <section className="customer-profile" aria-label="客户概览">
      {!!pending.length && (
        <section className="profile-business-card profile-pending" aria-label="需核实事项">
          <h3>需核实事项</h3>
          <p>经营事实存在冲突，自动首封暂不可发送，请先核实。</p>
          <ul>
            {pending.map((item) => (
              <li key={item}>
                <span>{formatBeijingText(item)}</span>
                {onSupplement && (
                  <button
                    className="text-link profile-supplement-link"
                    onClick={() => onSupplement(supplementContext(item))}
                    aria-label={'核实事项：' + item}
                  >
                    核实依据
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="profile-overview">
        <div className="profile-overview-heading">
          <h3>企业概况</h3>
          {onSupplement && (
            <button className="text-link" onClick={() => onSupplement({ category: 'profile' })}>
              记录已核实信息
            </button>
          )}
        </div>
        <p className="profile-introduction">{formatBeijingText(description)}</p>
        <dl className="profile-facts">
          <div>
            <dt>客户类型</dt>
            <dd>{typeLabel}</dd>
          </div>
          {audience && (
            <div>
              <dt>服务客群</dt>
              <dd>{audience}</dd>
            </div>
          )}
        </dl>
      </div>
      <section className="profile-products" aria-label="主营产品">
        <h3>主营产品</h3>
        {products.length ? (
          <>
            <div className="profile-product-tags">
              {products.slice(0, 6).map((product) => (
                <span key={product}>{product}</span>
              ))}
            </div>
            {products.length > 6 && (
              <details className="profile-more-products">
                <summary>其余 {products.length - 6} 项产品</summary>
                <div className="profile-product-tags">
                  {products.slice(6).map((product) => (
                    <span key={product}>{product}</span>
                  ))}
                </div>
              </details>
            )}
          </>
        ) : (
          <p className="profile-empty">尚无已核实产品</p>
        )}
      </section>
      <section
        id="profile-opportunities"
        tabIndex={-1}
        className="profile-business-card"
        aria-label="潜在供货机会"
      >
        <h3>潜在供货机会</h3>
        {!lead.assessment && (
          <p>
            <Badge>{lead.grade}</Badge>
          </p>
        )}
        {lead.assessment?.manualOverride && (
          <p className="profile-manual-priority">
            <Badge>{lead.grade} · 人工调整</Badge>
            客户优先级已人工调整；以下自动评估依据仍保留供核对。
          </p>
        )}
        {assessmentLimitations(lead.assessment)
          .filter((text) => /失败|无法|未完成|不完整|冲突|截断/.test(text))
          .map((text) => (
            <p key={text} className="profile-opportunity-limitation">
              研究限制：{formatBeijingText(text)}
            </p>
          ))}
        {lead.assessment ? (
          <ProfileOpportunities assessment={lead.assessment} />
        ) : opportunities.length ? (
          <>
            <ul>
              {opportunities.map((item) => (
                <li key={item}>{formatBeijingText(item)}</li>
              ))}
            </ul>
            <p className="profile-empty">当前仅有机会摘要，逐条经营依据尚未记录。</p>
          </>
        ) : (
          <p className="profile-empty">尚无已记录的供货机会</p>
        )}
        {demand.length > 0 && (
          <div className="profile-public-demand">
            <h4>公开采购需求</h4>
            <p>{formatBeijingText(demand.join('；'))}</p>
          </div>
        )}
        {lead.manualPurchaseNeed && (
          <div className="profile-public-demand">
            <h4>
              已确认采购需求 <small>人工确认</small>
            </h4>
            <p>{formatBeijingText(lead.manualPurchaseNeed)}</p>
          </div>
        )}
      </section>

      {!!lead.confirmations?.length && (
        <details className="profile-more-details profile-confirmations">
          <summary>人工确认记录（{lead.confirmations.length} 条）</summary>
          {lead.confirmations.map((confirmation) => (
            <article key={confirmation.id}>
              <strong>{formatBeijingText(confirmation.content)}</strong>
              {confirmation.product && (
                <p>
                  对应产品：
                  {(
                    { finished: '成品', materials: '材料配件', samples: '样本展示' } as Record<
                      string,
                      string
                    >
                  )[confirmation.direction || ''] || confirmation.direction}{' '}
                  · {confirmation.product}
                </p>
              )}
              <p className="profile-confirmation-evidence">
                依据：{formatBeijingText(confirmation.evidence)}
              </p>
              {evidenceUrl(confirmation.sourceUrl) && (
                <p>
                  <a
                    href={evidenceUrl(confirmation.sourceUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    查看来源 <ArrowUpRight size={12} />
                  </a>
                </p>
              )}
              <small>
                {confirmation.confirmedBy} · {formatBeijingTime(confirmation.confirmedAt)}
              </small>
            </article>
          ))}
        </details>
      )}
      <details className="profile-more-details">
        <summary>更多企业资料</summary>
        <dl className="profile-extra-fields">
          {extra.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{formatBeijingText(value)}</dd>
            </div>
          ))}
          {industryProfile && (
            <div>
              <dt>客户行业画像</dt>
              <dd>{formatBeijingText(industryProfile)}</dd>
            </div>
          )}
          {!!lead.companyIdentity?.notes?.length && (
            <div>
              <dt>名称核验记录</dt>
              <dd>{formatBeijingText(lead.companyIdentity.notes.join('\n'))}</dd>
            </div>
          )}
        </dl>
      </details>
      <div className="profile-updated" aria-label="资料与评估时间">
        <span>官网取证：{formatBeijingTime(lead.updatedAt, '时间未记录')}</span>
        <span>评估更新：{formatBeijingTime(lead.assessment?.evaluatedAt, '尚未评估')}</span>
      </div>
      <InitialAssessmentRecord assessment={lead.assessment} />
    </section>
  );
}
