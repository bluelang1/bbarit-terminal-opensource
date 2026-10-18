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

  it('registers macOS project MRU shortcuts on Ctrl+Shift brackets', () => {
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
