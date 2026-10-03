// client/src/components/Guard.tsx
import { useEffect, type ReactElement, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { authApi } from '../api/endpoints';
import { useSessionRenewal } from '../hooks/useSessionRenewal';

interface RequireAuthProps {
  children: ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps): ReactElement {
  const token = useAuthStore((s) => s.accessToken);
  const setUser = useAuthStore((s) => s.setUser);
  // The session renews itself before its token runs out (and on waking).
  useSessionRenewal();

  // Re-hydrate the signed-in user from the server on entry, so a session that was
  // cached at login (and persisted in localStorage) picks up fields that may have
  // changed since — e.g. a profile photo or display name added later. This is what
  // lets the sidebar avatar appear without forcing a re-login. A 401 (expired/invalid
  // token) is handled by the axios interceptor, which clears the session → the
  // redirect below sends the user to /login; other (transient) errors keep the cache.
  //
  // What a person may do can also change WHILE they are signed in — the admin
  // ticks or unticks a box for their role. The server enforces that at once;
  // this brings the screen along without a reload: once a minute while the tab
  // is in front, and when it comes back. Nothing is touched unless it changed.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let last = 0;
    const load = (): void => {
      last = Date.now();
      authApi.me()
        .then((res) => {
          if (cancelled) return;
          if (JSON.stringify(useAuthStore.getState().user) !== JSON.stringify(res.data)) setUser(res.data);
        })
        .catch(() => { /* keep the cached session on transient errors */ });
    };
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60_000);
    const onWake = (): void => { if (document.visibilityState === 'visible' && Date.now() - last > 30_000) load(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [token, setUser]);

  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

interface RequirePermissionProps {
  module: string;
  children: ReactNode;
}

export function RequirePermission({ module, children }: RequirePermissionProps): ReactElement {
  const can = useAuthStore((s) => s.can);
  if (!can(module)) {
    return (
      <div className="flex items-center justify-center h-full text-steel text-sm">
        You don't have access to this page.
      </div>
    );
  }
  return <>{children}</>;
}
