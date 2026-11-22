import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CircleCheck,
  Clock3,
  ContactRound,
  Inbox,
  LockKeyhole,
  Mail,
  MailCheck,
  PanelRight,
  Paperclip,
  Reply,
  RotateCcw,
  StickyNote,
  UserRound,
  X,
} from 'lucide-react';
import {
  mailConversationsApi,
  type InboxFolder,
  type InboxWorkflow,
  type MailConversationDetail,
  type MailMessage,
} from '../services/mailConversations';
import type { OutreachMailbox } from '../outreachApi';
import { ReceptionControls } from './InboxReception';
import { MailReplyComposer } from './MailReplyComposer';
import { MailMessageBody } from './MailMessageBody';
import { ReplySources } from './ReplyPreview';
import { sanitizeReplyHtml } from '../services/mailHtml';
import { Empty } from './ui';

const day = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});
const clock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
function timePart(value: string, format: Intl.DateTimeFormat) {
  const dt = new Date(value);
  return Number.isFinite(dt.getTime()) ? format.format(dt) : '时间未知';
}
export function InboxAvatar({ name, large = false }: { name: string; large?: boolean }) {
  const base = (name || '').split('@')[0];
  const words = base
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : base.slice(0, 2);
  const color = [...base].reduce((n, c) => n + c.charCodeAt(0), 0) % 5;
  return (
    <span
      aria-hidden="true"
      className={'inbox-avatar avatar-color-' + color + (large ? ' large' : '')}
    >
      {letters.toUpperCase() || <UserRound size={15} />}
    </span>
  );
}
const deliveryLabels: Record<MailMessage['deliveryStatus'], string> = {
  received: '已收到',
  sent: '已发出',
  accepted: '服务商已接受',
  unknown: '结果待核实',
  failed: '发送失败',
  sending: '正在提交',
};
const classLabels: Record<string, string> = {
  auto_reply: '系统通知',
  unverified: '待核实回执',
  hard_bounce: '退信',
  unsubscribe: '退订',
  complaint: '投诉',
};
export function MailConversationTimeline({
  conversation,
  messages,
  demands = [],
  demandNotices = [],
  replies = [],
  workflow,
  onReply,
}: MailConversationDetail & { onReply?: (id: string) => void }) {
  const events = [
    ...messages.map((mail) => ({ at: mail.occurredAt, id: mail.id, mail, note: null })),
    ...(workflow?.notes || []).map((note) => ({
      at: note.createdAt,
      id: note.id,
      note,
      mail: null,
    })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latestId = messages.at(-1)?.id;
  return (
    <>
      <header className="inbox-subject">
        <span className="inbox-account-chip">
          <Inbox size={12} />
          {conversation.account}
        </span>
        {conversation.customerId && (
          <Link to={'/business?customerId=' + encodeURIComponent(conversation.customerId)}>
            查看跟进任务 <ArrowUpRight size={12} />
          </Link>
        )}
      </header>
      {conversation.recordError && (
        <p role="alert" className="mail-reply-error">
          {conversation.recordError}
        </p>
      )}
      {!!demands.length && (
        <details className="inbox-evidence">
          <summary>自动整理的客户需求 · {demands.length}</summary>
          {demands.map((d) => (
            <div key={d.id}>
              <strong>{d.title}</strong>
              <p>
                {[d.productText, d.specifications, d.quantity && d.quantity + ' ' + d.unit]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <blockquote>{d.evidenceQuote}</blockquote>
            </div>
          ))}
        </details>
      )}
      {demandNotices.map((notice, i) => (
        <p key={i} role="alert" className="mail-reply-error">
          需求整理待核实：{notice}
        </p>
      ))}
      <div className="inbox-timeline">
        {events.map(({ id, at, mail, note }, i) => {
          const date = timePart(at, day);
          const operation = replies.find((r) => r.messageId && r.messageId === mail?.messageId);
          const author = mail?.fromName || mail?.from;
          return (
            <Fragment key={id}>
              {(!i || timePart(events[i - 1].at, day) !== date) && (
                <div className="inbox-date">
                  <time dateTime={at}>{date}</time>
                </div>
              )}
              {mail && (
                <details className="inbox-message" open={mail.id === latestId}>
                  <summary>
                    <InboxAvatar name={author || ''} />
                    <span className="inbox-sender">
                      <b title={mail.from}>{author}</b>
                      <small>发给 {mail.to}</small>
                    </span>
                    {mail.direction === 'inbound' && classLabels[mail.classification || ''] && (
                      <span className="inbox-mail-kind">
                        {classLabels[mail.classification || '']}
                      </span>
                    )}
                    <span className="inbox-snippet">{mail.subject || '（无主题）'}</span>
                    <time dateTime={at}>{timePart(at, clock)}</time>
                  </summary>
                  <MailMessageBody message={mail} collapseQuotes />
                  {operation?.provenance && <ReplySources sources={operation.provenance.sources} />}
                  {!!mail.attachments?.length && (
                    <p className="inbox-message-files">
                      <Paperclip size={13} />
                      {mail.attachments.map((a) => a.name || a.contentType).join('、')}
                      （请在原邮箱查看）
                    </p>
                  )}
                  <footer>
                    <details className="inbox-headers">
                      <summary>邮件详情</summary>
                      <dl>
                        <dt>发件人</dt>
                        <dd>{mail.from}</dd>
                        <dt>收件人</dt>
                        <dd>{mail.to}</dd>
                        <dt>主题</dt>
                        <dd>{mail.subject || '（无主题）'}</dd>
                        <dt>分类</dt>
                        <dd>
                          {mail.direction === 'inbound'
                            ? classLabels[mail.classification || ''] || '客户来信'
                            : operation?.origin === 'automatic' || mail.source === 'automatic'
                              ? '自动回复'
                              : '发出'}
                        </dd>
                        <dt>来源</dt>
                        <dd>
                          {mail.source === 'imap'
                            ? '来自邮箱同步'
                            : mail.source === 'manual'
                              ? '人工回复'
                              : '来自系统发送记录'}
                        </dd>
                        <dt>状态</dt>
                        <dd>
                          {deliveryLabels[mail.deliveryStatus]}
                          {mail.deliveryStatus === 'accepted' && ' · 提交结果不代表对方已收到'}
                        </dd>
                        {mail.messageId && (
                          <>
                            <dt>邮件编号</dt>
                            <dd>{mail.messageId}</dd>
                          </>
                        )}
                      </dl>
                    </details>
                    {mail.direction === 'inbound' && onReply && (
                      <button type="button" onClick={() => onReply(mail.id)}>
                        <Reply size={13} />
                        回复
                      </button>
                    )}
                  </footer>
                </details>
              )}
              {note && (
                <article className="inbox-team-note">
                  <header>
                    <LockKeyhole size={14} />
                    <strong>{note.author ? note.author + ' · ' : ''}内部备注</strong>
                    <time>{timePart(at, clock)}</time>
                  </header>
                  <p>{note.body}</p>
                </article>
              )}
            </Fragment>
          );
        })}
        {!events.length && <Empty title="会话暂无邮件" detail="同步邮箱后可在这里查看原文。" />}
      </div>
    </>
  );
}

interface ThreadProps {
  detail: MailConversationDetail;
  identity?: OutreachMailbox;
  onBack: () => void;
  marking: boolean;
  onRead: () => void;
  onCompleted: (result: MailConversationDetail) => void;
  onWorkflow: (id: string, workflow: InboxWorkflow, move: boolean) => void;
  onRefresh: () => void;
  editorVersion: number;
}
export function InboxThread({
  detail,
  identity,
  onBack,
  marking,
  onRead,
  onCompleted,
  onWorkflow,
  onRefresh,
  editorVersion,
}: ThreadProps) {
  const t = detail.conversation,
    wf = detail.workflow;
  const [contact, setContact] = useState<boolean | null>(null),
    [noteMode, setNoteMode] = useState(false);
  const [later, setLater] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [note, setNote] = useState(''),
    [replyTarget, setReplyTarget] = useState<{ id: string; request: number } | null>(null);
  const noteAttempt = useRef<{ body: string; id: string } | null>(null);
  const contactPanel = useRef<HTMLElement>(null);
  const owner = detail.reception?.owner || identity?.owner;
  const subject = t.subject || '（无主题）';
  async function move(state: InboxFolder, hours?: number) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const until = hours ? new Date(Date.now() + hours * 3600000).toISOString() : undefined;
      const updated = await mailConversationsApi.workflow(t.id, state, until);
      setLater(false);
      onWorkflow(t.id, updated, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '会话状态保存失败');
    } finally {
      setBusy(false);
    }
  }
  async function saveNote() {
    const body = note.trim();
    if (!body || busy) return;
    if (noteAttempt.current?.body !== body) noteAttempt.current = { body, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const updated = await mailConversationsApi.note(t.id, body, noteAttempt.current.id);
      onWorkflow(t.id, updated, false);
      setNote('');
      noteAttempt.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : '备注保存失败');
    } finally {
      setBusy(false);
    }
  }
  function toggleContact() {
    if (contactPanel.current) setContact(getComputedStyle(contactPanel.current).display === 'none');
  }
  const title =
    [...detail.messages]
      .reverse()
      .find(
        (mail) =>
          mail.direction === 'inbound' &&
          mail.from.toLowerCase() === t.participant.toLowerCase() &&
          mail.fromName,
      )?.fromName ||
    t.participantName ||
    t.companyName ||
    t.participant;
  const threadScroll = useRef<HTMLDivElement>(null);
  const latest = detail.messages.at(-1)?.id;
  useEffect(() => {
    const scroll = threadScroll.current;
    const message = scroll?.querySelector('.inbox-message[open]');
    if (!scroll || !message) return;
    const relativeTop = message.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    if (relativeTop > scroll.clientHeight * 0.4) scroll.scrollTop += relativeTop - 12;
  }, [t.id, latest]);
  return (
    <>
      <section
        className="mail-conversation-detail"
        aria-label="邮件会话详情"
        data-contact={contact === null ? 'auto' : contact ? 'show' : 'hide'}
      >
        <div className="inbox-thread-tools">
          <button
            className="inbox-icon mail-conversation-back"
            type="button"
            aria-label="返回会话列表"
            onClick={onBack}
          >
            <ArrowLeft size={17} />
          </button>
          <h2 className="inbox-thread-title" title={subject} tabIndex={0}>
            {subject}
          </h2>
          <div className="inbox-tool-end">
            {t.unread && (
              <button
                className="inbox-icon"
                type="button"
                disabled={marking}
                aria-label="标为已读"
                title="标为已读"
                onClick={onRead}
              >
                <MailCheck size={16} />
              </button>
            )}
            {wf && (
              <>
                <div className="inbox-later">
                  <button
                    className="inbox-icon"
                    type="button"
                    disabled={busy}
                    aria-expanded={later}
                    aria-label="稍后处理"
                    title="稍后处理"
                    onClick={() => setLater(!later)}
                  >
                    <Clock3 size={16} />
                  </button>
                  {later && (
                    <div className="inbox-popover">
                      <strong>稍后处理</strong>
                      {[
                        [1, '1 小时后'],
                        [24, '24 小时后'],
                        [168, '7 天后'],
                      ].map(([h, n]) => (
                        <button
                          type="button"
                          key={h}
                          disabled={busy}
                          onClick={() => void move('later', Number(h))}
                        >
                          {n}
                        </button>
                      ))}
                      {wf.state === 'later' && (
                        <button type="button" onClick={() => void move('open')}>
                          返回进行中
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <button
                  className="inbox-icon"
                  type="button"
                  disabled={busy}
                  title={wf.state === 'done' ? '重新打开' : '标为完成'}
                  aria-label={wf.state === 'done' ? '重新打开' : '标为完成'}
                  onClick={() => void move(wf.state === 'done' ? 'open' : 'done')}
                >
                  {wf.state === 'done' ? <RotateCcw size={16} /> : <CircleCheck size={16} />}
                </button>
              </>
            )}
            <button
              className="inbox-icon"
              aria-label="联系人资料"
              title="联系人资料"
              type="button"
              onClick={toggleContact}
            >
              <PanelRight size={16} />
            </button>
          </div>
        </div>
        <div className="inbox-thread-scroll" ref={threadScroll}>
          {error && (
            <p role="alert" className="mail-reply-error">
              {error}
            </p>
          )}
          {wf?.state === 'later' && wf.snoozeUntil && (
            <p className="inbox-snooze-time">
              <Clock3 size={13} /> 稍后处理 · {timePart(wf.snoozeUntil, day)}{' '}
              {timePart(wf.snoozeUntil, clock)}
            </p>
          )}
          <MailConversationTimeline
            {...detail}
            onReply={(id) => {
              setNoteMode(false);
              setReplyTarget((old) => ({ id, request: (old?.request || 0) + 1 }));
            }}
          />
        </div>
        <div className={'inbox-compose' + (noteMode ? ' note' : '')}>
          <div className="inbox-compose-tabs">
            <button type="button" aria-pressed={!noteMode} onClick={() => setNoteMode(false)}>
              <Reply size={14} />
              回复客户
            </button>
            {wf && (
              <button type="button" aria-pressed={noteMode} onClick={() => setNoteMode(true)}>
                <StickyNote size={14} />
                内部备注
              </button>
            )}
            {!noteMode && detail.replyContext?.signature && (
              <details className="inbox-signature">
                <summary>签名</summary>
                {detail.replyContext.signatureHtml && (
                  <div
                    className="inbox-signature-preview"
                    dangerouslySetInnerHTML={{
                      __html: sanitizeReplyHtml(detail.replyContext.signatureHtml),
                    }}
                  />
                )}
                {!detail.replyContext.signatureHtml && <p>{detail.replyContext.signature}</p>}
              </details>
            )}
          </div>
          <div hidden={noteMode}>
            <MailReplyComposer
              key={editorVersion}
              detail={detail}
              targetMessageId={replyTarget?.id}
              replyRequest={replyTarget?.request}
              onCompleted={onCompleted}
            />
          </div>
          {noteMode && (
            <div className="inbox-note-editor">
              <textarea
                aria-label="内部备注正文"
                placeholder="添加团队可见的备注…"
                value={note}
                maxLength={4000}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="btn primary"
                disabled={!note.trim() || busy}
                onClick={() => void saveNote()}
              >
                <Check size={13} />
                添加备注
              </button>
            </div>
          )}
        </div>
      </section>
      <aside
        ref={contactPanel}
        className="inbox-contact"
        aria-label="联系人及接待设置"
        data-contact={contact === null ? 'auto' : contact ? 'show' : 'hide'}
      >
        <header>
          <ContactRound size={16} />
          <b>联系人</b>
          <button
            className="inbox-icon"
            type="button"
            aria-label="关闭联系人资料"
            onClick={() => setContact(false)}
          >
            <X size={14} />
          </button>
        </header>
        <div className="inbox-contact-scroll">
          <InboxAvatar name={title} large />
          <h3>{title}</h3>
          <h4>
            <ContactRound size={14} />
            联系人资料
          </h4>
          <dl>
            {t.companyName && (
              <>
                <dt>公司</dt>
                <dd>{t.companyName}</dd>
              </>
            )}
            <dt>邮箱</dt>
            <dd>{t.participant}</dd>
          </dl>
          {t.customerId && (
            <Link to={'/leads?lead=' + encodeURIComponent(t.customerId)}>
              客户档案 <ArrowUpRight size={13} />
            </Link>
          )}
          <h4>
            <Mail size={14} />
            负责邮箱
          </h4>
          <strong>{identity?.brandName || t.account}</strong>
          <p>{t.account}</p>
          {owner && <p className="inbox-contact-owner">负责人 · {owner}</p>}
          {identity && (
            <Link to={'/inbox?tab=mailboxes&mailboxId=' + encodeURIComponent(identity.id)}>
              邮箱设置 <ArrowUpRight size={13} />
            </Link>
          )}
          <ReceptionControls detail={detail} onChange={onRefresh} />
        </div>
      </aside>
    </>
  );
}
