import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { customerBusinessApi } from '../services/customerBusiness';
import type {
  BusinessConversation,
  BusinessMailBody,
  BusinessMessage,
  BusinessWorkspace,
} from '../services/customerBusiness';
import { MailMessageBody } from './MailMessageBody';
import { Badge, Empty } from './ui';
import '../mail-conversations.css';

export interface ConversationRow {
  conversation: BusinessConversation;
  customer: string;
  messages: BusinessMessage[];
  matches: BusinessMessage[];
  latestAt: string;
  preview: string;
}

export function buildConversationRows(
  data: BusinessWorkspace,
  query: string,
  direction: string,
): ConversationRow[] {
  const term = query.trim().toLowerCase();
  const contains = (values: string[]) => values.join(' ').toLowerCase().includes(term);
  const customers = new Map(data.customers.map((item) => [item.id, item.name]));
  const grouped = new Map<string, BusinessMessage[]>();
  for (const message of data.messages) {
    const messages = grouped.get(message.conversationId) || [];
    messages.push(message);
    grouped.set(message.conversationId, messages);
  }
  return data.conversations
    .flatMap((conversation) => {
      const customer = customers.get(conversation.customerId) || conversation.customerId;
      const messages = (grouped.get(conversation.id) || []).sort(
        (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id),
      );
      const contextMatch = contains([
        customer,
        conversation.title,
        conversation.owner,
        conversation.participant,
        conversation.account,
      ]);
      const matches = messages.filter(
        (message) =>
          (direction === 'all' || message.direction === direction) &&
          (contextMatch ||
            contains([
              message.subject,
              message.body,
              message.from,
              message.to,
              message.notes || '',
            ])),
      );
      if (
        (term || direction !== 'all') &&
        !matches.length &&
        !(contextMatch && direction === 'all')
      )
        return [];
      const latest = messages.at(-1);
      const match = term ? matches.at(-1) : undefined;
      const previewText =
        (match
          ? [match.body, match.subject, match.from, match.to, match.notes || ''].find((value) =>
              value.toLowerCase().includes(term),
            ) || match.body
          : latest?.body) || '尚无沟通记录';
      const compact = previewText.replace(/\s+/g, ' ').trim();
      const start = Math.max(0, compact.toLowerCase().indexOf(term) - 30);
      return [
        {
          conversation,
          customer,
          messages,
          matches,
          latestAt: latest?.occurredAt || conversation.createdAt || '',
          preview: (start ? '…' : '') + compact.slice(start, start + 160),
        },
      ];
    })
    .sort(
      (a, b) =>
        (Date.parse(b.latestAt) || 0) - (Date.parse(a.latestAt) || 0) ||
        a.conversation.id.localeCompare(b.conversation.id),
    );
}

const shortTime = (value: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

export function BusinessMessageBody({
  message,
  original,
  reveal,
}: {
  message: BusinessMessage;
  original?: BusinessMailBody;
  reveal: boolean;
}) {
  const body = original || {
    subject: message.subject,
    bodyText: message.body,
    source: 'manual' as const,
  };
  const long = message.body.length > 1200 || (body.bodyHtml?.length || 0) > 6000;
  const [expanded, setExpanded] = useState(false);
  const viewer = (
    <MailMessageBody key={original ? 'original' : 'text'} message={body} collapseQuotes={!reveal} />
  );
  return long ? (
    <details
      className="business-long-message"
      open={expanded || reveal}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {expanded || reveal ? '收起长正文' : '展开完整正文'}
        <span>{message.body.slice(0, 220)}…</span>
      </summary>
      {viewer}
    </details>
  ) : (
    viewer
  );
}

export function BusinessConversations({
  rows,
  selected,
  query,
  direction,
  focusedId,
  saving,
  channelLabel,
  onSelect,
  onEdit,
  renderMessage,
}: {
  rows: ConversationRow[];
  selected?: ConversationRow;
  query: string;
  direction: string;
  focusedId: string;
  saving: boolean;
  channelLabel: (conversation: BusinessConversation) => string;
  onSelect: (conversationId: string, messageId?: string) => void;
  onEdit: (conversation: BusinessConversation) => void;
  renderMessage: (message: BusinessMessage, body: ReactNode) => ReactNode;
}) {
  const [originals, setOriginals] = useState<{
    conversationId: string;
    bodies: Record<string, BusinessMailBody>;
  }>({ conversationId: '', bodies: {} });
  const [mailError, setMailError] = useState('');
  const [mobileDetail, setMobileDetail] = useState(!!focusedId);
  const timeline = useRef<HTMLDivElement>(null);
  const positionObserver = useRef<ResizeObserver | null>(null);
  const id = selected?.conversation.id || '';
  const filtered = !!query.trim() || direction !== 'all';
  const target =
    selected?.messages.find((message) => message.id === focusedId) ||
    (filtered ? selected?.matches.at(-1) : selected?.messages.at(-1));
  const messageIds = selected?.messages.map((message) => message.id).join(',') || '';

  useEffect(() => {
    setMailError('');
    if (!id || !selected?.messages.some((message) => message.channel === 'email')) return;
    const controller = new AbortController();
    void customerBusinessApi
      .mailBodies(id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted)
          setOriginals({ conversationId: id, bodies: result.originals });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setMailError(error instanceof Error ? error.message : '原邮件排版暂时无法读取');
      });
    return () => controller.abort();
  }, [id, messageIds]);

  useEffect(() => {
    const container = timeline.current;
    const element = target && document.getElementById(`business-record-${target.id}`);
    if (!container || !element) return;
    const position = () => {
      container.scrollTop +=
        element.getBoundingClientRect().top - container.getBoundingClientRect().top - 16;
    };
    position();
    // Earlier HTML messages can grow after loading; stop following once the reader interacts.
    const observer = new ResizeObserver(position);
    positionObserver.current = observer;
    for (const article of container.children) observer.observe(article);
    const stop = () => observer.disconnect();
    for (const event of ['wheel', 'pointerdown', 'touchstart', 'keydown'])
      container.addEventListener(event, stop, { passive: true });
    return () => {
      observer.disconnect();
      for (const event of ['wheel', 'pointerdown', 'touchstart', 'keydown'])
        container.removeEventListener(event, stop);
    };
  }, [id, target?.id, query, direction, originals, mobileDetail]);

  const hitIndex = selected?.matches.findIndex((message) => message.id === target?.id) ?? -1;
  return (
    <div className={`business-conversation-browser${mobileDetail ? ' showing-detail' : ''}`}>
      <aside className="business-conversation-sidebar" aria-label="客户会话">
        <div className="business-list-heading">
          <strong>会话</strong>
          <span>
            {rows.length} 个{filtered ? '匹配' : ''}
          </span>
        </div>
        <div className="business-conversation-items">
          {rows.length ? (
            rows.map((row) => (
              <button
                key={row.conversation.id}
                className={`business-conversation${row.conversation.id === id ? ' active' : ''}`}
                aria-pressed={row.conversation.id === id}
                onClick={() => {
                  onSelect(row.conversation.id);
                  setMobileDetail(true);
                }}
              >
                <span className="business-conversation-top">
                  <strong>{row.customer}</strong>
                  <time dateTime={row.latestAt}>{shortTime(row.latestAt)}</time>
                </span>
                <span className="business-conversation-subject">
                  {row.conversation.title || '未命名会话'}
                </span>
                <span className="business-conversation-preview">{row.preview}</span>
                <span className="business-conversation-tags">
                  <Badge>
                    {row.conversation.status === 'closed'
                      ? '已关闭'
                      : row.conversation.ownership === 'auto'
                        ? '自动接待'
                        : '人工接管'}
                  </Badge>
                  <small>
                    {query.trim() && row.matches.length
                      ? `${row.matches.length} 条命中`
                      : channelLabel(row.conversation)}
                  </small>
                </span>
              </button>
            ))
          ) : (
            <Empty
              title={filtered ? '没有匹配的会话' : '暂无会话'}
              detail={filtered ? '尝试其他关键词或调整筛选。' : '新建会话后，录入已发生的沟通。'}
            />
          )}
        </div>
      </aside>
      <section className="business-conversation-detail" aria-label="会话往来">
        {selected ? (
          <>
            <header className="business-conversation-heading">
              <button
                className="text-link business-conversation-back"
                onClick={() => setMobileDetail(false)}
              >
                <ArrowLeft size={14} />
                返回会话
              </button>
              <div className="business-conversation-heading-top">
                <Link
                  to={`/leads?dataset=real&lead=${encodeURIComponent(selected.conversation.customerId)}`}
                >
                  {selected.customer}
                </Link>
                <button
                  className="btn secondary small"
                  disabled={saving}
                  onClick={() => onEdit(selected.conversation)}
                >
                  编辑会话
                </button>
              </div>
              <h2>{selected.conversation.title || '未命名会话'}</h2>
              <div className="business-conversation-context">
                <Badge>
                  {selected.conversation.status === 'closed'
                    ? '已关闭'
                    : selected.conversation.ownership === 'auto'
                      ? '自动接待'
                      : '人工接管'}
                </Badge>
                <span>
                  {channelLabel(selected.conversation)} ·{' '}
                  {selected.conversation.account || '账号未记录'}
                </span>
                {selected.conversation.owner && <span>负责人：{selected.conversation.owner}</span>}
                <span>{selected.messages.length} 条沟通</span>
              </div>
            </header>
            {filtered && (
              <div className="business-match-navigation">
                <span>
                  {query.trim() ? `“${query.trim()}” · ` : ''}
                  {selected.matches.length
                    ? `${hitIndex + 1} / ${selected.matches.length} 条匹配 · 显示完整往来`
                    : '会话信息匹配 · 显示完整往来'}
                </span>
                <div>
                  <button
                    aria-label="上一条匹配消息"
                    disabled={hitIndex <= 0}
                    onClick={() => onSelect(id, selected.matches[hitIndex - 1].id)}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <button
                    aria-label="下一条匹配消息"
                    disabled={hitIndex < 0 || hitIndex >= selected.matches.length - 1}
                    onClick={() => onSelect(id, selected.matches[hitIndex + 1].id)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
            {mailError && (
              <p className="business-mail-error" role="status">
                原邮件排版暂时无法读取，以下显示已保存原文。
              </p>
            )}
            <div className="business-message-list" ref={timeline}>
              {selected.messages.length ? (
                selected.messages.map((message) => {
                  const hit = filtered && selected.matches.some((item) => item.id === message.id);
                  return (
                    <article
                      id={`business-record-${message.id}`}
                      key={message.id}
                      className={`business-message ${message.direction}${(hit && target?.id === message.id) || focusedId === message.id ? ' business-focused-record' : ''}`}
                      tabIndex={-1}
                    >
                      {hit && <span className="business-message-match">匹配记录</span>}
                      {renderMessage(
                        message,
                        <BusinessMessageBody
                          message={message}
                          original={
                            originals.conversationId === id
                              ? originals.bodies[message.id]
                              : undefined
                          }
                          reveal={!!query.trim() && hit && target?.id === message.id}
                        />,
                      )}
                    </article>
                  );
                })
              ) : (
                <Empty
                  title="此会话暂无沟通记录"
                  detail="点击“录入实际沟通”保存已发生的邮件、留言或通话纪要。"
                />
              )}
            </div>
            {!!selected.messages.length && (
              <div className="business-timeline-footer">
                <span>时间按北京时间显示</span>
                <button
                  className="text-link"
                  onClick={() => {
                    positionObserver.current?.disconnect();
                    if (timeline.current)
                      timeline.current.scrollTop = timeline.current.scrollHeight;
                  }}
                >
                  <ArrowDown size={13} />
                  最新消息
                </button>
              </div>
            )}
          </>
        ) : (
          <Empty title="选择会话查看往来" detail="从左侧选择一段会话，查看完整沟通与相关需求。" />
        )}
      </section>
    </div>
  );
}
