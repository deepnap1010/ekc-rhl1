// client/src/layouts/AppLayout.tsx
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutGrid, Cpu, History, Clock, FileBarChart, Bell,
  Users, ShieldCheck, Network, LogOut, Gauge, Building2, Menu, X, Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '../store/auth';
import { useSettings, applyTheme } from '../lib/settings';
import { useT } from '../lib/i18n';
import { Avatar } from '../components/ui';
import { toast } from '../store/toast';
import { disconnectSocket } from '../lib/socket';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  module: string;
  section: string;
}

const NAV: NavItem[] = [
  { to: '/',          label: 'Dashboard',         icon: LayoutGrid,  module: 'dashboard', section: 'Overview' },
  { to: '/machines',  label: 'Machines',           icon: Cpu,         module: 'machines',  section: 'Overview' },
  { to: '/downtime',  label: 'Downtime',           icon: Clock,       module: 'downtime',  section: 'Monitoring' },
  { to: '/history',   label: 'History Log',        icon: History,     module: 'history',   section: 'Monitoring' },
  { to: '/reports',   label: 'Reports',            icon: FileBarChart,module: 'reports',   section: 'Monitoring' },
  { to: '/alerts',    label: 'Alerts',             icon: Bell,        module: 'alerts',    section: 'Monitoring' },
  { to: '/employees', label: 'Employees',          icon: Users,       module: 'employees', section: 'Management' },
  { to: '/orgchart',  label: 'Org Chart',          icon: Network,     module: 'orgchart',  section: 'Management' },
  { to: '/departments',label: 'Departments',       icon: Building2,   module: 'orgchart',  section: 'Management' },
  { to: '/roles',     label: 'Roles & Permissions',icon: ShieldCheck, module: 'roles',     section: 'Management' },
  { to: '/settings',  label: 'Settings',           icon: SettingsIcon,module: 'settings',  section: 'System' },
];

export default function AppLayout() {
  const { user, can, logout } = useAuthStore();
  const { company, appearance } = useSettings();
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  // Drawer state — only relevant below the lg breakpoint; the sidebar is always
  // visible from lg up regardless of this flag.
  const [mobileOpen, setMobileOpen] = useState(false);

  const allowed = NAV.filter((n) => can(n.module));
  const sections = [...new Set(allowed.map((n) => n.section))];
  const displayName = user?.name || '';

  // Belt-and-braces theme application: re-assert the theme whenever the preference
  // changes (the settings store also does this via its listener).
  useEffect(() => { applyTheme(); }, [appearance.theme]);

  // Close the drawer whenever the route changes (e.g. after tapping a nav item).
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  // Lock body scroll while the off-canvas drawer is open on small screens.
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileOpen]);

  const handleLogout = () => {
    disconnectSocket();
    logout();
    toast.success('Signed out');
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-base overflow-hidden">
      {/* Backdrop — only on small screens when the drawer is open */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-primary/40 backdrop-blur-[1px] lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar — static from lg up; off-canvas drawer below it */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-surface border-r border-line flex flex-col shadow-sm
          transform transition-transform duration-200 ease-out
          lg:static lg:z-auto lg:w-60 lg:shrink-0 lg:translate-x-0
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Brand */}
        <div className="px-5 py-4 flex items-center gap-2.5 border-b border-line">
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
            <Gauge size={20} className="text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-sm leading-tight text-primary truncate">{company.appName}</div>
            <div className="text-[10px] text-steel truncate">{company.tagline}</div>
          </div>
          {/* Close button — drawer only */}
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden text-steel hover:text-primary p-1 -mr-1"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-5">
          {sections.map((sec) => (
            <div key={sec}>
              <div className="label px-2 mb-1.5">{t(sec)}</div>
              <div className="space-y-0.5">
                {allowed.filter((n) => n.section === sec).map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.to === '/'}
                    onClick={() => setMobileOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors ${
                        isActive
                          ? 'bg-accent/10 text-accent font-medium'
                          : 'text-steel hover:text-primary hover:bg-line/60'
                      }`
                    }
                  >
                    <n.icon size={17} className="shrink-0" />
                    {t(n.label)}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* User footer */}
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2.5 px-1.5 mb-2">
            <Avatar src={user?.avatar} name={displayName} size={32} />
            <div className="min-w-0">
              <div className="text-xs font-medium text-primary truncate">{displayName}</div>
              <div className="text-[10px] text-steel truncate">
                {user?.role?.name || (user?.isSuperAdmin ? 'Super Admin' : '')}
              </div>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-steel hover:text-stopped hover:bg-stopped/5 transition-colors"
          >
            <LogOut size={16} /> {t('Sign out')}
          </button>
        </div>
      </aside>

      {/* Right column — mobile top bar + scrollable content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar with hamburger — hidden from lg up */}
        <header className="lg:hidden flex items-center gap-3 bg-surface border-b border-line px-4 py-3 shadow-sm">
          <button
            onClick={() => setMobileOpen(true)}
            className="text-steel hover:text-primary p-1 -ml-1"
            aria-label="Open menu"
          >
            <Menu size={22} />
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
              <Gauge size={16} className="text-accent" />
            </div>
            <span className="font-semibold text-sm text-primary truncate">{company.appName}</span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
