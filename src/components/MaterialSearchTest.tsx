import { useEffect, useState } from 'react';
import { FileSearch, Play, Search } from 'lucide-react';
import { outreachApi, type OutreachMailbox } from '../outreachApi';
import { sourceUrl, messageOf } from '../services/materials';
import type { ReplySource } from './ReplyPreview';

export function MaterialSearchTest() {
  const [boxes, setBoxes] = useState<Pick<OutreachMailbox, 'id' | 'email'>[]>([]),
    [box, setBox] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [question, setQuestion] = useState(''),
    [error, setError] = useState('');
  const [result, setResult] = useState<{ reason: string; sources: ReplySource[] } | null>(null);
  useEffect(() => {
    const c = new AbortController();
    outreachApi<{ mailboxes: OutreachMailbox[] }>('/state?view=inbox', { signal: c.signal })
      .then((r) => {
        if (!c.signal.aborted) {
          setBoxes(r.mailboxes);
          setBox(r.mailboxes[0]?.id || '');
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(messageOf(e));
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, []);
  async function test() {
    setResult(null);
    setBusy(true);
    setError('');
    try {
      setResult(
        await outreachApi('/mailboxes/' + encodeURIComponent(box) + '/preview', {
          method: 'POST',
          body: JSON.stringify({ question: question.trim() }),
        }),
      );
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="kb-test">
      <h2>
        <FileSearch size={18} />
        搜索测试
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void test();
        }}
      >
        <label>
          检索范围
          <select
            disabled={busy || !boxes.length}
            value={box}
            onChange={(e) => {
              setBox(e.target.value);
              setResult(null);
            }}
          >
            {!boxes.length && <option>{loading ? '正在读取邮箱…' : '暂无可用邮箱'}</option>}
            {boxes.map((b) => (
              <option key={b.id} value={b.id}>
                {b.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          测试问题
          <textarea
            rows={4}
            maxLength={4000}
            placeholder="输入客户的问题，测试可引用的资料"
            disabled={busy}
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
              setResult(null);
            }}
          />
        </label>
        <button className="kb-primary" disabled={!box || busy || !question.trim()}>
          <Play size={14} />
          {busy ? '正在搜索…' : '开始测试'}
        </button>
      </form>
      {error && (
        <p className="kb-error" role="alert">
          {error}
        </p>
      )}
      {result ? (
        <section aria-live="polite">
          <h3>匹配片段 · {result.sources.length}</h3>
          {!result.sources.length && <p>{result.reason || '没有匹配到此邮箱可引用的资料。'}</p>}
          {result.sources.map((s, i) => {
            const page = /^第\s*(\d+)\s*页/u.exec(s.ref)?.[1];
            return (
              <article className="kb-hit" key={i}>
                {s.documentId && s.productId ? (
                  <a
                    href={
                      sourceUrl(encodeURIComponent(s.productId), encodeURIComponent(s.documentId)) +
                      (page ? '#page=' + page : '')
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    {s.file}
                  </a>
                ) : (
                  <strong>{s.file}</strong>
                )}
                <small>
                  v{s.version} · {s.sheet ? s.sheet + '!' : ''}
                  {s.ref}
                </small>
                <p>{s.value}</p>
              </article>
            );
          })}
        </section>
      ) : (
        <div className="kb-empty">
          <Search size={28} />
          <p>搜索结果将显示在这里</p>
        </div>
      )}
    </div>
  );
}
