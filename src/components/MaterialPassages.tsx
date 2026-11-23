import { useEffect, useRef, useState } from 'react';
import { AlignLeft, BookOpen, Check, FileText, List, Pencil, Plus, Search, X } from 'lucide-react';
import { MaterialOriginal } from './MaterialOriginal';
import type { Reference, StoredDocument } from '../services/materials';
type Passage = {
  key: string;
  location: string;
  text: string;
  raw?: string;
  page?: number;
  index: number;
};

function passagesFor(doc: StoredDocument, facts: Reference[]) {
  const used = new Set<number>();
  const pdf = doc.contentType === 'application/pdf';
  const extracted = doc.extraction?.facts || [];
  const locations = extracted.map((f) =>
    pdf ? '第 ' + f.page + ' 页 · ' + f.location : f.location,
  );
  const unique = new Set<string>(),
    duplicate = new Set<string>();
  for (const location of locations) {
    if (unique.has(location)) duplicate.add(location);
    unique.add(location);
  }
  const rows: Passage[] = extracted.map((f, n) => {
    const location = locations[n];
    const index = facts.findIndex(
      (v, i) =>
        !used.has(i) &&
        v.documentId === doc.id &&
        v.location === location &&
        (!duplicate.has(location) || v.text === f.text),
    );
    if (index >= 0) used.add(index);
    return {
      key: 'extracted-' + n,
      index,
      location,
      page: pdf ? f.page : undefined,
      raw: f.text,
      text: facts[index]?.text ?? f.text,
    };
  });
  facts.forEach((f, index) => {
    if (f.documentId !== doc.id || used.has(index)) return;
    const page = pdf && /^第\s*(\d+)\s*页/u.exec(f.location)?.[1];
    rows.push({
      key: 'manual-' + index,
      index,
      location: f.location,
      text: f.text,
      page: page ? Number(page) : undefined,
    });
  });
  return rows;
}

type Props = {
  doc: StoredDocument;
  facts: Reference[];
  writable: boolean;
  page: number;
  initialPage: number;
  original: string;
  onPage: (page: number) => void;
  onEditing: (editing: boolean) => void;
  onSave: (facts: Reference[], notice: string) => Promise<boolean>;
};
export function MaterialPassages({
  doc,
  facts,
  writable,
  page,
  initialPage,
  original,
  onPage,
  onEditing,
  onSave,
}: Props) {
  const [query, setQuery] = useState(initialPage > 1 ? '第 ' + initialPage + ' 页' : ''),
    [usedOnly, setUsedOnly] = useState(false),
    [limit, setLimit] = useState(20);
  const [editor, setEditor] = useState<Passage | null>(null),
    [compare, setCompare] = useState(false),
    [editError, setEditError] = useState('');
  const modal = useRef<HTMLDialogElement>(null);
  const rows = passagesFor(doc, facts),
    used = rows.filter((v) => v.index >= 0).length,
    needle = query.trim().toLocaleLowerCase();
  const matches = rows
    .map((row, i) => ({ row, i }))
    .filter(
      ({ row }) =>
        (!usedOnly || row.index >= 0) &&
        (!needle ||
          [row.location, row.text, row.raw].some((s) => s?.toLocaleLowerCase().includes(needle))),
    );
  const loadMore = useRef<HTMLButtonElement>(null);
  const hasMore = matches.length > limit;
  useEffect(() => {
    const el = loadMore.current;
    if (!el || !hasMore || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setLimit((n) => n + 20);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, limit, query, usedOnly]);
  const editorKey = editor?.key;
  useEffect(() => {
    if (editorKey) modal.current?.showModal();
  }, [editorKey]);
  function edit(row: Passage) {
    setEditor({ ...row });
    setCompare(false);
    setEditError('');
    onEditing(true);
  }
  function close() {
    setEditor(null);
    onEditing(false);
  }
  async function store(row: Passage) {
    const item = { documentId: doc.id, location: row.location.trim(), text: row.text.trim() };
    const next =
      row.index < 0 ? [...facts, item] : facts.map((v, i) => (i === row.index ? item : v));
    const ok = await onSave(next, row.index < 0 ? '片段已保存并采用' : '片段修改已保存');
    if (ok) {
      close();
      if (row.key === 'new') {
        setQuery(item.location);
        setUsedOnly(true);
        setLimit(20);
      }
    } else setEditError('保存失败。请关闭编辑窗口查看详情，或再次保存。');
  }
  return (
    <section aria-label="引用片段" className="kb-passages">
      <div className="kb-data-tools">
        <span>
          <List size={17} />
          {rows.length} 组数据
        </span>
        <label className="kb-search">
          <Search size={15} />
          <input
            type="search"
            aria-label="搜索引用片段"
            placeholder="搜索分块内容"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(20);
            }}
          />
        </label>
        {writable && (
          <button
            onClick={() =>
              edit({
                key: 'new',
                location: doc.contentType === 'application/pdf' ? '第 ' + page + ' 页' : '',
                text: '',
                index: -1,
              })
            }
          >
            <Plus size={15} />
            插入数据
          </button>
        )}
      </div>
      <div className="kb-chunk-filters">
        <button
          aria-pressed={!usedOnly}
          onClick={() => {
            setUsedOnly(false);
            setLimit(20);
          }}
        >
          全部
        </button>
        <button
          aria-pressed={usedOnly}
          onClick={() => {
            setUsedOnly(true);
            setLimit(20);
          }}
        >
          已采用 · {used}
        </button>
        {doc.extraction?.pageCount && <small>原件共 {doc.extraction.pageCount} 页</small>}
      </div>
      <div className="kb-chunks">
        {matches.slice(0, limit).map(({ row: r, i }) => (
          <article className="kb-chunk" key={r.key}>
            <header>
              <span className="kb-chunk-id">
                <AlignLeft size={13} />#{i + 1}
              </span>
              <span className={'kb-chunk-status' + (r.index >= 0 ? ' used' : '')}>
                {r.index >= 0 ? (
                  <>
                    <Check size={12} />
                    已采用
                  </>
                ) : (
                  '待核对'
                )}
              </span>
            </header>
            <button
              className="kb-chunk-text"
              aria-label={'查看分块 ' + (i + 1)}
              onClick={() => edit(r)}
            >
              {r.text}
            </button>
            <footer>
              <button className="kb-locator" onClick={() => onPage(r.page || 1)}>
                <FileText size={13} />
                {r.location}
              </button>
              <div>
                {writable && (
                  <>
                    <button title="编辑片段" aria-label="编辑片段" onClick={() => edit(r)}>
                      <Pencil size={14} />
                    </button>
                    {r.index < 0 ? (
                      <button onClick={() => void store(r)}>采用片段</button>
                    ) : (
                      <button
                        onClick={() =>
                          void onSave(
                            facts.filter((_, j) => j !== r.index),
                            '已取消采用',
                          )
                        }
                      >
                        取消采用
                      </button>
                    )}
                  </>
                )}
              </div>
            </footer>
          </article>
        ))}
      </div>
      {!matches.length && (
        <div className="kb-empty">
          <Search size={28} />
          <p>{query ? '没有找到匹配的片段' : usedOnly ? '还没有采用片段' : '暂无引用片段'}</p>
        </div>
      )}
      {matches.length > limit && (
        <button ref={loadMore} className="kb-load" onClick={() => setLimit((n) => n + 20)}>
          加载更多 · 已显示 {limit} / {matches.length}
        </button>
      )}
      {editor && (
        <dialog
          className={'kb-modal kb-edit' + (compare ? ' kb-compare-on' : '')}
          ref={modal}
          aria-label="分块详情"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <header>
            <h2>{editor.key === 'new' ? '插入数据' : writable ? '编辑分块' : '分块详情'}</h2>
            <button type="button" className="kb-icon" aria-label="关闭分块详情" onClick={close}>
              <X size={17} />
            </button>
          </header>
          <div className="kb-editor-layout">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void store(editor);
              }}
            >
              {editor.raw ? (
                <div className="kb-editor-location">
                  <FileText size={14} />
                  {editor.location}
                </div>
              ) : (
                <label>
                  原件位置
                  <input
                    required
                    readOnly={!writable}
                    maxLength={240}
                    value={editor.location}
                    onChange={(e) => setEditor({ ...editor, location: e.target.value })}
                  />
                </label>
              )}
              <label>
                引用内容
                <textarea
                  autoFocus
                  rows={10}
                  readOnly={!writable}
                  required
                  maxLength={4000}
                  value={editor.text}
                  onChange={(e) => setEditor({ ...editor, text: e.target.value })}
                />
              </label>
              {editor.raw && editor.raw !== editor.text && (
                <details>
                  <summary>对照原识别文字</summary>
                  <p>{editor.raw}</p>
                </details>
              )}
              {editError && (
                <p className="kb-error" role="alert">
                  {editError}
                </p>
              )}
              <footer>
                <button type="button" onClick={() => setCompare(!compare)} aria-pressed={compare}>
                  <BookOpen size={14} />
                  {compare ? '收起原文' : '对照原文'}
                </button>
                <button type="button" onClick={close}>
                  取消
                </button>
                {writable && (
                  <button
                    className="kb-primary"
                    disabled={!editor.location.trim() || !editor.text.trim()}
                  >
                    {editor.index < 0 ? '保存并采用' : '保存修改'}
                  </button>
                )}
              </footer>
            </form>
            {compare && (
              <div className="kb-original">
                <MaterialOriginal doc={doc} url={original} page={editor.page || page} />
              </div>
            )}
          </div>
        </dialog>
      )}
    </section>
  );
}
