// server/src/utils/flatten.ts
// PLC payloads vary in shape: some send a flat metric map ({ temperature: 42 }),
// others nest signals under groups ({ active: { "I0.0": 1, "DB10.W0": 256 } }).
// The UI renders a flat key->value map, so we recursively flatten nested objects
// into dotted-path keys with scalar leaves. Read-only presentation helper — it
// never mutates stored telemetry. Arrays are stringified so they still display.

export type Scalar = number | string | boolean | null;

export function flattenData(
  input: unknown,
  prefix = '',
  out: Record<string, Scalar> = {},
): Record<string, Scalar> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      flattenData(v, key, out);
    } else if (Array.isArray(v)) {
      out[key] = JSON.stringify(v);
    } else {
      out[key] = v as Scalar;
    }
  }
  return out;
}
