// Read-only probe: build the review workbook against the configured database
// without starting the app (no sweep, no watchers — nothing is written).
// Run from server/:  npx tsx src/utils/export.probe.ts <from-ISO> <to-ISO> [out.xlsx] [machineId]
import { writeFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { exportWorkbook } from '../controllers/export.controller.js';

const [from, to, out = 'export-probe.xlsx', machineId] = process.argv.slice(2);
if (!from || !to) { console.error('usage: export.probe.ts <from-ISO> <to-ISO> [out.xlsx] [machineId]'); process.exit(2); }

await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 15_000 });
console.log(`[probe] connected → ${mongoose.connection.name}`);

const headers: Record<string, string> = {};
let sent: Buffer | null = null;
const res = {
  setHeader: (k: string, v: string) => { headers[k] = v; },
  status: (code: number) => { console.log('[probe] status', code); return res; },
  json: (body: unknown) => { console.log('[probe] json', JSON.stringify(body)); return res; },
  send: (body: Buffer) => { sent = body; return res; },
} as unknown as import('express').Response;
const req = {
  query: { from, to, tz: '330', label: 'probe window', ...(machineId ? { machineId } : {}) },
  user: { isSuperAdmin: true, name: 'probe' },
} as unknown as import('express').Request;

const t0 = Date.now();
await exportWorkbook(req, res, (e: unknown) => { throw e; });
if (sent) {
  writeFileSync(out, sent);
  console.log(`[probe] ${headers['Content-Disposition']} — ${(sent as Buffer).length} bytes in ${Date.now() - t0} ms → ${out}`);
}
await mongoose.disconnect();
