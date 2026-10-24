import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUp,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  Mail,
  Play,
  Target,
  UsersRound,
} from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { useWorkspace } from '../app/WorkspaceProvider';
import { Badge, SectionTitle } from '../components/ui';

export function Dashboard() {
  const { data } = useWorkspace();
  const [day, setDay] = useState('2026-10-19');
  if (!data) return null;
  const pending = data.conversations.filter((c) => !c.reviewed).length;
  const todo = data.tasks.filter((t) => !t.done).length;
  const metrics = [
    { label: '新增潜客', value: 128, change: '23%', icon: UsersRound },
    { label: '待审核文案 · 演示', value: pending, change: '4', icon: FileText },
    { label: '有效回复 · 演示', value: 8, change: '2', icon: Mail },
    { label: '今日待跟进', value: todo, change: '3', icon: CalendarDays },
  ];
  return (
    <>
      <PageHeading
        eyebrow="OVERVIEW"
        title="今天的获客与跟进"
        description="先处理需要你决策的事项，再查看自动运行进度"
      >
        <label className="date-picker">
          <CalendarDays size={16} />
          <input
            aria-label="概览日期"
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </label>
      </PageHeading>
      <div className="work-metrics">
        {metrics.map((m, i) => (
          <section className="panel work-metric" key={m.label}>
            <m.icon size={26} />
            <div>
              <span>{m.label}</span>
              <strong>{day === '2026-10-19' ? m.value : [96, 7, 6, 3][i]}</strong>
            </div>
            <div className={'metric-delta ' + (i === 1 ? 'danger' : '')}>
              <span>
                <ArrowUp size={17} />
                {m.change}
              </span>
              <small>较昨日</small>
            </div>
          </section>
        ))}
      </div>
      <div className="dashboard-columns">
        <div className="dashboard-stack">
          <section className="panel decision-panel">
            <SectionTitle title="待你处理" subtitle="以下为演示任务，不代表真实邮箱待办" />
            {[
              {
                icon: UsersRound,
                title: '疑似重复客户',
                desc: '发现可能重复的客户记录，请核对后处理',
                count: 2,
                to: '/leads?duplicates=1',
                action: '核对',
              },
            ].map((x) => (
              <div className="decision-row" key={x.title}>
                <x.icon size={27} />
                <div>
                  <strong>{x.title}</strong>
                  <p>{x.desc}</p>
                </div>
                <b>{x.count}</b>
                <Link className="btn primary" to={x.to}>
                  {x.action}
                </Link>
              </div>
            ))}
          </section>
          <section className="panel funnel-panel">
            <SectionTitle title="获客漏斗" subtitle="本周 · 演示汇总" />
            <div className="work-funnel">
              {[
                { label: '候选企业', count: 420, icon: Building2 },
                { label: '匹配客户', count: 128, icon: UsersRound },
                { label: '已核实联系人', count: 76, icon: FileText },
                { label: '有效回复', count: 8, icon: Mail },
              ].map((x, i) => (
                <div key={x.label}>
                  <x.icon size={26} />
                  <span>
                    {x.label}
                    <strong>{x.count}</strong>
                  </span>
                  {i < 3 && <ChevronRight className="funnel-chevron" size={16} />}
                </div>
              ))}
            </div>
          </section>
          <section className="panel priority-panel">
            <SectionTitle
              title="优先跟进客户"
              action={
                <Link className="text-link" to="/leads">
                  查看全部 <ChevronRight size={14} />
                </Link>
              }
            />
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>企业</th>
                    <th>市场</th>
                    <th>需求</th>
                    <th>下一步</th>
                  </tr>
                </thead>
                <tbody>
                  {[data.leads[0], data.leads[4], data.leads[1]].map((l, i) => (
                    <tr key={l.id}>
                      <td>
                        <Link to={'/leads?lead=' + l.id}>{l.name}</Link>
                      </td>
                      <td>
                        {l.market === '英国' ? '🇬🇧' : l.market === '阿联酋' ? '🇦🇪' : '🇦🇺'}{' '}
                        {l.market}
                      </td>
                      <td>{['卷帘样品', '产品目录', '蜂巢帘'][i]}</td>
                      <td>
                        <Link className="btn primary small" to={'/leads?lead=' + l.id}>
                          查看客户
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <div className="dashboard-stack">
          <section className="panel running-panel">
            <SectionTitle
              title="获客任务运行中"
              action={
                <Link className="text-link" to="/tasks">
                  查看全部 <ChevronRight size={14} />
                </Link>
              }
            />
            {[
              {
                title: '英国 · 卷帘经销商',
                desc: '挖掘当地卷帘经销商，采集官网联系方式',
                status: '正在核实官网',
                progress: 62,
              },
              {
                title: '澳大利亚 · 蜂巢帘',
                desc: '搜索建材与家居渠道，获取决策人信息',
                status: '已完成',
                progress: 100,
              },
              {
                title: '阿联酋 · 工程渠道',
                desc: '聚焦酒店与商业项目，挖掘工程承包商',
                status: '待启动',
                progress: 0,
              },
            ].map((x, i) => (
              <Link to="/tasks" className="running-row" key={x.title}>
                <span className={'run-symbol state-' + i}>
                  {i === 0 ? (
                    <Target size={28} />
                  ) : i === 1 ? (
                    <Check size={24} />
                  ) : (
                    <Play size={21} />
                  )}
                </span>
                <div>
                  <strong>{x.title}</strong>
                  <p>{x.desc}</p>
                </div>
                <div className="run-progress">
                  <span>
                    {i === 0 ? (
                      <span className="loading-ring" />
                    ) : i === 1 ? (
                      <CheckCircle2 size={15} />
                    ) : (
                      <Play size={14} />
                    )}{' '}
                    {x.status}
                  </span>
                  <div>
                    <i style={{ width: x.progress + '%' }} />
                  </div>
                  <small>{x.progress}%</small>
                </div>
              </Link>
            ))}
          </section>
          <section className="panel reply-chart">
            <SectionTitle title="近 7 天有效回复" subtitle="演示趋势" />
            <ReplyChart />
          </section>
          <section className="panel automation-health">
            <CheckCircle2 size={25} />
            <div>
              <strong>
                自动化运行正常 <Badge>演示状态</Badge>
              </strong>
              <p>系统按计划执行获客任务、发送邮件与数据更新</p>
            </div>
            <span>更新于 10:24</span>
          </section>
        </div>
      </div>
      <p className="page-note">
        演示运营数据用于呈现完整业务流程；真实客户请在客户库切换“真实获客”。
      </p>
    </>
  );
}
function ReplyChart() {
  const values = [3, 5, 7, 6, 11, 14, 8];
  const pts = values.map((v, i) => [40 + i * 60, 154 - v * 8]);
  const path = pts.map(([x, y], i) => (i ? 'L' : 'M') + x + ',' + y).join(' ');
  return (
    <svg viewBox="0 0 430 190" role="img" aria-label="近7天演示回复数量为3、5、7、6、11、14、8">
      <defs>
        <linearGradient id="repliesFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7d9d64" stopOpacity=".2" />
          <stop offset="1" stopColor="#7d9d64" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 5, 10, 15].map((v) => (
        <g key={v}>
          <line x1="38" x2="410" y1={154 - v * 8} y2={154 - v * 8} stroke="#edf0f4" />
          <text x="13" y={158 - v * 8}>
            {v}
          </text>
        </g>
      ))}
      {pts.map(([x], i) => (
        <line key={i} x1={x} x2={x} y1="25" y2="154" stroke="#f0f3f6" />
      ))}
      <path d={path + ' L400,154 L40,154 Z'} fill="url(#repliesFill)" />
      <path d={path} fill="none" stroke="#78995f" strokeWidth="2.5" />
      {pts.map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="3.6" fill="#78995f" />
          <text x={x} y={y - 10} textAnchor="middle">
            {values[i]}
          </text>
          <text x={x} y="177" textAnchor="middle">
            10.{13 + i}
          </text>
        </g>
      ))}
    </svg>
  );
}

export { RealCommunication as Communication } from './RealCommunication';
export { ProductKnowledgePage as Materials } from './ProductKnowledge';
