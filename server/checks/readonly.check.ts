// Self-check for the review-copy guard (middleware/readOnly).
//   npm run check:readonly
//
// Two ways this can be wrong, and both are bad: block nothing, and a change
// made from outside is silently overwritten by the next sync; or block too
// much, and nobody can sign in to look at the thing at all.
process.env.READ_ONLY = '1';
const { readOnlyGuard } = await import('../src/middleware/readOnly.js');

let bad = 0;
const check = (c: boolean, l: string): void => { console.log(`${c ? 'ok  ' : '!!  '}${l}`); if (!c) bad++; };

/** Returns 'through' when the request is allowed, or the refusal's code. */
function run(method: string, path: string): string {
  let out = 'through';
  const req = { method, path } as never;
  const res = {
    status(c: number) { out = `status ${c}`; return this; },
    json(b: { error?: { code?: string } }) { out = b?.error?.code || out; return this; },
  } as never;
  readOnlyGuard(req, res, () => { out = 'through'; });
  return out;
}

// ── reading is always fine: the whole point is to look ──────────────────────
for (const p of ['/machines', '/dashboard/overview', '/production/targets', '/machines/labels']) {
  check(run('GET', p) === 'through', `GET ${p} passes`);
}

// ── signing in must work, or the copy is unusable ───────────────────────────
check(run('POST', '/auth/login') === 'through', 'POST /auth/login passes — you have to sign in to look');
check(run('POST', '/auth/refresh') === 'through', 'POST /auth/refresh passes');
check(run('POST', '/auth/logout') === 'through', 'POST /auth/logout passes');

// ── every other write is refused, whatever the route ────────────────────────
const writes: [string, string][] = [
  ['POST', '/production/assignments'], ['PUT', '/machines/SPG02/label'],
  ['PATCH', '/production/orders/1'], ['DELETE', '/production/dia/1'],
  ['POST', '/users'], ['POST', '/ingest'], ['PUT', '/config'],
];
for (const [m, p] of writes) {
  check(run(m, p) === 'READ_ONLY', `${m} ${p} is refused`);
}

// ── and a route that merely STARTS like an auth path is not a way in ────────
check(run('POST', '/auth/login/../users') === 'READ_ONLY', 'a path that only looks like /auth/login is refused');
check(run('POST', '/auth/loginx') === 'READ_ONLY', 'and so is /auth/loginx');

console.log(bad ? `\nFAIL: ${bad}` : '\nALL OK');
process.exit(bad ? 1 : 0);
