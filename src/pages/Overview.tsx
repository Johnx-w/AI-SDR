import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Globe2,
  Mail,
  MoreHorizontal,
  Sparkles,
  Target,
  UsersRound,
  Workflow,
} from 'lucide-react';
import { PageHeading, NewTaskButton } from '../components/PageHeading';
import { useWorkspace } from '../app/WorkspaceProvider';
import { Avatar, Badge, SectionTitle, Sparkline } from '../components/ui';
import { exportCsv } from '../services/workspace';

export function TrendChart({ period = '14' }: { period?: string }) {
  const base =
    period === '7'
      ? [42, 61, 49, 85, 73, 110, 96]
      : period === '30'
        ? [28, 43, 39, 64, 45, 72, 62, 90, 74, 101, 86, 114, 98, 128]
        : [32, 48, 39, 68, 57, 81, 67, 94, 79, 107, 87, 118, 104, 132];
  const points = base.map((value, index) => [48 + index * (644 / (base.length - 1)), 190 - value]);
  const curve = points
    .map((point, index) => `${index ? 'L' : 'M'}${point[0]},${point[1]}`)
    .join(' ');
  const second = points
    .map(([x, y], index) => `${index ? 'L' : 'M'}${x},${y + 38 + (index % 3) * 5}`)
    .join(' ');
  return (
    <svg
      className="trend-chart"
      viewBox="0 0 720 235"
      role="img"
      aria-label={`最近${period}天的演示获客趋势，不代表真实 n8n 执行数据`}
    >
      <defs>
        <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4b8d6c" stopOpacity=".2" />
          <stop offset="100%" stopColor="#4b8d6c" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[40, 80, 120, 160, 200].map((y, index) => (
        <g key={y}>
          <line x1="48" x2="695" y1={y} y2={y} stroke="#edf0ed" strokeDasharray="3 5" />
          <text x="29" y={y + 4} textAnchor="end" fill="#9a9e97" fontSize="10">
            {160 - index * 40}
          </text>
        </g>
      ))}
      <path d={`${curve} L692,200 L48,200Z`} fill="url(#trend-fill)" />
      <path
        d={second}
        fill="none"
        stroke="#b6c89b"
        strokeWidth="2"
        strokeDasharray="5 5"
        strokeLinejoin="round"
      />
      <path
        d={curve}
        fill="none"
        stroke="#36775a"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx="692"
        cy={190 - base.at(-1)!}
        r="4"
        fill="#36775a"
        stroke="white"
        strokeWidth="2"
      />
      {['起始日', '第 3 天', '第 5 天', '第 7 天', '第 10 天', '最近'].map((text, index) => (
        <text key={text} x={48 + index * 128} y="226" fill="#9a9e97" fontSize="10">
          {text}
        </text>
      ))}
    </svg>
  );
}
export function Overview() {
  const { data, update } = useWorkspace();
  const [period, setPeriod] = useState('14');
  if (!data) return null;
  const aLeads = data.leads.filter((lead) => lead.grade === 'A');
  const openTasks = data.tasks.filter((task) => !task.done);
  const metrics = [
    {
      label: '客户线索',
      value: data.leads.length,
      caption: '覆盖美国、澳大利亚',
      icon: UsersRound,
      tone: 'sage',
    },
    {
      label: '高适配客户',
      value: aLeads.length,
      caption: `占全部线索 ${Math.round((aLeads.length / data.leads.length) * 100)}%`,
      icon: Target,
      tone: 'sand',
    },
    {
      label: '客户回复',
      value: data.leads.filter((lead) => lead.status === '已回复').length,
      caption: '演示回复 · 待人工跟进',
      icon: Mail,
      tone: 'blue',
    },
    {
      label: '今日待办',
      value: openTasks.length,
      caption: '跟进、研究与草稿审核',
      icon: Clock3,
      tone: 'lavender',
    },
  ];
  return (
    <>
      <PageHeading
        eyebrow="YOUR GROWTH, IN FOCUS"
        title="早上好，Johnson ☀"
        description="新的一天，从发现下一个好客户开始。"
      >
        <button
          className="btn secondary"
          onClick={() =>
            exportCsv(
              data.leads.map((lead) => ({
                公司: lead.name,
                市场: lead.market,
                等级: lead.grade,
                评分: lead.score,
                状态: lead.status,
              })),
              'ShadeFlow-业务概览.csv',
            )
          }
        >
          <ArrowDownToLine size={15} />
          导出报告
        </button>
        <NewTaskButton />
      </PageHeading>
      <div className="overview-strip">
        <div>
          <span className="status-dot" />
          <strong>工作台已就绪</strong>
          <span className="strip-divider" />
          美国 & 澳大利亚市场
          <span className="strip-divider" />
          业务数据为演示样本
        </div>
        <Link to="/automation">
          查看自动化中心
          <ArrowRight size={14} />
        </Link>
      </div>
      <div className="metric-grid">
        {metrics.map((metric, index) => (
          <section className="metric-card" key={metric.label}>
            <div className="metric-label">
              <span>{metric.label}</span>
              <span className={`metric-icon ${metric.tone}`}>
                <metric.icon size={17} />
              </span>
            </div>
            <div className="metric-main">
              <strong>{metric.value.toString().padStart(2, '0')}</strong>
              <Sparkline variant={index} />
            </div>
            <div className="metric-caption">
              <span className="tiny-status-dot" />
              {metric.caption}
            </div>
          </section>
        ))}
      </div>
      <div className="dashboard-middle">
        <section className="panel trend-panel">
          <SectionTitle
            title="获客趋势"
            subtitle="从客户发现，到有价值的回应"
            action={
              <div className="segmented" aria-label="趋势时间范围">
                {['7', '14', '30'].map((value) => (
                  <button
                    key={value}
                    className={period === value ? 'selected' : ''}
                    onClick={() => setPeriod(value)}
                  >
                    {value} 天
                  </button>
                ))}
              </div>
            }
          />
          <div className="chart-legend">
            <span>
              <i />
              发现线索
            </span>
            <span>
              <i className="light" />
              高适配客户
            </span>
            <small>演示趋势 · 历史聚合样本</small>
          </div>
          <TrendChart period={period} />
        </section>
        <section className="panel funnel-panel">
          <SectionTitle
            title="客户转化漏斗"
            action={<span className="tiny-label">演示样本</span>}
          />
          <div className="funnel-subtitle">每一步，都离客户更近一点。</div>
          <div className="funnel-rows">
            {[
              { label: '发现线索', value: data.leads.length, width: 100 },
              {
                label: '高适配客户',
                value: aLeads.length,
                width: (aLeads.length / data.leads.length) * 100,
              },
              {
                label: '正在跟进',
                value: data.leads.filter((lead) => ['跟进中', '已回复'].includes(lead.status))
                  .length,
                width: 50,
              },
              {
                label: '客户回复',
                value: data.leads.filter((lead) => lead.status === '已回复').length,
                width: 25,
              },
            ].map((item, index) => (
              <div className="funnel-row" key={item.label}>
                <div>
                  <span>
                    <i
                      style={{ background: ['#447c5e', '#79a17d', '#b0c399', '#dfd9b8'][index] }}
                    />
                    {item.label}
                  </span>
                  <b>{item.value}</b>
                </div>
                <div className="funnel-track">
                  <span
                    style={{
                      width: `${item.width}%`,
                      background: ['#447c5e', '#79a17d', '#b0c399', '#dfd9b8'][index],
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="funnel-insight">
            <Sparkles size={16} />
            <p>
              <strong>适配度 ≠ 采购意向</strong>
              <br />
              优先核实需求，再推进下一步沟通。
            </p>
          </div>
        </section>
      </div>
      <div className="dashboard-bottom">
        <section className="panel priority-panel">
          <SectionTitle
            title="值得优先关注的客户"
            subtitle="基于业务适配度排序，采购意向需进一步确认"
            action={
              <Link className="text-link" to="/leads">
                全部客户
                <ChevronRight size={14} />
              </Link>
            }
          />
          <div className="table-scroll">
            <table className="lead-table compact">
              <thead>
                <tr>
                  <th>公司 / 客户</th>
                  <th>市场</th>
                  <th>适配等级</th>
                  <th>开发状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...data.leads]
                  .sort((a, b) => b.score - a.score)
                  .slice(0, 4)
                  .map((lead) => (
                    <tr key={lead.id}>
                      <td>
                        <Link to={`/leads?lead=${lead.id}`} className="company-cell">
                          <Avatar lead={lead} small />
                          <span>
                            <strong>{lead.name}</strong>
                            <small>
                              {lead.type} · {lead.product}
                            </small>
                          </span>
                        </Link>
                      </td>
                      <td>
                        <span className="market-cell">
                          <span>{lead.market === '美国' ? '🇺🇸' : '🇦🇺'}</span>
                          {lead.market}
                        </span>
                      </td>
                      <td>
                        <Badge tone={lead.grade === 'A' ? 'green' : 'neutral'}>
                          {lead.grade} 级
                        </Badge>
                        <span className="score-inline">{lead.score}</span>
                      </td>
                      <td>
                        <span
                          className={`status-label ${lead.status === '已回复' ? 'green-text' : ''}`}
                        >
                          <i />
                          {lead.status}
                        </span>
                      </td>
                      <td>
                        <Link
                          aria-label={`查看 ${lead.name}`}
                          to={`/leads?lead=${lead.id}`}
                          className="icon-button"
                        >
                          <ArrowUpRight size={16} />
                        </Link>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="table-bottom">
            <span>共 {data.leads.length} 位客户 · 显示优先关注的 4 位</span>
            <Link to="/leads">
              管理客户线索
              <ArrowRight size={13} />
            </Link>
          </div>
        </section>
        <section className="panel today-panel">
          <SectionTitle title="今日待办" action={<Badge>{openTasks.length} 项待处理</Badge>} />
          <div className="task-list">
            {data.tasks.map((task) => (
              <button
                key={task.id}
                className={`task-item ${task.done ? 'done' : ''}`}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    tasks: current.tasks.map((item) =>
                      item.id === task.id ? { ...item, done: !item.done } : item,
                    ),
                  }))
                }
              >
                <span className="task-check">
                  {task.done ? <Check size={13} /> : <Circle size={17} />}
                </span>
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.detail}</small>
                  <em>
                    <Clock3 size={11} />
                    {task.time}
                    <span>·</span>
                    {task.kind}
                  </em>
                </span>
              </button>
            ))}
          </div>
          <Link className="today-link" to="/inbox">
            前往统一收件箱
            <ArrowRight size={14} />
          </Link>
        </section>
      </div>
      <div className="automation-teaser">
        <div className="automation-teaser-icon">
          <Workflow size={23} />
        </div>
        <div>
          <strong>你的获客流程，可以自己运转。</strong>
          <p>Tavily 发现客户 → DeepSeek 企业研究 → 飞书去重入库</p>
        </div>
        <Badge tone="green">自动获客</Badge>
        <Link to="/automation" className="btn secondary">
          配置 API 调用
          <ArrowUpRight size={15} />
        </Link>
      </div>
      <div className="workspace-note">
        <Globe2 size={13} />
        客户与统计均为虚构演示数据，真实获客状态请见获客任务。
        <CalendarDays size={13} />
        <span>本地工作空间</span>
        <ChevronDown size={11} />
        <MoreHorizontal size={15} />
      </div>
    </>
  );
}
