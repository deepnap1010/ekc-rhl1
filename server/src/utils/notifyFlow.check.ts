// Self-check for the notification workflow rules. Run: npx tsx server/src/utils/notifyFlow.check.ts
import { normalizeNotifyFlow, notifyModeFor, isOperatorRole, popupMachines, NOTIFY_EVENTS, MAX_RULES, type NotifyFlowConfig } from './notifyFlow.js';

const eq = (what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const errOf = (raw: unknown): string => {
  const r = normalizeNotifyFlow(raw);
  if (typeof r !== 'string') throw new Error(`expected an error, got a config: ${JSON.stringify(r)}`);
  return r;
};
const okOf = (raw: unknown): NotifyFlowConfig => {
  const r = normalizeNotifyFlow(raw);
  if (typeof r === 'string') throw new Error(`expected a config, got error: ${r}`);
  return r;
};

// Nothing stored → no rules; the defaults decide everything.
eq('null → no rules', okOf(null), { rules: {} });
eq('empty object → no rules', okOf({}), { rules: {} });
eq('three events are registered', NOTIFY_EVENTS.map((e) => e.key), ['productionClass', 'downtimeReason', 'diaInstruction']);

// Rules: known events, bounded role keys (case folded), known modes.
eq('role keys fold to lower case', okOf({ rules: { productionClass: { ' Plant_Head ': 'notify' } } }), { rules: { productionClass: { plant_head: 'notify' } } });
eq('an event with no rules is dropped', okOf({ rules: { productionClass: {} } }), { rules: {} });
eq('an unregistered event is dropped, the rest kept', okOf({ rules: { signalLost: { operator: 'popup' }, downtimeReason: { operator: 'off' } } }), { rules: { downtimeReason: { operator: 'off' } } });
eq('unknown mode rejected', errOf({ rules: { downtimeReason: { operator: 'email' } } }), '"email" is not a notification mode (popup, notify or off)');
eq('blank role key rejected', errOf({ rules: { downtimeReason: { '  ': 'off' } } }), 'a role key must be 1–64 characters, without . or $');
eq('a dotted role key rejected (it would be a field path)', errOf({ rules: { downtimeReason: { 'plant.head': 'off' } } }), 'a role key must be 1–64 characters, without . or $');
eq('rules must be an object', errOf({ rules: [] }), 'notification rules must be an object of event → role → mode');
eq('too many rules rejected', errOf({ rules: { productionClass: Object.fromEntries(Array.from({ length: MAX_RULES + 1 }, (_, i) => [`r${i}`, 'off'])) } }), `at most ${MAX_RULES} notification rules`);

// Resolution: explicit rule → operator-named default → off.
const cfg = okOf({ rules: { productionClass: { plant_head: 'notify', operator: 'off' }, downtimeReason: { supervisor: 'popup' } } });
eq('explicit rule wins', notifyModeFor(cfg, 'productionClass', { key: 'Plant_Head', name: 'Plant Head' }), 'notify');
eq('explicit off beats the operator default', notifyModeFor(cfg, 'productionClass', { key: 'operator', name: 'Operator' }), 'off');
eq('rules are per event', notifyModeFor(cfg, 'downtimeReason', { key: 'operator', name: 'Operator' }), 'popup');
eq('a role named operator is asked by default', notifyModeFor(cfg, 'productionClass', { key: 'production_operator', name: 'Production Operator' }), 'popup');
eq('the name alone is enough', notifyModeFor(cfg, 'downtimeReason', { key: 'floor1', name: 'Machine Operator' }), 'popup');
eq('every other role is silent by default', notifyModeFor(cfg, 'productionClass', { key: 'supervisor', name: 'Supervisor' }), 'off');
eq('a role keyed like an Object property finds no rule', notifyModeFor(cfg, 'productionClass', { key: 'constructor', name: 'Constructor' }), 'off');
eq('an explicit popup for a non-operator role', notifyModeFor(cfg, 'downtimeReason', { key: 'supervisor', name: 'Supervisor' }), 'popup');
eq('no role, no machines → nothing', notifyModeFor(cfg, 'productionClass', null), 'off');
eq('no role but machines assigned → asked for them, as before the workflow', notifyModeFor(cfg, 'productionClass', null, true), 'popup');
eq('an empty role is a role without a name: silent', notifyModeFor(cfg, 'productionClass', {}), 'off');

// The terminal and its machines.
eq('operator-named roles are terminals', [isOperatorRole({ key: 'operator' }), isOperatorRole({ key: 'x', name: 'Machine Operator' }), isOperatorRole({ key: 'plant_head', name: 'Plant Head' }), isOperatorRole(null)], [true, true, false, false]);
eq("the plant's own abbreviation counts", [isOperatorRole({ key: 'cnc_opr' }), isOperatorRole({ key: 'x', name: 'SPG Opr' }), isOperatorRole({ key: 'coprocessor' })], [true, true, false]);
eq('a popup covers the assigned machines exactly', popupMachines({ _id: 'u', assignedMachines: ['SPG05', '', 'PC07'] }), ['SPG05', 'PC07']);
eq('no machines assigned = no popup machines, never the fleet', popupMachines({ _id: 'u', isSuperAdmin: true }), []);

console.log('notifyFlow: all checks passed');
