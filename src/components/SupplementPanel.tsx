import { useEffect, useRef, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { formatBeijingTime } from '../domain/date-time.mjs';
import { customerBusinessApi } from '../services/customerBusiness';
import type { BusinessMessage } from '../services/customerBusiness';
import { pendingLeadSupplement, saveLeadSupplement } from '../services/leadSupplements';
import type {
  SupplementAssessment,
  SupplementCategory,
  SupplementContext,
  SupplementDimension,
  SupplementDirection,
  SupplementInput,
} from '../services/leadSupplements';
import './SupplementPanel.css';

const dimensionNames: Record<SupplementDimension, string> = {
  P: '产品契合',
  R: '经营角色',
  D: '持续经营',
  V: '定制与系统特征',
};
const directions: Record<SupplementDirection, string> = {
  finished: '成品',
  materials: '材料配件',
  samples: '样本展示',
};
const categories: Record<SupplementCategory, string> = {
  profile: '企业资料',
  legal_name: '经营法人名称',
  purchase_need: '采购需求',
  assessment: '评分依据',
};
const factOptions: Record<SupplementDimension, [string, string][]> = {
  P: [
    ['core_product', '主营产品'],
    ['secondary_product', '明确经营的副线产品'],
    ['adjacent_product', '邻近品类'],
    ['unrelated_product', '产品不匹配'],
  ],
  R: [
    ['specialist_supply', '该品类专业供货'],
    ['general_supply', '综合供货'],
    ['installation_only', '仅提供安装服务'],
    ['no_supply_role', '无该品类供货角色'],
  ],
  D: [
    ['current_supply_process', '当前供货流程'],
    ['company_since', '开始经营年份或日期'],
    ['company_years', '已持续经营年数'],
    ['operating_outlet', '实际经营网点'],
    ['active_dealer', '实际经销商'],
    ['completed_project', '已交付项目'],
    ['completed_commercial_project', '已交付商业项目'],
  ],
  V: [
    ['custom_made', '定制特征'],
    ['motorized_system', '电动系统特征'],
    ['commercial_specification', '工程配套规格'],
  ],
};

const isDirection = (value?: string): value is SupplementDirection =>
  Boolean(value && Object.hasOwn(directions, value));
const factHint = (kind: string) => {
  if (kind === 'company_since') return '例如：2009，或 2009-06-01';
  if (kind === 'company_years') return '填写已核实的年数，例如：12';
  if (kind === 'operating_outlet') return '填写一个实际经营网点的名称或地址';
  if (kind === 'active_dealer') return '填写一个实际经销商名称';
  if (kind.includes('completed_')) return '填写一个已交付项目名称';
  return '填写已确认的具体事实';
};
const inputFingerprint = (input: SupplementInput) =>
  JSON.stringify(
    {
      ...input,
      sourceUrl: input.sourceUrl || '',
      pendingItem: input.pendingItem || '',
      sourceMessageId: input.sourceMessageId || '',
      product: input.product || '',
      direction: input.direction || '',
    },
    (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
          )
        : value,
  );

export function SupplementPanel<TLead>({
  leadId,
  assessment,
  context,
  onSaved,
  onCancel,
}: {
  leadId: string;
  assessment?: SupplementAssessment | null;
  context: SupplementContext;
  onSaved: (lead: TLead) => void;
  onCancel: () => void;
}) {
  const [entryContext, setEntryContext] = useState(context);
  const [restoredInput, setRestoredInput] = useState<SupplementInput | undefined>(undefined);
  const [recovery, setRecovery] = useState<'loading' | 'ready' | 'error'>('loading');
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryRetry, setRecoveryRetry] = useState(0);
  const [expectedAssessmentId, setExpectedAssessmentId] = useState(assessment?.id || null);
  const candidates = [...(assessment?.opportunities || [])];
  if (assessment?.product && assessment.direction)
    candidates.unshift({ product: assessment.product, direction: assessment.direction });
  if (restoredInput?.category === 'assessment' && restoredInput.product && restoredInput.direction)
    candidates.unshift({ product: restoredInput.product, direction: restoredInput.direction });
  const opportunities = candidates.filter(
    (item, index) =>
      isDirection(item.direction) &&
      item.product &&
      candidates.findIndex(
        (other) => other.product === item.product && other.direction === item.direction,
      ) === index,
  );
  const initialProduct = context.product || assessment?.product || '';
  const initialDirection = context.direction || assessment?.direction || '';
  const initialOpportunity = Math.max(
    0,
    opportunities.findIndex(
      (item) => item.product === initialProduct && item.direction === initialDirection,
    ),
  );
  const [category, setCategory] = useState(context.category);
  const [dimension, setDimension] = useState<SupplementDimension>(context.dimension || 'P');
  const [opportunityIndex, setOpportunityIndex] = useState(initialOpportunity);
  const [product, setProduct] = useState(initialProduct);
  const [direction, setDirection] = useState<SupplementDirection>(
    isDirection(initialDirection) ? initialDirection : 'finished',
  );
  const [facts, setFacts] = useState([
    { kind: factOptions[context.dimension || 'P'][0][0], value: '' },
  ]);
  const [content, setContent] = useState('');
  const [evidence, setEvidence] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [confirmedBy, setConfirmedBy] = useState('');
  const [sourceMessageId, setSourceMessageId] = useState('');
  const [messages, setMessages] = useState<BusinessMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [messageError, setMessageError] = useState('');
  const [messageRefresh, setMessageRefresh] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submissionKeys = useRef(new Map<string, string>());
  const sourceMessage = messages.find((message) => message.id === sourceMessageId);

  useEffect(() => {
    const controller = new AbortController();
    setRecovery('loading');
    setRecoveryError('');
    void pendingLeadSupplement(leadId, controller.signal)
      .then(({ pending }) => {
        if (controller.signal.aborted) return;
        if (pending) {
          const input = pending.input;
          setRestoredInput(input);
          setEntryContext({
            category: input.category,
            dimension: input.dimension,
            pendingItem: input.pendingItem,
            product: input.product,
            direction: input.direction,
          });
          setCategory(input.category);
          setDimension(input.dimension || 'P');
          setOpportunityIndex(0);
          setProduct(input.product || '');
          setDirection(isDirection(input.direction) ? input.direction : 'finished');
          setFacts(input.facts || [{ kind: factOptions[input.dimension || 'P'][0][0], value: '' }]);
          setContent(input.content);
          setEvidence(input.evidence);
          setSourceUrl(input.sourceUrl || '');
          setConfirmedBy(input.confirmedBy);
          setSourceMessageId(input.sourceMessageId || '');
          setExpectedAssessmentId(input.expectedAssessmentId);
          submissionKeys.current.set(inputFingerprint(input), pending.key);
        }
        setRecovery('ready');
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setRecovery('error');
        setRecoveryError(
          cause instanceof Error && cause.name === 'TimeoutError'
            ? '上次保存状态读取超时，请重试核对'
            : cause instanceof Error
              ? cause.message
              : '上次保存状态读取失败，请重试核对',
        );
      });
    return () => controller.abort();
  }, [leadId, recoveryRetry]);

  useEffect(() => {
    if (category !== 'purchase_need') return;
    const controller = new AbortController();
    setLoadingMessages(true);
    setMessageError('');
    void customerBusinessApi
      .workspace({ customerId: leadId }, controller.signal)
      .then((workspace) => {
        if (controller.signal.aborted) return;
        setMessages(
          workspace.messages.filter(
            (message) =>
              message.customerId === leadId &&
              message.actualConfirmed === true &&
              ((message.direction === 'inbound' && message.deliveryStatus === 'received') ||
                (message.direction === 'note' &&
                  message.channel === 'phone' &&
                  message.deliveryStatus === 'recorded')) &&
              message.classification === 'normal',
          ),
        );
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setMessageError(cause instanceof Error ? cause.message : '沟通记录读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMessages(false);
      });
    return () => controller.abort();
  }, [category, leadId, messageRefresh]);

  const changeDimension = (value: SupplementDimension) => {
    setDimension(value);
    setFacts([{ kind: factOptions[value][0][0], value: '' }]);
  };
  const save = async () => {
    setError('');
    if (recovery !== 'ready') return;
    if (!restoredInput && category === 'assessment' && !opportunities[opportunityIndex]) {
      setError('当前没有可补充的产品评估，请先完成企业研究。');
      return;
    }
    if (
      !restoredInput &&
      category === 'purchase_need' &&
      (!sourceMessage || !sourceMessage.body.includes(evidence.trim()))
    ) {
      setError('请选择客户实际来信或通话记录，并从原文中逐字摘录依据。');
      return;
    }
    const selected = opportunities[opportunityIndex];
    const scopedProduct =
      restoredInput?.product ||
      (category === 'assessment' ? selected?.product || '' : product.trim());
    const scopedDirection =
      restoredInput?.direction ||
      (category === 'assessment' ? selected?.direction || '' : direction);
    const input: SupplementInput = restoredInput || {
      expectedAssessmentId,
      category,
      ...(category === 'assessment'
        ? { dimension, facts: facts.map((fact) => ({ ...fact, value: fact.value.trim() })) }
        : {}),
      ...(scopedProduct && isDirection(scopedDirection)
        ? { product: scopedProduct, direction: scopedDirection }
        : {}),
      content: content.trim(),
      evidence: evidence.trim(),
      confirmedBy: confirmedBy.trim(),
      ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
      ...(entryContext.pendingItem &&
      category === entryContext.category &&
      (category !== 'assessment' ||
        !entryContext.dimension ||
        dimension === entryContext.dimension) &&
      (!entryContext.product || scopedProduct === entryContext.product) &&
      (!entryContext.direction || scopedDirection === entryContext.direction)
        ? { pendingItem: entryContext.pendingItem }
        : {}),
      ...(category === 'purchase_need' ? { sourceMessageId } : {}),
    };
    const serialized = inputFingerprint(input);
    const submissionKey = submissionKeys.current.get(serialized) || crypto.randomUUID();
    submissionKeys.current.set(serialized, submissionKey);
    setSaving(true);
    try {
      const result = await saveLeadSupplement<TLead>(leadId, input, submissionKey);
      onSaved(result.lead);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === 'TimeoutError'
          ? '保存结果尚未返回，请保留内容并重试核对。'
          : cause instanceof Error
            ? cause.message
            : '补充资料保存失败，请重试。',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="supplement-panel" aria-label="补充资料">
      <div className="supplement-heading">
        <h3>补充资料</h3>
        {entryContext.pendingItem && <p>待确认：{entryContext.pendingItem}</p>}
      </div>
      {recovery === 'loading' && <p className="supplement-hint">正在核对上次保存状态…</p>}
      {restoredInput && (
        <p className="supplement-recovery" role="status">
          发现上次未确认的保存，已恢复内容，请先按原内容重试核对。
        </p>
      )}
      {recovery === 'error' && (
        <div className="supplement-recovery-error">
          <p className="supplement-error" role="alert">
            {recoveryError}
          </p>
          <button
            className="text-link"
            type="button"
            onClick={() => setRecoveryRetry((value) => value + 1)}
          >
            重试读取保存状态
          </button>
        </div>
      )}
      <form
        className="supplement-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={saving || recovery !== 'ready' || Boolean(restoredInput)}>
          <div className="supplement-scope-grid">
            <label>
              补充项目
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as SupplementCategory)}
              >
                {Object.entries(categories).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {category === 'assessment' && (
              <label>
                评分维度
                <select
                  value={dimension}
                  onChange={(event) => changeDimension(event.target.value as SupplementDimension)}
                >
                  {Object.entries(dimensionNames).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {category === 'assessment' ? (
            <>
              <label>
                对应产品与供货方向
                <select
                  value={opportunityIndex}
                  required
                  disabled={!opportunities.length}
                  onChange={(event) => setOpportunityIndex(Number(event.target.value))}
                >
                  {!opportunities.length && <option value="">尚无产品评估</option>}
                  {opportunities.map((item, index) => (
                    <option key={item.direction + item.product} value={index}>
                      {directions[item.direction as SupplementDirection]} · {item.product}
                    </option>
                  ))}
                </select>
              </label>
              {!opportunities.length && (
                <p className="supplement-hint">当前没有可补充的产品评估，请先完成企业研究。</p>
              )}
            </>
          ) : (
            <div className="supplement-scope-grid">
              <label>
                对应产品{category === 'purchase_need' ? '' : '（选填）'}
                <input
                  value={product}
                  maxLength={500}
                  required={category === 'purchase_need'}
                  onChange={(event) => setProduct(event.target.value)}
                  placeholder="企业通用资料可留空"
                />
              </label>
              <label>
                供货方向
                <select
                  value={direction}
                  onChange={(event) => setDirection(event.target.value as SupplementDirection)}
                >
                  {Object.entries(directions).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <label>
            {category === 'legal_name' ? '已确认的经营法人全称' : '确认内容'}
            <textarea
              value={content}
              rows={2}
              maxLength={2000}
              required
              autoFocus
              placeholder={
                category === 'legal_name'
                  ? '填写登记或客户确认的法人全称'
                  : '用一两句话记录本次已确认的信息'
              }
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          {category === 'assessment' && (
            <section className="supplement-facts" aria-label="已确认的评分事实">
              <div className="supplement-facts-heading">
                <h4>已确认的评分事实</h4>
                <button
                  className="text-link"
                  type="button"
                  disabled={facts.length >= 20}
                  onClick={() =>
                    setFacts([...facts, { kind: factOptions[dimension][0][0], value: '' }])
                  }
                >
                  <Plus size={13} /> 添加一项
                </button>
              </div>
              {facts.map((fact, index) => (
                <div className="supplement-fact-row" key={index}>
                  <label>
                    事实类型{facts.length > 1 ? ` ${index + 1}` : ''}
                    <select
                      value={fact.kind}
                      onChange={(event) =>
                        setFacts(
                          facts.map((item, position) =>
                            position === index ? { kind: event.target.value, value: '' } : item,
                          ),
                        )
                      }
                    >
                      {factOptions[dimension].map(([value, label]) => (
                        <option value={value} key={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    具体信息
                    <input
                      value={fact.value}
                      required
                      maxLength={1000}
                      placeholder={factHint(fact.kind)}
                      onChange={(event) =>
                        setFacts(
                          facts.map((item, position) =>
                            position === index ? { ...item, value: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                  {facts.length > 1 && (
                    <button
                      className="btn secondary supplement-remove"
                      type="button"
                      aria-label={`删除事实 ${index + 1}`}
                      onClick={() => setFacts(facts.filter((_, position) => position !== index))}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
              {dimension === 'D' && (
                <p className="supplement-hint">
                  经营年限、网点等资料需结合当前供货流程计分；每个网点或项目单独添加一项。
                </p>
              )}
            </section>
          )}
          {category === 'purchase_need' && (
            <section className="supplement-message" aria-label="采购需求来源">
              <div className="supplement-message-toolbar">
                <h4>采购需求来源</h4>
                <button
                  className="text-link"
                  type="button"
                  disabled={loadingMessages}
                  onClick={() => setMessageRefresh((current) => current + 1)}
                >
                  刷新记录
                </button>
              </div>
              <label>
                实际来信或通话记录
                <select
                  value={sourceMessageId}
                  required
                  disabled={loadingMessages}
                  onChange={(event) => {
                    setSourceMessageId(event.target.value);
                    setEvidence('');
                  }}
                >
                  <option value="">
                    {loadingMessages ? '正在读取沟通记录…' : '选择已确认的沟通记录'}
                  </option>
                  {messages.map((message) => (
                    <option value={message.id} key={message.id}>
                      {message.subject || (message.channel === 'phone' ? '通话记录' : '客户来信')} ·{' '}
                      {formatBeijingTime(message.occurredAt)}
                    </option>
                  ))}
                </select>
              </label>
              {sourceMessage && <blockquote>{sourceMessage.body}</blockquote>}
              {messageError && (
                <p role="alert" className="supplement-error">
                  {messageError}
                </p>
              )}
              {!loadingMessages && !messages.length && (
                <p className="supplement-hint">
                  先在
                  <a
                    href={`/business?customerId=${encodeURIComponent(leadId)}&tab=messages`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    沟通记录
                  </a>
                  中登记实际来信或已确认的通话，回来刷新记录后再补充采购需求。
                </p>
              )}
            </section>
          )}
          <label>
            {category === 'purchase_need' ? '依据原文（从所选记录逐字摘录）' : '确认依据'}
            <textarea
              value={evidence}
              rows={3}
              maxLength={10000}
              required
              placeholder={
                category === 'purchase_need'
                  ? '粘贴与采购需求直接相关的原文'
                  : '记录官网原文、客户确认内容或通话核实结果'
              }
              onChange={(event) => setEvidence(event.target.value)}
            />
          </label>
          <div className="supplement-scope-grid">
            <label>
              来源链接（选填）
              <input
                type="url"
                value={sourceUrl}
                maxLength={2000}
                placeholder="https://…"
                onChange={(event) => setSourceUrl(event.target.value)}
              />
            </label>
            <label>
              确认人
              <input
                value={confirmedBy}
                maxLength={100}
                required
                placeholder="填写实际确认人的姓名"
                onChange={(event) => setConfirmedBy(event.target.value)}
              />
            </label>
          </div>
          <p className="supplement-hint">
            保存后保留确认人、北京时间和依据，并按现有规则重算评级；评分未知项仅在依据补齐后清除。
          </p>
        </fieldset>
        {error && (
          <p className="supplement-error" role="alert">
            {error}
          </p>
        )}
        <div className="supplement-actions">
          <button className="btn secondary" type="button" disabled={saving} onClick={onCancel}>
            取消
          </button>
          <button
            className="btn primary"
            type="submit"
            disabled={
              saving ||
              recovery !== 'ready' ||
              (category === 'assessment' && !opportunities.length) ||
              (category === 'purchase_need' &&
                !restoredInput &&
                (!sourceMessage || loadingMessages))
            }
          >
            <Save size={14} /> {saving ? '正在保存并重算…' : '保存资料'}
          </button>
        </div>
      </form>
    </section>
  );
}
