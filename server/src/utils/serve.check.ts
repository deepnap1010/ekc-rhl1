// Self-check for how the built client is served: the build stamp in the page
// and on /health, no-cache on the page, immutable on hashed assets, and the
// SPA fallback. Needs client/dist (npm run build in client/), no database.
// Run: npx tsx server/src/utils/serve.check.ts
import { createApp } from '../app.js';
import type { AddressInfo } from 'node:net';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

const app = createApp();
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
try {
  const health = await (await fetch(`${base}/health`)).json() as { ok: boolean; build: string | null };
  eq('health answers', health.ok, true);
  if (!health.build) throw new Error('no client/dist — build the client first');
  eq('the build stamp is 12 hex chars', /^[0-9a-f]{12}$/.test(health.build), true);

  const page = await fetch(`${base}/machines`);   // an SPA route, not a file
  const html = await page.text();
  eq('the SPA fallback serves the page', html.includes('<div id="root">') || html.includes('id="root"'), true);
  eq('the page carries the stamp', html.includes(`<meta name="ekc-build" content="${health.build}">`), true);
  eq('the page is never cached', page.headers.get('cache-control'), 'no-cache');

  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  if (!asset) throw new Error('no hashed script in the page');
  const js = await fetch(`${base}${asset}`);
  eq('a hashed asset is served', js.status, 200);
  eq('a hashed asset caches for a year', js.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const api = await fetch(`${base}/api/v1/auth/me`);
  eq('the API still answers under /api', api.status, 401);
  console.log('serve: all checks passed');
} finally {
  server.close();
}
