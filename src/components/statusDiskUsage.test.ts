import { describe, expect, it, vi } from 'vitest';
import { DiskUsageStore, formatDiskAgo, formatDiskSize, type DiskUsageResult } from './statusDiskUsage';

const K = 1024;
const M = K * K;
const G = M * K;
const T = G * K;

describe('formatDiskSize', () => {
  it('uses B/K/M/G/T with one decimal below 10 and none above', () => {
    expect(formatDiskSize(0)).toBe('0B');
    expect(formatDiskSize(512)).toBe('512B');
    expect(formatDiskSize(1023)).toBe('1023B');
    expect(formatDiskSize(K)).toBe('1.0K');
    expect(formatDiskSize(1.5 * K)).toBe('1.5K');
    expect(formatDiskSize(512 * M)).toBe('512M');
    expect(formatDiskSize(2.1 * G)).toBe('2.1G');
    expect(formatDiskSize(9.4 * G)).toBe('9.4G');
    expect(formatDiskSize(12 * G)).toBe('12G');
    expect(formatDiskSize(3.25 * T)).toBe('3.3T');
  });

  it('does not print 10.0 or 1024 of a unit', () => {
    expect(formatDiskSize(9.97 * G)).toBe('10G');
    expect(formatDiskSize(1023.7 * M)).toBe('1.0G');
  });

  it('handles bad input', () => {
    expect(formatDiskSize(-5)).toBe('0B');
    expect(formatDiskSize(Number.NaN)).toBe('0B');
  });
});

describe('formatDiskAgo', () => {
  it('buckets elapsed time', () => {
    expect(formatDiskAgo(5_000)).toEqual({ unit: 'now', n: 0 });
    expect(formatDiskAgo(3 * 60_000 + 10)).toEqual({ unit: 'min', n: 3 });
    expect(formatDiskAgo(2 * 3_600_000 + 10)).toEqual({ unit: 'hour', n: 2 });
  });
});

type Deferred = {
  resolve: (r: DiskUsageResult) => void;
  reject: (e: unknown) => void;
};

function makeStore(now = () => 1000) {
  const pending = new Map<string, Deferred[]>();
  const measure = vi.fn((path: string) => new Promise<DiskUsageResult>((resolve, reject) => {
    const list = pending.get(path) ?? [];
    list.push({ resolve, reject });
    pending.set(path, list);
  }));
  const cancel = vi.fn();
  const store = new DiskUsageStore(measure, cancel, now);
  const settle = async (path: string, r: DiskUsageResult | Error, index = 0) => {
    const d = pending.get(path)![index];
    if (r instanceof Error) d.reject(r); else d.resolve(r);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { store, measure, cancel, settle };
}

const result = (bytes: number, files = 1): DiskUsageResult => ({ bytes, files, cancelled: false, elapsedMs: 10 });

describe('DiskUsageStore', () => {
  it('measures on a cache miss and reuses the value on a hit', async () => {
    const { store, measure, settle } = makeStore();
    store.request('/a');
    expect(store.view('/a')).toMatchObject({ entry: null, measuring: true });
    await settle('/a', result(4096));
    expect(store.view('/a')).toMatchObject({ entry: { bytes: 4096, files: 1, measuredAt: 1000 }, measuring: false });
    store.request('/a');
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('a forced request re-measures and keeps the old value while running', async () => {
    const { store, measure, settle } = makeStore();
    store.request('/a');
    await settle('/a', result(4096));
    store.request('/a', { force: true });
    expect(measure).toHaveBeenCalledTimes(2);
    expect(store.view('/a')).toMatchObject({ entry: { bytes: 4096 }, measuring: true });
    await settle('/a', result(8192), 1);
    expect(store.view('/a')).toMatchObject({ entry: { bytes: 8192 }, measuring: false });
  });

  it('ignores a request (even forced) while that folder is being measured', () => {
    const { store, measure } = makeStore();
    store.request('/a');
    store.request('/a', { force: true });
    store.request('/a');
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('cancelling ignores the late result and lets a new request start', async () => {
    const { store, measure, cancel, settle } = makeStore();
    store.request('/a');
    store.cancel('/a');
    expect(cancel).toHaveBeenCalledWith('/a');
    store.request('/b');
    await settle('/a', result(999_999));
    expect(store.view('/a')).toMatchObject({ entry: null, measuring: false });
    expect(store.view('/b')).toMatchObject({ entry: null, measuring: true });
    store.request('/a');
    expect(measure).toHaveBeenCalledTimes(3);
  });

  it("a result for one folder never shows on another folder", async () => {
    const { store, settle } = makeStore();
    store.request('/a');
    store.request('/b');
    await settle('/a', result(111));
    expect(store.view('/b').entry).toBeNull();
    expect(store.view('/a').entry?.bytes).toBe(111);
  });

  it('a cancelled walk from the backend is not cached', async () => {
    const { store, settle } = makeStore();
    store.request('/a');
    await settle('/a', { bytes: 5, files: 1, cancelled: true, elapsedMs: 1 });
    expect(store.view('/a')).toMatchObject({ entry: null, measuring: false, error: null });
  });

  it('keeps the error for the tooltip and clears it on the next success', async () => {
    const { store, settle } = makeStore();
    store.request('/a');
    await settle('/a', new Error('permission denied'));
    expect(store.view('/a')).toMatchObject({ entry: null, measuring: false, error: 'permission denied' });
    store.request('/a');
    expect(store.view('/a').measuring).toBe(true);
    await settle('/a', result(10), 1);
    expect(store.view('/a')).toMatchObject({ entry: { bytes: 10 }, error: null });
  });

  it('never measures empty or SSH paths', () => {
    const { store, measure } = makeStore();
    store.request('');
    store.request('ssh://host/srv/app');
    expect(measure).not.toHaveBeenCalled();
  });

  it('notifies subscribers on start and finish', async () => {
    const { store, settle } = makeStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.request('/a');
    expect(listener).toHaveBeenCalledTimes(1);
    await settle('/a', result(1));
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    store.request('/a', { force: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
