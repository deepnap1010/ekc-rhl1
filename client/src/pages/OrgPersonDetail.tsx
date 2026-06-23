// client/src/pages/OrgPersonDetail.tsx
// "View details" page for one person in the org chart: their whole reporting
// subtree, every machine across that team and who it's assigned to, and one search
// box filtering both. Built only from data we already have (orgchart + machines).
import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Search, Users, Cpu, Eye, Building2, GitBranch } from 'lucide-react';
import { userApi, machineApi } from '../api/endpoints';
import { Spinner, StatCard, StatusPill } from '../components/ui';
import Modal from '../components/Modal';
import { prettyType } from '../lib/format';
import { roleStyle } from '../lib/orgRole';
import type { User } from '../types/api';

const sortFn = (a: User, b: User) => roleStyle(a).rank - roleStyle(b).rank || a.name.localeCompare(b.name);

interface MachineInfo { label: string; type?: string; status?: string; plant?: string }
interface MachineOwner { id: string; name: string; color: string; role: string }
interface MachineRow { rawId: string; label: string; type?: string; status?: string; plant?: string; owners: MachineOwner[] }

export default function OrgPersonDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [machineModal, setMachineModal] = useState<MachineRow | null>(null);

  const { data: people, isLoading } = useQuery({
    queryKey: ['orgchart'],
    queryFn: () => userApi.orgchart().then((r) => r.data),
  });
  const { data: machineList } = useQuery({
    queryKey: ['machines', 'orgchart'],
    queryFn: () => machineApi.list({ limit: 200 }).then((r) => r.data),
  });

  const users = useMemo<User[]>(() => people || [], [people]);

  const machineMap = useMemo(() => {
    const m = new Map<string, MachineInfo>();
    (machineList || []).forEach((mc) => {
      const mid = mc.machineId || mc.code || mc._id;
      if (mid) m.set(mid, { label: mc.machineId || mc.code || mc.name || mid, type: mc.type || mc.machineType, status: mc.status, plant: mc.plant?.name });
    });
    return m;
  }, [machineList]);

  const { person, manager, teamFlat, directReports } = useMemo(() => {
    const byId = new Map(users.map((u) => [u.id, u]));
    const kids = new Map<string, User[]>();
    users.forEach((u) => {
      if (!u.reportsTo || !byId.has(u.reportsTo)) return;
      const arr = kids.get(u.reportsTo) || [];
      arr.push(u);
      kids.set(u.reportsTo, arr);
    });
    const p = (id && byId.get(id)) || null;
    const flat: { user: User; depth: number }[] = [];
    const build = (pid: string, depth: number): void => {
      (kids.get(pid) || []).slice().sort(sortFn).forEach((c) => {
        flat.push({ user: c, depth });
        build(c.id, depth + 1);
      });
    };
    if (p) build(p.id, 0);
    return {
      person: p,
      manager: p?.reportsTo ? byId.get(p.reportsTo) || null : null,
      teamFlat: flat,
      directReports: p ? (kids.get(p.id) || []).length : 0,
    };
  }, [users, id]);

  // One row per machine; a machine assigned to several people lists all of them.
  const machineRows = useMemo<MachineRow[]>(() => {
    if (!person) return [];
    const scope = [person, ...teamFlat.map((t) => t.user)];
    const byMachine = new Map<string, MachineRow>();
    scope.forEach((u) => {
      const rs = roleStyle(u);
      (u.assignedMachines || []).forEach((mid) => {
        const info = machineMap.get(mid);
        const row = byMachine.get(mid) || { rawId: mid, label: info?.label || mid, type: info?.type, status: info?.status, plant: info?.plant, owners: [] };
        if (!row.owners.some((o) => o.id === u.id)) row.owners.push({ id: u.id, name: u.name, color: rs.color, role: rs.label });
        byMachine.set(mid, row);
      });
    });
    return [...byMachine.values()];
  }, [person, teamFlat, machineMap]);

  const q = search.trim().toLowerCase();
  const teamView = q
    ? teamFlat.filter(({ user: u }) => `${u.name} ${u.role?.name || ''} ${u.plant || ''}`.toLowerCase().includes(q))
    : teamFlat;
  const machineView = q
    ? machineRows.filter((r) => `${r.label} ${r.type || ''} ${r.status || ''} ${r.plant || ''} ${r.owners.map((o) => o.name).join(' ')}`.toLowerCase().includes(q))
    : machineRows;

  if (isLoading) return <div className="flex items-center justify-center h-64"><Spinner label="Loading details" /></div>;

  if (!person) return (
    <div className="px-4 sm:px-6 py-10">
      <button onClick={() => navigate('/orgchart')} className="flex items-center gap-1.5 text-steel hover:text-primary text-sm mb-6">
        <ArrowLeft size={16} /> Org Chart
      </button>
      <div className="panel p-10 text-center text-steel">Person not found.</div>
    </div>
  );

  const rs = roleStyle(person);

  return (
    <div>
      <div className="sticky top-0 z-10 bg-surface/95 backdrop-blur border-b border-line px-4 sm:px-6 py-4">
        <button onClick={() => navigate('/orgchart')} className="flex items-center gap-1.5 text-steel hover:text-primary text-sm mb-3 transition-colors">
          <ArrowLeft size={16} /> Org Chart
        </button>
        <div className="flex items-center gap-3">
          <span className="w-12 h-12 rounded-full flex items-center justify-center text-sm font-semibold shrink-0" style={{ backgroundColor: `${rs.color}22`, color: rs.color }}>
            {person.name.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-primary truncate">{person.name}</h1>
            <p className="text-xs" style={{ color: rs.color }}>
              <span className="font-medium">{rs.label}</span>
              {person.plant ? <span className="text-steel"> · {person.plant}</span> : null}
              {manager ? <span className="text-steel"> · reports to {manager.name}</span> : null}
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 pb-8 pt-5 space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <StatCard label="Team size"      value={teamFlat.length}    sub="people under them" accent="#7C3AED" icon={Users} />
          <StatCard label="Direct reports" value={directReports}      sub="report to them directly" accent="#0D9488" icon={GitBranch} />
          <StatCard label="Machines"       value={machineRows.length} sub="across the team" accent="#D97706" icon={Cpu} />
        </div>

        <div className="panel p-3">
          <div className="flex items-center gap-2 bg-base border border-line rounded-lg px-3 py-2">
            <Search size={15} className="text-steel" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, role, machine or plant…"
              className="bg-transparent outline-none text-sm flex-1 text-primary placeholder:text-steel/60"
            />
          </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-5 items-start">
          <div className="panel p-4">
            <div className="flex items-center gap-2 mb-3">
              <Users size={15} className="text-accent" />
              <h2 className="font-semibold text-sm text-primary">Team — who reports up to {person.name}</h2>
              <span className="text-xs text-steel ml-auto">{teamView.length}</span>
            </div>
            {teamView.length === 0 ? (
              <div className="py-8 text-center text-steel text-sm">{q ? 'No team members match.' : 'No one reports to this person.'}</div>
            ) : (
              <div className="space-y-0.5">
                {teamView.map(({ user: u, depth }) => {
                  const urs = roleStyle(u);
                  const mc = u.assignedMachines?.length || 0;
                  return (
                    <div key={u.id} className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-base/70" style={{ marginLeft: q ? 0 : depth * 18 }}>
                      <span className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0" style={{ backgroundColor: `${urs.color}22`, color: urs.color }}>
                        {u.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-primary truncate">{u.name}</div>
                        <div className="text-[11px] truncate" style={{ color: urs.color }}>
                          {urs.label}{u.plant ? <span className="text-steel"> · {u.plant}</span> : null}
                        </div>
                      </div>
                      {mc > 0 && (
                        <span className="hidden sm:flex items-center gap-1 text-[11px] text-steel shrink-0"><Cpu size={11} /> {mc}</span>
                      )}
                      <button onClick={() => navigate(`/orgchart/${u.id}`)} title="View details" className="p-1.5 rounded-md text-steel hover:text-accent hover:bg-accent/10 shrink-0">
                        <Eye size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="panel p-4">
            <div className="flex items-center gap-2 mb-3">
              <Cpu size={15} className="text-accent" />
              <h2 className="font-semibold text-sm text-primary">Machines in {person.name}'s org</h2>
              <span className="text-xs text-steel ml-auto">{machineView.length}</span>
            </div>
            {machineView.length === 0 ? (
              <div className="py-8 text-center text-steel text-sm">{q ? 'No machines match.' : 'No machines assigned in this team.'}</div>
            ) : (
              <div className="divide-y divide-line">
                {machineView.map((r) => (
                  <div key={r.rawId} className="flex items-center gap-3 py-2.5">
                    <span className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0"><Cpu size={15} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="data text-sm text-primary font-medium">{r.label}</span>
                        {r.type && <span className="text-[11px] text-steel">{prettyType(r.type)}</span>}
                        {r.status && <StatusPill status={r.status} />}
                      </div>
                      <div className="text-[11px] text-steel flex items-center gap-2 mt-0.5">
                        <span>Assigned to <span className="font-medium text-primary">{r.owners.length}</span> employee{r.owners.length > 1 ? 's' : ''}</span>
                        {r.plant && <span className="flex items-center gap-0.5"><Building2 size={10} /> {r.plant}</span>}
                      </div>
                    </div>
                    <button onClick={() => setMachineModal(r)} title="See who it's assigned to" className="p-1.5 rounded-md text-steel hover:text-accent hover:bg-accent/10 shrink-0">
                      <Eye size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {machineModal && (
        <Modal
          title={machineModal.label}
          subtitle={`${machineModal.type ? prettyType(machineModal.type) : 'Machine'} · assigned to ${machineModal.owners.length} employee${machineModal.owners.length > 1 ? 's' : ''}`}
          icon={Cpu}
          onClose={() => setMachineModal(null)}
          maxW="max-w-md"
        >
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-sm">
              {machineModal.status && <StatusPill status={machineModal.status} />}
              {machineModal.plant && <span className="text-steel flex items-center gap-1"><Building2 size={12} /> {machineModal.plant}</span>}
            </div>
            <div>
              <div className="label mb-1.5">Assigned to ({machineModal.owners.length})</div>
              <div className="divide-y divide-line">
                {machineModal.owners.map((o) => (
                  <button key={o.id} onClick={() => { setMachineModal(null); navigate(`/orgchart/${o.id}`); }}
                    className="w-full flex items-center gap-2.5 py-2 px-1 text-left hover:bg-base/60 rounded-lg transition-colors">
                    <span className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0" style={{ background: `${o.color}22`, color: o.color }}>
                      {o.name.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-primary truncate">{o.name}</div>
                      <div className="text-[11px] truncate" style={{ color: o.color }}>{o.role}</div>
                    </div>
                    <Eye size={13} className="text-steel/50 shrink-0" />
                  </button>
                ))}
              </div>
            </div>
            <button onClick={() => { const mid = machineModal.rawId; setMachineModal(null); navigate(`/machines/${encodeURIComponent(mid)}`); }}
              className="w-full flex items-center justify-center gap-1.5 text-sm text-accent border border-accent/20 bg-accent/5 hover:bg-accent/10 rounded-lg py-2 font-medium transition-colors">
              <Cpu size={14} /> Open machine
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
