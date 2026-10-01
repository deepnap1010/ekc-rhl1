// client/src/hooks/useSessionRenewal.ts
// Keep the session alive without anyone noticing. The access token's own
// expiry is read from the token; ten minutes before it the pair is renewed
// (api/client#renewSession), and again whenever the tab wakes up — a PC
// that slept through the night comes back with a token about to expire, or
// expired, and must not land on the sign-in page. A renewal that failed only
// because the server was away (a deploy) is retried a minute later. An
// operator's token has no expiry and nothing here ever fires for it.
import { useEffect } from 'react';
import { useAuthStore } from '../store/auth';
import { renewSession } from '../api/client';

const LEAD_MS = 10 * 60_000;
const RETRY_MS = 60_000;

/** When this JWT expires (ms since epoch), or null when it never does. */
export function tokenExpiry(token: string | null | undefined): number | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch { return null; }
}

export function useSessionRenewal(): void {
  const token = useAuthStore((s) => s.accessToken);
  useEffect(() => {
    const exp = tokenExpiry(token);
    if (!token || exp == null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const renew = (): void => {
      void renewSession().then((r) => {
        // 'ok' swaps the token and this effect re-arms on the new one.
        if (r === 'offline') timer = setTimeout(renew, RETRY_MS);
      });
    };
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      // setTimeout caps at ~24.8 days; a 12-hour token is well inside.
      timer = setTimeout(renew, Math.max(1_000, exp - LEAD_MS - Date.now()));
    };
    const onWake = (): void => {
      if (document.visibilityState === 'visible' && Date.now() >= exp - LEAD_MS) renew();
    };
    arm();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [token]);
}
