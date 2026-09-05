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
// A register PRELOADED during commissioning is not a day's production: 887
// pieces cannot appear inside one reporting minute (SPG05, the day it was
// wired up). The mark still advances, so honest climbs after the jump count.
eq('preload jump credits nothing', countStepsOf(series(0, 887, 887, 888), 10), 1);
// …but a big step across a LONG gap is real accumulation — a machine that
// produced through a signal loss is fully credited on reconnect.
eq('reconnect gap is credited', countStepsOf([
  { t: 0, v: 0 }, { t: 120 * 60_000, v: 100 }, { t: 121 * 60_000, v: 100 },
], 10), 100);
// A seconds counter cannot earn faster than the clock (SPG05's run_sec_today
// flashed 40311 while the machine had been alive for an hour).
eq('seconds preload rejected', runMsFromSeries(series(0, 40311, 40311), 'seconds'), 0);

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

// ── Reporting intervals and timeline subtraction ────────────────────────────
import { coverageIntervals, subtractMs, type Interval } from './activity.service.js';

const iv = (s: number, e: number): Interval => ({ s, e });
const MIN = 60_000;

// Buckets up to the 5-minute grace apart are one interval; the last one counts
// as its own width.
eq('one run', coverageIntervals([0, MIN, 2 * MIN], MIN), [{ s: 0, e: 3 * MIN }]);
eq('single bucket', coverageIntervals([0], MIN), [{ s: 0, e: MIN }]);
// A silence longer than the grace splits the run — that time is NOT reported.
eq('gap splits', coverageIntervals([0, 20 * MIN], MIN), [{ s: 0, e: MIN }, { s: 20 * MIN, e: 21 * MIN }]);
eq('grace bridges', coverageIntervals([0, 5 * MIN], MIN), [{ s: 0, e: 6 * MIN }]);

// Downtime is removed from the reported time, on the timeline.
eq('no overlap', subtractMs([iv(0, 10)], [iv(20, 30)]), 10);
eq('fully covered', subtractMs([iv(0, 10)], [iv(0, 10)]), 0);
eq('cut in the middle', subtractMs([iv(0, 100)], [iv(40, 60)]), 80);
eq('cut hanging off both ends', subtractMs([iv(10, 20)], [iv(0, 15)]), 5);
eq('several cuts', subtractMs([iv(0, 100)], [iv(10, 20), iv(30, 40), iv(90, 200)]), 70);
eq('nothing to cut', subtractMs([], [iv(0, 10)]), 0);

// THE invariant SPG02 broke: a window cannot hold less running time than a
// window inside it. Same reporting, a wider window, more downtime — the shift's
// runtime must survive in the day's.
const dayCover = coverageIntervals([0, MIN, 2 * MIN, 480 * MIN], MIN);
const shiftCover = coverageIntervals([0, MIN, 2 * MIN], MIN);
const down = [iv(60 * MIN, 500 * MIN)];
if (subtractMs(dayCover, down) < subtractMs(shiftCover, down)) throw new Error('runtime shrank as the window grew');

console.log('activity: interval checks passed');

// ── downtime is clipped to the reporting envelope ───────────────────────────
// The engine books span time as cover ∩ span = reportedMs − (cover − span).
// This is what stops an open span from charging a dark machine with a full
// shift of "stopped" every day: SPG02 went silent for three days and its
// frozen 'stopped' status kept billing 7h50m a day until this.
const covered = [{ s: 0, e: 100 }];
eq('a span half outside the reporting envelope bills only the seen half',
  100 - subtractMs(covered, [sp('stopped', 50, 500)]), 50);
eq('a span entirely in the dark bills nothing',
  100 - subtractMs(covered, [sp('stopped', 200, 500)]), 0);
eq('a span inside the envelope bills in full',
  100 - subtractMs(covered, [sp('idle', 20, 40)]), 20);
eq('no reporting at all bills nothing, whatever the span claims',
  0 - subtractMs([], [sp('stopped', 0, 500)]), 0);
