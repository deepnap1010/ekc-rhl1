// server/src/utils/jwt.ts
import jwt from 'jsonwebtoken';
import type { SignOptions, JwtPayload as VerifiedPayload } from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { JwtPayload } from '../types/auth.js';

// env.jwtExpiry / env.refreshExpiry are validated strings like '12h' / '7d';
// jsonwebtoken accepts these as SignOptions['expiresIn'].
export const signAccessToken = (payload: JwtPayload): string =>
  jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiry } as SignOptions);

export const signRefreshToken = (payload: JwtPayload): string =>
  jwt.sign(payload, env.jwtSecret, { expiresIn: env.refreshExpiry } as SignOptions);

export const verifyToken = (token: string): JwtPayload =>
  jwt.verify(token, env.jwtSecret) as JwtPayload & VerifiedPayload;
