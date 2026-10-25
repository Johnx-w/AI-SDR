import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Archive, ExternalLink, FileCheck2, Plus, RefreshCw, Search } from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { Badge, Empty, Modal } from '../components/ui';
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
  feishu?: { configured: boolean; tableId?: string; status?: string; error?: string };
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
  const [feishu, setFeishu] = useState<ProductList['feishu']>();
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
      setFeishu(result.feishu);
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

      <div className="knowledge-guidance panel">
        <FileCheck2 size={23} />
        <div>
          <strong>先登记资料，再核对审核</strong>
          <p>
            获客搜索词仍在获客配置中维护；这里登记实际供货资料。未知参数保持空白，客户提出的规格应先核实。
          </p>
          <small>
            {(feishu?.status === 'pending' || !feishu?.configured) && feishu?.error
              ? feishu.error
              : feishu?.status === 'pending'
                ? '飞书 T5 同步待处理，已保存的资料可在本页继续核对。'
                : feishu?.configured
                  ? '通过本页维护，飞书 T5 同步供团队查看。'
                  : '当前资料保存在后台，飞书 T5 同步尚未配置。'}
          </small>
        </div>
      </div>
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
                审核前请补充可检查的来源或附件。MOQ、交期等资料仍需结合具体订单确认，资料审核不代替对某封商务邮件的批准。
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
