import { describe, expect, it } from 'vitest';
import { effectiveKeepRunningOnQuit, effectivePtyHolder } from './schema';

describe('effectivePtyHolder (mirrors pty_holder_wanted)', () => {
  it('follows the host default when unset; "on"/"off" override it', () => {
    // defaultOn: true = release build, false = debug build (pty_backend_info.defaultOn).
    expect(effectivePtyHolder(undefined, true)).toBe(true);
    expect(effectivePtyHolder('bogus', true)).toBe(true);
    expect(effectivePtyHolder('off', true)).toBe(false);
    expect(effectivePtyHolder(undefined, false)).toBe(false);
    expect(effectivePtyHolder('bogus', false)).toBe(false);
    expect(effectivePtyHolder('on', false)).toBe(true);
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
