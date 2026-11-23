import { describe, expect, it } from 'vitest';
import { DEFAULT_PET_CONFIG, DEFAULT_TERMINAL_CONFIG, effectiveKeepRunningOnQuit, effectivePtyHolder, normalizePetConfig, validateConfig } from './schema';

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

describe('pet config', () => {
  it('defaults on / octo / walk and survives validateConfig (unknown keys are dropped)', () => {
    expect(validateConfig({}).pet).toEqual(DEFAULT_PET_CONFIG);
    expect(validateConfig({ pet: { enabled: false, character: 'clawd', mode: 'stay' } }).pet)
      .toEqual({ enabled: false, character: 'clawd', mode: 'stay', weather: { enabled: false, city: null } });
  });

  it('only an explicit false disables, like pet.rs pet_enabled', () => {
    expect(normalizePetConfig({ enabled: 'no' }).enabled).toBe(true);
    expect(normalizePetConfig({ enabled: 0 }).enabled).toBe(true);
    expect(normalizePetConfig({ enabled: false }).enabled).toBe(false);
  });

  it('falls back on bad character / mode values', () => {
    expect(normalizePetConfig({ character: '  ', mode: 'run' })).toEqual(DEFAULT_PET_CONFIG);
    expect(normalizePetConfig([1, 2])).toEqual(DEFAULT_PET_CONFIG);
    expect(normalizePetConfig(null)).toEqual(DEFAULT_PET_CONFIG);
  });

  it('weather defaults off with no city and keeps a valid city', () => {
    expect(DEFAULT_PET_CONFIG.weather).toEqual({ enabled: false, city: null });
    const city = { name: '서울특별시', admin1: '서울특별시', country: '대한민국', lat: 37.566, lon: 126.9784 };
    expect(validateConfig({ pet: { weather: { enabled: true, city } } }).pet.weather).toEqual({ enabled: true, city });
    expect(normalizePetConfig({ weather: { enabled: true, city: { name: 'Paris', lat: 48.85, lon: 2.35, extra: 1 } } }).weather)
      .toEqual({ enabled: true, city: { name: 'Paris', lat: 48.85, lon: 2.35 } });
  });

  it('weather: only an explicit true turns it on; bad cities are dropped', () => {
    expect(normalizePetConfig({ weather: { enabled: 'yes' } }).weather.enabled).toBe(false);
    expect(normalizePetConfig({ weather: [true] }).weather).toEqual({ enabled: false, city: null });
    for (const city of [
      { name: '', lat: 1, lon: 1 },
      { name: 'x', lat: 91, lon: 1 },
      { name: 'x', lat: 1, lon: -181 },
      { name: 'x', lat: '1', lon: 1 },
      { name: 'x', lat: Number.NaN, lon: 1 },
      { name: 'x'.repeat(201), lat: 1, lon: 1 },
      'Seoul',
    ]) {
      expect(normalizePetConfig({ weather: { enabled: true, city } }).weather.city, JSON.stringify(city)).toBeNull();
    }
    // Optional labels must be non-empty strings.
    expect(normalizePetConfig({ weather: { city: { name: ' Busan ', admin1: 3, country: ' ', lat: 35.1, lon: 129.0 } } }).weather.city)
      .toEqual({ name: 'Busan', lat: 35.1, lon: 129.0 });
  });
});

describe('terminal.showTerminalStrip', () => {
  it('defaults off for new configs and for saved configs without the key', () => {
    expect(DEFAULT_TERMINAL_CONFIG.showTerminalStrip).toBe(false);
    expect(validateConfig({}).terminal.showTerminalStrip).toBe(false);
    expect(validateConfig({ version: 2, terminal: { fontSize: 13 } }).terminal.showTerminalStrip).toBe(false);
  });

  it('keeps an explicit choice', () => {
    expect(validateConfig({ version: 2, terminal: { showTerminalStrip: true } }).terminal.showTerminalStrip).toBe(true);
    expect(validateConfig({ version: 2, terminal: { showTerminalStrip: false } }).terminal.showTerminalStrip).toBe(false);
  });
});

describe('hints config', () => {
  it('defaults to raised / small and drops unknown values', () => {
    expect(validateConfig({}).hints).toEqual({ style: 'raised', size: 'small' });
    expect(validateConfig({ hints: { style: 'dark', size: 'normal' } }).hints).toEqual({ style: 'dark', size: 'normal' });
    expect(validateConfig({ hints: { style: 'neon', size: 'huge' } } as any).hints).toEqual({ style: 'raised', size: 'small' });
  });
});

describe('regionKeys', () => {
  it('is on unless explicitly turned off', () => {
    expect(validateConfig({}).regionKeys).toBe(true);
    expect(validateConfig({ regionKeys: false } as any).regionKeys).toBe(false);
    expect(validateConfig({ regionKeys: 'no' } as any).regionKeys).toBe(true);
  });
});

describe('window pin', () => {
  it('both switches are off for old config files and anything but true', () => {
    expect(validateConfig({}).window).toEqual({ alwaysOnTop: false, followDesktops: false });
    expect(validateConfig({ window: { alwaysOnTop: 'yes' } } as any).window).toEqual({ alwaysOnTop: false, followDesktops: false });
  });

  it('keeps saved values', () => {
    expect(validateConfig({ window: { alwaysOnTop: true, followDesktops: true } } as any).window)
      .toEqual({ alwaysOnTop: true, followDesktops: true });
    expect(validateConfig({ window: { followDesktops: true } } as any).window)
      .toEqual({ alwaysOnTop: false, followDesktops: true });
  });
});

describe('agent relay limits', () => {
  it('defaults for old config files and clamps saved values', () => {
    const board = { leaseSeconds: 300, renewSeconds: 60, staleMinutes: 30 };
    expect(validateConfig({}).agents).toEqual({ enabled: true, leadPhrase: '리드 에이전트로 진행해줘', maxChildren: 6, maxDepth: 2, maxTotal: 12, board });
    expect(validateConfig({ agents: { maxChildren: 99, maxDepth: 'x', maxTotal: 3 } } as any).agents)
      .toEqual({ enabled: true, leadPhrase: '리드 에이전트로 진행해줘', maxChildren: 32, maxDepth: 2, maxTotal: 3, board });
  });

  it('keeps the agent team switch (agents.enabled): on unless saved as false', () => {
    expect(validateConfig({ agents: { enabled: false } } as any).agents.enabled).toBe(false);
    expect(validateConfig({ agents: { enabled: true } } as any).agents.enabled).toBe(true);
    expect(validateConfig({ agents: { enabled: 'no' } } as any).agents.enabled).toBe(true);
  });

  it('keeps a valid lead phrase and falls back to the default otherwise', () => {
    expect(validateConfig({ agents: { leadPhrase: '  팀장으로   해줘 ' } } as any).agents.leadPhrase).toBe('팀장으로 해줘');
    expect(validateConfig({ agents: { leadPhrase: 'x' } } as any).agents.leadPhrase).toBe('리드 에이전트로 진행해줘');
  });

  it('keeps team-board timing (agents.board) clamped, renewal at most half the lease', () => {
    const agents = validateConfig({ agents: { board: { leaseSeconds: 100, renewSeconds: 90, staleMinutes: 2, backend: 'sqlite' } } } as any).agents;
    expect(agents.board).toEqual({ leaseSeconds: 100, renewSeconds: 50, staleMinutes: 5, backend: 'sqlite' });
  });
});
