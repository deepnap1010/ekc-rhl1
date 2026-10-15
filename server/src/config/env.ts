// server/src/config/env.ts
import dotenv from 'dotenv';
dotenv.config();

function required(key: string, fallback: string): string;
function required(key: string, fallback?: string): string | undefined;
function required(key: string, fallback?: string): string | undefined {
  const val = process.env[key] ?? fallback;
  if (val === undefined) {
    console.warn(`[env] Missing ${key}, app may misbehave`);
  }
  return val;
}

export interface Env {
  nodeEnv: string;
  port: number;
  mongoUri: string;
  dbName: string;
  // True on a deployment that only MIRRORS the plant (see middleware/readOnly).
  readOnly: boolean;
  jwtSecret: string;
  jwtExpiry: string;
  refreshExpiry: string;
  clientOrigin: string[];
  ingestKey: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  smtp: SmtpEnv;
}

// Outgoing mail, for the scheduled report emails (services/reportMail). Kept
// in the server's environment, never in the database or the browser: the
// password stays on the box that sends. No SMTP_HOST = mail is off — schedules
// can still be set up, and say so.
export interface SmtpEnv {
  host: string;
  port: number;
  secure: boolean;              // TLS from the first byte (465); otherwise STARTTLS
  user: string;
  pass: string;
  from: string;                 // "EKC SmartFactory <reports@company.com>"
  rejectUnauthorized: boolean;  // false only behind a firewall that re-signs TLS
}

const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10) || 587;

export const env: Env = {
  nodeEnv:  process.env.NODE_ENV || 'development',
  port:     parseInt(process.env.PORT || '5000', 10),

  mongoUri: required('MONGO_URI', 'mongodb://127.0.0.1:27017/test'),
  // Explicit target database. The real data lives in `test` on the EKC cluster.
  // Overrides any db path in the URI so we never accidentally hit the wrong DB.
  dbName:   process.env.DB_NAME || 'test',
  // READ_ONLY=1 on the cloud review copy; unset on the factory server.
  readOnly: /^(1|true|yes)$/i.test(process.env.READ_ONLY || ''),

  jwtSecret:    required('JWT_SECRET', 'dev-only-change-me'),
  jwtExpiry:    process.env.JWT_EXPIRY    || '12h',
  refreshExpiry: process.env.REFRESH_EXPIRY || '7d',

  clientOrigin: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(','),

  // Shared secret the data source / PLC agents send as `x-ingest-key` to POST /api/v1/ingest.
  // Empty = ingest disabled (fails closed). Set INGEST_KEY in .env to enable.
  ingestKey: process.env.INGEST_KEY || '',

  // First-access bootstrap admin. Used ONLY while the `users` collection is empty;
  // it issues a session without writing any document. As soon as you create real
  // users, this bootstrap auto-disables. See auth.controller.ts / middleware/auth.ts.
  adminName:     process.env.ADMIN_NAME     || 'Super Admin',
  adminEmail:    (process.env.ADMIN_EMAIL   || 'admin@ekc.in').toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',

  smtp: {
    host: (process.env.SMTP_HOST || '').trim(),
    port: smtpPort,
    secure: process.env.SMTP_SECURE ? /^(1|true|yes)$/i.test(process.env.SMTP_SECURE) : smtpPort === 465,
    user: (process.env.SMTP_USER || '').trim(),
    pass: process.env.SMTP_PASS || '',
    from: (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim(),
    rejectUnauthorized: !/^(0|false|no)$/i.test(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || ''),
  },
};
