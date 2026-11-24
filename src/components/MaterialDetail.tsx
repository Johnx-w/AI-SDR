import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Download,
  FileText,
  History,
  Info,
  PanelRightOpen,
  Settings2,
  Layers,
  X,
} from 'lucide-react';
import { MaterialParseMode, modeLabel } from './MaterialParseMode';
import { isPagedMaterial } from '../domain/material-upload.mjs';
import { MaterialOriginal } from './MaterialOriginal';
import { MaterialPassages } from './MaterialPassages';
import { ParameterReview } from './ParameterReview';
import { WorkbookPhotos } from './WorkbookPhotos';
import { WorkbookPreview } from './WorkbookPreview';
import {
  type ParseMode,
  acceptMaterials,
  attachParameterSource,
  fileSize,
  materialsRequest,
  sendJson,
  sourceUrl,
  statusName,
  uploadMaterial,
  messageOf,
  type Reference,
  type Correction,
  type MaterialDetail as Detail,
} from '../services/materials';

type MaterialView = 'preview' | 'edit' | 'history';
export function MaterialDocument({
  id,
  initialPage,
  initialRevision = '',
  initialParameter = '',
  showPhotos = false,
  openSource,
  onClose,
  onChanged,
}: {
  id: string;
  initialPage: number;
  initialRevision?: string;
  initialParameter?: string;
  showPhotos?: boolean;
  openSource: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [workbookView, setWorkbookView] = useState<'rows' | 'photos'>(
    showPhotos ? 'photos' : 'rows',
  );
  const upload = useRef<HTMLInputElement>(null);
  const [side, setSide] = useState<'info' | 'original'>(openSource ? 'original' : 'info');
  const [mobileSide, setMobileSide] = useState(openSource);
  const [view, setView] = useState<MaterialView>('preview'),
    [revision, setRevision] = useState(initialRevision),
    [data, setData] = useState<Detail | null>(null),
    [docId, setDocId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [parameterKeys, setParameterKeys] = useState<string[]>([]);
  const [edits, setEdits] = useState<Correction[]>([]);
  const [editingChunk, setEditingChunk] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(''),
    [modeOverride, setModeOverride] = useState<ParseMode | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setData(null);
    materialsRequest<Detail>('/' + id + (revision ? '?revision=' + revision : ''), {
      signal: controller.signal,
    })
      .then((d) => {
        if (controller.signal.aborted) return;
        display(d);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      });
    return () => controller.abort();
  }, [id, revision]);
  function display(d: Detail) {
    setData(d);
    setDocId((old) => (d.documents.some((doc) => doc.id === old) ? old : d.documents[0]?.id || ''));
    setEdits(d.product.cellEdits || []);
    const candidates = d.documents[0]?.extraction?.parameters || [];
    const confirmed = new Set(d.confirmedParameters?.map((p) => p.key));
    setParameterKeys(
      (initialParameter && d.confirmedParameters?.length ? d.confirmedParameters : candidates)
        .filter((p) => (confirmed.size ? confirmed.has(p.key) : !p.issue))
        .map((p) => p.key),
    );
  }
  const p = data?.product,
    doc = data?.documents.find((d) => d.id === docId),
    active = p?.version === data?.currentVersion;
  const structured = doc?.parseMode === 'model_parameters';
  const visual = !doc?.referencePages && (structured || isPagedMaterial(doc?.contentType));
  const storedMode = doc?.extraction?.mode ?? doc?.parseMode ?? 'rich_layout_recognition';
  const parseMode = modeOverride ?? storedMode;
  useEffect(() => setModeOverride(null), [docId, revision]);
  const ocrDocument =
    view === 'preview' &&
    active &&
    p?.status !== 'archived' &&
    doc &&
    visual &&
    !doc.extraction?.facts.length &&
    !doc.extraction?.parameters &&
    doc.extraction?.model !== 'failed'
      ? doc.id
      : '';
  useEffect(() => {
    if (!ocrDocument) {
      setOcrProgress('');
      return;
    }
    const controller = new AbortController();
    setOcrProgress('正在识别原件中的文字…');
    setError('');
    void materialsRequest(
      '/' + id + '/extract/' + ocrDocument,
      {
        method: 'POST',
        headers: { Prefer: 'respond-async' },
        signal: controller.signal,
      },
      (page, total) => {
        if (!controller.signal.aborted)
          setOcrProgress('正在提取第 ' + page + ' / ' + total + ' 页');
      },
    )
      .then(() => materialsRequest<Detail>('/' + id, { signal: controller.signal }))
      .then((next) => {
        if (controller.signal.aborted) return;
        const parsed = next.documents.find((d) => d.id === ocrDocument);
        if (parsed) {
          onChanged();
          setData(
            (prior) =>
              prior && {
                ...prior,
                documents: prior.documents.map((d) => (d.id === ocrDocument ? parsed : d)),
              },
          );
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(messageOf(error));
          onChanged();
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setOcrProgress('');
      });
    return () => controller.abort();
  }, [id, ocrDocument, onChanged]);
  async function perform(action: () => Promise<unknown>, message: string) {
    if (busy) return false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await action();
      const warning =
        result &&
        typeof result === 'object' &&
        'warning' in result &&
        typeof result.warning === 'string'
          ? result.warning
          : '';
      display(await materialsRequest<Detail>('/' + id));
      setNotice(warning ? message + '。' + warning : message);
      setRevision('');
      onChanged();
      return true;
    } catch (e) {
      setError(messageOf(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  function save(fields: Record<string, unknown>, message: string) {
    return perform(() => sendJson('/' + id, 'PATCH', { ...fields, version: p?.version }), message);
  }
  function changeCell(e: Correction, original: string) {
    setEdits((values) => [
      ...values.filter(
        (v) => !(v.documentId === e.documentId && v.ref === e.ref && v.sheet === e.sheet),
      ),
      ...(original === e.value ? [] : [e]),
    ]);
  }
  const writable = active && p?.status !== 'archived' && !busy;
  const original = doc ? sourceUrl(id, doc.id) : '';
  const facts = p?.sourceFacts || [];
  const reviewFields = { adoptDocumentId: docId, cellEdits: edits, sourceFacts: facts };
  const incompleteFact = facts.some((f) => !f.text.trim() || !f.location.trim());
  const firstPage = Math.min(initialPage, doc?.extraction?.pageCount || 1);
  const [sourcePage, setSourcePage] = useState(firstPage);
  useEffect(() => {
    setSourcePage(firstPage);
    setEditingChunk(false);
  }, [docId, revision, firstPage]);
  function saveFacts(next: Reference[], message: string) {
    if (next.length > 200) {
      setError('最多可采用 200 个片段，请逐条选择需要引用的内容');
      return Promise.resolve(false);
    }
    return save({ ...reviewFields, sourceFacts: next }, message);
  }
  function closeReader() {
    if (!editingChunk || window.confirm('放弃尚未保存的片段修改？')) onClose();
  }
  function viewOriginal(page: number) {
    setSourcePage(page);
    setSide('original');
    setMobileSide(true);
  }
  return (
    <section
      aria-label="素材详情"
      className={'kb-workspace kb-document' + (side === 'original' ? ' kb-show-source' : '')}
    >
      <div className="kb-surface">
        <header className="kb-titlebar">
          <button className="kb-back" onClick={closeReader} aria-label="返回素材库">
            <ArrowLeft size={16} />
            <span>素材库</span>
          </button>
          <ChevronRight size={14} />
          <span className="kb-crumb">集合数据</span>
          <button
            className="kb-mobile-info kb-icon"
            onClick={() => setMobileSide(!mobileSide)}
            aria-expanded={mobileSide}
            aria-label="文件信息"
          >
            <Info size={17} />
          </button>
        </header>
        {p && data && (
          <header className="kb-document-head">
            <span
              className="kb-file-icon"
              data-format={doc?.contentType === 'application/pdf' ? 'PDF' : ''}
            >
              <FileText size={23} />
            </span>
            <h1>{doc?.name || p.name}</h1>
            {doc && !doc.extraction?.sheets && (
              <button
                className="kb-secondary"
                onClick={() => {
                  setSide(side === 'original' ? 'info' : 'original');
                  setMobileSide(side !== 'original');
                }}
                aria-pressed={side === 'original'}
              >
                <PanelRightOpen size={15} />
                {side === 'original' ? '收起原文' : '查看原文'}
              </button>
            )}
          </header>
        )}
        {notice && (
          <p role="status" className="kb-notice">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="kb-error">
            {error}
          </p>
        )}
        {p && data ? (
          <div className="kb-document-body">
            {view !== 'preview' && (
              <button className="kb-text" onClick={() => setView('preview')}>
                <ArrowLeft size={14} />
                返回集合数据
              </button>
            )}
            {view === 'history' && (
              <section className="kb-form">
                <label>
                  查看版本
                  <select value={p.version} onChange={(e) => setRevision(e.target.value)}>
                    {data.history.map((v) => (
                      <option key={v} value={v}>
                        v{v}
                        {v === data.currentVersion ? ' · 当前版本' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  {p.name} · {statusName(p.status)} · {p.materialCategory || '未分类'}
                </p>
                {data.documents.map((d) => (
                  <p key={d.id}>
                    {d.name} · {fileSize(d.size)} · {new Date(d.createdAt).toLocaleDateString()}
                  </p>
                ))}
                <button type="button" onClick={() => setView('preview')}>
                  查看所选版本原件
                </button>
                {!active && (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      void perform(
                        () =>
                          sendJson('/' + id + '/restore', 'POST', {
                            revision: p.version,
                            version: data.currentVersion,
                          }),
                        '已恢复为待审核版本',
                      )
                    }
                  >
                    恢复为新版本
                  </button>
                )}
              </section>
            )}
            {view === 'edit' && (
              <form
                className="kb-form"
                key={p.version}
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  const site = String(f.get('site') || '');
                  const sites = f.getAll('sites').map(String).sort();
                  void save(
                    {
                      name: f.get('name'),
                      category: f.get('category'),
                      keywords: String(f.get('keywords') || '')
                        .split(/[,，、]/u)
                        .map((x) => x.trim())
                        .filter(Boolean),
                      ...(p.materialOnly
                        ? JSON.stringify(sites) === JSON.stringify([...data.sites].sort())
                          ? {}
                          : { sites }
                        : site === '__keep__'
                          ? {}
                          : { site }),
                    },
                    '资料已保存',
                  );
                }}
              >
                <label>
                  素材名称
                  <input
                    required
                    name="name"
                    maxLength={160}
                    defaultValue={p.name}
                    disabled={!writable}
                  />
                </label>
                {p.materialOnly ? (
                  <fieldset className="kb-brand-scope" disabled={!writable}>
                    <legend>适用品牌</legend>
                    {data.siteOptions.map((s) => (
                      <label key={s.site}>
                        <input
                          name="sites"
                          type="checkbox"
                          value={s.site}
                          defaultChecked={data.sites.includes(s.site)}
                        />
                        {s.brand} · {s.site}
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <label>
                    所属官网
                    <select
                      aria-label="所属官网"
                      name="site"
                      defaultValue="__keep__"
                      disabled={!writable}
                    >
                      <option value="__keep__">
                        {data.sites.join('、') || '未分配'} · 保持原设置
                      </option>
                      <option value="">未分配</option>
                      {data.siteOptions.map((s) => (
                        <option key={s.site} value={s.site}>
                          {s.brand} · {s.site}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  品类
                  <input
                    name="category"
                    maxLength={100}
                    defaultValue={p.materialCategory || '未分类'}
                    disabled={!writable}
                  />
                </label>
                <label>
                  关键词
                  <input
                    name="keywords"
                    maxLength={1000}
                    placeholder="用逗号分隔"
                    defaultValue={p.keywords?.join('，')}
                    disabled={!writable}
                  />
                </label>
                <button className="kb-primary" disabled={!writable}>
                  保存修改
                </button>
              </form>
            )}
            {view === 'preview' && (
              <>
                {data.documents.length > 1 && (
                  <label>
                    原始文件
                    <select
                      value={docId}
                      disabled={editingChunk || busy}
                      onChange={(e) => setDocId(e.target.value)}
                    >
                      {data.documents.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {doc ? (
                  <>
                    {ocrDocument && ocrProgress ? (
                      <p className="kb-notice" role="status">
                        {ocrProgress}
                      </p>
                    ) : (
                      writable &&
                      !visual &&
                      !doc.extraction?.facts.length &&
                      !doc.extraction?.sheets &&
                      doc.extraction?.model !== 'manual' && (
                        <button
                          onClick={() =>
                            void perform(
                              () =>
                                materialsRequest('/' + id + '/extract/' + doc.id, {
                                  method: 'POST',
                                }),
                              '已提取原件',
                            )
                          }
                        >
                          重新提取
                        </button>
                      )
                    )}
                    {doc.referencePages ? (
                      <MaterialOriginal doc={doc} url={original} page={sourcePage} />
                    ) : structured && doc.extraction?.parameters ? (
                      <ParameterReview
                        key={doc.id + revision}
                        initialKey={initialParameter}
                        parameterSet={p.parameterSet}
                        parameters={
                          (!active || !!initialParameter) && data.confirmedParameters?.length
                            ? data.confirmedParameters
                            : doc.extraction.parameters
                        }
                        selected={parameterKeys}
                        disabled={!writable || !!initialParameter}
                        onSelect={setParameterKeys}
                        original={original}
                        documents={data.documents}
                        onAttach={(file) =>
                          void perform(
                            () => attachParameterSource(id, p.version, file),
                            '已关联来源原件',
                          )
                        }
                      />
                    ) : doc.extraction?.model === 'manual' &&
                      !facts.some((f) => f.documentId === doc.id) ? (
                      <MaterialOriginal doc={doc} url={original} page={1} />
                    ) : doc.extraction?.sheets ? (
                      <>
                        <div className="photo-controls" aria-label="工作簿视图">
                          <button
                            className="kb-text"
                            aria-pressed={workbookView === 'rows'}
                            onClick={() => setWorkbookView('rows')}
                          >
                            价格表数据
                          </button>
                          <button
                            className="kb-text"
                            aria-pressed={workbookView === 'photos'}
                            onClick={() => setWorkbookView('photos')}
                          >
                            产品图片
                          </button>
                        </div>
                        {workbookView === 'photos' ? (
                          <WorkbookPhotos
                            key={doc.id + revision}
                            product={id}
                            doc={doc.id}
                            sheets={doc.extraction.sheets}
                            writable={!!writable && p.documentIds?.[0] === doc.id}
                          />
                        ) : (
                          <>
                            <WorkbookPreview
                              key={doc.id}
                              url={original}
                              id={doc.id}
                              sheets={doc.extraction.sheets}
                              edits={edits}
                              onEdit={changeCell}
                              linked={!!writable}
                            />
                            {writable && (
                              <button
                                className="kb-primary"
                                onClick={() => void save(reviewFields, '校对已保存')}
                                disabled={incompleteFact}
                              >
                                保存校对
                              </button>
                            )}
                          </>
                        )}
                      </>
                    ) : (
                      <MaterialPassages
                        key={doc.id}
                        doc={doc}
                        facts={facts}
                        writable={!!writable}
                        page={sourcePage}
                        initialPage={firstPage}
                        original={original}
                        onPage={viewOriginal}
                        onSave={saveFacts}
                        onEditing={setEditingChunk}
                      />
                    )}
                    {doc.extraction?.warnings.map((m, n) => (
                      <p className="kb-notice" key={n}>
                        {m}
                      </p>
                    ))}
                  </>
                ) : (
                  <>
                    <p>{p.specifications || '尚无原件'}</p>
                    {[p.sourceUrl, ...p.attachments].filter(Boolean).map((u) => (
                      <p key={u}>
                        <a href={u} target="_blank" rel="noreferrer">
                          {u}
                        </a>
                      </p>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        ) : (
          !error && <p className="kb-empty">正在读取文件…</p>
        )}
      </div>
      <aside aria-label="文件侧栏" className={'kb-aside' + (mobileSide ? ' kb-aside-open' : '')}>
        {side === 'original' && doc ? (
          <>
            <header className="kb-side-title">
              <h2>
                <BookOpen size={17} />
                原文预览
              </h2>
              <button
                className="kb-icon"
                aria-label="关闭原文"
                onClick={() => {
                  setSide('info');
                  setMobileSide(false);
                }}
              >
                <X size={16} />
              </button>
            </header>
            <div className="kb-original">
              {doc.contentType === 'application/pdf' && <small>第 {sourcePage} 页</small>}
              <MaterialOriginal doc={doc} url={original} page={sourcePage} />
            </div>
          </>
        ) : (
          p &&
          data && (
            <>
              <header className="kb-side-title">
                <h2>
                  <Info size={17} />
                  文件信息
                </h2>
                <button
                  className="kb-mobile-info kb-icon"
                  aria-label="关闭文件信息"
                  onClick={() => setMobileSide(false)}
                >
                  <X size={16} />
                </button>
              </header>
              <div className="kb-side-section">
                <h3>
                  <FileText size={15} />
                  集合信息
                </h3>
                <dl>
                  <dt>文件名称</dt>
                  <dd>{doc?.name || p.name}</dd>
                  <dt>当前查看</dt>
                  <dd>v{p.version}</dd>
                  <dt>文件大小</dt>
                  <dd>{doc ? fileSize(doc.size) : '—'}</dd>
                  <dt>官网</dt>
                  <dd>{data.sites.join('、') || '未分配'}</dd>
                  <dt>审核状态</dt>
                  <dd>{statusName(p.status)}</dd>
                </dl>
                {doc?.extraction?.mode && (
                  <p>
                    {doc.extraction.model === 'failed' ? '上次尝试' : '最近解析'} ·{' '}
                    {doc.extraction.model} · {modeLabel(doc.extraction.mode)}
                  </p>
                )}
                {doc && (
                  <a className="kb-side-action" href={original + '?download=1'} download>
                    <Download size={15} />
                    下载原件
                  </a>
                )}
              </div>
              <div className="kb-side-section">
                <h3>
                  <Layers size={15} />
                  文件管理
                </h3>
                <button
                  className="kb-side-action"
                  disabled={busy || editingChunk}
                  onClick={() => {
                    setView('edit');
                    setMobileSide(false);
                  }}
                >
                  <Settings2 size={15} />
                  编辑资料
                </button>
                <button
                  className="kb-side-action"
                  disabled={busy || editingChunk}
                  onClick={() => {
                    setView('history');
                    setMobileSide(false);
                  }}
                >
                  <History size={15} />
                  历史版本
                </button>
                {active && !doc?.referencePages && (
                  <footer className="kb-manage" inert={editingChunk}>
                    {p.status !== 'archived' && visual && (
                      <>
                        {!structured && (
                          <MaterialParseMode
                            generalOnly
                            value={parseMode}
                            onChange={setModeOverride}
                            disabled={busy || !!ocrDocument}
                          />
                        )}
                        {visual && doc && (
                          <button
                            type="button"
                            disabled={busy || !!ocrDocument}
                            onClick={() =>
                              void perform(async () => {
                                setNotice('正在使用 DeepSeek 解析…');
                                return materialsRequest(
                                  '/' + id + '/extract/' + doc.id + '?reparse=1&mode=' + parseMode,
                                  { method: 'POST', headers: { Prefer: 'respond-async' } },
                                  (n, total) =>
                                    setNotice('正在解析第 ' + n + ' / ' + total + ' 页'),
                                );
                              }, '解析结果已更新，请核对片段')
                            }
                          >
                            重新解析
                          </button>
                        )}
                      </>
                    )}

                    <input
                      type="file"
                      ref={upload}
                      hidden
                      accept={acceptMaterials}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file)
                          void perform(async () => {
                            const r = await uploadMaterial(
                              file,
                              { id, version: p.version, mode: parseMode },
                              crypto.randomUUID(),
                              (page, total) =>
                                setNotice('正在提取新版第 ' + page + ' / ' + total + ' 页'),
                            );
                            return r;
                          }, '已保存新版本');
                      }}
                    />
                    {p.status !== 'archived' && (
                      <button type="button" disabled={busy} onClick={() => upload.current?.click()}>
                        上传新版本
                      </button>
                    )}
                    {p.status === 'draft' && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const reviewer = String(
                            new FormData(e.currentTarget).get('reviewer') || '',
                          ).trim();
                          if (reviewer)
                            void save(
                              {
                                status: 'approved',
                                approvedBy: reviewer,
                                ...(structured ? { parameterKeys } : doc ? reviewFields : {}),
                              },
                              '已审核通过',
                            );
                        }}
                      >
                        <input
                          required
                          name="reviewer"
                          aria-label="审核人"
                          placeholder="审核人姓名"
                          maxLength={100}
                        />
                        <button
                          disabled={
                            busy ||
                            editingChunk ||
                            (data.documents[0]?.parseMode === 'model_parameters' &&
                              (!structured || !parameterKeys.length)) ||
                            incompleteFact ||
                            (!doc && !p.sourceUrl && !p.attachments.length)
                          }
                        >
                          审核通过
                        </button>
                      </form>
                    )}
                    {structured && p.status === 'approved' && (
                      <button
                        disabled={busy || !parameterKeys.length}
                        onClick={() =>
                          void save(
                            { parameterKeys, status: 'draft' },
                            '所选参数已保存，请重新审核',
                          )
                        }
                      >
                        修改已采用参数
                      </button>
                    )}
                    {p.status === 'approved' && <small>审核人 {p.approvedBy}</small>}
                    <button
                      disabled={busy}
                      type="button"
                      onClick={() =>
                        void save(
                          { status: p.status === 'archived' ? 'draft' : 'archived' },
                          p.status === 'archived' ? '已恢复至待审核' : '已撤回',
                        )
                      }
                    >
                      {p.status === 'archived' ? '恢复资料' : '撤回资料'}
                    </button>
                  </footer>
                )}
              </div>
            </>
          )
        )}
      </aside>
    </section>
  );
}
