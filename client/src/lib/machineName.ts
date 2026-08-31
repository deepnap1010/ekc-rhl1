// client/src/lib/machineName.ts
// One place that turns a machine's REAL identifier into the name people read.
//
// A supervisor renames CUTTINGMACHINE04 to "PC04" on the Machines page. That
// rename is a label and nothing more: the database, the PLC, the telemetry and
// every query still say CUTTINGMACHINE04, and must — the collectors post under
// that id and every historical row is keyed by it. What changes is only what the
// screen shows, so the rename has to reach every screen or the same machine
// reads as two different machines depending on the page.
//
// Storage is lib/machineConfig (localStorage, per browser). Lookups here are
// normalised the way the server's config/lineLinks does it, so SPG-06, SPG06 and
// "spg 06" all resolve to the same label.
import { useEffect, useReducer } from 'react';
import { subscribe, readAll } from './machineConfig';

/** Codes differ by punctuation across collector versions (SPG-08 vs SPG08). */
export const normRef = (s: string): string => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Build the ref → label index once per render, from whatever is stored. */
function buildIndex(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, cfg] of Object.entries(readAll())) {
    const name = (cfg?.displayName || '').trim();
    if (name) out.set(normRef(key), name);
  }
  return out;
}

/** The label for one ref, or the ref itself (upper-cased) when unnamed. */
export function machineNameOf(ref: string, index?: Map<string, string>): string {
  const raw = String(ref || '');
  const idx = index ?? buildIndex();
  return idx.get(normRef(raw)) || raw.toUpperCase();
}

/** True when this machine has been given a custom name. */
export function hasCustomName(ref: string, index?: Map<string, string>): boolean {
  return (index ?? buildIndex()).has(normRef(ref));
}

/**
 * The naming function for a component, live across renames.
 *
 *   const name = useMachineName();
 *   <span>{name(row.code)}</span>
 *
 * Returns a plain function rather than a value so one subscription serves a
 * whole list of machines — a board renders forty of these.
 */
export function useMachineName(): (ref: string) => string {
  const [, force] = useReducer((c: number) => c + 1, 0);
  useEffect(() => subscribe(force), []);
  const index = buildIndex();
  return (ref: string) => machineNameOf(ref, index);
}

/**
 * Label plus the machine's real id, for tooltips: "PC04 · machine sends
 * CUTTINGMACHINE04". Renamed machines only — an unnamed one just gets its code,
 * and repeating it would be noise.
 */
export function machineTitleOf(ref: string, index?: Map<string, string>): string {
  const idx = index ?? buildIndex();
  const raw = String(ref || '').toUpperCase();
  const label = idx.get(normRef(raw));
  return label ? `${label} · machine sends "${raw}"` : raw;
}

/** Tooltip companion to useMachineName, sharing one subscription. */
export function useMachineTitle(): (ref: string) => string {
  const [, force] = useReducer((c: number) => c + 1, 0);
  useEffect(() => subscribe(force), []);
  const index = buildIndex();
  return (ref: string) => machineTitleOf(ref, index);
}

// ── Self-check: npx tsx src/lib/machineName.check.ts ─────────────────────────
