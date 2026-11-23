import { sourceUrl } from '../services/materials';

export interface ReplySource {
  file: string;
  productId?: string;
  documentId?: string;
  sheet?: string;
  ref: string;
  value: string;
  version: number;
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
          page && s.productId && s.documentId
            ? sourceUrl(encodeURIComponent(s.productId), encodeURIComponent(s.documentId)) +
              '#page=' +
              page
            : '';
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
          </p>
        );
      })}
    </details>
  );
}
