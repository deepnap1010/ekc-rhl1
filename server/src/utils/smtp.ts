// server/src/utils/smtp.ts
// Outgoing mail with nothing but Node's own sockets.
//
// Why not a mail library: the factory server installs packages through a
// firewall that some days holds it at a login page (deploy.sh), and a deploy
// whose new package cannot be fetched stops before it builds. SMTP is a short
// conversation — greet, switch to TLS, log in, name the sender and the
// recipients, hand over the message, say goodbye — and this is that
// conversation, the way utils/xlsx is the plant's own spreadsheet writer.
//
// It speaks implicit TLS (465) and STARTTLS (587/25 — taken whenever the
// server offers it, and a password is never sent without it), AUTH PLAIN or
// LOGIN, several recipients (one refused is reported, not fatal while another
// is accepted), and a MIME message: an HTML body with its plain-text twin,
// plus attachments. Every failure comes back as a MailError in words an admin
// can act on — "the firewall is blocking outgoing mail", not "ETIMEDOUT".
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;               // TLS from the first byte (465); otherwise STARTTLS when offered
  user?: string;
  pass?: string;
  rejectUnauthorized?: boolean;  // false only behind a firewall that re-signs TLS
  heloName?: string;
  timeoutMs?: number;
}

export interface MailAttachment { filename: string; contentType: string; content: Buffer }
export interface MailMessage {
  from: string;                  // "Name <address>" or a bare address
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
}
export interface SendResult {
  accepted: string[];
  rejected: { address: string; reason: string }[];
  messageId: string;
  response: string;
}

/** A mail failure in words an admin can act on. `code` says what kind, so a
 *  caller can tell "try again later" from "fix the settings". */
export class MailError extends Error {
  constructor(message: string, readonly code: string, readonly detail = '') { super(message); }
}
/** The failures worth retrying: the network, the server busy — not a wrong
 *  password or an address that does not exist. */
export const RETRYABLE = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ENETUNREACH', 'ETEMPORARY', 'ECLOSED']);

const CRLF = '\r\n';
const DEFAULT_TIMEOUT_MS = 30_000;

// ── addresses ────────────────────────────────────────────────────────────────
const ADDR_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:".]+(\.[^\s@<>()[\]\\,;:".]+)+$/;
/** A plain address someone could actually mail. */
export const isEmail = (s: string): boolean => typeof s === 'string' && s.length <= 254 && ADDR_RE.test(s.trim());

/** "Name <a@b.c>" or "a@b.c" → its parts; null when there is no valid address. */
export function parseMailbox(s: string): { name: string; address: string } | null {
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(String(s || ''));
  const address = (m ? m[2] : String(s || '')).trim();
  if (!isEmail(address)) return null;
  return { name: (m?.[1] || '').trim(), address };
}

// ── the message ──────────────────────────────────────────────────────────────
// Headers carry no CR/LF from outside — the classic header-injection hole —
// and anything not plain ASCII rides as RFC 2047 encoded-words. Bodies and
// attachments are base64, so the whole message is 7-bit ASCII and any server
// takes it.
const oneLine = (s: string): string => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim();
const isAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

function encodeWords(s: string): string {
  const text = oneLine(s);
  if (isAscii(text) && text.length <= 900) return text;
  const words: string[] = [];
  let cur = '';
  for (const ch of text) {            // whole characters: a split UTF-8 sequence is mojibake
    if (Buffer.byteLength(cur + ch) > 45) { words.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

function mailboxHeader(s: string): string {
  const mb = parseMailbox(s);
  if (!mb) throw new MailError(`"${oneLine(s)}" is not an email address`, 'EADDRESS');
  if (!mb.name) return mb.address;
  const name = isAscii(mb.name) ? `"${mb.name.replace(/["\\]/g, '\\$&')}"` : encodeWords(mb.name);
  return `${name} <${mb.address}>`;
}

function base64Lines(buf: Buffer): string {
  const s = buf.toString('base64');
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join(CRLF);
}

function filenameParams(name: string): string {
  const clean = oneLine(name).replace(/["\\/]/g, '_') || 'attachment';
  if (isAscii(clean)) return `filename="${clean}"`;
  return `filename*=UTF-8''${encodeURIComponent(clean)}`;
}

type Part = { headers: string[]; body: string };
const render = (p: Part): string => [...p.headers, '', p.body].join(CRLF);
function multipart(kind: 'mixed' | 'alternative', parts: Part[]): Part {
  const boundary = `=_${kind}_${crypto.randomBytes(12).toString('hex')}`;
  return {
    headers: [`Content-Type: multipart/${kind}; boundary="${boundary}"`],
    body: [...parts.map((p) => `--${boundary}${CRLF}${render(p)}`), `--${boundary}--`].join(CRLF),
  };
}

/** The whole RFC 5322 message, CRLF line endings, ready for DATA (before dot-stuffing). */
export function buildMime(msg: MailMessage, opts: { messageId: string; date?: Date }): string {
  const text: Part = {
    headers: ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'],
    body: base64Lines(Buffer.from(msg.text || '', 'utf8')),
  };
  const content = msg.html
    ? multipart('alternative', [text, {
      headers: ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64'],
      body: base64Lines(Buffer.from(msg.html, 'utf8')),
    }])
    : text;
  const files = (msg.attachments || []).map((a): Part => ({
    headers: [
      `Content-Type: ${oneLine(a.contentType) || 'application/octet-stream'}; name="${oneLine(a.filename).replace(/["\\]/g, '_')}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${filenameParams(a.filename)}`,
    ],
    body: base64Lines(a.content),
  }));
  const root = files.length ? multipart('mixed', [content, ...files]) : content;
  const list = (name: string, items: string[]): string => `${name}: ${items.map(mailboxHeader).join(`,${CRLF} `)}`;
  const headers = [
    `From: ${mailboxHeader(msg.from)}`,
    list('To', msg.to),
    ...(msg.cc?.length ? [list('Cc', msg.cc)] : []),
    `Subject: ${encodeWords(msg.subject)}`,
    `Date: ${(opts.date || new Date()).toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: ${opts.messageId}`,
    'MIME-Version: 1.0',
    'X-Mailer: EKC SmartFactory',
    ...root.headers,
  ];
  return [...headers, '', root.body].join(CRLF);
}

/** DATA's own rule: a line that starts with a dot gets a second one. */
export const dotStuff = (mime: string): string => mime.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');

// ── the conversation ─────────────────────────────────────────────────────────
interface Reply { code: number; lines: string[] }
const replyText = (r: Reply): string => r.lines.join(' ').trim();

/** Collects the server's replies off whichever socket is current — the plain
 *  one first, the TLS one after STARTTLS. */
class Replies {
  private buf = '';
  private lines: string[] = [];
  private ready: Reply[] = [];
  private failure: Error | null = null;
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private sock: net.Socket | null = null;
  private readonly onData = (chunk: Buffer): void => {
    this.buf += chunk.toString('latin1');
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) continue;                                  // not SMTP — ignore it
      this.lines.push(m[3]);
      if (m[2] !== '-') { this.ready.push({ code: Number(m[1]), lines: this.lines }); this.lines = []; }
    }
    this.flush();
  };
  private readonly onError = (e: Error): void => { this.fail(e); };
  private readonly onClose = (): void => { this.fail(new MailError('The mail server closed the connection', 'ECLOSED')); };
  private readonly onTimeout = (): void => { this.fail(new MailError('', 'ETIMEDOUT')); };

  constructor(private readonly timeoutMs: number) {}

  bind(sock: net.Socket): void {
    this.unbind();
    this.sock = sock;
    sock.setTimeout(this.timeoutMs);
    sock.on('data', this.onData).on('error', this.onError).on('close', this.onClose).on('timeout', this.onTimeout);
  }
  unbind(): void {
    const s = this.sock;
    if (!s) return;
    s.off('data', this.onData).off('error', this.onError).off('close', this.onClose).off('timeout', this.onTimeout);
    this.sock = null;
  }
  private fail(e: Error): void { if (!this.failure) this.failure = e; this.flush(); }
  private flush(): void {
    if (!this.waiter) return;
    const w = this.waiter;
    if (this.ready.length) { this.waiter = null; w.resolve(this.ready.shift() as Reply); }
    else if (this.failure) { this.waiter = null; w.reject(this.failure); }
  }
  next(): Promise<Reply> {
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; this.flush(); });
  }
}

/** A network-level failure, said plainly. */
function networkError(e: unknown, cfg: SmtpConfig): MailError {
  if (e instanceof MailError && e.message) return e;
  const code = (e as { code?: string })?.code || (e instanceof MailError ? e.code : '') || 'ENETWORK';
  const where = `${cfg.host}:${cfg.port}`;
  const secs = Math.round((cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000);
  const detail = e instanceof Error ? e.message : String(e);
  switch (code) {
    case 'ENOTFOUND': case 'EAI_AGAIN':
      return new MailError(`Could not find the mail server "${cfg.host}" — check SMTP_HOST, and that this server can look up internet names.`, 'ENOTFOUND', detail);
    case 'ECONNREFUSED':
      return new MailError(`${where} refused the connection — the port is wrong, or the plant firewall is blocking outgoing mail.`, 'ECONNREFUSED', detail);
    case 'ETIMEDOUT':
      return new MailError(`No answer from ${where} within ${secs} s — the plant firewall is most likely blocking outgoing mail on this port. Ask IT to allow it (or try 465 / 587).`, 'ETIMEDOUT', detail);
    case 'ECONNRESET': case 'EPIPE':
      return new MailError(`The connection to ${where} was cut off — often the firewall.`, 'ECONNRESET', detail);
    case 'ENETUNREACH': case 'EHOSTUNREACH':
      return new MailError(`This server has no route to ${cfg.host} — it may be offline or held at the firewall's login page.`, 'ENETUNREACH', detail);
    case 'ECLOSED':
      return new MailError(`${cfg.host} closed the connection before the email was accepted.`, 'ECLOSED', detail);
    default:
      if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(VERIFY|GET)/i.test(code)) {
        return new MailError(`The mail server's security certificate could not be verified (${code}). If the plant firewall inspects encrypted traffic it re-signs it with its own certificate — then set SMTP_TLS_REJECT_UNAUTHORIZED=false on the server.`, 'ECERT', detail);
      }
      return new MailError(`Could not talk to ${where}: ${detail}`, code, detail);
  }
}

/** A reply the conversation did not expect, said plainly. */
function replyError(r: Reply, step: string, cfg: SmtpConfig, from: string): MailError {
  const text = replyText(r);
  if (r.code === 535 || r.code === 534) {
    return new MailError('The mail server rejected the username or password. For Gmail, use an App Password (with 2-step verification on); for Microsoft 365, SMTP sign-in must be allowed for the mailbox.', 'EAUTH', text);
  }
  if (r.code === 530 && step !== 'login') return new MailError('The mail server wants a login first — set SMTP_USER and SMTP_PASS on the server.', 'EAUTH', text);
  if (step === 'sender' && r.code >= 500) return new MailError(`The mail server will not send as ${from} — SMTP_FROM must be the account's own address, or one it may send as.`, 'ESENDER', text);
  if (r.code === 552 || /size/i.test(text)) return new MailError('The mail server refused the email as too large.', 'ESIZE', text);
  if (r.code === 421 || (r.code >= 400 && r.code < 500)) return new MailError(`${cfg.host} is busy or limiting mail right now (${r.code}) — it will be tried again.`, 'ETEMPORARY', text);
  return new MailError(`The mail server answered ${r.code} to ${step}: ${text}`, 'EPROTOCOL', text);
}

function open(cfg: SmtpConfig, replies: Replies): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const timeout = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sock = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.rejectUnauthorized !== false })
      : net.connect({ host: cfg.host, port: cfg.port });
    // Listening from the first byte: the greeting can arrive with the connect.
    replies.bind(sock);
    const timer = setTimeout(() => { sock.destroy(); reject(networkError(new MailError('', 'ETIMEDOUT'), cfg)); }, timeout);
    const done = (): void => { clearTimeout(timer); sock.off('error', onErr); resolve(sock); };
    const onErr = (e: Error): void => { clearTimeout(timer); reject(networkError(e, cfg)); };
    sock.once(cfg.secure ? 'secureConnect' : 'connect', done);
    sock.once('error', onErr);
  });
}

function startTls(plain: net.Socket, cfg: SmtpConfig, replies: Replies): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    // The plain socket's bytes are TLS records from here on: they belong to
    // the TLS layer, not to the reply reader.
    replies.unbind();
    const sec = tls.connect({ socket: plain, servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.rejectUnauthorized !== false });
    sec.once('secureConnect', () => { sec.off('error', onErr); replies.bind(sec); resolve(sec); });
    const onErr = (e: Error): void => reject(networkError(e, cfg));
    sec.once('error', onErr);
  });
}

/** EHLO's answer → the extensions it names (AUTH → its mechanisms). */
function extensions(r: Reply): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of r.lines.slice(1)) {
    const [kw, ...args] = line.trim().split(/[\s=]+/);
    if (kw) out.set(kw.toUpperCase(), args.map((a) => a.toUpperCase()));
  }
  return out;
}

/** Send one message. Resolves once the server has ACCEPTED it (250 after DATA). */
export async function sendMail(cfg: SmtpConfig, msg: MailMessage): Promise<SendResult> {
  if (!cfg.host) throw new MailError('Mail is not set up on the server — SMTP_HOST is empty.', 'ECONFIG');
  const sender = parseMailbox(msg.from);
  if (!sender) throw new MailError(`The sender "${oneLine(msg.from)}" is not an email address — check SMTP_FROM.`, 'ECONFIG');
  const seen = new Set<string>();
  const rcpts: string[] = [];
  for (const a of [...msg.to, ...(msg.cc || [])]) {
    const mb = parseMailbox(a);
    if (!mb) throw new MailError(`"${oneLine(a)}" is not an email address`, 'EADDRESS');
    if (!seen.has(mb.address.toLowerCase())) { seen.add(mb.address.toLowerCase()); rcpts.push(mb.address); }
  }
  if (!rcpts.length) throw new MailError('Nobody to send to.', 'EADDRESS');

  const messageId = `<${crypto.randomUUID()}@${sender.address.split('@')[1]}>`;
  const data = dotStuff(buildMime(msg, { messageId }));
  const helo = (cfg.heloName || os.hostname() || 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  const replies = new Replies(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let sock: net.Socket = await open(cfg, replies);

  const expect = async (codes: number[], step: string): Promise<Reply> => {
    let r: Reply;
    try { r = await replies.next(); } catch (e) { throw networkError(e, cfg); }
    if (!codes.includes(r.code)) throw replyError(r, step, cfg, sender.address);
    return r;
  };
  // A credential never goes into an error message: `step` names what was sent.
  const command = (line: string, codes: number[], step: string): Promise<Reply> => { sock.write(`${line}${CRLF}`); return expect(codes, step); };

  try {
    await expect([220], 'the greeting');
    let ehlo = await command(`EHLO ${helo}`, [250], 'EHLO');
    let ext = extensions(ehlo);
    if (!cfg.secure) {
      if (ext.has('STARTTLS')) {
        await command('STARTTLS', [220], 'STARTTLS');
        sock = await startTls(sock, cfg, replies);
        ehlo = await command(`EHLO ${helo}`, [250], 'EHLO');
        ext = extensions(ehlo);
      } else if (cfg.user) {
        throw new MailError(`${cfg.host}:${cfg.port} offers no encryption (STARTTLS), and a password is never sent in the clear. Use port 465 with SMTP_SECURE=true, or 587.`, 'ENOTLS');
      }
    }
    if (cfg.user) {
      const mechs = ext.get('AUTH') || [];
      const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
      if (mechs.includes('PLAIN') || !mechs.length) {
        await command(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass || ''}`)}`, [235], 'login');
      } else if (mechs.includes('LOGIN')) {
        await command('AUTH LOGIN', [334], 'login');
        await command(b64(cfg.user), [334], 'login');
        await command(b64(cfg.pass || ''), [235], 'login');
      } else {
        throw new MailError(`${cfg.host} offers no password login (only ${mechs.join(', ')}).`, 'EAUTH');
      }
    }
    const limit = Number(ext.get('SIZE')?.[0] || 0);
    if (limit > 0 && data.length > limit) {
      throw new MailError(`The email is ${(data.length / 1048576).toFixed(1)} MB and ${cfg.host} takes at most ${(limit / 1048576).toFixed(1)} MB.`, 'ESIZE');
    }
    await command(`MAIL FROM:<${sender.address}>`, [250], 'sender');
    const accepted: string[] = [];
    const rejected: { address: string; reason: string }[] = [];
    for (const to of rcpts) {
      sock.write(`RCPT TO:<${to}>${CRLF}`);
      let r: Reply;
      try { r = await replies.next(); } catch (e) { throw networkError(e, cfg); }
      if (r.code === 250 || r.code === 251) accepted.push(to);
      else rejected.push({ address: to, reason: `${r.code} ${replyText(r)}` });
    }
    if (!accepted.length) {
      throw new MailError(`The mail server refused every recipient — ${rejected.map((x) => `${x.address}: ${x.reason}`).join('; ')}`, 'ERECIPIENTS');
    }
    await command('DATA', [354], 'DATA');
    sock.write(`${data}${CRLF}.${CRLF}`);
    const done = await expect([250], 'the message');
    try { sock.write(`QUIT${CRLF}`); await replies.next(); } catch { /* accepted already */ }
    return { accepted, rejected, messageId, response: replyText(done) };
  } finally {
    replies.unbind();
    sock.destroy();
  }
}
