// client/src/pages/Roles.tsx
import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Plus, Lock, LockOpen, Crown, ChevronDown, ChevronRight, Sparkles, Building2, X, ShieldCheck, Pencil, Trash2, Check } from 'lucide-react';
import { rbacApi, authApi } from '../api/endpoints';
import { Spinner } from '../components/ui';
import Modal from '../components/Modal';
import PageHeader from '../components/PageHeader';
import { prettyKey } from '../lib/format';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import { useAppConfig } from '../hooks/useAppConfig';
import {
  classifyRoleGroup, DEFAULT_ROLE_TEMPLATES, displayRoleName,
  useRoleDepartments, takeLocalDepartments, forgetLocalDepartments, type RoleDepartment,
} from '../lib/departments';
import type { PermissionMatrix, Role } from '../types/api';

// Local working copy of a role's permission matrix: module -> set of actions.
type PermissionDraft = Record<string, Set<string>>;

// Super Admin starts locked so nobody strips their own access with a stray click,
// but the lock opens — its matrix has to be editable, or the role that grants every
// permission is the one role whose permissions can never be set. Deleting it stays
// impossible (the server refuses).
const isProtected = (r?: Role | null): boolean => {
  const s = `${r?.key || ''} ${r?.name || ''}`.toLowerCase();
  return s.includes('super') && s.includes('admin');
};

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const deptKeyOf = (name: string): string => slug(name.replace(/\s*department\s*$/i, '')).slice(0, 40);

export default function Roles() {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PermissionDraft>({}); // module -> Set(actions)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['production'])); // open departments
  const [creating, setCreating] = useState<null | { department: string }>(null);   // New role modal (+ the department it opens from)
  const [editing, setEditing] = useState(false);          // Edit role modal (name / description / department)
  const [addingDept, setAddingDept] = useState(false);    // Add department modal
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);   // inline department rename
  const canEdit = can('roles', 'update');                  // permission to edit roles at all
  const canCreate = can('roles', 'create');
  const canDelete = can('roles', 'delete');
  // The plant's departments — server-owned, same list on every screen.
  const roleDepartments = useRoleDepartments();
  const deptSig = roleDepartments.map((d) => `${d.key}:${d.name}`).join('|'); // stable memo signal

  const { data: meta } = useQuery({ queryKey: ['rbac', 'meta'], queryFn: () => rbacApi.meta().then((r) => r.data) });
  const { data: roles, isLoading } = useQuery({ queryKey: ['roles'], queryFn: () => rbacApi.roles().then((r) => r.data) });

  const selected = roles?.find((r) => r._id === selectedId) || roles?.[0];
  const [unlocked, setUnlocked] = useState(false);         // Super Admin's lock, opened by hand
  const protectedRole = !!selected && isProtected(selected);
  const locked = protectedRole && !unlocked;
  const editable = canEdit && !locked;                     // every other role edits directly

  // Group roles into the org tree: Super Admin → Plant Head → Departments → Other.
  const grouped = useMemo(() => {
    const g: Record<string, Role[]> = {};
    (roles || []).forEach((r) => { const k = classifyRoleGroup(r); (g[k] = g[k] || []).push(r); });
    return g;
  }, [roles, deptSig]);
  const selectedGroup = selected ? classifyRoleGroup(selected) : null;
  const isOpen = (key: string) => expanded.has(key) || selectedGroup === key; // keep the selected role's dept open
  const toggleGroup = (key: string) => setExpanded((prev) => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  useEffect(() => {
    if (selected) {
      const d: PermissionDraft = {};
      Object.entries(selected.permissions || {}).forEach(([m, acts]) => { d[m] = new Set(acts); });
      setDraft(d);
      setSelectedId(selected._id);
      setUnlocked(false);   // never leave the lock open behind you
    }
  }, [selected?._id]);

  // Every department edit is applied to the plant's LIVE list, fetched at
  // that moment — never to this screen's copy, which may be a minute old or
  // the built-in fallback, and a stale whole-list save would silently drop a
  // department another desk just added (and unplace its roles). Every screen
  // that groups roles reads the result back from the shared config.
  type DeptRow = Pick<RoleDepartment, 'key' | 'name' | 'accent'>;
  const saveDepts = async (edit: (live: DeptRow[]) => DeptRow[]): Promise<void> => {
    const live = (await rbacApi.departments()).data;
    await rbacApi.updateDepartments(edit(live).map((d) => ({ key: d.key, name: d.name, accent: d.accent })));
    await qc.invalidateQueries({ queryKey: ['app-config'] });
    await qc.invalidateQueries({ queryKey: ['roles'] });   // a removed department unplaces its roles
  };
  // Departments an earlier build kept on this device only: moved to the plant's
  // list once, so they finally exist for everyone, then forgotten here — also
  // when the plant refuses them (the admin is told), or every visit would retry.
  const { departments: plantList } = useAppConfig();
  const deptsReady = !!plantList?.length;
  useEffect(() => {
    if (!canEdit || !deptsReady) return;
    const local = takeLocalDepartments();
    if (!local.length) return;
    saveDepts((live) => [...live, ...local.filter((d) => !live.some((x) => x.key === d.key || x.name.toLowerCase() === d.name.toLowerCase()))])
      .then(() => toast.success(`Moved ${local.length} department${local.length > 1 ? 's' : ''} from this device to the plant's list`))
      .catch((e: unknown) => toast.error(`This device's old departments could not be moved to the plant: ${e instanceof Error ? e.message : 'rejected'}`))
      .finally(() => forgetLocalDepartments());
  }, [canEdit, deptsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const renameDept = async (): Promise<void> => {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) { setRenaming(null); return; }
    try {
      await saveDepts((live) => live.map((d) => (d.key === renaming.key ? { ...d, name } : d)));
      toast.success('Department renamed');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not rename'); }
    setRenaming(null);
  };
  const removeDept = async (d: RoleDepartment): Promise<void> => {
    // Only roles the admin PLACED here are affected; roles filed here by their
    // names are filed the same way again.
    const placed = (roles || []).filter((r) => (r.department || '') === d.key).length;
    if (!window.confirm(`Remove the "${d.name}" department?${placed ? ` Its ${placed} placed role${placed > 1 ? 's' : ''} go back to being filed by name — Manager / Supervisor / Operator under Production, a department word under that department, anything else under Other.` : ''}`)) return;
    try {
      await saveDepts((live) => live.filter((x) => x.key !== d.key));
      toast.success(`${d.name} removed`);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not remove'); }
  };

  const saveMut = useMutation({
    mutationFn: () => {
      const perms: PermissionMatrix = {};
      Object.entries(draft).forEach(([m, set]) => { if (set.size) perms[m] = [...set]; });
      return rbacApi.updatePermissions(selected!._id, perms);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roles'] }); toast.success('Permissions saved'); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not save permissions'),
  });

  // Deleting a role detaches the people in it (they keep their accounts, with
  // no role until reassigned) and drops its notification rules.
  const deleteMut = useMutation({
    mutationFn: (id: string) => rbacApi.deleteRole(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roles'] }); qc.invalidateQueries({ queryKey: ['app-config'] }); setSelectedId(null); toast.success('Role deleted'); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not delete the role'),
  });
  const deleteRole = (r: Role): void => {
    if (!window.confirm(`Delete the "${displayRoleName(r)}" role? People in it keep their accounts but have no role until you assign another.`)) return;
    deleteMut.mutate(r._id);
  };

  // One-click: create the Quality / Maintenance / Safety department roles that don't
  // exist yet (via the normal /roles API). Idempotent — skips any already present.
  const missingTemplateCount = DEFAULT_ROLE_TEMPLATES.filter((t) => !(roles || []).some((r) => r.key === t.key)).length;
  const setupMut = useMutation({
    mutationFn: async () => {
      const existing = new Set((roles || []).map((r) => r.key));
      const todo = DEFAULT_ROLE_TEMPLATES.filter((t) => !existing.has(t.key));
      for (const t of todo) {
        await rbacApi.createRole({ name: t.name, key: t.key, description: t.description, permissions: t.permissions });
      }
      return todo.length;
    },
    onSuccess: (n) => { qc.invalidateQueries({ queryKey: ['roles'] }); toast.success(n ? `Created ${n} department role${n > 1 ? 's' : ''}` : 'All department roles already exist'); },
    onError: (e: unknown) => { qc.invalidateQueries({ queryKey: ['roles'] }); toast.error(e instanceof Error ? e.message : 'Could not create some roles'); },
  });

  // What each row is and what each tick allows comes with the grid's shape
  // (server utils/permissions). A strict row offers only the actions it
  // describes — the other boxes gate nothing, so they are not drawn.
  const allActions = meta?.actions || [];
  const catalog = useMemo(() => new Map((meta?.catalog || []).map((c) => [c.module, c])), [meta]);
  const offered = (m: string): string[] => {
    const c = catalog.get(m);
    return c?.strict ? allActions.filter((a) => a in c.actions) : allActions;
  };
  // A control row is used from its parent's screens: granting one grants the
  // parent's View with it, so the person can reach what they were given.
  const withParentView = (next: PermissionDraft, module: string): PermissionDraft => {
    const parent = catalog.get(module)?.parent;
    if (!parent || !next[module]?.size || next[parent]?.has('view')) return next;
    return { ...next, [parent]: new Set([...(next[parent] || []), 'view']) };
  };

  const toggle = (module: string, action: string) => {
    if (!editable) return;
    setDraft((prev) => {
      const next = { ...prev };
      const set = new Set(next[module] || []);
      const adding = !set.has(action);
      if (adding) set.add(action); else set.delete(action);
      next[module] = set;
      return adding ? withParentView(next, module) : next;
    });
  };

  // "All" column — toggle every action the row offers at once.
  const rowFull = (m: string) => { const acts = offered(m); return acts.length > 0 && acts.every((a) => draft[m]?.has(a)); };
  const toggleRow = (m: string) => {
    if (!editable) return;
    setDraft((prev) => (rowFull(m) ? { ...prev, [m]: new Set<string>() } : withParentView({ ...prev, [m]: new Set(offered(m)) }, m)));
  };
  // Control rows ticked while their parent's View is not: the role holds a
  // permission it cannot reach (the grid says so instead of hiding it).
  const unreachable = (meta?.catalog || []).filter((c) =>
    c.parent && (draft[c.module]?.size || 0) > 0 && !draft[c.parent]?.has('view') && !draft[c.parent]?.has('admin'));

  if (isLoading) return <div><PageHeader title="Roles & Permissions" /><Spinner /></div>;

  const deptName = (key?: string): string => roleDepartments.find((d) => d.key === (key || ''))?.name || '';

  return (
    <div>
      <PageHeader
        title="Roles & Permissions"
        subtitle="Dynamic RBAC — module access per role"
        right={canCreate && (
          <div className="flex items-center gap-2">
            {missingTemplateCount > 0 && (
              <button onClick={() => setupMut.mutate()} disabled={setupMut.isPending}
                className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg text-accent border border-accent/30 bg-accent/5 hover:bg-accent/10 disabled:opacity-60 transition-colors">
                <Sparkles size={15} /> {setupMut.isPending ? 'Creating…' : `Set up dept roles (${missingTemplateCount})`}
              </button>
            )}
            <button onClick={() => setCreating({ department: '' })} className="flex items-center gap-1.5 bg-accent text-white text-sm font-medium px-3 py-1.5 rounded-lg hover:bg-accent/90 transition-colors">
              <Plus size={15} /> New role
            </button>
          </div>
        )}
      />

      <div className="px-4 sm:px-6 pb-8 grid lg:grid-cols-[260px_1fr] gap-5">
        {/* Role tree — Super Admin → Plant Head → Departments → roles */}
        <div className="panel p-2 h-fit space-y-2">
          {/* Leadership */}
          {(grouped.super_admin?.length || grouped.plant_head?.length) ? (
            <div>
              <div className="label px-2 mb-1 flex items-center gap-1.5"><Crown size={12} className="text-accent" /> Leadership</div>
              {(grouped.super_admin || []).map((r) => <RoleItem key={r._id} role={r} selected={selected} onSelect={setSelectedId} />)}
              {(grouped.plant_head || []).map((r) => <RoleItem key={r._id} role={r} selected={selected} onSelect={setSelectedId} />)}
            </div>
          ) : null}

          {/* Departments — the plant's own list: rename, remove, add roles inside */}
          <div>
            <div className="label px-2 mb-1 flex items-center justify-between">
              <span>Departments</span>
              {canEdit && deptsReady && (
                <button onClick={() => setAddingDept(true)} title="Add department" className="text-steel hover:text-accent transition-colors">
                  <Plus size={13} />
                </button>
              )}
            </div>
            {roleDepartments.map((d) => {
              const deptRoles = grouped[d.key] || [];
              const open = isOpen(d.key);
              const isRenaming = renaming?.key === d.key;
              return (
                <div key={d.key} className="mb-0.5">
                  <div onClick={() => { if (!isRenaming) toggleGroup(d.key); }}
                    className="w-full flex items-center gap-1.5 px-2 py-2 rounded-lg hover:bg-line/50 text-left transition-colors cursor-pointer group/dept">
                    {open ? <ChevronDown size={14} className="text-steel shrink-0" /> : <ChevronRight size={14} className="text-steel shrink-0" />}
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: d.accent }} />
                    {isRenaming ? (
                      <span className="flex-1 flex items-center gap-1 min-w-0" onClick={(e) => e.stopPropagation()}>
                        <input value={renaming.name} autoFocus maxLength={60}
                          onChange={(e) => setRenaming({ key: d.key, name: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void renameDept(); } if (e.key === 'Escape') setRenaming(null); }}
                          className="input !py-1 !px-2 text-sm flex-1 min-w-0" />
                        <button onClick={() => void renameDept()} title="Save name" className="text-accent hover:text-accent/80 shrink-0"><Check size={14} /></button>
                        <button onClick={() => setRenaming(null)} title="Cancel" className="text-steel hover:text-primary shrink-0"><X size={14} /></button>
                      </span>
                    ) : (
                      <span className="text-sm font-medium text-primary flex-1 truncate">{d.name}</span>
                    )}
                    {!isRenaming && <span className="pill bg-line text-steel !text-[10px]">{deptRoles.length}</span>}
                    {!isRenaming && canEdit && deptsReady && (
                      <span className="flex items-center gap-1 opacity-0 group-hover/dept:opacity-100 transition-opacity shrink-0">
                        {canCreate && (
                          <button onClick={(e) => { e.stopPropagation(); setCreating({ department: d.key }); }} title={`Add a role to ${d.name}`}
                            className="text-steel hover:text-accent"><Plus size={13} /></button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); setRenaming({ key: d.key, name: d.name }); }} title="Rename department"
                          className="text-steel hover:text-accent"><Pencil size={12} /></button>
                        {roleDepartments.length > 1 && (
                          <button onClick={(e) => { e.stopPropagation(); void removeDept(d); }} title="Remove department"
                            className="text-steel hover:text-stopped"><X size={13} /></button>
                        )}
                      </span>
                    )}
                  </div>
                  {open && (
                    <div className="ml-3 pl-2 border-l border-line mt-0.5">
                      {deptRoles.length
                        ? deptRoles.map((r) => <RoleItem key={r._id} role={r} selected={selected} onSelect={setSelectedId} />)
                        : <div className="text-[11px] text-steel/60 px-2 py-1.5">No roles yet — hover the department for “+”.</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Other / unplaced roles */}
          {grouped.other?.length ? (
            <div>
              <div className="label px-2 mb-1" title="Roles no department claims — edit a role to place it">Other</div>
              {grouped.other.map((r) => <RoleItem key={r._id} role={r} selected={selected} onSelect={setSelectedId} />)}
            </div>
          ) : null}
        </div>

        {/* Permission matrix — min-w-0 lets this grid column shrink, so the
            table scrolls inside its own wrapper instead of widening the page. */}
        <div className="panel p-5 min-w-0">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="min-w-0">
              <h2 className="font-semibold flex items-center gap-2">
                <span className="truncate">{displayRoleName(selected)}</span>
                {selected?.isSystem && <span className="pill bg-line text-steel !text-[10px] shrink-0">System</span>}
                {selected && deptName(selected.department) && <span className="pill bg-accent/10 text-accent !text-[10px] shrink-0">{deptName(selected.department)}</span>}
              </h2>
              <p className="text-xs text-steel truncate">{selected?.description || 'No description'}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {selected && canEdit && (
                <button onClick={() => setEditing(true)} title="Rename, describe or move this role"
                  className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-line text-primary hover:bg-base transition-colors">
                  <Pencil size={14} /> Edit
                </button>
              )}
              {selected && canDelete && !protectedRole && (
                <button onClick={() => deleteRole(selected)} disabled={deleteMut.isPending} title="Delete this role"
                  className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-stopped/30 text-stopped hover:bg-stopped/5 disabled:opacity-60 transition-colors">
                  <Trash2 size={14} /> Delete
                </button>
              )}
              {editable && (
                <button
                  onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
                  className="flex items-center gap-1.5 bg-accent text-white text-sm font-medium px-3 py-1.5 rounded-lg disabled:opacity-60"
                >
                  <Save size={15} /> {saveMut.isPending ? 'Saving…' : 'Save permissions'}
                </button>
              )}
            </div>
          </div>

          {protectedRole ? (
            <div className={`text-xs rounded-lg px-3 py-2 mb-4 flex items-center gap-2 border ${
              locked ? 'text-steel bg-base border-line' : 'text-amber-700 bg-amber-50 border-amber-200'
            }`}>
              {locked ? <Lock size={12} className="shrink-0" /> : <LockOpen size={12} className="shrink-0" />}
              <span className="flex-1">
                {locked
                  ? 'Super Admin is locked — unlock to change what it can access. It can never be deleted.'
                  : 'Unlocked. Unticking a box here removes it from every Super Admin, including you.'}
              </span>
              {canEdit && (
                <button
                  onClick={() => setUnlocked((u) => !u)}
                  className="shrink-0 flex items-center gap-1 border border-line bg-surface rounded-md px-2 py-1 hover:bg-base"
                >
                  {locked ? <><LockOpen size={11} /> Unlock</> : <><Lock size={11} /> Lock</>}
                </button>
              )}
            </div>
          ) : !canEdit ? (
            <div className="text-xs text-steel bg-base border border-line rounded-lg px-3 py-2 mb-4">
              You don't have permission to edit roles — this view is read-only.
            </div>
          ) : null}

          {(meta?.catalog || []).length > 0 && (
            <p className="text-[11px] text-steel mb-3">
              Hover a box to see exactly what it allows. The rows under <span className="font-medium text-primary">Production</span> are
              its controls, each granted on its own — a role can schedule a dia without being able to edit its cycle times.
            </p>
          )}

          {unreachable.length > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              <span className="font-medium">{catalog.get(unreachable[0].parent || '')?.label || 'Production'} → View is not ticked.</span>{' '}
              This role holds {unreachable.map((c) => c.label).join(', ')} but cannot open the screens that use {unreachable.length === 1 ? 'it' : 'them'} —
              tick View, or untick {unreachable.length === 1 ? 'that row' : 'those rows'}.
            </div>
          )}

          <div className="overflow-x-auto">
            {/* table-fixed + equal-width action columns keep every tick on a clean vertical grid. */}
            <table className="w-full text-sm table-fixed min-w-[720px]">
              <thead>
                <tr className="text-steel border-b border-line">
                  <th className="text-left font-normal py-2 label w-56">Module</th>
                  {allActions.map((a) => (
                    <th key={a} className="font-normal py-2 label text-center px-1">{a}</th>
                  ))}
                  <th className="label text-center px-1 w-14">All</th>
                </tr>
              </thead>
              <tbody>
                {(meta?.modules || []).map((m) => {
                  const c = catalog.get(m);
                  const acts = offered(m);
                  return (
                  <tr key={m} className="border-t border-line hover:bg-base/40">
                    <td className={`py-2.5 pr-2 align-top ${c?.parent ? 'pl-4' : ''}`}>
                      <div className={`font-medium text-primary ${c?.parent ? 'text-[13px]' : ''}`}>{c?.label || prettyKey(m)}</div>
                      {c?.hint && <div className="text-[10px] text-steel leading-snug">{c.hint}</div>}
                    </td>
                    {allActions.map((a) => {
                      // A box this row does not offer gates nothing: leave the cell empty.
                      if (!acts.includes(a)) return <td key={a} className="text-center px-1 text-line select-none" aria-hidden>·</td>;
                      const on = draft[m]?.has(a);
                      return (
                        <td key={a} className="text-center px-1">
                          <button
                            onClick={() => toggle(m, a)}
                            disabled={!editable}
                            title={c?.actions?.[a] || undefined}
                            aria-label={`${c?.label || prettyKey(m)} — ${a}`}
                            className={`w-4 h-4 rounded border transition-colors inline-flex items-center justify-center ${
                              on ? 'bg-accent border-accent' : 'border-line hover:border-steel'
                            } ${!editable ? 'cursor-not-allowed' : ''}`}
                          >
                            {on && <span className="text-white text-[10px] leading-none">✓</span>}
                          </button>
                        </td>
                      );
                    })}
                    <td className="text-center px-1">
                      <button
                        onClick={() => toggleRow(m)} disabled={!editable} title="Toggle all actions"
                        className={`w-4 h-4 rounded border transition-colors inline-flex items-center justify-center ${
                          rowFull(m) ? 'bg-accent border-accent' : 'border-line hover:border-steel'
                        } ${!editable ? 'cursor-not-allowed' : ''}`}
                      >
                        {rowFull(m) && <span className="text-white text-[10px] leading-none">✓</span>}
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {creating && (
        <RoleModal departments={roleDepartments} department={creating.department} onClose={() => setCreating(null)}
          // Select the new role only once the list holds it — selecting
          // earlier lets the fallback-to-first effect overwrite the choice.
          onCreated={async (r) => { setCreating(null); await qc.invalidateQueries({ queryKey: ['roles'] }); if (r?._id) setSelectedId(r._id); }} />
      )}
      {editing && selected && (
        <EditRoleModal role={selected} departments={roleDepartments} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); qc.invalidateQueries({ queryKey: ['roles'] }); qc.invalidateQueries({ queryKey: ['app-config'] }); }} />
      )}
      {addingDept && (
        <AddDepartmentModal existingKeys={new Set((roles || []).map((r) => r.key))} saveDepts={saveDepts} onClose={() => setAddingDept(false)}
          onCreated={(key) => { setAddingDept(false); setExpanded((s) => { const n = new Set(s); n.add(key); return n; }); }} />
      )}
    </div>
  );
}

// One role row in the tree. Preserves the per-role lock/unlock affordance: the
// selected role shows lock (locked) or unlock (editing); other system roles show a lock.
function RoleItem({ role, selected, onSelect }: {
  role: Role;
  selected?: Role;
  onSelect: (id: string) => void;
}) {
  const active = selected?._id === role._id;
  return (
    <button
      onClick={() => onSelect(role._id)}
      className={`w-full text-left px-3 py-2 rounded-lg mb-0.5 transition-colors ${active ? 'bg-accent/10' : 'hover:bg-line/50'}`}
    >
      <div className="flex items-center justify-between">
        <span className={`text-sm font-medium ${active ? 'text-accent' : 'text-primary'}`}>{displayRoleName(role)}</span>
        {isProtected(role) && <Lock size={12} className="text-steel" />}
      </div>
      <div className="data text-[10px] text-steel">{role.key}</div>
    </button>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return <div><label className="label block mb-1.5">{label}{required && <span className="text-stopped"> *</span>}</label>{children}</div>;
}

function DepartmentSelect({ value, onChange, departments }: { value: string; onChange: (v: string) => void; departments: RoleDepartment[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="input">
      <option value="">— not placed (filed by its name) —</option>
      {departments.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
    </select>
  );
}

// Create a department on the plant's list + seed its roles via the /roles API.
function AddDepartmentModal({ existingKeys, saveDepts, onClose, onCreated }: {
  existingKeys: Set<string>;
  saveDepts: (edit: (live: Pick<RoleDepartment, 'key' | 'name' | 'accent'>[]) => Pick<RoleDepartment, 'key' | 'name' | 'accent'>[]) => Promise<void>;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [roleNames, setRoleNames] = useState<string[]>(['', '', '']);
  const [error, setError] = useState('');

  const setRole = (i: number, v: string) => setRoleNames((arr) => arr.map((x, idx) => (idx === i ? v : x)));
  const addRoleRow = () => setRoleNames((arr) => [...arr, '']);
  const removeRoleRow = (i: number) => setRoleNames((arr) => arr.filter((_, idx) => idx !== i));

  const mut = useMutation({
    mutationFn: async () => {
      const clean = name.trim();
      const key = deptKeyOf(clean);
      if (!key) throw new Error('The department name needs at least one letter or digit.');
      await saveDepts((live) => {
        if (live.some((d) => d.key === key || d.name.toLowerCase() === clean.toLowerCase())) throw new Error('That department already exists.');
        return [...live, { key, name: clean, accent: '' }];
      });
      // A role key must be unique across the plant: "Manager" in HR becomes
      // hr_manager when a plain "manager" already exists.
      const taken = new Set(existingKeys);
      const made: string[] = [];
      const failed: string[] = [];
      for (const raw of roleNames.map((r) => r.trim()).filter(Boolean)) {
        const base = slug(raw);
        if (!base) continue;
        const roleKey = taken.has(base) ? `${key}_${base}` : base;
        try {
          await rbacApi.createRole({ name: raw, key: roleKey, description: `${clean} role`, department: key, permissions: { dashboard: ['view'], machines: ['view'] } });
          taken.add(roleKey); made.push(raw);
        } catch { failed.push(raw); }
      }
      return { key, name: clean, made, failed };
    },
    onSuccess: ({ key, name: n, made, failed }) => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      toast.success(`${n} created${made.length ? ` with ${made.length} role${made.length > 1 ? 's' : ''}` : ''}`);
      if (failed.length) toast.error(`Not created (a role with that key exists): ${failed.join(', ')}`, 8000);
      onCreated(key);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not create department'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) return setError('Department name is required.');
    mut.mutate();
  };

  return (
    <Modal title="Add Department" subtitle="A department for every screen — and the roles inside it" icon={Building2} onClose={onClose} maxW="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Department name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. HR, Logistics, Stores" className="input" autoFocus maxLength={60} />
        </Field>
        <div>
          <div className="label mb-1.5">Roles in this department</div>
          <div className="space-y-2">
            {roleNames.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={r} onChange={(e) => setRole(i, e.target.value)} placeholder="e.g. Manager, Supervisor, Operator" className="input flex-1" />
                {roleNames.length > 1 && (
                  <button type="button" onClick={() => removeRoleRow(i)} title="Remove" className="text-steel hover:text-stopped p-1 shrink-0"><X size={15} /></button>
                )}
              </div>
            ))}
          </div>
          <button type="button" onClick={addRoleRow} className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80">
            <Plus size={13} /> Add role
          </button>
        </div>
        <p className="text-[11px] text-steel">
          The department appears on the Roles page, the Employees form, the org chart and the notification matrix (Settings → Alerts & Downtime). Roles are placed in it as they are created; set each role’s permissions afterwards.
        </p>
        {error && <div className="text-sm text-stopped bg-stopped/8 border border-stopped/15 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base transition-colors">Cancel</button>
          <button type="submit" disabled={mut.isPending} className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-60">
            {mut.isPending ? 'Creating…' : 'Create department'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Create a single role (name + key + description, in a department), then set its permissions in the matrix.
function RoleModal({ departments, department, onClose, onCreated }: {
  departments: RoleDepartment[]; department: string; onClose: () => void; onCreated: (r?: Role) => void;
}) {
  const [form, setForm] = useState({ name: '', key: '', description: '', department });
  const [keyEdited, setKeyEdited] = useState(false);
  const [error, setError] = useState('');
  const onName = (v: string) => setForm((f) => ({ ...f, name: v, key: keyEdited ? f.key : slug(v) }));

  const mut = useMutation({
    mutationFn: () => rbacApi.createRole({ name: form.name.trim(), key: form.key.trim(), description: form.description.trim(), department: form.department, permissions: {} }),
    onSuccess: (res) => onCreated(res?.data),
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not create role'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim() || !form.key.trim()) return setError('Name and key are required.');
    mut.mutate();
  };
  const deptLabel = departments.find((d) => d.key === department)?.name;

  return (
    <Modal title="New Role" subtitle={deptLabel ? `In ${deptLabel} — then set its permissions` : 'Create a role, then set its permissions'} icon={ShieldCheck} onClose={onClose} maxW="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Role name" required><input value={form.name} onChange={(e) => onName(e.target.value)} placeholder="e.g. Quality Engineer" className="input" autoFocus maxLength={60} /></Field>
        <Field label="Key (unique id)" required><input value={form.key} onChange={(e) => { setKeyEdited(true); setForm((f) => ({ ...f, key: slug(e.target.value) })); }} placeholder="quality_engineer" className="input data" /></Field>
        <Field label="Department"><DepartmentSelect value={form.department} onChange={(v) => setForm((f) => ({ ...f, department: v }))} departments={departments} /></Field>
        <Field label="Description"><textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} placeholder="What this role is for…" className="input resize-none" maxLength={300} /></Field>
        {error && <div className="text-sm text-stopped bg-stopped/8 border border-stopped/15 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base transition-colors">Cancel</button>
          <button type="submit" disabled={mut.isPending} className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-60">{mut.isPending ? 'Creating…' : 'Create role'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Rename, describe, or move a role. The key stays: people, notification rules
// and the operator-session convention all hang off it.
function EditRoleModal({ role, departments, onClose, onSaved }: {
  role: Role; departments: RoleDepartment[]; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({ name: role.name, description: role.description || '', department: role.department || '' });
  const [error, setError] = useState('');
  const wasOperator = /operator|\bopr\b/i.test(`${role.key} ${role.name}`.replace(/[._/-]+/g, ' '));
  const isOperator = /operator|\bopr\b/i.test(`${role.key} ${form.name}`.replace(/[._/-]+/g, ' '));
  // Leadership sits above the departments whatever is stored: no placement to edit.
  const leadership = ['super_admin', 'plant_head'].includes(classifyRoleGroup(role));
  const me = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const mut = useMutation({
    mutationFn: () => rbacApi.updateRole(role._id, { name: form.name.trim(), description: form.description.trim(), ...(leadership ? {} : { department: form.department }) }),
    onSuccess: async () => {
      // My own role renamed: the name this screen gates on (operator or not)
      // must be the new one at once, not after the next sign-in.
      if (me?.role?.id === role._id) { try { setUser((await authApi.me()).data); } catch { /* next sign-in */ } }
      toast.success('Role updated'); onSaved();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not update the role'),
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) return setError('Name is required.');
    mut.mutate();
  };

  return (
    <Modal title="Edit Role" subtitle={<span className="data">{role.key}</span>} icon={Pencil} onClose={onClose} maxW="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Role name" required><input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="input" autoFocus maxLength={60} /></Field>
        {!leadership && <Field label="Department"><DepartmentSelect value={form.department} onChange={(v) => setForm((f) => ({ ...f, department: v }))} departments={departments} /></Field>}
        <Field label="Description"><textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} className="input resize-none" maxLength={300} /></Field>
        {wasOperator !== isOperator && (
          <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {isOperator
              ? 'A role with “operator” in its name is asked by the popups by default — check Settings → Alerts & Downtime after saving.'
              : 'This role will no longer read as an operator role: unless a rule says otherwise, its people stop getting the popups — check Settings → Alerts & Downtime after saving.'}
          </div>
        )}
        <p className="text-[11px] text-steel">The key never changes, so the people in this role, its notification rules and its permissions all stay as they are.</p>
        {error && <div className="text-sm text-stopped bg-stopped/8 border border-stopped/15 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base transition-colors">Cancel</button>
          <button type="submit" disabled={mut.isPending} className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-60">{mut.isPending ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
