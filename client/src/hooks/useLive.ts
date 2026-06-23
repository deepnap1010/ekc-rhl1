// client/src/hooks/useLive.ts
import { useEffect, useState } from 'react';
import { getSocket } from '../lib/socket';
import type { MachineTick, TicksMap, MachineUpdate, Telemetry } from '../types/api';

// Dashboard/Machines live feed. Returns a map of machine code -> latest snapshot tick,
// pushed by the server's change stream on the `machines` collection.
export function useDashboardLive(): TicksMap {
  const [ticks, setTicks] = useState<TicksMap>({});
  useEffect(() => {
    const s = getSocket();
    s.emit('subscribe:dashboard');
    const onTick = (t: MachineTick) => setTicks((prev) => ({ ...prev, [t.machineId]: t }));
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
    const onUpdate = (m: MachineUpdate) => { if (m.code === code) setMachine(m); };
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
    const onNew = (t: Telemetry) => setLatest(t);
    s.on('telemetry:new', onNew);
    return () => { s.off('telemetry:new', onNew); };
  }, [code]);
  return latest;
}
