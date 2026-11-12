// Popup menu keyboard (menuKeyboard.ts) against a jsdom DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  focusMenu,
  initialMenuItem,
  installMenuKeyboard,
  menuItems,
  menuTriggerOf,
  nextMenuIndex,
  openedMenuOf,
} from './menuKeyboard';
import { HINT_MODE_ATTR } from './hintModeFlag';

describe('nextMenuIndex', () => {
  it('wraps ArrowDown/ArrowUp and jumps with Home/End', () => {
    expect(nextMenuIndex(3, 0, 'ArrowDown')).toBe(1);
    expect(nextMenuIndex(3, 2, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(3, 0, 'ArrowUp')).toBe(2);
    expect(nextMenuIndex(3, 1, 'Home')).toBe(0);
    expect(nextMenuIndex(3, 1, 'End')).toBe(2);
  });

  it('starts at the first / last item when nothing has focus', () => {
    expect(nextMenuIndex(3, -1, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(3, -1, 'ArrowUp')).toBe(2);
    expect(nextMenuIndex(0, -1, 'ArrowDown')).toBe(-1);
  });
});

let fixture: HTMLDivElement;
let terminal: HTMLTextAreaElement;
let trigger: HTMLButtonElement;
let open = false;
let uninstall: () => void = () => {};
const chosen: string[] = [];
const leaked: string[] = [];
const leakListener = (event: KeyboardEvent) => { leaked.push(event.key); };

/** A tiny "React-like" menu: the trigger toggles it, a choice closes it. */
function render(active = 'b') {
  const wrap = fixture.querySelector('#wrap')!;
  wrap.querySelector('#menu')?.remove();
  trigger.setAttribute('aria-expanded', String(open));
  if (!open) return;
  const menu = document.createElement('div');
  menu.id = 'menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('data-menu-nav', '');
  menu.innerHTML = `
    <div class="title">Layout</div>
    <button id="a" role="menuitem">A</button>
    <button id="b" role="menuitem" class="${active === 'b' ? 'active' : ''}">B</button>
    <button id="off" role="menuitem" disabled>Off</button>
    <button id="hidden" role="menuitem" style="display:none">Hidden</button>
    <div id="c" role="menuitem" tabindex="-1">C</div>`;
  for (const item of Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))) {
    item.addEventListener('click', () => {
      chosen.push(item.id);
      open = false;
      render();
    });
  }
  wrap.appendChild(menu);
}

const menuEl = () => document.getElementById('menu') as HTMLElement;
const press = (key: string, extra: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
};
/** MutationObserver callbacks are microtasks. */
const flush = () => new Promise<void>((resolve) => { queueMicrotask(resolve); });

beforeEach(() => {
  chosen.length = 0;
  leaked.length = 0;
  open = false;
  fixture = document.createElement('div');
  fixture.innerHTML = `
    <textarea id="term"></textarea>
    <div id="wrap"><button id="trigger" aria-haspopup="menu" aria-controls="menu" aria-expanded="false"></button></div>`;
  document.body.appendChild(fixture);
  terminal = fixture.querySelector('#term')!;
  trigger = fixture.querySelector('#trigger')!;
  trigger.addEventListener('click', () => { open = !open; render(); });
  uninstall = installMenuKeyboard(window);
  // Stands in for the terminal / shortcut listeners components add later.
  window.addEventListener('keydown', leakListener, true);
});

afterEach(() => {
  uninstall();
  window.removeEventListener('keydown', leakListener, true);
  fixture.remove();
  document.documentElement.removeAttribute(HINT_MODE_ATTR);
});

describe('menu lookup', () => {
  it('finds the open menu from its trigger and back, only while expanded', () => {
    expect(openedMenuOf(trigger)).toBeNull();
    trigger.click();
    expect(openedMenuOf(trigger)).toBe(menuEl());
    expect(menuTriggerOf(menuEl())).toBe(trigger);
  });

  it('ignores a controlled element that did not opt in', () => {
    trigger.click();
    menuEl().removeAttribute('data-menu-nav');
    expect(openedMenuOf(trigger)).toBeNull();
  });

  it('lists usable items and starts on the current choice', () => {
    trigger.click();
    expect(menuItems(menuEl()).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(initialMenuItem(menuEl())?.id).toBe('b');
    open = true;
    render('none');
    expect(initialMenuItem(menuEl())?.id).toBe('a');
  });
});

describe('keyboard in a focused menu', () => {
  beforeEach(() => {
    terminal.focus();
    trigger.click();
    expect(focusMenu(menuEl(), terminal)).toBe(true);
  });

  it('moves with arrows (wrapping) and Home/End, skipping disabled and hidden items', () => {
    expect(document.activeElement?.id).toBe('b');
    expect(press('ArrowDown').defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('c');
    press('ArrowDown');
    expect(document.activeElement?.id).toBe('a');
    press('ArrowUp');
    expect(document.activeElement?.id).toBe('c');
    press('Home');
    expect(document.activeElement?.id).toBe('a');
    press('End');
    expect(document.activeElement?.id).toBe('c');
  });

  it('keeps every key away from later window listeners (terminal, shortcuts)', () => {
    press('ArrowDown');
    press('x');
    press('j', { metaKey: true });
    expect(leaked).toEqual([]);
  });

  it('Escape closes through the trigger and focus returns to the terminal', async () => {
    press('Escape');
    expect(open).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await flush();
    expect(document.activeElement).toBe(terminal);
  });

  it('Enter on a non-button item clicks it; closing returns focus to the terminal', async () => {
    press('End');
    expect(press('Enter').defaultPrevented).toBe(true);
    expect(chosen).toEqual(['c']);
    await flush();
    expect(document.activeElement).toBe(terminal);
  });

  it('leaves Enter on a button to the browser (native click)', () => {
    expect(press('Enter').defaultPrevented).toBe(false);
    expect(chosen).toEqual([]);
  });

  it('a button choice (click) closes the menu and focus returns to the terminal', async () => {
    (document.activeElement as HTMLElement).click();
    expect(chosen).toEqual(['b']);
    await flush();
    expect(document.activeElement).toBe(terminal);
  });

  it('does not pull focus back when the user moved focus elsewhere first', async () => {
    const other = document.createElement('input');
    fixture.appendChild(other);
    other.focus();
    open = false;
    render();
    await flush();
    expect(document.activeElement).toBe(other);
  });

  it('stands aside while hint mode owns the keyboard', () => {
    document.documentElement.setAttribute(HINT_MODE_ATTR, '');
    press('ArrowDown');
    expect(document.activeElement?.id).toBe('b');
    expect(leaked).toEqual(['ArrowDown']);
  });
});

describe('menus opened without hint mode', () => {
  it('does nothing while focus is outside the menu (mouse-opened menu, terminal keeps keys)', () => {
    terminal.focus();
    trigger.click();
    const event = press('ArrowDown');
    expect(event.defaultPrevented).toBe(false);
    expect(leaked).toEqual(['ArrowDown']);
    expect(document.activeElement).toBe(terminal);
  });

  it('returns focus to the trigger when no return target was given', async () => {
    trigger.click();
    (menuEl().querySelector('#a') as HTMLElement).focus();
    press('Escape');
    await flush();
    expect(document.activeElement).toBe(trigger);
  });

  it('focusMenu reports false for a menu without usable items', () => {
    trigger.click();
    for (const item of Array.from(menuEl().querySelectorAll('[role="menuitem"]'))) item.remove();
    expect(focusMenu(menuEl(), terminal)).toBe(false);
  });
});

describe('mouse presses inside a menu', () => {
  it('keep focus where it is (default prevented), except in text fields', () => {
    trigger.click();
    const press = (el: Element) => {
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(press(menuEl().querySelector('#c')!)).toBe(true);
    expect(press(menuEl().querySelector('.title')!)).toBe(true);
    const field = document.createElement('input');
    menuEl().appendChild(field);
    expect(press(field)).toBe(false);
    expect(press(terminal)).toBe(false);
  });

  it('a mouse-opened menu that never had keyboard use does not pull focus anywhere when it closes', async () => {
    trigger.click();
    (menuEl().querySelector('#c') as HTMLElement).focus(); // e.g. a browser that focuses on click
    (menuEl().querySelector('#c') as HTMLElement).click();
    await flush();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('install', () => {
  it('uninstall removes the listener', () => {
    uninstall();
    uninstall = () => {};
    trigger.click();
    (menuEl().querySelector('#a') as HTMLElement).focus();
    const spy = vi.fn();
    menuEl().addEventListener('keydown', spy);
    press('ArrowDown');
    expect(spy).toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('a');
  });
});
