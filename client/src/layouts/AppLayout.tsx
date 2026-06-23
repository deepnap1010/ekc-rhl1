// client/src/layouts/AppLayout.tsx
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutGrid, Cpu, History, Clock, FileBarChart, Bell,
  Users, ShieldCheck, Network, LogOut, Gauge, Building2, Menu, X,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '../store/auth';
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
];

export default function AppLayout() {
  const { user, can, logout } = useAuthStore();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false); // mobile drawer

  const allowed = NAV.filter((n) => can(n.module));
  const sections = [...new Set(allowed.map((n) => n.section))];

  const handleLogout = () => {
    disconnectSocket();
    logout();
    toast.success('Signed out');
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-base overflow-hidden">
      {/* Backdrop — mobile only, when the drawer is open */}
      {open && <div onClick={() => setOpen(false)} className="fixed inset-0 bg-slate-900/40 z-30 lg:hidden" aria-hidden />}

      {/* Sidebar — static on desktop (lg+), slide-in drawer below lg */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-64 lg:w-60 shrink-0 bg-surface border-r border-line flex flex-col shadow-xl lg:shadow-sm transform transition-transform duration-200 lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Brand */}
        <div className="px-5 py-4 flex items-center gap-2.5 border-b border-line">
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
            <Gauge size={20} className="text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-sm leading-tight text-primary truncate">EKC SmartFactory</div>
            <div className="text-[10px] text-steel">Production Monitor</div>
          </div>
          {/* Close — mobile only */}
          <button onClick={() => setOpen(false)} className="lg:hidden text-steel hover:text-primary p-1 -mr-1" aria-label="Close menu">
            <X size={18} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-5">
          {sections.map((sec) => (
            <div key={sec}>
              <div className="label px-2 mb-1.5">{sec}</div>
              <div className="space-y-0.5">
                {allowed.filter((n) => n.section === sec).map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.to === '/'}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors ${
                        isActive
                          ? 'bg-accent/10 text-accent font-medium'
                          : 'text-steel hover:text-primary hover:bg-line/60'
                      }`
                    }
                  >
                    <n.icon size={17} />
                    {n.label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* User footer */}
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2.5 px-1.5 mb-2">
            <div className="w-8 h-8 rounded-full bg-accent/15 text-accent flex items-center justify-center text-xs font-semibold shrink-0">
              {user?.name?.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-primary truncate">{user?.name}</div>
              <div className="text-[10px] text-steel truncate">
                {user?.role?.name || (user?.isSuperAdmin ? 'Super Admin' : '')}
              </div>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-steel hover:text-stopped hover:bg-stopped/5 transition-colors"
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar — brand + hamburger (sidebar is off-canvas here) */}
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 bg-surface border-b border-line shrink-0">
          <button onClick={() => setOpen(true)} className="text-steel hover:text-primary p-1 -ml-1" aria-label="Open menu">
            <Menu size={22} />
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
              <Gauge size={16} className="text-accent" />
            </div>
            <span className="font-semibold text-sm text-primary truncate">EKC SmartFactory</span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
