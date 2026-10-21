import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUp,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Download,
  FileText,
  Mail,
  MessageCircle,
  MoreHorizontal,
  PauseCircle,
  Pencil,
  Play,
  Plus,
  Save,
  Search,
  Send,
  Sparkles,
  Target,
  UsersRound,
  X,
} from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { useWorkspace } from '../app/WorkspaceProvider';
import { Avatar, Badge, Empty, Modal, SectionTitle } from '../components/ui';

export function Dashboard() {
  const { data } = useWorkspace();
  const [day, setDay] = useState('2026-10-19');
  if (!data) return null;
  const pending = data.conversations.filter((c) => !c.reviewed).length;
  const todo = data.tasks.filter((t) => !t.done).length;
  const metrics = [
    { label: '新增潜客', value: 128, change: '23%', icon: UsersRound },
    { label: '待审核文案', value: pending, change: '4', icon: FileText },
    { label: '有效回复', value: 8, change: '2', icon: Mail },
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
            <SectionTitle title="待你处理" />
            {[
              {
                icon: Mail,
                title: '审核首封开发信',
                desc: '系统已生成首封开发信，需审核后发送',
                count: pending,
                to: '/inbox',
                action: '去审核',
              },
              {
                icon: FileText,
                title: '客户询价待确认',
                desc: '有客户提交了具体需求，请确认并安排回复',
                count: 3,
                to: '/inbox',
                action: '查看需求',
              },
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
                        <Link className="btn primary small" to={'/inbox?lead=' + l.id}>
                          {['确认规格', '审核回复', '安排跟进'][i]}
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

export function Communication() {
  const { data, update, notify } = useWorkspace();
  const [params] = useState(() => new URLSearchParams(location.search));
  const [active, setActive] = useState(
    () => data?.conversations.find((c) => c.leadId === params.get('lead'))?.id || 'm1',
  );
  const [pendingOnly, setPendingOnly] = useState(true);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (!data) return null;
  const pending = data.conversations.filter((c) => !c.reviewed).length;
  const conversations = data.conversations.filter(
    (c) =>
      (!pendingOnly || !c.reviewed) &&
      `${data.leads.find((l) => l.id === c.leadId)?.name} ${c.subject} ${c.body}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const message = conversations.find((c) => c.id === active) || conversations[0];
  const lead = data.leads.find((l) => l.id === message?.leadId);
  const save = (draft: string) =>
    update((d) => ({
      ...d,
      conversations: d.conversations.map((c) => (c.id === message?.id ? { ...c, draft } : c)),
    }));
  const needs =
    message?.id === 'm1'
      ? ['产品目录', '样品咨询']
      : message?.id === 'm4'
        ? ['报价咨询', '项目需求']
        : ['产品资料', '规格确认'];
  const classification = message?.classification || '真人回复';
  return (
    <>
      <PageHeading
        eyebrow="COMMUNICATION"
        title="沟通中心"
        description="统一处理邮件与已授权的 WhatsApp 会话"
      >
        <Badge>演示会话 · 不会实际外发</Badge>
      </PageHeading>
      <div className="communication-grid">
        <aside className="comm-list panel">
          <div className="comm-tabs">
            <button className={pendingOnly ? 'active' : ''} onClick={() => setPendingOnly(true)}>
              待处理 <b>{pending}</b>
            </button>
            <button className={!pendingOnly ? 'active' : ''} onClick={() => setPendingOnly(false)}>
              全部
            </button>
          </div>
          <div className="comm-search search-field">
            <Search size={17} />
            <input
              aria-label="搜索客户或消息"
              placeholder="搜索客户或消息"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {conversations.map((c) => {
            const l = data.leads.find((x) => x.id === c.leadId)!;
            return (
              <button
                key={c.id}
                className={'comm-preview ' + (message?.id === c.id ? 'selected' : '')}
                onClick={() => {
                  setActive(c.id);
                  setEditing(false);
                  update((d) => ({
                    ...d,
                    conversations: d.conversations.map((x) =>
                      x.id === c.id ? { ...x, unread: false } : x,
                    ),
                  }));
                }}
              >
                <Avatar lead={l} />
                <div>
                  <strong>{l.name}</strong>
                  <span>
                    {c.channel === '邮件' ? <Mail size={15} /> : <MessageCircle size={15} />}{' '}
                    {c.channel}
                  </span>
                  <p>{c.preview}</p>
                </div>
                <time>{c.time}</time>
                {c.unread && <i />}
              </button>
            );
          })}
          {!conversations.length && (
            <Empty title="暂无待处理会话" detail="切换到全部可查看已审核的演示记录。" />
          )}
        </aside>
        {message && lead ? (
          <>
            <section className="comm-message panel">
              <div className="comm-header">
                <Avatar lead={lead} />
                <div>
                  <strong>
                    {lead.contact} · {lead.name}
                  </strong>
                  <p>
                    {lead.email} ｜ {lead.market} ｜ {message.time}
                  </p>
                </div>
                <Badge tone={message.reviewed ? 'green' : 'amber'}>
                  {message.reviewed ? '已审核' : '待回复'}
                </Badge>
              </div>
              <div className="comm-scroll">
                <article className="received-mail">
                  <div>
                    <strong>{lead.contact}</strong>
                    <span>&lt;{lead.email}&gt;</span>
                    <time>
                      {message.time.includes('昨天') || message.time.includes('月')
                        ? message.time
                        : '2026年10月19日 ' + message.time}
                    </time>
                  </div>
                  <p>{message.body}</p>
                </article>
                <div className="ai-draft">
                  <header>
                    <Pencil size={18} />
                    <strong>AI 回复草稿 · {message.reviewed ? '已审核' : '待审核'}</strong>
                    <Sparkles size={16} />
                  </header>
                  {editing ? (
                    <textarea
                      aria-label="修改回复草稿"
                      value={message.draft}
                      onChange={(e) => save(e.target.value)}
                      autoFocus
                    />
                  ) : (
                    <p className="draft-text">{message.draft}</p>
                  )}
                  {message.attachments?.map((a) => (
                    <div className="draft-attachment" key={a}>
                      <FileText size={27} />
                      <span>
                        {a}
                        <small>4.2 MB · 演示附件</small>
                      </span>
                      <button
                        className="icon-button"
                        aria-label="移除附件"
                        onClick={() =>
                          update((d) => ({
                            ...d,
                            conversations: d.conversations.map((c) =>
                              c.id === message.id ? { ...c, attachments: [] } : c,
                            ),
                          }))
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                </div>
                {message.reviewed && (
                  <div className="info-callout">
                    <CheckCircle2 size={17} />
                    <p>已记录演示发送，下一步跟进已加入跟进计划。</p>
                  </div>
                )}
              </div>
              <footer className="comm-actions">
                <button className="btn secondary" onClick={() => setEditing(!editing)}>
                  <Pencil size={16} />
                  {editing ? '完成修改' : '修改草稿'}
                </button>
                <button
                  className="btn secondary"
                  onClick={() =>
                    notify(message.draft.trim() ? '草稿已保存在当前浏览器' : '请先填写草稿')
                  }
                >
                  <Save size={16} />
                  保存草稿
                </button>
                <button
                  className="btn primary"
                  disabled={
                    !message.draft.trim() || message.reviewed || classification !== '真人回复'
                  }
                  onClick={() => setConfirm(true)}
                >
                  <Send size={17} />
                  审核并发送
                </button>
              </footer>
            </section>
            <aside className="comm-summary panel">
              <SectionTitle
                title="客户摘要"
                action={
                  <Link to={'/leads?lead=' + lead.id} aria-label="查看客户详情">
                    <MoreHorizontal size={19} />
                  </Link>
                }
              />
              <div className="summary-company">
                <Avatar lead={lead} />
                <div>
                  <strong>{lead.name}</strong>
                  <p>
                    {lead.market} ｜ {lead.type}
                  </p>
                </div>
              </div>
              <dl>
                <dt>国家／地区</dt>
                <dd>{lead.market}</dd>
                <dt>客户类型</dt>
                <dd>{lead.type}</dd>
                <dt>关注产品</dt>
                <dd>{lead.product}</dd>
              </dl>
              <section>
                <h3>识别到的需求</h3>
                <div className="needs-tags">
                  {needs.map((n) => (
                    <Badge key={n}>{n}</Badge>
                  ))}
                </div>
              </section>
              <section>
                <h3>回复识别</h3>
                <select
                  aria-label="回复分支"
                  value={classification}
                  onChange={(e) => {
                    const v = e.target.value as typeof classification;
                    update((d) => ({
                      ...d,
                      conversations: d.conversations.map((c) =>
                        c.id === message.id ? { ...c, classification: v } : c,
                      ),
                    }));
                  }}
                >
                  {['真人回复', '自动回复', '联系方式失效', '拒绝联系'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </section>
              <section>
                <h3>跟进状态</h3>
                <div className="pause-notice">
                  <PauseCircle size={28} />
                  <div>
                    <strong>
                      {classification === '联系方式失效'
                        ? '待重新寻找联系方式'
                        : classification === '拒绝联系'
                          ? '全部渠道停止联系'
                          : '原自动跟进已暂停'}
                    </strong>
                    <p>
                      {classification === '真人回复'
                        ? '等待本次回复处理'
                        : classification === '自动回复'
                          ? '转入低频人工复核'
                          : classification === '联系方式失效'
                            ? '核实同公司公开联系人'
                            : '保留停止联系记录'}
                    </p>
                  </div>
                </div>
              </section>
              <section>
                <h3>其他信息</h3>
                <p>
                  <MessageCircle size={17} /> WhatsApp：
                  {message.channel === 'WhatsApp' ? '已授权 · 演示会话' : '尚未获得联系许可'}
                </p>
              </section>
            </aside>
          </>
        ) : (
          <div className="panel comm-empty">
            <Empty title="待处理会话已清空" detail="点击“全部”查看历史消息。" />
          </div>
        )}
      </div>
      {confirm && message && lead && (
        <Modal title="审核并模拟发送" onClose={() => setConfirm(false)}>
          <div className="modal-body">
            <Badge tone="amber">演示操作</Badge>
            <p>
              收件人：{lead.contact} · {lead.email}
            </p>
            <p>渠道：{message.channel}。确认后记录审核状态，并添加人工跟进待办。</p>
            <div className="review-preview">{message.draft}</div>
            <button
              className="btn primary"
              onClick={() => {
                update((d) => ({
                  ...d,
                  conversations: d.conversations.map((c) =>
                    c.id === message.id ? { ...c, reviewed: true, unread: false } : c,
                  ),
                  leads: d.leads.map((l) => (l.id === lead.id ? { ...l, status: '已回复' } : l)),
                  tasks: [
                    ...d.tasks,
                    {
                      id: crypto.randomUUID(),
                      title: '跟进 ' + lead.name,
                      detail: '回复已审核，确认客户规格与样品需求',
                      time: '明天 10:00',
                      kind: '跟进',
                      done: false,
                    },
                  ],
                }));
                setConfirm(false);
                notify('已完成模拟发送，并创建下一步跟进');
              }}
            >
              确认模拟发送
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

export function AcquisitionTasks() {
  const { notify } = useWorkspace();
  const [tasks, setTasks] = useState(() => {
    try {
      return (
        JSON.parse(localStorage.getItem('shadeflow:demo-runs') || 'null') || [
          {
            id: 'run1',
            name: '英国 · 卷帘经销商',
            product: '卷帘',
            source: 'Google 网页 + 企业官网',
            progress: 62,
            status: '正在核实官网',
          },
          {
            id: 'run2',
            name: '澳大利亚 · 蜂巢帘',
            product: '蜂巢帘',
            source: 'Google 地图 + 行业目录',
            progress: 100,
            status: '已完成',
          },
          {
            id: 'run3',
            name: '阿联酋 · 工程渠道',
            product: '电动卷帘',
            source: 'LinkedIn + 行业目录',
            progress: 0,
            status: '待启动',
          },
        ]
      );
    } catch {
      return [];
    }
  });
  const [adding, setAdding] = useState(false);
  type Run = {
    id: string;
    name: string;
    product: string;
    source: string;
    progress: number;
    status: string;
  };
  function save(next: Run[]) {
    setTasks(next);
    localStorage.setItem('shadeflow:demo-runs', JSON.stringify(next));
  }
  return (
    <>
      <PageHeading
        eyebrow="AUTOMATION STUDIO"
        title="自动获客"
        description="选择获客方向，设置执行周期，自动发现潜在客户"
      >
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={16} />
          新建演示任务
        </button>
      </PageHeading>
      <div className="demo-task-grid">
        {tasks.map((t: Run) => (
          <section className="panel demo-task-card" key={t.id}>
            <div>
              <span className="task-target">
                <Target size={23} />
              </span>
              <Badge tone={t.progress === 100 ? 'green' : 'amber'}>{t.status}</Badge>
            </div>
            <h2>{t.name}</h2>
            <p>{t.source}</p>
            <div className="task-progress">
              <i style={{ width: t.progress + '%' }} />
            </div>
            <small>
              进度 {t.progress}% · {t.product}
            </small>
            <div className="task-stages">
              {['采集候选', '双重去重', '官网核实', 'AI 画像', '客户入库'].map((x, i) => (
                <span className={t.progress > i * 20 ? 'complete' : ''} key={x}>
                  {t.progress > (i + 1) * 20 ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <span className="stage-circle" />
                  )}
                  {x}
                </span>
              ))}
            </div>
            <footer>
              <button
                className="btn secondary"
                onClick={() => {
                  save(
                    tasks.map((r: Run) =>
                      r.id === t.id
                        ? { ...r, status: r.status === '已暂停' ? '正在核实官网' : '已暂停' }
                        : r,
                    ),
                  );
                  notify('演示任务状态已更新');
                }}
                disabled={t.progress === 100}
              >
                {t.status === '已暂停' ? <Play size={15} /> : <PauseCircle size={15} />}{' '}
                {t.status === '已暂停' ? '继续' : '暂停'}
              </button>
              <button
                className="btn primary"
                disabled={t.progress === 100 || t.status === '已暂停'}
                onClick={() => {
                  save(
                    tasks.map((r: Run) =>
                      r.id === t.id ? { ...r, progress: 100, status: '已完成' } : r,
                    ),
                  );
                  notify('模拟扫描完成，可在演示客户库查看客户样本');
                }}
              >
                模拟完成
              </button>
              <Link className="text-link" to="/leads">
                查看客户 <ChevronRight size={14} />
              </Link>
            </footer>
          </section>
        ))}
      </div>
      {adding && (
        <Modal title="新建演示获客任务" onClose={() => setAdding(false)}>
          <form
            className="modal-body form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              save([
                {
                  id: crypto.randomUUID(),
                  name: f.get('market') + ' · ' + f.get('type'),
                  source: String(f.get('source')),
                  product: String(f.get('product')),
                  progress: 0,
                  status: '待启动',
                },
                ...tasks,
              ]);
              setAdding(false);
              notify('演示任务已创建');
            }}
          >
            <label>
              目标市场
              <select name="market">
                {['英国', '澳大利亚', '美国', '阿联酋'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              客户类型
              <select name="type">
                {['窗饰经销商', '安装服务商', '工程承包商', '零售商'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              目标产品
              <select name="product">
                {['卷帘', '蜂巢帘', '百叶窗', '防风卷帘'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              采集来源
              <select name="source">
                {[
                  'Google 网页',
                  'Google 地图',
                  'LinkedIn',
                  '行业目录',
                  '海关数据',
                  'Lookalike 相似客户',
                ].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <p className="muted span-2">
              演示分片：国家＋区域＋产品＋客群＋关键词。重复分片在冷却期内不重复执行。
            </p>
            <button className="btn primary span-2">创建演示任务</button>
          </form>
        </Modal>
      )}
    </>
  );
}

export function Materials() {
  const { notify } = useWorkspace();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('全部资料');
  const [preview, setPreview] = useState<{ name: string; category: string; desc: string } | null>(
    null,
  );
  const docs = [
    {
      name: '卷帘产品目录',
      category: '产品目录',
      desc: 'Roller Blind Catalogue · 面料、颜色与控制方式',
    },
    { name: '蜂巢帘产品手册', category: '产品目录', desc: 'Honeycomb Blinds · 遮光与保温系列' },
    {
      name: '电动卷帘技术规格',
      category: '技术资料',
      desc: 'Motorized Roller Blinds · 电机与控制系统',
    },
    { name: '首封开发信模板', category: '沟通模板', desc: 'Email · 英国窗饰经销商 · 首次接洽' },
    {
      name: 'WhatsApp 需求确认',
      category: '沟通模板',
      desc: '已授权会话 · 简洁需求确认与样品咨询',
    },
    { name: '人工电话沟通提纲', category: '沟通模板', desc: '决策人、采购品类、周期与供应商确认' },
  ];
  return (
    <>
      <PageHeading
        eyebrow="PRODUCTS & RESOURCES"
        title="产品与资料"
        description="准备好产品资料，让每次回复都有合适的内容"
      />
      <div className="panel resources-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="搜索资料"
            placeholder="搜索产品目录、模板与资料"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select aria-label="资料分类" value={type} onChange={(e) => setType(e.target.value)}>
          {['全部资料', '产品目录', '技术资料', '沟通模板'].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </div>
      <div className="resource-grid">
        {docs
          .filter((x) => (type === '全部资料' || x.category === type) && x.name.includes(query))
          .map((x) => (
            <button className="panel resource-card" key={x.name} onClick={() => setPreview(x)}>
              <span>
                <FileText size={27} />
              </span>
              <Badge>{x.category}</Badge>
              <h3>{x.name}</h3>
              <p>{x.desc}</p>
              <footer>
                2026.10.19 更新 <ChevronRight size={16} />
              </footer>
            </button>
          ))}
      </div>
      {preview && (
        <Modal title={preview.name} onClose={() => setPreview(null)}>
          <div className="modal-body">
            <Badge>演示资料</Badge>
            <h2>{preview.name}</h2>
            <p>{preview.desc}</p>
            <div className="review-preview">
              {preview.category === '沟通模板'
                ? 'Hi {{first_name}},\n\nI noticed your work in {{product_category}}. Could you let us know if you are currently reviewing suppliers or planning new projects?\n\nBest regards,\nJohnson'
                : '资料内容占位：产品系列、可选面料、尺寸范围、控制系统与项目应用。\n\nMOQ、价格、认证、样品库存与交期以团队确认结果为准。'}
            </div>
            <button
              className="btn primary"
              onClick={() => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(
                  new Blob(
                    [preview.name + '\n' + preview.desc + '\n演示资料，请替换为正式产品资料。'],
                    { type: 'text/plain;charset=utf-8' },
                  ),
                );
                a.download = preview.name + '-演示.txt';
                a.click();
                URL.revokeObjectURL(a.href);
                notify('已下载演示资料说明');
              }}
            >
              <Download size={16} />
              下载演示资料
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
