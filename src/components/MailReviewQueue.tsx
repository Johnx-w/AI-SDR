import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { outreachApi } from '../outreachApi';
import { ReplySources } from './ReplyPreview';
import { mailConversationsApi, type MailConversationDetail } from '../services/mailConversations';

interface Queue {
  total: number;
  items: {
    threadId: string;
    sourceId: string;
    subject: string;
    from: string;
    account: string;
    reason: string;
    owner: string;
  }[];
}
export function MailReviewQueue({ count }: { count?: number }) {
  const [page, setPage] = useState(1),
    [data, setData] = useState<Queue | null>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setData(null);
    outreachApi<Queue>('/reception?page=' + page, { signal: controller.signal })
      .then((r) => {
        if (!controller.signal.aborted) setData(r);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [page, revision, count]);
  return (
    <section className="panel mail-review-list">
      <div className="outreach-section-heading">
        <h2>待审回信{data ? ' · ' + data.total : ''}</h2>
        <button type="button" className="btn secondary" onClick={() => setRevision((r) => r + 1)}>
          刷新待审
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">正在读取待审回信…</p>}
      {data?.total === 0 && <p>当前没有待审回信。</p>}
      {data?.items.map((item) => (
        <article key={item.sourceId}>
          <div>
            <strong>{item.subject || '（无主题）'}</strong>
            <p>
              {item.from} → {item.account}
            </p>
            <small>
              {item.owner} · {item.reason}
            </small>
          </div>
          <Link
            className="btn secondary"
            to={'/inbox?tab=conversations&thread=' + encodeURIComponent(item.threadId)}
          >
            查看并审核
          </Link>
        </article>
      ))}
      {data && (page > 1 || data.total > 20) && (
        <div className="workbook-controls">
          <button className="btn secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          {page} / {Math.ceil(data.total / 20)}
          <button
            className="btn secondary"
            disabled={page * 20 >= data.total}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}
export function ReceptionControls({
  detail,
  onChange,
}: {
  detail: MailConversationDetail;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const r = detail.reception;
  if (!r || !detail.conversation.customerId) return null;
  async function update(action: string) {
    setBusy(true);
    setError('');
    try {
      let revision;
      if (action === 'regenerate') {
        const { draft } = await mailConversationsApi.draft(detail.conversation.id);
        if (
          draft &&
          (!draft.provenance || draft.edited) &&
          !window.confirm('用当前资料重新生成将替换已编辑的草稿，继续吗？')
        )
          return;
        revision = draft?.revision || 0;
      }
      await outreachApi(
        '/conversations/' +
          encodeURIComponent(detail.conversation.id) +
          (action === 'regenerate' ? '/regenerate' : '/ownership'),
        { method: 'POST', body: JSON.stringify({ action, sourceId: r?.sourceId, revision }) },
      );
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mail-reception-controls">
      <div>
        <strong>{r.stopped ? '客户已停止联系' : r.human ? '人工接管中' : '邮箱接待'}</strong>{' '}
        {r.owner}
        {r.reason && <p>{r.reason}</p>}
      </div>
      <div className="workbook-controls">
        {!r.stopped && (
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => void update(r.human ? 'resume' : 'takeover')}
          >
            {r.human ? '恢复邮箱接待' : '人工接管'}
          </button>
        )}
        {!r.human &&
          !r.stopped &&
          r.sourceId &&
          ['review', 'attention'].includes(r.state || '') && (
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => void update('regenerate')}
            >
              按当前资料重新生成
            </button>
          )}
      </div>
      {error && <p role="alert">{error}</p>}
      {detail.draft?.provenance && <ReplySources sources={detail.draft.provenance.sources} />}
    </div>
  );
}
