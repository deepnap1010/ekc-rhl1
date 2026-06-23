// server/src/utils/normalize.ts
// Telemetry is schema-agnostic: each machine emits its own `data` map, wrapped one
// of three ways — (A) FLAT top-level keys, (B) data.named.{inputs,outputs} digital
// I/O maps, (C) data.active.{...} raw PLC dump. `normalizeData` collapses all three
// into one shape: named scalars, digital inputs, digital outputs, raw registers.
// This is the single place that knows how the factory wraps its payloads — the
// health/anomaly engine builds on it.

const REGISTER_RE = /^(IW|QW|IB|QB|MB|MW|MD|SM|SD|D|M|X|Y|T|C|R|L|V|Z|B|W|F|S|I|Q)\d+$/;
const DB_BLOCK_RE = /^DB\d+\.[A-Z]+\d+(\.\d+)?$/i; // DB21.W12 / DB21.DW0 / DB21.R0
const BIT_ADDR_RE = /^[IQM]\d+\.\d+$/;             // I0.0 / Q0.7 / M120.1

const META_KEYS = new Set(['status', 'name', 'machineId', 'machineName', 'machineType', 'timestamp', 'receivedAt', 'eventId']);

// int16 / int32 "no signal" values a disconnected sensor reports.
const SENTINELS = new Set([-32768, -32767, 32767, 65535, -2147483648, 2147483647]);

export const isRegisterKey = (k: string): boolean => REGISTER_RE.test(k) || DB_BLOCK_RE.test(k) || BIT_ADDR_RE.test(k);
export const isMetaKey = (k: string): boolean => META_KEYS.has(k);

export const isNumericValue = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));

export const isFaultValue = (v: unknown): boolean => isNumericValue(v) && SENTINELS.has(Number(v));

export interface Scalar { key: string; value: unknown; numeric: boolean; fault: boolean; }
export interface IO { key: string; value: unknown; on: boolean; }
export interface Normalized { named: Scalar[]; inputs: IO[]; outputs: IO[]; registers: Scalar[]; }

const scalar = (key: string, value: unknown): Scalar => ({ key, value, numeric: isNumericValue(value), fault: isFaultValue(value) });
const ioEntry = (key: string, value: unknown): IO => ({
  key, value,
  on: value === 1 || value === true || value === '1' || value === 'on' || value === 'ON',
});

// Plain object (not array/null) — used to enter the nested named/active wrappers.
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
// Any object/array — used to SKIP nested structures we don't flatten.
const isObjLike = (v: unknown): boolean => v !== null && typeof v === 'object';

export function normalizeData(data: Record<string, unknown> = {}): Normalized {
  const named: Scalar[] = [];
  const inputs: IO[] = [];
  const outputs: IO[] = [];
  const registers: Scalar[] = [];

  const sortScalar = (key: string, value: unknown): void => {
    if (isMetaKey(key)) return;
    if (isRegisterKey(key)) registers.push(scalar(key, value));
    else named.push(scalar(key, value));
  };

  for (const [key, value] of Object.entries(data || {})) {
    // B) digital I/O nested under `named`
    if (key === 'named' && isObj(value)) {
      if (isObj(value.inputs)) for (const [k, v] of Object.entries(value.inputs)) inputs.push(ioEntry(k, v));
      if (isObj(value.outputs)) for (const [k, v] of Object.entries(value.outputs)) outputs.push(ioEntry(k, v));
      for (const [k, v] of Object.entries(value)) {
        if (k === 'inputs' || k === 'outputs' || isObjLike(v)) continue;
        sortScalar(k, v);
      }
      continue;
    }
    // C) raw PLC dump nested under `active`
    if (key === 'active' && isObj(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (isObjLike(v)) continue;
        if (/^I\d+\.\d+$/.test(k)) inputs.push(ioEntry(k, v));
        else if (/^Q\d+\.\d+$/.test(k)) outputs.push(ioEntry(k, v));
        else sortScalar(k, v);
      }
      continue;
    }
    // A) flat top-level key (skip any other nested objects/arrays we don't understand)
    if (isObjLike(value)) continue;
    sortScalar(key, value);
  }

  return { named, inputs, outputs, registers };
}

// Rank named metrics so the most useful surface first: healthy numeric, then other
// numeric, then non-numeric — alphabetical within each tier for stable ordering.
export function rankNamed(named: Scalar[]): Scalar[] {
  const tier = (m: Scalar): number => (m.numeric && !m.fault ? 0 : m.numeric ? 1 : 2);
  return [...named].sort((a, b) => tier(a) - tier(b) || a.key.localeCompare(b.key));
}
