// client/src/lib/params.ts
// Curation layer: machines dump anywhere from 5 to 3,500+ raw signals, so we
// rank parameters by importance and surface only the meaningful ones up front.
//
// Importance is derived from (a) how these machines self-describe their data and
// (b) standard process parameters for the equipment involved:
//   - Milling (bottom-milling): spindle/feed speed, depth of cut, torque/load,
//     stroke position, rapid traverse, production, run time.
//   - Heat-treatment furnace: hardening/tempering/quench temps, soak time,
//     hot-air, power, conveyor, run/set time.
//   - Machine state/safety: alarms, overload, E-STOP, cycle start, auto/running,
//     motor, hydraulics.
// Earlier patterns rank higher. Unmatched keys are either named secondary signals
// or raw PLC register addresses (D0, T3, DB21.DW0, I0.0 …) — the latter, when
// empty (0), are hidden as noise.

import type { MetricValue, ParameterMap } from '../types/api';
import { isNumeric } from './format';

const IMPORTANT: RegExp[] = [
  /alarm|fault|trip|overload|\bo\s?l\b/,            // faults — surface first
  /e\s?stop|emergency/,
  /torque|load/,
  /spindle/,
  /processing|feed|cutting.*speed|feed.?rate/,
  /depth/,
  /stroke|travel|position/,
  /fast.?forward|rapid|fast.?servo|servo/,
  /harden|austeniti/,
  /temper/,
  /quench|\bq\s?t\b/,
  /soak/,
  /hot.?air/,
  /conveyor/,
  /\bpower\b/,
  /(^|[^a-z])t\s?\d+([^a-z]|$)|temperature|\btemp\b/, // zone temps H_T1, T_T3
  /production|output|pieces|parts|\bcount\b/,
  /efficiency|oee/,
  /cycle/,
  /run.?time|set.?time/,
  /auto|running/,
  /\bstart\b/,
  /motor/,
  /\bhyd/,
  /\bjob\b|load|unload/,
  /\bspeed\b/,
];

const norm = (k: string): string =>
  k.toLowerCase().replace(/[._/\-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Importance rank of a key (lower = more important; Infinity = not important). */
export function paramPriority(key: string): number {
  const n = norm(key);
  for (let i = 0; i < IMPORTANT.length; i++) if (IMPORTANT[i].test(n)) return i;
  return Infinity;
}

const stripGroup = (k: string): string =>
  k.replace(/^(named\.(inputs|outputs)\.|active\.|data\.)/i, '');

/**
 * True for raw PLC register/address keys (D0, DW0, T3, M120, DM130, IB0, QB1,
 * IW0, I0.0, Q8.2, DB21.DW0, DB16.W12 …) — as opposed to human-named signals.
 * Keys under a `named.*` group are always treated as named, never raw.
 */
export function isRawAddress(key: string): boolean {
  if (/(^|\.)named\./i.test(key)) return false;
  const b = stripGroup(key);
  return (
    /^(dw?|t|m|dm|mb|ib|qb|iw|qw|w|r)\d+$/i.test(b) || // D0, DW0, T3, M120, DM130, MB12, IB0, QB1, IW0, QW0, W0, R4
    /^[iqm]\d+\.\d+$/i.test(b) ||                       // I0.0, Q8.2, M12.3
    /^db\d+(\.(d?w|r)\d+)?$/i.test(b)                   // DB10, DB21.DW0, DB16.W12, DB11.R4
  );
}

/**
 * Informativeness rank for an unmapped raw register value (lower = surface first).
 * Without a PLC mapping we can't know meaning, but we can rank by signal quality:
 * a plausible analog reading beats a binary state bit, which beats 32-bit overlap
 * garbage and fault sentinels. Used to order the raw signal dump so the values
 * that actually look like real measurements rise to the top.
 */
function rawValueRank(v: MetricValue): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 5;
  const a = Math.abs(n);
  if (a === 32767 || a === 32768) return 4; // Siemens fault / no-sensor sentinel
  if (a > 100_000) return 3;                // 32-bit overlap / overflow noise
  if (n === 1) return 2;                    // binary state bit (little variation)
  return 1;                                 // plausible analog reading — most useful
}

export interface SplitParams {
  important: [string, MetricValue][]; // curated headline signals (process + safety)
  other: [string, MetricValue][];     // named secondary signals + non-zero raw
  hiddenRaw: number;                  // count of empty (zero) raw registers omitted
}

/** Split a parameter map into curated/important, secondary, and hidden-empty-raw. */
export function splitParams(data?: ParameterMap): SplitParams {
  const ranked: { e: [string, MetricValue]; p: number }[] = [];
  const named: [string, MetricValue][] = [];
  const raw: [string, MetricValue][] = [];
  let hiddenRaw = 0;

  for (const e of Object.entries(data || {})) {
    if (norm(e[0]) === 'status') continue; // shown as the status pill
    const p = paramPriority(e[0]);
    if (p !== Infinity) {
      ranked.push({ e, p });
    } else if (isRawAddress(e[0])) {
      if (isNumeric(e[1]) && Number(e[1]) === 0) hiddenRaw++; // empty register — noise
      else raw.push(e);
    } else {
      named.push(e);
    }
  }

  ranked.sort((a, b) => a.p - b.p || a.e[0].localeCompare(b.e[0]));
  // Order the raw register dump by informativeness so real analog readings lead
  // and binary bits / overflow garbage sink to the bottom.
  raw.sort((a, b) => rawValueRank(a[1]) - rawValueRank(b[1]) || a[0].localeCompare(b[0]));
  // Cap the headline set: boolean-heavy machines (hundreds of matching I/O
  // signals) would otherwise recreate the wall. Overflow keeps its rank ahead
  // of plain named signals in "other".
  const CAP = 24;
  const important = ranked.slice(0, CAP).map((x) => x.e);
  const overflow = ranked.slice(CAP).map((x) => x.e);
  return { important, other: [...overflow, ...named, ...raw], hiddenRaw };
}

/**
 * Parameters to show on a compact machine card. Prefers important ones; falls
 * back to the secondary set so the card is never blank.
 */
export function cardParams(data?: ParameterMap, limit = 6): [string, MetricValue][] {
  const { important, other } = splitParams(data);
  return (important.length ? important : other).slice(0, limit);
}

/** Human label for a key: drop the group prefix (named.inputs., active., …). */
export function paramLabel(key: string): string {
  return key.replace(/^(named\.(inputs|outputs)\.|active\.|data\.)/i, '');
}
