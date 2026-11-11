import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeybindingManager } from './KeybindingManager';
import { detectConflicts, parseKeybindings } from './parser';

const setPlatform = (platform: string) => {
  vi.stubGlobal('navigator', { platform });
};

describe('KeybindingManager defaults', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers macOS project list shortcuts on Ctrl+Shift brackets', () => {
    setPlatform('MacIntel');

    expect(KeybindingManager.defaultBindings()).toEqual(expect.arrayContaining([
      { id: 'project.previous', keys: 'ctrl+shift+[' },
      { id: 'project.next', keys: 'ctrl+shift+]' },
    ]));
  });

  it('keeps project bracket shortcuts conflict-free', () => {
    setPlatform('MacIntel');
    const projectBracketBindings = KeybindingManager.defaultBindings()
      .filter((binding) => binding.keys.includes('shift+[') || binding.keys.includes('shift+]'));

    expect(detectConflicts(parseKeybindings(projectBracketBindings))).toEqual([]);
  });
});

describe('hints.toggle default', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['MacIntel', 'cmd+j'],
    ['Win32', 'alt+j'],
    ['Linux x86_64', 'alt+j'],
  ])('binds hint mode to %s → %s without clashing with another default', (platform, keys) => {
    setPlatform(platform);
    const defaults = KeybindingManager.defaultBindings();
    expect(defaults).toEqual(expect.arrayContaining([{ id: 'hints.toggle', keys }]));
    const conflicts = detectConflicts(parseKeybindings(defaults));
    expect(conflicts.filter((c) => JSON.stringify(c).includes('hints.toggle'))).toEqual([]);
  });

  it('skips every shortcut while hint mode is open', () => {
    setPlatform('MacIntel');
    const km = new KeybindingManager();
    km.init();
    const handler = vi.fn();
    km.register('hints.toggle', handler);
    km.attach();
    try {
      const press = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', metaKey: true, bubbles: true }));
      press();
      expect(handler).toHaveBeenCalledTimes(1);
      document.documentElement.setAttribute('data-hint-mode', '');
      press();
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      document.documentElement.removeAttribute('data-hint-mode');
      km.destroy();
    }
  });
});
