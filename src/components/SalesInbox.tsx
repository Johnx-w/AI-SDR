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
import { ReceptionControls } from './InboxReception';
import { outreachApi } from '../outreachApi';
import { ReplySources } from './ReplyPreview';
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
  demands = [],
  demandNotices = [],
  replies = [],
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
              查看跟进任务 <ArrowUpRight size={14} />
            </Link>
          )}
        </div>
      </header>
      {!!demands.length && (
        <details className="mail-conversation-source">
          <summary>自动整理的客户需求 · {demands.length}</summary>
          {demands.map((d) => (
            <div key={d.id}>
              <strong>{d.title}</strong>
              <p>
                {[d.productText, d.specifications, d.quantity && `${d.quantity} ${d.unit}`]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <blockquote>{d.evidenceQuote}</blockquote>
            </div>
          ))}
        </details>
      )}
      {demandNotices.map((notice, index) => (
        <p role="alert" className="mail-reply-error" key={index}>
          需求整理待核实：{notice}
        </p>
      ))}

      <div className="mail-conversation-timeline">
        {messages.length ? (
          messages.map((mail) => {
            const status = statuses[mail.deliveryStatus] || statuses.unknown;
            const operation =
              mail.direction === 'outbound'
                ? replies.find((reply) => reply.messageId === mail.messageId)
                : undefined;
            return (
              <article key={mail.id} className={`mail-conversation-message ${mail.direction}`}>
                <div className="mail-conversation-message-top">
                  <strong>
                    {mail.direction === 'inbound' ? (
                      <ArrowDownLeft size={16} />
                    ) : (
                      <ArrowUpRight size={16} />
                    )}
                    {mail.direction === 'inbound'
                      ? (
                          {
                            auto_reply: '系统通知',
                            unverified: '待核实回执',
                            hard_bounce: '退信',
                            unsubscribe: '退订',
                            complaint: '投诉',
                          } as Record<string, string>
                        )[mail.classification || ''] || '客户来信'
                      : operation?.origin === 'automatic' || mail.source === 'automatic'
                        ? '自动回复'
                        : '发出'}
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
                {operation?.provenance && <ReplySources sources={operation.provenance.sources} />}
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
          最近成功同步 {lastSync ? formatTime(lastSync) : '尚未同步'}
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
              {item.lastError && (
                <details>
                  <summary>最近失败诊断{!item.error && '（已恢复）'}</summary>
                  <small>
                    {formatTime(item.lastError.occurredAt)} ·{' '}
                    {
                      {
                        credentials: '读取本地凭证',
                        connect: '连接与认证',
                        folders: '获取文件夹',
                        read: '读取邮件',
                        validate: '校验同步结果',
                        save: '本地保存',
                      }[item.lastError.stage]
                    }
                  </small>
                  <small>{item.lastError.message}</small>
                  <small>
                    {[
                      item.lastError.code,
                      item.lastError.providerCode,
                      item.lastError.responseStatus,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </details>
              )}
            </div>
          ))
        ) : (
          <p>添加邮箱后可手动同步邮件。</p>
        )}
      </div>
    </details>
  );
}

export function SalesInbox({
  mailboxes,
  mailboxId = 'all',
  customerId = '',
  inboundOnly = false,
  initialThread = '',
  onMailboxChange,
  review = false,
  reviewCount,
  refreshToken = 0,
  onReviewChange,
}: {
  mailboxes: OutreachMailbox[];
  mailboxId?: string;
  customerId?: string;
  inboundOnly?: boolean;
  initialThread?: string;
  onMailboxChange: (mailboxId: string) => void;
  review?: boolean;
  reviewCount?: number;
  refreshToken?: number;
  onReviewChange?: (review: boolean) => void;
}) {
  const queueCount = review ? reviewCount : undefined;
  const [query, setQuery] = useState('');
  const [unread, setUnread] = useState(false);
  const [list, setList] = useState<MailConversationList | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(initialThread || null);
  const [detail, setDetail] = useState<MailConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [replyTarget, setReplyTarget] = useState<{ id: string; request: number } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [marking, setMarking] = useState(false);
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [page, setPage] = useState(1);
  const filterKey = JSON.stringify([mailboxId, customerId, query, unread, inboundOnly]);
  const loadedFilter = useRef(filterKey);
  const mounted = useRef(true);
  const selected = useRef<string | null>(initialThread || null);
  const linkedThread = useRef(initialThread);
  const selectConversation = useCallback((id: string | null) => {
    if (selected.current === id) return;
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

    const timeout = window.setTimeout(
      () => {
        const result: Promise<MailConversationList> = review
          ? outreachApi<{
              total: number;
              page: number;
              pageSize: number;
              items: {
                threadId: string;
                sourceId: string;
                subject: string;
                account: string;
                from: string;
                receivedAt: string;
                reason: string;
              }[];
            }>('/reception?page=' + page, { signal: controller.signal }).then((result) => {
              return {
                page: result.page,
                pageSize: result.pageSize,
                total: result.total,
                mailboxes: [],
                items: result.items.map((ticket) => ({
                  id: ticket.threadId,
                  mailboxId: '',
                  subject: ticket.subject,
                  participant: ticket.from,
                  updatedAt: ticket.receivedAt,
                  account: ticket.account,
                  preview: ticket.reason,
                  unread: false,
                  messageCount: 0,
                })),
              };
            })
          : mailConversationsApi.list(
              { mailboxId, customerId, q: query, unread, inboundOnly, page, pageSize: 25 },
              controller.signal,
            );
        void result
          .then((value) => {
            if (controller.signal.aborted) return;
            const lastPage = Math.max(1, Math.ceil(value.total / value.pageSize));
            const actualPage = Math.min(lastPage, value.page);
            if (actualPage !== page) {
              setPage(actualPage);
              return;
            }
            setList(value);
            const retained =
              !review && loadedFilter.current === filterKey
                ? selected.current
                : value.items.find((t) => t.id === selected.current)?.id;
            loadedFilter.current = filterKey;
            const first = value.items[0]?.id;
            const wide =
              typeof window.matchMedia === 'function' &&
              window.matchMedia('(min-width:1101px)').matches;
            const next =
              linkedThread.current ||
              retained ||
              ((customerId && inboundOnly) || wide ? first : null);
            linkedThread.current = '';
            selectConversation(next || null);
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
  }, [
    mailboxId,
    customerId,
    query,
    unread,
    inboundOnly,
    review,
    page,
    filterKey,
    queueCount,
    refreshToken,
    revision,
    selectConversation,
  ]);

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
  }, [selectedId, detailRevision, refreshToken]);

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
      if (unread) setRevision((value) => value + 1);
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
  const visibleThreads = list?.items.filter((item) => review || !unread || item.unread) || [];

  const identity = shownDetail
    ? mailboxes.find((box) => box.id === shownDetail.conversation.mailboxId)
    : null;
  return (
    <section className="sales-inbox mail-conversations">
      {customerId && (
        <p className="mail-conversations-scope">
          {inboundOnly ? '仅显示该客户有来信的会话' : '仅显示该客户邮件'} ·{' '}
          <Link to="/inbox?tab=inbox">查看全部客户</Link>
        </p>
      )}
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

      <div
        className={`mail-conversations-workspace panel ${selectedId ? 'has-selection' : 'no-selection'}`}
      >
        <aside className="mail-conversation-list" aria-label="邮件会话列表" aria-busy={loading}>
          <div className="inbox-list-head">
            <h2>{review ? '待审草稿' : '收件箱'}</h2>
            <button
              className="icon-button"
              title="刷新列表"
              aria-label="刷新本地邮件缓存"
              disabled={loading}
              onClick={() => setRevision((v) => v + 1)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="inbox-scopes">
            <button
              type="button"
              aria-pressed={!review && !unread}
              onClick={() => {
                setPage(1);
                setUnread(false);
                if (review) onReviewChange?.(false);
              }}
            >
              全部
            </button>
            <button
              type="button"
              aria-pressed={!review && unread}
              onClick={() => {
                setPage(1);
                setUnread(true);
                if (review) onReviewChange?.(false);
              }}
            >
              未读
            </button>
            <button
              type="button"
              aria-pressed={review}
              onClick={() => {
                setPage(1);
                setUnread(false);
                onReviewChange?.(true);
              }}
            >
              待审
            </button>
          </div>
          {!review && (
            <div className="inbox-filters">
              <label className="mail-account-filter">
                <Mail size={15} />
                <select
                  aria-label="筛选会话邮箱"
                  value={mailboxId}
                  onChange={(e) => onMailboxChange(e.target.value)}
                >
                  <option value="all">全部邮箱</option>
                  {mailboxes.map((box) => (
                    <option key={box.id} value={box.id}>
                      {box.email}
                    </option>
                  ))}
                  {mailboxId !== 'all' && !mailboxes.some((b) => b.id === mailboxId) && (
                    <option value={mailboxId}>邮箱不存在</option>
                  )}
                </select>
              </label>
              <label className="outreach-search mail-conversation-search">
                <Search size={15} />
                <input
                  aria-label="搜索邮件会话"
                  placeholder="搜索客户、邮件主题或正文"
                  value={query}
                  onChange={(e) => {
                    setPage(1);
                    setQuery(e.target.value);
                  }}
                />
              </label>
            </div>
          )}
          {loading ? (
            <div className="mail-conversation-placeholder" role="status">
              <LoaderCircle size={22} className="outreach-spin" />
              正在读取邮件会话…
            </div>
          ) : listError && !list ? (
            <Empty title="会话读取失败" detail="请重新读取列表，或检查服务是否正常。" />
          ) : visibleThreads.length ? (
            <div className="mail-conversation-items">
              {visibleThreads.map((thread, index) => (
                <button
                  key={review ? thread.id + '-' + index : thread.id}
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
                    {!review && <span>{thread.messageCount} 封</span>}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title={
                review
                  ? '当前没有待审回信'
                  : query || unread
                    ? '没有符合筛选的会话'
                    : customerId && inboundOnly
                      ? '暂无该客户的来信'
                      : '暂无邮件会话'
              }
              detail={
                review
                  ? '需要审核的客户回信将在这里显示。'
                  : query || unread
                    ? '试试调整搜索词或取消未读筛选。'
                    : customerId && inboundOnly
                      ? '当前已同步的邮箱记录中没有该客户的来信，可同步邮件后重新查看。'
                      : '可手动同步邮箱；系统发送的邮件也会在这里保存。'
              }
            />
          )}
          {list && (
            <nav className="inbox-pager" aria-label={review ? '待审分页' : '会话分页'}>
              <span aria-live="polite">
                共 {list.total} {review ? '项' : '段'} · {page} /{' '}
                {Math.max(1, Math.ceil(list.total / list.pageSize))}
              </span>
              <div>
                <button
                  type="button"
                  disabled={loading || page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </button>
                <button
                  type="button"
                  disabled={loading || page * list.pageSize >= list.total}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </button>
              </div>
            </nav>
          )}
          {!review && (
            <div className="inbox-sync">
              <button
                type="button"
                className="btn secondary"
                disabled={syncing || !scopeMailboxes.some((box) => box.configured)}
                onClick={() => void sync()}
              >
                <RefreshCw size={14} className={syncing ? 'outreach-spin' : ''} />
                {syncing ? '正在同步…' : '同步邮件'}
              </button>
              <MailSyncSummary statuses={syncStatuses} />
            </div>
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
              {detailLoading && !shownDetail ? (
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
                    key={shownDetail.conversation.id + '-' + detailRevision}
                    detail={shownDetail}
                    targetMessageId={replyTarget?.id}
                    replyRequest={replyTarget?.request}
                    onCompleted={(value) => {
                      setDetail(value);
                      if (review) setRevision((v) => v + 1);
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
        {shownDetail && (
          <aside className="inbox-contact" aria-label="联系人及接待设置">
            <h3>联系人</h3>
            <strong>
              {shownDetail.conversation.companyName || shownDetail.conversation.participant}
            </strong>
            <p>{shownDetail.conversation.participant}</p>
            {shownDetail.conversation.customerId && (
              <Link to={'/leads?lead=' + encodeURIComponent(shownDetail.conversation.customerId)}>
                客户档案
              </Link>
            )}
            <h3>负责邮箱</h3>
            <strong>{identity?.brandName || shownDetail.conversation.account}</strong>
            <p>{shownDetail.conversation.account}</p>
            {identity && (
              <Link to={'/inbox?tab=mailboxes&mailboxId=' + encodeURIComponent(identity.id)}>
                邮箱设置
              </Link>
            )}
            <ReceptionControls
              detail={shownDetail}
              onChange={() => setDetailRevision((v) => v + 1)}
            />
          </aside>
        )}
      </div>
    </section>
  );
}
