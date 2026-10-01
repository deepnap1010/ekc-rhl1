// client/src/hooks/useNoticeFeed.ts
// The 'notify' mode of the notification workflow: the same queue the popup
// polls, announced as ONE quiet toast per poll for whatever is new, nothing
// to answer, nothing written. The first poll seeds silently — a plant head
// switched to notices at 15:00 is not told about the morning's queue — and
// the seen set lives in memory only, so a reload re-seeds silently too:
// nothing old is ever repeated, a notice is only ever about what just
// happened.
// The person's own "In-app toasts" preference (Settings → Profile) is the
// one switch that silences notices on this device without touching the
// admin's workflow.
import { useEffect, useRef } from 'react';
import { toast } from '../store/toast';
import { useSettings } from '../lib/settings';

const NOTICE_MS = 12_000;

export function useNoticeFeed<T extends { _id: string }>(
  rows: T[] | undefined, active: boolean, announce: (fresh: T[]) => string | null,
): void {
  const inApp = useSettings().notifications.inApp;
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!active || !rows) return;
    if (!seen.current) { seen.current = new Set(rows.map((r) => r._id)); return; }
    const fresh = rows.filter((r) => !seen.current!.has(r._id));
    if (!fresh.length) return;
    for (const r of fresh) seen.current.add(r._id);
    if (!inApp) return;
    const msg = announce(fresh);
    if (msg) toast.info(msg, NOTICE_MS);
  }, [rows, active]); // eslint-disable-line react-hooks/exhaustive-deps
}
