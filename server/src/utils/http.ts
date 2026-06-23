// server/src/utils/http.ts
// Consistent envelope so the frontend always parses the same shape.
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export const ok = <T>(res: Response, data: T, meta?: unknown): Response =>
  res.json({ success: true, data, ...(meta ? { meta } : {}) });

export const created = <T>(res: Response, data: T): Response =>
  res.status(201).json({ success: true, data });

export const fail = (
  res: Response,
  status: number,
  message: string,
  details?: unknown,
): Response =>
  res.status(status).json({ success: false, error: { message, details } });

// Wrap async controllers so we never forget try/catch
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// Narrow an unknown thrown value to a human-readable message.
export const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
