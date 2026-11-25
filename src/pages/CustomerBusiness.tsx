import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Star,
  ChevronDown,
  ClipboardList,
  ListChecks,
  Mail,
  UserRoundCheck,
  RefreshCw,
  ShieldQuestion,
} from 'lucide-react';
import { SectionWorkspace } from '../components/SectionWorkspace';
import { PageHeading } from '../components/PageHeading';
import { MailReplyHistory } from '../components/MailReplyHistory';
import { MailMessageBody } from '../components/MailMessageBody';
import { DeskList, PriorityAction } from '../components/FollowupDesk';
import {
  customerBusinessApi,
  followupDeskApi,
  type DeskPage,
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
    id: 'scheduled',
    label: '待执行',
    icon: ListChecks,
    description: '查看待执行或正在提交的追信。',
  },
  { id: 'completed', label: '已发出', icon: Mail, description: '查看已发出的首封开发信和追信。' },
  { id: 'bounced', label: '已拒收', icon: ShieldQuestion, description: '查看原邮箱已确认的退信。' },
  {
    id: 'skipped',
    label: '已跳过',
    icon: ListChecks,
    description: '核对跳过首封或追信的客户、所属计划及原始原因。',
  },
  {
    id: 'review',
    label: '待核实',
    icon: ShieldQuestion,
    description: '核对发送失败、被拒收或发送结果不确定的邮件。',
  },
  {
    id: 'approval',
    label: '待审核',
    icon: Mail,
    description: '核对 AI 回复草稿和需要人工处理的客户来信。',
  },
  { id: 'priority', label: '重点跟进', icon: Star, description: '查看业务员手动标记的客户。' },
  {
    id: 'assigned',
    label: '已接手',
    icon: UserRoundCheck,
    description: '查看人工接手的邮件会话、负责人和下一步。',
  },
] as const;
const statuses = {
  bounced: '已拒收',
  pending: '待执行',
  sending: '提交中',
  accepted: '已发出',
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
  task.status === 'bounced'
    ? '首封退信'
    : task.status === 'accepted' && task.step == null
      ? '首封开发信'
      : task.status === 'skipped' && task.step == null
        ? '首封已跳过'
        : `第 ${task.step} 次追信`;

function TaskDetail({
  task,
  revision,
  refresh,
}: {
  task: FollowupTaskSummary;
  revision: number;
  refresh: () => void;
}) {
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
        <PriorityAction id={task.customerId} refresh={refresh} />
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
          {!mail && task.status === 'skipped' && (
            <article>
              <h3>跳过原因</h3>
              <p>{task.reason || '记录未保存具体原因。'}</p>
            </article>
          )}
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
            <dt>
              {task.status === 'accepted' && task.step == null
                ? '首封发送时间（北京）'
                : '计划时间（北京）'}
            </dt>
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
    replies = view === 'replies';
  const state = params.get('state');
  const legacyQueue =
    state === 'candidate' ? 'completed' : state === 'attention' ? 'review' : state;
  const queue = queues.find((q) => q.id === (params.get('queue') || legacyQueue)) || queues[0];
  const [refresh, setRefresh] = useState(0),
    [opened, setOpened] = useState(params.get('task')?.replace(/^task_/, '') || '');
  const extra = ['approval', 'priority', 'assigned'].includes(queue.id);
  const key = params.toString();
  const [desk, setDesk] = useState<{ key: string; data?: DeskPage; error?: string }>();
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
    if (replies) return;
    const c = new AbortController();
    let busy = false;
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const filters = new URLSearchParams(key);
        if (!filters.has('queue') && legacyQueue === queue.id && queue.id !== 'all') {
          filters.set('queue', queue.id);
          filters.delete('state');
        }
        const [data, deskData] = await Promise.all([
          customerBusinessApi.followups(extra ? new URLSearchParams() : filters, c.signal),
          followupDeskApi.list(filters, c.signal),
        ]);
        if (!c.signal.aborted) setDesk({ key, data: deskData });
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
  }, [key, refresh, replies, extra, queue.id, legacyQueue]);
  const selectedTask = params.get('task');
  useEffect(() => setOpened(selectedTask?.replace(/^task_/, '') || ''), [selectedTask]);
  useEffect(() => setQuery(new URLSearchParams(key).get('q') || ''), [key]);
  const shown = result?.key === key ? result : undefined,
    data = shown?.data,
    counts: Record<string, number> = {
      ...data?.counts,
      ...(desk?.key === key ? desk.data?.counts : {}),
    };
  const deskData = desk?.key === key ? desk.data : undefined;
  const pagination = extra ? deskData : data;
  const scoped = params.has('customerId') || params.has('campaignId');
  const title = replies ? '邮箱来信跟进' : queue.label;
  return (
    <SectionWorkspace
      title="跟进任务"
      icon={ClipboardList}
      selected={replies ? 'replies' : queue.id}
      onSelect={(id) => {
        setOpened('');
        update({
          view: '',
          completed: '',
          customerId: '',
          campaignId: '',
          queue: queues.some((q) => q.id === id) && id !== 'all' ? id : '',
          page: '',
          task: '',
          state: '',
          bucket: '',
          asOf: '',
          q: '',
        });
      }}
      sections={[{ group: '任务队列', items: queues.map((q) => ({ ...q, count: counts[q.id] })) }]}
    >
      <div className="business-page section-page">
        <PageHeading
          eyebrow="AUTOMATIC FOLLOW-UP"
          title={title}
          description={replies ? '按原会话查看客户来信与回复。' : queue.description}
        >
          <button type="button" className="btn secondary" onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw size={15} />
            刷新
          </button>
        </PageHeading>
        {replies ? (
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
            {queue.id === 'assigned' && (
              <div className="business-filters">
                {[
                  ['', '进行中'],
                  ['1', '已完成'],
                ].map(([value, label]) => (
                  <button
                    key={label}
                    className="btn secondary"
                    aria-pressed={(params.get('completed') || '') === value}
                    onClick={() => update({ completed: value, page: '' })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {extra && !shown?.error && (
              <DeskList
                key={key}
                queue={queue.id}
                data={deskData}
                completed={params.get('completed') === '1'}
                refresh={() => setRefresh((n) => n + 1)}
              />
            )}
            {shown?.error && <p role="alert">{shown.error}</p>}
            {!extra && !shown && <p role="status">正在读取任务…</p>}
            {!extra && data && data.items.length === 0 && (
              <div className="followup-empty" role="status">
                <Mail size={24} />
                <strong>{scoped ? '该筛选范围暂无追信任务' : '暂无符合条件的追信任务'}</strong>
                <p>可以调整搜索词或切换任务队列。</p>
              </div>
            )}
            {!extra && !!data?.items.length && (
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
                        {task.status === 'skipped' && <small>{task.reason}</small>}
                        {task.day != null && <small>首封后第 {task.day} 天</small>}
                      </span>
                      <span>
                        <time dateTime={task.dueAt || task.firstSentAt || undefined}>
                          {when(task.dueAt || task.firstSentAt)}
                        </time>
                        <small>
                          {task.status === 'accepted' && task.step == null
                            ? '首封发送'
                            : task.status === 'skipped'
                              ? '跳过记录'
                              : '计划执行'}
                        </small>
                      </span>
                      <span className={'followup-status ' + task.status}>{statusLabel(task)}</span>
                      <ChevronDown size={15} />
                    </button>
                    {opened === task.id && (
                      <TaskDetail
                        task={task}
                        revision={refresh}
                        refresh={() => setRefresh((n) => n + 1)}
                      />
                    )}
                  </Fragment>
                ))}
              </div>
            )}
            {pagination?.total != null &&
              pagination.page != null &&
              pagination.pageSize != null &&
              pagination.total > pagination.pageSize && (
                <nav className="business-page-controls" aria-label="追信任务分页">
                  <button
                    className="btn secondary"
                    disabled={pagination.page === 1}
                    onClick={() => update({ page: String(pagination.page! - 1) })}
                  >
                    上一页
                  </button>
                  <span>
                    第 {pagination.page} / {Math.ceil(pagination.total / pagination.pageSize)} 页 ·
                    共 {pagination.total} 条
                  </span>
                  <button
                    className="btn secondary"
                    disabled={pagination.page * pagination.pageSize >= pagination.total}
                    onClick={() => update({ page: String(pagination.page! + 1) })}
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
