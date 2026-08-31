// client/src/lib/machineName.check.ts — npx tsx src/lib/machineName.check.ts
// The rule this file defends: a rename changes the LABEL and never the identity.
import { machineNameOf, machineTitleOf, hasCustomName, normRef } from './machineName.js';
import { saveConfig, getConfig, readAll } from './machineConfig.js';

// localStorage stand-in, so the check runs under plain node.
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
} as Storage;

const eq = (a: unknown, b: unknown, m: string): void => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

// ── punctuation and case never split one machine in two ──────────────────────
eq(normRef('SPG-06'), normRef('SPG06'), 'hyphen variant matches');
eq(normRef('bottom milling 03'), 'BOTTOMMILLING03', 'spaces and case normalise');

// ── an unnamed machine reads as its own code ─────────────────────────────────
eq(machineNameOf('CUTTINGMACHINE04'), 'CUTTINGMACHINE04', 'no rename → the code itself');
eq(machineNameOf('spg02'), 'SPG02', 'and it is upper-cased');
eq(hasCustomName('CUTTINGMACHINE04'), false, 'not renamed yet');
eq(machineTitleOf('SPG02'), 'SPG02', 'tooltip does not repeat an unnamed code');

// ── after a rename ───────────────────────────────────────────────────────────
saveConfig('CUTTINGMACHINE04', { displayName: 'PC04' });
eq(machineNameOf('CUTTINGMACHINE04'), 'PC04', 'renamed machine reads as its label');
eq(machineNameOf('cuttingmachine04'), 'PC04', 'lookup is case-insensitive');
eq(hasCustomName('CUTTINGMACHINE04'), true, 'flagged as renamed');
eq(machineTitleOf('CUTTINGMACHINE04'), 'PC04 · machine sends "CUTTINGMACHINE04"',
  'the tooltip still tells you the real id');

// ── THE POINT: the stored identity is untouched ──────────────────────────────
eq(Object.keys(readAll()), ['CUTTINGMACHINE04'], 'stored under the REAL code, not the label');
eq(machineNameOf('PC04'), 'PC04', 'the label is not itself an identifier that resolves');
eq(getConfig('PC04'), {}, 'nothing is ever stored under the label');

// ── a punctuation-different ref still finds the label ────────────────────────
saveConfig('SPG-06', { displayName: 'Spinner 6' });
eq(machineNameOf('SPG06'), 'Spinner 6', 'SPG06 finds the label stored as SPG-06');

// ── clearing the name falls back to the code ─────────────────────────────────
saveConfig('CUTTINGMACHINE04', { displayName: '' });
eq(machineNameOf('CUTTINGMACHINE04'), 'CUTTINGMACHINE04', 'cleared name → back to the code');
eq(hasCustomName('CUTTINGMACHINE04'), false, 'and no longer counts as renamed');

// ── blanks and junk never throw ──────────────────────────────────────────────
eq(machineNameOf(''), '', 'empty ref stays empty');
eq(machineNameOf('   '), '   '.toUpperCase(), 'whitespace ref is left alone');

console.log('machineName: all checks passed');
