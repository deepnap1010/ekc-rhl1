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

console.log('activity: all checks passed');
