import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CalendarDays,
  ChevronDown,
  ClipboardList,
  ListChecks,
  Mail,
  MessageSquare,
  RefreshCw,
  Settings2,
  ShieldQuestion,
} from 'lucide-react';
import { SectionWorkspace } from '../components/SectionWorkspace';
import { PageHeading } from '../components/PageHeading';
import { MailReplyHistory } from '../components/MailReplyHistory';
import { MailMessageBody } from '../components/MailMessageBody';
import { SequencePolicyPanel } from '../components/SequencePolicy';
import {
  customerBusinessApi,
  type FollowupTaskDetail,
  type FollowupTaskPage,
  type FollowupTaskSummary,
} from '../services/customerBusiness';
import { formatBeijingTime } from '../domain/date-time.mjs';
import './CustomerBusiness.css';

const queues = [
  {
    id: 'all',
    label: '全部追信',
    icon: ListChecks,
    description: '展开任务查看邮件、执行记录和原会话。暂停或关闭追信请进入所属发送计划。',
  },
  {
    id: 'upcoming',
    label: '近期安排',
    icon: CalendarDays,
    description: '按时间查看接下来 7 天待执行的追信。',
  },
  {
    id: 'review',
    label: '待核实',
    icon: ShieldQuestion,
    description: '查看已发首封、等待人工核对的客户，以及执行中需要核实的追信。',
  },
  {
    id: 'responded',
    label: '回信后停止',
    icon: MessageSquare,
    description: '查看系统因客户来信停止的追信。',
  },
] as const;
const statuses = {
  candidate: '待评估跟进',
  pending: '待执行',
  sending: '提交中',
  accepted: '服务商已接受',
  unknown: '待核实',
  failed: '发送失败',
  skipped: '已跳过',
  cancelled: '已停止',
};
const mailKinds = {
  first: '首封开发信',
  sent: '追信邮件',
  prepared: '本次准备的追信',
  reply: '相关客户来信',
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : '读取失败');
const statusLabel = (task: FollowupTaskSummary) =>
  task.replied ? '回信后停止' : statuses[task.status];
const when = (value?: string | null) => (value ? formatBeijingTime(value) : '—');
const stepLabel = (task: FollowupTaskSummary) =>
  task.status === 'candidate' ? '首封后跟进评估' : `第 ${task.step} 次追信`;

function TaskDetail({ task, revision }: { task: FollowupTaskSummary; revision: number }) {
  const [result, setResult] = useState<{ detail?: FollowupTaskDetail; error?: string }>({});
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    customerBusinessApi.followup(task.id, controller.signal).then(
      (detail) => {
        if (!controller.signal.aborted) setResult({ detail });
      },
      (error) => {
        if (!controller.signal.aborted) setResult({ error: errorText(error) });
      },
    );
    return () => controller.abort();
  }, [task.id, task.status, task.reason, revision]);
  if (result.error) return <p role="alert">{result.error}</p>;
  const detail = result.detail;
  if (!detail) return <p role="status">正在读取任务详情…</p>;
  const latest = detail.messages.at(-1);
  const mail = detail.messages.find((m) => m.id === selected) || latest;
  return (
    <section
      className="followup-detail"
      id={'detail-' + task.id}
      aria-label={task.customerName + ' 的追信详情'}
    >
      <header>
        <div>
          <h2>
            {task.customerName} · {stepLabel(task)}
          </h2>
          <Link
            to={'/inbox?' + new URLSearchParams({ tab: 'campaigns', campaignId: task.campaignId })}
          >
            {task.campaignName || '查看所属计划'}
          </Link>
        </div>
        {detail.thread && (
          <Link
            className="btn secondary"
            to={'/inbox?' + new URLSearchParams({ tab: 'inbox', thread: detail.thread })}
          >
            查看原会话
          </Link>
        )}
      </header>
      <div className="followup-detail-grid">
        <div className="followup-letter">
          <div className="followup-mail-tabs" aria-label="关联邮件">
            {detail.messages.map((m) => (
              <button
                className="btn secondary"
                key={m.id}
                aria-pressed={m.id === mail?.id}
                onClick={() => setSelected(m.id)}
              >
                {mailKinds[m.kind]}
              </button>
            ))}
          </div>
          {mail && (
            <article>
              <h3>{mail.subject || '（无主题）'}</h3>
              <div className="followup-mail-meta">
                发件人 {mail.from} · 收件人 {mail.to}
                <br />
                {when(mail.at)}
              </div>
              {mail.bodyText || mail.bodyHtml || mail.bodyUnavailable ? (
                <MailMessageBody key={mail.id} message={mail} collapseQuotes />
              ) : (
                <p>原始记录暂未保存邮件正文。</p>
              )}
            </article>
          )}
        </div>
        <aside className="followup-events">
          <h3>执行记录</h3>
          <dl>
            <dt>{task.status === 'candidate' ? '首封发送时间（北京）' : '计划时间（北京）'}</dt>
            <dd>{when(task.dueAt || task.firstSentAt)}</dd>
            {detail.attemptedAt && (
              <>
                <dt>提交时间</dt>
                <dd>{when(detail.attemptedAt)}</dd>
              </>
            )}
            {detail.sentAt && (
              <>
                <dt>服务商接受时间</dt>
                <dd>{when(detail.sentAt)}</dd>
              </>
            )}
            <dt>最新状态</dt>
            <dd>
              <strong>{statusLabel(task)}</strong>
              {detail.recordedAt && ' · ' + when(detail.recordedAt)}
            </dd>
          </dl>
          {task.reason && <p>{task.reason}</p>}
          {task.replied && !detail.messages.some((m) => m.kind === 'reply') && (
            <p>当前记录没有可核对的来信原文。</p>
          )}
          {!detail.thread && <p>当前记录尚未关联原会话。</p>}
          {(detail.day != null || detail.instruction) && (
            <details>
              <summary>
                本步规则{detail.policyRevision ? ' · V' + detail.policyRevision : ''}
              </summary>
              {detail.policyName && <p>{detail.policyName}</p>}
              {detail.day != null && <p>首封后第 {detail.day} 天</p>}
              {detail.instruction && <p>{detail.instruction}</p>}
            </details>
          )}
        </aside>
      </div>
    </section>
  );
}

export function CustomerBusiness() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view'),
    replies = view === 'replies',
    rules = view === 'rules';
  const queue = queues.find((q) => q.id === params.get('queue')) || queues[0];
  const [refresh, setRefresh] = useState(0),
    [opened, setOpened] = useState(params.get('task')?.replace(/^task_/, '') || '');
  const key = params.toString();
  const [query, setQuery] = useState(params.get('q') || '');
  const [result, setResult] = useState<{ key: string; data?: FollowupTaskPage; error?: string }>();
  function update(values: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(values)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next);
  }
  useEffect(() => {
    if (replies || rules) return;
    const c = new AbortController();
    let busy = false;
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const data = await customerBusinessApi.followups(new URLSearchParams(key), c.signal);
        if (!c.signal.aborted) setResult({ key, data });
      } catch (error) {
        if (!c.signal.aborted) setResult({ key, error: errorText(error) });
      } finally {
        busy = false;
      }
    }
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 30000);
    return () => {
      clearInterval(timer);
      c.abort();
    };
  }, [key, refresh, replies, rules]);
  const selectedTask = params.get('task');
  useEffect(() => setOpened(selectedTask?.replace(/^task_/, '') || ''), [selectedTask]);
  useEffect(() => setQuery(new URLSearchParams(key).get('q') || ''), [key]);
  const shown = result?.key === key ? result : undefined,
    data = shown?.data,
    counts = data?.counts;
  const scoped = params.has('customerId') || params.has('campaignId');
  const title = replies ? '邮箱来信跟进' : rules ? '跟进规则' : queue.label;
  return (
    <SectionWorkspace
      title="跟进任务"
      icon={ClipboardList}
      selected={replies ? 'replies' : rules ? 'rules' : queue.id}
      onSelect={(id) => {
        setOpened('');
        update({
          view: id === 'rules' || id === 'replies' ? id : '',
          queue: queues.some((q) => q.id === id) && id !== 'all' ? id : '',
          page: '',
          task: '',
          state: '',
          bucket: '',
          asOf: '',
          q: '',
        });
      }}
      sections={[
        { items: queues.map((q) => ({ ...q, count: counts?.[q.id] })) },
        { group: '设置', items: [{ id: 'rules', label: '跟进规则', icon: Settings2 }] },
        { group: '邮件', items: [{ id: 'replies', label: '邮箱来信跟进', icon: Mail }] },
      ]}
    >
      <div className="business-page section-page">
        <PageHeading
          eyebrow="AUTOMATIC FOLLOW-UP"
          title={title}
          description={
            replies
              ? '按原会话查看客户来信与回复。'
              : rules
                ? '编辑自动追信的时间和每一步的写作要求。'
                : queue.description
          }
        >
          <button type="button" className="btn secondary" onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw size={15} />
            刷新
          </button>
        </PageHeading>
        {rules ? (
          <SequencePolicyPanel refreshToken={refresh} />
        ) : replies ? (
          <MailReplyHistory
            key={params.get('businessKind') || 'all'}
            revision={refresh}
            initialBusinessKind={params.get('businessKind') || 'all'}
          />
        ) : (
          <>
            <form
              className="business-filters"
              onSubmit={(e) => {
                e.preventDefault();
                setOpened('');
                update({ q: query.trim(), page: '', task: '' });
              }}
            >
              <label>
                搜索客户、邮箱或计划{' '}
                <input
                  type="search"
                  maxLength={160}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              {queue.id === 'all' && (
                <label>
                  状态{' '}
                  <select
                    value={params.get('state') || 'all'}
                    onChange={(e) => {
                      setOpened('');
                      update({
                        state: e.target.value === 'all' ? '' : e.target.value,
                        bucket: '',
                        asOf: '',
                        task: '',
                        page: '',
                      });
                    }}
                  >
                    <option value="all">全部</option>
                    <option value="pending">待执行与待核实</option>
                    <option value="completed">服务商已接受</option>
                    <option value="skipped">跳过</option>
                    <option value="cancelled">已停止</option>
                  </select>
                </label>
              )}
              <button className="btn secondary">搜索</button>
              {(scoped ||
                params.has('task') ||
                params.has('bucket') ||
                params.has('state') ||
                params.has('q')) && (
                <Link to={queue.id === 'all' ? '/business' : '/business?queue=' + queue.id}>
                  清除筛选
                </Link>
              )}
            </form>
            {shown?.error && <p role="alert">{shown.error}</p>}
            {!shown && <p role="status">正在读取任务…</p>}
            {data && data.items.length === 0 && (
              <div className="followup-empty" role="status">
                <Mail size={24} />
                <strong>{scoped ? '该筛选范围暂无追信任务' : '暂无符合条件的追信任务'}</strong>
                <p>
                  {queue.id === 'upcoming'
                    ? '此处只显示未来 7 天已排期的追信。'
                    : '已发首封的客户可在「待核实」查看符合条件的跟进评估。'}
                </p>
              </div>
            )}
            {!!data?.items.length && (
              <div className="followup-list">
                <div className="followup-columns followup-list-head" aria-hidden="true">
                  <span>客户 / 收件邮箱</span>
                  <span>跟进步骤</span>
                  <span>时间（北京）</span>
                  <span>执行状态</span>
                  <span />
                </div>
                {data.items.map((task) => (
                  <Fragment key={task.id}>
                    <button
                      type="button"
                      className="followup-columns followup-row"
                      aria-expanded={opened === task.id}
                      aria-controls={opened === task.id ? 'detail-' + task.id : undefined}
                      onClick={() => setOpened(opened === task.id ? '' : task.id)}
                    >
                      <span className="followup-name">
                        <strong>{task.customerName || task.customerId}</strong>
                        <small>{task.recipient}</small>
                      </span>
                      <span>
                        {stepLabel(task)}
                        {task.day != null && <small>首封后第 {task.day} 天</small>}
                      </span>
                      <span>
                        <time dateTime={task.dueAt || task.firstSentAt || undefined}>
                          {when(task.dueAt || task.firstSentAt)}
                        </time>
                        <small>{task.status === 'candidate' ? '首封发送' : '计划执行'}</small>
                      </span>
                      <span className={'followup-status ' + task.status}>{statusLabel(task)}</span>
                      <ChevronDown size={15} />
                    </button>
                    {opened === task.id && <TaskDetail task={task} revision={refresh} />}
                  </Fragment>
                ))}
              </div>
            )}
            {data && data.total > data.pageSize && (
              <nav className="business-page-controls" aria-label="追信任务分页">
                <button
                  className="btn secondary"
                  disabled={data.page === 1}
                  onClick={() => update({ page: String(data.page - 1) })}
                >
                  上一页
                </button>
                <span>
                  第 {data.page} / {Math.ceil(data.total / data.pageSize)} 页 · 共 {data.total} 条
                </span>
                <button
                  className="btn secondary"
                  disabled={data.page * data.pageSize >= data.total}
                  onClick={() => update({ page: String(data.page + 1) })}
                >
                  下一页
                </button>
              </nav>
            )}
          </>
        )}
      </div>
    </SectionWorkspace>
  );
}
