import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeybindingManager } from './KeybindingManager';
import { detectConflicts, matchesEvent, parseKeybindings } from './parser';
import { cycleKeyboardRegion, isKeyboardInChrome, registerActiveTerminal, resetKbdRegionsForTest } from '../a11y/regions';

// Settings > Shortcuts "regionKeys" switch, read through the config snapshot.
const cfg = vi.hoisted(() => ({ regionKeys: true }));
vi.mock('../config/ConfigContext', () => ({ getConfigSnapshot: () => cfg }));

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

describe('focus.nextRegion / focus.prevRegion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
    resetKbdRegionsForTest();
  });

  it.each(['MacIntel', 'Win32', 'Linux x86_64'])('binds F6 / Shift+F6 on %s without clashing', (platform) => {
    setPlatform(platform);
    const defaults = KeybindingManager.defaultBindings();
    expect(defaults).toEqual(expect.arrayContaining([
      { id: 'focus.nextRegion', keys: 'f6' },
      { id: 'focus.prevRegion', keys: 'shift+f6' },
    ]));
    const conflicts = detectConflicts(parseKeybindings(defaults));
    expect(conflicts.filter((c) => JSON.stringify(c).includes('Region'))).toEqual([]);
  });

  it('matches F6 reported as "Process" by an IME mid-composition (by event.code)', () => {
    const [entry] = parseKeybindings([{ id: 'focus.nextRegion', keys: 'f6' }]);
    const ev = new KeyboardEvent('keydown', { key: 'Process', code: 'F6' });
    expect(matchesEvent(entry.binding, ev)).toBe(true);
  });

  it('takes F6 before the terminal sees it and moves focus after the keydown', () => {
    vi.useFakeTimers();
    setPlatform('MacIntel');
    document.body.innerHTML = `
      <div data-kbd-region="toolbar"><button id="git">git</button></div>
      <div data-terminal-scope data-kbd-region="terminal"><textarea id="bridge"></textarea></div>`;
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      (el as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    }
    const bridge = document.getElementById('bridge') as HTMLTextAreaElement;
    registerActiveTerminal(bridge.parentElement as HTMLElement, () => bridge.focus());
    const km = new KeybindingManager();
    km.init();
    km.attach();
    try {
      bridge.focus();
      const terminalSaw = vi.fn();
      bridge.addEventListener('keydown', terminalSaw);
      const ev = new KeyboardEvent('keydown', { key: 'F6', code: 'F6', bubbles: true, cancelable: true });
      bridge.dispatchEvent(ev);
      expect(terminalSaw).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(true);
      // Still in the terminal during dispatch; the move happens right after.
      expect(document.activeElement).toBe(bridge);
      vi.runAllTimers();
      expect(document.activeElement?.id).toBe('git');
      expect(isKeyboardInChrome()).toBe(true);
      // Shift+F6 from the toolbar wraps back to the terminal.
      document.getElementById('git')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', code: 'F6', shiftKey: true, bubbles: true, cancelable: true }));
      vi.runAllTimers();
      expect(document.activeElement).toBe(bridge);
    } finally {
      km.destroy();
    }
  });

  it('a terminal switch shortcut lets the terminal take focus again', () => {
    setPlatform('MacIntel');
    document.body.innerHTML = '<div data-kbd-region="toolbar"><button id="git">git</button></div>';
    const git = document.getElementById('git') as HTMLElement;
    git.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    git.parentElement!.getBoundingClientRect = git.getBoundingClientRect;
    const km = new KeybindingManager();
    km.init();
    const handler = vi.fn();
    km.register('terminal.tab-1', handler);
    km.attach();
    try {
      git.focus();
      cycleKeyboardRegion(1); // F6 into the toolbar
      expect(isKeyboardInChrome()).toBe(true);
      git.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', metaKey: true, bubbles: true, cancelable: true }));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(isKeyboardInChrome()).toBe(false);
    } finally {
      km.destroy();
    }
  });

  it('with region keys switched off, F6 / Shift+F6 go to the terminal as before', () => {
    vi.useFakeTimers();
    setPlatform('MacIntel');
    cfg.regionKeys = false;
    document.body.innerHTML = `
      <div data-kbd-region="toolbar"><button id="git">git</button></div>
      <div data-terminal-scope data-kbd-region="terminal"><textarea id="bridge"></textarea></div>`;
    const bridge = document.getElementById('bridge') as HTMLTextAreaElement;
    const km = new KeybindingManager();
    km.init();
    km.attach();
    try {
      bridge.focus();
      const terminalSaw = vi.fn();
      bridge.addEventListener('keydown', terminalSaw);
      for (const shiftKey of [false, true]) {
        const ev = new KeyboardEvent('keydown', { key: 'F6', code: 'F6', shiftKey, bubbles: true, cancelable: true });
        bridge.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(false);
      }
      vi.runAllTimers();
      expect(terminalSaw).toHaveBeenCalledTimes(2);
      expect(document.activeElement).toBe(bridge);
    } finally {
      cfg.regionKeys = true;
      km.destroy();
    }
  });

  it('task.open-last-completed from a text field lets the opened terminal take focus', () => {
    setPlatform('MacIntel');
    document.body.innerHTML = '<input id="field">';
    const field = document.getElementById('field') as HTMLInputElement;
    const km = new KeybindingManager();
    km.init();
    const handler = vi.fn();
    km.register('task.open-last-completed', handler);
    km.attach();
    try {
      document.body.insertAdjacentHTML('beforeend', '<div data-kbd-region="toolbar"><button id="git">git</button></div>');
      const git = document.getElementById('git') as HTMLElement;
      const box = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      git.getBoundingClientRect = box;
      git.parentElement!.getBoundingClientRect = box;
      git.focus();
      cycleKeyboardRegion(1);
      expect(isKeyboardInChrome()).toBe(true);
      field.focus();
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(isKeyboardInChrome()).toBe(false);
    } finally {
      km.destroy();
    }
  });
});
