// server/src/utils/jwt.ts
import jwt from 'jsonwebtoken';
import type { SignOptions, JwtPayload as VerifiedPayload } from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { JwtPayload } from '../types/auth.js';

// env.jwtExpiry / env.refreshExpiry are validated strings like '12h' / '7d';
// jsonwebtoken accepts these as SignOptions['expiresIn'].
//
// `neverExpires` omits the exp claim entirely, so the token stays valid for as
// long as it exists. That is for MACHINE TERMINALS only: a tablet bolted to one
// machine, showing one machine, that nobody should have to sign back into
// mid-shift. It is still revocable — middleware/auth loads the user on EVERY
// request and refuses an inactive one, so switching the account off logs that
// terminal out on its next call, token or no token.
export const signAccessToken = (payload: JwtPayload, neverExpires = false): string =>
  jwt.sign(payload, env.jwtSecret, (neverExpires ? {} : { expiresIn: env.jwtExpiry }) as SignOptions);

export const signRefreshToken = (payload: JwtPayload, neverExpires = false): string =>
  jwt.sign(payload, env.jwtSecret, (neverExpires ? {} : { expiresIn: env.refreshExpiry }) as SignOptions);

export const verifyToken = (token: string): JwtPayload =>
  jwt.verify(token, env.jwtSecret) as JwtPayload & VerifiedPayload;
