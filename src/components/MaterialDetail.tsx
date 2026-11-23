import { useEffect, useRef, useState } from 'react';
import { X, FileText, Download, History } from 'lucide-react';
import { WorkbookPreview } from './WorkbookPreview';
import {
  acceptMaterials,
  fileSize,
  materialsRequest,
  sendJson,
  sourceUrl,
  statusName,
  uploadMaterial,
  messageOf,
  type Reference,
  type Correction,
  type StoredDocument,
  type MaterialDetail as Detail,
} from '../services/materials';

export type MaterialView = 'preview' | 'edit' | 'history';
export function MaterialDialog({
  id,
  initialView,
  onClose,
  onChanged,
}: {
  id: string;
  initialView: MaterialView;
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    upload = useRef<HTMLInputElement>(null);
  const [view, setView] = useState(initialView),
    [revision, setRevision] = useState(''),
    [reload, setReload] = useState(0),
    [data, setData] = useState<Detail | null>(null),
    [docId, setDocId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [edits, setEdits] = useState<Correction[]>([]),
    [facts, setFacts] = useState<Reference[]>([]);
  const [pdfProgress, setPdfProgress] = useState(''),
    [pdfAttempt, retryPdf] = useState(0);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setData(null);
    materialsRequest<Detail>('/' + id + (revision ? '?revision=' + revision : ''), {
      signal: controller.signal,
    })
      .then((d) => {
        if (controller.signal.aborted) return;
        setData(d);
        setDocId((old) =>
          d.documents.some((doc) => doc.id === old) ? old : d.documents[0]?.id || '',
        );
        setFacts(d.product.sourceFacts || []);
        setEdits(d.product.cellEdits || []);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      });
    return () => controller.abort();
  }, [id, revision, reload]);
  const p = data?.product,
    doc = data?.documents.find((d) => d.id === docId),
    active = p?.version === data?.currentVersion;
  const pdfToRead =
    view === 'preview' &&
    active &&
    p?.status !== 'archived' &&
    doc?.contentType === 'application/pdf' &&
    !doc.extraction?.facts.length
      ? doc.id
      : '';
  useEffect(() => {
    if (!pdfToRead) return;
    const controller = new AbortController();
    setPdfProgress('正在提取 PDF 文字和图片…');
    setError('');
    void materialsRequest(
      '/' + id + '/extract/' + pdfToRead,
      {
        method: 'POST',
        headers: { Prefer: 'respond-async' },
        signal: controller.signal,
      },
      (page, total) => {
        if (!controller.signal.aborted)
          setPdfProgress('正在提取第 ' + page + ' / ' + total + ' 页');
      },
    )
      .then(() => materialsRequest<Detail>('/' + id, { signal: controller.signal }))
      .then((next) => {
        if (controller.signal.aborted) return;
        const parsed = next.documents.find((d) => d.id === pdfToRead);
        if (parsed)
          setData(
            (prior) =>
              prior && {
                ...prior,
                documents: prior.documents.map((d) => (d.id === pdfToRead ? parsed : d)),
              },
          );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(messageOf(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPdfProgress('');
      });
    return () => controller.abort();
  }, [id, pdfToRead, pdfAttempt]);
  async function perform(action: () => Promise<unknown>, message: string) {
    if (busy) return;
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
      setNotice(warning ? message + '。' + warning : message);
      setRevision('');
      setReload((r) => r + 1);
      onChanged();
    } catch (e) {
      setError(messageOf(e));
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
  const reviewFields = { adoptDocumentId: docId, cellEdits: edits, sourceFacts: facts };
  const incompleteFact = facts.some((f) => !f.text.trim() || !f.location.trim());
  const passages = (doc?.extraction?.facts || []).map((f) => ({
    documentId: docId,
    location:
      doc?.contentType === 'application/pdf' ? '第 ' + f.page + ' 页 · ' + f.location : f.location,
    text: f.text,
  }));
  function adopt(selected: Reference[]) {
    const next = [...facts];
    for (const item of selected) {
      if (
        !next.some(
          (f) =>
            f.documentId === item.documentId &&
            f.location === item.location &&
            f.text === item.text,
        )
      )
        next.push(item);
    }
    if (next.length > 200) return setError('最多可采用 200 个片段，请逐条选择需要引用的内容');
    setError('');
    setFacts(next);
  }
  const modeLabel: Record<MaterialView, string> = {
    preview: '原件与校对',
    edit: '编辑资料',
    history: '历史版本',
  };
  return (
    <dialog
      ref={dialog}
      className="mat-dialog"
      aria-label="素材详情"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <h2>{p?.name || '素材详情'}</h2>
          {p && (
            <small>
              {statusName(p.status)} · v{p.version} · {data?.sites.join('、') || '未分配官网'}
            </small>
          )}
        </div>
        <button type="button" className="mat-icon" aria-label="关闭素材详情" onClick={onClose}>
          <X size={19} />
        </button>
      </header>
      <nav>
        {(Object.keys(modeLabel) as MaterialView[]).map((v) => (
          <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
            {v === 'history' && <History size={14} />} {modeLabel[v]}
          </button>
        ))}
      </nav>
      {notice && (
        <p className="mat-note" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="mat-error" role="alert">
          {error}
        </p>
      )}
      {p && data ? (
        <div className="mat-dialog-body">
          {view === 'history' && (
            <section className="mat-form">
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
              className="mat-form"
              key={p.version}
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const site = String(f.get('site') || '');
                void save(
                  {
                    name: f.get('name'),
                    category: f.get('category'),
                    keywords: String(f.get('keywords') || '')
                      .split(/[,，、]/u)
                      .map((x) => x.trim())
                      .filter(Boolean),
                    ...(site === '__keep__' ? {} : { site }),
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
              <label>
                所属官网
                <select
                  aria-label="所属官网"
                  name="site"
                  defaultValue="__keep__"
                  disabled={!writable}
                >
                  <option value="__keep__">{data.sites.join('、') || '未分配'} · 保持原设置</option>
                  <option value="">未分配</option>
                  {data.siteOptions.map((s) => (
                    <option key={s.site} value={s.site}>
                      {s.brand} · {s.site}
                    </option>
                  ))}
                </select>
              </label>
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
              <button className="mat-primary" disabled={!writable}>
                保存修改
              </button>
            </form>
          )}
          {view === 'preview' && (
            <>
              {data.documents.length > 1 && (
                <label>
                  原始文件
                  <select value={docId} onChange={(e) => setDocId(e.target.value)}>
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
                  <div className="mat-filebar">
                    <span>
                      <FileText size={17} /> {doc.name} · {fileSize(doc.size)}
                    </span>
                    <a href={original + '?download=1'} download>
                      <Download size={14} />
                      下载原件
                    </a>
                  </div>
                  {doc.extraction?.sheets ? (
                    <WorkbookPreview
                      key={doc.id}
                      url={original}
                      id={doc.id}
                      sheets={doc.extraction.sheets}
                      edits={edits}
                      onEdit={changeCell}
                      linked={!!writable}
                    />
                  ) : (
                    <div className="mat-compare">
                      <div>
                        <h3>原件预览</h3>
                        <Original doc={doc} url={original} />
                      </div>
                      <div>
                        <h3>引用片段</h3>
                        {doc.extraction?.pageCount && (
                          <p>
                            原件共 {doc.extraction.pageCount} 页，已提取 {passages.length}{' '}
                            个候选片段。请对照原页核对后采用。
                          </p>
                        )}
                        {pdfToRead &&
                          (pdfProgress ? (
                            <p role="status">{pdfProgress}</p>
                          ) : (
                            <button type="button" onClick={() => retryPdf((n) => n + 1)}>
                              重新提取 PDF
                            </button>
                          ))}
                        {writable && passages.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              adopt(
                                passages.filter(
                                  (p) =>
                                    !facts.some(
                                      (f) =>
                                        f.documentId === p.documentId && f.location === p.location,
                                    ),
                                ),
                              )
                            }
                          >
                            采用全部识别片段
                          </button>
                        )}
                        {doc.extraction?.facts.map((f, i) => (
                          <div className="mat-evidence" key={i}>
                            <small>
                              {doc.contentType === 'application/pdf' || f.page > 1
                                ? '第 ' + f.page + ' 页 · '
                                : ''}
                              {f.location}
                            </small>
                            <p>{f.text}</p>
                            {writable && (
                              <button type="button" onClick={() => adopt([passages[i]])}>
                                采用片段
                              </button>
                            )}
                          </div>
                        ))}
                        {!pdfToRead && (!doc.extraction || !doc.extraction.facts.length) && (
                          <p>对照原件填写可引用的内容和位置。</p>
                        )}
                        {writable && !pdfToRead && !doc.extraction && (
                          <button
                            type="button"
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
                            {doc.contentType.startsWith('image/')
                              ? '使用已配置的 AI 提取'
                              : '重新提取'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {doc.extraction?.warnings.map((m, n) => (
                    <p className="mat-note" key={n}>
                      {m}
                    </p>
                  ))}
                  {!doc.extraction?.sheets && (
                    <section>
                      <h3>已核对引用</h3>
                      {facts.map((f, n) =>
                        f.documentId === doc.id ? (
                          <div className="mat-fact mat-form" key={n}>
                            <label>
                              原件位置
                              <input
                                required
                                maxLength={240}
                                value={f.location}
                                disabled={!writable}
                                onChange={(e) =>
                                  setFacts((prev) =>
                                    prev.map((a, i) =>
                                      i === n ? { ...a, location: e.target.value } : a,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <label>
                              引用内容
                              <textarea
                                rows={2}
                                value={f.text}
                                disabled={!writable}
                                onChange={(e) =>
                                  setFacts((prev) =>
                                    prev.map((a, i) =>
                                      i === n ? { ...a, text: e.target.value } : a,
                                    ),
                                  )
                                }
                              />
                            </label>
                            {writable && (
                              <button
                                onClick={() => setFacts((prev) => prev.filter((_, i) => i !== n))}
                              >
                                移除片段
                              </button>
                            )}
                          </div>
                        ) : null,
                      )}
                      {writable && (
                        <button
                          onClick={() =>
                            setFacts((prev) => [
                              ...prev,
                              { documentId: doc.id, location: '', text: '' },
                            ])
                          }
                        >
                          添加核对片段
                        </button>
                      )}
                    </section>
                  )}
                  {writable && (
                    <button
                      className="mat-primary"
                      onClick={() => void save(reviewFields, '校对已保存')}
                      disabled={incompleteFact}
                    >
                      保存校对
                    </button>
                  )}
                </>
              ) : (
                <div>
                  <p>{p.specifications || '尚无原件'}</p>
                  {[p.sourceUrl, ...p.attachments].filter(Boolean).map((u) => (
                    <p key={u}>
                      <a href={u} target="_blank" rel="noreferrer">
                        {u}
                      </a>
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
          {active && (
            <footer className="mat-manage">
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
                        { id, version: p.version },
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
                          ...(doc ? reviewFields : {}),
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
                      busy || incompleteFact || (!doc && !p.sourceUrl && !p.attachments.length)
                    }
                  >
                    审核通过
                  </button>
                </form>
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
      ) : (
        !error && <p>正在读取资料…</p>
      )}
    </dialog>
  );
}
function PdfOriginal({ name, url }: { name: string; url: string }) {
  const [inlineUrl, setInlineUrl] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { headers: { Range: 'bytes=0-0' }, signal: controller.signal })
      .then(async (response) => {
        await response.body?.cancel();
        if (
          !controller.signal.aborted &&
          response.ok &&
          !/deny/i.test(response.headers.get('X-Frame-Options') || '')
        )
          setInlineUrl(url);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [url]);
  return inlineUrl === url ? (
    <iframe title={name} src={url} />
  ) : (
    <a href={url} target="_blank" rel="noopener noreferrer">
      在新窗口查看 PDF 原件
    </a>
  );
}
function Original({ doc, url }: { doc: StoredDocument; url: string }) {
  if (doc.contentType.startsWith('image/')) return <img src={url} alt={doc.name} />;
  if (doc.contentType.startsWith('video/')) return <video src={url} controls preload="metadata" />;
  if (doc.contentType === 'application/pdf') return <PdfOriginal name={doc.name} url={url} />;
  if (doc.extraction?.facts.length)
    return (
      <div className="mat-original">
        {doc.extraction.facts.map((f, n) => (
          <p key={n}>
            <small>{f.location}</small>
            <br />
            {f.text}
          </p>
        ))}
      </div>
    );
  return (
    <a href={url + '?download=1'} download>
      下载原件核对
    </a>
  );
}
