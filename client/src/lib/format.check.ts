// Self-check for the range label. Run: npx --prefix server tsx client/src/lib/format.check.ts
import { fmtRangeLabel, statusStyle } from './format';

import { effectiveStatus, statusCounts } from './machineStatus.js';

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

// One spelling drives the pill, the KPI tiles, the status filter AND the sort.
// They used to disagree: a card whose pill read "Stopped" that the Stopped
// filter hid, because only statusStyle normalised and effectiveStatus did not.
const fresh = new Date().toISOString();
eq('"Stop" is stopped everywhere', effectiveStatus({ status: 'Stop', lastReadingAt: fresh }), 'stopped');
eq('and the pill agrees', statusStyle('Stop').label, 'Stopped');
eq('so does the tally', statusCounts([{ status: 'Stop', lastReadingAt: fresh }] as never).stopped, 1);
// Silence still wins over the reported status, normalised or not.
const old10 = new Date(Date.now() - 11 * 60_000).toISOString();
eq('silence beats the status', effectiveStatus({ status: 'Stop', lastReadingAt: old10 }), 'network');
// An unknown word stays the factory's own, and is not forced into a bucket.
eq('unknown passes through', effectiveStatus({ status: 'Maintenance', lastReadingAt: fresh }), 'maintenance');

console.log('format: all checks passed');
