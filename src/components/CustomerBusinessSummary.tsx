import { useEffect, useState } from 'react';
import { mailConversationsApi } from '../services/mailConversations';
import { Link } from 'react-router-dom';
import { Mail, CalendarClock, UserRound } from 'lucide-react';
import {
  customerBusinessApi,
  type CustomerTimeline,
  type TimelineItem,
  type TimelineOriginal,
} from '../services/customerBusiness';
import { formatBeijingTime } from '../domain/date-time.mjs';
import { MailMessageBody } from './MailMessageBody';
import { Badge, Modal } from './ui';
import './CustomerBusinessSummary.css';

const types = {
  mail: '我方发信',
  received: '客户回信',
  first: '自动首发',
  auto: '自动追信',
  manual: '人工跟进',
  reply: '积极回复待办',
};
const states: Record<string, string> = {
  sent: '已发送',
  received: '已收到',
  accepted: '已完成',
  completed: '已完成',
  pending: '待执行',
  queued: '已排队',
  sending: '提交中',
  draft: '待确认草稿',
  generating: '正在生成',
  skipped: '已跳过',
  cancelled: '已终止',
  failed: '发送失败',
  unknown: '结果待核实',
  blocked: '已阻止',
  verifiedFailed: '已核实未发出',
  quote: '索价待处理',
  catalog: '索目录待处理',
  meeting: '约见待处理',
};

function Original({
  customerId,
  item,
  close,
}: {
  customerId: string;
  item: TimelineItem;
  close: () => void;
}) {
  const [mail, setMail] = useState<TimelineOriginal | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const read = item.thread
      ? mailConversationsApi.detail(item.thread, controller.signal).then((detail) => {
          const message = detail.messages.find((m) => m.id === item.id);
          if (!message) throw new Error('未找到这封回信，请刷新时间线');
          return {
            ...message,
            bodyHtml: message.bodyHtml || '',
            sentAt: item.stamp || message.occurredAt,
          };
        })
      : customerBusinessApi.original(customerId, item, controller.signal);
    read
      .then((m) => {
        if (!controller.signal.aborted) setMail(m);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [customerId, item]);
  return (
    <Modal title={item.kind === 'received' ? '客户回信原文' : '已发送邮件'} wide onClose={close}>
      <article className="modal-body timeline-original">
        {error ? (
          <p role="alert">{error}</p>
        ) : mail ? (
          <>
            <h3>{mail.subject || '（无主题）'}</h3>
            <p>
              {mail.from} → {mail.to}
            </p>
            <p>{formatBeijingTime(mail.sentAt)}</p>
            <MailMessageBody
              message={{ ...mail, source: item.kind === 'received' ? 'imap' : 'outreach' }}
            />
          </>
        ) : (
          <p role="status">正在读取邮件…</p>
        )}
      </article>
    </Modal>
  );
}

export function CustomerBusinessSummary({ customerId }: { customerId: string }) {
  const [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const [data, setData] = useState<CustomerTimeline | null>(null),
    [error, setError] = useState('');
  const [selected, setSelected] = useState<TimelineItem | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    customerBusinessApi
      .timeline(customerId, page, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        const last = Math.max(1, Math.ceil(result.total / result.pageSize));
        if (page > last) setPage(last);
        else setData(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [customerId, page, revision]);
  const inbox = '/inbox?' + new URLSearchParams({ tab: 'inbox', customerId });
  const days = new Map<string, TimelineItem[]>();
  for (const r of data?.items || []) {
    const day = r.stamp ? formatBeijingTime(r.stamp).split(' ')[0] : '尚未定时';
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(r);
  }
  function event(r: TimelineItem) {
    const Icon = ['mail', 'received'].includes(r.kind)
      ? Mail
      : ['manual', 'reply'].includes(r.kind)
        ? UserRound
        : CalendarClock;
    const title = r.title || '（无主题）';
    const to =
      r.kind === 'received'
        ? null
        : r.thread
          ? inbox + '&thread=' + encodeURIComponent(r.thread)
          : r.source === 'task' && r.kind === 'auto'
            ? '/business?' + new URLSearchParams({ customerId, task: r.id })
            : r.campaign && r.kind !== 'mail'
              ? '/inbox?' + new URLSearchParams({ tab: 'campaigns', campaignId: r.campaign })
              : null;
    const tone = ['sent', 'completed', 'accepted'].includes(r.state)
      ? 'green'
      : ['failed', 'unknown', 'verifiedFailed', 'blocked'].includes(r.state)
        ? 'red'
        : r.kind === 'reply'
          ? 'amber'
          : ['received', 'pending', 'queued', 'sending'].includes(r.state)
            ? 'blue'
            : 'neutral';
    const time = r.stamp ? formatBeijingTime(r.stamp).split(' ')[1]?.slice(0, 5) : '';
    return (
      <li key={r.kind + r.id}>
        <Icon size={16} aria-hidden="true" />
        <div>
          {to ? (
            <Link to={to}>{title}</Link>
          ) : ['received', 'mail'].includes(r.kind) ? (
            <button className="text-link" onClick={() => setSelected(r)}>
              {title}
            </button>
          ) : (
            <strong>{title}</strong>
          )}
          <small>
            {types[r.kind]} ·{' '}
            {time
              ? r.clock + ' ' + time
              : r.kind === 'first' && r.state === 'queued'
                ? '等待调度'
                : '暂无计划时间'}
            {r.kind === 'reply' && r.stamp
              ? ' · 已等待 ' +
                Math.max(0, Math.floor((Date.now() - Date.parse(r.stamp)) / 3600000)) +
                ' 小时'
              : ''}
          </small>
          {r.note && <small>{r.note}</small>}
        </div>
        <Badge tone={tone}>{states[r.state] || r.state}</Badge>
      </li>
    );
  }
  return (
    <div className="customer-business-summary">
      {data?.fixedEmail && <p>我方联系邮箱：{data.fixedEmail}</p>}
      {data?.doNotContact && <p role="alert">客户已明确拒绝联系。</p>}
      <h3>
        沟通与任务时间线 <small>北京时间</small>
      </h3>
      {error ? (
        <p role="alert">
          {error}{' '}
          <button className="text-link" onClick={() => setRevision(revision + 1)}>
            重新读取
          </button>
        </p>
      ) : !data ? (
        <p role="status">正在读取沟通与跟进记录…</p>
      ) : (
        <>
          {data.sentCount === 0 && (
            <p>
              {data.firstCount ? '暂无已发送邮件；首发进度及原因见时间线。' : '暂无已发送邮件记录'}
            </p>
          )}
          {!data.total && <p>暂无关联任务。</p>}
          {[...days].map(([day, items]) => (
            <section className="timeline-day" key={day}>
              <h4>{day}</h4>
              <ul>{items.map(event)}</ul>
            </section>
          ))}
          {data.total > data.pageSize && (
            <div className="business-summary-links">
              <button
                className="btn secondary"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </button>
              <span>
                {page} / {Math.ceil(data.total / data.pageSize)}
              </span>
              <button
                className="btn secondary"
                disabled={page * data.pageSize >= data.total}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
      {selected && (
        <Original item={selected} customerId={customerId} close={() => setSelected(null)} />
      )}
    </div>
  );
}
