// client/src/lib/diaStage.ts
// Which of a DIA's stages a machine performs — matched by NAME against the
// machine's family stem, the teammate-built heuristic adopted whole: stage
// "Cutting" claims CUTTINGMACHINE05 because the stem contains it (either
// direction, so short stems match long names too). First active stage in the
// DIA's order that matches wins; no match → null, and the assign modal falls
// back to asking.
import type { DiaConfig, DiaStage } from '../types/api';

const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

// The plant's abbreviations — a machine family on the left, the stage names it
// performs on the right. "SPG02 runs Spinning" is vocabulary, not something a
// substring can discover. Mirrored on the server (production.controller's
// setMachineDia), so the UI and the API auto-pick identically.
const FAMILY_STAGE_ALIASES: Record<string, string[]> = {
  SPG: ['SPINNING'],
  ISB: ['INTERNALSHOTBLASTING', 'SHOTBLASTING'],
};

export function stageForMachine(
  machine: { code?: string; machineId?: string; name?: string; type?: string | null } | string,
  dia: Pick<DiaConfig, 'stages'> | null | undefined,
): DiaStage | null {
  if (!dia) return null;
  const ref = typeof machine === 'string' ? machine : `${machine.code || machine.machineId || ''}`;
  const stem = norm(ref).replace(/\d+$/, '');
  const hay = typeof machine === 'string'
    ? norm(machine)
    : norm(`${machine.code || ''} ${machine.machineId || ''} ${machine.name || ''} ${machine.type || ''}`);
  const candidates = [stem, ...(FAMILY_STAGE_ALIASES[stem] ?? [])];
  for (const st of dia.stages) {
    if (!st.active) continue;
    const n = norm(st.name);
    if (!n) continue;
    for (const cand of candidates) {
      if (cand.includes(n) || n.includes(cand) || hay.includes(n)) return st;
    }
  }
  return null;
}
