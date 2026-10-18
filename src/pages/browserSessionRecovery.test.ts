import { describe, expect, it } from 'vitest';
import {
  MAX_AGE_MS,
  MAX_RECENT,
  captureSession,
  restoreSession,
  serializeSession,
  sessionAgeLabel,
  type SessionSnapshot,
} from './browserSessionRecovery';

const T0 = 1_700_000_000_000;

describe('captureSession', () => {
  // 정상: first capture builds a snapshot with the url in recent.
  it('captures a fresh snapshot', () => {
    const s = captureSession(null, { url: 'https://a.test/x', title: 'A', scrollY: 120 }, T0);
    expect(s).toMatchObject({ url: 'https://a.test/x', title: 'A', scrollY: 120, savedAt: T0 });
    expect(s?.recent).toEqual(['https://a.test/x']);
  });

  // 매핑: repeat visit dedupes and moves the url to the end of recent.
  it('maintains a bounded, de-duplicated recent trail', () => {
    let s = captureSession(null, { url: 'https://a.test' }, T0);
    s = captureSession(s, { url: 'https://b.test' }, T0 + 1);
    s = captureSession(s, { url: 'https://a.test' }, T0 + 2); // revisit a
    expect(s?.recent).toEqual(['https://b.test', 'https://a.test']);
    // Overflow trims oldest.
    for (let i = 0; i < MAX_RECENT + 5; i++) s = captureSession(s, { url: `https://s${i}.test` }, T0 + 10 + i);
    expect(s!.recent.length).toBe(MAX_RECENT);
  });

  // 변조: non-http visits keep the previous snapshot unchanged.
  it('ignores non-restorable URLs', () => {
    const prev = captureSession(null, { url: 'https://a.test' }, T0);
    expect(captureSession(prev, { url: 'javascript:alert(1)' }, T0 + 1)).toBe(prev);
    expect(captureSession(null, { url: 'about:blank' }, T0)).toBeNull();
  });
});

describe('restoreSession', () => {
  const fresh: SessionSnapshot = { url: 'https://a.test/x', title: 'A', scrollY: 50, savedAt: T0, recent: ['https://a.test/x'] };

  // 정상: a fresh, valid snapshot round-trips.
  it('restores a fresh valid snapshot', () => {
    expect(restoreSession(serializeSession(fresh), T0 + 1000)).toMatchObject({ url: 'https://a.test/x', scrollY: 50 });
  });

  // 매핑: stale snapshots are rejected.
  it('rejects snapshots older than the max age', () => {
    expect(restoreSession(serializeSession(fresh), T0 + MAX_AGE_MS + 1)).toBeNull();
    expect(restoreSession(serializeSession(fresh), T0 + MAX_AGE_MS - 1)).not.toBeNull();
  });

  // None/변조: malformed, empty, or bad-url snapshots return null, never throw.
  it('rejects malformed or unsafe snapshots', () => {
    expect(restoreSession('not json', T0)).toBeNull();
    expect(restoreSession(null, T0)).toBeNull();
    expect(restoreSession('{}', T0)).toBeNull();
    expect(restoreSession(JSON.stringify({ url: 'ftp://x', savedAt: T0 }), T0)).toBeNull();
    expect(restoreSession(JSON.stringify({ url: 'https://a.test' }), T0)).toBeNull(); // no savedAt
  });

  it('sanitizes recent list to restorable URLs only', () => {
    const s = restoreSession(JSON.stringify({ url: 'https://a.test', savedAt: T0, recent: ['https://b.test', 'javascript:x', 42] }), T0 + 1);
    expect(s?.recent).toEqual(['https://b.test']);
  });
});

describe('sessionAgeLabel', () => {
  it('formats age buckets', () => {
    const s = (savedAt: number): SessionSnapshot => ({ url: 'https://a.test', title: '', scrollY: 0, savedAt, recent: [] });
    expect(sessionAgeLabel(s(T0), T0)).toBe('just now');
    expect(sessionAgeLabel(s(T0), T0 + 5 * 60_000)).toBe('5m ago');
    expect(sessionAgeLabel(s(T0), T0 + 3 * 3_600_000)).toBe('3h ago');
    expect(sessionAgeLabel(s(T0), T0 + 2 * 86_400_000)).toBe('2d ago');
  });
});
