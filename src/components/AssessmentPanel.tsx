import { Fragment } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Badge } from './ui';
import { formatBeijingText, formatBeijingTime } from '../domain/date-time.mjs';
import { buildAssessmentDimensions } from '../domain/assessment-dimensions.mjs';
import type { SupplementContext } from '../services/leadSupplements';
import './AssessmentPanel.css';

type Dimension = {
  score: number | null;
  maximum: number;
  missing?: string;
  conflict?: boolean;
  facts?: {
    kind: string;
    value: string;
    quote: string;
    source_url: string;
    origin?: string;
    confirmationId?: string;
    confirmedBy?: string;
    confirmedAt?: string;
  }[];
};
export interface AssessmentSummary {
  id: string;
  score: number;
  grade?: string | null;
  status?: string;
  complete: boolean;
  ruleVersion: string;
  evaluatedAt?: string;
  product?: string;
  direction?: string;
  evidenceReason?: string;
  incompleteReason?: string | null;
  dimensions?: Record<string, Dimension>;
  missing?: string[];
  manualOverride?: boolean;
  opportunities?: { direction: string; product: string; facts?: Dimension['facts'] }[];
  supplyOpportunity?: { targetProduct?: string; procurementStatus?: string; note?: string } | null;
}
interface Props {
  assessment?: AssessmentSummary | null;
  ratingReason?: string;
  researchAt?: string | number | null;
  onSupplement?: (context: SupplementContext) => void;
}
function evidenceUrl(value?: string | null) {
  try {
    const url = new URL(value || '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function assessmentPresentation(
  assessment: AssessmentSummary | null | undefined,
  ratingReason: string,
) {
  const original = assessment?.evidenceReason || ratingReason;
  const lines = original
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const technical =
    /^(?:\[自动评估(?:\s|\])|自动评估编号[:：]|规则版本[:：]|评估时间[:：]|评级口径[:：])/;
  const limitations = [
    ...new Set(
      [
        assessment?.incompleteReason || '',
        ...lines
          .filter((line) => /^(?:本轮)?研究限制[:：]/.test(line))
          .map((line) => line.replace(/^(?:本轮)?研究限制[:：]\s*/, '')),
      ]
        .flatMap((text) => text.split(/[；;]/))
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) =>
          /^(?:本次仅按新规则重算|仅用已保存事实按)/.test(text)
            ? '沿用已有官网证据重算，本次未重新抓取官网。'
            : text,
        ),
    ),
  ];
  const pending = [
    ...new Set(
      [
        ...(assessment?.missing || []),
        ...lines
          .filter((line) => /^待补充(?:依据)?[:：]/.test(line))
          .map((line) => line.replace(/^待补充(?:依据)?[:：]\s*/, '')),
      ]
        .flatMap((text) => text.split(/[；;]/))
        .map((text) => text.trim())
        .filter(Boolean),
    ),
  ];
  const evidence = lines
    .filter(
      (line) => !technical.test(line) && !/^(?:(?:本轮)?研究限制|待补充(?:依据)?)[:：]/.test(line),
    )
    .join('\n');
  const fullRecord = lines.filter((line) => !technical.test(line)).join('\n');
  const businessRecord = ratingReason
    .split('\n')
    .filter((line) => !technical.test(line.trim()))
    .join('\n')
    .trim();
  const supplementalRecord =
    assessment?.evidenceReason && businessRecord && businessRecord !== evidence
      ? businessRecord
      : '';
  return { evidence, limitations, pending, fullRecord, original, supplementalRecord };
}

function AssessmentRecord({ text }: { text: string }) {
  return (
    <pre className="assessment-full-record">
      {text.split('\n').map((line, index) => {
        const source = line.match(/^来源[:：]\s*(\S+)\s*$/)?.[1];
        const url = source && evidenceUrl(source);
        return (
          <Fragment key={index}>
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                来源：{source} <ArrowUpRight size={12} />
              </a>
            ) : (
              formatBeijingText(line)
            )}
            {'\n'}
          </Fragment>
        );
      })}
    </pre>
  );
}

export function AssessmentPanel({
  assessment,
  ratingReason = '',
  researchAt,
  onSupplement,
}: Props) {
  const presentation = assessmentPresentation(assessment, ratingReason);
  const hasEvidence = Boolean(presentation.original.trim());
  const legacyId = ratingReason.match(/\[自动评估\s+([^\]]+)\]/)?.[1];
  const legacyRule = ratingReason.match(/(?:^|\n)规则版本[:：]\s*([^\n]+)/)?.[1];
  const legacyTime = ratingReason.match(/(?:^|\n)评估时间[:：]\s*([^\n]+)/)?.[1];
  const dimensions = buildAssessmentDimensions(assessment, ratingReason);
  const pending = presentation.pending.filter(
    (item) => !dimensions.some((dimension) => dimension.missing === item),
  );
  const directionNames: Record<string, string> = {
    finished: '成品',
    materials: '材料配件',
    samples: '样本展示',
  };
  return (
    <section className="assessment-panel">
      <header>
        <h3>初始开发优先级</h3>
        {assessment?.product && (
          <p>
            {assessment.direction &&
              (directionNames[assessment.direction] || assessment.direction) + ' · '}
            {assessment.product}
          </p>
        )}
      </header>
      {assessment ? (
        <div className="assessment-current">
          <strong>
            {assessment.grade || assessment.status || '未评级'} · 已支持 {assessment.score}/100
          </strong>
          <Badge>{assessment.complete ? '评分维度完整' : '含未知维度'}</Badge>
          {assessment.manualOverride && <Badge>主表评级已人工修改</Badge>}
          <div className="assessment-dates">
            <span>评估更新：{formatBeijingTime(assessment.evaluatedAt)}</span>
            {researchAt !== undefined && researchAt !== null && (
              <span>官网取证：{formatBeijingTime(researchAt)}</span>
            )}
          </div>
          {assessment.manualOverride && (
            <p className="assessment-override-note">分数来自最新自动评估，客户评级已人工调整。</p>
          )}
        </div>
      ) : !hasEvidence ? (
        <p>尚无当前规则的自动评估。企业研究完成后会显示最新评分、依据与待补资料。</p>
      ) : (
        <div className="assessment-dates">
          {legacyTime && <span>评估更新：{formatBeijingTime(legacyTime)}</span>}
          {researchAt !== undefined && researchAt !== null && (
            <span>官网取证：{formatBeijingTime(researchAt)}</span>
          )}
        </div>
      )}
      {dimensions.length > 0 && (
        <section className="assessment-dimension-list" aria-label="评分维度">
          {dimensions.map((dimension) => (
            <article
              className="assessment-dimension-card"
              aria-label={dimension.name + '评分'}
              key={dimension.key}
            >
              <div className="assessment-dimension-heading">
                <h4>{dimension.name}</h4>
                <strong>
                  {dimension.score === null ? '未知' : dimension.score}
                  <small> / {dimension.maximum}</small>
                </strong>
              </div>
              <p className="assessment-dimension-conclusion">
                {formatBeijingText(dimension.conclusion)}
              </p>
              {dimension.basis.length > 0 && (
                <ul className="assessment-dimension-basis">
                  {dimension.basis.slice(0, 2).map((basis, index) => (
                    <li key={index}>
                      {formatBeijingText(basis.length > 100 ? basis.slice(0, 100) + '…' : basis)}
                    </li>
                  ))}
                </ul>
              )}
              {dimension.missing &&
                dimension.missing !== dimension.conclusion &&
                !dimension.basis.slice(0, 2).some((basis) => basis.includes(dimension.missing)) && (
                  <p className="assessment-dimension-missing">
                    {formatBeijingText(dimension.missing)}
                  </p>
                )}
              {onSupplement && (dimension.missing || dimension.score === null) && (
                <button
                  className="text-link assessment-supplement-link"
                  aria-label={'补充资料：' + dimension.name}
                  onClick={() =>
                    onSupplement({
                      category: 'assessment',
                      dimension: dimension.key as 'P' | 'R' | 'D' | 'V',
                      pendingItem: dimension.missing || undefined,
                    })
                  }
                >
                  补充资料
                </button>
              )}
              {dimension.facts.length > 0 && (
                <details className="assessment-dimension-sources">
                  <summary>原文与来源（{dimension.facts.length} 条）</summary>
                  {dimension.facts.map((fact, index) => (
                    <div className="assessment-source-fact" key={index}>
                      {fact.origin === 'manual' && (
                        <small className="assessment-manual-source">
                          人工确认{fact.confirmedBy ? ' · ' + fact.confirmedBy : ''}
                          {fact.confirmedAt ? ' · ' + formatBeijingTime(fact.confirmedAt) : ''}
                        </small>
                      )}
                      <p>{formatBeijingText(fact.value)}</p>
                      <blockquote>{formatBeijingText(fact.quote || '逐条原文未记录')}</blockquote>
                      {evidenceUrl(fact.source_url) ? (
                        <a
                          href={evidenceUrl(fact.source_url)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {fact.source_url} <ArrowUpRight size={12} />
                        </a>
                      ) : (
                        <span>
                          {fact.source_url
                            ? fact.source_url + '（链接不可打开）'
                            : fact.origin === 'manual'
                              ? '依据由确认人补充'
                              : '来源链接未记录'}
                        </span>
                      )}
                    </div>
                  ))}
                </details>
              )}
            </article>
          ))}
        </section>
      )}
      {!!pending.length && (
        <section className="assessment-notes" aria-label="待补资料">
          <h4>待补资料</h4>
          <ul>
            {pending.map((item) => (
              <li key={item}>
                {formatBeijingText(item)}
                {onSupplement && (
                  <button
                    className="text-link assessment-supplement-link"
                    aria-label={'补充资料：' + item}
                    onClick={() =>
                      onSupplement({
                        category: /采购需求|采购方式/.test(item) ? 'purchase_need' : 'profile',
                        pendingItem: item,
                        ...(item === assessment?.supplyOpportunity?.note &&
                        assessment.supplyOpportunity.targetProduct
                          ? {
                              product: assessment.supplyOpportunity.targetProduct,
                              direction: 'materials',
                            }
                          : {}),
                      })
                    }
                  >
                    补充资料
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!presentation.limitations.length && (
        <section className="assessment-notes" aria-label="研究限制">
          <h4>研究限制</h4>
          {presentation.limitations.map((text) => (
            <p key={text}>{formatBeijingText(text)}</p>
          ))}
        </section>
      )}
      {hasEvidence && (
        <details className="assessment-full-evidence" aria-label="完整评级依据">
          <summary>完整评级记录</summary>
          <AssessmentRecord text={presentation.fullRecord} />
          {presentation.supplementalRecord && (
            <>
              <h4>补充评级记录</h4>
              <AssessmentRecord text={presentation.supplementalRecord} />
            </>
          )}
        </details>
      )}
      {(assessment || hasEvidence) && (
        <details className="assessment-technical">
          <summary>技术信息</summary>
          <dl>
            {(assessment?.id || legacyId) && (
              <>
                <dt>评估编号</dt>
                <dd>{assessment?.id || legacyId}</dd>
              </>
            )}
            {(assessment?.ruleVersion || legacyRule) && (
              <>
                <dt>规则版本</dt>
                <dd>{assessment?.ruleVersion || legacyRule}</dd>
              </>
            )}
          </dl>
          <p>评级口径：A/B/C 表示初始开发优先级，未知项不补分。</p>
        </details>
      )}
    </section>
  );
}
