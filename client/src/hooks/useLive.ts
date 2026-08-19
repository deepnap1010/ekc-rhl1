// client/src/hooks/useLive.ts
import { useEffect, useState } from 'react';
import { getSocket } from '../lib/socket';
import type { MachineTick, TicksMap, MachineUpdate, Telemetry } from '../types/api';

// Socket events arrive on every ingest (every few seconds); applying each one makes the
// displayed parameters jitter. Apply at most one update per machine every 10s — the
// first event lands immediately so pages populate fast.
const LIVE_APPLY_MS = 10_000;

function throttlePerKey<T>(keyOf: (t: T) => string, apply: (t: T) => void): (t: T) => void {
  const lastAt = new Map<string, number>();
  return (t) => {
    const k = keyOf(t), now = Date.now();
    if (now - (lastAt.get(k) || 0) < LIVE_APPLY_MS) return;
    lastAt.set(k, now);
    apply(t);
  };
}

// Dashboard/Machines live feed. Returns a map of machine code -> latest snapshot tick,
// pushed by the server's change stream on the `machines` collection.
export function useDashboardLive(): TicksMap {
  const [ticks, setTicks] = useState<TicksMap>({});
  useEffect(() => {
    const s = getSocket();
    s.emit('subscribe:dashboard');
    const onTick = throttlePerKey((t: MachineTick) => t.machineId, (t) => setTicks((prev) => ({ ...prev, [t.machineId]: t })));
    s.on('machine:tick', onTick);
    return () => { s.off('machine:tick', onTick); };
  }, []);
  return ticks;
}

// A single machine's live snapshot updates (currentParameters / status / oee / output).
export function useMachineLive(code?: string): MachineUpdate | null {
  const [machine, setMachine] = useState<MachineUpdate | null>(null);
  useEffect(() => {
    if (!code) return;
    const s = getSocket();
    s.emit('subscribe:machine', code);
    const apply = throttlePerKey(() => code, (m: MachineUpdate) => setMachine(m));
    const onUpdate = (m: MachineUpdate) => { if (m.code === code) apply(m); };
    s.on('machine:update', onUpdate);
    return () => {
      s.emit('unsubscribe:machine', code);
      s.off('machine:update', onUpdate);
    };
  }, [code]);
  return machine;
}

// Live telemetry inserts for one machine — used to grow the history view in real time.
export function useMachineTelemetry(code?: string): Telemetry | null {
  const [latest, setLatest] = useState<Telemetry | null>(null);
  useEffect(() => {
    if (!code) return;
    const s = getSocket();
    s.emit('subscribe:machine', code);
    const onNew = throttlePerKey(() => code, (t: Telemetry) => setLatest(t));
    s.on('telemetry:new', onNew);
    return () => { s.off('telemetry:new', onNew); };
  }, [code]);
  return latest;
}
