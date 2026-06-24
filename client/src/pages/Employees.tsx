// client/src/pages/Employees.tsx — employee directory + full create/edit/deactivate.
import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Pencil, UserX, UserCheck, Users, ShieldCheck, Trash2, History, Camera } from 'lucide-react';
import { userApi, rbacApi, machineApi } from '../api/endpoints';
import { resizeImage } from '../lib/image';
import { Spinner, Avatar } from '../components/ui';
import Modal from '../components/Modal';
import PageHeader from '../components/PageHeader';
import DeleteEmployeeModal from '../components/DeleteEmployeeModal';
import EmployeeHistoryModal from '../components/EmployeeHistoryModal';
import { useAuthStore } from '../store/auth';
import { classifyRoleGroup, allRoleDepartments, displayRoleName, machineKey, DEPARTMENTS, usersForRole, isPlantHead, isSuperAdminUser, type RoleLike, type DeptRole } from '../lib/departments';
import type { User, Role, Machine, UserWritePayload } from '../types/api';

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export default function Employees() {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<User | null | undefined>(undefined); // undefined = closed · null = create · object = edit
  const [deleting, setDeleting] = useState<User | null>(null);                // employee being temporarily/permanently deleted
  const [showHistory, setShowHistory] = useState(false);
  const dSearch = useDebounced(search);

  const { data, isLoading } = useQuery({ queryKey: ['users', dSearch], queryFn: () => userApi.list({ search: dSearch, limit: 100 }) });
  const users = data?.data || [];
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: () => rbacApi.roles().then((r) => r.data) });
  const { data: machinesData } = useQuery({ queryKey: ['machines', 'assign'], queryFn: () => machineApi.list({ limit: 200, sort: 'name' }) });
  const machines = machinesData?.data || [];

  const userMap = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])) as Record<string, string>, [users]);
  const reactivate = useMutation({ mutationFn: (id: string) => userApi.update(id, { active: true }), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
  const deactivate = useMutation({ mutationFn: (id: string) => userApi.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });

  const canEdit = can('employees', 'update');
  const canDelete = can('employees', 'delete');

  return (
    <div>
      <PageHeader
        title="Employees" subtitle={`${users.length} shown`}
        right={(
          <div className="flex items-center gap-2">
            <button onClick={() => setShowHistory(true)} className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg text-steel border border-line hover:bg-base hover:text-primary transition-colors">
              <History size={15} /> History
            </button>
            {can('employees', 'create') && (
              <button onClick={() => setEditing(null)} className="flex items-center gap-1.5 bg-accent text-white text-sm font-medium px-3 py-1.5 rounded-lg hover:bg-accent/90 transition-colors">
                <Plus size={15} /> Add employee
              </button>
            )}
          </div>
        )}
      />

      <div className="px-4 sm:px-6 pb-8 space-y-4 pt-5">
        <div className="panel p-3">
          <div className="flex items-center gap-2 bg-base border border-line rounded-lg px-3 py-2">
            <Search size={15} className="text-steel" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email…" className="bg-transparent outline-none text-sm flex-1 text-primary placeholder:text-steel/60" />
          </div>
        </div>

        {isLoading ? <Spinner /> : (
          <div className="panel overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="bg-base border-b border-line">
                <tr>
                  {['Name', 'Email', 'Role', 'Plant', 'Reports to', 'Machines', 'Status'].map((h) => <th key={h} className="text-left label px-4 py-3">{h}</th>)}
                  {(canEdit || canDelete) && <th className="text-right label px-4 py-3">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr><td colSpan={8} className="text-center text-steel py-10">No employees found.</td></tr>
                ) : users.map((u) => (
                  <tr key={u.id} className={`border-t border-line hover:bg-base/60 ${!u.active ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2.5">
                        <Avatar src={u.avatar} name={u.name} size={28} />
                        <span className="font-medium text-primary">{u.name}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-steel">{u.email}</td>
                    <td className="px-4 py-3">
                      <span className={`pill ${u.isSuperAdmin ? 'bg-accent/10 text-accent' : 'bg-line text-steel'}`}>
                        {u.isSuperAdmin && <ShieldCheck size={11} />}{u.isSuperAdmin ? 'Super Admin' : (u.role ? displayRoleName(u.role) : '— no role —')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-steel">{u.plant || '—'}</td>
                    <td className="px-4 py-3 text-steel">{u.reportsTo ? (userMap[u.reportsTo] || '—') : '—'}</td>
                    <td className="px-4 py-3 data text-steel">{u.assignedMachines?.length || 0}</td>
                    <td className="px-4 py-3">
                      <span className={`pill ${u.active ? 'bg-running/10 text-running' : 'bg-line text-steel'}`}>{u.active ? 'Active' : 'Inactive'}</span>
                    </td>
                    {(canEdit || canDelete) && (
                      <td className="px-4 py-3 text-right">
                        <span className="inline-flex items-center gap-1 justify-end">
                          {canEdit && <button onClick={() => setEditing(u)} title="Edit" className="p-1.5 rounded-lg text-steel hover:text-accent hover:bg-accent/10"><Pencil size={14} /></button>}
                          {canDelete && (u.active
                            ? <button onClick={() => deactivate.mutate(u.id)} title="Deactivate" className="p-1.5 rounded-lg text-steel hover:text-stopped hover:bg-stopped/10"><UserX size={14} /></button>
                            : <button onClick={() => reactivate.mutate(u.id)} title="Reactivate" className="p-1.5 rounded-lg text-steel hover:text-running hover:bg-running/10"><UserCheck size={14} /></button>)}
                          {canDelete && <button onClick={() => setDeleting(u)} title="Delete (temporary / permanent)" className="p-1.5 rounded-lg text-steel hover:text-stopped hover:bg-stopped/10"><Trash2 size={14} /></button>}
                        </span>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing !== undefined && (
        <EmployeeModal
          employee={editing} roles={roles || []} users={users} machines={machines}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); qc.invalidateQueries({ queryKey: ['users'] }); }}
        />
      )}

      {deleting && (
        <DeleteEmployeeModal
          employee={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => { setDeleting(null); qc.invalidateQueries({ queryKey: ['users'] }); }}
        />
      )}

      {showHistory && <EmployeeHistoryModal canRestore={canEdit} onClose={() => setShowHistory(false)} />}
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <label className="label block mb-1.5">{label}{required && <span className="text-stopped"> *</span>}</label>
      {children}
    </div>
  );
}

// Map the chosen role to its department-config role (department-first so a generic
// "manager" doesn't swallow "Maintenance Manager"), to know exactly who it reports to.
function configRoleFor(dbRole?: RoleLike | null): DeptRole | null {
  if (!dbRole) return null;
  const group = classifyRoleGroup({ key: dbRole.key, name: dbRole.name });
  const dept = DEPARTMENTS.find((d) => d.key === group);
  if (!dept) return null;
  const s = `${dbRole.key || ''} ${dbRole.name || ''}`.toLowerCase();
  return dept.roles.find((r) => r.roleKeywords.some((k) => s.includes(k))) || null;
}

// Users that fill the "reports to" target — a role title, Plant Head, or Super Admin.
function reportsToUsers(parentTitle: string | null, base: User[]): User[] {
  const t = (parentTitle || '').toLowerCase();
  if (!t) return [];
  if (t.includes('super') && t.includes('admin')) return base.filter(isSuperAdminUser);
  if (t.includes('plant') && t.includes('head')) return base.filter(isPlantHead);
  for (const dept of DEPARTMENTS) {
    const r = dept.roles.find((x) => x.title.toLowerCase() === t);
    if (r) return usersForRole(base, r);
  }
  return base; // unknown parent → unrestricted
}

// Seniority order WITHIN a department group, so a dropdown section reads
// Manager → Supervisor → Engineer → Inspector → Operator/Technician/Officer.
function roleRank(r: Role): number {
  const s = `${r.key || ''} ${r.name || ''}`.toLowerCase();
  if (s.includes('head')) return 0;
  if (s.includes('manager')) return 1;
  if (s.includes('supervis')) return 2;
  if (s.includes('engineer')) return 3;
  if (s.includes('inspect')) return 4;
  if (s.includes('operator') || s.includes('technician') || s.includes('officer')) return 5;
  return 6;
}

// Which department dropdown a role belongs to (super_admin + plant_head → Leadership).
function deptKeyForRole(r?: RoleLike | null): string {
  if (!r) return '';
  const g = classifyRoleGroup({ key: r.key, name: r.name });
  return g === 'super_admin' || g === 'plant_head' ? 'leadership' : g;
}

interface EmployeeForm {
  name: string;
  email: string;
  password: string;
  dept: string;
  role: string;
  plant: string;
  reportsTo: string;
  isSuperAdmin: boolean;
  assignedMachines: string[];
  avatar: string;
}

interface EmployeeModalProps {
  employee: User | null;
  roles: Role[];
  users: User[];
  machines: Machine[];
  onClose: () => void;
  onSaved: () => void;
}

function EmployeeModal({ employee, roles, users, machines, onClose, onSaved }: EmployeeModalProps) {
  const isEdit = !!employee;
  const [form, setForm] = useState<EmployeeForm>({
    name: employee?.name || '', email: employee?.email || '', password: '',
    dept: deptKeyForRole(employee?.role), role: employee?.role?.id || '', plant: employee ? (employee.plant || '') : 'KASEZ (Gandhidham)', reportsTo: employee?.reportsTo || '',
    isSuperAdmin: employee?.isSuperAdmin || false, assignedMachines: employee?.assignedMachines || [], avatar: employee?.avatar || '',
  });
  const [error, setError] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { setError('Please choose an image file'); return; }
    setPhotoBusy(true);
    try { set('avatar', await resizeImage(f)); }
    catch { setError('Could not read that image'); }
    finally { setPhotoBusy(false); }
  };
  const set = <K extends keyof EmployeeForm,>(k: K, v: EmployeeForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  // "Reports to" follows the chosen role's department-config parent
  // (e.g. Mechanical Engineer → Maintenance Manager only).
  const selectedRole = roles.find((r) => r._id === form.role);
  const selGroup = selectedRole ? classifyRoleGroup({ key: selectedRole.key, name: selectedRole.name }) : null;
  const base = (users || []).filter((u) => u.id !== employee?.id);
  let parentTitle: string | null = null;
  if (!form.isSuperAdmin && selectedRole && selGroup !== 'super_admin') {
    parentTitle = selGroup === 'plant_head' ? 'Super Admin' : (configRoleFor(selectedRole)?.reportsTo || null);
  }
  const reportsToOptions =
    form.isSuperAdmin || (selectedRole && selGroup === 'super_admin') ? []
      : !selectedRole ? base
        : parentTitle ? reportsToUsers(parentTitle, base)
          : base;

  // Group the role dropdown into department sections (Leadership → departments → other).
  const groupedRoles = useMemo(() => {
    const g: Record<string, Role[]> = {};
    (roles || []).forEach((r) => { const k = classifyRoleGroup({ key: r.key, name: r.name }); (g[k] = g[k] || []).push(r); });
    Object.values(g).forEach((arr) => arr.sort((a, b) => roleRank(a) - roleRank(b) || a.name.localeCompare(b.name)));
    return g;
  }, [roles]);
  const leadershipRoles = [...(groupedRoles.super_admin || []), ...(groupedRoles.plant_head || [])];

  // Cascading role picker: choose a department first, then its roles fill the 2nd select.
  const deptOptions = [
    { key: 'leadership', name: 'Leadership', roles: leadershipRoles },
    ...allRoleDepartments().map((d) => ({ key: d.key as string, name: d.name, roles: groupedRoles[d.key] || [] })),
    { key: 'other', name: 'Other', roles: groupedRoles.other || [] },
  ].filter((d) => d.roles.length > 0);
  const rolesForDept = deptOptions.find((d) => d.key === form.dept)?.roles || [];

  const mut = useMutation({
    mutationFn: () => {
      const body: UserWritePayload = {
        name: form.name.trim(), email: form.email.trim().toLowerCase(),
        role: form.isSuperAdmin ? null : (form.role || null), plant: form.plant.trim(),
        reportsTo: form.reportsTo || null, assignedMachines: form.assignedMachines, isSuperAdmin: form.isSuperAdmin,
        avatar: form.avatar,
      };
      if (form.password) body.password = form.password;
      return isEdit ? userApi.update(employee!.id, body) : userApi.create(body);
    },
    onSuccess: onSaved,
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not save employee'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim() || !form.email.trim()) return setError('Name and email are required.');
    if (!isEdit && !form.password) return setError('A password is required for a new employee.');
    if (!form.isSuperAdmin && !form.role) return setError('Select a role, or mark the user a Super Admin.');
    mut.mutate();
  };

  const toggleMachine = (id: string) => set('assignedMachines', form.assignedMachines.includes(id) ? form.assignedMachines.filter((x) => x !== id) : [...form.assignedMachines, id]);

  return (
    <Modal title={isEdit ? 'Edit Employee' : 'Add Employee'} subtitle={isEdit ? employee!.email : 'Create an account and assign access'} icon={Users} onClose={onClose} maxW="max-w-2xl">
      <form onSubmit={submit} className="space-y-4" autoComplete="off">
        {/* Decoys absorb the browser's saved-login autofill so the real email/password stay empty. */}
        <input type="text" name="username" autoComplete="username" tabIndex={-1} aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />
        <input type="password" name="password" autoComplete="current-password" tabIndex={-1} aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />

        {/* Profile photo — saved to this employee's record in the DB */}
        <div className="flex items-center gap-4">
          <Avatar src={form.avatar} name={form.name} size={56} />
          <div className="flex flex-wrap gap-2">
            <label className="cursor-pointer flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-accent/30 text-accent bg-accent/5 hover:bg-accent/10 transition-colors">
              <Camera size={14} /> {photoBusy ? 'Processing…' : form.avatar ? 'Change photo' : 'Upload photo'}
              <input type="file" accept="image/*" className="hidden" onChange={onPhoto} />
            </label>
            {form.avatar && (
              <button type="button" onClick={() => set('avatar', '')} className="text-sm px-3 py-2 rounded-lg border border-line text-steel hover:text-stopped hover:border-stopped/40 transition-colors">
                Remove
              </button>
            )}
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Full name" required><input value={form.name} onChange={(e) => set('name', e.target.value)} className="input" placeholder="Enter full name" autoFocus autoComplete="off" /></Field>
          <Field label="Email" required><input type="email" name="ekc_emp_email" value={form.email} onChange={(e) => set('email', e.target.value)} className="input" placeholder="Enter your email" autoComplete="off" /></Field>
          <Field label={isEdit ? 'New password' : 'Password'} required={!isEdit}>
            <input type="password" name="ekc_emp_new_password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={isEdit ? 'Leave blank to keep current' : '••••••••'} className="input" autoComplete="new-password" />
          </Field>
          <Field label="Plant"><input value={form.plant} onChange={(e) => set('plant', e.target.value)} placeholder="e.g. Tarapur" className="input" autoComplete="off" /></Field>
          <Field label="Department" required={!form.isSuperAdmin}>
            <select value={form.dept} disabled={form.isSuperAdmin}
              onChange={(e) => setForm((f) => ({ ...f, dept: e.target.value, role: '', reportsTo: '' }))} className="input">
              <option value="">— Select department —</option>
              {deptOptions.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="Role" required={!form.isSuperAdmin}>
            {/* Locked until a department is chosen; then only that department's roles. */}
            <select value={form.role} disabled={form.isSuperAdmin || !form.dept}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value, reportsTo: '' }))}
              className="input disabled:opacity-60 disabled:cursor-not-allowed">
              <option value="">{form.dept ? '— Select role —' : 'Select a department first'}</option>
              {rolesForDept.map((r) => <option key={r._id} value={r._id}>{displayRoleName(r)}</option>)}
            </select>
          </Field>
          <Field label="Reports to">
            {/* Locked until BOTH department and role are chosen; then only the role's parent. */}
            <select value={form.reportsTo} onChange={(e) => set('reportsTo', e.target.value)}
              disabled={form.isSuperAdmin || !form.dept || !form.role}
              className="input disabled:opacity-60 disabled:cursor-not-allowed">
              <option value="">{!form.dept || !form.role ? 'Select department & role first' : '— None —'}</option>
              {reportsToOptions.map((u) => <option key={u.id} value={u.id}>{u.name}{u.role ? ` · ${displayRoleName(u.role)}` : ''}</option>)}
              {form.role && parentTitle && reportsToOptions.length === 0 && (
                <option value="" disabled>No {parentTitle} available</option>
              )}
            </select>
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer rounded-lg border border-line bg-base px-3 py-2.5">
          <input type="checkbox" checked={form.isSuperAdmin} onChange={(e) => set('isSuperAdmin', e.target.checked)} className="accent-accent" />
          <ShieldCheck size={15} className="text-accent" />
          <span className="text-primary font-medium">Super Admin</span>
          <span className="text-xs text-steel">— full access, bypasses all role permissions</span>
        </label>

        <div>
          <div className="label mb-1.5">Assigned machines <span className="text-steel/60">({form.assignedMachines.length})</span></div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-40 overflow-y-auto border border-line rounded-lg p-2 bg-base">
            {machines.map((m) => {
              const id = machineKey(m); const on = form.assignedMachines.includes(id);
              return (
                <label key={id} className={`flex items-center gap-2 text-xs px-2 py-1.5 rounded cursor-pointer ${on ? 'bg-accent/10 text-accent' : 'hover:bg-line/50 text-steel'}`}>
                  <input type="checkbox" checked={on} onChange={() => toggleMachine(id)} className="accent-accent shrink-0" />
                  <span className="truncate">{id.toUpperCase()}</span>
                </label>
              );
            })}
            {machines.length === 0 && <div className="text-xs text-steel col-span-full py-2 text-center">No machines.</div>}
          </div>
        </div>

        {error && <div className="text-sm text-stopped bg-stopped/8 border border-stopped/15 rounded-lg px-3 py-2">{error}</div>}

        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-line text-sm text-steel hover:bg-base transition-colors">Cancel</button>
          <button type="submit" disabled={mut.isPending} className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-60 transition-colors">
            {mut.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create employee'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
