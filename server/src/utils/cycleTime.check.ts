// Self-check for the dia+machine cycle-time rule. Run: npx tsx server/src/utils/cycleTime.check.ts
import { cycleSecFor } from './cycleTime.js';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

const cutting = {
  processingSec: 30,
  machineTimes: [
    { machineRef: 'CUTTINGMACHINE02', processingSec: 40 },
    { machineRef: 'cuttingmachine03', processingSec: 25 },
  ],
};

// The spec's own example: dia 20 → 30 s on machine 1, 40 s on 2, 25 s on 3.
eq('machine 1 has no own time → stage default', cycleSecFor(cutting, 'CUTTINGMACHINE01'), { sec: 30, source: 'stage' });
eq('machine 2 → its own 40 s', cycleSecFor(cutting, 'CUTTINGMACHINE02'), { sec: 40, source: 'machine' });
eq('machine 3 → its own 25 s, case-insensitively', cycleSecFor(cutting, 'CUTTINGMACHINE03'), { sec: 25, source: 'machine' });
eq('ref spelling on the other side too', cycleSecFor(cutting, ' cuttingmachine02 '), { sec: 40, source: 'machine' });

// 8 h × 3600 / 40 = 720 — the target the spec expects on machine 2.
const t = cycleSecFor(cutting, 'CUTTINGMACHINE02')!;
eq('8h on machine 2 = 720 pieces', Math.floor((8 * 3600) / t.sec), 720);

// A stage with NO default is machine-specific only: a machine without its own
// time gets no cycle time at all — the caller must refuse, never guess.
const specific = { processingSec: 0, machineTimes: [{ machineRef: 'CUTTINGMACHINE02', processingSec: 40 }] };
eq('machine-only stage: configured machine works', cycleSecFor(specific, 'CUTTINGMACHINE02'), { sec: 40, source: 'machine' });
eq('machine-only stage: other machine → null', cycleSecFor(specific, 'CUTTINGMACHINE01'), null);
eq('no stage → null', cycleSecFor(null, 'CUTTINGMACHINE01'), null);
eq('legacy stage without machineTimes → default', cycleSecFor({ processingSec: 30 }, 'X'), { sec: 30, source: 'stage' });

console.log('cycleTime: all checks passed');
