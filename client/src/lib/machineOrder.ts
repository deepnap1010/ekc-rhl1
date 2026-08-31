// client/src/lib/machineOrder.ts
// Deterministic production-flow ordering for machine lists:
//   cutting → SPG (numeric) → bottom milling → furnaces → everything else.
// Category detection is a reusable pattern map over code/name/type — NOT
// scattered string comparisons — so newly added machines slot in automatically.
// Nullable fields allowed: activity rows carry `type: string | null`.
export interface Orderable { code?: string | null; machineId?: string | null; name?: string | null; type?: string | null; machineType?: string | null }

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

// ── Grouping ────────────────────────────────────────────────────────────────
// A group is a machine FAMILY: the code with its trailing number stripped
// (CUTTINGMACHINE06 -> CUTTINGMACHINE, SPG-06 -> SPG). Purely derived, so a
// machine added tomorrow joins its family automatically and an unfamiliar one
// simply forms a family of its own — no list to maintain.
export interface MachineGroup { key: string; label: string }

// One family, spelled differently by different collectors. ISB01 and
// INTERNALSHOTBLASTING03 are the same shot-blasting line, and two cards for one
// line splits its output in half on every board. Alias -> canonical stem.
const FAMILY_ALIASES: Record<string, string> = {
  INTERNALSHOTBLASTING: 'ISB',
  SHOTBLASTING: 'ISB',
  SPINNING: 'SPG',
};

// What a merged family is called. Without an entry the label is derived from
// the code, which is right for every family that only spells itself one way.
const FAMILY_LABELS: Record<string, string> = {
  ISB: 'Internal Shot Blasting',
};

/** The one stem a family is filed under, whichever spelling arrived. */
export const canonicalFamily = (stem: string): string => FAMILY_ALIASES[stem] ?? stem;

/** Every spelling of a family — canonical first. Stage matching (lib/diaStage)
 *  reads the same table, so grouping and stage auto-pick cannot disagree. */
export function familySpellings(stem: string): string[] {
  const canon = canonicalFamily(stem);
  return [canon, ...Object.keys(FAMILY_ALIASES).filter((k) => FAMILY_ALIASES[k] === canon)];
}

// Words we know how to split so a run-together code reads like a name
// ("CUTTINGMACHINE" -> "Cutting Machine"). Longest first; unknown stems are
// shown as-is, which is still correct, just less pretty.
const WORDS = [
  'INTERNAL', 'QUENCHING', 'BLASTING', 'HYDRAULIC', 'ASSEMBLY', 'GRINDING', 'EXTERNAL',
  'CUTTING', 'MILLING', 'WELDING', 'FURNACE', 'MACHINE', 'BOTTOM', 'PRESS', 'LATHE',
  'DRILL', 'MOULD', 'PUMP', 'SHOT', 'SAW', 'TOP', 'CNC', 'SPG',
];

// Acronyms (<= 3 chars) keep their caps; longer words become Title Case.
const titleCase = (w: string): string => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase());

export function groupOf(m: Orderable): MachineGroup {
  const ref = refOf(m);
  const raw = ref.replace(/[^A-Z0-9]/g, '').replace(/\d+$/, '') || ref || 'OTHER';
  const stem = canonicalFamily(raw);
  const words: string[] = [];
  let rest = stem;
  while (rest) {
    const hit = WORDS.find((w) => rest.startsWith(w));
    if (!hit) { words.push(rest); break; }
    words.push(hit);
    rest = rest.slice(hit.length);
  }
  return { key: stem, label: FAMILY_LABELS[stem] ?? words.map(titleCase).join(' ') };
}

/** Bucket machines into families, each already in production-flow order.
 *  Groups themselves follow the order of their first (flow-ordered) machine. */
export function groupMachines<T extends Orderable>(rows: T[]): { key: string; label: string; machines: T[] }[] {
  const by = new Map<string, { key: string; label: string; machines: T[] }>();
  for (const m of [...rows].sort(processCompare)) {
    const g = groupOf(m);
    const hit = by.get(g.key) || { key: g.key, label: g.label, machines: [] as T[] };
    hit.machines.push(m);
    by.set(g.key, hit);
  }
  return [...by.values()];
}
