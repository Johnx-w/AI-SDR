import { useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  Bell,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
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
  X,
  Zap,
} from 'lucide-react';
import { useWorkspace } from './WorkspaceProvider';
import { Dashboard, Communication, Materials } from '../pages/Workbench';
import { ApiConnections } from '../pages/ApiConnections';
import { LeadLibrary } from '../pages/LeadLibrary';
import { Automation } from '../pages/Automation';
import { CustomerBusiness } from '../pages/CustomerBusiness';
import { overviewApi } from '../services/overview';
import type { OverviewData } from '../services/overview';
import { OverviewReminders } from '../components/OverviewReminders';

const nav = [
  { path: '/', name: '运营总览', icon: LayoutDashboard },
  { path: '/automation', name: '获客任务', icon: Zap },
  { path: '/leads', name: '客户库', icon: UsersRound },
  { path: '/business', name: '客户业务', icon: ClipboardList },
  { path: '/inbox', name: '沟通中心', icon: MessageSquare },
  { path: '/materials', name: '产品与资料', icon: FolderOpen },
  { path: '/settings', name: 'API 连接', icon: Settings2 },
];
export function App() {
  const { toast, notify } = useWorkspace();
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
  const [notifications, setNotifications] = useState(false);
  const [reminders, setReminders] = useState<OverviewData | null>(null);
  const [reminderLoading, setReminderLoading] = useState(false);
  const [reminderError, setReminderError] = useState('');
  useEffect(() => {
    if (!notifications) return;
    const controller = new AbortController();
    setReminderLoading(true);
    setReminderError('');
    setReminders(null);
    void overviewApi
      .get('7d', controller.signal)
      .then(
        (value) => {
          if (!controller.signal.aborted) setReminders(value);
        },
        () => {
          if (!controller.signal.aborted) setReminderError('提醒读取失败，请关闭后重试');
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setReminderLoading(false);
      });
    return () => controller.abort();
  }, [notifications]);
  const current = nav.find((item) => item.path === location.pathname);
  const reminderCount =
    (reminders?.metrics.dueTasks || 0) +
    (reminders?.work.paused || 0) +
    (reminders?.products.draft || 0);
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
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-market">
          <span className="tiny-label">获客范围</span>
          <div>
            <Globe2 size={16} />
            <span>按任务与计划设置</span>
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
            <strong>{current?.name || '工作空间'}</strong>
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
            <button
              className="icon-button notification-button"
              aria-label="通知"
              onClick={() => setNotifications(!notifications)}
            >
              <Bell size={18} />
              {reminderCount > 0 && <i />}
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
          <OverviewReminders
            data={reminders}
            loading={reminderLoading}
            error={reminderError}
            onOpen={(to) => {
              setNotifications(false);
              navigate(to);
            }}
          />
        )}
        <main>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/leads" element={<LeadLibrary />} />
            <Route path="/tasks" element={<Navigate to="/business?tab=tasks" replace />} />
            <Route path="/business" element={<CustomerBusiness />} />
            <Route path="/materials" element={<Materials />} />
            <Route path="/campaigns" element={<Navigate to="/inbox?tab=campaigns" replace />} />
            <Route path="/inbox" element={<Communication />} />
            <Route path="/automation" element={<Automation />} />
            <Route path="/reports" element={<Navigate to="/" replace />} />
            <Route path="/settings" element={<ApiConnections />} />
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
    </div>
  );
}
