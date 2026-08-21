// Self-check for the range label. Run: npx --prefix server tsx client/src/lib/format.check.ts
import { fmtRangeLabel } from './format';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const label = (a: string, b: string): string => fmtRangeLabel(new Date(a), new Date(b));

// Dates only → one date when it IS one day…
eq('single day', label('2026-08-21T00:00', '2026-08-21T23:59').includes('→'), false);
// …and both ends otherwise.
eq('two days', label('2026-08-20T00:00', '2026-08-21T23:59').includes('→'), true);

// Same day-of-month a year apart must not read as a single day.
const anniversary = label('2025-08-21T00:00', '2026-08-21T23:59');
eq('anniversary keeps both ends', anniversary.includes('→'), true);
eq('anniversary shows the years', anniversary.includes('2025') && anniversary.includes('2026'), true);

// A real time on either edge → timestamps, not bare days.
eq('with a start time', label('2026-08-20T09:30', '2026-08-21T23:59').includes(':'), true);
eq('with an end time', label('2026-08-20T00:00', '2026-08-21T17:00').includes(':'), true);

console.log('format: all checks passed');
