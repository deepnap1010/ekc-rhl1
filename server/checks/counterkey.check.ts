// Self-check: one reading without a counter must not erase a shift's count.
// On a real (in-memory) MongoDB.
//   npm i --no-save mongodb-memory-server     (one-off)
//   npm run check:counterkey
//
// The case from the floor: SPG06 made 102 pieces in Shift A. The machine page
// drew them hour by hour, and above the bars printed "— of 129 · 0 pcs" —
// because the card took the counter's NAME from the last reading inside the
// window, and that one reading (the PLC was off at the shift's end) had no
// counter in it. Every surface must give the same answer, and a machine that
// really has no counter must still read "cannot count", never "made nothing".
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { Machine } from '../src/models/Machine.js';
import { Telemetry } from '../src/models/Telemetry.js';
import { CounterKeyMemo } from '../src/models/CounterKeyMemo.js';
import { computeActivity, stepEvents, PROD_STEP_PER_MIN } from '../src/services/activity.service.js';
import { productionEventsBy } from '../src/services/counters.service.js';
import { counterKeys, seedCounterKeys, rememberCounterKey } from '../src/services/counterKey.service.js';
import { recordProduction } from '../src/services/event.service.js';
import { machineHourly } from '../src/controllers/machine.controller.js';

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

const MIN = 60_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;
const at = (min: number): Date => new Date(NOW + min * MIN);
// "Shift A": eight hours that ended an hour ago.
const SHIFT: [number, number] = [-540, -60];

// F = the full payload, S = the short one an agent sends with its PLC off,
// N = a reading with no data object at all.
type Shape = 'F' | 'S' | 'N';
const pieces = (min: number): number => Math.floor((min + 20_000) / 4);   // one piece every 4 minutes
const payload = (shape: Shape, min: number): Record<string, unknown> | undefined =>
  (shape === 'F' ? { production_count: pieces(min), spindle_speed: 1200, plc_online: 1 }
    : shape === 'S' ? { plc_online: 0, room_temp: 31 } : undefined);

/** One reading a minute over [first, last]. Returns the minutes that carried the counter. */
async function seed(code: string, first: number, shape: (min: number) => Shape, last = 0): Promise<number[]> {
  await Machine.create({ code, name: code, currentParameters: payload(shape(last), last) || {} });
  const docs = [];
  const full: number[] = [];
  for (let m = first; m <= last; m += 1) {
    const s = shape(m);
    const data = payload(s, m);
    docs.push(data ? { machineId: code, timestamp: at(m), data } : { machineId: code, timestamp: at(m) });
    if (s === 'F') full.push(m);
  }
  // Raw insert: a reading with NO data field must stay that way (the model defaults it to {}).
  await Telemetry.collection.insertMany(docs);
  return full;
}
/** What a window's own counter readings add up to, by the one counting rule. */
const made = (full: number[], [a, b]: [number, number] = SHIFT): number =>
  stepEvents(full.filter((m) => m >= a && m <= b).map((m) => ({ t: NOW + m * MIN, v: pieces(m) })), PROD_STEP_PER_MIN)
    .reduce((n, e) => n + e.made, 0);

// SPG06: counted all shift; the PLC was off across the shift's end.
const spg06 = await seed('SPG06', -600, (m) => (m > -70 && m <= -50 ? 'S' : 'F'));
// Two agents on one PC, two register lists turn about — and BOTH edges of the
// window, and the newest reading of all, are the short one.
const alt = await seed('ALT01', -600, (m) => (Math.abs(m) % 2 === 1 ? 'F' : 'S'));
// A counter in every reading: nothing about it may change.
const normal = await seed('NORM01', -600, () => 'F');
// Counted through the shift; the newest readings (and the snapshot) are short.
const late = await seed('LATE01', -600, (m) => (m <= -20 ? 'F' : 'S'));
// The shift's last reading has no data object at all.
const nodata = await seed('NODATA01', -600, (m) => (m === -60 ? 'N' : m > -70 && m <= -50 ? 'S' : 'F'));
// Ran 6h20m yesterday, the PLC off ever since — and off at both edges of the
// window that is asked about. No reading near "now", and none at the same
// time of day on any earlier day, names the counter.
const GAP: [number, number] = [-1400, -900];
const gap = await seed('GAP01', -3000, (m) => (m >= -1380 && m <= -1000 ? 'F' : 'S'));
// Ran for forty minutes nine days ago; short readings ever since. Older than
// anything the startup look-back reads — only the sweep's memory knows it.
const OLD: [number, number] = [-13_010, -12_950];
const old = await seed('MEM01', -13_050, (m) => (m >= -13_000 && m <= -12_960 ? 'F' : 'S'));
// Lost its counter three days ago: the name is still known, the window never read it.
await seed('LOST01', -4400, (m) => (m <= -4320 ? 'F' : 'S'));
// Never had one (a furnace).
await seed('FURN01', -600, () => 'S');
// Counts by a derived rule; one stray reading at the shift's start names a register.
await seed('BOTTOMMILLING03', -600, (m) => (m === -540 ? 'F' : 'S'));

const win = ([a, b]: [number, number]): [Date, Date] => [at(a), at(b)];
const card = async (code: string, w = SHIFT): Promise<{ production: number | null; productionKey: string | null }> =>
  (await computeActivity(null, ...win(w), [code])).rows[0];
const board = async (code: string, w = SHIFT): Promise<number | null> => {
  const evs = (await productionEventsBy([code], ...win(w))).get(code);
  return evs ? evs.reduce((n, e) => n + e.made, 0) : null;
};
const bars = async (code: string, w = SHIFT): Promise<{ key: string | null; total: number }> => {
  const [from, to] = win(w);
  const r = await call(machineHourly, { params: { code }, query: { from: from.toISOString(), to: to.toISOString() } });
  return { key: r.key, total: (r.hours as { made: number }[]).reduce((n, h) => n + h.made, 0) };
};
const same = async (code: string, want: number, w = SHIFT): Promise<boolean> => {
  const [c, b, h] = [await card(code, w), await board(code, w), await bars(code, w)];
  if (c.production !== want || b !== want || h.total !== want) console.log(`      card ${c.production} · board ${b} · bars ${h.total} · want ${want}`);
  return c.production === want && c.productionKey === 'production_count' && b === want && h.total === want && h.key === 'production_count';
};

// ── the server starts: it learns the names from the readings it already has ──
const learned = await seedCounterKeys();
check(learned >= 5, `startup learned the counter key of the machines that have one (${learned})`);
check((await CounterKeyMemo.countDocuments({ machineRef: { $in: ['FURN01', 'BOTTOMMILLING03'] } })) === 0,
  'and none for a machine with no counter, or one that counts by a derived rule');
check((await seedCounterKeys()) === 0, 'a second start learns nothing new');

// ── the case from the floor ──────────────────────────────────────────────────
check(made(spg06) > 100, `the seeded shift really made pieces (${made(spg06)})`);
check(await same('SPG06', made(spg06)), 'SPG06: card, targets board and hourly bars all read the shift — a last reading with no counter erases nothing');
check(await same('NODATA01', made(nodata)), 'NODATA01: nor does a last reading with no data in it at all');

// ── two agents turn about ────────────────────────────────────────────────────
const k2 = (await counterKeys(['ALT01']))[0];
check(k2?.key === 'production_count' && k2.recovered, 'ALT01: the counter is found in the readings just before the newest');
check(made(alt) > 50 && await same('ALT01', made(alt)), 'ALT01: counted on every surface though both edges of the window are short readings');

// ── the PLC is off now ───────────────────────────────────────────────────────
check(await same('LATE01', made(late)), 'LATE01: a PLC that is off NOW no longer blanks an earlier shift on the board or the bars');
check(made(gap, GAP) > 50 && await same('GAP01', made(gap, GAP), GAP),
  'GAP01: off since yesterday and off at both edges of the window — still counted, at any time of day');

// ── the sweep's memory outlives anything a look-back could read ──────────────
// (A minute wider than OLD: the card's answer is cached per window for 30 s.)
check((await card('MEM01', [OLD[0] - 1, OLD[1]])).production === null, 'MEM01: before any reading has taught the name, a window with short edges cannot be read');
await recordProduction('MEM01', payload('F', -12_960), new Date());            // what the 30-second sweep does
for (let i = 0; i < 40 && !(await CounterKeyMemo.exists({ machineRef: 'MEM01' })); i += 1) await new Promise((r) => setTimeout(r, 50));
check(!!(await CounterKeyMemo.exists({ machineRef: 'MEM01', key: 'production_count' })), 'MEM01: one reading with the counter teaches the memory');
check(made(old, OLD) >= 8 && await same('MEM01', made(old, OLD), OLD), 'MEM01: and nine days of short readings later the machine still counts');
await rememberCounterKey('MEM01', 'older_name', true);
check((await counterKeys(['MEM01']))[0]?.key === 'production_count', 'MEM01: old data never overwrites the name the machine uses now');

// ── nothing changes where nothing was wrong ──────────────────────────────────
check(await same('NORM01', made(normal)), `NORM01: a healthy machine reads exactly as before (${made(normal)})`);
check(!(await counterKeys(['NORM01']))[0]?.recovered, 'NORM01: and its key is the one its newest reading names');

// ── "cannot count" stays "cannot count" ──────────────────────────────────────
const lost = (await counterKeys(['LOST01']))[0];
check(lost?.key === 'production_count' && lost.recovered, 'LOST01: the name is still known three days after the counter went');
const c5 = await card('LOST01');
check(c5.production === null && c5.productionKey === null, 'LOST01 card: but a window that never read it says "cannot count", not "made 0"');
check((await board('LOST01')) === null, 'LOST01 targets board: absent, as before');
check((await bars('LOST01')).key === null, 'LOST01 hourly bars: no counter — not eight hours of zero');
const c6 = await card('FURN01');
check(c6.production === null && (await board('FURN01')) === null && (await bars('FURN01')).key === null && (await counterKeys(['FURN01'])).length === 0,
  'FURN01: a machine with no counter anywhere still has none');
const c7 = await card('BOTTOMMILLING03');
check(c7.productionKey !== 'production_count' && (await counterKeys(['BOTTOMMILLING03'])).length === 0,
  'BOTTOMMILLING03: a stray register reading does not retire its derived rule');

await mongoose.disconnect();
await mem.stop();
console.log(bad ? `\nFAIL: ${bad}` : '\nALL OK');
process.exit(bad ? 1 : 0);
