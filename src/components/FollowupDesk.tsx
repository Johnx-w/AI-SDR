import { ChevronDown } from 'lucide-react';
import { FollowupDetail } from './FollowupDetail';
import { MailMessageBody } from './MailMessageBody';
import type { MailMessage, MailReplyDraft } from '../services/mailConversations';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { followupDeskApi, type DeskPage, type DeskRow } from '../services/customerBusiness';
import { formatBeijingTime } from '../domain/date-time.mjs';
import { mailConversationsApi } from '../services/mailConversations';
export function PriorityAction({
  id,
  remove = false,
  refresh,
}: {
  id: string;
  remove?: boolean;
  refresh: () => void;
}) {
  const [message, setMessage] = useState('');
  return (
    <>
      <button
        className="btn secondary"
        onClick={async () => {
          try {
            await followupDeskApi.priority(id, !remove);
            setMessage(remove ? '已移除' : '已标记');
            refresh();
          } catch (e) {
            setMessage(String(e));
          }
        }}
      >
        {remove ? '移除重点标记' : '标记重点跟进'}
      </button>
      <small role="status">{message}</small>
    </>
  );
}
function ReviewMail({ row }: { row: DeskRow }) {
  const [result, setResult] = useState<{
    mail?: MailMessage;
    draft?: MailReplyDraft;
    error?: string;
  }>();
  const [tab, setTab] = useState<'mail' | 'draft'>('mail');
  useEffect(() => {
    const c = new AbortController();
    if (row.thread)
      mailConversationsApi.detail(row.thread, c.signal).then(
        ({ messages, draft }) => {
          if (!c.signal.aborted)
            setResult({
              mail: messages.find((m) => m.id === row.id),
              draft: draft?.replyToMessageId === row.id ? draft : undefined,
            });
        },
        (e) => {
          if (!c.signal.aborted) setResult({ error: String(e) });
        },
      );
    return () => c.abort();
  }, [row.thread, row.id]);
  if (!row.thread) return <article>当前记录尚未关联原会话。</article>;
  if (!result) return <article role="status">正在读取关联邮件…</article>;
  if (result.error) return <article role="alert">{result.error}</article>;
  const mail = result.mail;
  return (
    <>
      <div className="followup-mail-tabs" aria-label="关联邮件">
        <button
          className="btn secondary"
          aria-pressed={tab === 'mail'}
          onClick={() => setTab('mail')}
        >
          客户来信
        </button>
        {result.draft && (
          <button
            className="btn secondary"
            aria-pressed={tab === 'draft'}
            onClick={() => setTab('draft')}
          >
            回复草稿
          </button>
        )}
      </div>
      <article>
        {tab === 'draft' && result.draft ? (
          <>
            <h3>回复草稿</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{result.draft.bodyText}</p>
          </>
        ) : mail ? (
          <>
            <h3>{mail.subject || '（无主题）'}</h3>
            <div className="followup-mail-meta">
              发件人 {mail.from} · 收件人 {mail.to}
              <br />
              {formatBeijingTime(mail.occurredAt)}
            </div>
            <MailMessageBody message={mail} collapseQuotes />
          </>
        ) : (
          <p>当前记录没有可核对的来信原文。</p>
        )}
      </article>
    </>
  );
}
function CustomerLookup({ refresh }: { refresh: () => void }) {
  const [query, setQuery] = useState(''),
    [rows, setRows] = useState<DeskRow[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    setRows([]);
    setError('');
    if (!query.trim()) return;
    const timer = setTimeout(
      () =>
        followupDeskApi.list(new URLSearchParams({ queue: 'lookup', q: query }), c.signal).then(
          (r) => {
            if (!c.signal.aborted) setRows(r.items || []);
          },
          (e) => {
            if (!c.signal.aborted) setError(String(e));
          },
        ),
      200,
    );
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [query]);
  return (
    <div>
      <label>
        添加重点客户{' '}
        <input
          type="search"
          placeholder="输入公司或邮箱"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {rows.map((r) => (
        <p key={r.id}>
          {r.name} · {r.title}{' '}
          <PriorityAction
            id={r.id}
            refresh={() => {
              setQuery('');
              refresh();
            }}
          />
        </p>
      ))}
      {error}
    </div>
  );
}
export function DeskList({
  queue,
  data,
  refresh,
}: {
  queue: string;
  data?: DeskPage;
  refresh: () => void;
}) {
  const [open, setOpen] = useState('');
  return (
    <>
      {queue === 'priority' && <CustomerLookup refresh={refresh} />}
      {!data ? (
        <p>正在读取…</p>
      ) : !data.items?.length ? (
        <div className="followup-empty">当前没有符合条件的记录</div>
      ) : (
        <div className="followup-list">
          <div className="followup-columns followup-list-head" aria-hidden="true">
            <span>客户</span>
            <span>{queue === 'approval' ? '邮件主题' : '邮箱'}</span>
            <span>时间（北京）</span>
            <span>状态</span>
            <span />
          </div>
          {data.items.map((r) => (
            <div key={r.id}>
              <button
                className="followup-columns followup-row"
                aria-controls={open === r.id ? 'detail-' + r.id : undefined}
                aria-expanded={open === r.id}
                onClick={() => setOpen(open === r.id ? '' : r.id)}
              >
                <strong>{r.name}</strong>
                <span>{r.title}</span>
                <span>{formatBeijingTime(r.stamp)}</span>
                <span className="followup-status">
                  {queue === 'approval' ? '待审核' : '已标记'}
                </span>
                <ChevronDown size={15} />
              </button>
              {open === r.id && (
                <FollowupDetail
                  id={'detail-' + r.id}
                  title={r.name + ' · ' + (queue === 'approval' ? '待审核' : '重点跟进')}
                  actions={
                    <>
                      <PriorityAction
                        id={r.customerId}
                        remove={queue === 'priority'}
                        refresh={refresh}
                      />
                      {r.thread && (
                        <Link
                          className="btn secondary"
                          to={'/inbox?' + new URLSearchParams({ tab: 'inbox', thread: r.thread })}
                        >
                          查看原会话
                        </Link>
                      )}
                      {queue === 'priority' && (
                        <Link
                          className="btn secondary"
                          to={'/leads?lead=' + encodeURIComponent(r.customerId)}
                        >
                          客户档案
                        </Link>
                      )}
                    </>
                  }
                  events={
                    <dl>
                      <dt>{queue === 'priority' ? '标记时间' : '收到来信'}</dt>
                      <dd>{formatBeijingTime(r.stamp)}</dd>
                      {r.note && (
                        <>
                          <dt>处理说明</dt>
                          <dd>{r.note}</dd>
                        </>
                      )}
                      {r.owner && (
                        <>
                          <dt>负责人</dt>
                          <dd>{r.owner}</dd>
                        </>
                      )}
                    </dl>
                  }
                >
                  {queue === 'approval' ? (
                    <ReviewMail row={r} />
                  ) : (
                    <article>
                      <h3>{r.name}</h3>
                      <p>{r.title}</p>
                      <Link to={'/business?customerId=' + encodeURIComponent(r.customerId)}>
                        查看该客户的跟进邮件
                      </Link>
                    </article>
                  )}
                </FollowupDetail>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
