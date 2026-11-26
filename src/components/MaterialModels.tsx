import { useEffect, useMemo, useState } from 'react';
import type { ProductField } from '../services/materials';
import './MaterialModels.css';

type Photo = { id: string; slot: string; origin: string };
export function ModelPictures({
  url,
  sheet,
  item,
  row,
}: {
  url: string;
  sheet: string;
  item: string;
  row?: number;
}) {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setPhotos(null);
    setError(false);
    const params = new URLSearchParams({ sheet, item });
    if (row) params.set('row', String(row));
    fetch(url + '/photos?' + params, { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) throw Error();
        const data = await r.json();
        if (!abort.signal.aborted) setPhotos(data.photos);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, [url, sheet, item, row]);
  if (error || !photos?.length)
    return (
      <p className="model-photo-status">
        {error ? '图片读取失败' : photos ? '暂无已确认的产品图' : '正在读取产品图…'}
      </p>
    );
  return (
    <section className="model-inline-pictures" aria-label={item + ' 产品图'}>
      {photos.map((photo) => (
        <figure key={photo.id}>
          <a href={url + '/photos/' + photo.id} target="_blank" rel="noreferrer">
            <img src={url + '/photos/' + photo.id} loading="lazy" alt={item + ' · ' + photo.slot} />
          </a>
          <figcaption>
            {photo.slot} · {photo.origin}
          </figcaption>
        </figure>
      ))}
    </section>
  );
}

export function MaterialModels({
  fields,
  url,
  file,
  pdf = false,
}: {
  fields: ProductField[];
  url: string;
  file: string;
  pdf?: boolean;
}) {
  const [open, setOpen] = useState(''),
    [q, setQ] = useState(''),
    [page, setPage] = useState(1);
  const groups = useMemo(() => {
    const items = new Map<string, ProductField[]>();
    for (const f of fields) {
      const key = JSON.stringify([f.sheet, f.item]);
      if (!items.has(key)) items.set(key, []);
      items.get(key)!.push(f);
    }
    return [...items.entries()];
  }, [fields]);
  const matches = groups.filter(([, values]) =>
    values[0].item.toLowerCase().includes(q.trim().toLowerCase()),
  );
  if (!groups.length) return null;
  return (
    <section className="material-models" aria-label="型号详情">
      <h3>型号详情</h3>
      <input
        className="model-find"
        aria-label="查找型号"
        placeholder="查找型号或品名"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(1);
        }}
      />
      <div className="workbook-grid">
        {matches.slice((page - 1) * 12, page * 12).map(([key, values]) => {
          const { item, sheet } = values[0];
          return (
            <details key={key} open={open === key}>
              <summary
                onClick={(e) => {
                  e.preventDefault();
                  setOpen(open === key ? '' : key);
                }}
              >
                {item}
              </summary>
              {open === key && (
                <>
                  <ModelPictures url={url} sheet={sheet ?? '产品图片'} item={item} />
                  <p className="model-origin">{file}</p>
                  <dl className="model-properties">
                    {values.map((v, i) => {
                      const num = pdf && /第 (\d+) 页/u.exec(v.ref)?.[1];
                      return (
                        <div key={i}>
                          <dt>{v.field}</dt>
                          <dd>{v.value}</dd>
                          <small>
                            {num ? (
                              <a href={url + '#page=' + num} target="_blank" rel="noreferrer">
                                {v.ref}
                              </a>
                            ) : (
                              v.ref
                            )}
                            {v.ownerRef && v.ownerRef !== v.ref ? ' · 型号见 ' + v.ownerRef : ''}
                          </small>
                        </div>
                      );
                    })}
                  </dl>
                </>
              )}
            </details>
          );
        })}
      </div>
      {!matches.length && <p>没有匹配的型号</p>}
      {matches.length > 12 && (
        <div className="workbook-controls">
          <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          {page} / {Math.ceil(matches.length / 12)}
          <button
            type="button"
            disabled={page * 12 >= matches.length}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}
