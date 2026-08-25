// server/src/utils/history.ts
// Two questions the raw telemetry log has to answer: when are two readings the
// SAME reading, and which of a payload's keys deserve a column.

const norm = (k: string): string => k.toLowerCase().replace(/[._/\-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** A machine's own day clocks — run_sec_today, idle_sec_today, uptime… They tick
 *  on every reading, so a log that counts them as data prints a new row every
 *  second while nothing on the machine changed: INTERNALSHOTBLASTING03's last 15
 *  readings differed ONLY in run_sec_today, and the table showed 15 identical
 *  rows. They stay in the payload (and in the row detail) — they just don't get
 *  to claim that something happened. */
const CLOCK_RE = /^(.* )?(sec|secs|seconds|min|mins|minutes|ms|time)( today| day)$|^(uptime|runtime|downtime|elapsed)( sec| secs| seconds| ms)?$/;

export const isClockKey = (k: string): boolean => CLOCK_RE.test(norm(k));

/** What makes two readings identical: every value except the clocks. Key order
 *  is normalised so a collector that reshuffles its JSON can't fake a change. */
export function readingSignature(flat: Record<string, unknown>): string {
  return Object.keys(flat)
    .filter((k) => !isClockKey(k))
    .sort()
    .map((k) => `${k}=${JSON.stringify(flat[k])}`)
    .join('|');
}

/** The columns worth showing: the keys whose value actually MOVES, most-varied
 *  first. The log used to render the payload's first 12 keys, which on ISB03 are
 *  twelve registers that never change — so every row looked identical even
 *  though each one differed somewhere the table wasn't showing. */
export function pickColumns(rows: Record<string, unknown>[], max = 12): string[] {
  const values = new Map<string, Set<string>>();
  const first = new Map<string, number>();
  for (const r of rows.slice(0, 500)) {
    for (const [k, v] of Object.entries(r)) {
      if (isClockKey(k)) continue;
      let s = values.get(k);
      if (!s) { s = new Set(); values.set(k, s); first.set(k, first.size); }
      if (s.size <= 50) s.add(JSON.stringify(v));   // 50 distinct is already "varies"
    }
  }
  return [...values.keys()]
    .sort((a, b) => (values.get(b) as Set<string>).size - (values.get(a) as Set<string>).size
      || (first.get(a) as number) - (first.get(b) as number))
    .slice(0, max);
}

// Self-check
if (process.argv[1]?.includes('history')) {
  const eq = (a: unknown, b: unknown, m: string): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  eq(isClockKey('run_sec_today'), true, 'run seconds is a clock');
  eq(isClockKey('idle_sec_today'), true, 'idle seconds is a clock');
  eq(isClockKey('uptime'), true, 'uptime is a clock');
  eq(isClockKey('CYCLE_DAY'), false, 'cycles-that-day is a counter, not a clock');
  eq(isClockKey('PROD_COUNT'), false, 'production is never a clock');
  eq(isClockKey('CYCLE_SEC'), false, 'a live cycle timer is process data');

  // ISB03's real case: only the run clock moved.
  const a = { VD112: 110, PROD_COUNT: 28, run_sec_today: 11579 };
  const b = { VD112: 110, PROD_COUNT: 28, run_sec_today: 11582 };
  eq(readingSignature(a) === readingSignature(b), true, 'clock tick is not a change');
  eq(readingSignature(a) === readingSignature({ ...b, PROD_COUNT: 29 }), false, 'a piece IS a change');
  eq(readingSignature({ a: 1, b: 2 }) === readingSignature({ b: 2, a: 1 }), true, 'key order cannot fake a change');

  // Columns: the register that never moves loses to the bit that does.
  const rows = [
    { VD112: 110, 'Q0.6': 0, PROD_COUNT: 28, run_sec_today: 1 },
    { VD112: 110, 'Q0.6': 1, PROD_COUNT: 28, run_sec_today: 2 },
    { VD112: 110, 'Q0.6': 0, PROD_COUNT: 29, run_sec_today: 3 },
  ];
  eq(pickColumns(rows, 2), ['Q0.6', 'PROD_COUNT'], 'most-varied columns win');
  eq(pickColumns(rows).includes('run_sec_today'), false, 'clocks never get a column');
  console.log('history: all checks passed');
}
