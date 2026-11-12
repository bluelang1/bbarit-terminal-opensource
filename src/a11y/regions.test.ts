import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  availableRegions,
  cycleKeyboardRegion,
  installKbdRegions,
  isKeyboardInChrome,
  KBD_ITEM_ATTR,
  noteTerminalNavigation,
  PICK_FOCUS_FALLBACK_MS,
  regionLanding,
  registerActiveTerminal,
  resetKbdRegionsForTest,
  shouldTerminalTakeFocus,
  type RegionEnv,
} from './regions';

type Box = [left: number, top: number, width: number, height: number];

const place = (el: Element, [left, top, width, height]: Box) => {
  (el as HTMLElement).getBoundingClientRect = () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
  }) as DOMRect;
};

/** Mount HTML; every element gets a 10×10 box unless it says data-box="l,t,w,h". */
const mount = (html: string) => {
  document.body.innerHTML = html;
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const box = el.getAttribute('data-box');
    place(el, box ? box.split(',').map(Number) as Box : [0, 0, 10, 10]);
  }
};

const env = (): RegionEnv => ({ doc: document, win: window });
const byId = (id: string) => document.getElementById(id) as HTMLElement;
const names = () => availableRegions(env()).map((r) => r.name);
const activeId = () => (document.activeElement as HTMLElement | null)?.id || '(body)';

// A small version of the real window: top bar with the project tabs inside it (each tab is
// its own region element), toolbar, terminal header, one terminal with its strip, status bar.
const LAYOUT = `
  <div data-kbd-region="statusbar"><button id="stat">cpu</button></div>
  <div data-kbd-region="topbar">
    <button id="reload">reload</button>
    <div id="p1" data-kbd-region="projects" data-project-tab-id="p1">one</div>
    <div id="p2" data-kbd-region="projects" data-project-tab-id="p2" class="project-tab active">two</div>
    <div data-kbd-region="toolbar"><button id="git">git</button><button id="search">search</button></div>
  </div>
  <div data-kbd-region="terminal-header">
    <button id="new-tab">+</button>
    <div id="tab1" data-terminal-tab-id="t1" class="terminal-tab">t1</div>
    <div id="tab2" data-terminal-tab-id="t2" class="terminal-tab active">t2</div>
  </div>
  <div id="term" data-terminal-scope data-kbd-region="terminal">
    <div data-terminal-wrap>
      <textarea id="bridge" tabindex="-1"></textarea>
      <div data-kbd-region="terminal-strip"><button id="clear">clear</button></div>
    </div>
  </div>
`;

beforeEach(() => {
  resetKbdRegionsForTest();
});

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-hint-mode');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const withTerminal = () => {
  const focus = vi.fn(() => byId('bridge').focus());
  const off = registerActiveTerminal(byId('term'), focus);
  return { focus, off };
};

describe('region order and availability', () => {
  it('follows the visual order, not DOM order, and skips the terminal without a registered focuser', () => {
    mount(LAYOUT);
    expect(names()).toEqual(['topbar', 'toolbar', 'projects', 'terminal-header', 'terminal-strip', 'statusbar']);
    withTerminal();
    expect(names()).toEqual(['topbar', 'toolbar', 'projects', 'terminal-header', 'terminal', 'terminal-strip', 'statusbar']);
  });

  it('skips hidden regions and regions with nothing focusable', () => {
    mount(`${LAYOUT}<div data-kbd-region="prompts"><span>no controls</span></div>`);
    byId('git').parentElement!.style.display = 'none';
    place(byId('stat').parentElement!, [0, 0, 0, 0]);
    expect(names()).not.toContain('toolbar');
    expect(names()).not.toContain('statusbar');
    expect(names()).not.toContain('prompts');
  });

  it('skips disabled controls when choosing the first focusable', () => {
    mount(`<div data-kbd-region="statusbar"><button id="a" disabled>a</button><button id="b">b</button></div>`);
    expect(regionLanding('statusbar', env())?.id).toBe('b');
  });
});

describe('landing spot', () => {
  it('excludes nested regions from the outer one', () => {
    mount(LAYOUT);
    // The top bar's first focusable is reload, not a toolbar button or a project tab.
    expect(regionLanding('topbar', env())?.id).toBe('reload');
  });

  it('prefers the current item over the first focusable', () => {
    mount(LAYOUT);
    expect(regionLanding('projects', env())?.id).toBe('p2');
    expect(regionLanding('terminal-header', env())?.id).toBe('tab2');
  });

  it('prefers the element that last had focus while it is still usable', () => {
    mount(LAYOUT);
    const off = installKbdRegions(window);
    try {
      byId('search').focus();
      byId('stat').focus();
      expect(regionLanding('toolbar', env())?.id).toBe('search');
      byId('search').remove();
      expect(regionLanding('toolbar', env())?.id).toBe('git');
    } finally {
      off();
    }
  });

  it('makes a non-focusable current item focusable (tabindex -1) and Enter on it goes to the terminal', () => {
    vi.useFakeTimers();
    mount(LAYOUT);
    const { focus } = withTerminal();
    const off = installKbdRegions(window);
    try {
      byId('reload').focus();
      expect(cycleKeyboardRegion(1)).toBe('toolbar');
      expect(cycleKeyboardRegion(1)).toBe('projects');
      const tab = byId('p2');
      expect(activeId()).toBe('p2');
      expect(tab.getAttribute('tabindex')).toBe('-1');
      expect(tab.hasAttribute(KBD_ITEM_ATTR)).toBe(true);
      const events: string[] = [];
      for (const type of ['mousedown', 'mouseup', 'click']) tab.addEventListener(type, () => events.push(type));
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(events).toEqual(['mousedown', 'mouseup', 'click']);
      expect(isKeyboardInChrome()).toBe(false);
      // Already the current project: no activation refocus will come, so it focuses directly.
      vi.advanceTimersByTime(0);
      expect(focus).toHaveBeenCalledTimes(1);
      expect(activeId()).toBe('bridge');
    } finally {
      off();
    }
  });
});

describe('picking a project or terminal tab by keyboard', () => {
  const press = (el: HTMLElement, key = 'Enter') => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };

  it('a different tab: clicks it, lets the activation refocus run, and falls back after a delay', () => {
    vi.useFakeTimers();
    mount(LAYOUT);
    const { focus } = withTerminal();
    const off = installKbdRegions(window);
    try {
      byId('tab1').setAttribute('tabindex', '-1');
      byId('tab1').setAttribute(KBD_ITEM_ATTR, '');
      byId('tab1').focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      expect(isKeyboardInChrome()).toBe(true);
      const clicked = vi.fn();
      byId('tab1').addEventListener('click', clicked);
      press(byId('tab1'), ' ');
      expect(clicked).toHaveBeenCalledTimes(1);
      expect(isKeyboardInChrome()).toBe(false);
      expect(shouldTerminalTakeFocus()).toBe(true);
      vi.advanceTimersByTime(PICK_FOCUS_FALLBACK_MS - 1);
      expect(focus).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(focus).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('no fallback focus when the activation refocus already put focus in the terminal', () => {
    vi.useFakeTimers();
    mount(LAYOUT);
    const { focus } = withTerminal();
    const off = installKbdRegions(window);
    try {
      byId('tab1').setAttribute('tabindex', '-1');
      byId('tab1').setAttribute(KBD_ITEM_ATTR, '');
      byId('tab1').focus();
      press(byId('tab1'));
      byId('bridge').focus();
      vi.advanceTimersByTime(PICK_FOCUS_FALLBACK_MS);
      expect(focus).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('native project rows keep their own Enter handler and still end in the terminal', () => {
    vi.useFakeTimers();
    mount(`${LAYOUT}<div data-kbd-region="sidebar"><div id="row" role="button" tabindex="0" data-hint="project" class="project-selector-item">row</div></div>`);
    const { focus } = withTerminal();
    const off = installKbdRegions(window);
    try {
      byId('row').focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      const ev = press(byId('row'));
      expect(ev.defaultPrevented).toBe(false); // the row's own handler decides
      expect(isKeyboardInChrome()).toBe(false);
      vi.advanceTimersByTime(PICK_FOCUS_FALLBACK_MS);
      expect(focus).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('F6 away before the fallback fires cancels it', () => {
    vi.useFakeTimers();
    mount(LAYOUT);
    const { focus } = withTerminal();
    const off = installKbdRegions(window);
    try {
      byId('tab1').setAttribute('tabindex', '-1');
      byId('tab1').setAttribute(KBD_ITEM_ATTR, '');
      byId('tab1').focus();
      press(byId('tab1'));
      cycleKeyboardRegion(-1);
      expect(isKeyboardInChrome()).toBe(true);
      vi.advanceTimersByTime(PICK_FOCUS_FALLBACK_MS);
      expect(focus).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('other chrome buttons keep focus', () => {
    vi.useFakeTimers();
    mount(LAYOUT);
    const { focus } = withTerminal();
    const off = installKbdRegions(window);
    try {
      byId('git').focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      press(byId('git'));
      press(byId('new-tab'));
      vi.advanceTimersByTime(PICK_FOCUS_FALLBACK_MS * 2);
      expect(isKeyboardInChrome()).toBe(true);
      expect(focus).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
});

describe('cycleKeyboardRegion', () => {
  it('walks forward and wraps; Shift goes back', () => {
    mount(LAYOUT);
    const { focus } = withTerminal();
    byId('reload').focus();
    const seen: string[] = [];
    for (let i = 0; i < 7; i += 1) seen.push(`${cycleKeyboardRegion(1)}:${activeId()}`);
    expect(seen).toEqual([
      'toolbar:git',
      'projects:p2',
      'terminal-header:tab2',
      'terminal:bridge',
      'terminal-strip:clear',
      'statusbar:stat',
      'topbar:reload',
    ]);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(cycleKeyboardRegion(-1)).toBe('statusbar');
  });

  it('starts at the first (or last) region when nothing has focus', () => {
    mount(LAYOUT);
    expect(cycleKeyboardRegion(1)).toBe('topbar');
    (document.activeElement as HTMLElement).blur();
    resetKbdRegionsForTest();
    expect(cycleKeyboardRegion(-1)).toBe('statusbar');
  });

  it('continues by order when the focused region is no longer on screen', () => {
    mount(LAYOUT);
    byId('git').focus();
    byId('git').parentElement!.style.display = 'none';
    expect(cycleKeyboardRegion(1)).toBe('projects');
    byId('git').focus();
    expect(cycleKeyboardRegion(-1)).toBe('topbar');
  });

  it('lands on the active terminal strip only', () => {
    mount(`${LAYOUT}
      <div id="term-b" data-terminal-scope data-kbd-region="terminal">
        <div data-kbd-region="terminal-strip"><button id="clear-b">clear b</button></div>
      </div>`);
    registerActiveTerminal(byId('term-b'), () => {});
    expect(regionLanding('terminal-strip', env())?.id).toBe('clear-b');
  });

  it('does nothing while hint mode is open or a modal dialog is up', () => {
    mount(LAYOUT);
    byId('reload').focus();
    document.documentElement.setAttribute('data-hint-mode', '');
    expect(cycleKeyboardRegion(1)).toBeNull();
    document.documentElement.removeAttribute('data-hint-mode');
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    place(overlay, [0, 0, 100, 100]);
    document.body.appendChild(overlay);
    expect(cycleKeyboardRegion(1)).toBeNull();
    expect(activeId()).toBe('reload');
  });

  it('forgets an unregistered terminal', () => {
    mount(LAYOUT);
    const { off } = withTerminal();
    off();
    expect(names()).not.toContain('terminal');
  });
});

describe('keyboard-in-chrome guard for terminal auto-focus', () => {
  it('holds the terminal back after F6 into the chrome until the user acts on the terminal', () => {
    mount(LAYOUT);
    const { focus } = withTerminal();
    const off = installKbdRegions(window);
    try {
      byId('bridge').focus();
      expect(shouldTerminalTakeFocus()).toBe(true);
      // Leave the terminal: next region is the strip, then the status bar.
      cycleKeyboardRegion(1);
      cycleKeyboardRegion(1);
      expect(activeId()).toBe('stat');
      expect(isKeyboardInChrome()).toBe(true);
      expect(shouldTerminalTakeFocus()).toBe(false);
      // A mouse press anywhere restores today's mouse behaviour.
      window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(shouldTerminalTakeFocus()).toBe(true);

      cycleKeyboardRegion(1);
      expect(shouldTerminalTakeFocus()).toBe(false);
      // A terminal/project switch shortcut hands focus back.
      noteTerminalNavigation();
      expect(shouldTerminalTakeFocus()).toBe(true);

      byId('git').focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      expect(shouldTerminalTakeFocus()).toBe(false);
      // Focus entering the terminal (click, F6, hint pick) clears it.
      focus();
      expect(isKeyboardInChrome()).toBe(false);
    } finally {
      off();
    }
  });

  it('Tab inside a terminal does not count as walking the chrome', () => {
    mount(LAYOUT);
    const off = installKbdRegions(window);
    try {
      byId('bridge').focus();
      byId('bridge').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      expect(isKeyboardInChrome()).toBe(false);
    } finally {
      off();
    }
  });

  it('lets the terminal take focus when focus fell back to the body or sits in a modal', () => {
    mount(LAYOUT);
    byId('git').focus();
    cycleKeyboardRegion(1);
    expect(shouldTerminalTakeFocus()).toBe(false);
    (document.activeElement as HTMLElement).blur();
    expect(shouldTerminalTakeFocus()).toBe(true);
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.setAttribute('data-kbd-region', 'topbar');
    overlay.innerHTML = '<button id="ok">ok</button>';
    document.body.appendChild(overlay);
    byId('ok').focus();
    expect(shouldTerminalTakeFocus()).toBe(true);
  });
});

// The XTerminal auto-focus paths that run without a user action on the terminal must ask
// shouldTerminalTakeFocus first; inputs must stay out of the Tab order.
describe('XTerminal call sites', () => {
  const src = readFileSync(join(process.cwd(), 'src/XTerminal.tsx'), 'utf8');

  it('guards the activation refocus and the IME bridge initial focus', () => {
    expect(src).toMatch(/setTimeout\(\(\) => \{ if \(!isDisposedRef\.current && shouldTerminalTakeFocus\(\)\) focusActiveInput\(\); \}, 200\)/);
    expect(src).toMatch(/if \(shouldTerminalTakeFocus\(\)\) refocusBridge\(\);/);
  });

  it('registers the active terminal and keeps terminal inputs out of the Tab order', () => {
    expect(src).toContain('registerActiveTerminal(scope, focusActiveInput)');
    expect(src).toContain("term.textarea?.setAttribute('tabindex', '-1')");
    expect(src).toMatch(/ref=\{inputRef\}\s+type="text"\s+tabIndex=\{-1\}/);
    expect(src).toMatch(/ref=\{imeBridgeRef\}\s+tabIndex=\{-1\}/);
    expect(src).toContain('data-kbd-region="terminal"');
    expect(src).toContain('data-kbd-region="terminal-strip"');
  });
});
