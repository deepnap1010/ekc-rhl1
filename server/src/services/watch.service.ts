// server/src/services/watch.service.ts
// The "live" mechanism. Instead of fetching data from any external API or
// simulating it, we open MongoDB Change Streams on the real collections that the
// factory system writes to. When a machine snapshot updates or a new telemetry
// reading lands, we react and push it to subscribed clients over Socket.io.
//
// This is fully READ-ONLY: change streams observe, they never write.
// Atlas (replica set) supports change streams. If they're unavailable for any
// reason, the watchers fail soft — the UI still refreshes via its REST polling.
import type { Types } from 'mongoose';
import { Machine }   from '../models/Machine.js';
import type { IMachine } from '../models/Machine.js';
import { Telemetry } from '../models/Telemetry.js';
import { getIO }     from '../sockets/io.js';
import type { MachineTick } from '../types/socket.js';
import { errMessage } from '../utils/http.js';

// The fullDocument shape emitted by the change streams (schema fields + _id).
type MachineDoc = IMachine & { _id: Types.ObjectId };

// The change-stream handle type as returned by Model.watch().
type ChangeStream = ReturnType<typeof Machine.watch>;

let streams: ChangeStream[] = [];

// Compact projection broadcast to the dashboard room — small payload, many clients.
function toTick(doc: MachineDoc): MachineTick {
  const id = doc.code || String(doc._id);
  return {
    machineId:         id,                  // dashboard keys live ticks by this id
    code:              doc.code,
    name:              doc.name,
    type:              doc.type,
    status:            doc.status,
    oee:               doc.oee,
    totalOutput:       doc.totalOutput,
    currentParameters: doc.currentParameters || {},
    lastReadingAt:     doc.lastReadingAt,
  };
}

function watchMachines(): ChangeStream {
  const stream = Machine.watch([], { fullDocument: 'updateLookup' });

  stream.on('change', (change) => {
    if (change.operationType === 'delete') {
      getIO()?.to('dashboard').emit('machine:removed', { id: change.documentKey?._id });
      return;
    }
    const doc = 'fullDocument' in change ? (change.fullDocument as MachineDoc | undefined) : undefined;
    if (!doc) return;
    const id = doc.code || String(doc._id);
    const io = getIO();
    if (!io) return;
    io.to('dashboard').emit('machine:tick', toTick(doc));
    io.to(`machine:${id}`).emit('machine:update', doc as unknown as Record<string, unknown>);
  });

  stream.on('error', (err: unknown) => {
    console.error('[watch] machines stream error:', errMessage(err));
  });

  return stream;
}

function watchTelemetries(): ChangeStream {
  // Only care about new readings being appended.
  const stream = Telemetry.watch([{ $match: { operationType: 'insert' } }], {
    fullDocument: 'updateLookup',
  });

  stream.on('change', (change) => {
    const doc = 'fullDocument' in change ? change.fullDocument : undefined;
    if (!doc?.machineId) return;
    const io = getIO();
    if (!io) return;
    const payload = {
      machineId: doc.machineId,
      timestamp: doc.timestamp,
      data:      doc.data || {},
    };
    io.to('dashboard').emit('telemetry:new', payload);
    io.to(`machine:${doc.machineId}`).emit('telemetry:new', { ...payload, _id: doc._id, receivedAt: doc.receivedAt });
  });

  stream.on('error', (err: unknown) => {
    console.error('[watch] telemetries stream error:', errMessage(err));
  });

  return stream;
}

export function startWatchers(): void {
  try {
    streams = [watchMachines(), watchTelemetries()];
    console.log('[watch] change streams active on machines + telemetries');
  } catch (err) {
    console.warn('[watch] change streams unavailable — UI will rely on REST polling:', errMessage(err));
  }
}

export async function stopWatchers(): Promise<void> {
  await Promise.allSettled(streams.map((s) => s.close()));
  streams = [];
}
