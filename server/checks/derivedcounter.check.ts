// Self-check for the derived counter (config/derivedCounters), on a real
// (in-memory) MongoDB — the aggregation is what runs in production, so this is
// where it is proved.
//   npm i --no-save mongodb-memory-server     (one-off)
//   npm run check:derived
//
// BOTTOMMILLING03 publishes no counter: its pieces are its head's strokes and
// its feed speed. On 14 Oct 2026 it made 69 pieces in a shift and the card read
// 0, because the stroke rule wanted the LOW reading immediately before the
// HIGH one and every climb had a reading in between. This seeds the floor's
// own pattern — a reading every 2 s, the head stepping ~94,000 pulses — plus
// the two jobs each signal is blind to, a re-cut and a PLC dropout, and asks
// every surface that counts.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { Machine } from '../src/models/Machine.js';
import { Telemetry } from '../src/models/Telemetry.js';
import { derivedCounterFor } from '../src/config/derivedCounters.js';
import { derivedEvents } from '../src/services/derivedCounter.service.js';
import { computeActivity } from '../src/services/activity.service.js';
import { productionEventsBy } from '../src/services/counters.service.js';
import { machineHourly } from '../src/controllers/machine.controller.js';

let bad = 0;
const check = (c: boolean, l: string): void => { console.log(`${c ? 'ok  ' : '!!  '}${l}`); if (!c) bad++; };

function call(fn: any, opts: { query?: any; params?: any } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = { query: opts.query || {}, body: {}, params: opts.params || {}, user: { isSuperAdmin: true } } as any;
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

const CODE = 'BOTTOMMILLING03';
const S = 1000, B = 650_000, REST = 3_392;
const CLIMB = [245_766, 339_844, 433_965, 528_344, 622_439];   // 14 Oct 13:30, as read off the floor
const DOWN = [443_589, 208_253];
const T0 = Math.floor(Date.now() / 60_000) * 60_000 - 3 * 3_600_000;   // three hours ago: a closed window
let t = T0;
const docs: { machineId: string; timestamp: Date; data: Record<string, unknown> }[] = [];
const rises: number[] = [];           // when each climb's speed rose — for the boundary tests
const read = (stroke: number | null, speed?: number): void => {
  docs.push({ machineId: CODE, timestamp: new Date(t), data: stroke == null
    ? { status: 'stopped', plc_online: 0 }                               // the PLC away: what the agent sends
    : { current_stroke_pulse: stroke, travel_setting_pulse: B, processing_speed: speed, fast_forward_speed: 200_000, rated_torque_pct: 1, status: 'running', plc_online: 1 } });
  t += 2 * S;
};
const rest = (n: number, speed = REST): void => { for (let i = 0; i < n; i++) read(0, speed); };
/** One climb and return: `cut` while climbing, `restSpeed` at the top and on the way down, `peak` caps the travel. */
const climb = (cut = 40_000, restSpeed = REST, peak = B): void => {
  rises.push(t);
  for (const v of CLIMB) read(Math.min(v, peak), cut);
  read(peak, restSpeed);
  for (const v of DOWN) read(Math.min(v, peak), restSpeed);
};
const piece = (cut = 40_000, restSpeed = REST, peak = B): void => { rest(32, restSpeed); climb(cut, restSpeed, peak); };   // 80 s a piece

// The shift, in order. It opens on the constant-speed job, as the one seen on
// the floor did: from the window's first reading, which is baseline.
for (let i = 0; i < 4; i++) piece(33_920, 33_920);                     // speed held constant: only the strokes see it
const constantEnd = t;
for (let i = 0; i < 10; i++) piece();                                    // the ordinary job: both see it
for (let i = 0; i < 3; i++) { piece(); rest(3); climb(); }              // each with a re-cut seconds later: still one piece
const offStart = t;
for (let i = 0; i < 150; i++) read(null);                                // the PLC away for five minutes
const offEnd = t;
for (let i = 0; i < 5; i++) piece(40_000, REST, 280_000);              // short strokes, never half travel: only speed sees it
rest(5);
const END = t;
await Machine.create({ code: CODE, name: CODE, currentParameters: docs[docs.length - 1].data });
await Telemetry.collection.insertMany(docs);
const MADE = 4 + 10 + 3 + 5;      // 22

const dc = derivedCounterFor(CODE)!;
const total = async (from: number, to: number): Promise<number> => (await derivedEvents([CODE], dc, new Date(from), new Date(to))).length;

// ── the rule the floor had, for the record ───────────────────────────────────
// The LOW reading immediately before the HIGH one — never true on this data.
let old = 0, prevLow: boolean | null = null, lastEdge = -Infinity;
for (const d of docs) {
  const v = d.data.current_stroke_pulse, tr = d.data.travel_setting_pulse;
  if (typeof v !== 'number' || typeof tr !== 'number' || tr <= 0) continue;
  const lo = v < tr * 0.25, hi = v >= tr * 0.5, at = +d.timestamp;
  if (prevLow === true && hi && at - lastEdge >= 30_000) { old++; lastEdge = at; }
  prevLow = lo;
}
check(old === 0, `the old rule counts ${old} of the ${MADE} — the floor's failure, reproduced`);

// ── the counter ──────────────────────────────────────────────────────────────
const all = await total(T0, END);
check(all === MADE, `both signals together count every piece (${all} of ${MADE})`);
check(await total(T0, constantEnd) === 4, 'the constant-speed job: 4 pieces, from the strokes alone');
check(await total(offStart, offEnd) === 0, 'nothing while the PLC is away');
check(await total(offEnd, END) === 5, 'the short-stroke job: 5 pieces, from the speed alone');

// A window edge between a climb's speed rise and its stroke two seconds later:
// counted once, in the window the speed rose in — the lead-in carries it over.
// Cut between readings, at every half-second through one piece.
let agree = 0, tried = 0;
for (let off = 500; off <= 12_500; off += 1_000) {
  const cut = rises[9] + off;
  tried++;
  if ((await total(T0, cut)) + (await total(cut, END)) === MADE) agree++;
  else console.log(`      split at +${off / 1000}s does not add up`);
}
check(agree === tried, `whatever moment a window splits a piece at, it is counted exactly once (${agree}/${tried})`);

// ── every surface that counts ────────────────────────────────────────────────
const row = (await computeActivity(null, new Date(T0), new Date(END), [CODE])).rows[0];
check(row?.production === MADE, `the machine card reads ${row?.production}`);
check(row?.productionKey === 'current_stroke_pulse', 'and names the count after the strokes');
const board = (await productionEventsBy([CODE], new Date(T0), new Date(END))).get(CODE) || [];
const boardN = board.reduce((n, e) => n + e.made, 0);
check(boardN === MADE, `the targets board reads ${boardN}`);
const h = await call(machineHourly, { params: { code: CODE }, query: { from: new Date(T0).toISOString(), to: new Date(END).toISOString() } });
const bars = (h.hours as { made: number }[]).reduce((n, x) => n + x.made, 0);
check(bars === MADE, `the hourly bars read ${bars}`);

// ── for information: a window edge landing EXACTLY on a reading ──────────────
// Windows are closed at both ends ([from, to]), so a piece whose first edge is
// exactly on the boundary millisecond belongs to both. Shift boundaries fall on
// whole seconds and this agent reads on even seconds, so it can happen.
const onEdge = (await total(T0, rises[9])) + (await total(rises[9], END));
console.log(`info: split exactly on a rise reading -> ${onEdge} (${onEdge === MADE ? 'counted once' : 'counted in both windows — the closed-interval boundary, not this rule'})`);

await mongoose.disconnect();
await mem.stop();
console.log(bad ? `\nFAIL: ${bad}` : '\nALL OK');
process.exit(bad ? 1 : 0);
