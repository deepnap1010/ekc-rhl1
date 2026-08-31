// server/src/config/migrations.ts
// Small, idempotent repairs run once at startup, before anything serves.
//
// They exist for state the app cannot simply declare: a collection that outlived
// an earlier shape of itself. Mongoose creates the indexes a schema asks for, but
// it never removes the ones a previous schema left behind, and a stale UNIQUE
// index is not inert — it rejects writes.
import mongoose from 'mongoose';

/** Indexes machine_labels is supposed to have. Anything else on that collection
 *  is from a shape it no longer has. */
const LABEL_INDEXES = new Set(['_id_', 'machineRef_1']);

/**
 * machine_labels once had a unique index on `machineId`. Documents written by
 * the current model have no such field, so every one of them stores null there
 * — the first label saved, and the second collided with the first on null and
 * came back as "Duplicate entry". One machine could be renamed and no more.
 *
 * The collection belongs entirely to this app, so an index it does not declare
 * has no business enforcing anything.
 */
async function repairMachineLabelIndexes(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const exists = await db.listCollections({ name: 'machine_labels' }, { nameOnly: true }).toArray();
  if (!exists.length) return;
  const col = db.collection('machine_labels');
  for (const idx of await col.indexes()) {
    const name = String(idx.name);
    if (LABEL_INDEXES.has(name)) continue;
    await col.dropIndex(name);
    console.log(`[migrate] dropped stale index machine_labels.${name} (${JSON.stringify(idx.key)})`);
  }
}

/** Never fatal: a repair that cannot run must not stop the plant monitor. */
export async function runStartupMigrations(): Promise<void> {
  try {
    await repairMachineLabelIndexes();
  } catch (e) {
    console.error('[migrate] failed (continuing):', e instanceof Error ? e.message : e);
  }
}
