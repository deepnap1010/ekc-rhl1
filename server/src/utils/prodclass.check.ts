// Self-check for the classification config rules. Run: npx tsx server/src/utils/prodclass.check.ts
import { normalizeProdClass, DEFAULT_PROD_CLASS, CLASS_VALUES, type ProdClassConfig } from './prodclass.js';

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
eq('all four options exist', DEFAULT_PROD_CLASS.options.map((o) => o.value), [...CLASS_VALUES]);

// Popup duration: never zero, never negative, bounded.
eq('zero duration rejected', errOf({ ...base(), timeoutSec: 0 }), 'popup duration must be 3–600 seconds');
eq('negative rejected', errOf({ ...base(), timeoutSec: -5 }), 'popup duration must be 3–600 seconds');
eq('too long rejected', errOf({ ...base(), timeoutSec: 601 }), 'popup duration must be 3–600 seconds');
eq('fractional seconds round', okOf({ ...base(), timeoutSec: 19.6 }).timeoutSec, 20);

// The value set is closed: unknown, duplicate or missing options are refused.
eq('unknown value rejected', errOf({ ...base(), options: [...(base().options as object[]), { value: 'SCRAP', label: 'Scrap', enabled: true, order: 5 }] }),
  'unknown classification option "SCRAP"');
const dup = base(); (dup.options as { value: string }[])[3].value = 'OK';
eq('duplicate rejected', errOf(dup), 'duplicate classification option "OK"');
const missing = base(); (missing.options as unknown[]).pop();
eq('missing canonical option rejected', errOf(missing), 'missing classification option "SAMPLE"');

// Labels are display-only but still bounded.
const blank = base(); (blank.options as { label: string }[])[1].label = '  ';
eq('blank label rejected', errOf(blank), 'option labels must be 1–40 characters');
const renamed = base(); (renamed.options as { label: string }[])[2].label = ' Reject ';
eq('labels trim, values stay stable', okOf(renamed).options[2], { value: 'DEFECTIVE', label: 'Reject', enabled: true, order: 3 });

// Order normalizes to unique 1..N — admin numbers are a preference, not a contract.
const shuffled = base();
(shuffled.options as { value: string; order: number }[]).forEach((o) => {
  o.order = o.value === 'DEFECTIVE' ? 1 : o.value === 'OK' ? 2 : 9;   // tie on 9
});
eq('sorted by order, ties by canonical position, reindexed',
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
eq('a disabled option survives normalization', okOf(noSample).options[3], { value: 'SAMPLE', label: 'Sample', enabled: false, order: 4 });

console.log('prodclass: all checks passed');
