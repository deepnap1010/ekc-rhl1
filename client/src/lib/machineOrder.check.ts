// Self-check for the grouping rules. Run: npx --prefix server tsx client/src/lib/machineOrder.check.ts
// (no test runner in this project — plain asserts, one file, runnable anywhere)
import { groupOf, groupMachines, canonicalFamily, familySpellings } from './machineOrder';

const eq = (what: string, got: unknown, want: unknown): void => {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)];
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
};
const label = (code: string): string => groupOf({ code }).label;
const key = (code: string): string => groupOf({ code }).key;

// Codes collapse to their family, however they're numbered or punctuated…
eq('CUTTINGMACHINE06 key', key('CUTTINGMACHINE06'), 'CUTTINGMACHINE');
eq('SPG-06 key', key('SPG-06'), 'SPG');
eq('SPG02 key', key('SPG02'), 'SPG');
eq('BOTTOMMILLING2 key', key('BOTTOMMILLING2'), 'BOTTOMMILLING');

// …and read like names.
eq('CUTTINGMACHINE06 label', label('CUTTINGMACHINE06'), 'Cutting Machine');
eq('BOTTOMMILLING03 label', label('BOTTOMMILLING03'), 'Bottom Milling');
eq('QUENCHINGFURNACE02 label', label('QUENCHINGFURNACE02'), 'Quenching Furnace');
eq('HYDRAULICPRESS02 label', label('HYDRAULICPRESS02'), 'Hydraulic Press');
eq('CNCLATHE04 label', label('CNCLATHE04'), 'CNC Lathe');
eq('SPG08 label', label('SPG08'), 'SPG');
eq('INTERNALSHOTBLASTING03 label', label('INTERNALSHOTBLASTING03'), 'Internal Shot Blasting');

// A machine nobody planned for still gets a group — no config to update.
eq('unknown family', key('ROBOARM07'), 'ROBOARM');

const groups = groupMachines([
  { code: 'SPG-06' }, { code: 'CUTTINGMACHINE07' }, { code: 'SPG02' },
  { code: 'QUENCHINGFURNACE02' }, { code: 'CUTTINGMACHINE05' }, { code: 'ROBOARM07' },
]);
eq('group order', groups.map((g) => g.key), ['CUTTINGMACHINE', 'SPG', 'QUENCHINGFURNACE', 'ROBOARM']);
eq('order inside a group', groups[0].machines.map((m) => m.code), ['CUTTINGMACHINE05', 'CUTTINGMACHINE07']);
eq('SPG members', groups[1].machines.length, 2);

// ── One family, two spellings ────────────────────────────────────────────────
// ISB01 and INTERNALSHOTBLASTING03 are the same shot-blasting line. Two cards
// for one line would split its output in half on every board.
const isb = groupMachines([{ code: 'ISB01' }, { code: 'INTERNALSHOTBLASTING03' }, { code: 'ISB02' }]);
eq('ISB and INTERNALSHOTBLASTING form ONE family', isb.length, 1);
eq('and it holds all three machines', isb[0].machines.length, 3);
eq('the merged family reads as the full name', isb[0].label, 'Internal Shot Blasting');
eq('the long spelling files under the short stem', canonicalFamily('INTERNALSHOTBLASTING'), 'ISB');
eq('so does the middle one', canonicalFamily('SHOTBLASTING'), 'ISB');
eq('a family with one spelling is untouched', canonicalFamily('CUTTINGMACHINE'), 'CUTTINGMACHINE');
eq('stage matching sees every spelling', familySpellings('ISB').join(','), 'ISB,INTERNALSHOTBLASTING,SHOTBLASTING');
eq('and just the one where there is only one', familySpellings('CUTTINGMACHINE').join(','), 'CUTTINGMACHINE');
eq('unrelated families stay apart', groupMachines([{ code: 'CUTTINGMACHINE04' }, { code: 'ISB01' }]).length, 2);

console.log('machineOrder: all checks passed');
