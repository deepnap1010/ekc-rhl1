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
eq(stageForMachine('CUTTINGMACHINE05', null), null, 'no dia → null');
console.log('diaStage: all checks passed');
