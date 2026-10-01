// Self-check for the department list rules. Run: npx tsx server/src/utils/departments.check.ts
import { normalizeDepartments, departmentKeyOf, DEFAULT_DEPARTMENTS, MAX_DEPARTMENTS } from './departments.js';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const errOf = (raw: unknown): string => {
  const r = normalizeDepartments(raw);
  if (typeof r !== 'string') throw new Error(`expected an error, got a list: ${JSON.stringify(r)}`);
  return r;
};
const okOf = (raw: unknown) => {
  const r = normalizeDepartments(raw);
  if (typeof r === 'string') throw new Error(`expected a list, got error: ${r}`);
  return r;
};

eq('nothing stored → the four built-ins', okOf(null).map((d) => d.key), ['production', 'quality', 'maintenance', 'safety']);
eq('built-ins keep their colours', okOf(undefined)[0].accent, DEFAULT_DEPARTMENTS[0].accent);
eq('a key is minted from the name', departmentKeyOf('HR & Admin Department'), 'hr_admin');
eq('a submitted name without a key gets one', okOf([{ name: 'Stores' }]), [{ key: 'stores', name: 'Stores', accent: '#7C3AED' }]);
eq('keys fold to lower case, accents to upper', okOf([{ key: 'HR', name: 'HR', accent: '#abcdef' }]), [{ key: 'hr', name: 'HR', accent: '#ABCDEF' }]);
eq('order is the admin\'s', okOf([{ key: 'b', name: 'B' }, { key: 'a', name: 'A' }]).map((d) => d.key), ['b', 'a']);
eq('a bad accent is replaced, not rejected', okOf([{ key: 'x', name: 'X', accent: 'red' }])[0].accent, '#7C3AED');
eq('blank name rejected', errOf([{ key: 'x', name: '  ' }]), 'a department name must be 1–60 characters');
eq('bad key rejected', errOf([{ key: 'plant head', name: 'Plant Head' }]), 'department key "plant head" must be 1–40 characters: letters, digits and _');
eq('duplicate key rejected', errOf([{ key: 'a', name: 'A' }, { key: 'a', name: 'B' }]), 'duplicate department key "a"');
eq('a reserved group key rejected', errOf([{ key: 'other', name: 'Other' }]), '"other" cannot be a department key');
eq('a name that is an Object property rejected', errOf([{ name: 'Constructor' }]), '"constructor" cannot be a department key');
eq('duplicate name rejected (case-insensitive)', errOf([{ key: 'a', name: 'Stores' }, { key: 'b', name: 'stores' }]), 'duplicate department name "stores"');
eq('empty list rejected', errOf([]), 'keep at least one department');
eq('not a list rejected', errOf({}), 'departments must be a list');
eq('too many rejected', errOf(Array.from({ length: MAX_DEPARTMENTS + 1 }, (_, i) => ({ key: `d${i}`, name: `D${i}` }))), `at most ${MAX_DEPARTMENTS} departments`);

console.log('departments: all checks passed');
