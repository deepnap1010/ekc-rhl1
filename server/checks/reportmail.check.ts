// Self-check: scheduled report emails. On a real (in-memory) MongoDB, against
// a fake mail server on localhost — nothing leaves this machine.
//   npm i --no-save mongodb-memory-server     (one-off)
//   npm run check:reportmail
//
// What it holds: the plant-clock arithmetic (when each kind of schedule sends,
// and what period each email covers); the message itself (encoded subject,
// no header injection, the attachment byte-for-byte); the SMTP conversation
// (STARTTLS before any password, PLAIN and LOGIN, refused recipients, size
// limits, and every failure in words an admin can act on); the runner (one
// email per due moment, a missed stretch sent once, a failed send retried for
// the SAME period, nothing on the review copy, nothing twice); the screens'
// endpoints; and that Export Excel still downloads exactly as before.
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let bad = 0;
const check = (c: boolean, l: string): void => { console.log(`${c ? 'ok  ' : '!!  '}${l}`); if (!c) bad++; };
const MIN = 60_000, HOUR = 60 * MIN;
const IST = (s: string): number => Date.parse(`${s}+05:30`);   // a plant-clock moment

// ── a fake mail server ───────────────────────────────────────────────────────
interface Got { mailFrom: string; rcpt: string[]; data: string; user?: string; pass?: string; tls: boolean; commands: string[] }
interface Fake { auth?: string[]; startTls?: { key: string; cert: string }; implicitTls?: { key: string; cert: string }; rejectRcpt?: string[]; badPassword?: string; size?: number; silent?: boolean }
async function fakeSmtp(o: Fake = {}): Promise<{ port: number; got: Got[]; seen: Got[]; close: () => Promise<void> }> {
  const got: Got[] = [];
  const seen: Got[] = [];           // every conversation, delivered or not
  const live = new Set<net.Socket>();
  const serve = (raw: net.Socket): void => {
    live.add(raw); raw.on('close', () => live.delete(raw)); raw.on('error', () => {});
    if (o.silent) return;           // takes the call and never says hello
    let sock: net.Socket = raw;
    let secured = !!o.implicitTls;
    const cur: Got = { mailFrom: '', rcpt: [], data: '', tls: secured, commands: [] };
    seen.push(cur);
    let buf = '';
    let mode: 'cmd' | 'data' | 'user' | 'pass' = 'cmd';
    const say = (s: string): void => { sock.write(`${s}\r\n`); };
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (mode === 'data') {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          cur.data = buf.slice(0, end).replace(/\r\n\.\./g, '\r\n.').replace(/^\.\./, '.');
          buf = buf.slice(end + 5);
          got.push({ ...cur, rcpt: [...cur.rcpt] });
          mode = 'cmd'; say('250 2.0.0 queued');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (mode === 'user') { cur.user = Buffer.from(line, 'base64').toString(); mode = 'pass'; say('334 UGFzc3dvcmQ6'); continue; }
        if (mode === 'pass') { cur.pass = Buffer.from(line, 'base64').toString(); mode = 'cmd'; say(cur.pass === o.badPassword ? '535 5.7.8 Authentication failed' : '235 2.7.0 ok'); continue; }
        const [verbRaw, a1 = '', a2 = ''] = line.split(' ');
        const verb = verbRaw.toUpperCase();
        cur.commands.push(verb === 'AUTH' ? `AUTH ${a1.toUpperCase()}` : verb);
        if (verb === 'EHLO') {
          const caps = ['250-fake.test'];
          if (o.startTls && !secured) caps.push('250-STARTTLS');
          if (o.auth?.length) caps.push(`250-AUTH ${o.auth.join(' ')}`);
          if (o.size) caps.push(`250-SIZE ${o.size}`);
          caps.push('250 8BITMIME');
          sock.write(`${caps.join('\r\n')}\r\n`);
        } else if (verb === 'STARTTLS' && o.startTls) {
          say('220 2.0.0 ready');
          sock.off('data', onData);
          const sec = new tls.TLSSocket(sock, { isServer: true, key: o.startTls.key, cert: o.startTls.cert });
          sec.on('error', () => {});
          sock = sec; secured = true; cur.tls = true;
          sec.on('data', onData);
        } else if (verb === 'AUTH') {
          if (a1.toUpperCase() === 'PLAIN') {
            const [, u, p] = Buffer.from(a2, 'base64').toString().split('\0');
            cur.user = u; cur.pass = p;
            say(p === o.badPassword ? '535 5.7.8 Authentication failed' : '235 2.7.0 ok');
          } else if (a1.toUpperCase() === 'LOGIN') { mode = 'user'; say('334 VXNlcm5hbWU6'); } else say('504 5.5.4 unknown mechanism');
        } else if (verb === 'MAIL') { cur.mailFrom = /<([^>]*)>/.exec(line)?.[1] || ''; cur.rcpt = []; say('250 2.1.0 ok'); }
        else if (verb === 'RCPT') {
          const a = /<([^>]*)>/.exec(line)?.[1] || '';
          if (o.rejectRcpt?.includes(a)) say('550 5.1.1 no such user'); else { cur.rcpt.push(a); say('250 2.1.5 ok'); }
        } else if (verb === 'DATA') { mode = 'data'; say('354 go ahead'); }
        else if (verb === 'QUIT') { say('221 2.0.0 bye'); sock.end(); }
        else say('250 ok');
      }
    };
    sock.on('data', onData);
    say('220 fake.test ESMTP');
  };
  const server = o.implicitTls ? tls.createServer({ key: o.implicitTls.key, cert: o.implicitTls.cert }, serve) : net.createServer(serve);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { port, got, seen, close: async () => { for (const s of live) s.destroy(); await new Promise<void>((r) => server.close(() => r())); } };
}
/** A port with nobody listening on it. */
async function deadPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
/** A throwaway self-signed certificate, if openssl is about. */
function selfSigned(): { key: string; cert: string } | null {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekc-smtp-'));
    const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const out = { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8') };
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
  } catch { return null; }
}

// ── reading a message back ───────────────────────────────────────────────────
type Leaf = { headers: string; body: string };
function leaves(entity: string): Leaf[] {
  const i = entity.indexOf('\r\n\r\n');
  const headers = entity.slice(0, i).replace(/\r\n[ \t]/g, ' ');
  const body = entity.slice(i + 4);
  const b = /multipart\/[^;]+;\s*boundary="([^"]+)"/i.exec(headers);
  if (!b) return [{ headers, body }];
  return body.split(`--${b[1]}`).slice(1).filter((p) => !p.startsWith('--'))
    .flatMap((p) => leaves(p.replace(/^\r\n/, '').replace(/\r\n$/, '')));
}
const bytes = (l: Leaf): Buffer => Buffer.from(l.body.replace(/\r\n/g, ''), 'base64');
const header = (mime: string, name: string): string => {
  const head = mime.slice(0, mime.indexOf('\r\n\r\n')).replace(/\r\n[ \t]/g, ' ');
  return (new RegExp(`^${name}: (.*)$`, 'im').exec(head) || [])[1] || '';
};
const words = (s: string): string => s.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));

// The mail settings the runner will read — set before anything imports env.
const relay = await fakeSmtp({ rejectRcpt: ['nobody@ekc.test'] });
Object.assign(process.env, {
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(relay.port), SMTP_SECURE: 'false',
  SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: 'EKC SmartFactory <reports@ekc.test>', READ_ONLY: '',
});
const { env } = await import('../src/config/env.js');
const smtp = await import('../src/utils/smtp.js');
const svc = await import('../src/services/reportMail.service.js');
const ctl = await import('../src/controllers/reportMail.controller.js');
const { exportWorkbook } = await import('../src/controllers/export.controller.js');
const { ReportSchedule } = await import('../src/models/ReportSchedule.js');
const { ReportMailRun } = await import('../src/models/ReportMailRun.js');
const { AuditLog } = await import('../src/models/AuditLog.js');
const { AppConfig } = await import('../src/models/AppConfig.js');
const { Machine } = await import('../src/models/Machine.js');
const { Telemetry } = await import('../src/models/Telemetry.js');
const { MODULES, FULL_PERMISSIONS } = await import('../src/models/Role.js');
const { PERMISSION_CATALOG, normalizePermissions } = await import('../src/utils/permissions.js');

const SHIFTS = [{ name: 'Shift A', start: '07:00', end: '15:00' }, { name: 'Shift B', start: '15:00', end: '23:00' }, { name: 'Shift C', start: '23:00', end: '07:00' }];
const base = { frequency: 'daily' as const, everyHours: 12, time: '07:30', weekday: 1, monthDay: 1, shifts: [] as string[], delayMin: 10, period: 'auto' as const, periodHours: 12 };
type Shape = Parameters<typeof svc.nextRunAfter>[0];
const sched = (o: Partial<Shape>): Shape => ({ ...base, ...o }) as Shape;
const at = (s: Shape, after: string): number | null => svc.nextRunAfter(s, IST(after), SHIFTS);

// ── 1 · when each kind of schedule sends ─────────────────────────────────────
const shiftly = sched({ frequency: 'shift', delayMin: 10 });
check(at(shiftly, '2026-10-15T14:00') === IST('2026-10-15T15:10'), 'after each shift: 10 min after Shift A ends → 15:10');
check(at(shiftly, '2026-10-15T15:10') === IST('2026-10-15T23:10'), '…then 23:10 — never the same minute twice');
check(at(shiftly, '2026-10-15T23:30') === IST('2026-10-16T07:10'), '…then 07:10 next morning, after the night shift');
check(at(sched({ frequency: 'shift', shifts: ['Shift C'] }), '2026-10-15T08:00') === IST('2026-10-16T07:10'), 'only after Shift C: once a day, 07:10');
const twelve = sched({ frequency: 'hours', everyHours: 12, time: '07:00' });
check(at(twelve, '2026-10-15T06:59') === IST('2026-10-15T07:00') && at(twelve, '2026-10-15T07:00') === IST('2026-10-15T19:00')
  && at(twelve, '2026-10-15T20:00') === IST('2026-10-16T07:00'), 'every 12 hours from 07:00: 07:00 and 19:00, every day');
check(at(sched({ frequency: 'hours', everyHours: 8, time: '06:00' }), '2026-10-15T15:00') === IST('2026-10-15T22:00'), 'every 8 hours from 06:00: 06:00, 14:00, 22:00');
check(at(sched({ frequency: 'hours', everyHours: 24, time: '07:30' }), '2026-10-15T07:30') === IST('2026-10-16T07:30'), 'every 24 hours is once a day');
check(at(base as Shape, '2026-10-15T07:29') === IST('2026-10-15T07:30') && at(base as Shape, '2026-10-15T07:30') === IST('2026-10-16T07:30'), 'daily at 07:30');
check(at(sched({ frequency: 'weekly', weekday: 1, time: '08:00' }), '2026-10-15T09:00') === IST('2026-10-19T08:00'), 'weekly on Monday 08:00 — from Thursday 15 Oct, Monday the 19th');
check(at(sched({ frequency: 'monthly', monthDay: 1, time: '08:00' }), '2026-10-15T09:00') === IST('2026-11-01T08:00')
  && at(sched({ frequency: 'monthly', monthDay: 1, time: '08:00' }), '2026-12-01T08:00') === IST('2027-01-01T08:00'), 'monthly on the 1st — across the year end too');

// ── 2 · what each email covers ───────────────────────────────────────────────
const win = (s: Shape, due: string): { from: number; to: number; label: string } => {
  const w = svc.windowFor(s, IST(due), SHIFTS);
  return { from: +w.from, to: +w.to, label: w.label };
};
let w = win(shiftly, '2026-10-15T15:10');
check(w.from === IST('2026-10-15T07:00') && w.to === IST('2026-10-15T15:00') && w.label === 'Shift A · 15 Oct 2026 (07:00–15:00)', `the 15:10 email covers Shift A — "${w.label}"`);
w = win(shiftly, '2026-10-16T07:10');
check(w.from === IST('2026-10-15T23:00') && w.to === IST('2026-10-16T07:00') && w.label.startsWith('Shift C · 15 Oct 2026'), `the 07:10 email covers the night shift, booked on the day it began — "${w.label}"`);
w = win(twelve, '2026-10-15T19:00');
check(w.from === IST('2026-10-15T07:00') && w.to === IST('2026-10-15T19:00'), 'every 12 hours covers the 12 hours before it');
w = win(base as Shape, '2026-10-16T07:30');
check(w.from === IST('2026-10-15T07:00') && w.to === IST('2026-10-16T07:00') && w.label === 'Production day · 15 Oct 2026 (07:00 → 07:00)', `daily covers the previous production day — "${w.label}"`);
w = win(base as Shape, '2026-10-16T06:00');
check(w.from === IST('2026-10-14T07:00') && w.to === IST('2026-10-15T07:00'), 'sent before 07:00, it is the last COMPLETE production day');
w = win(sched({ frequency: 'weekly' }), '2026-10-19T08:00');
check(w.from === IST('2026-10-12T07:00') && w.to === IST('2026-10-19T07:00'), 'weekly covers the last 7 production days');
w = win(sched({ frequency: 'monthly' }), '2026-11-01T08:00');
check(w.from === IST('2026-10-01T07:00') && w.to === IST('2026-11-01T07:00') && w.label === 'October 2026', 'monthly covers the previous month');
w = win(sched({ period: 'month_to_date' }), '2026-10-15T12:00');
check(w.from === IST('2026-10-01T07:00') && w.to === IST('2026-10-15T12:00'), 'this month so far, from the 1st at 07:00');
w = win(sched({ period: 'today' }), '2026-10-15T12:00');
check(w.from === IST('2026-10-15T07:00') && w.to === IST('2026-10-15T12:00'), 'today so far');
w = win(sched({ period: 'hours', periodHours: 6 }), '2026-10-15T12:00');
check(w.from === IST('2026-10-15T06:00') && w.to === IST('2026-10-15T12:00'), 'a daily email can cover any number of hours');
check(svc.describeSchedule(shiftly, SHIFTS).when === '10 min after every shift ends · 15:10, 23:10 and 07:10'
  && svc.describeSchedule(twelve, SHIFTS).when === 'Every 12 hours · 07:00 and 19:00', 'each schedule reads as a sentence');

// ── 3 · the message ──────────────────────────────────────────────────────────
const blob = Buffer.from(Array.from({ length: 150_000 }, (_, i) => (i * 37) % 256));
const mime = smtp.buildMime({
  from: 'EKC SmartFactory <reports@ekc.test>', to: ['"Plant Head" <head@ekc.test>'], cc: ['qa@ekc.test'],
  subject: 'Rapport — Shift A ✓\r\nBcc: spy@evil.test', text: 'plain', html: '<b>rich</b>',
  attachments: [{ filename: 'EKC_SmartFactory_2026-10-15.xlsx', contentType: 'application/octet-stream', content: blob }],
}, { messageId: '<x@ekc.test>' });
const head = mime.slice(0, mime.indexOf('\r\n\r\n'));
check(!/^bcc:/im.test(head) && words(header(mime, 'Subject')) === 'Rapport — Shift A ✓ Bcc: spy@evil.test', 'a line break in the subject cannot add a header; the subject survives, encoded');
check(header(mime, 'To') === '"Plant Head" <head@ekc.test>' && header(mime, 'Cc') === 'qa@ekc.test', 'named and bare recipients');
const parts = leaves(mime);
const file = parts.find((p) => /attachment/i.test(p.headers));
check(!!file && bytes(file).equals(blob) && file.body.split('\r\n').every((l) => l.length <= 76), 'the attachment arrives byte for byte, in 76-character lines');
check(bytes(parts.find((p) => /text\/html/i.test(p.headers)) as Leaf).toString() === '<b>rich</b>' && bytes(parts.find((p) => /text\/plain/i.test(p.headers)) as Leaf).toString() === 'plain', 'an HTML body and its plain-text twin');
check(smtp.dotStuff('.a\r\n.b\r\nc.') === '..a\r\n..b\r\nc.', 'a line that starts with a dot is doubled for DATA');
check(!!smtp.parseMailbox('"Plant Head" <head@ekc.test>') && !smtp.parseMailbox('head@ekc') && !smtp.parseMailbox('head ekc.test') && smtp.isEmail('a.b-c@sub.ekc.co.in'), 'addresses are checked');

// ── 4 · the conversation ─────────────────────────────────────────────────────
const msg = { from: 'EKC SmartFactory <reports@ekc.test>', to: ['head@ekc.test', 'nobody@ekc.test'], cc: ['qa@ekc.test'], subject: 'Hello', text: 'hi', attachments: [{ filename: 'f.xlsx', contentType: 'application/octet-stream', content: blob }] };
const fail = async (p: Promise<unknown>): Promise<{ code: string; message: string } | null> => {
  try { await p; return null; } catch (e) { return { code: (e as { code?: string }).code || '', message: (e as Error).message }; }
};
const r1 = await smtp.sendMail({ host: '127.0.0.1', port: relay.port, secure: false }, msg);
const d1 = relay.got[relay.got.length - 1];
check(r1.accepted.length === 2 && r1.rejected.length === 1 && r1.rejected[0].address === 'nobody@ekc.test', 'a refused recipient is reported; the others still get it');
check(d1.mailFrom === 'reports@ekc.test' && d1.rcpt.join() === 'head@ekc.test,qa@ekc.test' && bytes(leaves(d1.data).find((p) => /attachment/i.test(p.headers)) as Leaf).equals(blob),
  'the server received the whole message, attachment intact');
relay.got.length = 0; relay.seen.length = 0;
const noTls = await fakeSmtp({ auth: ['PLAIN', 'LOGIN'] });
let e = await fail(smtp.sendMail({ host: '127.0.0.1', port: noTls.port, secure: false, user: 'u', pass: 'secret' }, msg));
check(e?.code === 'ENOTLS' && !noTls.seen.some((g) => g.commands.some((c) => c.startsWith('AUTH'))), 'no STARTTLS on offer → the password is never sent');
await noTls.close();
e = await fail(smtp.sendMail({ host: '127.0.0.1', port: relay.port, secure: false }, { ...msg, to: ['nobody@ekc.test'], cc: [] }));
check(e?.code === 'ERECIPIENTS', 'every recipient refused → a failure that names them');
const small = await fakeSmtp({ size: 1000 });
e = await fail(smtp.sendMail({ host: '127.0.0.1', port: small.port, secure: false }, msg));
check(e?.code === 'ESIZE' && !small.seen.some((g) => g.commands.includes('DATA')), 'too large for the server → said before DATA is sent');
await small.close();
e = await fail(smtp.sendMail({ host: '127.0.0.1', port: await deadPort(), secure: false }, msg));
check(e?.code === 'ECONNREFUSED' && /firewall/.test(e.message), `nothing listening → "${e?.message}"`);
const silent = await fakeSmtp({ silent: true });
const t0 = Date.now();
e = await fail(smtp.sendMail({ host: '127.0.0.1', port: silent.port, secure: false, timeoutMs: 1500 }, msg));
check(e?.code === 'ETIMEDOUT' && Date.now() - t0 < 5000 && /firewall/.test(e.message), 'a server that never answers → a timeout that blames the likely firewall');
await silent.close();
const cert = selfSigned();
if (!cert) {
  console.log('--  openssl not found: the TLS checks are skipped');
} else {
  const tlsBox = await fakeSmtp({ startTls: cert, auth: ['PLAIN', 'LOGIN'], badPassword: 'wrong' });
  const cfg = { host: '127.0.0.1', port: tlsBox.port, secure: false, user: 'reports@ekc.test', pass: 'app-pass', rejectUnauthorized: false };
  await smtp.sendMail(cfg, msg);
  const g = tlsBox.got[0];
  check(!!g && g.tls && g.user === 'reports@ekc.test' && g.pass === 'app-pass'
    && g.commands.indexOf('STARTTLS') >= 0 && g.commands.indexOf('STARTTLS') < g.commands.indexOf('AUTH PLAIN'), 'STARTTLS first, then the login (AUTH PLAIN), then the message');
  e = await fail(smtp.sendMail({ ...cfg, pass: 'wrong' }, msg));
  check(e?.code === 'EAUTH' && /App Password/.test(e.message), 'a wrong password says how to get the right one');
  e = await fail(smtp.sendMail({ ...cfg, rejectUnauthorized: true }, msg));
  check(e?.code === 'ECERT' && /SMTP_TLS_REJECT_UNAUTHORIZED/.test(e.message), 'a certificate the server cannot verify → the firewall setting is named');
  await tlsBox.close();
  const loginBox = await fakeSmtp({ startTls: cert, auth: ['LOGIN'] });
  await smtp.sendMail({ ...cfg, port: loginBox.port }, msg);
  check(loginBox.got[0]?.user === 'reports@ekc.test' && loginBox.got[0]?.pass === 'app-pass', 'AUTH LOGIN where PLAIN is not offered');
  await loginBox.close();
  const implicit = await fakeSmtp({ implicitTls: cert, auth: ['PLAIN'] });
  await smtp.sendMail({ ...cfg, port: implicit.port, secure: true }, msg);
  check(implicit.got[0]?.tls === true && implicit.got[0]?.pass === 'app-pass', 'port 465 style: TLS from the first byte');
  await implicit.close();
}

// ── 5 · the runner, on a real database ───────────────────────────────────────
const mem = await MongoMemoryServer.create({ instance: { launchTimeout: 90_000 } });
await mongoose.connect(mem.getUri(), { dbName: 'test' });
await AppConfig.create({ key: 'global', shifts: SHIFTS });

// The last shift that has ended, and a machine that worked through it.
const now = Date.now();
const shiftS = sched({ frequency: 'shift', delayMin: 10 });
let due = svc.nextRunAfter(shiftS, now - 30 * HOUR, SHIFTS) as number;
for (let n = svc.nextRunAfter(shiftS, due, SHIFTS); n !== null && n <= now; n = svc.nextRunAfter(shiftS, due, SHIFTS)) due = n;
const shiftWin = svc.windowFor(shiftS, due, SHIFTS);
const docs = [];
for (let t = +shiftWin.from - 10 * MIN; t <= Math.min(+shiftWin.to + 5 * MIN, now); t += MIN) {
  const made = Math.max(0, Math.min(Math.floor((t - +shiftWin.from) / (5 * MIN)), Math.floor((+shiftWin.to - +shiftWin.from) / (5 * MIN))));
  docs.push({ machineId: 'SPG05', timestamp: new Date(t), receivedAt: new Date(t), status: 'running', data: { production_count: 1000 + made, status: 'running' } });
}
await Telemetry.collection.insertMany(docs);
await Machine.create({ code: 'SPG05', name: 'SPG05', status: 'running', currentParameters: docs[docs.length - 1].data, lastReadingAt: docs[docs.length - 1].timestamp, lastSeenAt: new Date() });

const s1 = await ReportSchedule.create({ name: 'Shift report', to: ['head@ekc.test'], cc: ['qa@ekc.test'], frequency: 'shift', delayMin: 10, nextRunAt: new Date(due) });
await svc.runDueReportMails();
const got1 = relay.got[0];
const att = got1 ? leaves(got1.data).find((p) => /attachment/i.test(p.headers)) : undefined;
const html = got1 ? bytes(leaves(got1.data).find((p) => /text\/html/i.test(p.headers)) as Leaf).toString() : '';
check(relay.got.length === 1 && words(header(got1.data, 'Subject')).includes(shiftWin.label), `one email, for the shift that ended — "${words(header(got1?.data || '', 'Subject'))}"`);
check(!!att && /filename="EKC_SmartFactory_[^"]+\.xlsx"/.test(att.headers) && bytes(att).subarray(0, 2).toString() === 'PK', 'the workbook is attached — a real .xlsx (a zip)');
check(/Pieces made/.test(html) && /Spinning|SPG/i.test(html), 'the summary is in the body, by section');
let run = await ReportMailRun.findOne({ scheduleId: s1._id }).lean();
let s1b = await ReportSchedule.findById(s1._id).lean();
check(run?.status === 'sent' && run?.trigger === 'schedule' && +(run?.window?.from || 0) === +shiftWin.from && s1b?.lastRun?.status === 'sent', 'logged as sent, for exactly that period');
check(!!s1b?.nextRunAt && +s1b.nextRunAt > now && +s1b.nextRunAt === svc.nextRunAfter(shiftS, now, SHIFTS) && !s1b.claimedAt, 'and the next send is the next shift end');

// Two ticks at once: one email.
relay.got.length = 0;
await ReportSchedule.updateOne({ _id: s1._id }, { $set: { nextRunAt: new Date(due) } });
await Promise.all([svc.runDueReportMails(), svc.runDueReportMails()]);
check(relay.got.length === 1, 'two ticks at once send it once');

// A server off for three days: one email, for the latest.
relay.got.length = 0;
await ReportSchedule.updateOne({ _id: s1._id }, { $set: { nextRunAt: new Date(due - 72 * HOUR) } });
await svc.runDueReportMails();
s1b = await ReportSchedule.findById(s1._id).lean();
check(relay.got.length === 1 && /9 earlier sends were missed/.test(s1b?.lastRun?.detail || ''), `three days missed → one email, for the latest shift (${s1b?.lastRun?.detail})`);

// Claimed by another process: left alone — until its claim goes stale.
relay.got.length = 0;
await ReportSchedule.updateOne({ _id: s1._id }, { $set: { nextRunAt: new Date(due), claimedAt: new Date() } });
await svc.runDueReportMails();
check(relay.got.length === 0, 'a schedule another process holds is not sent twice');
await ReportSchedule.updateOne({ _id: s1._id }, { $set: { claimedAt: new Date(Date.now() - 16 * MIN) } });
await svc.runDueReportMails();
check(relay.got.length === 1, '…and one whose process died holding it is sent');

// The mail server down: retried for the SAME period.
relay.got.length = 0;
const goodPort = env.smtp.port;
env.smtp.port = await deadPort();
await ReportSchedule.updateOne({ _id: s1._id }, { $set: { nextRunAt: new Date(due) } });
await svc.runDueReportMails();
s1b = await ReportSchedule.findById(s1._id).lean();
check(s1b?.attempt === 1 && +(s1b?.due || 0) === due && Math.abs(+(s1b?.nextRunAt || 0) - (Date.now() + 5 * MIN)) < 30_000 && /trying again/.test(s1b?.lastRun?.detail || ''),
  `the mail server down → tried again in 5 minutes (${s1b?.lastRun?.detail})`);
env.smtp.port = goodPort;
await svc.runDueReportMails(new Date(Date.now() + 6 * MIN));
s1b = await ReportSchedule.findById(s1._id).lean();
run = await ReportMailRun.findOne({ scheduleId: s1._id }).sort({ at: -1 }).lean();
check(relay.got.length === 1 && run?.status === 'sent' && +(run?.window?.from || 0) === +shiftWin.from && !s1b?.due && s1b?.attempt === 0,
  'the retry reports the period it was for, then the schedule moves on');

// A setting missing is not retried — it is for the admin to fix.
env.smtp.from = '';
await ReportSchedule.updateOne({ _id: s1._id }, { $set: { nextRunAt: new Date(due) } });
await svc.runDueReportMails();
s1b = await ReportSchedule.findById(s1._id).lean();
check(s1b?.lastRun?.status === 'failed' && /not set up/.test(s1b.lastRun.detail) && !s1b.due && +(s1b.nextRunAt || 0) > now, 'mail not set up → logged, not retried every few minutes');
env.smtp.from = 'EKC SmartFactory <reports@ekc.test>';

// The review copy never sends.
relay.got.length = 0;
env.readOnly = true;
await ReportSchedule.updateOne({ _id: s1._id }, { $set: { nextRunAt: new Date(due) } });
check(await svc.runDueReportMails() === 0 && relay.got.length === 0, 'READ_ONLY (the cloud review copy) sends nothing');
env.readOnly = false;
await ReportSchedule.updateOne({ _id: s1._id }, { $set: { enabled: false } });
await svc.runDueReportMails();
check(relay.got.length === 0, 'a paused schedule sends nothing');

// ── 6 · the screens' endpoints ───────────────────────────────────────────────
function call(fn: any, opts: { query?: any; params?: any; body?: any } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = { query: opts.query || {}, body: opts.body || {}, params: opts.params || {}, user: { _id: 'u1', name: 'Admin', email: 'admin@ekc.test', isSuperAdmin: true } } as any;
    const res = {
      code: 200,
      status(c: number) { this.code = c; return this; },
      json(b: any) { b?.success ? resolve(b.data) : reject(new Error(`${this.code}: ${b?.error?.message}`)); },
    } as any;
    Promise.resolve(fn(req, res, ((x: any) => reject(x)) as any)).catch(reject);
  });
}
const err = async (p: Promise<unknown>): Promise<string> => { try { await p; return ''; } catch (x) { return (x as Error).message; } };
// Audit rows are written fire-and-forget (a change never fails on its log) —
// so they are looked for, not expected the same instant.
const eventually = async (f: () => Promise<unknown>): Promise<boolean> => {
  for (let i = 0; i < 40; i += 1) { if (await f()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};
check(/400: Not an email address: nope/.test(await err(call(ctl.createSchedule, { body: { name: 'x', to: ['nope'], frequency: 'daily' } }))), 'a bad address is refused, by name');
check(/400: Add at least one person/.test(await err(call(ctl.createSchedule, { body: { name: 'x', to: [], frequency: 'daily' } }))), 'nobody to send to is refused');
const made = await call(ctl.createSchedule, { body: { name: 'Daily to head', to: ['Head@EKC.test', 'head@ekc.test'], cc: ['head@ekc.test', 'qa@ekc.test'], frequency: 'daily', time: '07:30' } });
check(made.to.join() === 'Head@EKC.test' && made.cc.join() === 'qa@ekc.test', 'each person once — and someone in To is not copied again');
check(made.describe.when === 'Every day at 07:30' && /production day/.test(made.describe.covers) && +new Date(made.nextRunAt) > Date.now(), `it reads "${made.describe.when} · ${made.describe.covers}"`);
check(await eventually(() => AuditLog.exists({ action: 'report_mail.create', 'user.name': 'Admin' })), 'creating it is in the audit log, with who did it');
const pv = await call(ctl.previewSchedule, { query: { draft: JSON.stringify({ frequency: 'hours', everyHours: 12, time: '07:00' }) } });
check(pv.next.length === 3 && pv.next.every((x: any) => /^Last 12 hours/.test(x.window.label)), 'the preview shows the next three sends and what each covers');
relay.got.length = 0;
const sent = await call(ctl.sendNow, { params: { id: String(made._id) } });
check(sent.status === 'sent' && relay.got.length === 1, 'Send now sends it now');
check(/429/.test(await err(call(ctl.sendNow, { params: { id: String(made._id) } }))), '…and a second click within the minute is refused');
const tst = await call(ctl.sendTest, { body: { to: 'it@ekc.test' } });
check(tst.status === 'sent' && words(header(relay.got[relay.got.length - 1].data, 'Subject')) === 'EKC SmartFactory — test email', 'a test email');
const paused = await call(ctl.updateSchedule, { params: { id: String(made._id) }, body: { ...made, enabled: false } });
check(paused.enabled === false && paused.nextRunAt === null, 'pausing clears the next send');
const runs = await call(ctl.listRuns, { query: {} });
check(['schedule', 'manual', 'test'].every((k) => runs.some((r: any) => r.trigger === k)), 'the history holds scheduled, by-hand and test sends');
await call(ctl.deleteSchedule, { params: { id: String(made._id) } });
check(!(await ReportSchedule.findById(made._id)) && await eventually(() => AuditLog.exists({ action: 'report_mail.delete' })), 'deleting it is in the audit log too');
const st = await call(ctl.mailStatus);
check(st.configured === true && !('pass' in st), 'the mail status never carries the password');

// ── 7 · the Roles grid, and Export Excel as before ───────────────────────────
const row = PERMISSION_CATALOG.find((c) => c.module === 'report_mail');
check(MODULES.includes('report_mail') && FULL_PERMISSIONS.report_mail?.length > 0 && row?.parent === 'reports' && row.strict === true
  && JSON.stringify(normalizePermissions({ report_mail: ['view', 'update', 'delete'] })) === JSON.stringify({ report_mail: ['view', 'update'] }),
  'Report emails is its own row under Reports: View and Update');
const download = await new Promise<{ headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
  const headers: Record<string, string> = {};
  const res = {
    code: 200,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    status(c: number) { this.code = c; return this; },
    send(b: Buffer) { resolve({ headers, body: b }); },
    json(b: any) { reject(new Error(`${this.code}: ${b?.error?.message}`)); },
  } as any;
  const req = { query: { from: shiftWin.from.toISOString(), to: shiftWin.to.toISOString(), machineId: 'SPG05' }, user: { isSuperAdmin: true, name: 'Admin' } } as any;
  Promise.resolve(exportWorkbook(req, res, reject as any)).catch(reject);
});
check(/filename="EKC_SmartFactory_SPG05_/.test(download.headers['content-disposition'] || '') && download.body.subarray(0, 2).toString() === 'PK',
  'Export Excel downloads as before — and a machine with no dia assigned no longer fails it (BY DIA sheet)');

await mongoose.disconnect();
await mem.stop();
await relay.close();
console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
