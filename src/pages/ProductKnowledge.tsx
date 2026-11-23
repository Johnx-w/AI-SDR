import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowDownUp,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  File,
  Files,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Image,
  Info,
  Layers,
  ListFilter,
  Plus,
  Search,
  SlidersHorizontal,
  UploadCloud,
  X,
} from 'lucide-react';
import { MaterialParseMode } from '../components/MaterialParseMode';
import { MaterialDocument } from '../components/MaterialDetail';
import { MaterialSearchTest } from '../components/MaterialSearchTest';
import { documentLimitMiB, videoLimitMiB } from '../domain/material-upload.mjs';
import {
  type ParseMode,
  acceptMaterials,
  fileSize,
  materialFormats,
  materialsRequest,
  sendJson,
  messageOf,
  statusName,
  uploadMaterial,
  type Material,
  type MaterialList,
} from '../services/materials';
import './ProductKnowledge.css';

const statuses: Record<Material['extractionStatus'], string> = {
  ready: '已就绪',
  pending: '等待提取',
  processing: '解析中',
  failed: '解析异常',
  manual: '附件素材',
};
const statusOptions = [
  ['active', '在用资料'],
  ['draft', '待审核'],
  ['approved', '已审核'],
  ['archived', '已撤回'],
  ['all', '全部状态'],
];
function formatIcon(format: string) {
  return format === 'Excel'
    ? FileSpreadsheet
    : format === '图片'
      ? Image
      : format === '视频'
        ? File
        : FileText;
}
export function ProductKnowledgePage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id') || params.get('product') || params.get('productId');
  const tab = params.get('tab') === 'test' ? 'test' : 'data';
  const status = statusOptions.some(([s]) => s === params.get('status'))
    ? params.get('status')!
    : 'active';
  function navigate(fields: Record<string, string | null>, replace = false) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(fields)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace });
  }
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [site, setSite] = useState(''),
    [format, setFormat] = useState(''),
    [page, setPage] = useState(1),
    [size, setSize] = useState(20);
  const [data, setData] = useState<MaterialList | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [tick, setTick] = useState(0);
  const [parseMode, setParseMode] = useState<ParseMode>('rich_layout_recognition');
  const [importing, setImporting] = useState(false),
    [busy, setBusy] = useState(false),
    [drag, setDrag] = useState(false),
    [progress, setProgress] = useState(''),
    [report, setReport] = useState('');
  const [sort, setSort] = useState('updated-desc');
  const [selected, setSelected] = useState<string[]>([]),
    [applying, setApplying] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const picker = useRef<HTMLInputElement>(null),
    uploadDialog = useRef<HTMLDialogElement>(null);
  const refresh = useCallback(() => setTick((v) => v + 1), []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (id || tab !== 'data') return;
    const c = new AbortController();
    setLoading(true);
    setError('');
    const q = new URLSearchParams({
      q: search,
      sort,
      site,
      format,
      status,
      page: String(page),
      pageSize: String(size),
    });
    materialsRequest<MaterialList>('?' + q, { signal: c.signal })
      .then((result) => {
        if (!c.signal.aborted) {
          setSelected((ids) => ids.filter((id) => result.items.some((m) => m.id === id)));
          setData(result);
          setPage(result.page);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(messageOf(e));
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [id, tab, search, site, format, status, page, size, sort, tick]);
  useEffect(() => {
    if (
      id ||
      tab !== 'data' ||
      loading ||
      error ||
      !data?.items.some((m) => m.extractionStatus === 'processing')
    )
      return;
    const t = setTimeout(refresh, 1800);
    return () => clearTimeout(t);
  }, [id, tab, loading, error, data, refresh]);
  useEffect(() => {
    if (importing) uploadDialog.current?.showModal();
  }, [importing]);
  async function upload(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true);
    setImporting(false);
    setReport('');
    setError('');
    let added = 0,
      reused = 0;
    const problems: string[] = [];
    for (const [index, f] of files.entries()) {
      const label = index + 1 + ' / ' + files.length + ' · ' + f.name;
      setProgress('上传中 ' + label);
      try {
        const r = await uploadMaterial(
          f,
          { site: site === 'unassigned' ? '' : site, mode: parseMode },
          crypto.randomUUID(),
          (n, total) => setProgress(label + ' · 正在解析第 ' + n + ' / ' + total + ' 页'),
        );
        if (r.reused) reused++;
        else added++;
        if (r.warning) problems.push(f.name + ' · ' + r.warning);
      } catch (e) {
        problems.push(f.name + ' · ' + messageOf(e));
      }
    }
    setReport(
      [
        '已导入 ' +
          added +
          ' 份素材' +
          (reused ? '，' + reused + ' 份已存在' : '') +
          (files.length > added + reused ? '，' + (files.length - added - reused) + ' 份失败' : ''),
        ...problems,
      ].join('\n'),
    );
    setBusy(false);
    setProgress('');
    if (added + reused) {
      setQuery('');
      setSearch('');
      setFormat('');
      setPage(1);
      if (window.location.pathname === '/materials' && status !== 'active') {
        const current = new URLSearchParams(window.location.search);
        if (!current.has('id') && !current.has('tab') && current.get('status') === status) {
          current.delete('status');
          setParams(current, { replace: true });
        }
      }
      refresh();
    }
  }
  const siteName =
    data?.sites.find((s) => s.site === site)?.brand ||
    (site === 'unassigned' ? '未分配' : '全部品牌');
  function order(field: 'name' | 'updated') {
    const defaultDirection = field === 'name' ? 'asc' : 'desc';
    const next = sort.startsWith(field)
      ? sort.endsWith('asc')
        ? 'desc'
        : 'asc'
      : defaultDirection;
    setSort(field + '-' + next);
    setPage(1);
  }
  function sortState(field: string) {
    return sort.startsWith(field) ? (sort.endsWith('asc') ? 'ascending' : 'descending') : 'none';
  }
  async function enable(items: Material[], enabled: boolean) {
    if (!items.length || applying) return;
    if (
      !enabled &&
      !window.confirm('停用选中的 ' + items.length + ' 份文件？停用后邮件将无法引用。')
    )
      return;
    setApplying(true);
    setError('');
    try {
      await sendJson('/bulk', 'POST', {
        items: items.map(({ id, version }) => ({ id, version })),
        changes: { status: enabled ? 'draft' : 'archived' },
      });
      setSelected([]);
      setReport(enabled ? '已启用，文件待审核' : '文件已停用');
      refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setApplying(false);
    }
  }
  const openFile = (value: string) =>
    navigate({ id: value, product: null, productId: null, sourcePage: null });
  if (id)
    return (
      <MaterialDocument
        key={id}
        id={id}
        initialPage={Math.max(1, parseInt(params.get('sourcePage') || '1', 10) || 1)}
        openSource={params.has('sourcePage')}
        onClose={() => openFile('')}
        onChanged={refresh}
      />
    );
  const filtered = Boolean(search || site || format || status !== 'active');
  return (
    <section
      aria-label="素材库"
      className={'kb-workspace' + (drag ? ' kb-drag' : '')}
      onDragOver={(e) => {
        if (tab === 'data' && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          if (!busy) setDrag(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
      }}
      onDrop={(e) => {
        if (tab === 'data' && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDrag(false);
          void upload(Array.from(e.dataTransfer.files));
        }
      }}
    >
      <div className="kb-surface">
        <header className="kb-titlebar">
          <div className="kb-title">
            <span className="kb-avatar">
              <BookOpen size={19} />
            </span>
            <h1>素材库</h1>
          </div>
          <nav className="kb-tabs" aria-label="素材库视图">
            <button
              aria-current={tab === 'data' ? 'page' : undefined}
              onClick={() => navigate({ tab: null })}
            >
              <Files size={15} />
              数据集
            </button>
            <button
              aria-current={tab === 'test' ? 'page' : undefined}
              onClick={() => navigate({ tab: 'test' })}
            >
              <Search size={15} />
              搜索测试
            </button>
          </nav>
          <button
            className="kb-mobile-info kb-icon"
            aria-label="素材库信息"
            aria-expanded={showInfo}
            onClick={() => setShowInfo(!showInfo)}
          >
            <Info size={17} />
          </button>
        </header>
        {tab === 'test' ? (
          <MaterialSearchTest />
        ) : (
          <>
            <div className="kb-toolbar">
              <h2>
                <FolderOpen size={17} />
                根目录
              </h2>
              <label className="kb-search">
                <Search size={15} />
                <input
                  type="search"
                  aria-label="搜索素材"
                  placeholder="搜索文件"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <details className="kb-filter">
                <summary aria-label="筛选文件">
                  <ListFilter size={16} />
                  <span>筛选</span>
                </summary>
                <div className="kb-popover">
                  <label>
                    品牌邮箱
                    <select
                      aria-label="品牌邮箱筛选"
                      value={site}
                      onChange={(e) => {
                        setSite(e.target.value);
                        setPage(1);
                      }}
                    >
                      <option value="">全部品牌邮箱</option>
                      <option value="unassigned">未分配</option>
                      {data?.sites.map((s) => (
                        <option key={s.site} value={s.site}>
                          {s.brand} · {s.site}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    文件格式
                    <select
                      value={format}
                      onChange={(e) => {
                        setFormat(e.target.value);
                        setPage(1);
                      }}
                    >
                      <option value="">全部格式</option>
                      {[...materialFormats, '产品资料'].map((f) => (
                        <option key={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    审核状态
                    <select
                      value={status}
                      onChange={(e) => {
                        navigate(
                          { status: e.target.value === 'active' ? null : e.target.value },
                          true,
                        );
                        setPage(1);
                      }}
                    >
                      {statusOptions.map(([s, n]) => (
                        <option key={s} value={s}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </details>
              <button className="kb-primary" disabled={busy} onClick={() => setImporting(true)}>
                <Plus size={16} />
                新建 / 导入
              </button>
            </div>
            {filtered && (
              <div className="kb-filtered">
                当前筛选 ·{' '}
                {[
                  search,
                  site ? siteName : '',
                  format,
                  status !== 'active' ? statusOptions.find(([key]) => key === status)?.[1] : '',
                ]
                  .filter(Boolean)
                  .join(' / ')}
                <button
                  aria-label="清除筛选"
                  onClick={() => {
                    setQuery('');
                    setSearch('');
                    setSite('');
                    setFormat('');
                    setPage(1);
                    navigate({ status: null }, true);
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            {(progress || report) && (
              <div className="kb-notice" role="status">
                {busy ? <UploadCloud size={16} /> : <Check size={16} />}
                <span>{progress || report}</span>
                {!busy && (
                  <button className="kb-icon" aria-label="关闭通知" onClick={() => setReport('')}>
                    <X size={13} />
                  </button>
                )}
              </div>
            )}
            {error && (
              <p className="kb-error" role="alert">
                {error} <button onClick={refresh}>重新读取</button>
              </p>
            )}
            {selected.length > 0 && (
              <div className="kb-selected">
                <span>已选择 {selected.length} 项</span>
                <button
                  disabled={
                    applying ||
                    !data?.items.some((m) => selected.includes(m.id) && m.status !== 'archived')
                  }
                  onClick={() =>
                    void enable(
                      data!.items.filter((m) => selected.includes(m.id) && m.status !== 'archived'),
                      false,
                    )
                  }
                >
                  停用
                </button>
                <button
                  disabled={
                    applying ||
                    !data?.items.some((m) => selected.includes(m.id) && m.status === 'archived')
                  }
                  onClick={() =>
                    void enable(
                      data!.items.filter((m) => selected.includes(m.id) && m.status === 'archived'),
                      true,
                    )
                  }
                >
                  启用
                </button>
                <button onClick={() => setSelected([])}>取消选择</button>
              </div>
            )}
            <div className="kb-table-wrap">
              <table className="kb-table" aria-label="素材文件" aria-busy={loading}>
                <thead>
                  <tr>
                    <th aria-sort={sortState('name')}>
                      <div className="kb-cell-name">
                        <input
                          type="checkbox"
                          aria-label="选择当页文件"
                          checked={
                            !!data?.items.length && data.items.every((m) => selected.includes(m.id))
                          }
                          onChange={(e) =>
                            setSelected(
                              e.target.checked ? (data?.items || []).map((m) => m.id) : [],
                            )
                          }
                        />
                        <button className="kb-sort" onClick={() => order('name')}>
                          集合名称
                          <ArrowDownUp size={12} />
                        </button>
                      </div>
                    </th>
                    <th>处理方式</th>
                    <th>数据量</th>
                    <th aria-sort={sortState('updated')}>
                      <button className="kb-sort" onClick={() => order('updated')}>
                        更新时间
                        <ArrowDownUp size={12} />
                      </button>
                    </th>
                    <th>状态</th>
                    <th>启用</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.items.map((m) => {
                    const Icon = formatIcon(m.format);
                    return (
                      <tr key={m.id}>
                        <td>
                          <div className="kb-cell-name">
                            <input
                              type="checkbox"
                              aria-label={'选择 ' + m.name}
                              checked={selected.includes(m.id)}
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? [...selected, m.id]
                                    : selected.filter((id) => id !== m.id),
                                )
                              }
                            />
                            <button
                              className="kb-row-name"
                              aria-label={'预览 ' + m.name}
                              onClick={() => openFile(m.id)}
                            >
                              <span className="kb-file-icon" data-format={m.format}>
                                <Icon size={20} />
                              </span>
                              <span>
                                <strong>{m.name}</strong>
                                <small>
                                  {[m.format, m.size ? fileSize(m.size) : '', statusName(m.status)]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </small>
                              </span>
                            </button>
                          </div>
                        </td>
                        <td>
                          {m.extractionStatus === 'manual'
                            ? '人工录入'
                            : m.format === 'Excel'
                              ? '表格解析'
                              : '分块存储'}
                        </td>
                        <td>
                          {m.format === 'Excel' &&
                          !m.extractionCount &&
                          m.extractionStatus === 'ready'
                            ? '按行查看'
                            : m.extractionCount.toLocaleString()}
                        </td>
                        <td>{m.updatedAt.slice(0, 10)}</td>
                        <td>
                          <span className={'kb-state ' + m.extractionStatus}>
                            {statuses[m.extractionStatus]}
                          </span>
                        </td>
                        <td>
                          <button
                            className="kb-switch"
                            role="switch"
                            aria-label={'启用 ' + m.name}
                            aria-checked={m.status !== 'archived'}
                            disabled={applying}
                            onClick={() => void enable([m], m.status === 'archived')}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!data?.items.length && !error && (
              <div className="kb-empty">
                <FolderOpen size={34} />
                <p>{loading ? '正在读取文件…' : filtered ? '没有符合条件的文件' : '暂无文件'}</p>
                {!loading && !filtered && (
                  <button onClick={() => setImporting(true)}>导入本地文件</button>
                )}
              </div>
            )}
            <footer className="kb-pagination">
              <span>共 {data?.total ?? 0} 条</span>
              <select
                aria-label="每页条数"
                value={size}
                onChange={(e) => {
                  setSize(Number(e.target.value));
                  setPage(1);
                }}
              >
                {[10, 20, 50].map((n) => (
                  <option key={n} value={n}>
                    {n} 条 / 页
                  </option>
                ))}
              </select>
              <button aria-label="上一页" disabled={page === 1} onClick={() => setPage(page - 1)}>
                <ChevronLeft size={16} />
              </button>
              <b>{page}</b>
              <button
                aria-label="下一页"
                disabled={page * size >= (data?.total ?? 0)}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </footer>
          </>
        )}
      </div>
      <aside className={'kb-aside' + (showInfo ? ' kb-aside-open' : '')} aria-label="素材库概览">
        <div className="kb-aside-heading">
          <span className="kb-avatar big">
            <BookOpen size={24} />
          </span>
          <h2>素材库</h2>
          <button
            className="kb-mobile-info kb-icon"
            aria-label="关闭素材库信息"
            onClick={() => setShowInfo(false)}
          >
            <X size={16} />
          </button>
        </div>
        <div className="kb-side-section">
          <h3>
            <Database size={15} />
            知识库信息
          </h3>
          <dl>
            <dt>类型</dt>
            <dd>文件知识库</dd>
            <dt>来源</dt>
            <dd>本地上传</dd>
            <dt>文件解析</dt>
            <dd>DeepSeek 文档解析</dd>
          </dl>
        </div>
        <div className="kb-side-section">
          <h3>
            <SlidersHorizontal size={15} />
            导入配置
          </h3>
          <dl>
            <dt>处理方式</dt>
            <dd>自动分块</dd>
            <dt>文档 / 图片</dt>
            <dd>{documentLimitMiB} MiB / 份</dd>
            <dt>视频</dt>
            <dd>{videoLimitMiB} MiB / 份</dd>
          </dl>
        </div>
        <div className="kb-side-section">
          <h3>
            <Layers size={15} />
            引用范围
          </h3>
          <p>邮件草稿使用当前邮箱选用并已审核的资料。</p>
        </div>
      </aside>
      {drag && (
        <div className="kb-drop-indicator">
          <UploadCloud size={34} />
          松开即可导入文件
        </div>
      )}
      {importing && (
        <dialog
          ref={uploadDialog}
          className="kb-modal kb-import"
          aria-label="导入本地文件"
          onCancel={() => setImporting(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDrag(false);
            void upload(Array.from(e.dataTransfer.files));
          }}
        >
          <header>
            <h2>导入本地文件</h2>
            <button className="kb-icon" aria-label="关闭导入" onClick={() => setImporting(false)}>
              <X size={18} />
            </button>
          </header>
          <MaterialParseMode value={parseMode} onChange={setParseMode} />
          <button
            className="kb-picker"
            aria-label="选择文件上传"
            onClick={() => picker.current?.click()}
          >
            <UploadCloud size={32} />
            <strong>选择文件上传</strong>
            <span>或将多个文件拖到此处</span>
          </button>
          <input
            hidden
            type="file"
            multiple
            accept={acceptMaterials}
            aria-label="选择本地文件"
            ref={picker}
            onChange={(e) => void upload(Array.from(e.target.files || []))}
          />
          <p>
            文档和图片每份最多 {documentLimitMiB} MiB，视频 {videoLimitMiB} MiB。PDF、DOCX、PPTX 由
            DeepSeek 解析。独立图片和视频保存为附件素材。
          </p>
        </dialog>
      )}
    </section>
  );
}
