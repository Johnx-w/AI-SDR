import { createPortal } from 'react-dom';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
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
import { OutreachCommunication as Communication } from '../pages/OutreachCommunication';
import { LeadLibrary } from '../pages/LeadLibrary';
import { overviewApi } from '../services/overview';
import type { OverviewData } from '../services/overview';
import { OverviewReminders } from '../components/OverviewReminders';
import type { InitialPage } from './initialPage';
import { leadLibrary as defaultLibrary, type LeadLibraryClient } from '../services/leadLibrary';
import { outreachApi, type OutreachState } from '../outreachApi';
const Dashboard = lazy(() =>
  import('../pages/Dashboard').then((module) => ({ default: module.Dashboard })),
);
const Materials = lazy(() =>
  import('../pages/ProductKnowledge').then((module) => ({ default: module.ProductKnowledgePage })),
);
const ApiConnections = lazy(() =>
  import('../pages/ApiConnections').then((module) => ({ default: module.ApiConnections })),
);
const Automation = lazy(() =>
  import('../pages/Automation').then((module) => ({ default: module.Automation })),
);
const CustomerBusiness = lazy(() =>
  import('../pages/CustomerBusiness').then((module) => ({ default: module.CustomerBusiness })),
);

const nav = [
  { path: '/', name: '运营总览', icon: LayoutDashboard },
  { path: '/automation', name: '获客任务', icon: Zap },
  { path: '/leads', name: '客户库', icon: UsersRound },
  { path: '/business', name: '跟进任务', icon: ClipboardList },
  { path: '/inbox', name: '沟通中心', icon: MessageSquare },
  { path: '/materials', name: '素材库', icon: FolderOpen },
  { path: '/settings', name: 'API 连接', icon: Settings2 },
];
function WorkspaceNavigation({ onNavigate }: { onNavigate: () => void }) {
  const [hint, setHint] = useState<{ name: string; left: number; top: number } | null>(null);
  function showLabel(link: HTMLAnchorElement, name: string) {
    if (!window.matchMedia('(min-width: 761px)').matches) return;
    const { right, top, height } = link.getBoundingClientRect();
    setHint({ name, left: right + 8, top: top + height / 2 });
  }
  useEffect(() => {
    if (!hint) return;
    const hide = () => setHint(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', hide, true);
    };
  }, [hint]);
  return (
    <>
      {' '}
      <nav>
        {nav.map(({ path, name, icon: Icon }) => (
          <NavLink
            key={path}
            aria-label={name}
            to={path}
            end={path === '/'}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'touch') showLabel(event.currentTarget, name);
            }}
            onPointerLeave={() => setHint(null)}
            onFocus={(event) => {
              if (event.currentTarget.matches(':focus-visible'))
                showLabel(event.currentTarget, name);
            }}
            onBlur={() => setHint(null)}
            onClick={() => {
              setHint(null);
              onNavigate();
            }}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <Icon size={18} />
            <span>{name}</span>
          </NavLink>
        ))}
      </nav>
      {hint &&
        createPortal(
          <div
            key={hint.name}
            aria-hidden="true"
            className="workspace-nav-hint"
            style={{ left: hint.left, top: hint.top }}
          >
            {hint.name}
          </div>,
          document.body,
        )}
    </>
  );
}
export function App({
  library,
  initial,
}: { library?: LeadLibraryClient; initial?: InitialPage } = {}) {
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
  const notificationButton = useRef<HTMLButtonElement>(null);
  const notificationPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!notifications) return;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !notificationButton.current?.contains(event.target) &&
        !notificationPanel.current?.contains(event.target)
      )
        setNotifications(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNotifications(false);
        notificationButton.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [notifications]);
  const [reminders, setReminders] = useState<OverviewData | null>(null);
  const [reminderLoading, setReminderLoading] = useState(false);
  const [reminderError, setReminderError] = useState('');
  const [reminderRevision, setReminderRevision] = useState(0);
  const [reminderCount, setReminderCount] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReminderLoading(true);
    setReminderError('');
    const read = notifications
      ? overviewApi.get('7d', controller.signal)
      : overviewApi.reminderCount(controller.signal);
    void read
      .then(
        (value) => {
          if (controller.signal.aborted) return;
          if (typeof value === 'number') setReminderCount(value);
          else {
            setReminders(value);
            setReminderCount((value.metrics.dueTasks || 0) + (value.products.draft || 0));
          }
        },
        () => {
          if (!controller.signal.aborted) setReminderError('提醒读取失败，请关闭后重试');
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setReminderLoading(false);
      });
    return () => controller.abort();
  }, [notifications, reminderRevision]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'hidden') setReminderRevision((value) => value + 1);
    };
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const current = nav.find((item) => item.path === location.pathname);
  const boot = useRef(initial);
  const outreachPages = useRef<Pick<InitialPage, 'outreach'>>({});
  const warmed = useRef(false);
  useEffect(() => {
    if (location.pathname === '/settings') {
      outreachPages.current = {};
      warmed.current = false;
    }
    if (warmed.current || !['/', '/leads', '/inbox'].includes(location.pathname)) return;
    const customerList = library ?? defaultLibrary;
    const pages = outreachPages.current;
    const warm = () => {
      if (warmed.current || document.hidden) return;
      warmed.current = true;
      const inbox = location.pathname === '/inbox';
      const tab = new URLSearchParams(location.search).get('tab') || 'mailboxes';
      if (location.pathname !== '/leads' && !customerList.cachedList())
        void customerList
          .list('page=1&q=&market=&grade=&product=&status=', false, true)
          .catch(() => {});
      const viewKey = 'view=current&status=all&q=&page=1&pageSize=20';
      if (!pages.outreach && !(inbox && tab === 'campaigns'))
        void outreachApi<OutreachState>('/state?' + viewKey)
          .then((data) => {
            pages.outreach ??= { ...data, viewKey };
          })
          .catch(() => {});
    };
    const timer = window.setTimeout(warm, 150);
    document.addEventListener('visibilitychange', warm);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', warm);
    };
  }, [library, location.pathname, location.search]);
  useEffect(() => {
    boot.current = undefined;
    document.getElementById('root')?.setAttribute('data-interactive', 'true');
  }, []);
  return (
    <div className="app-shell workspace-shell">
      {mobile && (
        <button className="sidebar-shade" aria-label="关闭导航" onClick={() => setMobile(false)} />
      )}
      <aside className={`sidebar ${mobile ? 'open' : ''}`}>
        <NavLink className="brand" to="/" aria-label="ShadeFlow 首页" title="ShadeFlow 首页">
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
        <WorkspaceNavigation onNavigate={() => setMobile(false)} />
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
              ref={notificationButton}
              className="icon-button notification-button"
              aria-label="通知"
              aria-expanded={notifications}
              aria-controls="notification-panel"
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
          <div ref={notificationPanel} id="notification-panel">
            <OverviewReminders
              data={reminders}
              loading={reminderLoading}
              error={reminderError}
              onOpen={(to) => {
                setNotifications(false);
                navigate(to);
              }}
            />
          </div>
        )}
        <main>
          <Suspense fallback={<p role="status">正在读取页面…</p>}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route
                path="/leads"
                element={
                  <LeadLibrary
                    library={library}
                    initialKey={boot.current?.list?.key}
                    initialDetailId={boot.current?.detail?.lead.id}
                  />
                }
              />
              <Route path="/tasks" element={<Navigate to="/business?tab=tasks" replace />} />
              <Route path="/business" element={<CustomerBusiness />} />
              <Route path="/materials" element={<Materials />} />
              <Route path="/campaigns" element={<Navigate to="/inbox?tab=campaigns" replace />} />
              <Route
                path="/inbox"
                element={<Communication initial={boot.current} pages={outreachPages.current} />}
              />
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
          </Suspense>
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
