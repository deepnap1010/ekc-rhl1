// server/src/controllers/reports.controller.ts
// READ-ONLY reporting over the real collections. One report remains
// server-side: reliability (MTBF / MTTR over a window). Production, downtime
// and the overview are read by the Reports page straight off
// /machines/activity — the Dashboard's dataset — so a report can never
// disagree with the screen it was printed from.
import type { PipelineStage } from 'mongoose';
import { Machine }       from '../models/Machine.js';
import { DowntimeEvent } from '../models/DowntimeEvent.js';
import { ok, asyncHandler } from '../utils/http.js';
import { computeActivity } from '../services/activity.service.js';
import { machineScope } from '../utils/scope.js';

type ScopedUser = { isSuperAdmin?: boolean; assignedMachines?: string[] };

/** The window a report covers. A page-level filter speaks in real edges — a
 *  "previous week" or "yesterday" cannot be said with "last N days" — so from/to
 *  win when given, and ?days= stays as the fallback every existing caller uses. */
function reportWindow(rq: Record<string, string | undefined>): { since: Date; until: Date; windowDays: number } {
  const parse = (v?: string): Date | null => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const from = parse(rq.from);
  const to = parse(rq.to);
  if (from && to && from < to) {
    const until = new Date(Math.min(to.getTime(), Date.now()));
    return { since: from, until, windowDays: Math.max(1, Math.round((until.getTime() - from.getTime()) / 86400000)) };
  }
  const windowDays = Math.min(Math.max(Number(rq.days) || 30, 1), 365);
  return { since: new Date(Date.now() - windowDays * 24 * 3600 * 1000), until: new Date(), windowDays };
}

// An explicit ?machineId= scopes a report to one machine ("Machine Report").
// The ref is resolved to BOTH its spellings (business `code` + raw `machineId`)
// so downtime rows keyed by either alias are found and scope checks accept
// either. Returns denied=true when the machine is outside the user's scope.
async function requestedMachine(
  q: Record<string, string | undefined>,
  scope: string[] | null
): Promise<{ refs: string[] | null; denied: boolean }> {
  const m = q.machineId && q.machineId !== 'all' ? q.machineId : null;
  if (!m) return { refs: null, denied: false };
  const doc = (await Machine.findOne({ $or: [{ code: m }, { machineId: m }] })
    .select({ code: 1, machineId: 1 }).lean()) as { code?: string; machineId?: string } | null;
  const refs = doc ? ([doc.code, doc.machineId].filter(Boolean) as string[]) : [m];
  if (scope && !refs.some((r) => scope.includes(r))) return { refs, denied: true };
  return { refs, denied: false };
}

// GET /reports/reliability — MTBF / MTTR / availability over a rolling window.
export const reliabilityReport = asyncHandler(async (req, res) => {
  const scope = machineScope(req.user as ScopedUser | undefined);
  const rq = req.query as Record<string, string | undefined>;
  const { refs, denied } = await requestedMachine(rq, scope);
  if (denied) return ok(res, { windowDays: 0, machines: [] });
  const sm = refs ? { machineId: { $in: refs } } : (scope ? { machineId: { $in: scope } } : {});
  const { since, until, windowDays } = reportWindow(rq);
  const windowMs = until.getTime() - since.getTime();

  // Operating time comes from the SHARED activity engine (time the machine
  // actually reported minus downtime) — never window-minus-spans, which
  // credited silent days as operating time and inflated availability/MTBF.
  const [act, agg] = await Promise.all([
    computeActivity(scope, since, until, refs),
    // Events OVERLAPPING the window — same semantics as the duration source
    // (computeActivity), or a boundary-crossing span contributes duration with
    // no event and MTTR explodes.
    DowntimeEvent.aggregate([
      { $match: {
        startedAt: { $lte: new Date() },
        $or: [{ endedAt: null }, { endedAt: { $gte: since } }],
        ...sm,
      } as PipelineStage.Match['$match'] },
      { $group: { _id: '$machineId', events: { $sum: 1 } } },
    ]),
  ]);
  const evBy = new Map<string, number>(agg.map((d) => [d._id as string, d.events as number]));

  const machines = act.rows
    .filter((r) => r.readings > 0 || r.idleMs + r.stoppedMs + r.offlineMs > 0)
    .map((r) => {
      const downtimeMs = r.idleMs + r.stoppedMs + r.offlineMs;
      const events = evBy.get(r.code) || 0;
      return {
        machineId: r.code, events, downtimeMs,
        availability: act.windowMs ? Math.round((r.runningMs / act.windowMs) * 1000) / 10 : 0,
        mttrMs: events ? Math.round(downtimeMs / events) : 0,
        mtbfMs: events ? Math.round(r.runningMs / events) : r.runningMs,
      };
    })
    .sort((a, b) => b.downtimeMs - a.downtimeMs);

  return ok(res, { windowDays, machines });
});
