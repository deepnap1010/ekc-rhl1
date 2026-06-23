// client/src/layouts/AppLayout.tsx
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutGrid, Cpu, History, Clock, FileBarChart, Bell,
  Users, ShieldCheck, Network, LogOut, Gauge, Building2,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '../store/auth';
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

  const allowed = NAV.filter((n) => can(n.module));
  const sections = [...new Set(allowed.map((n) => n.section))];

  const handleLogout = () => {
    disconnectSocket();
    logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-base">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 bg-surface border-r border-line flex flex-col shadow-sm">
        {/* Brand */}
        <div className="px-5 py-4 flex items-center gap-2.5 border-b border-line">
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center">
            <Gauge size={20} className="text-accent" />
          </div>
          <div>
            <div className="font-semibold text-sm leading-tight text-primary">EKC SmartFactory</div>
            <div className="text-[10px] text-steel">Production Monitor</div>
          </div>
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
            <div className="w-8 h-8 rounded-full bg-accent/15 text-accent flex items-center justify-center text-xs font-semibold">
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

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
