// client/src/lib/temperature.ts
// THE single source of truth for "which signal is this machine's measured
// temperature" — the furnace-side counterpart of lib/production.ts, and the
// mirror of the server's utils/temperature.ts (change both together, exactly as
// production.ts already requires).
//
// A furnace makes heat, not pieces. Every surface that shows PRODUCTION for a
// press must show TEMPERATURE for a furnace, or the cards, the group panels and
// the shift breakdown each tell a different story about the same machine.
//
// Guards, in order of how badly each one bites:
//   - SETPOINTS AND ALARM BANDS ARE NOT TEMPERATURES. `mainTempSet_c` (620) is
//     what the furnace is ASKED to hold, `SV_TEMP` is a set value, and
//     loop1_hiDev / loop2_loWarn are alarm bands. Averaging those shows a
//     rock-steady "temperature" that is really the recipe and never moves when
//     the furnace does.
//   - Zone keys (T1…T4, T01…T06) are the furnace thermocouple convention, but on
//     any other machine `T3` is an S7 TIMER address (lib/params#isRawAddress
//     rejects it for exactly that reason). Zones are read ONLY on furnaces.
import type { MetricValue, ParameterMap } from '../types/api';
import { isRawAddress, paramLabel } from './params';

/** A machine that reports heat instead of pieces. Same test as the server's
 *  utils/temperature#isFurnaceRef and lib/machineOrder's furnace category. */
export const isFurnaceRef = (ref?: string | null): boolean => /furnace|quench/i.test(String(ref || ''));

const norm = (k: string): string =>
  paramLabel(k).toLowerCase().replace(/[._/\-]+/g, ' ').replace(/\s+/g, ' ').trim();

// Matched WITHOUT word boundaries on purpose: `mainTempSet_c` normalises to a
// single token ("maintempset c"), so a bounded \bset\b sails straight past it.
const SETPOINT_RE = /set|target|alarm|limit|warn|dev\b|\bsv\b/;
const NAMED_TEMP_RE = /temp|therm|celsius|deg ?c/;
const ZONE_RE = /^t ?0?\d+$/;
// The furnace's MAIN temperature channel. The PLC integrator named it
// `mainTempSet_c`, so the setpoint guard above would drop it — the plant reads
// this as the furnace's temperature and asked for it, so it is allowed through
// as a FALLBACK only: a real measured zone always wins when one is reporting.
const MAIN_TEMP_RE = /main.?temp/;

// An unwired thermocouple returns an S7 fault sentinel (-32768 / 32767) and no
// heat-treat furnace here runs past 2000 °C — outside this band is a dead
// channel, not a process value.
const sane = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 2000;

/** Every measured temperature this machine is reporting right now (one per work
 *  zone), from a FLAT parameter map. Empty when it reports none. */
export function temperatureValues(
  params?: ParameterMap | Record<string, MetricValue>,
  ref?: string | null,
): number[] {
  const zonesOk = isFurnaceRef(ref);
  const measured: number[] = [];
  const fallback: number[] = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (/^(named\.(inputs|outputs)|active|raw)\./i.test(k)) continue;
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') continue;
    const n = Number(v);
    if (!sane(n)) continue;
    const label = norm(k);
    if (MAIN_TEMP_RE.test(label)) { fallback.push(n); continue; }
    if (SETPOINT_RE.test(label)) continue;
    if (NAMED_TEMP_RE.test(label) && !isRawAddress(k)) { measured.push(n); continue; }
    if (zonesOk && ZONE_RE.test(label)) measured.push(n);
  }
  return measured.length ? measured : fallback;
}

/** The machine's temperature right now — the mean across its work zones, so a
 *  four-zone furnace reads as one number. null when it reports none. */
export function temperatureNow(
  params?: ParameterMap | Record<string, MetricValue>,
  ref?: string | null,
): number | null {
  const vals = temperatureValues(params, ref);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}
