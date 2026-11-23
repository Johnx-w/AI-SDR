import { useState } from 'react';
import { outreachApi } from '../outreachApi';
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
export function ReplyPreview({ id }: { id: string }) {
  const [question, setQuestion] = useState(''),
    [result, setResult] = useState<{ body: string; reason: string; sources: ReplySource[] } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function preview() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(
        await outreachApi('/mailboxes/' + encodeURIComponent(id) + '/preview', {
          method: 'POST',
          body: JSON.stringify({ question }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '试问失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="outreach-reply-preview">
      <summary>按此邮箱资料试问</summary>
      <label>
        客户问题
        <input
          value={question}
          maxLength={4000}
          onChange={(e) => {
            setQuestion(e.target.value);
            setResult(null);
          }}
        />
      </label>
      <button
        type="button"
        className="btn secondary"
        disabled={busy || !question.trim()}
        onClick={() => void preview()}
      >
        {busy ? '查询中…' : '预览答复'}
      </button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p style={{ whiteSpace: 'pre-wrap' }}>{result.body}</p>
          <small>{result.reason}</small>
          <ReplySources sources={result.sources} />
        </>
      )}
    </details>
  );
}
