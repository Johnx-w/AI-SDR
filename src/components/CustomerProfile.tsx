import { ArrowUpRight } from 'lucide-react';
import { Badge } from './ui';
import { formatBeijingText, formatBeijingTime } from '../domain/date-time.mjs';
import type { AssessmentSummary } from './AssessmentPanel';
import type { ManualConfirmation, SupplementContext } from '../services/leadSupplements';
import './CustomerProfile.css';

interface ProfileLead {
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
  advertisingCodes?: string;
  source: string;
  updatedAt: string | number | null;
  assessment?: AssessmentSummary | null;
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
  onAssessment,
  onSupplement,
}: {
  lead: ProfileLead;
  typeLabel: string;
  onAssessment: () => void;
  onSupplement?: (context: SupplementContext) => void;
}) {
  const overview = [lead.mainProductPreference, lead.evidence, lead.industryProfile].find(
    (value) => value && meaningful(value),
  );
  const fullDescription = businessLines(overview)[0] || '企业概况待补充';
  const description =
    fullDescription.length > 140 ? fullDescription.slice(0, 140) + '…' : fullDescription;
  const products = lines(lead.product);
  const opportunities = businessLines(lead.supplyOpportunity).map((line) =>
    line.replace(/（潜在供货机会）|\(潜在供货机会\)/g, '').replace(/[，,]潜在供货机会/g, ''),
  );
  const demand = businessLines(lead.demandProducts).filter((line) => meaningful(line));
  const pending = [
    ...new Set(
      [
        ...(lead.assessment?.missing || []),
        ...Object.values(lead.assessment?.dimensions || {}).flatMap((dimension) =>
          dimension.missing ? [dimension.missing] : [],
        ),
        ...businessLines(
          (lead.pendingQuestions || '').replace(/(?:本轮)?研究限制[:：][\s\S]*$/, ''),
        ).flatMap((line) => line.split(/[；;]/)),
        ...(!lead.companyIdentity?.legal_name ||
        lead.companyIdentity?.status === 'legal_name_self_reported'
          ? ['经营法人名称待核实']
          : []),
        ...(!demand.length && !lead.manualPurchaseNeed ? ['具体采购需求待确认'] : []),
      ]
        .map((item) => item.trim())
        .filter((item) => item && !/^(暂无已记录的待确认事项|暂无|无)$/.test(item)),
    ),
  ].filter((item) => {
    // Confirming a free-form note cannot resolve an unfilled score dimension.
    if (
      Object.values(lead.assessment?.dimensions || {}).some(
        (dimension) => dimension.missing === item,
      )
    )
      return true;
    if (
      /经营法人名称待核实/.test(item) &&
      lead.companyIdentity?.status === 'legal_name_manual_confirmed'
    )
      return false;
    if (/具体采购需求待确认/.test(item) && lead.manualPurchaseNeed) return false;
    return !lead.confirmations?.some(
      (confirmation) => confirmation.category === 'profile' && confirmation.pendingItem === item,
    );
  });
  const supplementContext = (item: string): SupplementContext => {
    const dimension = Object.entries(lead.assessment?.dimensions || {}).find(
      ([, value]) => value.missing === item,
    )?.[0];
    if (dimension && ['P', 'R', 'D', 'V'].includes(dimension))
      return {
        category: 'assessment',
        dimension: dimension as 'P' | 'R' | 'D' | 'V',
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
    ...(lead.source ? [['发现来源', lead.source]] : []),
    ...(lead.advertisingCodes ? [['广告代码', lead.advertisingCodes]] : []),
  ];
  const priority: Record<string, string> = { A: '优先开发', B: '可开发', C: '较低优先级' };
  const audience =
    (
      { B: '企业客户', C: '个人客户', BC: '企业与个人客户', 'B+C': '企业与个人客户' } as Record<
        string,
        string
      >
    )[lead.audience || ''] || lead.audience;
  return (
    <section className="customer-profile" aria-label="客户概览">
      <div className="profile-overview">
        <div className="profile-overview-heading">
          <div className="profile-priority">
            <Badge tone={lead.grade === 'A' ? 'green' : 'neutral'}>
              {lead.grade}
              {priority[lead.grade] ? ' · ' + priority[lead.grade] : ''}
            </Badge>
            {lead.score !== null && <span>已支持 {lead.score}/100</span>}
          </div>
          <div className="profile-actions">
            {onSupplement && (
              <button className="text-link" onClick={() => onSupplement({ category: 'profile' })}>
                补充资料
              </button>
            )}
            <button className="text-link" onClick={onAssessment}>
              查看完整评估 <ArrowUpRight size={13} />
            </button>
          </div>
        </div>
        <p className="profile-introduction">{formatBeijingText(description)}</p>
        <dl className="profile-facts">
          <div>
            <dt>客户类型</dt>
            <dd>{typeLabel}</dd>
          </div>
          {lead.serviceAreas && (
            <div>
              <dt>服务地区</dt>
              <dd>{lead.serviceAreas}</dd>
            </div>
          )}
          {audience && (
            <div>
              <dt>服务客群</dt>
              <dd>{audience}</dd>
            </div>
          )}
          <div>
            <dt>开发状态</dt>
            <dd>{lead.status}</dd>
          </div>
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
          <p className="profile-empty">主营产品待补充</p>
        )}
      </section>
      <div className="profile-business-grid">
        <section className="profile-business-card" aria-label="潜在供货机会">
          <h3>潜在供货机会</h3>
          {opportunities.length ? (
            <ul>
              {opportunities.map((item) => (
                <li key={item}>{formatBeijingText(item)}</li>
              ))}
            </ul>
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
        <section className="profile-business-card profile-pending" aria-label="待确认">
          <h3>待确认</h3>
          {pending.length ? (
            <ul>
              {pending.map((item) => (
                <li key={item}>
                  <span>{formatBeijingText(item)}</span>
                  {onSupplement && (
                    <button
                      className="text-link profile-supplement-link"
                      onClick={() => onSupplement(supplementContext(item))}
                      aria-label={'补充资料：' + item}
                    >
                      补充资料
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="profile-empty">暂无已记录的待确认事项</p>
          )}
        </section>
      </div>
      <div className="profile-updated" aria-label="资料与评估时间">
        <span>官网取证：{formatBeijingTime(lead.updatedAt, '时间未记录')}</span>
        <span>评估更新：{formatBeijingTime(lead.assessment?.evaluatedAt, '尚未评估')}</span>
      </div>
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
              {confirmation.sourceUrl && /^https?:\/\//i.test(confirmation.sourceUrl) && (
                <p>
                  <a href={confirmation.sourceUrl} target="_blank" rel="noopener noreferrer">
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
          {lead.industryProfile && (
            <div>
              <dt>客户行业画像</dt>
              <dd>{formatBeijingText(lead.industryProfile)}</dd>
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
    </section>
  );
}
