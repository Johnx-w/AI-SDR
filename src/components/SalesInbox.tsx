import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  Inbox,
  LoaderCircle,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { OutreachMailbox } from '../outreachApi';
import { mailConversationsApi } from '../services/mailConversations';
import type {
  MailConversationDetail,
  MailConversationList,
  MailboxSyncStatus,
  MailThread,
} from '../services/mailConversations';
import { Empty } from './ui';
import { InboxAvatar, InboxThread } from './InboxThread';
import { outreachApi } from '../outreachApi';
import '../mail-conversations.css';

export type InboxView = 'all' | 'unread' | 'hasReply' | 'later' | 'done';
const primaryViews = [
  ['all', '全部'],
  ['unread', '未读'],
  ['hasReply', '有回复'],
] as const;

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
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="mail-sync-accounts">
        {lastSync && <small>最近成功同步 {formatTime(lastSync)}</small>}
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
  view = 'all',
  initialQuery = '',
  onViewChange,
  onMailboxChange,
  review = false,
  reviewCount,
  refreshToken = 0,
  onExitReview,
}: {
  mailboxes: OutreachMailbox[];
  mailboxId?: string;
  customerId?: string;
  inboundOnly?: boolean;
  initialThread?: string;
  view?: InboxView;
  initialQuery?: string;
  onViewChange: (view: InboxView, query: string) => void;
  onMailboxChange: (mailboxId: string, query: string) => void;
  review?: boolean;
  reviewCount?: number;
  refreshToken?: number;
  onExitReview: () => void;
}) {
  const queueCount = review ? reviewCount : undefined;
  const [query, setQuery] = useState(initialQuery);
  const unread = view === 'unread';
  const hasReply = view === 'hasReply';
  const folder = view === 'later' || view === 'done' ? view : undefined;
  const [list, setList] = useState<MailConversationList | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(initialThread || null);
  const [detail, setDetail] = useState<MailConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [marking, setMarking] = useState(false);
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [pagination, setPagination] = useState({ view, page: 1 });
  const page = pagination.view === view ? pagination.page : 1;
  const setPage = useCallback((page: number) => setPagination({ view, page }), [view]);
  const filterKey = JSON.stringify([mailboxId, customerId, query, view, inboundOnly]);
  const loadedFilter = useRef(filterKey);
  const mounted = useRef(true);
  const workspace = useRef<HTMLDivElement>(null);
  const openedRow = useRef<HTMLButtonElement | null>(null);
  const selected = useRef<string | null>(initialThread || null);
  const linkedThread = useRef(initialThread);
  const selectConversation = useCallback((id: string | null) => {
    if (selected.current === id) return;
    selected.current = id;
    setSelectedId(id);
    setDetail(null);
    setDetailError('');
  }, []);
  function revealDetailOnNarrowScreen() {
    if (!window.matchMedia('(max-width: 760px)').matches) return;
    window.requestAnimationFrame(() => {
      workspace.current
        ?.querySelector<HTMLElement>('.mail-conversation-detail')
        ?.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
  }
  function backToList() {
    selectConversation(null);
    requestAnimationFrame(() => {
      const row = openedRow.current?.isConnected
        ? openedRow.current
        : workspace.current?.querySelector<HTMLButtonElement>(
            '.mail-conversation-row, .inbox-scopes button',
          );
      row?.focus({ preventScroll: true });
    });
  }
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
              {
                mailboxId,
                customerId,
                q: query,
                unread,
                hasReply,
                inboundOnly,
                page,
                pageSize: 25,
                folder,
              },
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
            const next = linkedThread.current || retained || first;
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
    hasReply,
    inboundOnly,
    review,
    page,
    filterKey,
    folder,
    queueCount,
    refreshToken,
    revision,
    selectConversation,
    setPage,
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

  useEffect(() => {
    const host = workspace.current;
    if (!host) return;
    let frame = 0;
    const viewport = window.visualViewport;
    function measure() {
      frame = 0;
      if (!host) return;
      const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const height = Math.max(
        0,
        Math.floor(bottom - Math.max(0, host.getBoundingClientRect().top) - 12),
      );
      const next = height + 'px';
      if (host.style.getPropertyValue('--inbox-available') !== next)
        host.style.setProperty('--inbox-available', next);
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !host.contains(event.target)) schedule();
    };
    const observer = new ResizeObserver(schedule);
    const parent = host.closest('.outreach-page');
    if (parent) observer.observe(parent);
    const topbar = document.querySelector('.topbar');
    if (topbar) observer.observe(topbar);
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    document.addEventListener('scroll', onScroll, true);
    measure();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);
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
      if (unread) {
        if (selected.current === thread.id) selectConversation(null);
        setRevision((value) => value + 1);
      }
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
  const visibleThreads = list?.items || [];
  const filtered = Boolean(query || view !== 'all');
  function switchView(next: InboxView) {
    if (view === next) return;
    setPage(1);
    onViewChange(next, query);
  }

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
        ref={workspace}
        className={`mail-conversations-workspace panel ${selectedId ? 'has-selection' : 'no-selection'}`}
      >
        <aside className="mail-conversation-list" aria-label="邮件会话列表" aria-busy={loading}>
          <div className="inbox-list-title">
            <strong>{review ? '待审草稿' : '邮件会话'}</strong>
            <span aria-live="polite" aria-label={`共 ${list?.total ?? '…'} 段会话`}>
              {list ? `${list.total} 个` : '更新中'}
            </span>
          </div>
          <div className="inbox-list-head">
            <Inbox size={16} />
            {review ? (
              <b>待审草稿</b>
            ) : (
              <select
                aria-label="筛选会话邮箱"
                title={mailboxes.find((box) => box.id === mailboxId)?.email || '全部邮箱'}
                value={mailboxId}
                onChange={(e) => onMailboxChange(e.target.value, query)}
              >
                <option value="all">全部邮箱</option>
                {mailboxes.map((box) => (
                  <option value={box.id} key={box.id}>
                    {box.email}
                  </option>
                ))}
                {mailboxId !== 'all' && !mailboxes.some((box) => box.id === mailboxId) && (
                  <option value={mailboxId}>邮箱不存在</option>
                )}
              </select>
            )}
            {!review && (
              <div className="inbox-scopes" role="group" aria-label="会话筛选">
                {primaryViews.map(([key, label]) => (
                  <button
                    type="button"
                    key={key}
                    aria-pressed={view === key}
                    onClick={() => switchView(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="inbox-filters">
            {!review && (
              <label>
                <Search size={14} />
                <input
                  aria-label="搜索邮件会话"
                  placeholder="搜索会话"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
            )}
            {review && (
              <button className="text-link" onClick={onExitReview}>
                返回全部会话
              </button>
            )}
            {!review && (
              <label className="inbox-folder-select" data-active={!!folder} title="其他处理状态">
                <Archive size={14} aria-hidden="true" />
                <select
                  aria-label="其他处理状态"
                  value={folder || ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    switchView(value === 'later' || value === 'done' ? value : 'all');
                  }}
                >
                  <option value="">其他状态</option>
                  <option value="later">稍后</option>
                  <option value="done">已完成</option>
                </select>
              </label>
            )}
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
              {visibleThreads.map((thread, index) => {
                const brand =
                  mailboxes.find(
                    (box) => box.id === thread.mailboxId || box.email === thread.account,
                  )?.brandName || thread.account;
                return (
                  <button
                    key={review ? thread.id + '-' + index : thread.id}
                    className={`mail-conversation-row ${selectedId === thread.id ? 'selected' : ''} ${thread.unread ? 'unread' : ''}`}
                    aria-pressed={selectedId === thread.id}
                    onClick={(event) => {
                      openedRow.current = event.currentTarget;
                      selectConversation(thread.id);
                      revealDetailOnNarrowScreen();
                    }}
                  >
                    <span className="mail-conversation-row-top">
                      <InboxAvatar
                        name={thread.participantName || thread.companyName || thread.participant}
                      />
                      {thread.unread && <i aria-label="未读" />}
                      <strong title={thread.participant}>
                        {thread.participantName || thread.companyName || thread.participant}
                      </strong>
                      <time dateTime={thread.updatedAt}>{formatTime(thread.updatedAt)}</time>
                    </span>
                    {thread.preview?.trim() && (
                      <span className="mail-conversation-preview">{thread.preview}</span>
                    )}
                    <span className="mail-conversation-row-meta">
                      <span className="mail-conversation-row-subject" title={thread.subject}>
                        {thread.subject || '（无主题）'}
                      </span>
                      {(mailboxId === 'all' || review) && brand && (
                        <span className="inbox-brand-label" title={thread.account}>
                          {brand}
                        </span>
                      )}
                      {!review && thread.messageCount > 1 && (
                        <span className="mail-conversation-row-count">
                          {thread.messageCount} 封
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <Empty
              title={
                review
                  ? '当前没有待审回信'
                  : filtered
                    ? '没有符合筛选的会话'
                    : customerId && inboundOnly
                      ? '暂无该客户的来信'
                      : '暂无邮件会话'
              }
              detail={
                review
                  ? '需要审核的客户回信将在这里显示。'
                  : filtered
                    ? '可调整搜索词、选择其他邮箱或返回全部会话。'
                    : customerId && inboundOnly
                      ? '当前已同步的邮箱记录中没有该客户的来信，可同步邮件后重新查看。'
                      : '可手动同步邮箱；系统发送的邮件也会在这里保存。'
              }
            />
          )}
          {list && list.total > list.pageSize && (
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
            <div className="inbox-sync-footer">
              <MailSyncSummary statuses={syncStatuses} />
              <button
                type="button"
                className="inbox-sync-action"
                aria-label="同步邮件"
                title={mailboxId === 'all' ? '同步全部邮箱' : '同步所选邮箱'}
                disabled={syncing || !scopeMailboxes.some((box) => box.configured)}
                onClick={() => void sync()}
              >
                <RefreshCw
                  size={13}
                  aria-hidden="true"
                  className={syncing ? 'outreach-spin' : undefined}
                />
                {syncing ? '同步中…' : '同步'}
              </button>
            </div>
          )}
        </aside>
        {shownDetail ? (
          <InboxThread
            key={shownDetail.conversation.id}
            detail={shownDetail}
            identity={identity || undefined}
            onBack={backToList}
            marking={marking}
            onRead={() => void markRead(shownDetail.conversation)}
            onRefresh={() => setDetailRevision((n) => n + 1)}
            editorVersion={detailRevision}
            onWorkflow={(id, workflow, move) => {
              if (selected.current !== id) return;
              setDetail((d) => (d && d.conversation.id === id ? { ...d, workflow } : d));
              if (move) {
                if (!review && folder && folder !== workflow.state) selectConversation(null);
                setRevision((n) => n + 1);
              }
            }}
            onCompleted={(value) => {
              if (selected.current !== value.conversation.id) return;
              setDetail(value);
              if (review && value.replies?.[0]?.status === 'accepted')
                setNotice('回复已被服务商接受。');
              if (review) setRevision((n) => n + 1);
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
        ) : (
          <section
            className="mail-conversation-detail"
            aria-label="邮件会话详情"
            aria-busy={detailLoading}
          >
            {selectedId && (
              <button
                type="button"
                className="mail-conversation-back inbox-icon"
                aria-label="返回会话列表"
                onClick={backToList}
              >
                <ArrowLeft size={16} />
              </button>
            )}
            {detailError ? (
              <div className="outreach-alert error" role="alert">
                {detailError}{' '}
                <button className="btn subtle" onClick={() => setDetailRevision((n) => n + 1)}>
                  重试读取
                </button>
              </div>
            ) : selectedId ? (
              <div role="status" className="mail-conversation-placeholder">
                <LoaderCircle className="outreach-spin" size={19} />
                正在读取邮件正文…
              </div>
            ) : (
              <div className="mail-conversation-welcome">
                <Inbox size={30} />
                <h3>选择一段邮件会话</h3>
              </div>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
