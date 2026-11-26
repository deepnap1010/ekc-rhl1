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
import { env } from '../config/env.js';

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

  for (const r of readings) {
    const id = String(r.machineId || r.code || '').trim();
    if (!id) return fail(res, 400, 'Each reading requires a machineId (or code)');
    noteSource(id, req.ip);
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

    const set: Partial<IMachine> = { machineId: id, code: id, currentParameters: data, lastReadingAt: ts, lastSeenAt: now };
    if (name) set.name = name;
    if (type) set.type = type;
    // Canonicalised once, here, so every reader downstream — downtime engine,
    // fleet counts, health, the client's pill — gets one spelling instead of
    // each guessing.
    if (status) set.status = status;
    machineOps.push({ updateOne: { filter: { $or: [{ code: id }, { machineId: id }] }, update: { $set: set }, upsert: true } });
  }

  await Telemetry.insertMany(telemetry, { ordered: false });
  await Machine.bulkWrite(machineOps, { ordered: false });
  return ok(res, { ingested: telemetry.length });
});
