// client/src/hooks/useBuildWatch.ts
// A deploy used to end with "hard refresh the browser": every open screen
// kept the old bundle, calling endpoints that had moved, showing a page that
// no longer existed, until someone pressed Ctrl+Shift+R. The server stamps
// the build it serves into the page (<meta name="ekc-build">) and reports it
// on /health; this watches for the stamp to change and reloads — at a quiet
// moment: not while a dialog is open or someone is typing, and only when
// the tab is actually being looked at.
import { useEffect } from 'react';
import { toast } from '../store/toast';
import { modalsOpen } from '../components/Modal';

const CHECK_MS = 2 * 60_000;
const QUIET_RETRY_MS = 20_000;

const typing = (): boolean => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

export function useBuildWatch(): void {
  useEffect(() => {
    const mine = document.querySelector('meta[name="ekc-build"]')?.getAttribute('content') || '';
    if (!mine) return;   // the dev server stamps nothing
    let pending = false;
    const reloadWhenQuiet = (): void => {
      if (document.visibilityState !== 'visible' || modalsOpen() || typing()) { setTimeout(reloadWhenQuiet, QUIET_RETRY_MS); return; }
      location.reload();
    };
    const check = async (): Promise<void> => {
      if (pending || document.visibilityState !== 'visible') return;
      try {
        const r = await fetch('/health', { cache: 'no-store' });
        const j = (await r.json()) as { build?: string | null };
        if (j.build && j.build !== mine) {
          pending = true;
          toast.info('A new version of the app is ready — refreshing in a moment', 8_000);
          setTimeout(reloadWhenQuiet, 8_000);
        }
      } catch { /* the server is restarting — next check */ }
    };
    const i = setInterval(() => { void check(); }, CHECK_MS);
    const onWake = (): void => { void check(); };
    document.addEventListener('visibilitychange', onWake);
    return () => { clearInterval(i); document.removeEventListener('visibilitychange', onWake); };
  }, []);
}
