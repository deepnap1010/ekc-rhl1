// server/src/controllers/ingest.controller.ts
// POST /api/v1/ingest — the data source (PLC agents / middleware) pushes real
// readings here over HTTP. Guarded by the `x-ingest-key` header (env.INGEST_KEY).
// Each reading is stored as a telemetry document and folded into the machine's
// latest snapshot; the server's change streams then push it live to every client.
// This ONLY persists what the source sends — it never fabricates data.
import type { AnyBulkWriteOperation } from 'mongoose';
import { Machine, type IMachine } from '../models/Machine.js';
import { Telemetry } from '../models/Telemetry.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { normalizeStatus, linkIsDown } from '../utils/status.js';
import { statusFromData } from '../utils/production.js';
import { flattenData } from '../utils/flatten.js';
import { env, normalizeAddr } from '../config/env.js';

interface Reading {
  machineId?: string;
  code?: string;
  machineName?: string;
  name?: string;
  machineType?: string;
  type?: string;
  status?: string;
  timestamp?: string | number | Date;
  data?: Record<string, unknown>;
}

// ── who posts as whom ───────────────────────────────────────────────────────
// Three machines have already been caught carrying TWO devices each: a second
// collector posting under the same machineId, the pair overwriting each other's
// status and counter every second — CUTTINGMACHINE08 read idle while it cut,
// and finding the second box took a day of queries. The payload cannot say
// which address it came from; the connection can. The first sighting of every
// machineId↔address pair is logged once, and a machineId acquiring a SECOND
// address is called out loudly, because that is exactly the duplicate-device
// signature. Restart re-announces the pairs — one line each, useful, not spam.
const SOURCES = new Map<string, Set<string>>();
function noteSource(id: string, ip: string | undefined): void {
  if (!ip) return;
  let seen = SOURCES.get(id);
  if (!seen) SOURCES.set(id, (seen = new Set()));
  if (seen.has(ip)) return;
  seen.add(ip);
  if (seen.size > 1) {
    console.warn(`[ingest] DUPLICATE SOURCE: ${id} now posts from ${[...seen].join(' AND ')} — two devices under one machineId overwrite each other's status and counter. Give one of them its own --machine.`);
  } else {
    console.log(`[ingest] ${id} posts from ${ip}`);
  }
}

// A machine pinned in INGEST_BIND takes readings only from its own address.
// Everything NOT named there is unpoliced and ingests exactly as before.
function sourceAllowed(id: string, ip: string): boolean {
  const allowed = env.ingestBind.get(id.toUpperCase());
  return !allowed || allowed.has(ip);
}

// A refused box does not stop sending because we stopped listening — the one
// posting as SPG07 floods at nine readings a second, which is 777,000 log lines
// a day if each is announced. The first is said plainly, then a rollup every
// five minutes carrying the count, so the line stays visible in `pm2 logs`
// without burying everything else in it.
const REFUSED = new Map<string, { n: number; at: number }>();
const REFUSE_ROLLUP_MS = 5 * 60_000;
function noteRefusal(id: string, ip: string): void {
  const key = `${id}|${ip}`;
  const now = Date.now();
  const rec = REFUSED.get(key);
  if (!rec) {
    REFUSED.set(key, { n: 1, at: now });
    console.warn(`[ingest] REFUSED: ${id} from ${ip || 'an unknown address'} — not an address bound to that machine (INGEST_BIND). Reading dropped.`);
    return;
  }
  rec.n++;
  if (now - rec.at >= REFUSE_ROLLUP_MS) {
    console.warn(`[ingest] REFUSED: ${id} from ${ip} — ${rec.n} readings dropped in the last ${Math.round((now - rec.at) / 60_000)} min.`);
    rec.n = 0;
    rec.at = now;
  }
}

// How long a reading that COULD see the machine goes on speaking for it.
//
// On 2026-11-27 one box, 192.168.2.236, was found sending two feeds under the
// name SPG07, 0.4 seconds apart: a real one (prod 65, running 11574, idle
// 12916 — a machine idle for 55 minutes) and a process stuck since 17 November
// replaying a frozen snapshot (prod 24, running 6804, idle 60554, elapsed
// 6284, byte-identical for ten days) at 523 readings a minute against the real
// feed's 11. The frozen one wins every race simply by being louder, so the
// machine document read `offline`, the downtime sweep turned that into spans,
// and the card said "signal lost 2h 47m" about a machine we could see once a
// minute the whole time.
//
// The rule underneath is not about SPG07: a reading whose collector could not
// reach the machine carries no fact about the machine, and something that
// knows nothing must not be allowed to overwrite something that knows. So
// while a live reading is recent, a blind one updates only the fields that are
// about the COLLECTOR — it still arrived, it is still blind, both are stamped
// — and leaves status and the parameter snapshot alone. Once the live feed
// itself goes quiet for this long, the blind readings are all we have and they
// take over exactly as before.
//
// Five minutes: the real feed polls once a minute, so this survives four
// missed polls before conceding, while a machine that truly goes dark still
// falls to Signal Lost well inside the 10-minute silence rule.
const LIVE_GRACE_MS = 5 * 60_000;

export const ingest = asyncHandler(async (req, res) => {
  // Fail closed: no key configured, or a wrong/absent header → reject.
  // Accept x-ingest-key OR x-api-key (the JCI-style header) so JCI integrations are drop-in.
  const providedKey = req.get('x-ingest-key') || req.get('x-api-key');
  if (!env.ingestKey || providedKey !== env.ingestKey) {
    return fail(res, 401, 'Invalid or missing x-ingest-key (or x-api-key)');
  }

  // Accept either one reading or an array of readings.
  const body = req.body as Reading | Reading[];
  const readings = Array.isArray(body) ? body : [body];
  if (!readings.length) return fail(res, 400, 'No readings provided');

  const now = new Date();
  const telemetry: Record<string, unknown>[] = [];
  const machineOps: AnyBulkWriteOperation<IMachine>[] = [];
  let refused = 0;
  const refusedWho = new Set<string>();

  for (const r of readings) {
    const id = String(r.machineId || r.code || '').trim();
    if (!id) return fail(res, 400, 'Each reading requires a machineId (or code)');
    const from = normalizeAddr(req.ip);
    noteSource(id, from);
    // Dropped per READING, not per request: a batch carrying several machines
    // keeps the ones whose source is right instead of losing good data because
    // one entry in it came from the wrong box.
    if (!sourceAllowed(id, from)) {
      noteRefusal(id, from);
      refused++;
      refusedWho.add(`${id} from ${from || 'an unknown address'}`);
      continue;
    }
    const ts = r.timestamp ? new Date(r.timestamp) : now;
    const data = r.data && typeof r.data === 'object' ? r.data : {};
    const name = r.name || r.machineName;
    const type = r.type || r.machineType;

    // The status belongs to the READING as much as to the machine. It used to be
    // written only onto the machine document, where a single scalar keeps just
    // the latest value — so for every collector that sends its status beside the
    // payload rather than inside it, the history had no per-minute state at all
    // and the timeline fell back to reconstructing one from downtime spans.
    // The top level first, always — a collector that states its status beside
    // the payload is answering the question directly. Only when it sends none
    // do we look inside, where NECKDRILLING1 keeps its `run-status`. The
    // flatten is paid by that one machine: every other collector takes the
    // first branch and never reaches it.
    const reported = r.status
      ? normalizeStatus(r.status)
      : normalizeStatus(statusFromData(flattenData(data)));
    // A collector that cannot reach the PLC is not reporting the MACHINE's
    // state, it is reporting its own blindness — and the rest of the payload
    // goes stale with it. On 2026-11-26 SPG07's totals and state_elapsed came
    // back byte-identical to the values it last sent on 2026-11-17: a nine-day
    // old snapshot, republished nine times a second. Stored as the collector's
    // own word that reads as 110,407 readings of "stopped" in one shift, which
    // is downtime the machine never had, on a machine that was making pieces.
    // We book it as offline — no data, which is exactly what it is, and which
    // b2e68f2 already keeps out of downtime. The collector's own word is kept
    // beside it rather than discarded, so nothing is lost by the swap.
    const blind = linkIsDown(data);
    const status = blind ? 'offline' : reported;
    telemetry.push({ machineId: id, machineName: name, machineType: type, timestamp: ts, receivedAt: now, data, ...(status ? { status } : {}), ...(blind && reported ? { reportedStatus: reported } : {}) });

    const filter = { $or: [{ code: id }, { machineId: id }] };

    if (!blind) {
      const set: Partial<IMachine> = {
        machineId: id, code: id, currentParameters: data,
        lastReadingAt: ts, lastSeenAt: now,
        // The stamp the blind branch below reads. Written on every reading that
        // could see the machine, whatever it saw.
        lastLiveReadingAt: now,
      };
      if (name) set.name = name;
      if (type) set.type = type;
      // Canonicalised once, here, so every reader downstream — downtime engine,
      // fleet counts, health, the client's pill — gets one spelling instead of
      // each guessing.
      if (status) set.status = status;
      machineOps.push({ updateOne: { filter, update: { $set: set }, upsert: true } });
    } else {
      // linkLastSilentAt is stamped on every blind reading below. The client
      // holds "Signal Lost" for two minutes after the last one, so a link
      // dropping in and out hundreds of times a minute reads as one steady
      // sentence rather than a pill flipping between Running and Offline every
      // few seconds.
      //
      // An aggregation-pipeline update so the DATABASE decides, against the
      // stamp it already holds. The alternative — read the machine, compare,
      // then write — opens a window at nine readings a second in which the one
      // live reading per minute lands between the read and the write and is
      // thrown away by the very rule meant to protect it.
      const liveRecent = { $gt: ['$lastLiveReadingAt', new Date(now.getTime() - LIVE_GRACE_MS)] };
      // $literal on every payload-derived value: inside a pipeline a bare
      // string is an EXPRESSION, so a name or a payload key beginning with '$'
      // would be read as a field path instead of stored. A missing
      // lastLiveReadingAt compares false, so an upsert and a machine that has
      // never been seen alive both fall through to the old behaviour.
      machineOps.push({
        updateOne: {
          filter,
          update: [{
            $set: {
              machineId: { $literal: id }, code: { $literal: id },
              ...(name ? { name: { $literal: name } } : {}),
              ...(type ? { type: { $literal: type } } : {}),
              lastReadingAt: ts, lastSeenAt: now, linkLastSilentAt: now,
              status: { $cond: [liveRecent, '$status', 'offline'] },
              currentParameters: { $cond: [liveRecent, '$currentParameters', { $literal: data }] },
            },
          }],
          upsert: true,
        },
      });
    }
  }

  // Every reading in this request came from a box that is not bound to the
  // machine it claims. Say so with a 403 rather than answering 200 to a sender
  // whose every reading we are dropping — a collector told nothing goes on
  // believing it is feeding the floor. A MIXED batch still succeeds below and
  // reports the count, so one wrong entry never costs the right ones.
  //   This also keeps both arrays non-empty at the writes: each reading either
  //   fails the 400 above, is refused here, or lands in both.
  if (!telemetry.length && refused) {
    return fail(res, 403, `Refused ${refused} reading(s): ${[...refusedWho].join('; ')} — see INGEST_BIND.`);
  }

  await Telemetry.insertMany(telemetry, { ordered: false });
  await Machine.bulkWrite(machineOps, { ordered: false });
  return ok(res, { ingested: telemetry.length, ...(refused ? { refused } : {}) });
});
