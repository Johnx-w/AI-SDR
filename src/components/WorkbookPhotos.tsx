import { useEffect, useRef, useState } from 'react';
import { materialsRequest, sendJson, sourceUrl, messageOf } from '../services/materials';
import './WorkbookPhotos.css';

export interface ProductPhoto {
  id: string;
  documentId: string;
  sheet: string;
  item: string;
  slot: string;
  origin: string;
  productId?: string;
}
interface ModelRow {
  sheet: string;
  item: string;
  occurrences: number;
  photos: ProductPhoto[];
}
type Suggestion = ProductPhoto & { reason: string };
const imagePath = (product: string, p: ProductPhoto) =>
  sourceUrl(product, p.documentId) + '/photos/' + p.id;
export function PhotoPreview({ url, label }: { url: string; label: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" title={'查看原图 · ' + label}>
      <img loading="lazy" src={url} alt={label} />
    </a>
  );
}
function readImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(Error('读取图片失败'));
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(file);
  });
}
export function WorkbookPhotos({
  product,
  doc,
  sheets,
  writable,
}: {
  product: string;
  doc: string;
  sheets: { name: string }[];
  writable: boolean;
}) {
  const base = '/' + product + '/document/' + doc + '/photos';
  const [sheet, setSheet] = useState(''),
    [q, setQ] = useState(''),
    [missing, setMissing] = useState(false),
    [page, setPage] = useState(1),
    [refresh, reload] = useState(0);
  const [data, setData] = useState<{ page: number; total: number; rows: ModelRow[] } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{
    row: ModelRow;
    old?: ProductPhoto;
    slot: string;
    newSlot: boolean;
    remove: boolean;
    preview: string;
  } | null>(null);
  const reviewRef = useRef<HTMLElement>(null);
  const editing = !!edit;
  useEffect(() => {
    if (editing) reviewRef.current?.scrollIntoView({ block: 'nearest' });
  }, [editing, edit?.row.item, edit?.slot === '主图']);
  const [previous, setPrevious] = useState<Suggestion[] | null>(null),
    [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    const c = new AbortController();
    setData(null);
    setError('');
    materialsRequest<NonNullable<typeof data>>(
      base +
        '?' +
        new URLSearchParams({ sheet, q, missing: missing ? '1' : '0', page: String(page) }),
      { signal: c.signal },
    )
      .then((v) => {
        if (!c.signal.aborted) setData(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(messageOf(e));
      });
    return () => c.abort();
  }, [base, sheet, q, missing, page, refresh]);
  async function perform(job: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await job();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="model-photos" aria-label="产品图片">
      <div className="photo-controls">
        <select
          aria-label="筛选工作表"
          value={sheet}
          onChange={(e) => {
            setSheet(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部工作表</option>
          {sheets.map((s) => (
            <option key={s.name}>{s.name}</option>
          ))}
        </select>
        <input
          aria-label="搜索型号"
          placeholder="搜索型号"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={missing}
            onChange={(e) => {
              setMissing(e.target.checked);
              setPage(1);
            }}
          />{' '}
          缺少主图
        </label>
        {writable && (
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                setEdit(null);
                setPrevious(await materialsRequest<Suggestion[]>(base + '/carry'));
                setSelected([]);
              })
            }
          >
            沿用上版图片
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {previous && (
        <section className="photo-review">
          <strong>沿用上版图片</strong>
          {!previous.length && <p>上一个工作簿版本没有可沿用的图片。</p>}
          {previous.length > 0 && (
            <label>
              <input
                type="checkbox"
                checked={
                  selected.length > 0 &&
                  selected.length === previous.filter((p) => !p.reason).length
                }
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? previous.filter((p) => !p.reason).map((p) => p.id) : [],
                  )
                }
              />{' '}
              全选可沿用图片
            </label>
          )}
          {previous.map((p) => (
            <div className="photo-candidate" key={p.id}>
              <input
                type="checkbox"
                aria-label={'沿用 ' + p.sheet + ' ' + p.item + ' ' + p.slot}
                disabled={!!p.reason || busy}
                checked={selected.includes(p.id)}
                onChange={(e) =>
                  setSelected((old) =>
                    e.target.checked ? [...old, p.id] : old.filter((i) => i !== p.id),
                  )
                }
              />
              <PhotoPreview url={imagePath(product, p)} label={p.item + ' ' + p.slot} />
              <span>
                {p.sheet} · {p.item} · {p.slot}
                <small>{p.reason || p.origin}</small>
              </span>
            </div>
          ))}
          <button
            disabled={busy || !selected.length}
            onClick={() =>
              void perform(async () => {
                await sendJson(base + '/carry', 'POST', { ids: selected });
                setPrevious(null);
                reload((n) => n + 1);
              })
            }
          >
            确认沿用 {selected.length} 张
          </button>{' '}
          <button disabled={busy} onClick={() => setPrevious(null)}>
            关闭
          </button>
        </section>
      )}
      {edit && (
        <section ref={reviewRef} className="photo-review">
          <strong>
            {edit.remove ? '移除图片' : '核对图片'} · {edit.row.sheet} / {edit.row.item}
          </strong>
          {edit.newSlot ? (
            <label>
              图片用途{' '}
              <input
                value={edit.slot}
                placeholder="例如 色卡、安装图"
                maxLength={40}
                onChange={(e) => setEdit({ ...edit, slot: e.target.value })}
              />
            </label>
          ) : (
            <span>{edit.slot}</span>
          )}
          <div className="photo-compare">
            {edit.old && (
              <figure>
                <PhotoPreview url={imagePath(product, edit.old)} label={edit.slot} />
                <figcaption>当前图片 · {edit.old.origin}</figcaption>
              </figure>
            )}
            {edit.preview && (
              <figure>
                <img src={edit.preview} alt="待确认的新图" />
                <figcaption>新图片</figcaption>
              </figure>
            )}
          </div>
          {!edit.remove && (
            <input
              type="file"
              aria-label="选择新图片"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  void perform(async () => {
                    if (f.size > 6 * 1024 * 1024) throw Error('请选择 6 MB 以内的图片');
                    const preview = await readImage(f);
                    setEdit({ ...edit, preview });
                  });
              }}
            />
          )}
          <div>
            <button
              disabled={busy || !edit.slot.trim() || (!edit.remove && !edit.preview)}
              onClick={() =>
                void perform(async () => {
                  const slot = edit.slot.trim();
                  if (
                    edit.newSlot &&
                    (slot === '主图' || edit.row.photos.some((p) => p.slot === slot))
                  )
                    throw Error('此用途已有图片，请选择对应图片的「替换」');
                  await sendJson(base, 'POST', {
                    sheet: edit.row.sheet,
                    item: edit.row.item,
                    slot,
                    expectedId: edit.old?.id || null,
                    remove: edit.remove,
                    contentBase64: edit.preview.split(',')[1],
                  });
                  setEdit(null);
                  reload((n) => n + 1);
                })
              }
            >
              {edit.remove ? '确认移除' : '确认使用'}
            </button>{' '}
            <button disabled={busy} onClick={() => setEdit(null)}>
              取消
            </button>
          </div>
        </section>
      )}
      {data ? (
        <>
          <div className="photo-models">
            {data.rows.map((row) => {
              const change = (slot: string, old?: ProductPhoto, remove = false) => {
                setPrevious(null);
                setError('');
                setEdit({ row, slot, old, remove, newSlot: !slot, preview: '' });
              };
              return (
                <article key={JSON.stringify([row.sheet, row.item])}>
                  <div className="photo-model-name">
                    <strong>{row.item}</strong>
                    <small>{row.sheet}</small>
                  </div>
                  <div>
                    {row.photos.map((p) => (
                      <div className="photo-candidate" key={p.id}>
                        <PhotoPreview url={imagePath(product, p)} label={row.item + ' ' + p.slot} />
                        <span>
                          {p.slot}
                          <small>{p.origin}</small>
                        </span>
                        {writable && row.occurrences === 1 && (
                          <>
                            <button disabled={busy} onClick={() => change(p.slot, p)}>
                              替换
                            </button>
                            <button disabled={busy} onClick={() => change(p.slot, p, true)}>
                              移除
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                    {row.occurrences > 1 ? (
                      <small>同表有 {row.occurrences} 条同名记录，请核对型号</small>
                    ) : (
                      writable && (
                        <div className="photo-controls">
                          {!row.photos.some((p) => p.slot === '主图') && (
                            <button disabled={busy} onClick={() => change('主图')}>
                              添加主图
                            </button>
                          )}
                          <button disabled={busy} onClick={() => change('')}>
                            添加附图
                          </button>
                        </div>
                      )
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          {!data.rows.length && <p>没有符合条件的型号。</p>}
          <div className="photo-controls">
            <small>
              共 {data.total} 个型号 · 第 {data.page} 页
            </small>
            <button disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>
              上一页
            </button>
            <button disabled={data.page * 20 >= data.total} onClick={() => setPage(data.page + 1)}>
              下一页
            </button>
          </div>
        </>
      ) : (
        !error && <p>正在读取型号…</p>
      )}
    </section>
  );
}
