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

// Express hands an IPv4 client on a dual-stack listener as
// "::ffff:192.168.2.236", while the .env will say "192.168.2.236". Compared in
// one shape so the address an admin copies out of the ingest log is the value
// that works in the config — the two must never differ by a prefix nobody sees.
export const normalizeAddr = (raw: string | undefined | null): string => {
  const s = String(raw ?? '').trim().toLowerCase();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
};

// ── which address may post as which machine ─────────────────────────────────
// SPG07 has been posted by FOUR addresses (192.168.2.236, .2.221, .0.72,
// .0.41) and SPG08 by four more, with the same boxes appearing under several
// names at once: 192.168.2.221 posts as SPG08, SPG07 and CUTTINGMACHINE04.
// Under one machineId they overwrite each other's status and counter on every
// reading, and no amount of reading the payload can tell them apart — the
// payload cannot say which box sent it. The connection can.
//
//   INGEST_BIND=SPG07=192.168.2.236;SPG08=192.168.2.221
//
// Entries are separated by ';', and one machine may list several addresses
// with ','. Only machines NAMED here are policed; every other machine ingests
// exactly as before. That default is the point: one typo in this line must not
// be able to black out a floor of nineteen machines.
//
// This is a misconfiguration guard, not a security control. The app sits behind
// Apache with `trust proxy 1`, so req.ip can be set by an X-Forwarded-For
// header — anything holding the ingest key could still post under any name it
// likes. It is here to stop collectors that are wrong, not collectors that lie.
function parseIngestBind(raw: string): Map<string, Set<string>> {
  const bind = new Map<string, Set<string>>();
  for (const entry of raw.split(';')) {
    const at = entry.indexOf('=');
    if (at < 0) continue;
    const id = entry.slice(0, at).trim().toUpperCase();
    const addrs = new Set(
      entry.slice(at + 1).split(',').map(normalizeAddr).filter(Boolean),
    );
    // An entry naming a machine but no usable address is dropped rather than
    // read as "nothing may post as this machine": a trailing "SPG07=" in a
    // hand-edited .env would otherwise silence the machine it was meant to fix.
    if (id && addrs.size) bind.set(id, addrs);
  }
  return bind;
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
  // machineId (upper case) → the addresses allowed to post as it. Absent = unpoliced.
  ingestBind: Map<string, Set<string>>;
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

  // Pin a machine to the collector that is really its own. See parseIngestBind.
  ingestBind: parseIngestBind(process.env.INGEST_BIND || ''),

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

// Printed once at boot, so "is the pin actually live?" is answered by `pm2 logs`
// rather than by guessing whether the .env was saved before the restart.
if (env.ingestBind.size) {
  const lines = [...env.ingestBind].map(([m, a]) => `${m} <- ${[...a].join(', ')}`);
  console.log(`[env] INGEST_BIND active — ${lines.join(' | ')}`);
}
