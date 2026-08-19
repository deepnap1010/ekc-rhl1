// server/src/controllers/config.controller.ts
// Shared config API. GET returns the stored global config, or the EKC seed
// defaults until an admin saves one — so behavior is identical before/after
// the first write. PUT upserts (settings.update permission, enforced in routes).
import { AppConfig, type IShift } from '../models/AppConfig.js';
import { ok, fail, asyncHandler } from '../utils/http.js';

// Canonical seeds (mirror the client's previous hard-coded lists).
const DEFAULTS = {
  shifts: [
    { name: 'Shift A', start: '06:00', end: '14:00' },
    { name: 'Shift B', start: '14:00', end: '22:00' },
    { name: 'Shift C', start: '22:00', end: '06:00' },
    { name: 'General', start: '09:00', end: '18:00' },
  ] as IShift[],
  // EXACTLY the client's historical seed lists (lib/machineConfig.ts) — values
  // operators saved per-machine must keep resolving to an option.
  products: [
    'CNG', 'Industrial Gas', 'Medical Oxygen', 'Fire Suppression', 'Hydrogen',
    'Breathing Air', 'Aluminium', 'Jumbo', 'Type-4 Composite',
  ],
  processStages: [
    'Billet Heating', 'Bottom Forming / Milling', 'Heat Treatment (Hardening + Tempering)',
    'Quenching', 'Machining', 'Neck Forming / Threading', 'Hydrostatic Testing', 'Inspection & Marking', 'Other',
  ],
};

const TIME_RE = /^\d{2}:\d{2}$/;

// GET /config — the shared lists every device uses.
export const getConfig = asyncHandler(async (_req, res) => {
  const doc = await AppConfig.findOne({ key: 'global' }).lean();
  return ok(res, {
    shifts: doc?.shifts?.length ? doc.shifts : DEFAULTS.shifts,
    products: doc?.products?.length ? doc.products : DEFAULTS.products,
    processStages: doc?.processStages?.length ? doc.processStages : DEFAULTS.processStages,
    stored: !!doc,
  });
});

// PUT /config — partial update; only supplied lists change.
export const updateConfig = asyncHandler(async (req, res) => {
  const body = req.body as { shifts?: IShift[]; products?: string[]; processStages?: string[] };
  const set: Record<string, unknown> = {};

  if (body.shifts !== undefined) {
    if (!Array.isArray(body.shifts) || body.shifts.length < 1 || body.shifts.length > 12) {
      return fail(res, 400, 'shifts must be a list of 1–12 entries');
    }
    for (const s of body.shifts) {
      if (!s?.name?.trim() || !TIME_RE.test(s.start || '') || !TIME_RE.test(s.end || '')) {
        return fail(res, 400, 'each shift needs a name and HH:MM start/end');
      }
    }
    set.shifts = body.shifts.map((s) => ({ name: s.name.trim(), start: s.start, end: s.end }));
  }
  const strList = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]).map((x) => x.trim()).filter(Boolean) : null;
  if (body.products !== undefined) {
    const list = strList(body.products);
    if (!list || list.length > 100) return fail(res, 400, 'products must be a list of strings');
    set.products = list;
  }
  if (body.processStages !== undefined) {
    const list = strList(body.processStages);
    if (!list || list.length > 100) return fail(res, 400, 'processStages must be a list of strings');
    set.processStages = list;
  }
  if (!Object.keys(set).length) return fail(res, 400, 'Nothing to update');
  set.updatedBy = (req.user as { name?: string } | undefined)?.name || '';

  const doc = await AppConfig.findOneAndUpdate(
    { key: 'global' }, { $set: set }, { new: true, upsert: true }
  ).lean();
  return ok(res, { shifts: doc.shifts, products: doc.products, processStages: doc.processStages, stored: true });
});
