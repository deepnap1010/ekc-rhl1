// server/src/utils/scope.ts
// Row-level machine visibility. A user's `assignedMachines` scopes which machines
// they can see:
//   • Super admins               → no restriction (see everything)
//   • non-empty assignedMachines → restricted to exactly those machineIds
//   • empty assignedMachines     → no restriction (see everything)
// Enforced on the backend so it can't be bypassed by calling the API directly.

interface ScopedUser {
  isSuperAdmin?: boolean;
  assignedMachines?: string[];
}

// Returns null when unrestricted, or an array of allowed machineIds.
export function machineScope(user?: ScopedUser | null): string[] | null {
  if (!user || user.isSuperAdmin) return null;
  const list = Array.isArray(user.assignedMachines) ? user.assignedMachines : [];
  return list.length ? list : null;
}
