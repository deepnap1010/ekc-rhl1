// server/src/utils/temperature.ts
// THE one place that decides which telemetry keys carry a machine's MEASURED
// temperature — the furnace-side counterpart of utils/production.ts. A furnace
// makes heat, not pieces, so every surface that shows "production" for a press
// shows "temperature" for a furnace, and they must agree on which signal that is.
// Mirrors the client's lib/temperature.ts — change both together.
//
// Guards, in order of how badly each one bites:
//   - SETPOINTS AND ALARM BANDS ARE NOT TEMPERATURES. `mainTempSet_c` (620) is
//     what the furnace is ASKED to hold, `SV_TEMP` is a set value, and
//     loop1_hiDev / loop2_loWarn are alarm bands. Averaging those reports a
//     rock-steady "temperature" that is really just the recipe and never moves
//     when the furnace does — the most convincing way to be wrong.
//   - Zone keys (T1…T4, T01…T06) are the furnace thermocouple convention, but on
//     any other machine `T3` is an S7 TIMER address. Zones are therefore read
//     ONLY on machines whose ref says furnace/quench.
//   - Raw register addresses and digital I/O bits never qualify.
import { isRegisterKey, isNumericValue } from './normalize.js';

/** A machine that reports heat instead of pieces (same test as the client's
 *  lib/machineOrder furnace category). */
export const isFurnaceRef = (ref: string): boolean => /furnace|quench/i.test(ref);

const norm = (k: string): string => k.toLowerCase().replace(/[._/\-]+/g, ' ').replace(/\s+/g, ' ').trim();
const stripGroups = (k: string): string => k.replace(/^(named|active|data)\./i, '');

const GROUP_RE = /^(named\.(inputs|outputs)|active|raw)\./i;
// "set", "sv", a deviation/warn band, an alarm flag or a configured limit - all
// recipe, none of them a reading. Matched WITHOUT word boundaries on purpose:
// `mainTempSet_c` normalises to a single token ("maintempset c"), so a bounded
// \bset\b sails straight past it and the 620 C recipe gets reported as the
// furnace's temperature - steady, plausible, and completely wrong.
const SETPOINT_RE = /set|target|alarm|limit|warn|dev\b|\bsv\b/;
const NAMED_TEMP_RE = /temp|therm|celsius|deg ?c/;
const ZONE_RE = /^t ?0?\d+$/;
// The furnace's MAIN temperature channel. Named `mainTempSet_c` by the PLC
// integrator, so the setpoint guard above would drop it — the plant reads this
// as the furnace's temperature and asked for it, so it is allowed through as a
// FALLBACK only: a real measured zone always wins when one is reporting.
// Worth knowing what it is: 620 in all 8,680 numeric readings, null in the rest,
// unchanged while the furnace was idle. It will not move when the furnace does.
const MAIN_TEMP_RE = /main.?temp/;

/** Every key in a flattened payload that carries this machine's temperature.
 *  All of them — a furnace's reading is the mean across its work zones.
 *  Falls back to the main temperature channel when no measured zone reports. */
export function pickTemperatureKeys(flat: Record<string, unknown>, ref: string): string[] {
  const zonesOk = isFurnaceRef(ref);
  const measured: string[] = [];
  const fallback: string[] = [];
  for (const [k, v] of Object.entries(flat)) {
    if (GROUP_RE.test(k)) continue;
    if (!isNumericValue(v)) continue;
    const label = stripGroups(k);
    const n = norm(label);
    if (MAIN_TEMP_RE.test(n)) { fallback.push(k); continue; }
    if (SETPOINT_RE.test(n)) continue;
    if (NAMED_TEMP_RE.test(n) && !isRegisterKey(label)) { measured.push(k); continue; }
    if (zonesOk && ZONE_RE.test(n)) measured.push(k);
  }
  return measured.length ? measured : fallback;
}

/** Readings outside this band are a dead channel, not a process value: an
 *  unwired thermocouple returns an S7 fault sentinel (-32768 / 32767), and no
 *  heat-treat furnace in this plant runs past 2000 °C. */
export const TEMP_MIN = 0;
export const TEMP_MAX = 2000;
