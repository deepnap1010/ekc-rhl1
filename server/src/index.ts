// server/src/index.ts
import http from 'http';
import { createApp } from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import { runStartupMigrations } from './config/migrations.js';
import { env } from './config/env.js';
import { initSocket } from './sockets/io.js';
import { startWatchers, stopWatchers } from './services/watch.service.js';
import { startDowntimeMonitor, stopDowntimeMonitor } from './services/downtime.service.js';
import { startScheduleTicker, stopScheduleTicker } from './services/schedule.service.js';

async function start(): Promise<void> {
  await connectDB();
  // Repairs that must happen before anything serves (see config/migrations).
  await runStartupMigrations();

  const app    = createApp();
  const server = http.createServer(app);
  initSocket(server);

  // Live updates come straight from MongoDB change streams on the real collections.
  // No ingest, no simulation, no DB polling — we react to what the factory writes.
  startWatchers();
  // Derive machine state (running/idle/stopped/offline) and record downtime spans.
  startDowntimeMonitor();
  // Apply scheduled dia assignments at their minute (and catch up on startup).
  startScheduleTicker();

  server.listen(env.port, () => {
    console.log(`[server] EKC SmartFactory API on :${env.port} (${env.nodeEnv})`);
  });

  const shutdown = async (): Promise<void> => {
    stopDowntimeMonitor();
    stopScheduleTicker();
    await stopWatchers();
    server.close();
    await disconnectDB();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
