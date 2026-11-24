import { useEffect, useState } from 'react';
import { materialsRequest, sourceUrl, type Correction } from '../../services/materials';
import { PriceAmount } from './PriceAmount';
import './catalog.css';

type Cell = { ref: string; field: string; value: string };
type Row = {
  number: number;
  cells: Cell[];
  photos: { id: string; slot: string; origin: string }[];
};
export function UploadedQuote({
  product,
  doc,
  sheets,
  terms,
  figures,
  edits,
  writable,
  onSave,
  onPage,
  pdf,
}: {
  product: string;
  doc: string;
  sheets: { name: string; rows: number }[];
  terms: string[];
  figures: { label: string; source: string; index: number }[];
  edits: Correction[];
  writable: boolean;
  onSave: (sheet: string, ref: string, value: string, original: string) => Promise<boolean>;
  onPage: (page: number) => void;
  pdf: boolean;
}) {
  const [sheet, setSheet] = useState(sheets[0].name),
    [page, setPage] = useState(1),
    [query, setQuery] = useState('');
  const [data, setData] = useState<{ rows: Row[]; total: number; pageSize: number } | null>(null),
    [error, setError] = useState('');
  const base = '/' + product + '/document/' + doc;
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    materialsRequest<NonNullable<typeof data>>(
      base + '/rows?' + new URLSearchParams({ sheet, q: query, page: String(page) }),
      { signal: controller.signal },
    )
      .then((r) => {
        if (!controller.signal.aborted) setData(r);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [base, sheet, page, query]);
  return (
    <section className="pc" aria-label="完整图文清单">
      <div className="pc-toolbar">
        <label className="pc-search">
          <input
            aria-label="查找型号或品名"
            placeholder="查找型号或品名"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <select
          aria-label="选择报价表"
          value={sheet}
          onChange={(e) => {
            setSheet(e.target.value);
            setPage(1);
          }}
        >
          {sheets.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}（{s.rows}）
            </option>
          ))}
        </select>
      </div>
      {figures.length > 0 && (
        <details>
          <summary>系列参考图（{figures.length}）</summary>
          <div className="pc-photos">
            {figures.map((f) => (
              <figure key={f.index}>
                <a
                  className="pc-photo"
                  target="_blank"
                  rel="noreferrer"
                  href={sourceUrl(product, doc) + '/figure?index=' + f.index}
                >
                  <img
                    src={sourceUrl(product, doc) + '/figure?index=' + f.index}
                    loading="lazy"
                    alt={f.label}
                  />
                </a>
                <figcaption>
                  {f.label}
                  <br />
                  <small>{f.source}</small>
                </figcaption>
              </figure>
            ))}
          </div>
        </details>
      )}
      {terms.length > 0 && (
        <details>
          <summary>报价条件</summary>
          {terms.map((term, i) => (
            <p className="pc-terms" key={i}>
              {term}
            </p>
          ))}
        </details>
      )}
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <section className="pc-group">
            <div className="pc-column-head">
              <span>产品与配图</span>
              <span>规格与来源</span>
              <span>参考价格</span>
            </div>
            {data.rows.map((row) => {
              const amount = row.cells.find((c) => c.field === '参考价格')!;
              const effective = (cell: Cell) =>
                edits.find((e) => e.documentId === doc && e.sheet === sheet && e.ref === cell.ref)
                  ?.value ?? cell.value;
              const label = effective(row.cells[0]);
              const original = row.cells.find((c) => c.field === '来源')?.value;
              const pageNumber = Number(/^PDF p\.(\d+)/u.exec(sheet)?.[1]);
              return (
                <article className="pc-record pc-grid" key={row.number}>
                  <div className="pc-identity">
                    <h3>{label}</h3>
                    <div className="pc-photos">
                      {row.photos.length && label === row.cells[0].value ? (
                        row.photos.map((p) => (
                          <div key={p.id} className="pc-shared">
                            <a
                              className="pc-photo"
                              href={sourceUrl(product, doc) + '/photos/' + p.id}
                              target="_blank"
                              rel="noreferrer"
                              title={p.origin}
                            >
                              <img
                                loading="lazy"
                                alt={label + ' ' + p.slot}
                                src={sourceUrl(product, doc) + '/photos/' + p.id}
                              />
                            </a>
                            {row.photos.length > 1 && <small>{p.slot}</small>}
                          </div>
                        ))
                      ) : (
                        <small className="pc-no-photo">暂无已归属配图</small>
                      )}
                    </div>
                  </div>
                  <div>
                    <dl className="pc-facts">
                      {row.cells
                        .slice(1)
                        .filter(
                          (c) =>
                            effective(c) &&
                            !['参考价格', '单位', '币种', '来源'].includes(c.field) &&
                            !(c.field === '适用条件' && effective(c) === terms.join('\n')),
                        )
                        .map((c) => (
                          <div key={c.ref} className={c.value.length > 38 ? 'pc-wide' : ''}>
                            <dt>{c.field}</dt>
                            <dd>{effective(c)}</dd>
                          </div>
                        ))}
                    </dl>
                    {pdf && pageNumber ? (
                      <button className="pc-edit" onClick={() => onPage(pageNumber)}>
                        {original} · 查看原页
                      </button>
                    ) : (
                      <small>{original}</small>
                    )}
                  </div>
                  <div className="pc-quote">
                    <small>
                      {['币种', '单位']
                        .map((f) => row.cells.filter((c) => c.field === f).map(effective)[0])
                        .filter(Boolean)
                        .join(' / ')}
                    </small>
                    <label>
                      <span>单价</span>
                      <PriceAmount
                        value={effective(amount)}
                        label={label + ' 参考价格'}
                        writable={writable}
                        notify={setError}
                        commit={(v) => void onSave(sheet, amount.ref, v, amount.value)}
                      />
                    </label>
                    {effective(amount) !== amount.value && (
                      <small>原值 {amount.value || '空白'}</small>
                    )}
                  </div>
                </article>
              );
            })}
            {!data.rows.length && <p className="pc-empty">没有匹配的产品。</p>}
          </section>
          <div className="workbook-controls">
            <button
              className="btn secondary"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </button>
            <span>
              {page} / {Math.max(1, Math.ceil(data.total / data.pageSize))} · {data.total} 行
            </span>
            <button
              className="btn secondary"
              disabled={page * data.pageSize >= data.total}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </section>
  );
}
