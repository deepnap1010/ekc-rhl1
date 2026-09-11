// server/src/utils/cycleTime.ts
// THE rule for "how long does one piece of this dia take on THIS machine":
//
//   Dia + machine → cycle time → target.
//
// A stage carries a default time per piece; it may also carry machine-specific
// times, because the same dia genuinely cuts faster on one pipe-cutting
// machine than another. The machine's own time wins when it exists; the
// stage default stands in when it does not; neither means no target can be
// computed — and the caller must refuse to assign rather than guess.
//
// Every place that freezes a snapshot (assign, set-dia, scheduled apply) and
// every place that previews a target calls THIS, so adding machines or dias
// never touches the calculation.
import type { IDiaStage } from '../models/DiaConfig.js';

export type CycleSource = 'machine' | 'stage';
export interface CycleTime { sec: number; source: CycleSource }

const norm = (ref: string): string => String(ref || '').trim().toUpperCase();

export function cycleSecFor(stage: Pick<IDiaStage, 'processingSec' | 'machineTimes'> | null | undefined, machineRef: string): CycleTime | null {
  if (!stage) return null;
  const want = norm(machineRef);
  const own = (stage.machineTimes || []).find((m) => norm(m.machineRef) === want);
  if (own && own.processingSec > 0) return { sec: own.processingSec, source: 'machine' };
  if (stage.processingSec > 0) return { sec: stage.processingSec, source: 'stage' };
  return null;
}

/** The message an admin reads when a dia cannot be put on a machine. */
export const noCycleMsg = (diaName: string, stageName: string, machineRef: string): string =>
  `No cycle time configured for "${diaName}" (${stageName}) on ${machineRef} — set one in Production Targets before assigning`;
