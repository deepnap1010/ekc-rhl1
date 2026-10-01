// server/src/controllers/corrections.controller.ts
// The error-correction book (models/MachineCorrection): who may say what a
// machine really did over a period, and the rules a correction must keep.
//
// Permission is its own RBAC module — `corrections` — so the admin decides,
// on the Roles page, which roles may correct, see, and revoke; nobody has it
// until it is ticked (super admins have everything). Scope still applies: a
// corrector sees and corrects the machines assigned to them, or every
// machine when none are. Every creation and revocation is audited.
import { MachineCorrection, type CorrectionState } from '../models/MachineCorrection.js';
import { Machine } from '../models/Machine.js';
import { AuditLog } from '../models/AuditLog.js';
import { ok, fail, created, asyncHandler } from '../utils/http.js';
import { machineScope } from '../utils/scope.js';
import { refMatch, refIn } from '../utils/machineRef.js';
import { invalidateProductionReads } from '../utils/prodclass.js';
import { PROD_STEP_PER_MIN } from '../services/activity.service.js';
import type { AuthUser } from '../types/auth.js';

// The plant clock, for messages a person reads back against what they typed.
const ist = (d: Date): string => `${new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')} IST`;
// Check-then-insert, serialised per machine: two overlapping corrections
// posted together must not both pass the overlap check (one Node process —
// see utils/cache for the same assumption).
const inflight = new Map<string, Promise<unknown>>();

const DAY_MS = 86_400_000;
const MAX_PERIOD_MS = 31 * DAY_MS;      // a correction is a period, not a rewrite of history
const MAX_AGE_MS = 400 * DAY_MS;
const FUTURE_SLACK_MS = 5 * 60_000;     // clocks differ by seconds, not hours
const MAX_PIECES = 100_000;
const STATES: CorrectionState[] = ['running', 'idle', 'stopped'];

const audit = (user: AuthUser | undefined, action: string, id: string, label: string, before: unknown, after: unknown): void => {
  AuditLog.create({ at: new Date(), user: { id: String(user?._id || ''), name: user?.name || '' }, action, entity: { type: 'correction', id, label }, before, after })
    .catch(() => {});
};
const parseD = (v: unknown): Date | null => {
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The machine's code as the app uses it, if it exists and is in the caller's scope. */
async function resolveMachine(user: AuthUser | undefined, raw: unknown): Promise<string | null> {
  const ref = String(raw ?? '').trim();
  if (!ref) return null;
  const scope = machineScope(user);
  if (scope && !refIn(scope, ref)) return null;
  const m = await Machine.findOne({ $or: [{ code: refMatch(ref) }, { machineId: refMatch(ref) }] }).select({ code: 1, machineId: 1 }).lean();
  return m ? String(m.code || m.machineId || ref) : null;
}

// GET /corrections?machineId&from&to&revoked=1 — the book, newest first.
export const listCorrections = asyncHandler(async (req, res) => {
  const user = req.user as AuthUser | undefined;
  const q = req.query as Record<string, string | undefined>;
  const scope = machineScope(user);
  const filter: Record<string, unknown> = {};
  if (q.machineId && q.machineId !== 'all') {
    if (scope && !refIn(scope, q.machineId)) return ok(res, []);
    filter.machineRef = refMatch(q.machineId);
  } else if (scope) {
    filter.machineRef = { $in: scope.map(refMatch) };
  }
  const to = parseD(q.to) || new Date();
  const from = parseD(q.from) || new Date(to.getTime() - 30 * DAY_MS);
  filter.from = { $lt: to };
  filter.to = { $gt: from };
  if (q.revoked !== '1') filter.revokedAt = null;
  const rows = await MachineCorrection.find(filter).sort({ from: -1 }).limit(500).lean();
  return ok(res, rows);
});

// POST /corrections { machineRef, from, to, state?, pieces?, downtimeReason?, reason }
export const createCorrection = asyncHandler(async (req, res) => {
  const user = req.user as AuthUser | undefined;
  const b = req.body as Record<string, unknown>;
  const machineRef = await resolveMachine(user, b.machineRef);
  if (!machineRef) return fail(res, 404, 'Machine not found');
  const from = parseD(b.from), to = parseD(b.to);
  if (!from || !to) return fail(res, 400, 'from and to must be valid dates');
  const now = Date.now();
  if (to.getTime() <= from.getTime()) return fail(res, 400, 'The period must end after it starts');
  if (to.getTime() > now + FUTURE_SLACK_MS) return fail(res, 400, 'A correction describes the past — the period cannot end in the future');
  if (to.getTime() - from.getTime() > MAX_PERIOD_MS) return fail(res, 400, 'A correction covers at most 31 days');
  if (from.getTime() < now - MAX_AGE_MS) return fail(res, 400, 'A correction reaches back at most 400 days');
  const state = b.state == null || b.state === '' ? null : (b.state as CorrectionState);
  if (state !== null && !STATES.includes(state)) return fail(res, 400, 'state must be running, idle, stopped, or left as recorded');
  let pieces: number | null = null;
  if (b.pieces != null && b.pieces !== '') {
    pieces = Math.round(Number(b.pieces));
    if (!Number.isFinite(pieces) || pieces < 0 || pieces > MAX_PIECES) return fail(res, 400, `pieces must be a whole number from 0 to ${MAX_PIECES}`);
    // No faster than the counting engine itself believes a machine can go.
    const maxForPeriod = Math.ceil((to.getTime() - from.getTime()) / 60_000) * PROD_STEP_PER_MIN;
    if (pieces > maxForPeriod) return fail(res, 400, `${pieces} pieces in that period is faster than any machine here runs — at most ${maxForPeriod} (${PROD_STEP_PER_MIN} a minute)`);
  }
  if (state === null && pieces === null) return fail(res, 400, 'Say what the machine was doing, how many pieces it made, or both');
  const reason = String(b.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 200) return fail(res, 400, 'A reason of 3–200 characters is required');
  const downtimeReason = String(b.downtimeReason ?? '').trim().slice(0, 60);
  // Two corrections cannot both say what one hour was: revoke, then re-enter.
  const key = machineRef.toUpperCase();
  const run = (inflight.get(key) ?? Promise.resolve()).then(async () => {
    const clash = await MachineCorrection.findOne({ machineRef: refMatch(machineRef), revokedAt: null, from: { $lt: to }, to: { $gt: from } })
      .select({ from: 1, to: 1 }).lean();
    if (clash) return { clash };
    const doc = await MachineCorrection.create({
      machineRef, from, to, state, pieces, downtimeReason: state === 'running' || state === null ? '' : downtimeReason, reason,
      createdBy: { id: String(user?._id || ''), name: user?.name || '' }, createdAt: new Date(),
      revokedAt: null, revokedBy: null, revokeReason: '',
    });
    return { doc };
  });
  inflight.set(key, run.catch(() => undefined));
  const result = await run;
  if ('clash' in result && result.clash) {
    return fail(res, 409, `Overlaps a correction from ${ist(new Date(result.clash.from))} to ${ist(new Date(result.clash.to))} — revoke that one first`);
  }
  if (!('doc' in result) || !result.doc) return fail(res, 500, 'Could not record the correction');
  invalidateProductionReads();   // every cached figure that overlaps the period is now wrong
  audit(user, 'correction.create', String(result.doc._id), machineRef, null, result.doc.toObject());
  return created(res, result.doc.toObject());
});

// POST /corrections/:id/revoke { reason? } — the record stays, marked.
export const revokeCorrection = asyncHandler(async (req, res) => {
  const user = req.user as AuthUser | undefined;
  const doc = await MachineCorrection.findById(req.params.id).lean();
  if (!doc) return fail(res, 404, 'Correction not found');
  const scope = machineScope(user);
  if (scope && !refIn(scope, doc.machineRef)) return fail(res, 404, 'Correction not found');
  if (doc.revokedAt) return fail(res, 400, 'Already revoked');
  const revokeReason = String((req.body as { reason?: unknown })?.reason ?? '').trim().slice(0, 200);
  const r = await MachineCorrection.updateOne(
    { _id: doc._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedBy: { id: String(user?._id || ''), name: user?.name || '' }, revokeReason } },
  );
  if (r.modifiedCount > 0) {
    invalidateProductionReads();
    audit(user, 'correction.revoke', String(doc._id), doc.machineRef, doc, { revokeReason });
  }
  return ok(res, { revoked: r.modifiedCount > 0 });
});
