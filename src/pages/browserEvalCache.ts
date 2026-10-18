// Short-TTL cache for read-only page observations (performance / caching strategy).
//
// The agent loop re-reads the page (snapshot/dom/text/…) frequently; two read-only
// tools in the same reasoning step often re-eval identical content over the CDP link.
// This memoizes read-only eval results for a brief window, keyed by the eval source,
// and INVALIDATES on any page-changing action so stale content is never served.
//
// D1: Cache ONLY read-only reads, TTL is short (sub-second by default), and ANY
//     state-changing tool clears the whole cache. Reason: correctness first — a cached
//     read must never outlive a page mutation. Cost: at most one stale-within-TTL read
//     right after an untracked external change; acceptable for a sub-second window.
//     Escape hatch: it is a plain object the caller can bypass or clear at will.

export interface EvalCacheEntry { value: string; at: number }
export interface EvalCache {
  store: Map<string, EvalCacheEntry>;
  ttlMs: number;
  hits: number;
  misses: number;
}

export const DEFAULT_EVAL_TTL_MS = 800;

export function createEvalCache(ttlMs = DEFAULT_EVAL_TTL_MS): EvalCache {
  return { store: new Map(), ttlMs: Math.max(0, ttlMs), hits: 0, misses: 0 };
}

// Return the cached value for `key` if present and fresh (now - at <= ttl), else null.
export function getCached(cache: EvalCache, key: string, now: number): string | null {
  if (!cache || !key) return null;
  const entry = cache.store.get(key);
  if (!entry) { cache.misses++; return null; }
  if (now - entry.at > cache.ttlMs) { cache.store.delete(key); cache.misses++; return null; }
  cache.hits++;
  return entry.value;
}

export function setCached(cache: EvalCache, key: string, value: string, now: number): void {
  if (!cache || !key) return;
  cache.store.set(key, { value, at: now });
}

// Clear everything — call after any page-changing action so no stale read survives.
export function invalidateCache(cache: EvalCache): void {
  if (cache) cache.store.clear();
}

// Memoize an async producer: return the fresh cached value or run + store it.
export async function cachedEval(
  cache: EvalCache,
  key: string,
  now: number,
  produce: () => Promise<string>,
): Promise<string> {
  const hit = getCached(cache, key, now);
  if (hit !== null) return hit;
  const value = await produce();
  setCached(cache, key, value, now);
  return value;
}
