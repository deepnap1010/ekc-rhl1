// client/src/pages/OrgChart.tsx
// Interactive reporting structure built entirely from data we already have:
//   • the org tree is derived from each user's `reportsTo`
//   • reassigning a manager reuses PATCH /users/:id (same write the Employee form does)
import { useMemo, useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ChevronDown, Pencil, Search, Users, Cpu, X, GitBranch, Eye, Building2 } from 'lucide-react';
import { userApi } from '../api/endpoints';
import { Spinner, Avatar } from '../components/ui';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/auth';
import { roleStyle } from '../lib/orgRole';
import { classifyRoleGroup, allRoleDepartments, type DeptKey } from '../lib/departments';
import type { User } from '../types/api';

// A department badge derived from a person's role, used to group the tree.
interface DeptBadge { key: DeptKey; name: string; fullName: string; accent: string; }

// Department a person belongs to, derived from their role (Production / Quality /
// Maintenance / Safety). Plant Head & Super Admin sit above departments → null.
function deptOf(u: User): DeptBadge | null {
  const g = classifyRoleGroup({ key: u.role?.key, name: u.role?.name });
  const d = allRoleDepartments().find((x) => x.key === g);
  return d ? { key: d.key, name: d.name.replace(/\s*Department$/i, ''), fullName: d.name, accent: d.accent } : null;
}

interface DeptGroup { dept: DeptBadge; people: User[]; }

export default function OrgChart() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const canEdit = can('employees', 'update');

  const [search, setSearch] = useState('');
  // Collapsed by default: a node's children show only when its id is in the expanded set.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());        // expanded person nodes
  const [deptExpanded, setDeptExpanded] = useState<Set<string>>(new Set()); // expanded department group nodes
  const [editingId, setEditingId] = useState<string | null>(null);
  const seeded = useRef(false);

  const { data: people, isLoading } = useQuery({
    queryKey: ['orgchart'],
    queryFn: () => userApi.orgchart().then((r) => r.data),
  });
  const users = useMemo<User[]>(() => people || [], [people]);

  const { childrenOf, roots } = useMemo(() => {
    const byId = new Map(users.map((u) => [u.id, u]));
    const kids = new Map<string, User[]>();
    const ROOT = '__root__';
    users.forEach((u) => {
      const pid = u.reportsTo && byId.has(u.reportsTo) ? u.reportsTo : ROOT;
      const arr = kids.get(pid) || [];
      arr.push(u);
      kids.set(pid, arr);
    });
    const sortFn = (a: User, b: User) => roleStyle(a).rank - roleStyle(b).rank || a.name.localeCompare(b.name);
    kids.forEach((arr) => arr.sort(sortFn));
    return { childrenOf: kids, roots: (kids.get(ROOT) || []).slice().sort(sortFn) };
  }, [users]);

  // Collapsed by default: once data lands, seed the roots + their direct reports as
  // expanded so the top of the org is visible, and the user drills down one level at
  // a time from there (deeper nodes and all department groups start collapsed).
  useEffect(() => {
    if (!seeded.current && roots.length) {
      const seed = new Set<string>();
      roots.forEach((r) => {
        seed.add(r.id);
        (childrenOf.get(r.id) || []).forEach((c) => seed.add(c.id));
      });
      setExpanded(seed);
      seeded.current = true;
    }
  }, [roots, childrenOf]);

  const descendants = (id: string): Set<string> => {
    const out = new Set<string>();
    const stack = [...(childrenOf.get(id) || [])];
    while (stack.length) {
      const c = stack.pop() as User;
      if (out.has(c.id)) continue;
      out.add(c.id);
      stack.push(...(childrenOf.get(c.id) || []));
    }
    return out;
  };

  const managerOptions = (u: User): User[] => {
    const blocked = descendants(u.id);
    blocked.add(u.id);
    return users.filter((x) => !blocked.has(x.id)).sort((a, b) => a.name.localeCompare(b.name));
  };

  const q = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const vis = new Set<string>();
    if (!q) return vis;
    const matches = (u: User) => `${u.name} ${u.role?.name || ''} ${u.role?.key || ''} ${u.plant || ''}`.toLowerCase().includes(q);
    const walk = (u: User): boolean => {
      let childHit = false;
      (childrenOf.get(u.id) || []).forEach((c) => { if (walk(c)) childHit = true; });
      const hit = matches(u) || childHit;
      if (hit) vis.add(u.id);
      return hit;
    };
    roots.forEach(walk);
    return vis;
  }, [q, childrenOf, roots]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const reassign = useMutation({
    mutationFn: ({ id, reportsTo }: { id: string; reportsTo: string | null }) => userApi.update(id, { reportsTo }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orgchart'] }),
    onError: (e: unknown) => window.alert((e as { message?: string })?.message || 'Could not update reporting line'),
  });

  const toggleDept = (id: string) =>
    setDeptExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // Every expandable id in the tree (mirrors the render's dept-grouping), so
  // "Expand all" opens people AND department nodes in one shot.
  const allExpandable = useMemo(() => {
    const personIds = new Set<string>();
    const deptIds = new Set<string>();
    function person(u: User, currentDeptKey: DeptKey | null): void {
      if ((childrenOf.get(u.id) || []).length) personIds.add(u.id);
      forest(childrenOf.get(u.id) || [], deptOf(u)?.key ?? currentDeptKey, u.id);
    }
    function forest(list: User[], currentDeptKey: DeptKey | null, parentId: string): void {
      const direct: User[] = [];
      const groups = new Map<string, DeptGroup>();
      list.forEach((p) => {
        const d = deptOf(p);
        if (d && d.key !== currentDeptKey) {
          const grp = groups.get(d.key) || { dept: d, people: [] };
          grp.people.push(p); groups.set(d.key, grp);
        } else direct.push(p);
      });
      direct.forEach((p) => person(p, currentDeptKey));
      groups.forEach((grp) => {
        deptIds.add(`${parentId}::${grp.dept.key}`);
        grp.people.forEach((p) => person(p, grp.dept.key));
      });
    }
    forest(roots, null, '__root__');
    return { personIds, deptIds };
  }, [roots, childrenOf]);

  const expandAll = () => { setExpanded(new Set(allExpandable.personIds)); setDeptExpanded(new Set(allExpandable.deptIds)); };
  const collapseAll = () => { setExpanded(new Set()); setDeptExpanded(new Set()); };

  // Department display order (Production → Quality → Maintenance → Safety → custom).
  const deptOrder = allRoleDepartments().map((d) => d.key);

  // A person + all their reports — for a department headcount.
  const subtreeCount = (u: User): number => 1 + descendants(u.id).size;

  // Render a list of people; insert a "<Department>" node whenever we cross from the
  // current department context into a different one (e.g. Plant Head → Production).
  const renderForest = (list: User[], currentDeptKey: DeptKey | null, parentId: string): (JSX.Element | null)[] => {
    if (q) return list.filter((p) => visible.has(p.id)).map((p) => renderPerson(p, currentDeptKey));
    const direct: User[] = [];
    const groups = new Map<string, DeptGroup>();
    list.forEach((p) => {
      const d = deptOf(p);
      if (d && d.key !== currentDeptKey) {
        const g = groups.get(d.key) || { dept: d, people: [] };
        g.people.push(p);
        groups.set(d.key, g);
      } else {
        direct.push(p);
      }
    });
    return [
      ...direct.map((p) => renderPerson(p, currentDeptKey)),
      ...[...groups.values()]
        .sort((a, b) => deptOrder.indexOf(a.dept.key) - deptOrder.indexOf(b.dept.key))
        .map((g) => renderDeptNode(g, parentId)),
    ];
  };

  const renderDeptNode = (g: DeptGroup, parentId: string): JSX.Element => {
    const id = `${parentId}::${g.dept.key}`;
    const open = deptExpanded.has(id);
    const headcount = g.people.reduce((n, p) => n + subtreeCount(p), 0);
    return (
      <div key={id}>
        <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-base/70 transition-colors">
          <button onClick={() => toggleDept(id)} className="w-5 h-5 flex items-center justify-center text-steel shrink-0 hover:text-primary">
            {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${g.dept.accent}1f`, color: g.dept.accent }}>
            <Building2 size={16} />
          </span>
          <div className="min-w-0 flex-1 cursor-pointer" onClick={() => toggleDept(id)}>
            <div className="text-sm font-semibold truncate" style={{ color: g.dept.accent }}>{g.dept.fullName}</div>
            <div className="text-[11px] text-steel">{headcount} {headcount === 1 ? 'person' : 'people'}</div>
          </div>
          <button onClick={() => navigate(`/departments?dept=${g.dept.key}`)} title="Open department" className="p-1.5 rounded-md text-steel hover:text-accent hover:bg-accent/10 shrink-0">
            <Eye size={14} />
          </button>
        </div>
        {open && (
          <div className="ml-5 pl-4 border-l" style={{ borderColor: `${g.dept.accent}40` }}>
            {g.people.map((p) => renderPerson(p, g.dept.key))}
          </div>
        )}
      </div>
    );
  };

  const renderPerson = (u: User, currentDeptKey: DeptKey | null): JSX.Element | null => {
    if (q && !visible.has(u.id)) return null;
    const kids = (childrenOf.get(u.id) || []).filter((c) => !q || visible.has(c.id));
    const childDeptKey = deptOf(u)?.key ?? currentDeptKey;
    const hasKids = kids.length > 0;
    const open = q ? true : expanded.has(u.id);
    const rs = roleStyle(u);
    const machineCount = u.assignedMachines?.length || 0;
    const isEditing = editingId === u.id;
    const editable = canEdit && !u.isSuperAdmin; // Super Admin reports to no one

    return (
      <div key={u.id}>
        <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-base/70 transition-colors">
          <button onClick={() => hasKids && toggle(u.id)} className={`w-5 h-5 flex items-center justify-center text-steel shrink-0 ${hasKids ? 'hover:text-primary' : 'opacity-0 pointer-events-none'}`}>
            {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>

          <Avatar src={u.avatar} name={u.name} size={32} color={rs.color} />

          <div className="min-w-0 flex-1 cursor-pointer" onClick={() => hasKids && toggle(u.id)}>
            <div className="text-sm font-medium text-primary truncate">{u.name}</div>
            <div className="text-[11px] font-medium truncate" style={{ color: rs.color }}>
              {rs.label}{u.plant ? <span className="text-steel font-normal"> · {u.plant}</span> : null}
            </div>
          </div>

          {hasKids ? (
            <span className="hidden sm:flex items-center gap-1 text-[11px] text-steel bg-base border border-line rounded-full px-2 py-0.5 shrink-0">
              <Users size={11} /> {kids.length} report{kids.length > 1 ? 's' : ''}
            </span>
          ) : machineCount ? (
            <span className="hidden sm:flex items-center gap-1 text-[11px] text-steel bg-base border border-line rounded-full px-2 py-0.5 shrink-0">
              <Cpu size={11} /> {machineCount} machine{machineCount > 1 ? 's' : ''}
            </span>
          ) : null}

          <button onClick={() => navigate(`/orgchart/${u.id}`)} title="View details" className="p-1.5 rounded-md text-steel hover:text-accent hover:bg-accent/10 shrink-0">
            <Eye size={14} />
          </button>

          {editable && (
            <button onClick={() => setEditingId(isEditing ? null : u.id)} title="Change who this person reports to" className="p-1.5 rounded-md text-steel hover:text-accent hover:bg-accent/10 shrink-0">
              {isEditing ? <X size={14} /> : <Pencil size={14} />}
            </button>
          )}
        </div>

        {isEditing && editable && (
          <div className="flex items-center gap-2 ml-[3.25rem] mb-1.5 text-xs text-steel">
            Reports to
            <select
              className="bg-base border border-line rounded-lg px-2 py-1.5 text-sm text-primary outline-none focus:border-accent min-w-[200px]"
              defaultValue={u.reportsTo || ''}
              disabled={reassign.isPending}
              onChange={(e) => { reassign.mutate({ id: u.id, reportsTo: e.target.value || null }); setEditingId(null); }}
            >
              <option value="">— no manager —</option>
              {managerOptions(u).map((m) => (
                <option key={m.id} value={m.id}>{m.name}{m.role?.name ? ` · ${m.role.name}` : ''}</option>
              ))}
            </select>
          </div>
        )}

        {open && hasKids && (
          <div className="ml-5 pl-4 border-l border-line">
            {renderForest(kids, childDeptKey, u.id)}
          </div>
        )}
      </div>
    );
  };

  const visibleRoots = q ? roots.filter((r) => visible.has(r.id)) : roots;

  return (
    <div>
      <PageHeader title="Org Chart" subtitle="Reporting structure" />

      <div className="px-4 sm:px-6 pb-8 space-y-4 pt-5">
        <div className="panel p-3 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2 bg-base border border-line rounded-lg px-3 py-2 flex-1 min-w-[220px]">
            <Search size={15} className="text-steel" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search a person by name, role or plant…"
              className="bg-transparent outline-none text-sm flex-1 text-primary placeholder:text-steel/60"
            />
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={expandAll} className="text-xs text-steel hover:text-primary border border-line rounded-lg px-2.5 py-2 hover:bg-base transition-colors">Expand all</button>
            <button onClick={collapseAll} className="text-xs text-steel hover:text-primary border border-line rounded-lg px-2.5 py-2 hover:bg-base transition-colors">Collapse all</button>
          </div>
          <p className="text-xs text-steel sm:max-w-xs">
            {canEdit ? (
              <>Click a person to expand their team. Viewing as <span className="text-primary font-medium">{me?.name || '—'}</span>. Use <Pencil size={11} className="inline -mt-0.5" /> to change who someone reports to.</>
            ) : (
              <>Click a person to expand their team. Viewing as <span className="text-primary font-medium">{me?.name || '—'}</span>.</>
            )}
          </p>
        </div>

        {isLoading ? (
          <div className="py-12"><Spinner label="Loading org chart" /></div>
        ) : (
          <div className="panel p-3">
            {visibleRoots.length === 0 ? (
              <div className="py-12 text-center text-steel text-sm flex flex-col items-center gap-2">
                <GitBranch size={22} className="text-steel/50" />
                {q ? 'No one matches your search.' : 'No employees to chart yet.'}
              </div>
            ) : (
              renderForest(visibleRoots, null, '__root__')
            )}
          </div>
        )}
      </div>
    </div>
  );
}
