import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  Inbox,
  LoaderCircle,
  Mail,
  RefreshCw,
  Reply,
  Search,
} from 'lucide-react';
import type { OutreachMailbox } from '../outreachApi';
import { mailConversationsApi } from '../services/mailConversations';
import type {
  MailConversationDetail,
  MailConversationList,
  MailboxSyncStatus,
  MailMessage,
  MailThread,
} from '../services/mailConversations';
import { Badge, Empty } from './ui';
import { MailMessageBody } from './MailMessageBody';
import { MailReplyComposer } from './MailReplyComposer';
import '../mail-conversations.css';

const formatTime = (value?: string | null) => {
  if (!value) return '尚未同步';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '时间未知'
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
};
const errorText = (reason: unknown) =>
  reason instanceof Error ? reason.message : '读取未完成，请重试。';
const statuses: Record<MailMessage['deliveryStatus'], { label: string; tone: string }> = {
  received: { label: '已收到', tone: 'green' },
  sent: { label: '已发出', tone: 'green' },
  accepted: { label: '服务商已接受', tone: 'neutral' },
  unknown: { label: '结果待核实', tone: 'amber' },
  failed: { label: '发送失败', tone: 'red' },
  sending: { label: '正在提交', tone: 'neutral' },
};

export function MailConversationTimeline({
  conversation,
  messages,
  onReply,
}: MailConversationDetail & { onReply?: (id: string) => void }) {
  return (
    <>
      <header className="mail-conversation-heading">
        <div className="mail-conversation-eyebrow">
          <Mail size={15} /> {conversation.account}
        </div>
        <h3>{conversation.subject || '（无主题）'}</h3>
        {conversation.recordError && (
          <p role="alert" className="mail-reply-error">
            {conversation.recordError}
          </p>
        )}
        <div className="mail-conversation-participant">
          <span>{conversation.companyName || conversation.participant}</span>
          {conversation.companyName && <span>{conversation.participant}</span>}
          {conversation.customerId && (
            <Link to={`/business?customerId=${encodeURIComponent(conversation.customerId)}`}>
              查看客户业务 <ArrowUpRight size={14} />
            </Link>
          )}
        </div>
      </header>
      <div className="mail-conversation-timeline">
        {messages.length ? (
          messages.map((mail) => {
            const status = statuses[mail.deliveryStatus] || statuses.unknown;
            return (
              <article key={mail.id} className={`mail-conversation-message ${mail.direction}`}>
                <div className="mail-conversation-message-top">
                  <strong>
                    {mail.direction === 'inbound' ? (
                      <ArrowDownLeft size={16} />
                    ) : (
                      <ArrowUpRight size={16} />
                    )}
                    {mail.direction === 'inbound' ? '收到' : '发出'}
                  </strong>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <time dateTime={mail.occurredAt}>{formatTime(mail.occurredAt)}</time>
                </div>
                <dl className="mail-conversation-addresses">
                  <div>
                    <dt>发件人</dt>
                    <dd>{mail.from}</dd>
                  </div>
                  <div>
                    <dt>收件人</dt>
                    <dd>{mail.to}</dd>
                  </div>
                  <div>
                    <dt>主题</dt>
                    <dd>{mail.subject || '（无主题）'}</dd>
                  </div>
                </dl>
                <MailMessageBody key={mail.id} message={mail} />
                {!!mail.attachments?.length && (
                  <p className="mail-conversation-source">
                    附件：
                    {mail.attachments
                      .map((attachment) => attachment.name || attachment.contentType)
                      .join('、')}
                    （请在原邮箱查看）
                  </p>
                )}
                <footer className="mail-conversation-source">
                  {mail.source === 'imap'
                    ? '来自邮箱同步'
                    : mail.source === 'manual'
                      ? '人工回复'
                      : '来自系统发送记录'}
                  {mail.deliveryStatus === 'accepted' && ' · 提交结果不代表对方已收到'}
                  {mail.messageId && (
                    <details>
                      <summary>邮件编号</summary>
                      <span>{mail.messageId}</span>
                    </details>
                  )}
                  {mail.direction === 'inbound' && onReply && (
                    <button
                      type="button"
                      className="mail-message-reply"
                      onClick={() => onReply(mail.id)}
                    >
                      <Reply size={14} />
                      回复
                    </button>
                  )}
                </footer>
              </article>
            );
          })
        ) : (
          <Empty title="会话暂无邮件" detail="邮件正文尚未保存，可手动同步后重试。" />
        )}
      </div>
    </>
  );
}

export function MailSyncSummary({ statuses: syncStatuses }: { statuses: MailboxSyncStatus[] }) {
  const failures = syncStatuses.filter((item) => item.error);
  const lastSync = syncStatuses
    .map((item) => item.lastSyncAt)
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);
  return (
    <details className="mail-sync-summary" open={failures.length > 0 || undefined}>
      <summary>
        <span>
          <span className={`mail-sync-dot ${failures.length ? 'error' : ''}`} />
          {failures.length ? `${failures.length} 个邮箱同步异常` : '邮箱同步状态'}
        </span>
        <span>
          最近同步 {lastSync ? formatTime(lastSync) : '尚未同步'}
          <ChevronDown size={14} />
        </span>
      </summary>
      <div className="mail-sync-accounts">
        {syncStatuses.length ? (
          syncStatuses.map((item) => (
            <div key={item.mailboxId} className="mail-sync-account">
              <div>
                <strong>{item.email}</strong>
                <span>{item.syncing ? '正在同步…' : formatTime(item.lastSyncAt)}</span>
              </div>
              {!!item.folders?.length && <small>已同步文件夹：{item.folders.join('、')}</small>}
              {item.hasMore && <small>还有邮件待同步，可再次点击同步邮件继续读取。</small>}
              {item.error && <p role="alert">{item.error}</p>}
            </div>
          ))
        ) : (
          <p>添加邮箱后可手动同步邮件。</p>
        )}
      </div>
    </details>
  );
}

export function MailConversations({
  mailboxes,
  mailboxId = 'all',
  onMailboxChange,
}: {
  mailboxes: OutreachMailbox[];
  mailboxId?: string;
  onMailboxChange: (mailboxId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [unread, setUnread] = useState(false);
  const [list, setList] = useState<MailConversationList | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MailConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [replyTarget, setReplyTarget] = useState<{ id: string; request: number } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [marking, setMarking] = useState(false);
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const mounted = useRef(true);
  const selected = useRef<string | null>(null);
  const selectConversation = useCallback((id: string | null) => {
    selected.current = id;
    setSelectedId(id);
    setDetail(null);
    setDetailError('');
    setReplyTarget(null);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListError('');
    setList(null);
    selectConversation(null);
    const timeout = window.setTimeout(
      () => {
        void mailConversationsApi
          .list({ mailboxId, q: query, unread }, controller.signal)
          .then((value) => {
            if (controller.signal.aborted) return;
            setList(value);
          })
          .catch((reason: unknown) => {
            if (!controller.signal.aborted) setListError(errorText(reason));
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [mailboxId, query, unread, revision, selectConversation]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError('');
    void mailConversationsApi
      .detail(selectedId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setDetailError(errorText(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedId, detailRevision]);

  async function sync() {
    if (syncing) return;
    const scopeLabel =
      mailboxId === 'all'
        ? '全部邮箱'
        : mailboxes.find((item) => item.id === mailboxId)?.email || '所选邮箱';
    setSyncing(true);
    setNotice('');
    setListError('');
    try {
      const result = await mailConversationsApi.sync(mailboxId);
      if (!mounted.current) return;
      setNotice(
        `${scopeLabel}本次同步结束，新保存 ${result.imported} 封邮件。请查看各邮箱同步状态。`,
      );
      setRevision((value) => value + 1);
    } catch (reason) {
      if (mounted.current) setListError(errorText(reason));
    } finally {
      if (mounted.current) setSyncing(false);
    }
  }
  async function markRead(thread: MailThread) {
    setMarking(true);
    setDetailError('');
    try {
      const result = await mailConversationsApi.markRead(thread.id);
      if (!mounted.current) return;
      if (selected.current === thread.id)
        setDetail((value) => (value ? { ...value, conversation: result.conversation } : value));
      setList((value) =>
        value
          ? {
              ...value,
              items: value.items.map((item) =>
                item.id === thread.id ? result.conversation : item,
              ),
            }
          : value,
      );
    } catch (reason) {
      if (mounted.current && selected.current === thread.id) setDetailError(errorText(reason));
    } finally {
      if (mounted.current) setMarking(false);
    }
  }

  const shownDetail = detail?.conversation.id === selectedId ? detail : null;
  const scopeMailboxes =
    mailboxId === 'all' ? mailboxes : mailboxes.filter((item) => item.id === mailboxId);
  const syncStatuses = scopeMailboxes.map(
    (item) =>
      list?.mailboxes.find((status) => status.mailboxId === item.id) || {
        mailboxId: item.id,
        email: item.email,
        lastSyncAt: null,
        error: null,
      },
  );
  const visibleThreads = list?.items.filter((item) => !unread || item.unread) || [];

  return (
    <section className="mail-conversations">
      <div className="outreach-section-heading">
        <div>
          <h2>邮件会话</h2>
          <p>按邮箱查看已保存的来信与往来邮件，查看正文不会发送邮件。</p>
        </div>
        <button
          className="btn primary"
          disabled={syncing || !scopeMailboxes.some((item) => item.configured)}
          onClick={() => void sync()}
        >
          <RefreshCw size={15} className={syncing ? 'outreach-spin' : ''} />
          {syncing ? '正在同步…' : '同步邮件'}
        </button>
      </div>
      <div className="mail-conversations-toolbar panel">
        <label className="mail-account-filter">
          <Mail size={16} />
          <select
            aria-label="筛选会话邮箱"
            value={mailboxId}
            onChange={(event) => onMailboxChange(event.target.value)}
          >
            <option value="all">全部邮箱</option>
            {mailboxes.map((item) => (
              <option value={item.id} key={item.id}>
                {item.email}
              </option>
            ))}
            {mailboxId !== 'all' && !mailboxes.some((item) => item.id === mailboxId) && (
              <option value={mailboxId}>邮箱不存在</option>
            )}
          </select>
        </label>
        <label className="outreach-search mail-conversation-search">
          <Search size={17} />
          <input
            aria-label="搜索邮件会话"
            value={query}
            placeholder="搜索客户、邮箱、主题或正文"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="mail-unread-filter">
          <input
            type="checkbox"
            checked={unread}
            onChange={(event) => setUnread(event.target.checked)}
          />
          仅看未读
        </label>
        <button
          className="btn subtle"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
          aria-label="刷新本地邮件缓存"
        >
          <RefreshCw size={15} />
          刷新列表
        </button>
      </div>
      <p className="mail-conversations-scope">
        首次同步读取最近 30
        天的收件箱与可识别的已发件箱，之后继续增量读取。点击“同步邮件”才会连接邮箱读取，未读标记仅用于本工作台。
      </p>
      {notice && (
        <div className="outreach-alert success" role="status">
          {notice}
        </div>
      )}
      {listError && (
        <div className="outreach-alert error" role="alert">
          {listError}
          <button className="btn subtle" onClick={() => setRevision((value) => value + 1)}>
            重新读取列表
          </button>
        </div>
      )}
      <MailSyncSummary statuses={syncStatuses} />
      <div
        className={`mail-conversations-workspace panel ${selectedId ? 'has-selection' : 'no-selection'}`}
      >
        <aside className="mail-conversation-list" aria-label="邮件会话列表" aria-busy={loading}>
          <div className="mail-conversation-list-heading">
            <strong>会话列表</strong>
            <span>{loading ? '读取中' : `${visibleThreads.length} 个会话`}</span>
          </div>
          {loading ? (
            <div className="mail-conversation-placeholder" role="status">
              <LoaderCircle size={22} className="outreach-spin" />
              正在读取邮件会话…
            </div>
          ) : listError && !list ? (
            <Empty title="会话读取失败" detail="请重新读取列表，或检查服务是否正常。" />
          ) : visibleThreads.length ? (
            <div className="mail-conversation-items">
              {visibleThreads.map((thread) => (
                <button
                  key={thread.id}
                  className={`mail-conversation-row ${selectedId === thread.id ? 'selected' : ''} ${thread.unread ? 'unread' : ''}`}
                  aria-pressed={selectedId === thread.id}
                  onClick={() => selectConversation(thread.id)}
                >
                  <span className="mail-conversation-row-top">
                    <strong>{thread.companyName || thread.participant}</strong>
                    <time>{formatTime(thread.updatedAt)}</time>
                  </span>
                  <span className="mail-conversation-row-subject">
                    {thread.unread && <i aria-label="未读" />}
                    {thread.subject || '（无主题）'}
                  </span>
                  <span className="mail-conversation-preview">
                    {thread.preview || '暂无正文摘要'}
                  </span>
                  <span className="mail-conversation-row-account">
                    <Mail size={12} />
                    {thread.account}
                    <span>{thread.messageCount} 封</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title={query || unread ? '没有符合筛选的会话' : '暂无邮件会话'}
              detail={
                query || unread
                  ? '试试调整搜索词或取消未读筛选。'
                  : '可手动同步邮箱；系统发送的邮件也会在这里保存。'
              }
            />
          )}
          {list?.hasMore && (
            <p className="mail-conversation-list-note">
              当前显示最近 {list.items.length} 个会话，请按邮箱或关键词缩小范围。
            </p>
          )}
        </aside>
        <section
          className="mail-conversation-detail"
          aria-label="邮件会话详情"
          aria-busy={!!selectedId && detailLoading}
        >
          {selectedId ? (
            <>
              <button
                type="button"
                className="mail-conversation-back"
                onClick={() => selectConversation(null)}
              >
                <ArrowLeft size={15} />
                返回会话列表
              </button>
              {detailError && (
                <div className="outreach-alert error" role="alert">
                  {detailError}
                  <button
                    className="btn subtle"
                    onClick={() => setDetailRevision((value) => value + 1)}
                  >
                    重试读取
                  </button>
                </div>
              )}
              {detailLoading ? (
                <div className="mail-conversation-placeholder" role="status">
                  <LoaderCircle size={22} className="outreach-spin" />
                  正在读取邮件正文…
                </div>
              ) : shownDetail ? (
                <>
                  {shownDetail.conversation.unread && (
                    <div className="mail-conversation-read-action">
                      <button
                        className="btn subtle"
                        disabled={marking}
                        onClick={() => void markRead(shownDetail.conversation)}
                      >
                        <Check size={15} />
                        {marking ? '正在保存…' : '标为已读'}
                      </button>
                    </div>
                  )}
                  <MailConversationTimeline
                    {...shownDetail}
                    onReply={(id) =>
                      setReplyTarget((current) => ({ id, request: (current?.request || 0) + 1 }))
                    }
                  />
                  <MailReplyComposer
                    key={shownDetail.conversation.id}
                    detail={shownDetail}
                    targetMessageId={replyTarget?.id}
                    replyRequest={replyTarget?.request}
                    onCompleted={(value) => {
                      setDetail(value);
                      setList((current) =>
                        current
                          ? {
                              ...current,
                              items: current.items.map((item) =>
                                item.id === value.conversation.id ? value.conversation : item,
                              ),
                            }
                          : current,
                      );
                    }}
                  />
                </>
              ) : null}
            </>
          ) : (
            <div className="mail-conversation-welcome">
              <span>
                <Inbox size={30} />
              </span>
              <h3>选择一段邮件会话</h3>
              <p>在左侧查看来信与发信，保留同一邮箱的往来顺序。</p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
