import { useEffect, useState } from 'react';
import { materialsRequest, messageOf } from '../services/materials';
type Group = { number: number; topics: string[]; answer: string; source: string };
export function KnowledgeSheet({
  product,
  doc,
  sheet,
  revision,
}: {
  product: string;
  doc: string;
  sheet: string;
  revision: number;
}) {
  const [page, setPage] = useState(1),
    [q, setQuery] = useState(''),
    [error, setError] = useState(''),
    [data, setData] = useState<{ groups: Group[]; total: number; pageSize: number } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    const params = new URLSearchParams({
      sheet,
      revision: String(revision),
      q,
      page: String(page),
      view: 'knowledge',
    });
    materialsRequest<NonNullable<typeof data>>(
      '/' + product + '/document/' + doc + '/rows?' + params,
      { signal: controller.signal },
    )
      .then((r) => {
        if (!controller.signal.aborted) setData(r);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      });
    return () => controller.abort();
  }, [product, doc, sheet, revision, q, page]);
  return (
    <section className="pc" aria-label="答复规则">
      <div className="pc-toolbar">
        <input
          aria-label="查找主题或答复"
          placeholder="查找主题或答复"
          value={q}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <div className="pc-group">
            {data.groups.map((g) => (
              <article className="pc-record" key={g.number}>
                <div>
                  <strong>{g.topics.join(' · ')}</strong>
                </div>
                <div>
                  <p>{g.answer || '答复待填写'}</p>
                  <small>{g.source || sheet + ' · 行 ' + g.number}</small>
                </div>
              </article>
            ))}
          </div>
          <div className="workbook-controls">
            <button disabled={page === 1} onClick={() => setPage(page - 1)}>
              上一页
            </button>
            <span>
              {page} / {Math.max(1, Math.ceil(data.total / data.pageSize))} · {data.total} 条答复
            </span>
            <button disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>
              下一页
            </button>
          </div>
        </>
      )}
    </section>
  );
}
