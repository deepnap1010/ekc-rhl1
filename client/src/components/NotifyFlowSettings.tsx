// client/src/components/NotifyFlowSettings.tsx
// Admin Settings → Alerts & Downtime: who is told what, and how — the
// notification workflow behind the operator popups. One matrix: a row per
// role, a column per event, each cell Popup / Notify / Off. A cell shows the
// EFFECTIVE mode — the admin's rule, or the default (a role that calls itself
// an operator is asked, nobody else is) — so what the admin sees is what
// happens; Save writes an explicit choice for every visible cell, so a role
// renamed later never changes behaviour by accident. Same contract as
// DowntimeAskSettings: explicit Save, the server validates, invalidate.
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, X } from 'lucide-react';
import { configApi, rbacApi, userApi } from '../api/endpoints';
import { useAppConfig } from '../hooks/useAppConfig';
import { notifyModeFor, isOperatorRole } from '../hooks/useNotifyMode';
import { useAuthStore } from '../store/auth';
import { toast } from '../store/toast';
import type { NotifyEventKey, NotifyFlowConfig, NotifyMode, Role } from '../types/api';

type Rules = NotifyFlowConfig['rules'];
const MODES: { value: NotifyMode; label: string; hint: string }[] = [
  { value: 'popup', label: 'Popup', hint: 'Asks for an answer, on screen, for the machines assigned to the person' },
  { value: 'notify', label: 'Notify', hint: 'A quiet notice of what is waiting — nothing to answer, for every machine the person can see' },
  { value: 'off', label: 'Off', hint: 'Not told' },
];
const roleKeyOf = (k: unknown): string => String(k ?? '').trim().toLowerCase();
const clone = (r: Rules): Rules => JSON.parse(JSON.stringify(r)) as Rules;
// A rule is stored under the role's key as a field name: a key the server
// cannot store (dots, $, blank, over-long, or an Object property name) makes
// the role unroutable — it is shown, never saved, and the admin is told.
const routable = (role: Role): boolean => {
  const k = roleKeyOf(role.key);
  return /^[^.$\s][^.$]{0,63}$/.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k);
};

// What a role must hold to receive the event at all: the popup routes need
// Production view, and a downtime NOTICE — the whole plant's open downtime —
// needs the Downtime page's view too. A mode the role cannot receive is
// still saved (permissions may follow), but the admin is told.
const cannotReceive = (role: Role, ev: NotifyEventKey, mode: NotifyMode): string | null => {
  if (mode === 'off') return null;
  const has = (m: string): boolean => { const a = role.permissions?.[m] || []; return a.includes('view') || a.includes('admin'); };
  if (!has('production')) return 'needs Production view';
  if (ev === 'downtimeReason' && mode === 'notify' && !has('downtime')) return 'needs Downtime view';
  return null;
};

export default function NotifyFlowSettings(): JSX.Element {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const { notifyFlow, readOnly, prodClass, downtimeAsk } = useAppConfig();
  const canRoles = can('roles', 'view');
  const { data: roles, isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: () => rbacApi.roles().then((r) => r.data),
    enabled: canRoles,
    staleTime: 60_000,
  });
  // Before the workflow existed, anyone with machines assigned was asked.
  // The people who will notice a change are in roles that have machines
  // assigned and now resolve to Off — the card names those roles so the
  // admin can set them back to Popup in one click if they are operators.
  const canUsers = can('employees', 'view');
  // The whole live roster (the list endpoint pages at 20 by default), minus
  // deactivated accounts: they are told nothing either way.
  const { data: users } = useQuery({
    queryKey: ['users', 'notify-flow'],
    queryFn: () => userApi.list({ limit: 200 }).then((r) => r.data.filter((u) => u.active !== false)),
    enabled: canUsers,
    staleTime: 60_000,
  });
  const [draft, setDraft] = useState<Rules | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!draft && notifyFlow) setDraft(clone(notifyFlow.rules)); }, [draft, notifyFlow]);
  if (!notifyFlow || !draft) return <div className="card p-4 text-sm text-steel">Loading notification workflow…</div>;

  const events = notifyFlow.events;
  const dis = !can('settings', 'update') || readOnly;
  const dirty = JSON.stringify(draft) !== JSON.stringify(notifyFlow.rules);
  const list = [...(roles || [])].sort((a, b) => a.name.localeCompare(b.name));
  // Two roles whose keys differ only in case share one rule — say so.
  const keys = list.map((r) => roleKeyOf(r.key));
  const shared = new Set(keys.filter((k, i) => keys.indexOf(k) !== i));
  const effective = (ev: NotifyEventKey, role: Role): NotifyMode => notifyModeFor({ rules: draft }, ev, role);
  const assignedRoleIds = new Set((users || []).filter((u) => (u.assignedMachines?.length ?? 0) > 0 && u.role?.id).map((u) => String(u.role?.id)));
  const silenced = list.filter((r) => assignedRoleIds.has(r._id) && events.every((ev) => effective(ev.key, r) === 'off') && events.every((ev) => draft[ev.key]?.[roleKeyOf(r.key)] == null));
  // Who is actually behind a row: how many people, how many with machines —
  // a Popup row whose people hold no machines delivers nothing.
  const headcount = (role: Role): string | null => {
    if (!users) return null;
    const people = users.filter((u) => String(u.role?.id || '') === role._id);
    const withMachines = people.filter((u) => (u.assignedMachines?.length ?? 0) > 0).length;
    return `${people.length} ${people.length === 1 ? 'person' : 'people'} · ${withMachines} with machines`;
  };
  // The event's own switch lives on another card; a cell reading "Popup"
  // under a switched-off popup would be a lie.
  const masterOff = (ev: NotifyEventKey): boolean =>
    ev === 'productionClass' ? prodClass?.enabled === false : ev === 'downtimeReason' ? downtimeAsk?.enabled === false : false;
  const isDefault = (ev: NotifyEventKey, role: Role): boolean => draft[ev]?.[roleKeyOf(role.key)] == null;
  const set = (ev: NotifyEventKey, role: Role, mode: NotifyMode): void =>
    setDraft((d) => { const n = clone(d || {}); (n[ev] ??= {})[roleKeyOf(role.key)] = mode; return n; });

  const save = async (): Promise<void> => {
    // Every visible cell becomes an explicit rule: what the admin saw is what
    // is saved, defaults included.
    const rules: Rules = {};
    for (const ev of events) for (const r of list) if (routable(r)) (rules[ev.key] ??= {})[roleKeyOf(r.key)] = effective(ev.key, r);
    setSaving(true);
    try {
      await configApi.update({ notifyFlow: { rules } });
      await qc.invalidateQueries({ queryKey: ['app-config'] });
      setDraft(null);   // re-seed from the server's normalized copy
      toast.success('Notification workflow saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center"><BellRing size={16} className="text-accent" /></span>
          <div>
            <h3 className="font-semibold text-primary text-sm">Who is told, and how</h3>
            <p className="text-xs text-steel">For each role: whether a production count increase or a long downtime opens the popup, shows a quiet notice, or nothing. The operator's popups are the Popup column.</p>
          </div>
        </div>
        {dirty && (
          <div className="flex items-center gap-2">
            <button onClick={() => setDraft(null)} disabled={saving}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-steel hover:text-primary rounded-lg px-3 py-2 disabled:opacity-50">
              <X size={13} /> Discard
            </button>
            <button onClick={save} disabled={dis || saving}
              className="inline-flex items-center gap-1.5 text-xs font-semibold bg-accent text-white rounded-lg px-3 py-2 disabled:opacity-50">
              <Check size={13} /> {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
      </div>

      {silenced.length > 0 && (
        <div className="mt-3 rounded-xl border border-idle/40 bg-idle/5 px-3 py-2.5 text-xs text-primary">
          People in {silenced.map((r) => <b key={r._id}>{r.name}</b>).reduce<ReactNode[]>((a, x, i) => (i ? [...a, ', ', x] : [x]), [])} have machines assigned and were asked before this workflow existed; by the default they are now Off.
          If they run those machines, set them to Popup; if they only watch them, this is the change you wanted.
        </div>
      )}

      {!canRoles ? (
        <p className="mt-3 text-xs text-steel">The roles come from the Roles page, which this account cannot view — so the table cannot be shown here.</p>
      ) : isLoading ? (
        <p className="mt-3 text-xs text-steel">Loading roles…</p>
      ) : (
        <div className="mt-4 rounded-xl border border-line overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-base/60">
              <tr className="text-steel align-bottom">
                <th className="text-left label px-3 py-2">Role</th>
                {events.map((ev) => (
                  <th key={ev.key} className="text-left px-3 py-2">
                    <div className="label">{ev.label}</div>
                    <div className="text-[11px] font-normal normal-case tracking-normal text-steel/80">“{ev.ask}”</div>
                    {masterOff(ev.key) && <div className="text-[10px] font-normal normal-case tracking-normal text-stopped">{ev.master} is switched off — nobody is asked until it is on</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr><td colSpan={1 + events.length} className="px-3 py-3 text-xs text-steel">No roles yet — create them on the Roles page.</td></tr>
              )}
              {list.map((role) => (
                <tr key={role._id} className="border-t border-line">
                  <td className="px-3 py-2.5 align-top">
                    <div className="font-medium text-primary flex items-center gap-1.5">
                      {role.name}
                      {isOperatorRole(role) && <span className="pill bg-accent/10 text-accent !text-[10px]" title="An operator role: its screens are the machine's terminal — an ask that runs out there is recorded as unanswered and leaves every queue">terminal</span>}
                    </div>
                    <div className="data text-[10px] text-steel">{role.key}{shared.has(roleKeyOf(role.key)) ? ' · shares its rule with a same-named role' : ''}</div>
                    {headcount(role) && <div className="text-[10px] text-steel/80">{headcount(role)}</div>}
                    {!routable(role) && <div className="text-[10px] text-stopped">cannot be routed — the key has a dot, $ or a reserved word; recreate the role with a plain key</div>}
                  </td>
                  {events.map((ev) => {
                    const mode = effective(ev.key, role);
                    const warn = cannotReceive(role, ev.key, mode);
                    return (
                      <td key={ev.key} className="px-3 py-2.5 align-top">
                        <div className="inline-flex rounded-lg border border-line overflow-hidden" role="radiogroup" aria-label={`${role.name} — ${ev.label}`}>
                          {MODES.map((m) => (
                            <button key={m.value} type="button" role="radio" aria-checked={mode === m.value} title={m.hint} disabled={dis || !routable(role)}
                              onClick={() => set(ev.key, role, m.value)}
                              className={`px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${mode === m.value ? 'bg-accent text-white' : 'text-steel hover:text-primary'}`}>
                              {m.label}
                            </button>
                          ))}
                        </div>
                        <div className="text-[10px] mt-1 min-h-[14px]">
                          {warn ? <span className="text-stopped">{warn}</span> : isDefault(ev.key, role) ? <span className="text-steel/70" title="No rule saved for this role yet — a role with “operator” (or “opr”) in its name is asked, every other role is off">default</span> : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-steel mt-3">
        <b>Popup</b> asks on screen, for the machines assigned to the person — nobody is asked about machines they are not assigned to, and the first answer stands when two people are asked.
        (Assigning machines to someone also narrows what they <i>see</i> to those machines — a plant head who should see the whole plant needs no machines assigned, only a Notify or Popup rule here.)
        Only an operator's screen can let an ask lapse; any other popup that runs out just closes.
        <b> Notify</b> is a quiet notice of what is waiting — unclassified pieces, downtime without a reason — for every machine the person can see (all of them when none are assigned); nothing is recorded from it.
        <b> Off</b> is silence. An account with no role (a super admin's, usually) has no row here and is asked only for the machines assigned to it.
        Until a role has a rule, the default applies: a role with “operator” (or “opr”) in its name is asked, every other role is off.
        The popup's own switch — Production classification popup, Downtime reason popup — still turns the whole event off for everyone.
      </p>
    </div>
  );
}
