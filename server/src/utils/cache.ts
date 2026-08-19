// server/src/utils/cache.ts
// Tiny in-process TTL cache for expensive read-only aggregations. Every client
// polling the same endpoint shares ONE computation within the TTL instead of each
// hammering Atlas on every poll. Concurrent misses share a single in-flight promise;
// failures are NOT cached (the entry is dropped so the next call retries).
// ponytail: in-process only — correct for one Node process; swap in Redis if the
// app is ever scaled to multiple instances.
type Entry = { at: number; p: Promise<unknown> };
const store = new Map<string, Entry>();

// Keep the map bounded: distinct filter combinations create distinct keys, so
// without pruning the store would grow for the process lifetime.
const MAX_ENTRIES = 300;
const MAX_AGE_MS = 10 * 60_000;

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
  if (store.size >= MAX_ENTRIES) {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [k, v] of store) if (v.at < cutoff) store.delete(k);
    if (store.size >= MAX_ENTRIES) {
      // Still full of fresh entries — drop the oldest (Map preserves insertion order).
      for (const k of store.keys()) { store.delete(k); if (store.size < MAX_ENTRIES) break; }
    }
  }
  const p = fn().catch((e) => { store.delete(key); throw e; });
  store.set(key, { at: Date.now(), p });
  return p as Promise<T>;
}
