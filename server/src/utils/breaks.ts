// server/src/utils/breaks.ts
// The plant's planned daily pauses (lunch, tea) — set on the Production
// Targets page, kept in app_config.breaks as HH:MM on the plant clock.
// Targets have always excluded them; the downtime-reason ask does too: a
// machine standing still through lunch is not a stop anyone has to explain,
// so the ask-after mark is measured on the time OUTSIDE the breaks.
import { AppConfig, type IBreak } from '../models/AppConfig.js';

const IST_MS = 5.5 * 3_600_000;
const DAY = 24 * 3_600_000;

/** Overlap of [s, e) with the plant's DAILY break windows (HH:MM, IST). A break
 *  whose end precedes its start wraps midnight. */
export function breakOverlapMs(s: number, e: number, breaks: Pick<IBreak, 'start' | 'end'>[]): number {
  if (!breaks.length || e <= s) return 0;
  const hm = (v: string): number => {
    const [h, m] = v.split(':').map(Number);
    return (h * 60 + (m || 0)) * 60_000;
  };
  let sum = 0;
  // Check each break on the interval's own IST day and its neighbours (wraps).
  const base0 = Math.floor((s + IST_MS) / DAY) * DAY - IST_MS;
  for (const base of [base0 - DAY, base0, base0 + DAY]) {
    for (const b of breaks) {
      const bs = base + hm(b.start);
      let be = base + hm(b.end);
      if (be <= bs) be += DAY;
      sum += Math.max(0, Math.min(be, e) - Math.max(bs, s));
    }
  }
  return sum;
}

/** A stop's length with the planned breaks taken out — what the ask-after
 *  mark is held against. */
export const askableMs = (s: number, e: number, breaks: Pick<IBreak, 'start' | 'end'>[]): number =>
  Math.max(0, e - s - breakOverlapMs(s, e, breaks));

// ── cached read ──────────────────────────────────────────────────────────────
// The queue is polled every 30 s per open screen; the break schedule changes
// when someone edits it. Never throws: no schedule reads as no breaks.
const CACHE_MS = 30_000;
let cache: { at: number; breaks: IBreak[] } | null = null;
export async function loadBreaks(): Promise<IBreak[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.breaks;
  let breaks: IBreak[] = [];
  try { breaks = (await AppConfig.findOne({ key: 'global' }).select({ breaks: 1 }).lean())?.breaks || []; } catch { /* DB hiccup → no breaks */ }
  cache = { at: Date.now(), breaks };
  return breaks;
}
export function invalidateBreaksCache(): void { cache = null; }
