import { sourceUrl } from '../services/materials';

export interface ReplySource {
  file: string;
  key?: string;
  set?: string;
  item?: string;
  field?: string;
  conditions?: string;
  origin?: string;
  quote?: string;
  box?: number[];
  upstream?: { documentId: string; file: string; page: number };
  productId?: string;
  documentId?: string;
  sheet?: string;
  ref: string;
  value: string;
  version: number;
}
export function parameterLocation(s: ReplySource) {
  return s.key && s.productId
    ? '/materials?' +
        new URLSearchParams({ id: s.productId, revision: String(s.version), parameter: s.key })
    : '';
}
export function ParameterCitation({ source: s }: { source: ReplySource }) {
  if (!s.key) return null;
  const base = s.productId && s.documentId ? sourceUrl(s.productId, s.documentId) : '';
  return (
    <>
      <br />
      {[s.item, s.field, s.conditions].filter(Boolean).join(' · ')}
      {s.quote && <small> · 原文「{s.quote}」</small>}
      {s.box && base && (
        <a
          href={base + '/region?' + new URLSearchParams({ key: s.key, set: s.set || '' })}
          target="_blank"
          rel="noreferrer"
        >
          查看原图标注
        </a>
      )}
      {s.origin && (
        <>
          <br />
          {s.upstream && s.productId ? (
            <a
              href={sourceUrl(s.productId, s.upstream.documentId) + '#page=' + s.upstream.page}
              target="_blank"
              rel="noreferrer"
            >
              {s.origin}
            </a>
          ) : (
            s.origin
          )}
        </>
      )}
    </>
  );
}
export function ReplySources({ sources, reason }: { sources: ReplySource[]; reason?: string }) {
  if (!sources.length) return reason ? <p className="mail-source-reason">{reason}</p> : null;
  return (
    <details className="mail-conversation-source">
      <summary>查看回复依据 · {sources.length}</summary>
      {reason && <p>{reason}</p>}
      {sources.map((s, i) => {
        const label = s.file + ' · v' + s.version + ' · ' + (s.sheet ? s.sheet + '!' : '') + s.ref;
        const page = /\.pdf$/iu.test(s.file) && /^第 (\d+) 页/u.exec(s.ref)?.[1];
        const target =
          parameterLocation(s) ||
          (s.productId && s.documentId
            ? sourceUrl(encodeURIComponent(s.productId), encodeURIComponent(s.documentId)) +
              (page ? '#page=' + page : '')
            : '');
        return (
          <p key={i}>
            {target ? (
              <a href={target} target="_blank" rel="noreferrer">
                {label}
              </a>
            ) : (
              label
            )}
            <br />
            {s.value}
            <ParameterCitation source={s} />
          </p>
        );
      })}
    </details>
  );
}
