#!/usr/bin/env node
// server/scripts/sync-to-atlas.mjs
//
// Pushes a REVIEW COPY of the factory's data up to Atlas. The factory server is
// the source of truth and keeps everything forever; Atlas is a small, expendable
// window onto it so the site can be reviewed from anywhere — which machines are
// down, what broke, what got made.
//
// Nothing here ever reads FROM Atlas or writes to the factory. If Atlas is full,
// unreachable, or wiped, this script fails and the plant does not notice: the
// local database and the local dashboard never touch it.
//
//   LOCAL_URI=mongodb://ekc_app:pw@127.0.0.1:27017/?authSource=admin&replicaSet=rs0 \
//   ATLAS_URI='<atlas srv string>' \
//   node scripts/sync-to-atlas.mjs
//
// Options (env):
//   DB_NAME          database on both sides            (default: test)
//   TELEMETRY_HOURS  how much raw telemetry to mirror  (default: 48)
//   TELEMETRY_TTL_D  days Atlas keeps telemetry        (default: 3, 0 = no TTL)
//
// Run it from cron every 5 minutes; see the runbook for the crontab line.
import mongoose from 'mongoose';

const { MongoClient } = mongoose.mongo;

const LOCAL_URI = process.env.LOCAL_URI || 'mongodb://127.0.0.1:27017';
const ATLAS_URI = process.env.ATLAS_URI;
const DB_NAME = process.env.DB_NAME || 'test';
const TELEMETRY_HOURS = Number(process.env.TELEMETRY_HOURS ?? 48);
const TELEMETRY_TTL_D = Number(process.env.TELEMETRY_TTL_D ?? 3);

// The firehose is handled differently from everything else: ~120 MB a day, so
// only a recent slice goes up, and Atlas expires it on its own.
const FIREHOSE = 'telemetries';
const BATCH = 1000;

if (!ATLAS_URI) {
  console.error('ATLAS_URI is not set — refusing to run.');
  process.exit(2);
}

const isQuotaError = (e) =>
  /over your space quota|you are over your space quota|AtlasError/i.test(String(e?.message || e));

/** Atlas expires its own telemetry, so "delete it when full" stops being a chore. */
async function ensureTelemetryTtl(atlasDb) {
  if (TELEMETRY_TTL_D <= 0) return 'TTL disabled';
  const seconds = Math.round(TELEMETRY_TTL_D * 86_400);
  const col = atlasDb.collection(FIREHOSE);
  const existing = (await col.indexes().catch(() => [])).find((i) => i.name === 'timestamp_-1');
  if (existing?.expireAfterSeconds === seconds) return `TTL already ${TELEMETRY_TTL_D}d`;
  try {
    // collMod converts an existing plain index into a TTL one without a rebuild.
    if (existing) {
      await atlasDb.command({ collMod: FIREHOSE, index: { name: 'timestamp_-1', expireAfterSeconds: seconds } });
      return `TTL set to ${TELEMETRY_TTL_D}d`;
    }
    await col.createIndex({ timestamp: -1 }, { name: 'timestamp_-1', expireAfterSeconds: seconds });
    return `TTL index created (${TELEMETRY_TTL_D}d)`;
  } catch (e) {
    return `TTL not set: ${e.message}`;
  }
}

/** Mirror a small collection wholesale: upsert what exists, drop what no longer does. */
async function mirrorCollection(localDb, atlasDb, name) {
  const docs = await localDb.collection(name).find({}).toArray();
  const target = atlasDb.collection(name);
  let written = 0;

  for (let i = 0; i < docs.length; i += BATCH) {
    const slice = docs.slice(i, i + BATCH);
    const res = await target.bulkWrite(
      slice.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
      { ordered: false },
    );
    written += (res.upsertedCount || 0) + (res.modifiedCount || 0);
  }

  // Anything deleted on the factory side should disappear from the review copy
  // too, or a retired dia lives on in Atlas forever.
  const localIds = new Set(docs.map((d) => String(d._id)));
  const stale = (await target.find({}, { projection: { _id: 1 } }).toArray())
    .filter((d) => !localIds.has(String(d._id)))
    .map((d) => d._id);
  if (stale.length) await target.deleteMany({ _id: { $in: stale } });

  return { count: docs.length, written, removed: stale.length };
}

/** Mirror the recent slice of the firehose. Re-running is safe: same _id, skipped. */
async function mirrorTelemetry(localDb, atlasDb) {
  const since = new Date(Date.now() - TELEMETRY_HOURS * 3_600_000);
  const cursor = localDb.collection(FIREHOSE).find({ timestamp: { $gte: since } }).sort({ timestamp: 1 });
  const target = atlasDb.collection(FIREHOSE);
  let seen = 0, inserted = 0, buf = [];

  const flush = async () => {
    if (!buf.length) return;
    try {
      const res = await target.insertMany(buf, { ordered: false });
      inserted += res.insertedCount;
    } catch (e) {
      // Duplicate keys are the normal case on a re-run — count what did land.
      if (e?.writeErrors && e.result) {
        inserted += e.result.nInserted ?? 0;
        const fatal = e.writeErrors.filter((w) => w.code !== 11000);
        if (fatal.length) throw fatal[0].err ?? e;
      } else throw e;
    }
    buf = [];
  };

  for await (const doc of cursor) {
    buf.push(doc);
    seen += 1;
    if (buf.length >= BATCH) await flush();
  }
  await flush();
  return { count: seen, written: inserted, removed: 0 };
}

async function main() {
  const t0 = Date.now();
  const local = new MongoClient(LOCAL_URI, { serverSelectionTimeoutMS: 8000 });
  const atlas = new MongoClient(ATLAS_URI, { serverSelectionTimeoutMS: 15000 });
  const rows = [];
  let quotaHit = false;

  try {
    await local.connect();
    await atlas.connect();
    const localDb = local.db(DB_NAME);
    const atlasDb = atlas.db(DB_NAME);

    console.log(`[sync] ${DB_NAME}: factory → Atlas review copy`);
    console.log(`[sync] ${await ensureTelemetryTtl(atlasDb)}`);

    const names = (await localDb.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.'))
      .sort();

    for (const name of names) {
      try {
        const r = name === FIREHOSE
          ? await mirrorTelemetry(localDb, atlasDb)
          : await mirrorCollection(localDb, atlasDb, name);
        rows.push([name, r.count, r.written, r.removed, 'ok']);
      } catch (e) {
        if (isQuotaError(e)) {
          quotaHit = true;
          rows.push([name, '—', 0, 0, 'ATLAS FULL']);
          break;
        }
        rows.push([name, '—', 0, 0, `error: ${e.message.slice(0, 40)}`]);
      }
    }
  } finally {
    await local.close().catch(() => {});
    await atlas.close().catch(() => {});
  }

  const pad = (v, n) => String(v).padEnd(n);
  const padS = (v, n) => String(v).padStart(n);
  console.log(`\n${pad('collection', 24)}${padS('local', 9)}${padS('sent', 8)}${padS('pruned', 8)}  status`);
  for (const [n, c, w, r, s] of rows) console.log(`${pad(n, 24)}${padS(c, 9)}${padS(w, 8)}${padS(r, 8)}  ${s}`);
  console.log(`\n[sync] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (quotaHit) {
    console.error(
      '\n[sync] Atlas is out of space. The factory database is UNAFFECTED — it has every\n' +
      '       reading and the local dashboard is still recording. To free the review copy:\n' +
      `         db.${FIREHOSE}.deleteMany({ timestamp: { $lt: new Date(Date.now() - 86400000) } })\n` +
      '       A TTL index normally prevents this; check it exists on Atlas.',
    );
    process.exit(1);
  }
}

main().catch((e) => { console.error('[sync] failed:', e.message); process.exit(1); });
