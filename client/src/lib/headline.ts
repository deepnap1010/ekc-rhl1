// client/src/lib/headline.ts
// The single most decision-relevant value per machine — what an operator/manager
// should read at a glance. Picks the first applicable rule and computes a real
// KPI from the reported signals (sums, peak, uniformity spread, load %). Raw PLC
// register addresses (D0, T3, I0.0 …) are excluded so timers/bits are never
// mistaken for a temperature or speed. Returns null when nothing meaningful is
// reported (e.g. unmapped digital-only machines) — the card then just shows chips.
//
// KPI choices are research-grounded:
//   - Milling: spindle load % = the key tool-wear / cut-health indicator.
//   - Heat-treat furnace: work-zone peak temperature + uniformity (TUS / AMS2750).

import type { MetricValue, ParameterMap } from '../types/api';
import { fmtNum } from './format';
import { isRawAddress, paramLabel } from './params';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';
export interface Headline {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  tone: Tone;
}

const norm = (k: string): string => k.toLowerCase().replace(/[._/\-]+/g, ' ').replace(/\s+/g, ' ').trim();
const asNum = (v: MetricValue): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Numeric values whose (non-raw) key matches the pattern. */
function vals(data: ParameterMap, re: RegExp): number[] {
  const out: number[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (isRawAddress(k)) continue;
    const n = asNum(v);
    // Match the stripped label, not the group-prefixed key, so a group name like
    // "named.outputs.*" can't be mistaken for an "output"/production metric.
    if (n !== null && re.test(norm(paramLabel(k)))) out.push(n);
  }
  return out;
}
const firstVal = (data: ParameterMap, re: RegExp): number | null => {
  const v = vals(data, re);
  return v.length ? v[0] : null;
};

export function computeHeadline(data?: ParameterMap): Headline | null {
  if (!data || Object.keys(data).length === 0) return null;

  // 1) Production / output — the business KPI
  const prod = vals(data, /production|output|pieces|\bparts\b|\bcount\b/);
  if (prod.length) {
    return { label: 'Production', value: fmtNum(prod.reduce((s, n) => s + n, 0)), unit: 'pcs', tone: 'neutral' };
  }

  // 2) Efficiency / OEE
  const eff = firstVal(data, /efficiency|oee/);
  if (eff !== null) {
    return { label: 'Efficiency', value: String(Math.round(eff)), unit: '%', tone: eff >= 75 ? 'good' : eff >= 50 ? 'warn' : 'bad' };
  }

  // 3) Spindle / servo load (torque %) — milling tool & cut health
  const torque = firstVal(data, /torque|spindle.?load/);
  if (torque !== null) {
    const pct = Math.round(torque);
    const feed = firstVal(data, /processing.?speed|feed.?rate|cutting.?speed|^feed$/);
    return {
      label: 'Spindle Load',
      value: String(pct),
      unit: '%',
      sub: feed !== null ? `feed ${fmtNum(feed)}` : undefined,
      tone: pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : pct > 0 ? 'good' : 'neutral',
    };
  }

  // 4) Cut depth — actual vs target
  const depthAct = firstVal(data, /depth.?actual|actual.?depth/);
  const depthSet = firstVal(data, /depth.?(of.?)?cut|set.?depth/);
  if (depthAct !== null || depthSet !== null) {
    const act = depthAct ?? (depthSet as number);
    const tgt = depthAct !== null ? depthSet : null;
    const tol = tgt !== null ? Math.max(1, Math.abs(tgt) * 0.02) : 0;
    return {
      label: 'Cut Depth',
      value: fmtNum(act),
      sub: tgt !== null ? `target ${fmtNum(tgt)}` : undefined,
      tone: tgt !== null ? (Math.abs(act - tgt) <= tol ? 'good' : 'warn') : 'neutral',
    };
  }

  // 5) Furnace work-zone temperature — peak + uniformity spread (TUS-style)
  const sane = (arr: number[]): number[] => arr.filter((n) => n >= 0 && n <= 2000); // drop S7 fault sentinels (-32768 …)
  const heat = sane(vals(data, /^h ?t ?\d+$|harden/));
  const temps = heat.length
    ? heat
    : sane(vals(data, /(^|[^a-z])t ?\d+([^a-z]|$)|temperature|\btemp\b|quench/));
  if (temps.length >= 2) {
    const peak = Math.round(Math.max(...temps));
    const spread = Math.round(Math.max(...temps) - Math.min(...temps));
    return {
      label: heat.length ? 'Hardening Temp' : 'Process Temp',
      value: fmtNum(peak),
      unit: '°C',
      sub: `${temps.length} zones · spread ${spread}°C`,
      tone: 'neutral',
    };
  }
  if (temps.length === 1) return { label: 'Temperature', value: fmtNum(temps[0]), unit: '°C', tone: 'neutral' };

  // 6) Feed / processing speed (specific keys only — avoid digital "speed" flags)
  const feed = firstVal(data, /processing.?speed|feed.?rate|cutting.?speed|^feed$/);
  if (feed !== null) return { label: 'Feed Speed', value: fmtNum(feed), tone: 'neutral' };

  return null;
}
