// server/src/middleware/readOnly.ts
// Marks a deployment as a REVIEW COPY: you can look, you cannot change.
//
// Two deployments of this app run against two databases. The factory server is
// the source of truth — the PLCs post there, the operators work there, and the
// data stays. The cloud one exists so the site can be watched from outside, and
// it is fed by scripts/sync-to-atlas.mjs, which mirrors the factory wholesale.
//
// That mirroring is exactly why the cloud copy must not take writes. A dia
// assigned, a machine renamed or an operator set from outside would live in the
// review copy for a few minutes and then be silently overwritten by the next
// sync — the worst kind of bug, because it looks like it worked. Better to
// refuse the change and say where to make it.
//
// Enabled with READ_ONLY=1 in the cloud deployment's environment. Unset
// everywhere else, so the factory server is unaffected.
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Signing in writes a refresh token, and someone has to sign in to look at
// anything. These stay open; everything else that writes does not.
const ALLOWED = [/^\/auth\/login$/, /^\/auth\/refresh$/, /^\/auth\/logout$/];

export function readOnlyGuard(req: Request, res: Response, next: NextFunction): void {
  if (!env.readOnly || !MUTATING.has(req.method)) return next();
  if (ALLOWED.some((re) => re.test(req.path))) return next();
  res.status(403).json({
    success: false,
    error: {
      message: 'This is the review copy — it mirrors the plant and is refreshed from it, '
        + 'so a change made here would be overwritten. Make it on the plant dashboard.',
      code: 'READ_ONLY',
    },
  });
}
