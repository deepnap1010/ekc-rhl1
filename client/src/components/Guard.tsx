// client/src/components/Guard.tsx
import type { ReactElement, ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';

interface RequireAuthProps {
  children: ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps): ReactElement {
  const token = useAuthStore((s) => s.accessToken);
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
