import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Upload,
  History,
  Eye,
  Grid2X2,
  List,
  Search,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FileImage,
  FolderOpen,
  ChevronDown,
} from 'lucide-react';
import { MaterialDialog, type MaterialView } from '../components/MaterialDetail';
import { documentLimitMiB, videoLimitMiB } from '../domain/material-upload.mjs';
import {
  acceptMaterials,
  fileSize,
  materialFormats,
  materialsRequest,
  messageOf,
  sendJson,
  sourceUrl,
  statusName,
  uploadMaterial,
  type Material,
  type MaterialList,
} from '../services/materials';
import './ProductKnowledge.css';

export function ProductKnowledgePage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id') || params.get('product') || params.get('productId') || '';
  const requestedStatus = params.get('status') || 'active';
  const status = ['active', 'draft', 'approved', 'archived', 'all'].includes(requestedStatus)
    ? requestedStatus
    : 'active';
  function setStatus(value: string) {
    const next = new URLSearchParams(params);
    if (value === 'active') next.delete('status');
    else next.set('status', value);
    setParams(next, { replace: true });
  }
  function showId(value: string) {
    const next = new URLSearchParams(params);
    next.delete('productId');
    next.delete('product');
    if (value) next.set('id', value);
    else next.delete('id');
    setParams(next);
  }
  const [data, setData] = useState<MaterialList | null>(null),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [site, setSite] = useState(''),
    [categories, setCategories] = useState<string[]>([]),
    [catSearch, setCatSearch] = useState(''),
    [format, setFormat] = useState(''),
    [page, setPage] = useState(1),
    [size, setSize] = useState(20),
    [reload, setReload] = useState(0),
    [view, setView] = useState<'grid' | 'list'>('grid'),
    [dialogView, setDialogView] = useState<MaterialView>('preview');
  const [batch, setBatch] = useState(false),
    [selection, setSelection] = useState<Map<string, Material>>(new Map()),
    [editing, setEditing] = useState(false),
    [drag, setDrag] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [report, setReport] = useState(''),
    [loading, setLoading] = useState(true);
  const input = useRef<HTMLInputElement>(null),
    bulkDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 180);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    const c = new AbortController();
    setError('');
    setLoading(true);
    const p = new URLSearchParams({
      q: search,
      site,
      format,
      status,
      page: String(page),
      pageSize: String(size),
    });
    categories.forEach((cat) => p.append('category', cat));
    materialsRequest<MaterialList>('?' + p, { signal: c.signal })
      .then((result) => {
        if (!c.signal.aborted) {
          setData(result);
          if (result.page !== page) setPage(result.page);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(messageOf(e));
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [search, site, format, status, page, size, categories, reload]);
  useEffect(() => {
    if (editing) bulkDialog.current?.showModal();
  }, [editing]);
  const refresh = useCallback(() => setReload((v) => v + 1), []);
  function open(item: Material, mode: MaterialView) {
    setDialogView(mode);
    showId(item.id);
  }
  function toggleSelected(m: Material, on: boolean) {
    setSelection((prev) => {
      const next = new Map(prev);
      if (on) next.set(m.id, m);
      else next.delete(m.id);
      return next;
    });
  }
  async function upload(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true);
    setError('');
    setReport('');
    let done = 0,
      reused = 0;
    const errors: string[] = [];
    for (const [i, file] of files.entries()) {
      setReport('正在导入 ' + (i + 1) + ' / ' + files.length + ' · ' + file.name);
      try {
        const key = crypto.randomUUID();
        const result = await uploadMaterial(
          file,
          {
            site: site === 'unassigned' ? '' : site,
            category: categories.length === 1 ? categories[0] : undefined,
          },
          key,
        );
        done++;
        if (result.reused) reused++;
        if (result.warning) errors.push(file.name + ' · 原件已保存，' + result.warning);
      } catch (e) {
        errors.push(file.name + ' · ' + messageOf(e));
      }
    }
    setBusy(false);
    setReport(
      [
        '已导入 ' +
          (done - reused) +
          ' 份素材' +
          (reused ? '，' + reused + ' 份原件已存在' : '') +
          (files.length > done ? '，' + (files.length - done) + ' 份失败' : ''),
        ...errors,
      ].join('\n'),
    );
    if (done) {
      setPage(1);
      setStatus('active');
      setFormat('');
      setQuery('');
      if (categories.length > 1) setCategories([]);
      refresh();
    }
  }
  async function bulk(changes: Record<string, unknown>) {
    if (!selection.size || busy) return;
    setBusy(true);
    setError('');
    try {
      await sendJson('/bulk', 'POST', {
        items: [...selection.values()].map(({ id, version }) => ({ id, version })),
        changes,
      });
      setReport('已更新 ' + selection.size + ' 份素材');
      setEditing(false);
      setSelection(new Map());
      refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  function csv() {
    const escape = (v: string) =>
      '"' + (/^[\s]*[=+\-@]/.test(v) ? "'" : '') + v.replaceAll('"', '""') + '"';
    const arr = [
      ['素材名称', '品类', '关键词', '官网', '文件格式', '版本', '状态'],
      ...[...selection.values()].map((m) => [
        m.name,
        m.category,
        m.keywords.join('、'),
        m.sites.join('、'),
        m.format,
        String(m.version),
        statusName(m.status),
      ]),
    ];
    const u = URL.createObjectURL(
      new Blob(['\ufeff' + arr.map((row) => row.map(escape).join(',')).join('\r\n')], {
        type: 'text/csv;charset=utf-8',
      }),
    );
    const a = document.createElement('a');
    a.href = u;
    a.download = '素材清单.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  }
  const items = data?.items || [],
    pages = Math.max(1, Math.ceil((data?.total || 0) / size));
  const busyFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  return (
    <main
      className="materials"
      aria-label="素材库"
      onDragOver={(e) => {
        if (busyFiles(e)) {
          e.preventDefault();
          if (!busy) setDrag(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
      }}
      onDrop={(e) => {
        if (busyFiles(e)) {
          e.preventDefault();
          setDrag(false);
          void upload(Array.from(e.dataTransfer.files));
        }
      }}
    >
      <header className="mat-head">
        <h1>素材库</h1>
      </header>
      <section className={'mat-entry' + (drag ? ' dragging' : '')}>
        <div className="mat-entry-label">
          <span className="mat-upload-icon">
            <Upload size={21} />
          </span>
          <div>
            <h2>素材上传入口</h2>
            <p>
              拖入或选择文件。文档、表格和图片每份最多 {documentLimitMiB} MiB，视频最多{' '}
              {videoLimitMiB} MiB。
            </p>
          </div>
        </div>
        <div className="mat-actions">
          <button
            type="button"
            onClick={() => {
              setBatch(!batch);
              setSelection(new Map());
            }}
          >
            {batch ? '退出批量管理' : '批量管理'}
          </button>
          <button className="mat-primary" disabled={busy} onClick={() => input.current?.click()}>
            <Upload size={15} />
            选择文件上传
          </button>
          <input
            aria-label="选择本地文件"
            hidden
            ref={input}
            type="file"
            multiple
            accept={acceptMaterials}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = '';
              void upload(files);
            }}
          />
        </div>
      </section>
      {report && (
        <p role="status" className="mat-note">
          {report}
        </p>
      )}
      {error && (
        <p role="alert" className="mat-error">
          {error} <button onClick={refresh}>重新读取</button>
        </p>
      )}
      <section className="mat-filters" aria-label="素材筛选">
        <label className="mat-search">
          <Search size={16} />
          <input
            type="search"
            value={query}
            aria-label="搜索素材"
            placeholder="搜索素材名称、关键词"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
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
            <option value={s.site} key={s.site}>
              {s.brand} · {s.site}
            </option>
          ))}
        </select>
        <details>
          <summary>
            {categories.length ? '品类 · ' + categories.length : '全部类别'}{' '}
            <ChevronDown size={13} />
          </summary>
          <div className="mat-dropdown">
            <input
              aria-label="搜索品类"
              value={catSearch}
              onChange={(e) => setCatSearch(e.target.value)}
              placeholder="搜索品类"
            />
            {data?.categories
              .filter((c) => c.includes(catSearch))
              .map((c) => (
                <label key={c}>
                  <input
                    type="checkbox"
                    checked={categories.includes(c)}
                    onChange={(e) => {
                      setCategories((prev) =>
                        e.target.checked ? [...prev, c] : prev.filter((x) => x !== c),
                      );
                      setPage(1);
                    }}
                  />
                  {c}
                </label>
              ))}
          </div>
        </details>
        <details>
          <summary>
            筛选 <ChevronDown size={13} />
          </summary>
          <div className="mat-dropdown">
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
                {[...materialFormats, '产品资料'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              素材状态
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                {[
                  ['active', '在用资料'],
                  ['draft', '待审核'],
                  ['approved', '已审核'],
                  ['archived', '已撤回'],
                  ['all', '所有状态'],
                ].map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
        <div className="mat-view">
          <button aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
            <Grid2X2 size={14} />
            宫格
          </button>
          <button aria-pressed={view === 'list'} onClick={() => setView('list')}>
            <List size={14} />
            列表
          </button>
        </div>
      </section>
      {(search || categories.length > 0 || format || site || status !== 'active') && (
        <button
          className="mat-clear"
          onClick={() => {
            setQuery('');
            setSearch('');
            setCategories([]);
            setFormat('');
            setSite('');
            setStatus('active');
            setPage(1);
          }}
        >
          清除筛选
        </button>
      )}
      {batch && (
        <section className="mat-bulk">
          <label>
            <input
              type="checkbox"
              checked={!!items.length && items.every((m) => selection.has(m.id))}
              onChange={(e) => {
                const on = e.target.checked;
                setSelection((prev) => {
                  const result = new Map(prev);
                  items.forEach((m) => (on ? result.set(m.id, m) : result.delete(m.id)));
                  return result;
                });
              }}
            />
            全选当前页
          </label>
          <b>已选 {selection.size} 项</b>
          <button disabled={!selection.size} onClick={csv}>
            导出 CSV
          </button>
          <button disabled={!selection.size || busy} onClick={() => setEditing(true)}>
            分配与归类
          </button>
          <button
            disabled={!selection.size || busy}
            onClick={() => void bulk({ status: 'archived' })}
          >
            撤回资料
          </button>
        </section>
      )}
      <section aria-busy={loading} className={'mat-grid ' + (view === 'list' ? 'mat-list' : '')}>
        {items.map((m) => (
          <article key={m.id}>
            <div
              className={
                'mat-cover ' + (m.format === 'Excel' ? 'sheet' : m.format === 'PDF' ? 'pdf' : '')
              }
            >
              {m.documentId && m.contentType?.startsWith('image/') ? (
                <img loading="lazy" alt={m.name} src={sourceUrl(m.id, m.documentId)} />
              ) : m.documentId && m.contentType?.startsWith('video/') ? (
                <video muted preload="none" src={sourceUrl(m.id, m.documentId)} />
              ) : m.preview ? (
                <div className="mat-sheet-cover" aria-label="工作簿内容预览">
                  <span>
                    <FileSpreadsheet size={15} />
                    {m.preview[0]}
                  </span>
                  <table>
                    <thead>
                      <tr>
                        {[1, 3, 5]
                          .filter((n) => m.preview![n])
                          .map((n) => (
                            <th key={n}>{m.preview![n]}</th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        {[1, 3, 5]
                          .filter((n) => m.preview![n])
                          .map((n) => (
                            <td key={n}>{m.preview![n + 1]}</td>
                          ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mat-filemark">
                  {m.format === 'Excel' ? (
                    <FileSpreadsheet />
                  ) : m.format === '视频' ? (
                    <FileVideo />
                  ) : m.format === '图片' ? (
                    <FileImage />
                  ) : (
                    <FileText />
                  )}
                  <strong>{m.format}</strong>
                </div>
              )}
              <button
                className="mat-eye"
                aria-label={'预览 ' + m.name}
                onClick={() => open(m, 'preview')}
              >
                <Eye size={16} />
              </button>
              {batch && (
                <input
                  className="mat-pick"
                  type="checkbox"
                  aria-label={'选择 ' + m.name}
                  checked={selection.has(m.id)}
                  onChange={(e) => toggleSelected(m, e.target.checked)}
                />
              )}
            </div>
            <div className="mat-cardinfo">
              <button className="mat-name" onClick={() => open(m, 'preview')}>
                {m.name}
              </button>
              <div>
                <span className="mat-kind">{m.category}</span>
              </div>
              <div className="mat-tags">
                {m.keywords.slice(0, 3).map((t) => (
                  <span key={t}>{t}</span>
                ))}
                {m.keywords.length > 3 && (
                  <span title={m.keywords.join('、')}>+{m.keywords.length - 3}</span>
                )}
              </div>
              <small>
                {m.format} {m.size ? fileSize(m.size) : ''} · {m.updatedAt.slice(0, 10)} ·{' '}
                {statusName(m.status)}
              </small>
              <footer>
                <button onClick={() => open(m, 'history')}>
                  <History size={13} />
                  历史版本
                </button>
                <button onClick={() => open(m, 'edit')}>编辑</button>
              </footer>
            </div>
          </article>
        ))}
      </section>
      {!loading && !error && !items.length && (
        <div className="mat-empty">
          <FolderOpen size={30} />
          <p>
            {search || categories.length || format || site || status !== 'active'
              ? '没有符合条件的素材'
              : '尚未上传素材'}
          </p>
        </div>
      )}
      <footer className="mat-pages">
        <span>
          共 {data?.total || 0} 条 · 第 {data?.page || 1} / {pages} 页
        </span>
        <div>
          <select
            aria-label="每页条数"
            value={size}
            onChange={(e) => {
              setSize(Number(e.target.value));
              setPage(1);
            }}
          >
            {[10, 20, 50].map((n) => (
              <option value={n} key={n}>
                {n} 条/页
              </option>
            ))}
          </select>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            下一页
          </button>
        </div>
      </footer>
      {id && (
        <MaterialDialog
          key={id}
          id={id}
          initialView={dialogView}
          onClose={() => showId('')}
          onChanged={refresh}
        />
      )}
      {editing && (
        <dialog
          ref={bulkDialog}
          className="mat-dialog compact"
          aria-label="批量编辑素材"
          onCancel={() => setEditing(false)}
        >
          <h2>分配与归类</h2>
          <form
            className="mat-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget),
                changes: Record<string, string> = {};
              if (f.get('category')) changes.category = String(f.get('category'));
              if (f.get('site') !== '__keep__') changes.site = String(f.get('site'));
              if (Object.keys(changes).length) void bulk(changes);
            }}
          >
            <label>
              所属官网
              <select aria-label="所属官网" name="site" defaultValue="__keep__">
                <option value="__keep__">保持原设置</option>
                <option value="">未分配</option>
                {data?.sites.map((s) => (
                  <option value={s.site} key={s.site}>
                    {s.brand}
                  </option>
                ))}
              </select>
            </label>
            <label>
              品类
              <input name="category" placeholder="留空保持原设置" maxLength={100} />
            </label>
            {error && <p role="alert">{error}</p>}
            <div className="mat-actions">
              <button type="button" onClick={() => setEditing(false)}>
                取消
              </button>
              <button className="mat-primary" disabled={busy}>
                保存
              </button>
            </div>
          </form>
        </dialog>
      )}
    </main>
  );
}
