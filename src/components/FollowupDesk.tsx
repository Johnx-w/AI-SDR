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
function ReviewDraft({ row }: { row: DeskRow }) {
  const [body, setBody] = useState('正在读取草稿…');
  useEffect(() => {
    const c = new AbortController();
    if (row.thread)
      mailConversationsApi.draft(row.thread, c.signal).then(
        ({ draft }) => {
          if (!c.signal.aborted)
            setBody(draft?.replyToMessageId === row.id ? draft.bodyText : '当前来信暂无待审草稿。');
        },
        (e) => {
          if (!c.signal.aborted) setBody(String(e));
        },
      );
    return () => c.abort();
  }, [row]);
  return <p style={{ whiteSpace: 'pre-wrap' }}>{body}</p>;
}
function Assignment({
  row,
  completed,
  refresh,
}: {
  row: DeskRow;
  completed: boolean;
  refresh: () => void;
}) {
  const [error, setError] = useState('');
  return (
    <form
      className="business-filters"
      onSubmit={async (e) => {
        e.preventDefault();
        const values = new FormData(e.currentTarget);
        try {
          await followupDeskApi.plan(row.id, {
            owner: String(values.get('owner')),
            nextStep: String(values.get('nextStep')),
            dueAt: new Date(String(values.get('due')) + '+08:00').toISOString(),
            completed: (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'done',
          });
          refresh();
        } catch (err) {
          setError(String(err));
        }
      }}
    >
      <label>
        负责人
        <input required maxLength={120} name="owner" defaultValue={row.owner} />
      </label>
      <label>
        下一步
        <input required maxLength={1000} name="nextStep" defaultValue={row.note} />
      </label>
      <label>
        跟进时间（北京）
        <input
          type="datetime-local"
          required
          name="due"
          defaultValue={
            row.note && row.stamp
              ? new Date(Date.parse(row.stamp) + 8 * 3600000).toISOString().slice(0, 16)
              : ''
          }
        />
      </label>
      <button className="btn secondary">{completed ? '重新打开' : '保存安排'}</button>
      {!completed && (
        <button className="btn secondary" value="done">
          完成跟进
        </button>
      )}
      <span role="status">{error}</span>
    </form>
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
  completed,
}: {
  queue: string;
  data?: DeskPage;
  refresh: () => void;
  completed: boolean;
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
          {data.items.map((r) => (
            <div key={r.id}>
              <button
                className="followup-columns followup-row"
                aria-expanded={open === r.id}
                onClick={() => setOpen(open === r.id ? '' : r.id)}
              >
                <strong>{r.name}</strong>
                <span>{r.title}</span>
                <span>{formatBeijingTime(r.stamp)}</span>
                <small>{r.owner || r.note}</small>
                <span>⌄</span>
              </button>
              {open === r.id && (
                <section className="followup-detail">
                  <h3>{r.title}</h3>
                  <p>{r.note}</p>
                  {queue === 'approval' && <ReviewDraft row={r} />}
                  {queue === 'assigned' && (
                    <Assignment row={r} completed={completed} refresh={refresh} />
                  )}
                  {r.thread && (
                    <Link
                      className="btn secondary"
                      to={'/inbox?' + new URLSearchParams({ tab: 'inbox', thread: r.thread })}
                    >
                      {queue === 'approval' ? '审核或接手原会话' : '查看原会话'}
                    </Link>
                  )}
                  <Link
                    className="btn secondary"
                    to={'/leads?lead=' + encodeURIComponent(r.customerId)}
                  >
                    客户档案
                  </Link>{' '}
                  <PriorityAction
                    id={r.customerId}
                    remove={queue === 'priority'}
                    refresh={refresh}
                  />
                </section>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
