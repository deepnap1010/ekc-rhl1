// Self-check for the span timeline. Run: npx tsx server/src/services/activity.check.ts
import { clipSpans, type Span } from './activity.service.js';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const total = (spans: Span[]): number => clipSpans(spans).reduce((n, s) => n + (s.e - s.s), 0);
const sp = (type: Span['type'], s: number, e: number): Span => ({ type, s, e });

// Clean input passes through untouched.
eq('disjoint', total([sp('idle', 0, 10), sp('stopped', 20, 30)]), 20);

// The double-sweep signature: two instances logging the same minutes.
eq('duplicate spans counted once', total([sp('idle', 0, 60), sp('idle', 2, 62)]), 62);
eq('overlap counted once', total([sp('stopped', 0, 100), sp('idle', 50, 150)]), 150);

// Backwards rows (endedAt before startedAt) are not real.
eq('backwards dropped', total([sp('stopped', 100, 50), sp('idle', 0, 10)]), 10);

// A span wholly inside another adds nothing.
eq('swallowed span', total([sp('idle', 0, 100), sp('stopped', 10, 20)]), 100);

// The invariant that matters: downtime can never exceed the time it spans.
const messy: Span[] = [];
for (let i = 0; i < 200; i += 1) messy.push(sp(i % 2 ? 'idle' : 'stopped', i * 30, i * 30 + 90));
if (total(messy) > 200 * 30 + 90) throw new Error('total exceeded the covered span');

// Earliest writer keeps the label; the later one only contributes new time.
eq('clipped shape', clipSpans([sp('idle', 0, 100), sp('stopped', 50, 150)]),
  [{ type: 'idle', s: 0, e: 100 }, { type: 'stopped', s: 100, e: 150 }]);

console.log('activity: span checks passed');

// ── Counter stepping ────────────────────────────────────────────────────────
import { countStepsOf, runMsFromSeries } from './activity.service.js';

const series = (...vals: number[]) => vals.map((v, i) => ({ t: i * 60_000, v }));

eq('plain climb', countStepsOf(series(4, 8, 12)), 8);
// A shift reset must not erase the day: the climb before it AND after it count.
eq('reset keeps both halves', countStepsOf(series(4, 8, 12, 0, 4, 8)), 4 + 4 + 4);
// ...at a known cost: the LAST climb before a reset has no later sample to
// confirm it, so it is dropped. Once per reset, bounded by one bucket of output.
// Real counters step in small increments, so this stays small - ISB03's
// 132-piece day comes out exactly right.
eq('the bucket a reset lands in is the cost', countStepsOf(series(0, 10, 0, 5)), 5);
// A single garbage sample fabricates nothing, in either direction.
eq('spike down ignored', countStepsOf(series(440, 0, 441)), 1);
eq('spike up ignored', countStepsOf(series(51, 507, 52)), 1);
// A dip that recovers is not new production (ISB02: 80 -> 76 -> 80).
eq('dip is not production', countStepsOf(series(80, 76, 80)), 0);
eq('too short to step', countStepsOf(series(5)), 0);

// ── Run signals ─────────────────────────────────────────────────────────────
// Seconds counters are stepped, then converted to ms.
eq('run seconds', runMsFromSeries(series(0, 60, 120), 'seconds'), 120_000);
// A flag credits the gap AFTER a sample that said "running", bridged at 5 min.
eq('flag credits its own gaps', runMsFromSeries(series(1, 1, 0, 0), 'flag'), 120_000);
eq('flag never set', runMsFromSeries(series(0, 0, 0), 'flag'), 0);
// A 20-minute silence is not 20 minutes of running.
eq('flag gap is bridged, not trusted',
  runMsFromSeries([{ t: 0, v: 1 }, { t: 20 * 60_000, v: 1 }, { t: 21 * 60_000, v: 0 }], 'flag'),
  5 * 60_000 + 60_000);
eq('one sample is not a signal', runMsFromSeries(series(1), 'flag'), null);

console.log('activity: step + run-signal checks passed');
