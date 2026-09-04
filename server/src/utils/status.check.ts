// server/src/utils/status.check.ts — run: npx tsx server/src/utils/status.check.ts
import { normalizeStatus } from './status.js';

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

console.log('status: all checks passed');
