// Augments Express's Request so `req.user` is typed everywhere without casting.
// `req.user` is populated by the `authenticate` middleware and is either a
// lean User document (with its `role` populated) or the synthetic bootstrap user.
import type { AuthUser } from './auth.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
