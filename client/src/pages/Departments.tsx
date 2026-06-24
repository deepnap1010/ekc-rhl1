// client/src/pages/Departments.tsx
// EKC org / RBAC structure: Company → Plant → Department → Role → User.
// Every position is filled from the REAL users + machines in the database
// (read-only). Production is live; more departments plug in via lib/departments.ts.
import { useMemo, useState, useEffect, type ComponentType } from 'react';
import { useNavigate, useSearchParams, type NavigateFunction } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Building2, ChevronRight, ShieldCheck, Users, Cpu, KeyRound, CheckCircle2,
  ArrowDown, MapPin, Crown, type LucideProps,
} from 'lucide-react';
import { userApi, machineApi } from '../api/endpoints';
import { Spinner, Avatar } from '../components/ui';
import PageHeader from '../components/PageHeader';
import type { User, Machine } from '../types/api';
import {
  COMPANY, ORG_LEVELS, DEPARTMENTS,
  isSuperAdminUser, isPlantHead, usersForRole, machinesForKeywords, machineKey,
  type Department, type DeptRole,
} from '../lib/departments';

export default function Departments() {
  const navigate = useNavigate();

  const { data: usersData, isLoading } = useQuery({ queryKey: ['users', 'dept'], queryFn: () => userApi.list({ limit: 200 }).then((r) => r.data) });
  const { data: machinesData } = useQuery({ queryKey: ['machines', 'dept'], queryFn: () => machineApi.list({ limit: 200 }).then((r) => r.data) });

  const users = useMemo<User[]>(() => usersData || [], [usersData]);
  const machines = useMemo<Machine[]>(() => machinesData || [], [machinesData]);

  const superAdmins = users.filter(isSuperAdminUser);
  const plantHeads = users.filter(isPlantHead);
  const plants = useMemo(
    () => [...new Set(users.map((u) => u.plant).filter((p): p is string => !!p))],
    [users],
  );

  // Department tabs, with a ?dept= deep-link (e.g. from the Org Chart's dept node).
  const [searchParams] = useSearchParams();
  const deptParam = searchParams.get('dept');
  const [activeDept, setActiveDept] = useState<string>(
    DEPARTMENTS.some((d) => d.key === deptParam) ? (deptParam as string) : (DEPARTMENTS[0]?.key ?? ''),
  );
  useEffect(() => {
    if (deptParam && DEPARTMENTS.some((d) => d.key === deptParam)) setActiveDept(deptParam);
  }, [deptParam]);
  const activeDeptObj = DEPARTMENTS.find((d) => d.key === activeDept) || DEPARTMENTS[0];

  return (
    <div>
      <PageHeader title="Departments" subtitle="Company → Plant → Department → Role → User" />

      <div className="px-4 sm:px-6 pb-8 space-y-5 pt-5">
        {/* Company banner */}
        <div className="rounded-card bg-slate-900 text-white px-5 py-4 shadow-panel">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-11 h-11 rounded-lg bg-white/10 flex items-center justify-center shrink-0"><Building2 size={22} /></span>
              <div className="min-w-0">
                <h2 className="text-lg font-bold truncate">{COMPANY.name}</h2>
                <div className="text-xs text-white/55">Organization &amp; access structure</div>
              </div>
            </div>
            <div className="flex items-center gap-5">
              <Stat label="Departments" value={DEPARTMENTS.length} />
              <Stat label="Employees" value={users.length} />
              <Stat label="Plants" value={plants.length || '—'} />
              <Stat label="Machines" value={machines.length} />
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-3 flex-wrap">
            {ORG_LEVELS.map((l, i) => (
              <span key={l} className="flex items-center gap-1.5">
                <span className="text-[11px] bg-white/10 rounded px-2 py-0.5">{l}</span>
                {i < ORG_LEVELS.length - 1 && <ChevronRight size={12} className="text-white/40" />}
              </span>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="py-12"><Spinner label="Loading organization" /></div>
        ) : (
          <>
            {/* Leadership above departments */}
            <div className="grid sm:grid-cols-2 gap-4">
              <LeaderCard icon={Crown} accent="#0D9488" title="Super Admin" sub="Full access · bypasses all permissions" people={superAdmins} navigate={navigate} />
              <LeaderCard icon={ShieldCheck} accent="#7C3AED" title="Plant Head" sub="Heads the plant · departments report up to this role" people={plantHeads} navigate={navigate} />
            </div>

            {/* Plant context */}
            {plants.length > 0 && (
              <div className="panel p-3 flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs text-steel"><MapPin size={14} className="text-accent" /> Plants:</span>
                {plants.map((p) => <span key={p} className="pill bg-accent/10 text-accent">{p}</span>)}
              </div>
            )}

            {/* Department tabs — each department on its own page-like view */}
            <div className="panel p-1.5 flex flex-wrap gap-1">
              {DEPARTMENTS.map((d) => (
                <button key={d.key} onClick={() => setActiveDept(d.key)}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm transition-colors ${activeDept === d.key ? 'bg-accent/10 text-accent font-medium' : 'text-steel hover:bg-base hover:text-primary'}`}>
                  <span className="w-2 h-2 rounded-full" style={{ background: d.accent }} />
                  {d.name.replace(/\s*Department$/i, '')}
                </button>
              ))}
            </div>

            {/* Active department */}
            {activeDeptObj && (
              <DepartmentSection key={activeDeptObj.key} dept={activeDeptObj} users={users} machines={machines} navigate={navigate} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface DepartmentSectionProps {
  dept: Department;
  users: User[];
  machines: Machine[];
  navigate: NavigateFunction;
}

function DepartmentSection({ dept, users, machines, navigate }: DepartmentSectionProps) {
  return (
    <div className="panel overflow-hidden">
      {/* Department header */}
      <div className="px-5 py-4 border-b border-line flex items-center gap-3" style={{ borderLeft: `3px solid ${dept.accent}` }}>
        <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${dept.accent}18`, color: dept.accent }}><Users size={18} /></span>
        <div>
          <h3 className="font-semibold text-primary">{dept.name}</h3>
          <p className="text-xs text-steel">{dept.purpose}</p>
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Role hierarchy */}
        <div className="space-y-3">
          {dept.roles.map((role, i) => (
            <div key={role.key}>
              <RoleCard role={role} people={usersForRole(users, role)} accent={dept.accent} navigate={navigate} />
              {i < dept.roles.length - 1 && (
                <div className="flex justify-center py-1"><ArrowDown size={16} className="text-steel/40" /></div>
              )}
            </div>
          ))}
        </div>

        {/* Department machines */}
        {dept.machines.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Cpu size={15} className="text-accent" />
            <h4 className="font-semibold text-sm text-primary">{dept.machinesLabel || 'Machines'}</h4>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {dept.machines.map((station) => {
              const matched = machinesForKeywords(machines, station.match);
              return (
                <div key={station.label} className="rounded-lg border border-line bg-base p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm font-medium text-primary">{station.label}</span>
                    <span className="pill bg-line text-steel !text-[10px]">{matched.length}</span>
                  </div>
                  {matched.length ? (
                    <div className="flex flex-wrap gap-1">
                      {matched.map((m) => {
                        const id = machineKey(m);
                        return (
                          <button key={id} onClick={() => navigate(`/machines/${encodeURIComponent(id)}`)}
                            className="data text-[11px] bg-surface border border-line hover:border-accent/40 hover:text-accent rounded px-1.5 py-0.5 transition-colors">
                            {id.toUpperCase()}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="text-[11px] text-steel/60">No live machine mapped yet</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

interface RoleCardProps {
  role: DeptRole;
  people: User[];
  accent: string;
  navigate: NavigateFunction;
}

function RoleCard({ role, people, accent, navigate }: RoleCardProps) {
  return (
    <div className="rounded-xl border border-line bg-base p-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h4 className="font-semibold text-primary">{role.title}</h4>
        <span className="text-[11px] text-steel">Reports to <span className="font-medium text-primary">{role.reportsTo}</span></span>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mt-3">
        <div>
          <div className="flex items-center gap-1.5 mb-1.5"><KeyRound size={13} className="text-accent" /><span className="label">Access</span></div>
          <div className="flex flex-wrap gap-1">
            {role.access.map((a) => <span key={a} className="pill bg-accent/10 text-accent !text-[10px]">{a}</span>)}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-1.5 mb-1.5"><CheckCircle2 size={13} className="text-running" /><span className="label">Responsible For</span></div>
          <div className="flex flex-wrap gap-1">
            {role.responsibilities.map((r) => <span key={r} className="pill bg-running/10 text-running !text-[10px]">{r}</span>)}
          </div>
        </div>
      </div>

      {/* Real people in this role */}
      <div className="mt-3 pt-3 border-t border-line">
        <div className="flex items-center gap-1.5 mb-1.5"><Users size={13} className="text-steel" /><span className="label">People ({people.length})</span></div>
        {people.length ? (
          <div className="flex flex-wrap gap-1.5">
            {people.map((u) => (
              <button key={u.id} onClick={() => navigate(`/orgchart/${u.id}`)} title="View in org chart"
                className="group flex items-center gap-1.5 bg-surface border border-line hover:border-accent/40 rounded-full pl-1 pr-2 py-0.5 transition-colors">
                <Avatar src={u.avatar} name={u.name} size={20} color={accent} interactive={false} />
                <span className="text-xs text-primary group-hover:text-accent">{u.name}</span>
                {u.assignedMachines?.length ? <span className="text-[10px] text-steel inline-flex items-center gap-0.5"><Cpu size={10} />{u.assignedMachines.length}</span> : null}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-[11px] text-steel/60">No one assigned to this role yet.</span>
        )}
      </div>
    </div>
  );
}

interface LeaderCardProps {
  icon: ComponentType<LucideProps>;
  accent: string;
  title: string;
  sub: string;
  people: User[];
  navigate: NavigateFunction;
}

function LeaderCard({ icon: Icon, accent, title, sub, people, navigate }: LeaderCardProps) {
  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2.5 mb-3">
        <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${accent}18`, color: accent }}><Icon size={18} /></span>
        <div className="min-w-0">
          <h3 className="font-semibold text-sm text-primary">{title}</h3>
          <p className="text-[11px] text-steel truncate">{sub}</p>
        </div>
        <span className="pill bg-line text-steel ml-auto">{people.length}</span>
      </div>
      {people.length ? (
        <div className="flex flex-wrap gap-1.5">
          {people.map((u) => (
            <button key={u.id} onClick={() => navigate(`/orgchart/${u.id}`)} title="View in org chart"
              className="group flex items-center gap-1.5 bg-base border border-line hover:border-accent/40 rounded-full pl-1 pr-2 py-0.5 transition-colors">
              <Avatar src={u.avatar} name={u.name} size={20} color={accent} interactive={false} />
              <span className="text-xs text-primary group-hover:text-accent">{u.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <span className="text-[11px] text-steel/60">No one in this role yet.</span>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wider text-white/45">{label}</div>
      <div className="data text-lg font-bold">{value}</div>
    </div>
  );
}
