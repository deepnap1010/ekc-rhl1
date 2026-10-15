// Self-check: a collector that replays old readings must not cost a machine
// its popup and its Production history. On a real (in-memory) MongoDB.
//   npm i --no-save mongodb-memory-server     (one-off)
//   npm run check:replay
//
// CUTTINGMACHINE07, 15 Oct 2026: its card and History tab counted every piece
// (counter 3,388 → 3,394) while Production history read "0 counted" over 25
// rows of "668 → 3,39x · not counted", and its operator was asked about those
// instead of the real pieces. Its collector replays old readings — counter 668
// — stamped with the current time, between the live ones, and the sweep
// believed whichever reading arrived last. This replays that through the
// sweep, then a healthy machine with one bad reading and a real counter reset,
// then a commissioning preload, and asks the events, the operator's popup and
// the card.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { Machine } from '../src/models/Machine.js';
import { Telemetry } from '../src/models/Telemetry.js';
import { MachineEvent } from '../src/models/MachineEvent.js';
import { Role } from '../src/models/Role.js';
import { User } from '../src/models/User.js';
import { computeActivity, PROD_STEP_PER_MIN } from '../src/services/activity.service.js';
import { classQueue } from '../src/controllers/events.controller.js';
import { recordProduction, forgetCounters } from '../src/services/event.service.js';

let bad = 0;
const check = (c: boolean, l: string): void => { console.log(`${c ? 'ok  ' : '!!  '}${l}`); if (!c) bad++; };

function call(fn: any, opts: { query?: any; params?: any; user?: any } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = { query: opts.query || {}, body: {}, params: opts.params || {}, user: opts.user || { isSuperAdmin: true } } as any;
    const res = {
      code: 200,
      status(c: number) { this.code = c; return this; },
      json(b: any) { b?.success ? resolve(b.data) : reject(new Error(`${this.code}: ${b?.error?.message}`)); },
    } as any;
    Promise.resolve(fn(req, res, ((e: any) => reject(e)) as any)).catch(reject);
  });
}

// A cold mongod on a Windows laptop can take longer than the default 10 s.
const mem = await MongoMemoryServer.create({ instance: { launchTimeout: 90_000 } });
await mongoose.connect(mem.getUri(), { dbName: 'test' });

const S = 1000, MIN = 60_000;
// Seventy minutes ago: a closed hour, inside the popup's two-hour reach.
const T0 = Math.floor(Date.now() / MIN) * MIN - 70 * MIN;
const END = T0 + 60 * MIN;
const at = (m: number): number => T0 + m * MIN;
// The sweep, every 30 s — a second after the live readings (even seconds), so
// a replayed one, arriving a second after each, is the last in at most ticks.
const TICKS = Array.from({ length: 119 }, (_, i) => T0 + (i + 1) * 30 * S + S);
const tickNo = (t: number): number => (t - T0 - S) / (30 * S);

type Doc = { machineId: string; timestamp: Date; receivedAt: Date; data: Record<string, unknown> };
/** A live reading every 2 s over the hour. */
const liveDocs = (code: string, live: (t: number) => number): Doc[] => {
  const out: Doc[] = [];
  for (let t = T0; t < END; t += 2 * S) {
    out.push({ machineId: code, timestamp: new Date(t), receivedAt: new Date(t), data: { production_count: live(t), status: 'running' } });
  }
  return out;
};

/** The 30-second sweep over the hour. The snapshot is whichever reading
 *  arrived last, exactly as ingest leaves the machine. `restartAt`: forget
 *  the counters at the first tick from there, as a restart does. */
async function sweep(code: string, docs: Doc[], restartAt?: number): Promise<{ tick: number; v: number }[]> {
  await Telemetry.collection.insertMany(docs.map((d) => ({ ...d })));
  const byArrival = [...docs].sort((a, b) => +a.receivedAt - +b.receivedAt);
  await Machine.create({ code, name: code, currentParameters: byArrival[byArrival.length - 1].data });
  const seen: { tick: number; v: number }[] = [];
  let i = 0;
  for (const tick of TICKS) {
    if (restartAt != null && tick >= restartAt && tick - 30 * S < restartAt) forgetCounters();
    while (i + 1 < byArrival.length && +byArrival[i + 1].receivedAt <= tick) i++;
    const snap = byArrival[i];
    seen.push({ tick, v: Number(snap.data.production_count) });
    await recordProduction(code, snap.data, new Date(tick), snap.timestamp);
  }
  return seen;
}

// ── the sweep as it was, for the record: the last reading in is the counter ─
function oldSweep(seen: { tick: number; v: number }[], restartAt?: number): { resets: number; refused: number; counted: number } {
  let prev: { v: number; at: number } | null = null;
  let resets = 0, refused = 0, counted = 0;
  for (const s of seen) {
    if (restartAt != null && s.tick >= restartAt && s.tick - 30 * S < restartAt) prev = null;
    if (!prev) { prev = { v: s.v, at: s.tick }; continue; }
    if (s.v === prev.v) { prev.at = s.tick; continue; }
    if (s.v > prev.v) {
      if (s.v - prev.v > Math.max((s.tick - prev.at) / MIN, 1) * PROD_STEP_PER_MIN) refused++;
      else counted += s.v - prev.v;
    } else resets++;
    prev = { v: s.v, at: s.tick };
  }
  return { resets, refused, counted };
}

const events = async (code: string) => MachineEvent.find({ machineId: code, kind: 'production' }).sort({ startedAt: 1 }).lean();
const isReset = (e: { meta?: unknown }): boolean => !!(e.meta as { reset?: boolean } | undefined)?.reset;
const isRefused = (e: { meta?: unknown }): boolean => !!(e.meta as { implausible?: boolean } | undefined)?.implausible;
const counted = (evs: Awaited<ReturnType<typeof events>>): number =>
  evs.filter((e) => !isReset(e) && !isRefused(e)).reduce((n, e) => n + (e.delta || 0), 0);
/** Every piece has an event within one sweep of it, and every counted event is a piece. */
const onTime = (evs: Awaited<ReturnType<typeof events>>, pieces: number[]): boolean => {
  const got = evs.filter((e) => !isReset(e) && !isRefused(e)).map((e) => +new Date(e.startedAt));
  return got.length === pieces.length && pieces.every((m, k) => got[k] >= at(m) && got[k] - at(m) <= 31 * S);
};

const role = await Role.create({ name: 'Operator', key: 'operator', permissions: { dashboard: ['view'], machines: ['view'], production: ['view'] } });
/** What the machine's own terminal polls, signed in as its operator. */
async function popup(code: string): Promise<{ delta: number; startedAt: Date }[]> {
  const u = new User({ name: code, email: `${code.toLowerCase()}@example.test`, role: role._id, assignedMachines: [code], active: true });
  await u.setPassword('test-only-pw-123');
  await u.save();
  return call(classQueue, { user: await User.findById(u._id).populate('role').lean() });
}

// ── CUTTINGMACHINE07: live readings, and two replays of an old 668 ───────────
const A = 'CUTTINGMACHINE07';
const A_PIECES = [7, 14, 31, 43, 55];                   // 14 and 43: inside a replay
const aDocs = liveDocs(A, (t) => 3388 + A_PIECES.filter((m) => at(m) <= t).length);
for (const [a, b] of [[10, 18], [33, 52]]) {
  for (let t = at(a); t < at(b); t += 2 * S) {
    const arrives = t + S;
    // Every fifth sweep the live reading happens to be the last one in — the
    // flips back to the real counter the floor's rows show.
    if (tickNo(arrives) % 5 === 0) continue;
    aDocs.push({ machineId: A, timestamp: new Date(arrives), receivedAt: new Date(arrives), data: { production_count: 668, status: 'running' } });
  }
}
// A restart in the middle of the second replay, the snapshot on 668.
const A_RESTART = at(40) + 30 * S;
const aSeen = await sweep(A, aDocs, A_RESTART);
check(aSeen.filter((s) => s.v === 668).length > 40, `the snapshot sat on the old 668 at ${aSeen.filter((s) => s.v === 668).length} of ${aSeen.length} sweeps, as on the floor`);
const aOld = oldSweep(aSeen, A_RESTART);
check(aOld.counted < A_PIECES.length && aOld.refused > 0 && aOld.resets > 0,
  `the old sweep: ${aOld.resets} resets, ${aOld.refused} refused jumps, ${aOld.counted} of ${A_PIECES.length} pieces — the floor's failure, reproduced`);
const aEv = await events(A);
check(aEv.filter(isReset).length === 0 && aEv.filter(isRefused).length === 0, 'now: no reset and no refused jump, through both replays and the restart');
check(onTime(aEv, A_PIECES) && aEv.every((e) => isReset(e) || e.delta === 1),
  `one +1 per piece, each within a sweep of it — the two made during a replay included (${counted(aEv)} of ${A_PIECES.length})`);
const aPop = await popup(A);
check(aPop.length === A_PIECES.length && aPop.every((r) => r.delta === 1), `the operator is asked about exactly the ${A_PIECES.length} pieces (${aPop.length})`);

// ── a healthy machine: one bad reading, then a real counter reset ────────────
const B = 'SPG09';
const B_BEFORE = [4, 8, 12, 16, 20, 24, 28, 32, 36];
const B_AFTER = [41, 45, 49, 53, 57];                   // 41: a minute after the reset
const RESET = at(40);
const bDocs = liveDocs(B, (t) => (t < RESET ? 120 + B_BEFORE.filter((m) => at(m) <= t).length : B_AFTER.filter((m) => at(m) <= t).length));
const GLITCH = at(22) + S;                              // the last reading in before that sweep
bDocs.push({ machineId: B, timestamp: new Date(GLITCH), receivedAt: new Date(GLITCH), data: { production_count: 0, status: 'running' } });
const bSeen = await sweep(B, bDocs);
const bOld = oldSweep(bSeen);
check(bOld.resets === 2 && bOld.refused === 1, `the old sweep took the one bad reading for a reset and a refused +${120 + 5} — a fake row, and a popup`);
const bEv = await events(B);
const bResets = bEv.filter(isReset);
check(bResets.length === 1 && bResets[0].prevValue === 129 && bResets[0].newValue === 0
  && +new Date(bResets[0].startedAt) >= RESET && +new Date(bResets[0].startedAt) - RESET <= 31 * S,
  'now: the bad reading changes nothing; the real reset is recorded once, 129 → 0, at the reset');
check(bEv.filter(isRefused).length === 0, 'no refused jump');
check(onTime(bEv, [...B_BEFORE, ...B_AFTER]),
  `every piece once and on time — the one made a minute after the reset, while the readings were still being checked, too (${counted(bEv)})`);
const bPop = await popup(B);
check(bPop.length === B_BEFORE.length + B_AFTER.length, `its operator is asked about exactly its ${B_BEFORE.length + B_AFTER.length} pieces (${bPop.length})`);

// ── a commissioning preload: still refused, and no longer asked about ───────
const C = 'PRELOAD01';
const cDocs = liveDocs(C, (t) => (t < at(20) ? 10 : 897 + [30, 40].filter((m) => at(m) <= t).length));
await sweep(C, cDocs);
const cEv = await events(C);
check(cEv.filter(isRefused).length === 1 && cEv.find(isRefused)?.delta === 887, 'the preload is still recorded as a refused +887, never counted');
const cPop = await popup(C);
check(cPop.length === 2 && cPop.every((r) => r.delta === 1), `the popup asks about the 2 real pieces, not the preload (${cPop.length})`);

// ── and every machine's events say what its card says ───────────────────────
const card = (await computeActivity(null, new Date(T0), new Date(END), [A, B, C])).rows;
const cardOf = (code: string): number | null | undefined => card.find((r) => r.code === code)?.production;
for (const [code, evs] of [[A, aEv], [B, bEv], [C, cEv]] as const) {
  check(cardOf(code) === counted(evs), `${code}: Production history counts ${counted(evs)}, the card ${cardOf(code)}`);
}

await mongoose.disconnect();
await mem.stop();
console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
