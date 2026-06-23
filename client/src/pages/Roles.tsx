// client/src/pages/Roles.tsx
import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Plus, Lock, Crown, ChevronDown, ChevronRight, Sparkles, Building2, X, ShieldCheck } from 'lucide-react';
import { rbacApi } from '../api/endpoints';
import { Spinner } from '../components/ui';
import Modal from '../components/Modal';
import PageHeader from '../components/PageHeader';
import { prettyKey } from '../lib/format';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import {
  classifyRoleGroup, DEFAULT_ROLE_TEMPLATES, displayRoleName,
  useRoleDepartments, addCustomDepartment, removeCustomDepartment, type RoleDepartment,
} from '../lib/departments';
import type { PermissionMatrix, Role } from '../types/api';

// Local working copy of a role's permission matrix: module -> set of actions.
type PermissionDraft = Record<string, Set<string>>;

// Only the Super Admin role is protected — its permissions are read-only and it can
// never be deleted. Every other role (system or custom) is edited directly.
const isProtected = (r?: Role | null): boolean => {
  const s = `${r?.key || ''} ${r?.name || ''}`.toLowerCase();
  return s.includes('super') && s.includes('admin');
};

export default function Roles() {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PermissionDraft>({}); // module -> Set(actions)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['production'])); // open departments
  const [creating, setCreating] = useState(false);        // New role modal
  const [addingDept, setAddingDept] = useState(false);    // Add department modal
  const canEdit = can('roles', 'update');                  // permission to edit roles at all
  const roleDepartments = useRoleDepartments();            // built-in + custom departments
  const deptSig = roleDepartments.map((d) => d.key).join('|'); // stable memo signal

  const { data: meta } = useQuery({ queryKey: ['rbac', 'meta'], queryFn: () => rbacApi.meta().then((r) => r.data) });
  const { data: roles, isLoading } = useQuery({ queryKey: ['roles'], queryFn: () => rbacApi.roles().then((r) => r.data) });

  const selected = roles?.find((r) => r._id === selectedId) || roles?.[0];
  const locked = !!selected && isProtected(selected);      // only Super Admin is read-only
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
    }
  }, [selected?._id]);

  const saveMut = useMutation({
    mutationFn: () => {
      const perms: PermissionMatrix = {};
      Object.entries(draft).forEach(([m, set]) => { if (set.size) perms[m] = [...set]; });
      return rbacApi.updatePermissions(selected!._id, perms);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roles'] }); toast.success('Permissions saved'); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not save permissions'),
  });

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

  const toggle = (module: string, action: string) => {
    if (!editable) return;
    setDraft((prev) => {
      const next = { ...prev };
      const set = new Set(next[module] || []);
      if (set.has(action)) set.delete(action); else set.add(action);
      next[module] = set;
      return next;
    });
  };

  // "All" column — toggle every action for a module at once.
  const allActions = meta?.actions || [];
  const rowFull = (m: string) => allActions.length > 0 && allActions.every((a) => draft[m]?.has(a));
  const toggleRow = (m: string) => {
    if (!editable) return;
    setDraft((prev) => ({ ...prev, [m]: rowFull(m) ? new Set<string>() : new Set(allActions) }));
  };

  if (isLoading) return <div><PageHeader title="Roles & Permissions" /><Spinner /></div>;

  return (
    <div>
      <PageHeader
        title="Roles & Permissions"
        subtitle="Dynamic RBAC — module access per role"
        right={can('roles', 'create') && (
          <div className="flex items-center gap-2">
            {missingTemplateCount > 0 && (
              <button onClick={() => setupMut.mutate()} disabled={setupMut.isPending}
                className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg text-accent border border-accent/30 bg-accent/5 hover:bg-accent/10 disabled:opacity-60 transition-colors">
                <Sparkles size={15} /> {setupMut.isPending ? 'Creating…' : `Set up dept roles (${missingTemplateCount})`}
              </button>
            )}
            <button onClick={() => setCreating(true)} className="flex items-center gap-1.5 bg-accent text-white text-sm font-medium px-3 py-1.5 rounded-lg hover:bg-accent/90 transition-colors">
              <Plus size={15} /> New role
            </button>
          </div>
        )}
      />

      <div className="px-4 sm:px-6 pb-8 grid lg:grid-cols-[240px_1fr] gap-5">
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

          {/* Departments — built-in + user-added (custom) */}
          <div>
            <div className="label px-2 mb-1 flex items-center justify-between">
              <span>Departments</span>
              {can('roles', 'create') && (
                <button onClick={() => setAddingDept(true)} title="Add department" className="text-steel hover:text-accent transition-colors">
                  <Plus size={13} />
                </button>
              )}
            </div>
            {roleDepartments.map((d) => {
              const deptRoles = grouped[d.key] || [];
              const open = isOpen(d.key);
              return (
                <div key={d.key} className="mb-0.5">
                  <div onClick={() => toggleGroup(d.key)}
                    className="w-full flex items-center gap-1.5 px-2 py-2 rounded-lg hover:bg-line/50 text-left transition-colors cursor-pointer group/dept">
                    {open ? <ChevronDown size={14} className="text-steel shrink-0" /> : <ChevronRight size={14} className="text-steel shrink-0" />}
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: d.accent }} />
                    <span className="text-sm font-medium text-primary flex-1 truncate">{d.name}</span>
                    <span className="pill bg-line text-steel !text-[10px]">{deptRoles.length}</span>
                    {d.custom && (
                      <button
                        onClick={(e) => { e.stopPropagation(); if (window.confirm(`Remove the "${d.name}" department? Its roles move to "Other".`)) removeCustomDepartment(d.key); }}
                        title="Remove department"
                        className="opacity-0 group-hover/dept:opacity-100 text-steel hover:text-stopped transition-opacity shrink-0">
                        <X size={13} />
                      </button>
                    )}
                  </div>
                  {open && (
                    <div className="ml-3 pl-2 border-l border-line mt-0.5">
                      {deptRoles.length
                        ? deptRoles.map((r) => <RoleItem key={r._id} role={r} selected={selected} onSelect={setSelectedId} />)
                        : <div className="text-[11px] text-steel/60 px-2 py-1.5">No roles yet — use “New role” or “Set up dept roles”.</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Other / unassigned roles */}
          {grouped.other?.length ? (
            <div>
              <div className="label px-2 mb-1">Other</div>
              {grouped.other.map((r) => <RoleItem key={r._id} role={r} selected={selected} onSelect={setSelectedId} />)}
            </div>
          ) : null}
        </div>

        {/* Permission matrix */}
        <div className="panel p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="min-w-0">
              <h2 className="font-semibold flex items-center gap-2">
                <span className="truncate">{displayRoleName(selected)}</span>
                {selected?.isSystem && <span className="pill bg-line text-steel !text-[10px] shrink-0">System</span>}
              </h2>
              <p className="text-xs text-steel truncate">{selected?.description || 'No description'}</p>
            </div>
            {editable && (
              <button
                onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
                className="flex items-center gap-1.5 bg-accent text-white text-sm font-medium px-3 py-1.5 rounded-lg disabled:opacity-60 shrink-0"
              >
                <Save size={15} /> {saveMut.isPending ? 'Saving…' : 'Save permissions'}
              </button>
            )}
          </div>

          {locked ? (
            <div className="text-xs text-steel bg-base border border-line rounded-lg px-3 py-2 mb-4 flex items-center gap-1.5">
              <Lock size={12} className="shrink-0" />
              The Super Admin role has full access — its permissions can't be changed and it can't be deleted.
            </div>
          ) : !canEdit ? (
            <div className="text-xs text-steel bg-base border border-line rounded-lg px-3 py-2 mb-4">
              You don't have permission to edit roles — this view is read-only.
            </div>
          ) : null}

          <div className="overflow-x-auto">
            {/* table-fixed + equal-width action columns keep every tick on a clean vertical grid. */}
            <table className="w-full text-sm table-fixed">
              <thead>
                <tr className="text-steel border-b border-line">
                  <th className="text-left font-normal py-2 label w-36">Module</th>
                  {allActions.map((a) => (
                    <th key={a} className="font-normal py-2 label text-center px-1">{a}</th>
                  ))}
                  <th className="label text-center px-1 w-14">All</th>
                </tr>
              </thead>
              <tbody>
                {(meta?.modules || []).map((m) => (
                  <tr key={m} className="border-t border-line hover:bg-base/40">
                    <td className="py-2.5 font-medium text-primary">{prettyKey(m)}</td>
                    {allActions.map((a) => {
                      const on = draft[m]?.has(a);
                      return (
                        <td key={a} className="text-center px-1">
                          <button
                            onClick={() => toggle(m, a)}
                            disabled={!editable}
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
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {creating && <RoleModal onClose={() => setCreating(false)} onCreated={(r) => { setCreating(false); qc.invalidateQueries({ queryKey: ['roles'] }); if (r?._id) setSelectedId(r._id); }} />}
      {addingDept && <AddDepartmentModal onClose={() => setAddingDept(false)} onCreated={(d) => { setAddingDept(false); setExpanded((s) => { const n = new Set(s); n.add(d.key); return n; }); }} />}
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

// Create a custom department (localStorage) + seed its roles via the /roles API.
function AddDepartmentModal({ onClose, onCreated }: { onClose: () => void; onCreated: (d: RoleDepartment) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [roleNames, setRoleNames] = useState<string[]>(['', '', '']);
  const [error, setError] = useState('');

  const setRole = (i: number, v: string) => setRoleNames((arr) => arr.map((x, idx) => (idx === i ? v : x)));
  const addRoleRow = () => setRoleNames((arr) => [...arr, '']);
  const removeRoleRow = (i: number) => setRoleNames((arr) => arr.filter((_, idx) => idx !== i));
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const deptShort = name.trim().replace(/\s*department$/i, '').trim();

  const mut = useMutation({
    mutationFn: async () => {
      const dept = addCustomDepartment(name.trim());
      if (!dept) throw new Error('That department already exists, or the name is invalid.');
      const short = dept.name.replace(/\s*Department$/i, '');
      let created = 0;
      for (const raw of roleNames.map((r) => r.trim()).filter(Boolean)) {
        // Ensure the role name carries the department word so it groups correctly.
        const finalName = raw.toLowerCase().includes(short.toLowerCase()) ? raw : `${short} ${raw}`;
        const key = slug(finalName);
        if (!key) continue;
        try {
          await rbacApi.createRole({ name: finalName, key, description: `${dept.name} role`, permissions: { dashboard: ['view'], machines: ['view'] } });
          created += 1;
        } catch { /* skip duplicate/invalid, keep going */ }
      }
      return { dept, created };
    },
    onSuccess: ({ dept, created }) => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      toast.success(`${dept.name} created${created ? ` with ${created} role${created > 1 ? 's' : ''}` : ''}`);
      onCreated(dept);
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
    <Modal title="Add Department" subtitle="Create a department and the roles inside it" icon={Building2} onClose={onClose} maxW="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Department name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. HR, Logistics, Stores" className="input" autoFocus />
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
          Roles are created under this department. Typing “Manager” becomes “{deptShort || 'HR'} Manager”, so it groups here automatically. You can set each role’s permissions afterwards.
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

// Create a single custom role (name + key + description), then set its permissions in the matrix.
function RoleModal({ onClose, onCreated }: { onClose: () => void; onCreated: (r?: Role) => void }) {
  const [form, setForm] = useState({ name: '', key: '', description: '' });
  const [keyEdited, setKeyEdited] = useState(false);
  const [error, setError] = useState('');
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const onName = (v: string) => setForm((f) => ({ ...f, name: v, key: keyEdited ? f.key : slug(v) }));

  const mut = useMutation({
    mutationFn: () => rbacApi.createRole({ name: form.name.trim(), key: form.key.trim(), description: form.description.trim(), permissions: {} }),
    onSuccess: (res) => onCreated(res?.data),
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not create role'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim() || !form.key.trim()) return setError('Name and key are required.');
    mut.mutate();
  };

  return (
    <Modal title="New Role" subtitle="Create a custom role, then set its permissions" icon={ShieldCheck} onClose={onClose} maxW="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Role name" required><input value={form.name} onChange={(e) => onName(e.target.value)} placeholder="e.g. Quality Engineer" className="input" autoFocus /></Field>
        <Field label="Key (unique id)" required><input value={form.key} onChange={(e) => { setKeyEdited(true); setForm((f) => ({ ...f, key: slug(e.target.value) })); }} placeholder="quality_engineer" className="input data" /></Field>
        <Field label="Description"><textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} placeholder="What this role is for…" className="input resize-none" /></Field>
        {error && <div className="text-sm text-stopped bg-stopped/8 border border-stopped/15 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base transition-colors">Cancel</button>
          <button type="submit" disabled={mut.isPending} className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-60">{mut.isPending ? 'Creating…' : 'Create role'}</button>
        </div>
      </form>
    </Modal>
  );
}
