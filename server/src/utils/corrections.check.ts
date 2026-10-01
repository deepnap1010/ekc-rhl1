// Self-check for the correction arithmetic. Run: npx tsx server/src/utils/corrections.check.ts
import { syntheticSteps, correctSteps, cutOut, overlapOf, timeCuts, timeSplitWithin, piecesWithin, inPiecesPeriod, type Correction } from './corrections.js';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const H = 3_600_000;
const T0 = Date.parse('2026-10-01T01:30:00Z');   // 07:00 IST
const corr = (from: number, to: number, pieces: number | null, state: Correction['state'] = null, time: Correction['time'] = null): Correction =>
  ({ _id: 'c', machineRef: 'SPG05', from: new Date(from), to: new Date(to), time, state, pieces, downtimeReason: '', reason: 'late start',
    createdBy: { id: 'u', name: 'Admin' }, createdAt: new Date(), revokedAt: null, revokedBy: null, revokeReason: '' });

// Synthetic steps: the right total, evenly spread, inside the period.
const fifty = syntheticSteps(corr(T0, T0 + 5 * H, 50));
eq('50 pieces → 50 steps of 1', [fifty.length, fifty.reduce((n, s) => n + s.made, 0)], [50, 50]);
eq('steps sit inside the period', fifty.every((s) => s.t > T0 && s.t < T0 + 5 * H), true);
eq('first step near the start, last near the end', [fifty[0].t - T0, T0 + 5 * H - fifty[49].t], [H / 20, H / 20]);
const big = syntheticSteps(corr(T0, T0 + H, 1000));
eq('a big count is capped at 240 steps, never front-loaded', [big.length, big.reduce((n, s) => n + s.made, 0), Math.min(...big.map((s) => s.made)), Math.max(...big.map((s) => s.made))], [240, 1000, 4, 5]);
// Three equal shifts of a 300-piece day each get 100 — the card's share and the report's split agree.
const day = corr(T0, T0 + 24 * H, 300);
eq('equal windows get equal shares', [piecesWithin(day, T0, T0 + 8 * H), piecesWithin(day, T0 + 8 * H, T0 + 16 * H), piecesWithin(day, T0 + 16 * H, T0 + 24 * H)], [100, 100, 100]);
eq('the shares add up to the whole', piecesWithin(day, T0, T0 + 24 * H), 300);
eq('inside a pieces period', [inPiecesPeriod([corr(T0, T0 + H, 5)], T0 + H / 2), inPiecesPeriod([corr(T0, T0 + H, 5)], T0 + H), inPiecesPeriod([corr(T0, T0 + H, null, 'idle')], T0 + H / 2)], [true, false, false]);
eq('zero pieces → no steps', syntheticSteps(corr(T0, T0 + H, 0)), []);
eq('as-recorded pieces → no steps', syntheticSteps(corr(T0, T0 + H, null)), []);

// Correcting a step list: the engine's steps in the period go, the correction's come in, the rest stay.
const engine = [{ t: T0 + H, made: 1 }, { t: T0 + 2 * H, made: 2 }, { t: T0 + 8 * H, made: 3 }];
const out = correctSteps(engine, [corr(T0, T0 + 5 * H, 10)], T0, T0 + 10 * H);
eq('period steps replaced, later ones kept', [out.reduce((n, s) => n + s.made, 0), out[out.length - 1].made], [13, 3]);
eq('a sub-window gets its share', correctSteps([], [corr(T0, T0 + 5 * H, 10)], T0, T0 + 2.5 * H).reduce((n, s) => n + s.made, 0), 5);
eq('a state-only correction leaves the steps alone', correctSteps(engine, [corr(T0, T0 + 5 * H, null, 'running')], T0, T0 + 10 * H), engine);
eq('actual zero removes the engine\'s pieces', correctSteps(engine, [corr(T0, T0 + 5 * H, 0)], T0, T0 + 10 * H).reduce((n, s) => n + s.made, 0), 3);

// Cutting intervals.
eq('a cut in the middle splits', cutOut(0, 10, [{ s: 3, e: 5 }]), [{ s: 0, e: 3 }, { s: 5, e: 10 }]);
eq('a cut at the edge trims', cutOut(0, 10, [{ s: 8, e: 20 }]), [{ s: 0, e: 8 }]);
eq('a covering cut leaves nothing', cutOut(2, 4, [{ s: 0, e: 10 }]), []);
eq('two cuts', cutOut(0, 10, [{ s: 1, e: 2 }, { s: 8, e: 9 }]), [{ s: 0, e: 1 }, { s: 2, e: 8 }, { s: 9, e: 10 }]);
eq('a non-touching cut changes nothing', cutOut(0, 10, [{ s: 20, e: 30 }]), [{ s: 0, e: 10 }]);

// Overlaps.
eq('overlap clips to the window', overlapOf(corr(T0, T0 + 5 * H, 1), T0 + 4 * H, T0 + 9 * H), { s: T0 + 4 * H, e: T0 + 5 * H });
eq('no overlap → null', overlapOf(corr(T0, T0 + 5 * H, 1), T0 + 6 * H, T0 + 9 * H), null);
eq('time cuts carry their correction', timeCuts([corr(T0, T0 + H, null, 'idle'), corr(T0 + 2 * H, T0 + 3 * H, 5)], T0, T0 + 9 * H).map((x) => [x.s - T0, x.e - T0, x.c.state]), [[0, H, 'idle']]);

// Time amounts: the card's own tiles, as amounts, scaled to the part a window takes.
const five = corr(T0, T0 + 5 * H, 50, null, { runningMs: 4 * H, idleMs: 0.5 * H, stoppedMs: 0.25 * H });
eq('the whole period gives the amounts, the rest unaccounted', timeSplitWithin(five, T0, T0 + 5 * H), { runningMs: 4 * H, idleMs: 0.5 * H, stoppedMs: 0.25 * H, darkMs: 0.25 * H });
eq('half the period gives half of each', timeSplitWithin(five, T0, T0 + 2.5 * H), { runningMs: 2 * H, idleMs: 0.25 * H, stoppedMs: 0.125 * H, darkMs: 0.125 * H });
eq('amounts never exceed the part', timeSplitWithin(corr(T0, T0 + H, null, null, { runningMs: 2 * H, idleMs: 0, stoppedMs: 0 }), T0, T0 + H), { runningMs: H, idleMs: 0, stoppedMs: 0, darkMs: 0 });
eq('an older whole-period state is the whole part', timeSplitWithin(corr(T0, T0 + H, null, 'stopped'), T0, T0 + H / 2), { runningMs: 0, idleMs: 0, stoppedMs: H / 2, darkMs: 0 });
eq('pieces only says nothing about time', timeSplitWithin(corr(T0, T0 + H, 5), T0, T0 + H), null);
eq('a time correction is a time cut', timeCuts([five], T0, T0 + H).map((x) => x.e - x.s), [H]);

console.log('corrections: all checks passed');
