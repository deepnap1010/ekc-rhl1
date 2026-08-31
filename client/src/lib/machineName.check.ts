// client/src/lib/machineName.check.ts — npx tsx src/lib/machineName.check.ts
// The rule this file defends: a rename changes the LABEL and never the identity,
// and the label is shared — it comes from the server, so it cannot differ
// between the admin who set it and the operator reading the board.
import { loadMachineLabels, machineNameOf, machineTitleOf, hasCustomName, normRef } from './machineName.js';

const eq = (a: unknown, b: unknown, m: string): void => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

// ── punctuation and case never split one machine in two ──────────────────────
eq(normRef('SPG-06'), normRef('SPG06'), 'hyphen variant matches');
eq(normRef('bottom milling 03'), 'BOTTOMMILLING03', 'spaces and case normalise');

// ── before anything loads, a machine reads as its own code ───────────────────
eq(machineNameOf('CUTTINGMACHINE04'), 'CUTTINGMACHINE04', 'no label yet → the code itself');
eq(machineNameOf('spg02'), 'SPG02', 'and it is upper-cased');
eq(hasCustomName('CUTTINGMACHINE04'), false, 'not renamed yet');
eq(machineTitleOf('SPG02'), 'SPG02', 'tooltip does not repeat an unnamed code');

// ── the server's labels arrive ───────────────────────────────────────────────
const changed = loadMachineLabels([
  { machineRef: 'CUTTINGMACHINE04', displayName: 'PC04' },
  { machineRef: 'CUTTINGMACHINE07', displayName: 'PC07' },
  { machineRef: 'SPG-06', displayName: 'Spinner 6' },
]);
eq(changed, true, 'loading new labels reports a change');
eq(machineNameOf('CUTTINGMACHINE04'), 'PC04', 'renamed machine reads as its label');
eq(machineNameOf('cuttingmachine04'), 'PC04', 'lookup is case-insensitive');
eq(machineNameOf('SPG06'), 'Spinner 6', 'SPG06 finds the label stored as SPG-06');
eq(hasCustomName('CUTTINGMACHINE07'), true, 'flagged as renamed');
eq(machineTitleOf('CUTTINGMACHINE07'), 'PC07 · machine sends "CUTTINGMACHINE07"',
  'the tooltip still tells you the real id');

// ── THE POINT: the label is never an identifier ──────────────────────────────
eq(machineNameOf('PC04'), 'PC04', 'the label does not itself resolve to anything');
eq(hasCustomName('PC04'), false, 'and is not a machine the app knows');
eq(machineNameOf('CUTTINGMACHINE05'), 'CUTTINGMACHINE05', 'an unnamed machine is untouched');

// ── an identical payload must NOT churn every board on the page ──────────────
eq(loadMachineLabels([
  { machineRef: 'CUTTINGMACHINE04', displayName: 'PC04' },
  { machineRef: 'CUTTINGMACHINE07', displayName: 'PC07' },
  { machineRef: 'SPG-06', displayName: 'Spinner 6' },
]), false, 'an unchanged refetch reports no change');

// ── clearing a name falls back to the code, everywhere at once ───────────────
eq(loadMachineLabels([{ machineRef: 'CUTTINGMACHINE07', displayName: 'PC07' }]), true, 'a removal is a change');
eq(machineNameOf('CUTTINGMACHINE04'), 'CUTTINGMACHINE04', 'the cleared machine is back to its code');
eq(machineNameOf('CUTTINGMACHINE07'), 'PC07', 'the one still named keeps its name');

// ── junk never throws ────────────────────────────────────────────────────────
eq(loadMachineLabels([{ machineRef: 'X1', displayName: '   ' }]), true, 'a blank name is dropped');
eq(machineNameOf('X1'), 'X1', 'so the machine keeps its code');
eq(machineNameOf(''), '', 'empty ref stays empty');

console.log('machineName: all checks passed');
