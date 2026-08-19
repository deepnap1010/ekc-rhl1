// client/src/lib/machineOrder.ts
// Deterministic production-flow ordering for machine lists:
//   cutting → SPG (numeric) → bottom milling → furnaces → everything else.
// Category detection is a reusable pattern map over code/name/type — NOT
// scattered string comparisons — so newly added machines slot in automatically.
export interface Orderable { code?: string; machineId?: string; name?: string; type?: string; machineType?: string }

const CATEGORY_PATTERNS: RegExp[] = [
  /cutting/i,           // 0 — cutting machines
  /\bspg[\s_-]?\d*/i,   // 1 — SPG forming machines
  /bottom|milling/i,    // 2 — bottom-milling machines
  /furnace|quench/i,    // 3 — heat-treat / quenching furnaces
];

const refOf = (m: Orderable): string =>
  String(m.code || m.machineId || m.name || '').toUpperCase();

export function processCategory(m: Orderable): number {
  const hay = `${m.code || ''} ${m.machineId || ''} ${m.name || ''} ${m.type || ''} ${m.machineType || ''}`;
  for (let i = 0; i < CATEGORY_PATTERNS.length; i += 1) {
    if (CATEGORY_PATTERNS[i].test(hay)) return i;
  }
  return CATEGORY_PATTERNS.length; // everything else, after the known stages
}

// First number in the ref (SPG04 → 4, CUTTINGMACHINE06 → 6); Infinity when none,
// so un-numbered machines follow their numbered siblings.
const numOf = (ref: string): number => {
  const m = ref.match(/(\d+)/);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
};

/** Compare two machines in production-flow order (stable, deterministic). */
export function processCompare(a: Orderable, b: Orderable): number {
  const ca = processCategory(a), cb = processCategory(b);
  if (ca !== cb) return ca - cb;
  const ra = refOf(a), rb = refOf(b);
  const na = numOf(ra), nb = numOf(rb);
  if (na !== nb) return na - nb;
  return ra.localeCompare(rb);
}
