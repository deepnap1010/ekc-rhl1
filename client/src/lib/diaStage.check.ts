// client/src/lib/diaStage.check.ts — run: npx tsx client/src/lib/diaStage.check.ts
import { stageForMachine } from './diaStage.js';

const eq = (a: unknown, b: unknown, m: string): void => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};
const dia = { stages: [
  { key: 'cutting', name: 'Cutting', seq: 1, processingSec: 180, active: true },
  { key: 'spg', name: 'SPG', seq: 2, processingSec: 300, active: true },
  { key: 'off', name: 'Bottom Milling', seq: 3, processingSec: 60, active: false },
] };
eq(stageForMachine('CUTTINGMACHINE05', dia)?.key, 'cutting', 'stem contains the stage name');
eq(stageForMachine('SPG-08', dia)?.key, 'spg', 'short stage name matches the stem');
eq(stageForMachine({ code: 'BOTTOMMILLING04' }, dia), null, 'inactive stages never match');
eq(stageForMachine('QUENCHINGFURNACE02', dia), null, 'no match → null, never a guess');

// Plant vocabulary: an SPG machine RUNS the Spinning stage, an ISB machine
// runs Internal Shot Blasting — abbreviations no substring could discover.
const named = { stages: [
  { key: 'cutting', name: 'Cutting', seq: 1, processingSec: 180, active: true },
  { key: 'spinning', name: 'Spinning', seq: 2, processingSec: 300, active: true },
  { key: 'shot', name: 'Internal Shot Blasting', seq: 3, processingSec: 120, active: true },
] };
eq(stageForMachine('SPG02', named)?.key, 'spinning', 'SPG family → Spinning stage');
eq(stageForMachine('SPG-08', named)?.key, 'spinning', 'hyphenated SPG too');
eq(stageForMachine('ISB01', named)?.key, 'shot', 'ISB family → Internal Shot Blasting');
eq(stageForMachine('QUENCHINGFURNACE02', named), null, 'aliases never widen to non-members');
eq(stageForMachine('CUTTINGMACHINE05', null), null, 'no dia → null');
console.log('diaStage: all checks passed');
