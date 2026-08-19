// server/src/utils/cache.ts
// Tiny in-process TTL cache for expensive read-only aggregations. Every client
// polling the same endpoint shares ONE computation within the TTL instead of each
// hammering Atlas on every poll. Concurrent misses share a single in-flight promise;
// failures are NOT cached (the entry is dropped so the next call retries).
// ponytail: in-process only — correct for one Node process; swap in Redis if the
// app is ever scaled to multiple instances.
type Entry = { at: number; p: Promise<unknown> };
const store = new Map<string, Entry>();

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
  const p = fn().catch((e) => { store.delete(key); throw e; });
  store.set(key, { at: Date.now(), p });
  return p as Promise<T>;
}
