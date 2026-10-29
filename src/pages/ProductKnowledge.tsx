import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Archive, ExternalLink, Plus, RefreshCw, Search } from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { Badge, Empty, Modal } from '../components/ui';
import type { OutreachFact } from '../outreachApi';
import './ProductKnowledge.css';

const categoryLabels = {
  ventilation: '透气窗',
  shutters: '百叶窗',
  indoor: '室内成品帘',
  outdoor: '户外遮阳',
  other: '其他',
};
const directionLabels = { finished: '成品', materials: '材料配件', samples: '样本展示' };
const statusLabels = { draft: '待审核', approved: '已审核', archived: '已归档' };
const factLabels: Record<OutreachFact['kind'], string> = {
  product: '产品介绍',
  price: '标准报价',
  moq: 'MOQ',
  stock: '库存',
  leadTime: '交期',
  freight: '运费',
  payment: '付款条件',
};
const needsExpiry = (kind: OutreachFact['kind']) =>
  ['price', 'stock', 'leadTime', 'freight'].includes(kind);
const beijingInput = (value: string | null) =>
  value ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 19) : '';

interface ProductDraft {
  name: string;
  englishName: string;
  category: keyof typeof categoryLabels;
  direction: keyof typeof directionLabels;
  deliveryForms: string[];
  aliases: string[];
  specifications: string;
  moq: string;
  leadTime: string;
  brands: string[];
  markets: string[];
  sourceUrl: string;
  attachments: string[];
  status: keyof typeof statusLabels;
  effectiveDate: string;
  approvedBy: string;
  notes: string;
  outreachFacts: OutreachFact[];
}
interface ProductKnowledge extends ProductDraft {
  id: string;
  version: number;
  approvedAt: string;
  createdAt: string;
  updatedAt: string;
}
interface ProductList {
  products: ProductKnowledge[];
}
interface SaveResult {
  product: ProductKnowledge;
  feishu?: { status: 'synced' | 'pending' | 'not_configured'; error?: string };
}
interface Editor {
  original: ProductKnowledge | null;
  value: ProductDraft;
  key: string;
}
type ListField = 'deliveryForms' | 'aliases' | 'brands' | 'markets' | 'attachments';
class ProductRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const blankProduct = (): ProductDraft => ({
  name: '',
  englishName: '',
  category: 'other',
  direction: 'finished',
  deliveryForms: [],
  aliases: [],
  specifications: '',
  moq: '',
  leadTime: '',
  brands: [],
  markets: [],
  sourceUrl: '',
  attachments: [],
  status: 'draft',
  effectiveDate: '',
  approvedBy: '',
  notes: '',
  outreachFacts: [],
});
const splitList = (value: string) => [
  ...new Set(
    value
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean),
  ),
];
const sourceLink = (value: string) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
};
const timestamp = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '尚未记录'
    : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
};

async function request<T>(
  method = 'GET',
  value?: object,
  signal?: AbortSignal,
  options?: { path?: string; key?: string },
): Promise<T> {
  const response = await fetch(options?.path || '/api/v1/products/knowledge', {
    method,
    ...(value
      ? {
          headers: {
            'Content-Type': 'application/json',
            ...(options?.key ? { 'Idempotency-Key': options.key } : {}),
          },
          body: JSON.stringify(value),
        }
      : {}),
    signal: signal || AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ProductRequestError(
      body?.error || `产品资料操作失败（${response.status}）`,
      response.status,
    );
  if (!body) throw new Error('服务未返回有效结果，请刷新列表核对');
  return body as T;
}

export function ProductKnowledgePage() {
  const [productParams, setProductParams] = useSearchParams();
  const focusedProduct = productParams.get('product');
  const [products, setProducts] = useState<ProductKnowledge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (focusedProduct) setQuery(focusedProduct);
  }, [focusedProduct]);
  const requestedStatus = productParams.get('status') || '';
  const status = ['active', 'draft', 'approved', 'archived', 'all'].includes(requestedStatus)
    ? requestedStatus
    : 'active';
  const [editor, setEditor] = useState<Editor | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [pendingSyncId, setPendingSyncId] = useState('');
  const [listInputs, setListInputs] = useState<Record<ListField, string>>({
    deliveryForms: '',
    aliases: '',
    brands: '',
    markets: '',
    attachments: '',
  });

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const result = await request<ProductList>('GET', undefined, signal);
      if (!Array.isArray(result.products)) throw new Error('产品资料返回格式异常');
      setProducts(result.products);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : '无法读取产品资料');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const shown = useMemo(() => {
    const term = query.trim().toLowerCase();
    return products.filter(
      (product) =>
        (status === 'all' ||
          (status === 'active' ? product.status !== 'archived' : product.status === status)) &&
        (!term ||
          [product.name, product.englishName, product.id, ...product.aliases, ...product.brands]
            .join(' ')
            .toLowerCase()
            .includes(term)),
    );
  }, [products, query, status]);

  function openEditor(product?: ProductKnowledge) {
    setFormError('');
    setRefreshRequired(false);
    setEditor({
      original: product || null,
      key: crypto.randomUUID(),
      value: product
        ? {
            ...product,
            outreachFacts: product.outreachFacts || [],
            status: 'draft',
            approvedBy: '',
          }
        : blankProduct(),
    });
    setListInputs({
      deliveryForms: product?.deliveryForms.join('，') || '',
      aliases: product?.aliases.join('，') || '',
      brands: product?.brands.join('，') || '',
      markets: product?.markets.join('，') || '',
      attachments: product?.attachments.join('\n') || '',
    });
  }
  function change<K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) {
    setEditor((current) => current && { ...current, value: { ...current.value, [key]: value } });
  }
  function changeList(key: ListField, value: string) {
    setListInputs((current) => ({ ...current, [key]: value }));
    change(
      key,
      key === 'attachments'
        ? value
            .split('\n')
            .map((item) => item.trim())
            .filter(Boolean)
        : splitList(value),
    );
  }
  function changeFact(id: string, values: Partial<OutreachFact>) {
    if (editor)
      change(
        'outreachFacts',
        editor.value.outreachFacts.map((fact) => (fact.id === id ? { ...fact, ...values } : fact)),
      );
  }
  function acceptSaved(result: SaveResult, requestedStatus?: ProductDraft['status']) {
    setProducts((current) => [
      ...current.filter((product) => product.id !== result.product.id),
      result.product,
    ]);
    setPendingSyncId(result.feishu?.status === 'pending' ? result.product.id : '');
    const saved =
      requestedStatus === 'approved' && result.product.status === 'draft'
        ? '资料变更已保存为待审核，请核对后再次审核。'
        : '产品资料已保存。';
    const sync =
      result.feishu?.status === 'synced'
        ? '已同步到飞书 T5。'
        : result.feishu?.status === 'pending'
          ? '飞书同步待核对，请勿重复新建。'
          : '';
    setNotice(saved + sync);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || saving || refreshRequired) return;
    setSaving(true);
    setFormError('');
    try {
      const result = await request<SaveResult>(
        editor.original ? 'PUT' : 'POST',
        {
          ...editor.value,
          ...(editor.original
            ? { id: editor.original.id, expectedVersion: editor.original.version }
            : {}),
        },
        undefined,
        { key: editor.key },
      );
      acceptSaved(result, editor.value.status);
      setEditor(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '保存失败';
      if (!(cause instanceof ProductRequestError) || cause.status === 409 || cause.status >= 500) {
        setRefreshRequired(true);
        setFormError(
          cause instanceof ProductRequestError && cause.status === 409
            ? `${message}。请关闭并刷新列表，重新打开最新资料。`
            : `${message}。保存结果尚未确认，请先关闭并刷新列表核对，再决定是否重试。`,
        );
      } else setFormError(message);
    } finally {
      setSaving(false);
    }
  }
  async function archive(product: ProductKnowledge) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await request<SaveResult>('PUT', {
        ...product,
        expectedVersion: product.version,
        status: 'archived',
      });
      acceptSaved(result);
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : '归档失败'}。请刷新列表核对当前状态。`);
    } finally {
      setSaving(false);
    }
  }
  async function retrySync() {
    if (!pendingSyncId || saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await request<SaveResult>('POST', undefined, undefined, {
        path: `/api/v1/products/knowledge/${encodeURIComponent(pendingSyncId)}/sync`,
      });
      acceptSaved(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '飞书同步结果尚未确认，请稍后核对');
    } finally {
      setSaving(false);
    }
  }
  function closeEditor() {
    if (saving) return;
    setEditor(null);
    if (refreshRequired) void load();
  }

  return (
    <div className="product-knowledge">
      <PageHeading
        eyebrow="PRODUCT KNOWLEDGE · T5"
        title="产品资料库"
        description="维护公司可供产品、规格依据和审核状态，供业务接待查阅"
      >
        <button className="btn secondary" onClick={() => void load()} disabled={loading || saving}>
          <RefreshCw size={15} /> 刷新
        </button>
        <button
          className="btn primary"
          onClick={() => openEditor()}
          disabled={loading || saving || !!error}
        >
          <Plus size={16} /> 新增产品资料
        </button>
      </PageHeading>

      {error && (
        <p className="knowledge-alert error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <div className="knowledge-alert knowledge-save-notice" role="status">
          <span>{notice}</span>
          {pendingSyncId && (
            <button
              className="btn secondary small"
              disabled={saving}
              onClick={() => void retrySync()}
            >
              核对并重试飞书同步
            </button>
          )}
        </div>
      )}

      <section className="panel knowledge-list">
        <div className="knowledge-toolbar">
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label="搜索产品资料"
              placeholder="搜索产品、编号、别名或品牌"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <select
            aria-label="产品审核状态"
            value={status}
            onChange={(event) =>
              setProductParams((current) => {
                const next = new URLSearchParams(current);
                if (event.target.value === 'active') next.delete('status');
                else next.set('status', event.target.value);
                return next;
              })
            }
          >
            <option value="active">在用资料</option>
            <option value="draft">待审核</option>
            <option value="approved">已审核</option>
            <option value="archived">已归档</option>
            <option value="all">全部资料</option>
          </select>
          <span className="knowledge-count">
            {shown.length} 条资料 · 已审核{' '}
            {products.filter((product) => product.status === 'approved').length} 条
          </span>
        </div>
        {loading ? (
          <p className="knowledge-loading" role="status">
            正在读取产品资料…
          </p>
        ) : shown.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>产品</th>
                  <th>品类与方向</th>
                  <th>供货资料</th>
                  <th>审核状态</th>
                  <th>来源</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((product) => (
                  <tr key={product.id}>
                    <td className="knowledge-name">
                      <strong>{product.name}</strong>
                      <span>{product.englishName || '英文名称待补充'}</span>
                      <small>{product.id}</small>
                    </td>
                    <td>
                      {categoryLabels[product.category]}
                      <span className="knowledge-secondary">
                        {directionLabels[product.direction]}
                        {product.deliveryForms.length
                          ? ` · ${product.deliveryForms.join('、')}`
                          : ''}
                      </span>
                    </td>
                    <td className="knowledge-summary">
                      <span>{product.specifications || '规格参数待核实'}</span>
                      <small>
                        MOQ：{product.moq || '待核实'} · 常规交期：{product.leadTime || '待核实'}
                      </small>
                      {!!product.outreachFacts?.length && (
                        <details className="knowledge-fact-summary">
                          <summary>开发信可引用资料 · {product.outreachFacts.length} 条</summary>
                          {product.outreachFacts.map((fact) => (
                            <div key={fact.id}>
                              <strong>{factLabels[fact.kind]}</strong>
                              <p>{fact.text}</p>
                              {fact.conditions && <p>适用条件：{fact.conditions}</p>}
                              <small>
                                {fact.validUntil
                                  ? `有效期至 ${timestamp(fact.validUntil)}${Date.parse(fact.validUntil) <= Date.now() ? ' · 已过期' : ''}`
                                  : '未设置到期时间'}
                              </small>
                            </div>
                          ))}
                        </details>
                      )}
                    </td>
                    <td>
                      <Badge tone={product.status === 'approved' ? 'success' : 'neutral'}>
                        {statusLabels[product.status]}
                      </Badge>
                      <span className="knowledge-secondary">第 {product.version} 版</span>
                      {product.status === 'approved' && (
                        <small className="knowledge-secondary">审核：{product.approvedBy}</small>
                      )}
                    </td>
                    <td>
                      {sourceLink(product.sourceUrl) ? (
                        <a
                          className="text-link"
                          href={sourceLink(product.sourceUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          查看依据 <ExternalLink size={13} />
                        </a>
                      ) : (
                        <span className="muted">待补充</span>
                      )}
                      <small className="knowledge-secondary">
                        {product.attachments.length} 个附件链接
                      </small>
                    </td>
                    <td>
                      <div className="knowledge-actions">
                        <button
                          className="btn secondary small"
                          onClick={() => openEditor(product)}
                          disabled={saving}
                        >
                          查看 / 编辑
                        </button>
                        <Link
                          className="btn secondary small"
                          to={
                            '/business?' +
                            new URLSearchParams({ productId: product.id, tab: 'demands' })
                          }
                        >
                          关联需求与跟进
                        </Link>
                        {product.status !== 'archived' && (
                          <button
                            className="btn secondary small"
                            onClick={() => void archive(product)}
                            disabled={saving}
                            aria-label={`归档 ${product.name}`}
                          >
                            <Archive size={13} /> 归档
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !error && (
            <Empty
              title={products.length ? '没有符合条件的产品资料' : '尚未登记产品资料'}
              detail={
                products.length
                  ? '调整搜索或审核状态后再查看。'
                  : '添加一项产品，填写已有资料及来源。未核实的规格、MOQ 和交期可以留空。'
              }
            />
          )
        )}
      </section>

      {editor && (
        <Modal
          wide
          title={editor.original ? `产品资料 · ${editor.original.name}` : '新增产品资料'}
          onClose={closeEditor}
        >
          <form className="modal-body knowledge-form" onSubmit={(event) => void save(event)}>
            {editor.original && (
              <p className="knowledge-editor-meta">
                编号 {editor.original.id} · 第 {editor.original.version} 版 · 最近更新{' '}
                {timestamp(editor.original.updatedAt)}
              </p>
            )}
            {editor.original?.status === 'approved' && (
              <p className="knowledge-alert">
                本次编辑按草稿打开。确认修改内容后，可重新选择“已审核”并填写审核人。
              </p>
            )}
            {formError && (
              <p className="knowledge-alert error" role="alert">
                {formError}
              </p>
            )}
            <fieldset disabled={saving || refreshRequired}>
              <legend>产品与供货范围</legend>
              <div className="knowledge-fields">
                <label>
                  产品名称 *
                  <input
                    required
                    maxLength={160}
                    value={editor.value.name}
                    onChange={(event) => change('name', event.target.value)}
                  />
                </label>
                <label>
                  英文名称
                  <input
                    maxLength={160}
                    value={editor.value.englishName}
                    onChange={(event) => change('englishName', event.target.value)}
                  />
                </label>
                <label>
                  品类
                  <select
                    value={editor.value.category}
                    onChange={(event) =>
                      change('category', event.target.value as ProductDraft['category'])
                    }
                  >
                    {Object.entries(categoryLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  供货方向
                  <select
                    value={editor.value.direction}
                    onChange={(event) =>
                      change('direction', event.target.value as ProductDraft['direction'])
                    }
                  >
                    {Object.entries(directionLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  采购形态
                  <input
                    placeholder="例如：成品、型材；多个用逗号分隔"
                    value={listInputs.deliveryForms}
                    onChange={(event) => changeList('deliveryForms', event.target.value)}
                  />
                </label>
                <label>
                  产品别名
                  <input
                    placeholder="多个用逗号分隔"
                    value={listInputs.aliases}
                    onChange={(event) => changeList('aliases', event.target.value)}
                  />
                </label>
                <label>
                  适用品牌
                  <input
                    placeholder="多个用逗号分隔，未知留空"
                    value={listInputs.brands}
                    onChange={(event) => changeList('brands', event.target.value)}
                  />
                </label>
                <label>
                  适用市场
                  <input
                    placeholder="多个用逗号分隔，未知留空"
                    value={listInputs.markets}
                    onChange={(event) => changeList('markets', event.target.value)}
                  />
                </label>
              </div>
            </fieldset>
            <fieldset disabled={saving || refreshRequired}>
              <legend>规格与资料依据</legend>
              <div className="knowledge-fields">
                <label className="knowledge-full">
                  已核实参数
                  <textarea
                    rows={4}
                    placeholder="记录适用产品、参数值、单位和范围，并在下方补充依据"
                    value={editor.value.specifications}
                    onChange={(event) => change('specifications', event.target.value)}
                  />
                </label>
                <label>
                  MOQ
                  <input
                    placeholder="已确认时填写数量及单位"
                    value={editor.value.moq}
                    onChange={(event) => change('moq', event.target.value)}
                  />
                </label>
                <label>
                  常规交期
                  <input
                    placeholder="已确认时填写适用条件"
                    value={editor.value.leadTime}
                    onChange={(event) => change('leadTime', event.target.value)}
                  />
                </label>
                <label className="knowledge-full">
                  来源链接
                  <input
                    type="url"
                    placeholder="https://…"
                    value={editor.value.sourceUrl}
                    onChange={(event) => change('sourceUrl', event.target.value)}
                  />
                </label>
                <label className="knowledge-full">
                  附件链接
                  <textarea
                    rows={2}
                    placeholder="图纸、规格书或目录链接，每行一个"
                    value={listInputs.attachments}
                    onChange={(event) => changeList('attachments', event.target.value)}
                  />
                </label>
                {editor.value.attachments.some(sourceLink) && (
                  <div className="knowledge-full knowledge-attachment-links">
                    {editor.value.attachments.filter(sourceLink).map((url, index) => (
                      <a
                        key={url}
                        className="text-link"
                        href={sourceLink(url)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        查看附件 {index + 1} <ExternalLink size={13} />
                      </a>
                    ))}
                  </div>
                )}
                <label className="knowledge-full">
                  备注
                  <textarea
                    rows={2}
                    placeholder="适用条件、资料缺项或待核实事项"
                    value={editor.value.notes}
                    onChange={(event) => change('notes', event.target.value)}
                  />
                </label>
              </div>
            </fieldset>
            <fieldset disabled={saving || refreshRequired}>
              <legend>开发信可引用资料</legend>
              <p className="knowledge-form-note">
                填写可直接对外使用的英文事实和适用条件，随本份产品资料一起审核。报价、库存、交期和运费须设置有效期；过期资料不会用于发信。
              </p>
              {editor.value.outreachFacts.map((fact, index) => (
                <div className="knowledge-fact-editor" key={fact.id}>
                  <div className="knowledge-fields">
                    <label>
                      资料 {index + 1} · 类型
                      <select
                        value={fact.kind}
                        onChange={(event) =>
                          changeFact(fact.id, { kind: event.target.value as OutreachFact['kind'] })
                        }
                      >
                        {Object.entries(factLabels).map(([kind, label]) => (
                          <option key={kind} value={kind}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      有效期至（北京时间）{needsExpiry(fact.kind) ? ' *' : ''}
                      <input
                        type="datetime-local"
                        step="1"
                        required={needsExpiry(fact.kind)}
                        value={beijingInput(fact.validUntil)}
                        onChange={(event) =>
                          changeFact(fact.id, {
                            validUntil: event.target.value
                              ? new Date(event.target.value + '+08:00').toISOString()
                              : null,
                          })
                        }
                      />
                    </label>
                    <label className="knowledge-full">
                      可外发英文原句 *
                      <textarea
                        required
                        rows={2}
                        maxLength={1200}
                        value={fact.text}
                        onChange={(event) => changeFact(fact.id, { text: event.target.value })}
                      />
                    </label>
                    <label className="knowledge-full">
                      适用条件英文原句{fact.kind === 'price' ? ' *' : ''}
                      <textarea
                        required={fact.kind === 'price'}
                        rows={2}
                        maxLength={800}
                        placeholder="报价请写全数量档位、规格、币种、计价单位及适用交易条件"
                        value={fact.conditions}
                        onChange={(event) =>
                          changeFact(fact.id, { conditions: event.target.value })
                        }
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="btn secondary small"
                    onClick={() =>
                      change(
                        'outreachFacts',
                        editor.value.outreachFacts.filter((item) => item.id !== fact.id),
                      )
                    }
                    aria-label={`删除资料 ${index + 1}`}
                  >
                    删除此条
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn secondary small"
                disabled={editor.value.outreachFacts.length >= 30}
                onClick={() =>
                  change('outreachFacts', [
                    ...editor.value.outreachFacts,
                    {
                      id: crypto.randomUUID(),
                      kind: 'product',
                      text: '',
                      conditions: '',
                      validUntil: null,
                    },
                  ])
                }
              >
                <Plus size={14} /> 添加外发资料
              </button>
            </fieldset>
            <fieldset disabled={saving || refreshRequired}>
              <legend>审核与生效</legend>
              <div className="knowledge-fields">
                <label>
                  资料状态
                  <select
                    value={editor.value.status}
                    onChange={(event) =>
                      change('status', event.target.value as ProductDraft['status'])
                    }
                  >
                    <option value="draft">待审核</option>
                    <option value="approved">已审核</option>
                  </select>
                </label>
                <label>
                  生效日期
                  <input
                    type="date"
                    required={editor.value.status === 'approved'}
                    value={editor.value.effectiveDate}
                    onChange={(event) => change('effectiveDate', event.target.value)}
                  />
                </label>
                {editor.value.status === 'approved' && (
                  <label className="knowledge-full">
                    审核人 *
                    <input
                      required
                      maxLength={100}
                      value={editor.value.approvedBy}
                      onChange={(event) => change('approvedBy', event.target.value)}
                    />
                  </label>
                )}
              </div>
              <p className="knowledge-form-note">
                审核前请核对以上资料及来源。计划另行授权后，系统可在已确认范围内自动发信；修改资料后需重新审核，未授权范围不会自动扩大。
              </p>
            </fieldset>
            <div className="modal-actions">
              <button
                type="button"
                className="btn secondary"
                disabled={saving}
                onClick={closeEditor}
              >
                {refreshRequired ? '关闭并刷新核对' : '取消'}
              </button>
              <button className="btn primary" type="submit" disabled={saving || refreshRequired}>
                {saving
                  ? '正在保存…'
                  : editor.value.status === 'approved'
                    ? '审核并保存'
                    : '保存草稿'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
