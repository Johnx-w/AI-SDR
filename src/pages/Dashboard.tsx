import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Building2,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileCheck2,
  ListTodo,
  PauseCircle,
  RefreshCw,
  Target,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { Badge } from '../components/ui';
import type { OverviewPeriod } from '../domain/overview-rules.mjs';
import { overviewApi } from '../services/overview';
import type { OverviewData, OverviewSource } from '../services/overview';
import './Dashboard.css';

const countText = (value: number | null) => (value === null ? '—' : value.toLocaleString('zh-CN'));
const isVisible = () => document.visibilityState !== 'hidden';
const dateText = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '暂无记录';
const jobStates: Record<string, string> = {
  running: '运行中',
  stopping: '正在停止',
  paused: '待核对',
  completed: '已完成',
  partial: '部分完成',
};
const planStates: Record<string, string> = {
  enabled: '已启用',
  paused: '已暂停',
  closed: '已关闭',
  completed: '已结束',
};
const jobReasons: Record<string, string> = {
  target_reached: '已达到新增目标',
  research_limit: '已达到研究次数上限',
  search_limit: '已达到搜索次数上限',
  time_limit: '已达到运行时间上限',
  exhausted: '当前条件下的候选已处理完',
  customs_budget: '已达到本轮海关读取预算',
  stopped: '本轮已停止，已入库客户保留',
  interrupted: '服务曾中断，继续前需核对',
  uncertain: '执行结果待确认，已暂停',
};

function SourceNotice({ source }: { source: OverviewSource }) {
  if (source.state === 'ready') return null;
  return (
    <p className="ov-source-notice" role="status">
      <CircleAlert size={14} aria-hidden="true" />
      <span>
        {source.state === 'stale'
          ? `保留最近数据 · 更新于 ${dateText(source.updatedAt)}`
          : '暂时无法读取此项数据'}
        {source.error && <small>{source.error}</small>}
      </span>
    </p>
  );
}

function PanelHeading({
  title,
  detail,
  to,
  link = '查看全部',
}: {
  title: string;
  detail?: string;
  to?: string;
  link?: string;
}) {
  return (
    <div className="ov-panel-heading">
      <div>
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {to && (
        <Link className="ov-text-link" to={to}>
          {link} <ChevronRight size={14} aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="ov-empty">
      <span className="ov-empty-mark" aria-hidden="true">
        ○
      </span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function Metric({
  title,
  value,
  unit,
  detail,
  icon: Icon,
  to,
  source,
}: {
  title: string;
  value: number | null;
  unit: string;
  detail: string;
  icon: LucideIcon;
  to: string;
  source: OverviewSource;
}) {
  const content = (
    <>
      <div className="ov-metric-top">
        <span>{title}</span>
        <Icon size={19} aria-hidden="true" />
      </div>
      <div className="ov-metric-value">
        <strong>{countText(value)}</strong>
        <span>{unit}</span>
      </div>
      <div className="ov-metric-caption">
        <span>{value === null ? '未能读取' : detail}</span>
        {value !== null && <ArrowUpRight size={15} aria-hidden="true" />}
      </div>
      <SourceNotice source={source} />
    </>
  );
  return value === null ? (
    <div className="panel ov-metric">{content}</div>
  ) : (
    <Link
      className="panel ov-metric ov-clickable"
      to={to}
      aria-label={`${title} ${value} ${unit}，查看明细`}
    >
      {content}
    </Link>
  );
}

function CaptureTrend({ data }: { data: OverviewData }) {
  const known = data.trend.filter((item) => item.count !== null);
  if (!known.length)
    return (
      <EmptyState title="新增趋势暂不可用" detail="恢复读取后，将按已保存的实际收录记录显示。" />
    );
  const max = Math.max(1, ...known.map((item) => item.count || 0));
  const ceiling = Math.max(1, Math.ceil(max / 4) * 4);
  const left = 38,
    right = 620,
    bottom = 179,
    top = 30;
  const points = data.trend.map((item, i) => ({
    ...item,
    x:
      data.trend.length === 1
        ? (left + right) / 2
        : left + (i * (right - left)) / (data.trend.length - 1),
    y: item.count === null ? null : bottom - (item.count / ceiling) * (bottom - top),
  }));
  const path = points
    .map((item, i) =>
      item.y === null ? '' : `${i && points[i - 1].y !== null ? 'L' : 'M'}${item.x},${item.y}`,
    )
    .join(' ');
  const total = known.reduce((sum, item) => sum + (item.count || 0), 0);
  const every = Math.max(1, Math.ceil(data.trend.length / 7));
  return (
    <Link
      className="ov-chart-link"
      to={data.links.newCompanies}
      aria-label={`${data.range.label}已记录新增 ${total} 家，查看收录明细`}
    >
      <svg
        className="ov-chart"
        viewBox="0 0 640 218"
        role="img"
        aria-label={`${data.range.label}已记录新增企业趋势，共 ${total} 家`}
      >
        <title>{data.coverage.note}</title>
        {[0, 1, 2, 3, 4].map((tick) => {
          const value = (ceiling * tick) / 4;
          const y = bottom - ((bottom - top) * tick) / 4;
          return (
            <g key={tick}>
              <line x1={left} x2={right} y1={y} y2={y} className="ov-chart-grid" />
              <text x={left - 12} y={y + 4} textAnchor="end">
                {value % 1 === 0 ? value : ''}
              </text>
            </g>
          );
        })}
        {known.length === points.length && (
          <path
            d={`${path} L${points.at(-1)?.x},${bottom} L${points[0].x},${bottom} Z`}
            fill="var(--color-primary-soft)"
          />
        )}
        <path
          d={path}
          fill="none"
          stroke="var(--chart-1)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        {points.map((item, i) => (
          <g key={item.date}>
            {item.y !== null && (
              <circle
                cx={item.x}
                cy={item.y}
                r={data.trend.length > 10 ? 2.7 : 4}
                fill="var(--chart-1)"
              >
                <title>{`${item.date}：已记录新增 ${item.count} 家`}</title>
              </circle>
            )}
            {(i % every === 0 || i === points.length - 1) && (
              <text x={item.x} y="205" textAnchor="middle">
                {item.date.slice(5).replace('-', '/')}
              </text>
            )}
            {points.length <= 7 && item.y !== null && (
              <text x={item.x} y={item.y - 11} textAnchor="middle" className="ov-chart-value">
                {item.count}
              </text>
            )}
          </g>
        ))}
      </svg>
    </Link>
  );
}

export function Dashboard() {
  const [period, setPeriod] = useState<OverviewPeriod>('7d');
  const [dataByPeriod, setDataByPeriod] = useState<Partial<Record<OverviewPeriod, OverviewData>>>(
    {},
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const cache = useRef<Partial<Record<OverviewPeriod, OverviewData>>>({});
  const data = dataByPeriod[period];
  useEffect(() => {
    let alive = true,
      pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    setError('');
    const load = async () => {
      if (!alive || pending || !isVisible()) return;
      if (timer) clearTimeout(timer);
      pending = true;
      controller = new AbortController();
      setRefreshing(true);
      try {
        const result = await overviewApi.get(
          period,
          AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        );
        if (!alive || controller.signal.aborted) return;
        if (result.range.period !== period) throw new Error('返回的统计期间不一致，请重新读取');
        cache.current[period] = result;
        setDataByPeriod((current) => ({ ...current, [period]: result }));
        setError('');
      } catch (cause) {
        if (alive && !controller.signal.aborted)
          setError(
            cause instanceof DOMException && cause.name === 'TimeoutError'
              ? '读取超时，请稍后重试'
              : cause instanceof TypeError
                ? '无法连接业务服务，请检查服务是否运行'
                : cause instanceof Error
                  ? cause.message
                  : '运营总览读取失败，请稍后重试',
          );
      } finally {
        pending = false;
        if (alive) {
          setRefreshing(false);
          if (isVisible()) {
            const running = cache.current[period]?.jobs.some((job) =>
              ['running', 'stopping'].includes(job.status),
            );
            timer = setTimeout(() => void load(), running ? 5000 : 30000);
          }
        }
      }
    };
    const visible = () => {
      if (timer) clearTimeout(timer);
      if (isVisible()) void load();
    };
    void load();
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive = false;
      controller?.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [period, revision]);

  const header = (
    <PageHeading
      eyebrow="OVERVIEW"
      title="今天的获客与跟进"
      description="先处理到期行动，再推进客户明确表达的需求"
    >
      <label className="ov-period-picker">
        <CalendarDays size={16} aria-hidden="true" />
        <span className="ov-sr-only">成果统计期间</span>
        <select
          aria-label="成果统计期间"
          value={period}
          onChange={(event) => setPeriod(event.target.value as OverviewPeriod)}
        >
          <option value="today">今日</option>
          <option value="7d">近 7 天</option>
          <option value="30d">近 30 天</option>
        </select>
      </label>
      <button
        className="btn secondary"
        disabled={refreshing}
        onClick={() => setRevision((value) => value + 1)}
      >
        <RefreshCw size={15} className={refreshing ? 'ov-spin' : ''} aria-hidden="true" />
        {refreshing ? '读取中' : '刷新总览'}
      </button>
    </PageHeading>
  );
  if (!data)
    return (
      <div className="ov-page">
        {header}
        {error ? (
          <div className="ov-error" role="alert">
            <CircleAlert size={19} aria-hidden="true" />
            <span>{error}。可点击“刷新总览”重试。</span>
          </div>
        ) : (
          <p className="ov-loading" role="status">
            正在汇总真实获客与客户业务数据…
          </p>
        )}
        <div className="ov-metrics ov-skeleton" aria-hidden="true">
          {[0, 1, 2, 3].map((key) => (
            <div className="panel" key={key}>
              <i />
              <b />
              <i />
            </div>
          ))}
        </div>
      </div>
    );

  const work = [
    {
      key: 'overdue' as const,
      title: '逾期待跟进',
      detail: '已超过计划时间，先核对下一步',
      icon: Clock3,
      className: 'overdue',
    },
    {
      key: 'today' as const,
      title: '今日待跟进',
      detail: '今天尚未到时的待执行行动',
      icon: CalendarDays,
      className: 'today',
    },
    {
      key: 'paused' as const,
      title: '暂停待核对',
      detail: '查看暂停原因，核对后再安排',
      icon: PauseCircle,
      className: 'paused',
    },
  ];
  const anySourceFailure = Object.values(data.sources).some((source) => source.state !== 'ready');
  const stageTotal = data.stages.reduce((sum, stage) => sum + stage.count, 0);
  return (
    <div className="ov-page">
      {header}
      <div className="ov-meta">
        <span>
          <span className={`ov-dot ${anySourceFailure || error ? 'warning' : ''}`} />
          {error
            ? '更新失败，保留上次读取结果'
            : anySourceFailure
              ? '部分数据需要核对'
              : '真实业务数据'}
        </span>
        <span>截至 {dateText(data.asOf)} · 北京时间</span>
      </div>
      {error && (
        <div className="ov-error" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <span>
            {error}。以下保留 {dateText(data.asOf)} 的结果。
          </span>
        </div>
      )}
      <section className="panel ov-todo-panel">
        <PanelHeading
          title="待你处理"
          detail="始终展示当前逾期和今日事项，不受成果日期筛选影响"
          to="/business?tab=tasks"
          link="全部跟进"
        />
        <SourceNotice source={data.sources.business} />
        <div className="ov-todo-grid">
          {work.map((item) => {
            const value = data.work[item.key];
            const content = (
              <>
                <span className={`ov-todo-icon ${item.className}`}>
                  <item.icon size={21} aria-hidden="true" />
                </span>
                <div className="ov-todo-copy">
                  <strong>{item.title}</strong>
                  <small>{value === null ? '未能读取，稍后重试' : item.detail}</small>
                </div>
                <b>{countText(value)}</b>
                {value !== null && <ChevronRight size={16} aria-hidden="true" />}
              </>
            );
            return value === null ? (
              <div className={`ov-todo ${item.className}`} key={item.key}>
                {content}
              </div>
            ) : (
              <Link
                className={`ov-todo ov-clickable ${item.className}`}
                key={item.key}
                to={data.links[item.key]}
                aria-label={`${item.title} ${value} 项，查看明细`}
              >
                {content}
              </Link>
            );
          })}
        </div>
      </section>
      <div className="ov-metrics">
        <Metric
          title="当前企业总量"
          value={data.metrics.companies}
          unit="家"
          detail="当前客户库中的企业档案"
          icon={Building2}
          to={data.links.companies}
          source={data.sources.customers}
        />
        <Metric
          title={`${data.range.label}确认新增`}
          value={data.metrics.newCompanies}
          unit="家"
          detail="按已记录新增统计"
          icon={ArrowDownToLine}
          to={data.links.newCompanies}
          source={data.sources.acquisition}
        />
        <Metric
          title="当前进行中需求"
          value={data.metrics.activeDemands}
          unit="条"
          detail="客户明确表达且尚未结束"
          icon={FileCheck2}
          to={data.links.activeDemands}
          source={data.sources.business}
        />
        <Metric
          title="当前到期跟进"
          value={data.metrics.dueTasks}
          unit="项"
          detail="逾期与今日待执行，不含暂停"
          icon={ListTodo}
          to={data.links.dueTasks}
          source={data.sources.business}
        />
      </div>
      <div className="ov-main-grid">
        <section className="panel ov-priority-panel">
          <PanelHeading
            title="优先处理客户"
            detail="到期行动 → 进行中需求 → 高评级待开发，每家企业展示一次"
            to="/leads"
            link="客户库"
          />
          <SourceNotice source={data.sources.customers} />
          <SourceNotice source={data.sources.business} />
          {data.priority.length ? (
            <div className="ov-priority-list">
              {data.priority.map((customer, index) => (
                <Link
                  className="ov-priority-row ov-clickable"
                  to={customer.to}
                  key={customer.customerId}
                >
                  <span className="ov-rank">{String(index + 1).padStart(2, '0')}</span>
                  <div className="ov-priority-content">
                    <div className="ov-company-title">
                      <strong>{customer.name}</strong>
                      {customer.grade && <Badge>{customer.grade} 级</Badge>}
                    </div>
                    <p className="ov-priority-reason">{customer.reason}</p>
                    <span className="ov-customer-meta">
                      {[
                        customer.market,
                        customer.owner && `负责人 ${customer.owner}`,
                        customer.dueAt && `计划 ${dateText(customer.dueAt)}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  <span className="ov-next-action">
                    {customer.action || '查看客户'}
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              title={
                data.sources.business.state === 'unavailable' ||
                data.sources.customers.state === 'unavailable'
                  ? '优先客户暂未完整读取'
                  : '暂无需要优先处理的客户'
              }
              detail="有到期任务、待安排的明确需求或高评级待开发客户时，将在这里列出。"
            />
          )}
        </section>
        <div className="ov-side-stack">
          <section className="panel ov-jobs-panel">
            <PanelHeading
              title="获客执行"
              detail="实际新增收录与本轮目标"
              to="/automation?tab=runs"
            />
            <SourceNotice source={data.sources.acquisition} />
            {data.jobs.length ? (
              <div className="ov-job-list">
                {data.jobs.map((job) => (
                  <Link className="ov-job ov-clickable" to={job.to} key={job.id}>
                    <div className="ov-job-heading">
                      <span className="ov-job-symbol">
                        <Target size={18} aria-hidden="true" />
                      </span>
                      <strong>{job.title}</strong>
                      <Badge
                        tone={
                          job.status === 'completed'
                            ? 'green'
                            : job.status === 'paused' || job.status === 'partial'
                              ? 'amber'
                              : 'neutral'
                        }
                      >
                        {jobStates[job.status] || '查看状态'}
                      </Badge>
                    </div>
                    <div className="ov-job-count">
                      <span>
                        新增收录 <b>{job.inserted}</b> / {job.target} 家
                      </span>
                      <small>
                        更新 {job.updated} · 待核对 {job.pending}
                      </small>
                    </div>
                    <progress
                      aria-label={`${job.title}新增收录进度`}
                      max={Math.max(1, job.target)}
                      value={Math.max(0, Math.min(job.inserted, job.target))}
                    />
                    <p className="ov-job-reason">
                      {jobReasons[job.reason] ||
                        (job.reason && !/^[a-z_]+$/.test(job.reason)
                          ? job.reason
                          : job.status === 'running'
                            ? '正在执行，点击查看当前步骤'
                            : '查看本轮执行明细')}
                      <ChevronRight size={13} aria-hidden="true" />
                    </p>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                title={
                  data.sources.acquisition.state === 'unavailable'
                    ? '获客执行暂不可用'
                    : '暂无获客执行'
                }
                detail="新建获客任务后，可在这里查看实际进度。"
              />
            )}
          </section>
          <section className="panel ov-plans-panel">
            <PanelHeading title="定时获客计划" to="/automation?tab=schedules" link="管理计划" />
            {data.schedules.length ? (
              <div className="ov-plan-list">
                {data.schedules.map((plan) => (
                  <Link className="ov-plan ov-clickable" to={plan.to} key={plan.id}>
                    <CalendarDays size={17} aria-hidden="true" />
                    <div>
                      <strong>{plan.name}</strong>
                      <small>
                        {plan.nextRunAt ? `下次 ${dateText(plan.nextRunAt)}` : '暂无下一次执行时间'}
                      </small>
                    </div>
                    <Badge>{planStates[plan.status] || '查看状态'}</Badge>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="ov-quiet-empty">
                {data.sources.acquisition.state === 'unavailable'
                  ? '计划暂时无法读取'
                  : '暂无定时计划，可在获客任务中配置。'}
              </p>
            )}
          </section>
        </div>
      </div>
      <div className="ov-bottom-grid">
        <section className="panel ov-trend-panel">
          <PanelHeading
            title="已记录新增趋势"
            detail={`${data.range.label} · 按实际收录时间统计`}
            to={data.links.newCompanies}
            link="收录明细"
          />
          <SourceNotice source={data.sources.acquisition} />
          <CaptureTrend data={data} />
          <p className="ov-coverage">
            <CircleAlert size={13} aria-hidden="true" />
            {data.coverage.note}
          </p>
        </section>
        <section className="panel ov-stages-panel">
          <PanelHeading
            title="当前需求阶段"
            detail="按需求条数统计，包含已结束的需求"
            to="/business?tab=demands"
            link="需求明细"
          />
          <SourceNotice source={data.sources.business} />
          {stageTotal ? (
            <div className="ov-stage-list">
              {data.stages.map((stage) => (
                <Link to={stage.to} className="ov-stage ov-clickable" key={stage.stage}>
                  <span>{stage.label}</span>
                  <div aria-hidden="true">
                    <i style={{ width: `${(stage.count / stageTotal) * 100}%` }} />
                  </div>
                  <b>{stage.count}</b>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              title={
                data.sources.business.state === 'unavailable'
                  ? '需求阶段暂不可用'
                  : '暂无已登记采购需求'
              }
              detail="从实际沟通登记需求后，将显示各阶段的当前分布。"
            />
          )}
        </section>
      </div>
      <section className="panel ov-health-panel">
        <PanelHeading title="资料与数据状态" detail="查看资料审核及各数据来源的最近读取状态" />
        <div className="ov-support-grid">
          <Link to={data.products.to} className="ov-product-reminder ov-clickable">
            <FileCheck2 size={21} aria-hidden="true" />
            <div>
              <strong>
                待审核产品资料 <b>{countText(data.products.draft)}</b>
              </strong>
              <small>未审核草稿及修改后需重新审核的资料</small>
              {data.products.syncIssues !== null && data.products.syncIssues > 0 && (
                <small>另有 {data.products.syncIssues} 份资料同步待核对</small>
              )}
            </div>
            <ChevronRight size={17} aria-hidden="true" />
          </Link>
          <div className="ov-source-list">
            {(
              Object.entries(data.sources) as [keyof OverviewData['sources'], OverviewSource][]
            ).map(([key, source]) => (
              <div key={key}>
                <span className={`ov-dot ${source.state !== 'ready' ? 'warning' : ''}`} />
                <strong>
                  {
                    {
                      customers: '企业档案',
                      business: '需求与跟进',
                      acquisition: '获客执行',
                      products: '产品资料',
                    }[key]
                  }
                </strong>
                <span>
                  {source.state === 'ready'
                    ? '已读取'
                    : source.state === 'stale'
                      ? '数据待更新'
                      : '读取失败'}
                </span>
                <small>{dateText(source.updatedAt)}</small>
              </div>
            ))}
          </div>
        </div>
        <SourceNotice source={data.sources.products} />
      </section>
      <p className="ov-footnote">
        日期筛选仅影响期间新增和趋势；当前客户、需求与待办按当前记录展示。页面可见时自动更新。
      </p>
    </div>
  );
}
