// client/src/components/Guard.tsx
import { useEffect, type ReactElement, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { authApi } from '../api/endpoints';

interface RequireAuthProps {
  children: ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps): ReactElement {
  const token = useAuthStore((s) => s.accessToken);
  const setUser = useAuthStore((s) => s.setUser);

  // Re-hydrate the signed-in user from the server on entry, so a session that was
  // cached at login (and persisted in localStorage) picks up fields that may have
  // changed since — e.g. a profile photo or display name added later. This is what
  // lets the sidebar avatar appear without forcing a re-login. A 401 (expired/invalid
  // token) is handled by the axios interceptor, which clears the session → the
  // redirect below sends the user to /login; other (transient) errors keep the cache.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    authApi.me()
      .then((res) => { if (!cancelled) setUser(res.data); })
      .catch(() => { /* keep the cached session on transient errors */ });
    return () => { cancelled = true; };
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
