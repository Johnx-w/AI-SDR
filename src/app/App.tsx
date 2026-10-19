import { useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  Bell,
  BookOpen,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  Globe2,
  LayoutDashboard,
  MessageSquare,
  FolderOpen,
  Menu,
  Search,
  Settings2,
  Sparkles,
  UsersRound,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { useWorkspace } from './WorkspaceProvider';
import { Campaigns, Reports, Settings } from '../pages/Business';
import {
  Dashboard,
  Communication,
  Followups,
  AcquisitionTasks,
  Materials,
} from '../pages/Workbench';
import { LeadLibrary } from '../pages/LeadLibrary';
import { Automation } from '../pages/Automation';
import { Modal } from '../components/ui';

const nav = [
  { path: '/', name: '运营总览', icon: LayoutDashboard },
  { path: '/leads', name: '客户库', icon: UsersRound },
  { path: '/tasks', name: '获客任务', icon: Zap },
  { path: '/inbox', name: '沟通中心', icon: MessageSquare },
  { path: '/followups', name: '跟进计划', icon: CalendarDays },
  { path: '/materials', name: '产品与资料', icon: FolderOpen },
  { path: '/settings', name: '策略设置', icon: Settings2 },
];
export function App() {
  const { data, toast, notify } = useWorkspace();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [mobile, setMobile] = useState(false);
  const [help, setHelp] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const current = nav.find((item) => item.path === location.pathname);
  const unread = data?.conversations.filter((item) => item.unread).length || 0;
  if (!data)
    return (
      <div className="boot">
        <div className="brand-mark">S</div>
        <p>正在准备你的工作台…</p>
      </div>
    );
  return (
    <div className="app-shell">
      {mobile && (
        <button className="sidebar-shade" aria-label="关闭导航" onClick={() => setMobile(false)} />
      )}
      <aside className={`sidebar ${mobile ? 'open' : ''}`}>
        <NavLink className="brand" to="/">
          <span className="brand-mark">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span>
            ShadeFlow
            <small>外贸窗饰获客工作台</small>
          </span>
        </NavLink>
        <button className="workspace-switch" onClick={() => navigate('/settings')}>
          <span className="workspace-logo">
            <Building2 size={20} />
          </span>
          <span>
            <strong>窗饰出海项目</strong>
            <small>获客与客户运营工作区</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-caption">WORKSPACE</div>
        <nav>
          {nav.map(({ path, name, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              onClick={() => setMobile(false)}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon size={18} />
              <span>{name}</span>
              {path === '/inbox' && unread > 0 ? (
                <b className="nav-count">{unread}</b>
              ) : path === '/automation' ? (
                <span className="nav-dot" />
              ) : null}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-market">
          <span className="tiny-label">当前目标市场</span>
          <div>
            <Globe2 size={16} />
            <span>美国 & 澳大利亚</span>
          </div>
          <p>从发现潜客，到持续跟进。</p>
        </div>
        <div className="sidebar-bottom">
          <div className="assistant-card">
            <div>
              <Sparkles size={16} />
              <strong>让 AI 帮你多走一步</strong>
            </div>
            <p>
              发现客户、研究画像，
              <br />
              把精力留给有价值的沟通。
            </p>
            <button onClick={() => navigate('/automation')}>
              创建获客任务 <ArrowUpRight size={15} />
            </button>
          </div>
          <NavLink className="nav-item" to="/automation">
            <Workflow size={18} />
            <span>真实 n8n 工作流</span>
          </NavLink>
          <button className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={18} />
            <span>使用指南</span>
            <ArrowUpRight size={14} />
          </button>
          <div className="sidebar-footer">
            <span className="team-avatar">J</span> 外贸团队 <ChevronDown size={14} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="展开导航"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>{current?.name || '设置与集成'}</strong>
          </div>
          <div className="topbar-right">
            <form
              className="global-search"
              onSubmit={(event) => {
                event.preventDefault();
                const query = new URLSearchParams({ q: search });
                if (location.search.includes('dataset=real')) query.set('dataset', 'real');
                navigate(`/leads?${query}`);
              }}
            >
              <Search size={15} />
              <input
                ref={searchRef}
                aria-label="搜索客户"
                placeholder="搜索客户、公司、邮箱或关键词…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <kbd>
                <Command size={10} /> K
              </kbd>
            </form>
            <span className="demo-pill">
              <span />{' '}
              {location.pathname === '/leads' && location.search.includes('dataset=real')
                ? '飞书真实客户'
                : '概念设计 · 示例数据'}
            </span>
            <button
              className="icon-button notification-button"
              aria-label="通知"
              onClick={() => setNotifications(!notifications)}
            >
              <Bell size={18} />
              <i />
            </button>
            <div className="topbar-divider" />
            <button
              className="user-avatar"
              aria-label="工作区设置"
              onClick={() => navigate('/settings')}
            >
              J
            </button>
          </div>
        </header>
        {notifications && (
          <div className="notification-panel">
            <h3>待处理提醒</h3>
            {data.tasks
              .filter((task) => !task.done)
              .map((task) => (
                <button
                  key={task.id}
                  onClick={() => {
                    setNotifications(false);
                    navigate('/');
                  }}
                >
                  <span className="status-dot" />
                  <div>
                    <strong>{task.title}</strong>
                    <small>{task.time} · 演示待办</small>
                  </div>
                  <ChevronRight size={14} />
                </button>
              ))}
            {data.tasks.every((task) => task.done) && <p>今日待办已全部完成。</p>}
          </div>
        )}
        <main>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/leads" element={<LeadLibrary />} />
            <Route path="/tasks" element={<AcquisitionTasks />} />
            <Route path="/followups" element={<Followups />} />
            <Route path="/materials" element={<Materials />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/inbox" element={<Communication />} />
            <Route path="/automation" element={<Automation />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="*"
              element={
                <div className="not-found">
                  <h1>这个页面还没有内容</h1>
                  <NavLink className="btn primary" to="/">
                    返回工作台
                  </NavLink>
                </div>
              }
            />
          </Routes>
        </main>
        <footer className="page-footer">
          <span>
            ShadeFlow <span>·</span> 把每条线索，变成新的可能。
          </span>
          <span>
            <span className="status-dot" />{' '}
            {location.search.includes('dataset=real')
              ? '飞书真实客户 · 只读同步'
              : '演示工作区 · n8n 真实链路保留'}
          </span>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button aria-label="关闭通知" className="icon-button" onClick={() => notify('')}>
            <X size={13} />
          </button>
        </div>
      )}
      {help && (
        <Modal title="开始使用 ShadeFlow" onClose={() => setHelp(false)}>
          <div className="modal-body help-content">
            <BookOpen size={30} />
            <p>1. 在客户线索中筛选、查看画像，或添加虚构客户进行演示。</p>
            <p>2. 在多渠道触达中创建演示计划；在收件箱中保存回复草稿。</p>
            <p>
              3. 自动化中心调用真实 n8n
              Webhook。先按项目文档配置入口和认证，再从任务表单提交搜索条件。
            </p>
            <p className="muted">
              业务演示数据保存在当前浏览器中。n8n
              运行可能产生搜索费用并写入飞书，请核对参数后再提交。
            </p>
            <button
              className="btn primary"
              onClick={() => {
                setHelp(false);
                navigate('/automation');
              }}
            >
              前往自动化中心
              <ArrowUpRight size={16} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
