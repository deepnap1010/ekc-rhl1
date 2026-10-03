// Self-check for the planned-break arithmetic. Run: npx tsx server/src/utils/breaks.check.ts
import { breakOverlapMs, askableMs } from './breaks.js';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const MIN = 60_000;
// IST wall-clock on 3 Oct 2026 → UTC instant.
const ist = (hhmm: string): number => Date.parse(`2026-10-03T${hhmm}:00+05:30`);
const LUNCH = [{ start: '12:30', end: '13:00' }, { start: '20:30', end: '21:00' }];

// The plant's own case: stopped 12:34 → 13:06 with lunch 12:30–13:00.
eq('26 of the 32 minutes were lunch', breakOverlapMs(ist('12:34'), ist('13:06'), LUNCH), 26 * MIN);
eq('6 minutes are left to ask about — under a 10-minute mark', askableMs(ist('12:34'), ist('13:06'), LUNCH), 6 * MIN);
eq('a stop wholly inside lunch has nothing to ask about', askableMs(ist('12:35'), ist('12:55'), LUNCH), 0);
eq('a long stop around lunch keeps the rest', askableMs(ist('12:00'), ist('13:30'), LUNCH), 60 * MIN);
eq('a stop that never touches a break is whole', askableMs(ist('09:00'), ist('09:20'), LUNCH), 20 * MIN);
eq('the evening break counts too', breakOverlapMs(ist('20:00'), ist('22:00'), LUNCH), 30 * MIN);
eq('no schedule, no breaks', askableMs(ist('12:34'), ist('13:06'), []), 32 * MIN);
// A break that wraps midnight (23:45 → 00:15).
eq('a break across midnight', breakOverlapMs(ist('23:30'), ist('23:59'), [{ start: '23:45', end: '00:15' }]), 14 * MIN);

console.log('breaks: all checks passed');
