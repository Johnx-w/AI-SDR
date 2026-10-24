import { Fragment } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Badge } from './ui';
import type { CustomsBuyerEvidence } from '../domain/types';
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
const customsFamilyNames: Record<string, string> = {
  fabrics: '窗饰面料',
  fabric: '窗饰面料',
  components: '组件与叶片',
  plantation_shutters: '透气窗',
  finished_blinds: '成品帘',
  outdoor_shading: '户外遮阳',
  samples: '窗饰样本册',
};
const customsMatchNames: Record<string, string> = {
  verified: '买方身份关联已核实',
  name_only: '仅名称一致 · 待核实',
  pending: '买方身份待核实',
  conflict: '身份存在冲突 · 不作已确认关联',
};
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

type CustomsRecord = CustomsBuyerEvidence['records'][number];
const customsUnits: Record<string, string> = {
  CTN: '箱',
  CTNS: '箱',
  CARTON: '箱',
  CARTONS: '箱',
  ROL: '卷',
  ROLL: '卷',
  ROLLS: '卷',
  PCS: '件',
  PIECES: '件',
  SET: '套',
  SETS: '套',
  PKG: '包',
  PKGS: '包',
  M: '米',
  MTR: '米',
  SQM: '平方米',
};
function shipmentQuantity(record: CustomsRecord) {
  const quantity = record.quantity;
  if (!quantity || !Number.isFinite(quantity.value) || quantity.value < 0) return '未提供';
  const value = quantity.value.toLocaleString('zh-CN', { maximumFractionDigits: 20 });
  const unit = quantity.unit?.trim();
  if (!unit) return `${value}（单位未提供）`;
  const label = customsUnits[unit.toUpperCase()];
  return label ? `${value} ${label}（${unit}）` : `${value} ${unit}`;
}
function shipmentProduct(description?: string) {
  const text = (description || '').replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').trim();
  // Labels only translate explicit cargo phrases; the complete original stays in details.
  const phrases: [RegExp, string][] = [
    [/\bpvc\s+blind(?:window)?\s+(?:window\s+)?blind\s+components?\b/i, 'PVC 百叶窗组件'],
    [/\bvertical\s+blinds?\s+components?\b/i, '垂直百叶组件'],
    [/\bfaux\s*wood\s+blinds?\b(?!\s+(?:components?|parts?))/i, '仿木百叶帘'],
    [/\b(?:roller\s+(?:blinds?|shades?))\s+fabrics?\b/i, '卷帘面料'],
    [/\bpolyester\s+sun\s*screen\s+fabrics?\b/i, '聚酯遮阳面料'],
    [/\bzebra\s+(?:blinds?|shades?)\s+fabrics?\b/i, '斑马帘面料'],
    [/\b(?:honeycomb|cellular)\s+(?:blinds?|shades?)\s+fabrics?\b/i, '蜂巢帘面料'],
    [/\bplantation\s+shutters?\b/i, '透气窗'],
    [/\b(?:outdoor\s+)?zip\s*screens?\b|\bziptrack\s+blinds?\b/i, '户外防风帘'],
    [/\b(?:roller\s+(?:blinds?|shades?))\b(?!\s+(?:fabric|component|part|clutch|sample))/i, '卷帘'],
  ];
  const labels = phrases.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  if (!labels.length && /\bsun\s*screen\s+fabrics?\b/i.test(text)) return '遮阳面料';
  return [...new Set(labels)].join('、') || text || '产品未提供';
}
const shipmentBillKey = (record: CustomsRecord) =>
  record.bill_of_lading_number
    ? JSON.stringify([record.provider || '', record.bill_of_lading_number])
    : null;

export function CustomsEvidence({ buyers }: { buyers: CustomsBuyerEvidence[] }) {
  return (
    <section className="customs-evidence" aria-label="海关逐票证据">
      <h3>海关记录</h3>
      {!buyers.length ? (
        <p>尚无关联到该官网的海关记录。</p>
      ) : (
        buyers.map((buyer) => {
          const verified = buyer.match?.status === 'verified';
          const records = buyer.records || [];
          const billCounts = new Map<string, number>();
          for (const record of records) {
            const key = shipmentBillKey(record);
            if (key) billCounts.set(key, (billCounts.get(key) || 0) + 1);
          }
          const billNumbers = new Set(records.map((r) => r.bill_of_lading_number).filter(Boolean));
          return (
            <section className="customs-buyer" key={`${buyer.id}:${buyer.product_family}`}>
              <div className="customs-buyer-heading">
                <strong>{customsFamilyNames[buyer.product_family] || buyer.product_family}</strong>
                <Badge tone={verified ? 'green' : 'amber'}>
                  {customsMatchNames[buyer.match?.status || 'pending'] || '买方身份待核实'}
                </Badge>
              </div>
              {!!records.length && (
                <p className="customs-record-count">
                  {records.length} 条记录 ·{' '}
                  {billNumbers.size ? `${billNumbers.size} 个提单号` : '提单号未提供'}
                </p>
              )}
              {buyer.records?.length ? (
                <table className="customs-product-table">
                  <thead>
                    <tr>
                      <th scope="col">记录日期</th>
                      <th scope="col">产品</th>
                      <th scope="col">进口数量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((record, index) => {
                      const sharedBill = (billCounts.get(shipmentBillKey(record) || '') || 0) > 1;
                      return (
                        <tr key={`${record.provider || ''}:${record.id}:${index}`}>
                          <td className="customs-record-date">
                            {formatBeijingText(record.date || '日期未知')}
                          </td>
                          <td>
                            <strong>{shipmentProduct(record.description)}</strong>
                            <details className="customs-record-details">
                              <summary>原始记录</summary>
                              <div className="customs-record-source">
                                <p className="assessment-reason">
                                  {record.description || '未提供货物描述'}
                                </p>
                                <p>
                                  {formatBeijingText(record.date || '日期未知')} · B/L：
                                  {record.bill_of_lading_number || '未提供提单号'}
                                </p>
                                <small>
                                  {record.provider && `${record.provider} · `}记录 ID：
                                  {record.id || '未知'}
                                </small>
                                <p>
                                  {evidenceUrl(record.source_url) ? (
                                    <a
                                      href={evidenceUrl(record.source_url)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      查看原始来源
                                    </a>
                                  ) : (
                                    <small>服务商未提供可打开的原始来源链接。</small>
                                  )}
                                </p>
                              </div>
                            </details>
                          </td>
                          <td className="customs-record-quantity">
                            {shipmentQuantity(record)}
                            {sharedBill && (
                              <small className="customs-shared-bill">同提单 · 数量不累加</small>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p>海关线索待补票据。</p>
              )}
            </section>
          );
        })
      )}
    </section>
  );
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
