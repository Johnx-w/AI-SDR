import { useState } from 'react';
import type { ModelParameter, StoredDocument } from '../services/materials';
export function ParameterReview({
  parameters,
  selected,
  disabled,
  onSelect,
  original,
  documents,
  onAttach,
  initialKey,
  parameterSet,
}: {
  initialKey?: string;
  parameterSet?: string;
  parameters: ModelParameter[];
  selected: string[];
  disabled: boolean;
  onSelect: (keys: string[]) => void;
  original: string;
  documents: StoredDocument[];
  onAttach: (file: File) => void;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(initialKey);
  const [limit, setLimit] = useState(30);
  const keys = new Set(selected);
  const matches = parameters.filter(
    (p) =>
      (!focused || p.key === focused) &&
      [p.item, p.field, p.ref, p.key].some((s) =>
        s.toLowerCase().includes(query.trim().toLowerCase()),
      ),
  );

  const issues = matches.filter((p) => p.issue);
  function group(rows: ModelParameter[], title: string) {
    if (!rows.length) return null;
    return (
      <section>
        <h3>
          {title} · {rows.length}
        </h3>
        {rows.slice(0, limit).map((p) => (
          <article key={p.key} className="kb-hit">
            <label>
              <input
                type="checkbox"
                disabled={disabled || p.issue?.includes('补齐计量单位')}
                checked={keys.has(p.key)}
                onChange={(e) =>
                  onSelect(
                    e.target.checked ? [...keys, p.key] : selected.filter((k) => k !== p.key),
                  )
                }
              />{' '}
              <strong>{p.item}</strong> · {p.field} · {p.value}
            </label>
            {p.conditions && <p>适用条件 · {p.conditions}</p>}
            <small>
              {p.sheet ? p.sheet + '!' : ''}
              {p.ref} · {p.quote}
            </small>
            {p.origin && (
              <p>
                来源 ·{' '}
                {p.upstream ? (
                  <a
                    href={
                      original.slice(0, original.lastIndexOf('/') + 1) +
                      p.upstream.documentId +
                      '#page=' +
                      p.upstream.page
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    {p.origin}
                  </a>
                ) : (
                  p.origin
                )}
              </p>
            )}
            {p.issue && <p>{p.issue}</p>}
            {p.box && (
              <details>
                <summary>查看原图标注</summary>
                <img
                  style={{ maxWidth: '100%' }}
                  alt={p.ref + '中的参数标注'}
                  loading="lazy"
                  src={
                    original +
                    '/region?' +
                    new URLSearchParams({ key: p.key, set: parameterSet || '' })
                  }
                />
              </details>
            )}
          </article>
        ))}
      </section>
    );
  }
  return (
    <div className="kb-parameters">
      <h2>型号参数</h2>
      {focused && (
        <button type="button" onClick={() => setFocused(undefined)}>
          查看同版全部参数
        </button>
      )}
      <label>
        搜索参数{' '}
        <input
          type="search"
          value={query}
          placeholder="型号、参数或原件位置"
          onChange={(e) => {
            setQuery(e.target.value);
            setFocused(undefined);
            setLimit(30);
          }}
        />
      </label>
      {!disabled && (
        <button
          type="button"
          onClick={() => onSelect(parameters.filter((p) => !p.issue).map((p) => p.key))}
        >
          全选正常项
        </button>
      )}{' '}
      <span>已选 {selected.length} 项</span>
      {group(issues, '需要核对')}
      {group(
        matches.filter((p) => !p.issue),
        '可采用',
      )}
      {Math.max(issues.length, matches.length - issues.length) > limit && (
        <button onClick={() => setLimit(limit + 30)}>显示更多参数</button>
      )}
      {documents
        .filter((d) => d.referencePages)
        .map((d) => (
          <p key={d.id}>
            已关联 · {d.name}（{d.referencePages} 页）
          </p>
        ))}
      {!disabled && (
        <label>
          关联来源 PDF{' '}
          <input
            type="file"
            accept=".pdf"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) onAttach(f);
            }}
          />
        </label>
      )}
    </div>
  );
}
