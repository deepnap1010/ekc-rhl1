// server/src/middleware/error.ts
import type { Request, Response, ErrorRequestHandler } from 'express';
import { fail } from '../utils/http.js';
import { env } from '../config/env.js';

// Structural view of the errors this handler inspects (Zod, Mongoose validation,
// duplicate-key, and generic HTTP errors). All fields are optional at the boundary.
interface AppError {
  name?: string;
  message?: string;
  stack?: string;
  status?: number;
  code?: number | string;
  keyValue?: unknown;
  errors?: unknown;
}

export function notFound(req: Request, res: Response): Response {
  return fail(res, 404, `Route not found: ${req.method} ${req.originalUrl}`);
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const e = err as AppError;
  console.error('[error]', e.message);

  if (e.name === 'ZodError') {
    return fail(res, 422, 'Validation failed', e.errors);
  }
  if (e.name === 'ValidationError') {
    const errors = (e.errors ?? {}) as Record<string, { message?: string }>;
    return fail(res, 422, 'Validation failed', Object.values(errors).map((v) => v.message));
  }
  if (e.code === 11000) {
    return fail(res, 409, 'Duplicate entry', e.keyValue);
  }

  const status = e.status || 500;
  return fail(res, status, e.message || 'Internal server error',
    env.nodeEnv === 'development' ? e.stack : undefined);
};
