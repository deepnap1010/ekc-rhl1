#!/usr/bin/env node
// server/scripts/create-machine-logins.ts
//
// One login per machine. SPG02's terminal signs in as spg02operator@ekc.local,
// sees SPG02 and nothing else, and is never signed out again.
//
//     cd ~/ekc/server && npx tsx scripts/create-machine-logins.ts
//
// Safe to run again: an account that already exists keeps its password and is
// only re-pointed at its machine. New machines get accounts; nothing is deleted.
// Pass --reset-passwords to issue fresh passwords for every terminal.
//
// Credentials land in ~/ekc-machine-logins.csv (chmod 600) — never printed, so
// they cannot end up in a terminal's scrollback or a chat message.
import 'dotenv/config';
import { writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { Role } from '../src/models/Role.js';
import { Machine } from '../src/models/Machine.js';

const RESET = process.argv.includes('--reset-passwords');
const OUT = join(homedir(), 'ekc-machine-logins.csv');
const DOMAIN = 'ekc.local';

/** spg02operator@ekc.local — typed on a shop-floor keyboard, so no punctuation. */
const loginFor = (code: string): string =>
  `${code.toLowerCase().replace(/[^a-z0-9]/g, '')}operator@${DOMAIN}`;

/** Readable but not guessable: the code, then six random characters. */
const passwordFor = (code: string): string =>
  `${code.replace(/[^A-Za-z0-9]/g, '')}-${randomBytes(4).toString('base64url').slice(0, 6)}`;

async function main(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URI!, { dbName: process.env.DB_NAME || 'test' });

  const role = await Role.findOne({ key: 'operator' }).lean();
  if (!role) throw new Error('No role with key "operator" — create it under Roles & Permissions first');

  const machines = await Machine.find().select({ code: 1, machineId: 1 }).sort({ code: 1 }).lean();
  if (!machines.length) throw new Error('No machines registered');

  const rows: string[] = ['machine,login,password,status'];
  let made = 0, kept = 0, reset = 0;

  for (const m of machines) {
    const code = String(m.code || m.machineId || '').trim();
    if (!code) continue;
    const email = loginFor(code);
    const existing = await User.findOne({ email });

    if (existing && !RESET) {
      // Re-point it at its machine in case the fleet changed, but leave the
      // password alone — terminals are already signed in with it.
      existing.assignedMachines = [code];
      existing.kiosk = true;
      existing.active = true;
      existing.role = role._id;
      await existing.save();
      rows.push(`${code},${email},(unchanged),existing`);
      kept += 1;
      continue;
    }

    const password = passwordFor(code);
    if (existing) {
      existing.assignedMachines = [code];
      existing.kiosk = true;
      existing.active = true;
      existing.role = role._id;
      await existing.setPassword(password);
      await existing.save();
      rows.push(`${code},${email},${password},password reset`);
      reset += 1;
    } else {
      const u = new User({
        name: `${code} Operator`,
        email,
        role: role._id,
        assignedMachines: [code],
        kiosk: true,
        active: true,
        isSuperAdmin: false,
      });
      await u.setPassword(password);
      await u.save();
      rows.push(`${code},${email},${password},created`);
      made += 1;
    }
  }

  writeFileSync(OUT, rows.join('\n') + '\n', { mode: 0o600 });
  chmodSync(OUT, 0o600);

  console.log(`machines:        ${machines.length}`);
  console.log(`created:         ${made}`);
  console.log(`already existed: ${kept}${kept && !RESET ? '  (run with --reset-passwords to reissue)' : ''}`);
  if (reset) console.log(`passwords reset: ${reset}`);
  console.log(`\ncredentials written to ${OUT} (chmod 600, not printed here)`);
  console.log(`read them with:  cat ${OUT}`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
