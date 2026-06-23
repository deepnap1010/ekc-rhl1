// server/src/services/fleet.service.ts
// One pass over the fleet: for every machine, pull its latest telemetry (single
// index-backed $lookup) and run the health engine on it. The alerts feed builds on
// this snapshot, so health is computed once and consistently.
import type { PipelineStage } from 'mongoose';
import { Machine } from '../models/Machine.js';
import { getProfile } from '../config/machineProfiles.js';
import { normalizeData, rankNamed } from '../utils/normalize.js';
import { machineHealth, type HealthResult } from '../utils/health.js';

interface FleetDoc {
  _id: unknown;
  machineId?: string;
  machineName?: string;
  machineType?: string;
  status?: string;
  lastSeenAt?: string | Date | null;
  updatedAt?: string | Date | null;
  payloadCount?: number;
  _latestRow?: { data?: Record<string, unknown>; timestamp?: string | Date | null };
}

export interface FleetKeyMetric { key: string; value: unknown; fault: boolean; }

export interface FleetMachine {
  machineId: string;
  name: string;
  type: string | null;
  class: string | null;
  subtitle: string | null;
  status: string;
  lastSeenAt: string | Date | null;
  ts: string | Date | null;
  readings: number | null;
  signals: number;
  namedCount: number;
  ioCount: number;
  registers: number;
  faultCount: number;
  keyMetrics: FleetKeyMetric[];
  health: HealthResult;
}

export async function getFleetSnapshot(scope: string[] | null = null): Promise<FleetMachine[]> {
  const pipeline: PipelineStage[] = [
    ...(scope ? [{ $match: { machineId: { $in: scope } } }] : []),
    {
      $lookup: {
        from: 'telemetries',
        let: { ref: '$machineId' },
        pipeline: [
          { $match: { $expr: { $eq: ['$machineId', '$$ref'] } } },
          { $sort: { timestamp: -1 } },
          { $limit: 1 },
          { $project: { _id: 0, data: 1, timestamp: 1 } },
        ],
        as: '_latest',
      },
    },
    { $addFields: { _latestRow: { $first: '$_latest' } } },
    { $project: { _latest: 0 } },
  ];

  const docs = await Machine.aggregate<FleetDoc>(pipeline);

  return docs.map((d) => {
    const data = d._latestRow?.data || {};
    const profile = getProfile(d.machineId || '');
    const { named, inputs, outputs, registers } = normalizeData(data);
    const health = machineHealth(d, data, profile);

    const ranked = rankNamed(named);
    const io = [...inputs, ...outputs];
    const keyMetrics: FleetKeyMetric[] = ranked.length
      ? ranked.slice(0, 4).map((m) => ({ key: m.key, value: m.value, fault: m.fault }))
      : io.slice(0, 4).map((m) => ({ key: m.key, value: m.on ? 'ON' : 'OFF', fault: false }));

    return {
      machineId: d.machineId || String(d._id),
      name: d.machineName || d.machineId || '—',
      type: d.machineType || null,
      class: profile?.class || null,
      subtitle: profile?.subtitle || null,
      status: d.status || 'offline',
      lastSeenAt: d.lastSeenAt || d.updatedAt || null,
      ts: d._latestRow?.timestamp || null,
      readings: d.payloadCount ?? null,
      signals: named.length + inputs.length + outputs.length,
      namedCount: named.length,
      ioCount: inputs.length + outputs.length,
      registers: registers.length,
      faultCount: named.filter((m) => m.fault).length,
      keyMetrics,
      health,
    };
  });
}
