// server/src/controllers/config.controller.ts
// Shared config API. GET returns the stored global config, or the EKC seed
// defaults until an admin saves one — so behavior is identical before/after
// the first write. PUT upserts (settings.update permission, enforced in routes).
import { AppConfig, type IShift, type IStageTemplate } from '../models/AppConfig.js';
import { AuditLog } from '../models/AuditLog.js';
import { ok, fail, asyncHandler } from '../utils/http.js';
import { env } from '../config/env.js';
import { normalizeProdClass, invalidateProdClassCache, DEFAULT_PROD_CLASS, type ProdClassConfig } from '../utils/prodclass.js';

// A stored prodClass that fails today's rules (or was never saved) reads as
// the defaults — same before/after-first-write contract as every other field.
const prodClassOf = (raw: unknown): ProdClassConfig => {
  const norm = normalizeProdClass(raw);
  return typeof norm === 'string' ? DEFAULT_PROD_CLASS : norm;
};

// Canonical seeds (mirror the client's previous hard-coded lists).
const DEFAULTS: Record<string, unknown> & { shifts: IShift[]; products: string[]; processStages: string[]; stageTemplates: IStageTemplate[] } = {
  // The plant's real 8-hour rotation, confirmed against the machines' own SHIFT
  // field (B->C flips at 23:00, C->A at 07:00, and SHIFT_DATE rolls with A).
  // Guessed timings here are not harmless: a shift window that doesn't match the
  // PLC's silently attributes one shift's output to another.
  shifts: [
    { name: 'Shift A', start: '07:00', end: '15:00' },
    { name: 'Shift B', start: '15:00', end: '23:00' },
    { name: 'Shift C', start: '23:00', end: '07:00' },
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
  // The plant's stage flow, in order — mirrors lib/machineOrder's families.
  // defaultSec 0 = "not set", so no target is invented until an admin types one.
  stageTemplates: [
    { name: 'Cutting', defaultSec: 0 },
    { name: 'SPG', defaultSec: 0 },
    { name: 'Bottom Milling', defaultSec: 0 },
    { name: 'Furnace', defaultSec: 0 },
  ] as IStageTemplate[],
  prodClass: DEFAULT_PROD_CLASS,
};

const TIME_RE = /^\d{2}:\d{2}$/;

// GET /config — the shared lists every device uses.
export const getConfig = asyncHandler(async (_req, res) => {
  const doc = await AppConfig.findOne({ key: 'global' }).lean();
  return ok(res, {
    shifts: doc?.shifts?.length ? doc.shifts : DEFAULTS.shifts,
    breaks: doc?.breaks || [],
    stageTemplates: doc?.stageTemplates?.length ? doc.stageTemplates : DEFAULTS.stageTemplates,
    products: doc?.products?.length ? doc.products : DEFAULTS.products,
    processStages: doc?.processStages?.length ? doc.processStages : DEFAULTS.processStages,
    prodClass: prodClassOf(doc?.prodClass),
    stored: !!doc,
    // The client shows a banner and hides its edit controls on a review copy.
    readOnly: env.readOnly,
  });
});

// PUT /config — partial update; only supplied lists change.
export const updateConfig = asyncHandler(async (req, res) => {
  const body = req.body as {
    shifts?: IShift[]; products?: string[]; processStages?: string[];
    stageTemplates?: IStageTemplate[]; prodClass?: unknown;
  };
  const set: Record<string, unknown> = {};
  if (body.prodClass !== undefined) {
    const norm = normalizeProdClass(body.prodClass);
    if (typeof norm === 'string') return fail(res, 400, norm);
    set.prodClass = norm;
  }

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
  if (body.stageTemplates !== undefined) {
    if (!Array.isArray(body.stageTemplates) || body.stageTemplates.length > 100) {
      return fail(res, 400, 'stageTemplates must be a list of at most 100 entries');
    }
    const out: IStageTemplate[] = [];
    const seen = new Set<string>();
    for (const st of body.stageTemplates) {
      const name = String(st?.name ?? '').trim();
      const sec = Number(st?.defaultSec ?? 0);
      if (!name) return fail(res, 400, 'each stage needs a name');
      if (seen.has(name.toLowerCase())) return fail(res, 400, `duplicate stage "${name}"`);
      seen.add(name.toLowerCase());
      if (!Number.isFinite(sec) || sec < 0 || sec > 86_400) return fail(res, 400, 'stage time must be 0–86400 seconds');
      out.push({ name, defaultSec: Math.round(sec) });
    }
    set.stageTemplates = out;
  }
  if (!Object.keys(set).length) return fail(res, 400, 'Nothing to update');
  set.updatedBy = (req.user as { name?: string } | undefined)?.name || '';

  // Popup-rule changes are audited (who changed the timeout / options / default
  // matters when a classification is questioned later). Fire-and-forget — an
  // audit row must never be the reason a save fails.
  const before = set.prodClass !== undefined
    ? await AppConfig.findOne({ key: 'global' }).select({ prodClass: 1 }).lean()
        .then((d) => prodClassOf(d?.prodClass), () => null)
    : null;

  const doc = await AppConfig.findOneAndUpdate(
    { key: 'global' }, { $set: set }, { new: true, upsert: true }
  ).lean();
  if (set.prodClass !== undefined) {
    invalidateProdClassCache();
    const u = req.user as { _id?: unknown; name?: string } | undefined;
    AuditLog.create({
      at: new Date(), user: { id: String(u?._id || ''), name: u?.name || '' },
      action: 'settings.prodclass', entity: { type: 'config', label: 'Production classification rules' },
      before, after: set.prodClass,
    }).catch(() => {});
  }
  return ok(res, {
    shifts: doc.shifts, products: doc.products, processStages: doc.processStages,
    breaks: doc.breaks || [],
    stageTemplates: doc.stageTemplates?.length ? doc.stageTemplates : DEFAULTS.stageTemplates,
    prodClass: prodClassOf(doc.prodClass),
    stored: true,
  });
});
