// Self-check for the classification config rules. Run: npx tsx server/src/utils/prodclass.check.ts
import { normalizeProdClass, DEFAULT_PROD_CLASS, BUILTIN_VALUES, valueFromLabel, type ProdClassConfig } from './prodclass.js';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const errOf = (raw: unknown): string => {
  const r = normalizeProdClass(raw);
  if (typeof r !== 'string') throw new Error(`expected an error, got a config: ${JSON.stringify(r)}`);
  return r;
};
const okOf = (raw: unknown): ProdClassConfig => {
  const r = normalizeProdClass(raw);
  if (typeof r === 'string') throw new Error(`expected a config, got error: ${r}`);
  return r;
};
const base = (): Record<string, unknown> => ({
  enabled: true, timeoutSec: 20, defaultValue: 'OK',
  options: DEFAULT_PROD_CLASS.options.map((o) => ({ ...o })),
});

// Nothing stored yet → the defaults, whole and enabled.
eq('null → defaults', okOf(null), DEFAULT_PROD_CLASS);
eq('defaults default to OK', DEFAULT_PROD_CLASS.defaultValue, 'OK');
eq('the four defaults exist', DEFAULT_PROD_CLASS.options.map((o) => o.value), [...BUILTIN_VALUES]);

// Popup duration: never zero, never negative, bounded.
eq('zero duration rejected', errOf({ ...base(), timeoutSec: 0 }), 'popup duration must be 3–600 seconds');
eq('negative rejected', errOf({ ...base(), timeoutSec: -5 }), 'popup duration must be 3–600 seconds');
eq('too long rejected', errOf({ ...base(), timeoutSec: 601 }), 'popup duration must be 3–600 seconds');
eq('fractional seconds round', okOf({ ...base(), timeoutSec: 19.6 }).timeoutSec, 20);

// The option set is the admin's: a new option is welcome, a duplicate is not,
// a malformed value is not, and OK can never be removed.
const scrap = okOf({ ...base(), options: [...(base().options as object[]), { value: 'SCRAP', label: 'Scrap', enabled: true, order: 5 }] });
eq('a custom option is accepted', scrap.options[4], { value: 'SCRAP', label: 'Scrap', enabled: true, order: 5, counts: false });
eq('a custom option never counts unless told to', scrap.options[4].counts, false);
eq('malformed value rejected', errOf({ ...base(), options: [...(base().options as object[]), { value: 'scrap piece', label: 'x', enabled: true, order: 5 }] }),
  'invalid classification value "scrap piece" — letters, digits and _ only');
const dup = base(); (dup.options as { value: string }[])[3].value = 'OK';
eq('duplicate rejected', errOf(dup), 'duplicate classification option "OK"');
const noOk = base(); (noOk.options as unknown[]).shift();
eq('OK cannot be removed', errOf(noOk), 'the OK option cannot be removed');
const noSampleOpt = base(); (noSampleOpt.options as unknown[]).pop();
eq('a default option CAN be removed (usage is checked at save)', okOf(noSampleOpt).options.length, 3);
eq('values mint from labels', valueFromLabel(' Trial piece! '), 'TRIAL_PIECE');
eq('a value never starts with a digit', valueFromLabel('2nd grade'), 'X2ND_GRADE');

// Labels are display-only but still bounded.
const blank = base(); (blank.options as { label: string }[])[1].label = '  ';
eq('blank label rejected', errOf(blank), 'option labels must be 1–40 characters');
const renamed = base(); (renamed.options as { label: string }[])[2].label = ' Reject ';
eq('labels trim, values stay stable', okOf(renamed).options[2], { value: 'DEFECTIVE', label: 'Reject', enabled: true, order: 3, counts: false });

// Order normalizes to unique 1..N — admin numbers are a preference, not a contract.
const shuffled = base();
(shuffled.options as { value: string; order: number }[]).forEach((o) => {
  o.order = o.value === 'DEFECTIVE' ? 1 : o.value === 'OK' ? 2 : 9;   // tie on 9
});
eq('sorted by order, ties by the order given, reindexed',
  okOf(shuffled).options.map((o) => [o.value, o.order]),
  [['DEFECTIVE', 1], ['OK', 2], ['DRY_CYCLE', 3], ['SAMPLE', 4]]);

// The default must exist AND be enabled; something must be enabled at all.
eq('unknown default rejected', errOf({ ...base(), defaultValue: 'GOOD' }), 'default classification is not a known option');
const disabledDefault = base(); (disabledDefault.options as { value: string; enabled: boolean }[])[0].enabled = false;
eq('disabled default rejected', errOf(disabledDefault), 'default classification must be an enabled option');
const allOff = base(); (allOff.options as { enabled: boolean }[]).forEach((o) => { o.enabled = false; });
eq('all-disabled rejected', errOf(allOff), 'enable at least one classification option');

// Disabling an option is allowed — it just leaves the popup, not the system.
const noSample = base(); (noSample.options as { value: string; enabled: boolean }[])[3].enabled = false;
eq('a disabled option survives normalization', okOf(noSample).options[3], { value: 'SAMPLE', label: 'Sample', enabled: false, order: 4, counts: false });

// "Counts" — whether a piece so classified is production. OK cannot be turned
// off; the others default to NOT counting when a stored config predates the
// field (a config saved before "counts" existed must not start counting dry
// cycles as production), and follow the admin when set.
const okOff = base(); (okOff.options as { value: string; counts?: boolean }[])[0].counts = false;
eq('OK always counts', okOf(okOff).options[0].counts, true);
const legacy = base(); (legacy.options as Record<string, unknown>[]).forEach((o) => { delete o.counts; });
eq('legacy config: only OK counts', okOf(legacy).options.map((o) => o.counts), [true, false, false, false]);
const defCounts = base(); (defCounts.options as { value: string; counts?: boolean }[])[2].counts = true;
eq('admin can make defective count', okOf(defCounts).options[2].counts, true);

// Edit reasons: trimmed, de-duplicated case-insensitively, bounded; absent = defaults.
eq('reasons default when absent', okOf({ ...base(), reasons: undefined }).reasons, DEFAULT_PROD_CLASS.reasons);
eq('reasons trim + dedupe', okOf({ ...base(), reasons: [' Wrong button ', 'wrong BUTTON', '', 'Late'] }).reasons, ['Wrong button', 'Late']);
eq('a 61-char reason is refused', errOf({ ...base(), reasons: ['x'.repeat(61)] }), 'an edit reason must be 60 characters or fewer');

console.log('prodclass: all checks passed');
