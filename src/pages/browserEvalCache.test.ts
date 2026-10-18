import { describe, expect, it } from 'vitest';
import {
  cachedEval,
  createEvalCache,
  getCached,
  invalidateCache,
  setCached,
} from './browserEvalCache';

describe('eval cache', () => {
  // 정상: set then get within TTL returns the value.
  it('returns a fresh cached value', () => {
    const c = createEvalCache(1000);
    setCached(c, 'snapshot', 'DATA', 100);
    expect(getCached(c, 'snapshot', 500)).toBe('DATA');
    expect(c.hits).toBe(1);
  });

  // 매핑: past the TTL, the entry expires (miss) and is evicted.
  it('expires entries past the TTL', () => {
    const c = createEvalCache(800);
    setCached(c, 'k', 'V', 0);
    expect(getCached(c, 'k', 900)).toBeNull();   // 900 > 800
    expect(getCached(c, 'k', 1000)).toBeNull();  // already evicted
    expect(c.misses).toBe(2);
  });

  // 매핑: invalidate clears everything (post page-change).
  it('invalidates the whole cache', () => {
    const c = createEvalCache();
    setCached(c, 'a', '1', 0);
    setCached(c, 'b', '2', 0);
    invalidateCache(c);
    expect(getCached(c, 'a', 1)).toBeNull();
    expect(getCached(c, 'b', 1)).toBeNull();
  });

  // None/변조: empty key / null cache safe.
  it('tolerates empty keys and missing cache', () => {
    const c = createEvalCache();
    expect(getCached(c, '', 0)).toBeNull();
    setCached(c, '', 'x', 0);
    expect(c.store.size).toBe(0);
    expect(getCached(null as unknown as ReturnType<typeof createEvalCache>, 'k', 0)).toBeNull();
  });
});

describe('cachedEval', () => {
  it('produces once then serves from cache within TTL', async () => {
    const c = createEvalCache(1000);
    let calls = 0;
    const produce = async () => { calls++; return `result-${calls}`; };
    expect(await cachedEval(c, 'dom', 0, produce)).toBe('result-1');
    expect(await cachedEval(c, 'dom', 500, produce)).toBe('result-1'); // cached
    expect(calls).toBe(1);
    // After TTL, produces again.
    expect(await cachedEval(c, 'dom', 2000, produce)).toBe('result-2');
    expect(calls).toBe(2);
  });

  it('re-produces after invalidation', async () => {
    const c = createEvalCache(10000);
    let calls = 0;
    const produce = async () => { calls++; return String(calls); };
    await cachedEval(c, 'x', 0, produce);
    invalidateCache(c);
    await cachedEval(c, 'x', 1, produce);
    expect(calls).toBe(2);
  });
});
