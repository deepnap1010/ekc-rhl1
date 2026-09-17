// Self-check for the downtime-popup rules. Run: npx tsx server/src/utils/downtimeAsk.check.ts
import {
  normalizeDowntimeAsk, DEFAULT_DOWNTIME_ASK, reasonsFor, askedTypes, shiftSwitchExpr, shiftNameAt,
  type DowntimeAskConfig,
} from './downtimeAsk.js';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const errOf = (raw: unknown): string => {
  const r = normalizeDowntimeAsk(raw);
  if (typeof r !== 'string') throw new Error(`expected an error, got a config: ${JSON.stringify(r)}`);
  return r;
};
const okOf = (raw: unknown): DowntimeAskConfig => {
  const r = normalizeDowntimeAsk(raw);
  if (typeof r === 'string') throw new Error(`expected a config, got error: ${r}`);
  return r;
};
const base = (): Record<string, unknown> => ({
  enabled: true, askAfterMin: 10, timeoutSec: 0, askIdle: true, askStopped: true, allowCustom: true,
  reasons: DEFAULT_DOWNTIME_ASK.reasons.map((r) => ({ ...r })),
});

// Nothing stored yet → the defaults, whole.
eq('null → defaults', okOf(null), DEFAULT_DOWNTIME_ASK);
eq('defaults ask after 10 minutes', DEFAULT_DOWNTIME_ASK.askAfterMin, 10);
eq('defaults wait for the answer', DEFAULT_DOWNTIME_ASK.timeoutSec, 0);

// Ask-after is bounded; the popup duration allows 0 (wait) but no tiny countdown.
eq('ask after 0 rejected', errOf({ ...base(), askAfterMin: 0 }), 'ask after must be 1–240 minutes');
eq('ask after rounds', okOf({ ...base(), askAfterMin: 9.6 }).askAfterMin, 10);
eq('duration 0 = wait', okOf({ ...base(), timeoutSec: 0 }).timeoutSec, 0);
eq('duration 5 rejected', errOf({ ...base(), timeoutSec: 5 }), 'popup duration must be 0 (wait for the answer) or 10–3600 seconds');
eq('duration 120 ok', okOf({ ...base(), timeoutSec: 120 }).timeoutSec, 120);
eq('duration too long rejected', errOf({ ...base(), timeoutSec: 3601 }), 'popup duration must be 0 (wait for the answer) or 10–3600 seconds');

// Something must be asked about while the popup is on.
eq('nothing to ask rejected', errOf({ ...base(), askIdle: false, askStopped: false }), 'choose at least one state to ask about, or turn the popup off');
eq('…but fine when off', okOf({ ...base(), enabled: false, askIdle: false, askStopped: false }).enabled, false);
eq('asked types follow the switches', askedTypes(okOf({ ...base(), askIdle: false })), ['stopped']);

// Reasons: trimmed, de-duplicated, typed; bare strings accepted; bounded.
const custom = okOf({ ...base(), reasons: [' Crane wait ', 'crane WAIT', { label: 'Breakdown', types: ['stopped'] }] });
eq('bare strings apply to both, duplicates fold, blanks trimmed', custom.reasons.slice(0, 2),
  [{ label: 'Crane wait', types: ['idle', 'stopped'] }, { label: 'Breakdown', types: ['stopped'] }]);
eq('empty types → error', errOf({ ...base(), reasons: [{ label: 'Any', types: [] }] }), '"Any" must apply to idle, stopped or both');
eq('unknown types drop', okOf({ ...base(), reasons: [{ label: 'X', types: ['stopped', 'offline'] }] }).reasons[0].types, ['stopped']);
eq('too long rejected', errOf({ ...base(), reasons: ['x'.repeat(61)] }), 'a reason must be 1–60 characters');
eq('too many rejected', errOf({ ...base(), reasons: Array.from({ length: 31 }, (_, i) => `r${i}`) }), 'at most 30 reasons');
eq('no reasons and no free text = nothing to answer with', errOf({ ...base(), reasons: [], allowCustom: false }), 'add at least one reason, or allow operators to type their own');
eq('no reasons but free text is fine', okOf({ ...base(), reasons: [] }).reasons, []);
eq('reasons per type', reasonsFor(DEFAULT_DOWNTIME_ASK, 'stopped'),
  ['Setup / changeover', 'Tool change', 'Quality hold', 'Breakdown', 'Power failure', 'Planned maintenance']);
eq('offline gets no buttons', reasonsFor(DEFAULT_DOWNTIME_ASK, 'offline'), []);

// Shift bucketing — the plant's real rotation, with the overnight shift wrapping.
const shifts = [
  { name: 'Shift A', start: '07:00', end: '15:00' },
  { name: 'Shift B', start: '15:00', end: '23:00' },
  { name: 'Shift C', start: '23:00', end: '07:00' },
];
eq('07:00 is A', shiftNameAt(shifts, 7 * 60), 'Shift A');
eq('14:59 is A', shiftNameAt(shifts, 14 * 60 + 59), 'Shift A');
eq('15:00 is B', shiftNameAt(shifts, 15 * 60), 'Shift B');
eq('23:30 is C (wraps)', shiftNameAt(shifts, 23 * 60 + 30), 'Shift C');
eq('02:00 is C (wraps)', shiftNameAt(shifts, 2 * 60), 'Shift C');
eq('a gap is off-shift', shiftNameAt([shifts[0]], 20 * 60), 'Off-shift');
eq('no shifts = all day', shiftNameAt([], 20 * 60), 'All day');
const sw = shiftSwitchExpr(shifts, '$m') as { $switch: { branches: { case: unknown; then: string }[]; default: string } };
eq('one branch per shift', sw.$switch.branches.map((b) => b.then), ['Shift A', 'Shift B', 'Shift C']);
eq('a day shift is an AND', sw.$switch.branches[0].case, { $and: [{ $gte: ['$m', 420] }, { $lt: ['$m', 900] }] });
eq('the overnight shift is an OR', sw.$switch.branches[2].case, { $or: [{ $gte: ['$m', 1380] }, { $lt: ['$m', 420] }] });
eq('no shifts = a constant', shiftSwitchExpr([], '$m'), 'All day');

console.log('downtimeAsk: all checks passed');
