import { describe, expect, it, vi } from 'vitest';
import {
  applyWindowPin, followDesktopsSupported, followsMainPin, keepGuideOnTopAfterSpotlight, readWindowPin,
  nativePinFor, setSecondaryOnTop, windowPinAction, type PinnableWindow,
} from './windowPin';

function fakeWindow(overrides: Partial<PinnableWindow> = {}) {
  const calls: string[] = [];
  const win: PinnableWindow = {
    setAlwaysOnTop: vi.fn(async (v: boolean) => { calls.push(`top:${v}`); }),
    setVisibleOnAllWorkspaces: vi.fn(async (v: boolean) => { calls.push(`all:${v}`); }),
    ...overrides,
  };
  return { win, calls };
}

describe('applyWindowPin', () => {
  it('passes both values to the window', async () => {
    const { win, calls } = fakeWindow();
    await applyWindowPin(win, { alwaysOnTop: true, followDesktops: false });
    expect(calls.sort()).toEqual(['all:false', 'top:true']);
  });

  it('turns both off', async () => {
    const { win } = fakeWindow();
    await applyWindowPin(win, { alwaysOnTop: false, followDesktops: false });
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(false);
  });

  it('a failing call does not throw and does not stop the other', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { win } = fakeWindow({
      setVisibleOnAllWorkspaces: vi.fn(async () => { throw new Error('not allowed'); }),
    });
    await expect(applyWindowPin(win, { alwaysOnTop: true, followDesktops: true })).resolves.toBeUndefined();
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a synchronous throw is caught too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { win } = fakeWindow({
      setAlwaysOnTop: vi.fn(() => { throw new Error('boom'); }) as unknown as PinnableWindow['setAlwaysOnTop'],
    });
    await expect(applyWindowPin(win, { alwaysOnTop: true, followDesktops: true })).resolves.toBeUndefined();
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true);
    warn.mockRestore();
  });
});

describe('readWindowPin', () => {
  it('defaults to off for missing or malformed values', () => {
    expect(readWindowPin(undefined)).toEqual({ alwaysOnTop: false, followDesktops: false });
    expect(readWindowPin({ alwaysOnTop: 'yes', followDesktops: 1 })).toEqual({ alwaysOnTop: false, followDesktops: false });
  });

  it('keeps explicit true values', () => {
    expect(readWindowPin({ alwaysOnTop: true, followDesktops: true })).toEqual({ alwaysOnTop: true, followDesktops: true });
  });
});

describe('windowPinAction', () => {
  const off = { alwaysOnTop: false, followDesktops: false };
  const top = { alwaysOnTop: true, followDesktops: false };
  const base = { label: 'main', ready: true, touched: false };

  it('waits for config', () => {
    expect(windowPinAction({ ...base, ready: false, state: top })).toBe('skip');
  });

  it('only the main window applies', () => {
    expect(windowPinAction({ ...base, label: 'harness', state: top })).toBe('skip');
    expect(windowPinAction({ ...base, label: 'tool-guide', state: top })).toBe('skip');
  });

  it('leaves the window alone until a switch is first used', () => {
    expect(windowPinAction({ ...base, state: off })).toBe('skip');
    expect(windowPinAction({ ...base, state: top })).toBe('apply');
    expect(windowPinAction({ ...base, state: { alwaysOnTop: false, followDesktops: true } })).toBe('apply');
  });

  it('applies turning off once a switch has been used', () => {
    expect(windowPinAction({ ...base, touched: true, state: off })).toBe('apply');
  });
});

describe('followsMainPin', () => {
  it('every app window but main and the pet', () => {
    expect(followsMainPin('main')).toBe(false);
    expect(followsMainPin('pet')).toBe(false);
    for (const l of ['tool-guide', 'tool-settings', 'term-detach-abc', 'harness', 'agent-1', 'scrum-x', 'research-y']) {
      expect(followsMainPin(l), l).toBe(true);
    }
    expect(followsMainPin('')).toBe(false);
  });
});

describe('setSecondaryOnTop', () => {
  it('sets only the windows that follow main, and survives failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const mk = (label: string, fail = false) => ({
      label,
      setAlwaysOnTop: async (on: boolean) => { if (fail) throw new Error('gone'); calls.push(`${label}:${on}`); },
    });
    await setSecondaryOnTop([mk('main'), mk('pet'), mk('tool-guide', true), mk('term-detach-1'), mk('harness')], true);
    expect(calls.sort()).toEqual(['harness:true', 'term-detach-1:true']);
    warn.mockRestore();
  });
});

describe('keepGuideOnTopAfterSpotlight', () => {
  it('only while the main window is pinned', () => {
    expect(keepGuideOnTopAfterSpotlight({ alwaysOnTop: true })).toBe(true);
    expect(keepGuideOnTopAfterSpotlight({ alwaysOnTop: false })).toBe(false);
    expect(keepGuideOnTopAfterSpotlight(undefined)).toBe(false);
  });
});

describe('followDesktopsSupported', () => {
  it('macOS only', () => {
    expect(followDesktopsSupported('MacIntel')).toBe(true);
    expect(followDesktopsSupported('Win32')).toBe(false);
    expect(followDesktopsSupported('Linux x86_64')).toBe(false);
    expect(followDesktopsSupported(undefined)).toBe(false);
  });
});

describe('native pin (macOS)', () => {
  it('nativePinFor uses the window_pin_apply command on macOS only', async () => {
    const invoke = vi.fn(async () => undefined);
    expect(nativePinFor('Win32', invoke)).toBeNull();
    expect(nativePinFor('Linux x86_64', invoke)).toBeNull();
    const native = nativePinFor('MacIntel', invoke)!;
    await native('main', true, false);
    expect(invoke).toHaveBeenCalledWith('window_pin_apply', { label: 'main', alwaysOnTop: true, followDesktops: false });
  });

  it('applyWindowPin goes through the native path when given one', async () => {
    const { win } = fakeWindow();
    const native = vi.fn(async () => {});
    await applyWindowPin({ ...win, label: 'main' }, { alwaysOnTop: true, followDesktops: true }, native);
    expect(native).toHaveBeenCalledWith('main', true, true);
    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(win.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
  });

  it('applyWindowPin logs a native failure instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { win } = fakeWindow();
    const native = vi.fn(async () => { throw new Error('no window'); });
    await expect(applyWindowPin({ ...win, label: 'main' }, { alwaysOnTop: false, followDesktops: false }, native)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('setSecondaryOnTop pins other windows natively, never follow, never the pet', async () => {
    const native = vi.fn(async () => {});
    const mk = (label: string) => ({ label, setAlwaysOnTop: vi.fn(async () => {}) });
    const wins = [mk('main'), mk('pet'), mk('tool-guide')];
    await setSecondaryOnTop(wins, true, native);
    expect(native.mock.calls).toEqual([['tool-guide', true, false]]);
    expect(wins[2].setAlwaysOnTop).not.toHaveBeenCalled();
  });
});
