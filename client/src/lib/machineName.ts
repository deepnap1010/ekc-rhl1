// client/src/lib/machineName.ts
// One place that turns a machine's REAL identifier into the name people read.
//
// A supervisor renames CUTTINGMACHINE04 to "PC04". That rename is a label and
// nothing more: the database, the PLC, the telemetry and every query still say
// CUTTINGMACHINE04, and must — the collectors post under that id and every
// historical row is keyed by it.
//
// The label lives on the SERVER (machine_labels, GET /machines/labels), because
// the point of a name is that everyone uses it: the plant head, the supervisor
// and the operator have to read the same board, on any device, at any login.
// Only an admin can set one (PUT /machines/:code/label is admin-gated).
//
// Lookups normalise punctuation and case the way the server's config/lineLinks
// does, so SPG-06, SPG06 and "spg 06" all resolve to the same label.
import { useEffect, useReducer } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { machineApi } from '../api/endpoints';
import { useAuthStore } from '../store/auth';

/** Codes differ by punctuation across collector versions (SPG-08 vs SPG08). */
export const normRef = (s: string): string => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// A module-level index so plain functions (lib/production's borrowedFrom) can
// name a machine without being React components. The query below is its only
// writer; components re-render through the subscription.
let INDEX = new Map<string, string>();
const listeners = new Set<() => void>();

/** Replace the index from a labels payload. Returns true when anything changed,
 *  so an unchanged refetch does not re-render every board on the page. */
export function loadMachineLabels(rows: { machineRef: string; displayName: string }[]): boolean {
  const next = new Map<string, string>();
  for (const r of rows) {
    const name = (r.displayName || '').trim();
    if (name) next.set(normRef(r.machineRef), name);
  }
  if (next.size === INDEX.size && [...next].every(([k, v]) => INDEX.get(k) === v)) return false;
  INDEX = next;
  listeners.forEach((fn) => fn());
  return true;
}

/** The label for one ref, or the ref itself (upper-cased) when unnamed. */
export function machineNameOf(ref: string): string {
  const raw = String(ref || '');
  return INDEX.get(normRef(raw)) || raw.toUpperCase();
}

/** True when this machine has been given a custom name. */
export const hasCustomName = (ref: string): boolean => INDEX.has(normRef(ref));

/** Label plus the machine's real id, for tooltips: "PC04 · machine sends
 *  CUTTINGMACHINE04". Renamed machines only — repeating an unnamed code is noise. */
export function machineTitleOf(ref: string): string {
  const raw = String(ref || '').toUpperCase();
  const label = INDEX.get(normRef(raw));
  return label ? `${label} · machine sends "${raw}"` : raw;
}

function useLabelIndex(): void {
  const [, force] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => { listeners.delete(force); };
  }, []);
}

/**
 * The naming function for a component, live across renames.
 *
 *   const name = useMachineName();
 *   <span>{name(row.code)}</span>
 *
 * Returns a function rather than a value so one subscription serves a whole
 * list — a board renders forty of these.
 */
export function useMachineName(): (ref: string) => string {
  useLabelIndex();
  return machineNameOf;
}

/** Tooltip companion to useMachineName. */
export function useMachineTitle(): (ref: string) => string {
  useLabelIndex();
  return machineTitleOf;
}

/** Fetches the labels once for the whole app — mount it high (App), not per
 *  page: react-query dedupes the key, and every naming hook reads the module
 *  index this fills. Refetched on a slow interval; a rename also invalidates
 *  it directly, so it appears at once for the admin making it. */
export function useMachineLabelsSync(): void {
  const token = useAuthStore((s) => s.accessToken);
  const { data } = useQuery({
    queryKey: ['machine-labels'],
    queryFn: () => machineApi.labels().then((r) => r.data),
    enabled: !!token,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  useEffect(() => { if (data) loadMachineLabels(data); }, [data]);
}

/** One-time carry-over of names typed before they were shared.
 *
 *  Renaming used to write to this browser's localStorage, so the admin who did
 *  it is the only person who ever saw those names. On their next visit their
 *  local names are pushed up and become everyone's; after that the local copy
 *  is dropped, because two sources for one name is how they drift apart.
 *  Anyone else's stale local names are simply ignored — the server refuses the
 *  write, which is exactly right. */
export function useAdoptLocalNames(canRename: boolean): void {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['machine-labels'],
    queryFn: () => machineApi.labels().then((r) => r.data),
    enabled: false,
  });
  useEffect(() => {
    if (!canRename || !data) return;
    let local: Record<string, { displayName?: string }> = {};
    try { local = JSON.parse(localStorage.getItem('ekc.machine.config.v1') || '{}'); } catch { return; }
    const known = new Set(data.map((r) => normRef(r.machineRef)));
    const pending = Object.entries(local)
      .map(([ref, cfg]) => ({ ref, name: (cfg?.displayName || '').trim() }))
      .filter((x) => x.name && !known.has(normRef(x.ref)));
    if (!pending.length) return;
    void Promise.allSettled(pending.map((x) => machineApi.setLabel(x.ref, x.name)))
      .then(() => qc.invalidateQueries({ queryKey: ['machine-labels'] }));
  }, [canRename, data, qc]);
}
