// client/src/lib/linkedMetrics.ts
// Proxy metrics between physically-connected machines: a machine that doesn't
// report a signal itself borrows it from the machine it's coupled to.
// e.g. BOTTOMMILLING03 has no production counter — the HYDRAULICPRESS02 feeding
// it does (workpiece count), so that count IS bottommilling's production.
// A new source value is only surfaced after the link's settling delay, and only
// while the target machine is online (not offline).
import type { Machine, MachineTick, TicksMap } from '../types/api';
import { isNumeric } from './format';
import { effectiveStatus } from './machineStatus';
import { flattenParams } from './params';

// sourceKeys are tried in priority order — the first regex with a non-zero
// numeric match wins (so a generic "count" never shadows a real workpiece/production counter).
export const LINKS = [
  { target: 'BOTTOMMILLING03', source: 'HYDRAULICPRESS02', sourceKeys: [/workpiece/i], as: 'production', delayMs: 60_000 },
  { target: 'BOTTOMMILLING04', source: 'SPG08', sourceKeys: [/workpiece/i, /production|output|piece/i, /\bcount\b/i], as: 'production', delayMs: 120_000 },
];

// Per-link memory: the value currently shown + the newer value waiting out its
// 1-minute delay. Module-level so it survives re-renders (resets on page reload,
// where showing the current value immediately is the right behavior anyway).
const mem = new Map<string, { shown?: number; pending?: { v: number; at: number } }>();

export function delayedValue(key: string, current: number, delayMs: number, now = Date.now()): number | null {
  const s = mem.get(key);
  if (!s || s.shown == null) { mem.set(key, { shown: current }); return current; }
  if (current === s.shown) { if (s.pending) mem.set(key, { shown: s.shown }); return s.shown; }
  if (s.pending?.v === current) {
    if (now - s.pending.at >= delayMs) { mem.set(key, { shown: current }); return current; }
    return s.shown;
  }
  mem.set(key, { shown: s.shown, pending: { v: current, at: now } }); // new value — start its clock
  return s.shown;
}

const codeOf = (m: Machine): string => String(m.code || m.machineId || '').toUpperCase();

function paramsOf(m: Machine, ticks: TicksMap): Record<string, unknown> {
  const tick: MachineTick | undefined = ticks[m.code || m._id];
  const cp = tick?.currentParameters || m.currentParameters || {};
  // Flatten — nested socket payloads must not hide the source counter.
  return flattenParams(Object.keys(cp).length ? cp : (m.latestData || {}));
}

/** Extra derived params per machine code, e.g. { BOTTOMMILLING03: { production: 277 } }. */
export function linkedExtras(machines: Machine[], ticks: TicksMap): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const link of LINKS) {
    const src = machines.find((m) => codeOf(m) === link.source);
    const tgt = machines.find((m) => codeOf(m) === link.target);
    if (!src || !tgt) continue;
    const tick = ticks[tgt.code || tgt._id];
    const status = effectiveStatus({
      status: tick?.status || tgt.status,
      lastReadingAt: tick?.lastReadingAt || tgt.lastReadingAt,
    });
    if (status === 'offline') continue; // only while the target machine is online
    const srcParams = Object.entries(paramsOf(src, ticks));
    let entry: [string, unknown] | undefined;
    for (const re of link.sourceKeys) {
      entry = srcParams.find(([k, v]) => re.test(k) && isNumeric(v as string | number) && Number(v) !== 0);
      if (entry) break;
    }
    if (!entry) continue;
    const v = delayedValue(`${link.target}:${link.as}`, Number(entry[1]), link.delayMs);
    if (v != null && v !== 0) (out[link.target] ||= {})[link.as] = v;
  }
  return out;
}
