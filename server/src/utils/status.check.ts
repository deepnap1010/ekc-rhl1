// server/src/utils/status.check.ts — run: npx tsx server/src/utils/status.check.ts
import { normalizeStatus, sessionStateAt } from './status.js';

const eq = (a: unknown, b: unknown, m: string): void => {
  if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

// The bug this exists for: CUTTINGMACHINE04 posts "Stop", downtime.service
// tested `=== 'stopped'`, missed, and treated a stopped machine as running.
eq(normalizeStatus('Stop'), 'stopped', '"Stop" is stopped');
eq(normalizeStatus('STOP'), 'stopped', 'case ignored');
eq(normalizeStatus(' Stopped '), 'stopped', 'padding trimmed');
eq(normalizeStatus('stopped'), 'stopped', 'the canonical form survives');
eq(normalizeStatus('Halted'), 'stopped', 'halted is stopped');

eq(normalizeStatus('Run'), 'running', '"Run" is running');
eq(normalizeStatus('Running'), 'running', 'and so is "Running"');
eq(normalizeStatus('Idle'), 'idle', 'idle');
eq(normalizeStatus('stand-by'), 'idle', 'separators ignored');
eq(normalizeStatus('Stand By'), 'idle', 'spaces ignored');
eq(normalizeStatus('Disconnected'), 'offline', 'disconnected is offline');

// An unknown status passes through UNCHANGED rather than being forced into a
// bucket. Guessing wrong is worse than showing the factory's own word.
eq(normalizeStatus('Maintenance'), 'Maintenance', 'unknown status kept verbatim');
eq(normalizeStatus('E-STOP'), 'E-STOP', 'unknown kept even when it looks close');
eq(normalizeStatus(''), '', 'empty stays empty');
eq(normalizeStatus(null), '', 'null is empty, not "null"');
eq(normalizeStatus(undefined), '', 'undefined is empty too');

// The key is collector-supplied. An object-literal lookup would resolve these up
// the prototype chain and return a FUNCTION, which `?? s` does not catch.
eq(normalizeStatus('constructor'), 'constructor', 'prototype keys are not aliases');
eq(normalizeStatus('toString'), 'toString', 'nor is toString');
eq(normalizeStatus('__proto__'), '__proto__', 'nor __proto__');

// ── what the sweep RECORDED at a moment in time ───────────────────────────
// This is the only status source for a machine that reports none of its own —
// CUTTINGMACHINE06 sends three fields and not one is a status — so whatever this
// returns IS that machine's entire history.
const D = (s: string): Date => new Date(s);
const T = (s: string): number => Date.parse(s);
const sessions = [
  { state: 'running', startedAt: D('2026-09-04T09:00:00Z'), endedAt: D('2026-09-04T10:00:00Z') },
  { state: 'idle', startedAt: D('2026-09-04T10:00:00Z'), endedAt: D('2026-09-04T10:30:00Z') },
  { state: 'stopped', startedAt: D('2026-09-04T12:00:00Z'), endedAt: null },
];

eq(sessionStateAt(sessions, T('2026-09-04T09:30:00Z')), 'running',
   'running is a recorded state, not the absence of a downtime span');
eq(sessionStateAt(sessions, T('2026-09-04T10:15:00Z')), 'idle', 'inside a session, that session wins');
eq(sessionStateAt(sessions, T('2026-09-04T13:00:00Z')), 'stopped', 'an open session runs forward');
// A gap between sessions is a gap in the RECORD — the sweep was not running.
// Calling it 'running' is what the downtime-span version could not avoid, and it
// is how a deploy or a lease handover would have been painted as production.
eq(sessionStateAt(sessions, T('2026-09-04T11:00:00Z')), null, 'a gap in the log is not a state');
eq(sessionStateAt([], T('2026-09-04T11:00:00Z')), null, 'no log at all, no opinion');
eq(sessionStateAt(sessions, T('2026-08-20T11:00:00Z')), null, 'before the log begins, no opinion');
// Sessions abut, so the boundary instant belongs to both. First match wins and
// the list is sorted by startedAt, so it reads as the state that was ENDING.
eq(sessionStateAt(sessions, T('2026-09-04T10:00:00Z')), 'running', 'a boundary reads as the closing session');

console.log('status: all checks passed');
