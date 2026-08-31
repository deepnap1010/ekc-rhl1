// Self-check for scripts/sync-to-atlas.mjs, against two throwaway MongoDB servers.
// Proves the one property the whole design rests on: the factory copy is never
// touched, and Atlas only ever receives.
//
//   npm i --no-save mongodb-memory-server     (one-off)
//   npm run check:sync
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { MongoClient } = mongoose.mongo;
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sync-to-atlas.mjs');
let bad = 0;
const check = (c, l) => { console.log(`${c ? 'ok  ' : '!!  '}${l}`); if (!c) bad++; };

const src = await MongoMemoryServer.create();
const dst = await MongoMemoryServer.create();
const A = new MongoClient(src.getUri()); await A.connect();
const B = new MongoClient(dst.getUri()); await B.connect();
const a = A.db('test'), b = B.db('test');

await a.collection('machines').insertMany([
  { _id: 'm1', code: 'SPG02', status: 'running' },
  { _id: 'm2', code: 'BOTTOMMILLING03', status: 'idle' },
]);
await a.collection('downtime_reports').insertOne({ _id: 'd1', machineId: 'SPG02', minutes: 12 });
await a.collection('dia_configs').insertOne({ _id: 'x1', name: 'CN 410 X 60L' });
const now = Date.now();
await a.collection('telemetries').insertMany([
  { _id: 't_old', machineId: 'SPG02', timestamp: new Date(now - 10 * 86400e3), data: { v: 1 } },
  { _id: 't_new1', machineId: 'SPG02', timestamp: new Date(now - 3600e3), data: { v: 2 } },
  { _id: 't_new2', machineId: 'SPG02', timestamp: new Date(now - 60e3), data: { v: 3 } },
]);

const run = () => execFileSync(process.execPath, [SCRIPT], {
  env: { ...process.env, LOCAL_URI: src.getUri(), ATLAS_URI: dst.getUri(),
    DB_NAME: 'test', TELEMETRY_HOURS: '48', TELEMETRY_TTL_D: '3' },
  encoding: 'utf8',
});

run();
check(await b.collection('machines').countDocuments() === 2, 'machines reach the review copy');
check(await b.collection('downtime_reports').countDocuments() === 1, 'downtime reports reach it');
check(await b.collection('telemetries').countDocuments() === 2, 'only the recent telemetry slice goes up');
check(await b.collection('telemetries').findOne({ _id: 't_old' }) === null, 'older readings stay at the factory');
const ttl = (await b.collection('telemetries').indexes()).find((i) => i.name === 'timestamp_-1');
check(ttl?.expireAfterSeconds === 259200, 'Atlas expires its own telemetry, so it cannot fill up');

await a.collection('machines').updateOne({ _id: 'm2' }, { $set: { status: 'stopped' } });
await a.collection('dia_configs').deleteOne({ _id: 'x1' });
await a.collection('telemetries').insertOne({ _id: 't_new3', machineId: 'SPG02', timestamp: new Date(), data: { v: 4 } });
run();
check((await b.collection('machines').findOne({ _id: 'm2' }))?.status === 'stopped', 'changes update on the next run');
check(await b.collection('dia_configs').countDocuments() === 0, 'a deletion at the factory propagates up');
check(await b.collection('telemetries').countDocuments() === 3, 're-running inserts only what is new');
check(await a.collection('telemetries').countDocuments() === 4, 'THE FACTORY COPY IS UNTOUCHED — it still has everything');

await A.close(); await B.close(); await src.stop(); await dst.stop();
console.log(bad ? `\nFAIL: ${bad} check(s)` : '\nALL OK');
process.exit(bad ? 1 : 0);
