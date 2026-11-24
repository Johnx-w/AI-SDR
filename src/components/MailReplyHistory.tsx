import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatBeijingTime } from '../domain/date-time.mjs';

const kinds = {
  reply: '客户回信',
  inquiry: '无回复头来信',
  notification: '自动通知',
  unverified: '待核实回执',
  bounce: '退信',
  unsubscribe: '退订',
  complaint: '投诉',
  internal: '内部往来',
  test: '内部测试',
  all: '全部来信',
};
const handling = {
  manual: '已人工回复',
  automatic: '已自动回复',
  sent: '邮箱已回复',
  unanswered: '未见后续回信',
};
const businessKinds = {
  all: '全部业务分类',
  positive: '积极回复',
  refusal: '明确拒绝',
  referral: '渠道转介',
  notification: '客服通知',
  bounce: '退信',
  unverified: '待核实',
  other: '其他真人回复',
};
const requestTypes = { quote: '索价', catalog: '索目录', meeting: '约见' };
interface Row {
  id: string;
  threadId: string;
  mailboxId: string;
  account: string;
  from: string;
  subject: string;
  receivedAt: string;
  kind: Exclude<keyof typeof kinds, 'all'>;
  companyName: string | null;
  hasLocalParent: boolean;
  handling: keyof typeof handling;
  businessKind: Exclude<keyof typeof businessKinds, 'all'>;
  requestType: keyof typeof requestTypes | null;
}
interface Result {
  items: Row[];
  total: number;
  page: number;
  pageSize: number;
  mailboxes: { id: string; email: string }[];
  businessCounts: Record<Exclude<keyof typeof businessKinds, 'all'>, number>;
}
export function MailReplyHistory({
  revision,
  initialBusinessKind = 'all',
}: {
  revision: number;
  initialBusinessKind?: string;
}) {
  const selectedBusinessKind = Object.hasOwn(businessKinds, initialBusinessKind)
    ? (initialBusinessKind as keyof typeof businessKinds)
    : 'all';
  const [mailbox, setMailbox] = useState('all'),
    [kind, setKind] = useState<keyof typeof kinds>('reply'),
    [businessKind, setBusinessKind] = useState<keyof typeof businessKinds>(selectedBusinessKind),
    [replyState, setReplyState] = useState('all'),
    [page, setPage] = useState(1);
  const [result, setResult] = useState<Result | null>(null),
    [error, setError] = useState('');
  const [boxes, setBoxes] = useState<Result['mailboxes']>([]);
  useEffect(() => {
    const abort = new AbortController();
    setResult(null);
    setError('');
    const params = new URLSearchParams({
      mailboxId: mailbox,
      kind,
      businessKind,
      handling: replyState,
      page: String(page),
    });
    async function load() {
      try {
        const response = await fetch('/api/v1/outreach/reply-history?' + params, {
          signal: abort.signal,
        });
        if (!response.ok) throw new Error('无法读取本地来信记录');
        const next: Result = await response.json();
        if (!abort.signal.aborted) {
          setResult(next);
          setBoxes(next.mailboxes);
        }
      } catch (cause) {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败');
      }
    }
    void load();
    return () => abort.abort();
  }, [mailbox, kind, businessKind, replyState, page, revision]);
  return (
    <section className="business-replies" aria-label="邮箱来信跟进">
      <div className="business-filters">
        <label>
          收件邮箱
          <select
            value={mailbox}
            onChange={(e) => {
              setMailbox(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">全部邮箱</option>
            {boxes.map((b) => (
              <option key={b.id} value={b.id}>
                {b.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          业务分类
          <select
            value={businessKind}
            onChange={(e) => {
              setBusinessKind(e.target.value as keyof typeof businessKinds);
              setPage(1);
            }}
          >
            {Object.entries(businessKinds).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          来信类型
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as keyof typeof kinds);
              setReplyState('all');
              setPage(1);
            }}
          >
            {Object.entries(kinds).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {kind === 'reply' && (
          <label>
            处理情况
            <select
              value={replyState}
              onChange={(e) => {
                setReplyState(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">全部处理情况</option>
              <option value="unanswered">待跟进</option>
              <option value="answered">已有回复</option>
            </select>
          </label>
        )}
      </div>
      {result && (
        <p className="outreach-hint">
          {Object.entries(result.businessCounts)
            .map(
              ([key, count]) =>
                `${businessKinds[key as keyof typeof result.businessCounts]} ${count}`,
            )
            .join(' · ')}
        </p>
      )}
      {error ? (
        <p role="alert">{error}</p>
      ) : !result ? (
        <p role="status">正在读取来信…</p>
      ) : (
        <>
          <div className="table-wrap reply-table">
            <table>
              <thead>
                <tr>
                  {[
                    '客户 / 发件人',
                    '邮件主题',
                    '业务分类',
                    '收件邮箱',
                    '收件时间（北京）',
                    '依据',
                    '处理情况',
                  ].map((k) => (
                    <th key={k}>{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.companyName || r.from}
                      {r.companyName && <small>{r.from}</small>}
                    </td>
                    <td>
                      <Link
                        to={
                          '/inbox?' +
                          new URLSearchParams({
                            tab: 'inbox',
                            thread: r.threadId,
                            mailboxId: r.mailboxId,
                            ...(r.kind === 'reply' ? { hasReply: '1' } : {}),
                          })
                        }
                      >
                        {r.subject || '（无主题）'}
                      </Link>
                    </td>
                    <td>
                      {businessKinds[r.businessKind]}
                      {r.requestType && <small>{requestTypes[r.requestType]}</small>}
                    </td>
                    <td>{r.account}</td>
                    <td>
                      <time dateTime={r.receivedAt}>
                        {formatBeijingTime(r.receivedAt).replace('（北京时间）', '')}
                      </time>
                    </td>
                    <td>
                      {r.kind === 'reply'
                        ? r.hasLocalParent
                          ? '已关联原发信'
                          : '有回复头，未找到原发信'
                        : kinds[r.kind]}
                    </td>
                    <td>
                      <span
                        className={
                          'reply-status ' +
                          (r.handling === 'unanswered' && r.kind === 'reply' ? 'needs-reply' : '')
                        }
                      >
                        {r.handling === 'unanswered' && r.kind === 'reply'
                          ? '待跟进'
                          : handling[r.handling]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!result.items.length && <p role="status">此范围内暂无匹配来信。</p>}
          <div className="business-page-controls">
            <span>
              {result.total} 封 · 第 {page} /{' '}
              {Math.max(1, Math.ceil(result.total / result.pageSize))} 页
            </span>
            <button
              className="btn secondary small"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              上一页
            </button>
            <button
              className="btn secondary small"
              disabled={page * result.pageSize >= result.total}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </section>
  );
}
