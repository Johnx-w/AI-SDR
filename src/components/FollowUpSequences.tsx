import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock3, Mail } from 'lucide-react';
import { Link } from 'react-router-dom';
import { outreachApi, type OutreachDelivery, type OutreachMailbox } from '../outreachApi';
import { Empty, Modal } from './ui';
import { MailMessageBody } from './MailMessageBody';
import { SequencePolicyPanel } from './SequencePolicy';

interface Sequence {
  id: string;
  name: string;
  status: string;
  followUpEnabled: boolean;
  followUpPaused: boolean;
  mailboxIds: string[];
  firstCount: number;
  pendingCount: number;
}
interface Recipient {
  firstId: string;
  customerId: string | null;
  threadId?: string | null;
  mailboxId?: string | null;
  companyName: string;
  from: string;
  to: string;
  sentAt: string;
  followUps: {
    day: number;
    step: number;
    instruction: string;
    policyName: string;
    status: string;
    dueAt: string;
    sentAt?: string;
    reason?: string;
  }[];
}
interface SequenceDetail {
  sequence: Sequence;
  steps: { step: number; day: number; offsetHours: number }[];
  items: Recipient[];
  page: number;
  pageSize: number;
  total: number;
}
const when = (d?: string | null) =>
  d ? new Date(d).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const status = (s: string) =>
  ({
    pending: '待跟进',
    accepted: '服务商已接受',
    cancelled: '已取消',
    skipped: '已跳过',
    sending: '提交中',
    blocked: '待处理',
    failed: '失败',
    unknown: '结果待核实',
    expired: '已过期',
    held: '已暂停',
    active: '进行中',
    paused: '已暂停',
    completed: '已完成',
    draft: '草稿',
    ready: '已就绪',
    preparing: '准备中',
  })[s] || s;
const notice = (e: unknown) => (e instanceof Error ? e.message : '读取失败，请重试。');
function Pager({
  page,
  size,
  total,
  change,
}: {
  page: number;
  size: number;
  total: number;
  change: (n: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="sequence-pager">
      <span>共 {total} 项</span>
      <button
        type="button"
        aria-label="上一页"
        className="icon-button"
        disabled={page === 1}
        onClick={() => change(page - 1)}
      >
        <ChevronLeft size={16} />
      </button>
      <span>
        {page} / {pages}
      </span>
      <button
        type="button"
        aria-label="下一页"
        className="icon-button"
        disabled={page >= pages}
        onClick={() => change(page + 1)}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
function SentMessage({ row, close }: { row: Recipient; close: () => void }) {
  const [item, setItem] = useState<OutreachDelivery | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    outreachApi<OutreachDelivery>('/deliveries/' + encodeURIComponent(row.firstId), {
      signal: c.signal,
    })
      .then((v) => {
        if (!c.signal.aborted) setItem(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(notice(e));
      });
    return () => c.abort();
  }, [row.firstId]);
  return (
    <Modal title="首封实发邮件" wide onClose={close}>
      <div className="modal-body">
        {error ? (
          <p role="alert">{error}</p>
        ) : item ? (
          <>
            <h3>{item.subject}</h3>
            <p>
              {item.from} → {item.to}
            </p>
            <small>{when(item.sentAt)}</small>
            <MailMessageBody
              message={{
                source: 'outreach',
                subject: item.subject,
                bodyText: item.bodyText || '',
                bodyHtml: item.bodyHtml,
              }}
            />
          </>
        ) : (
          <p role="status">正在读取邮件…</p>
        )}
      </div>
    </Modal>
  );
}
export function CampaignFollowUps({
  id,
  refreshToken,
  mailboxes,
}: {
  id: string;
  refreshToken: number;
  mailboxes: OutreachMailbox[];
}) {
  const [data, setData] = useState<SequenceDetail | null>(null),
    [page, setPage] = useState(1),
    [day, setDay] = useState(0),
    [rev, setRev] = useState(0),
    [error, setError] = useState(''),
    [preview, setPreview] = useState<Recipient | null>(null);
  useEffect(() => {
    const c = new AbortController();
    setError('');
    setData(null);
    outreachApi<SequenceDetail>(
      '/sequences/' + encodeURIComponent(id) + '?page=' + page + '&pageSize=20',
      { signal: c.signal },
    )
      .then((v) => {
        if (!c.signal.aborted) setData(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(notice(e));
      });
    return () => c.abort();
  }, [id, page, rev, refreshToken]);
  const s = data?.sequence;
  return (
    <div className="sequence-page sequence-detail">
      {error && (
        <div className="outreach-alert error" role="alert">
          {error}
          <button className="btn subtle" onClick={() => setRev((n) => n + 1)}>
            重试
          </button>
        </div>
      )}
      {!data && !error && <p role="status">正在读取跟进步骤…</p>}
      {data && s && (
        <>
          <div className="sequence-layout">
            <aside className="sequence-steps">
              <h3>邮件步骤</h3>
              {data.steps.map((item) => (
                <button
                  className={day === item.day ? 'selected' : ''}
                  key={item.day}
                  onClick={() => setDay(item.day)}
                  aria-pressed={day === item.day}
                >
                  <Mail size={15} />
                  <span>
                    <strong>{item.day === 0 ? '首封开发信' : '未回复跟进'}</strong>
                    <small>
                      {item.step === 0
                        ? '实际发送'
                        : '首封发出后第 ' + item.offsetHours / 24 + ' 天'}
                    </small>
                  </span>
                </button>
              ))}
            </aside>
            <div className="sequence-recipients">
              <div className="sequence-rule">
                <Clock3 size={17} />
                <p>
                  {day === 0
                    ? '首封邮件由触达计划生成并发送。'
                    : '按首封实际发出时间计算第 ' +
                      day +
                      ' 天。同一邮箱沿原线程跟进，客户回复、退订或接管会终止后续自动跟进。'}
                </p>
              </div>
              <h3>{day === 0 ? '已发送的客户' : '客户执行情况'}</h3>
              {data.items.length ? (
                <div className="outreach-table-wrap">
                  <table className="outreach-table">
                    <thead>
                      <tr>
                        <th>客户</th>
                        <th>{day ? '计划时间（北京）' : '发送时间（北京）'}</th>
                        <th>执行情况</th>
                        <th>邮件</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((row) => {
                        const task = row.followUps.find((f) => f.day === day);
                        const mailboxId =
                          row.mailboxId ||
                          mailboxes.find((m) => m.email.toLowerCase() === row.from?.toLowerCase())
                            ?.id;
                        const params = new URLSearchParams({ tab: 'inbox' });
                        if (row.customerId) params.set('customerId', row.customerId);
                        if (row.threadId) params.set('thread', row.threadId);
                        if (mailboxId) params.set('mailboxId', mailboxId);
                        return (
                          <tr key={row.firstId}>
                            <td>
                              <strong>{row.companyName || row.to}</strong>
                              <small>{row.to}</small>
                            </td>
                            <td>{when(day ? task?.dueAt : row.sentAt)}</td>
                            <td>
                              {day ? (task ? status(task.status) : '无此步骤') : '首封已发'}
                              {task?.instruction && (
                                <details>
                                  <summary>写作要求</summary>
                                  <small>{task.policyName}</small>
                                  <p>{task.instruction}</p>
                                </details>
                              )}
                              {task?.reason && <small>{task.reason}</small>}
                              {task?.sentAt && <small>{when(task.sentAt)}</small>}
                            </td>
                            <td>
                              <button className="text-link" onClick={() => setPreview(row)}>
                                查看首封
                              </button>
                              {(row.threadId || row.customerId) && (
                                <Link to={'/inbox?' + params}>收件箱</Link>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="暂无已发首封"
                  detail="收到该计划的真实发送结果后，客户和跟进时间将在这里出现。"
                />
              )}
              <Pager page={data.page} total={data.total} size={data.pageSize} change={setPage} />
            </div>
          </div>
        </>
      )}
      {preview && <SentMessage row={preview} close={() => setPreview(null)} />}
    </div>
  );
}
export function FollowUpSequences({ refreshToken }: { refreshToken: number }) {
  return (
    <section className="sequence-page">
      <div className="outreach-section-heading">
        <h2>开发信与跟进信</h2>
        <Link to="/inbox?tab=campaigns">打开触达计划</Link>
      </div>
      <SequencePolicyPanel refreshToken={refreshToken} />
    </section>
  );
}
