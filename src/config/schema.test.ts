import { describe, expect, it } from 'vitest';
import { effectiveKeepRunningOnQuit, effectivePtyHolder } from './schema';

describe('effectivePtyHolder (mirrors pty_holder_wanted)', () => {
  it('is on by default in release builds; dev builds need an explicit "on"', () => {
    expect(effectivePtyHolder(undefined, false)).toBe(true);
    expect(effectivePtyHolder('off', false)).toBe(false);
    expect(effectivePtyHolder(undefined, true)).toBe(false);
    expect(effectivePtyHolder('on', true)).toBe(true);
  });

  it('is always off on Windows', () => {
    for (const value of [undefined, 'on', 'off'] as const) {
      expect(effectivePtyHolder(value, false, true)).toBe(false);
      expect(effectivePtyHolder(value, true, true)).toBe(false);
    }
  });
});

describe('effectiveKeepRunningOnQuit', () => {
  it('defaults true in release builds; dev builds need an explicit true', () => {
    expect(effectiveKeepRunningOnQuit(undefined, false)).toBe(true);
    expect(effectiveKeepRunningOnQuit(false, false)).toBe(false);
    expect(effectiveKeepRunningOnQuit(undefined, true)).toBe(false);
    expect(effectiveKeepRunningOnQuit(true, true)).toBe(true);
  });
});
