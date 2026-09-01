// server/src/app.ts
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { notFound, errorHandler } from './middleware/error.js';
import { readOnlyGuard } from './middleware/readOnly.js';

export function createApp(): Express {
  const app = express();
  // Behind Apache reverse proxy (1 hop) — trust its X-Forwarded-* so req.ip and the
  // auth rate-limiter see the real client IP, not Apache's 127.0.0.1.
  app.set('trust proxy', 1);

  // CSP disabled so the bundled SPA (its scripts/styles/fonts) loads when this server
  // also serves the client (single-service deploy). Helmet's other protections stay on.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: env.clientOrigin, credentials: true }));
  app.use(compression());                 // gzip responses -> faster transfer
  app.use(express.json({ limit: '1mb' }));
  if (env.nodeEnv === 'development') app.use(morgan('dev'));

  // Rate limit only the auth + ingest surface
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
  app.use('/api/v1/auth', authLimiter);

  app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), readOnly: env.readOnly }));
  // Before the routes: a review copy refuses every write, whatever the route.
  app.use('/api/v1', readOnlyGuard, routes);

  // Single-service hosting (e.g. Render): when the client has been built, serve its
  // static bundle + SPA fallback so the whole app runs from ONE origin — API,
  // socket.io and UI are same-origin (no CORS). In local dev the client runs on Vite
  // (port 5173) and this block is skipped because client/dist doesn't exist.
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // Any non-API, non-socket GET → index.html (React Router handles the route).
    app.get(/^(?!\/(api|health|socket\.io)).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
