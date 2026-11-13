// Keyboard for small popup menus (layout menu, Office menu, tool dropdown).
//
// A menu opts in with markup only:
//   trigger: aria-haspopup="menu" aria-expanded={open} aria-controls="<menu id>"
//   menu:    id="<menu id>" role="menu" data-menu-nav
//   items:   role="menuitem" (non-button items also need tabIndex={-1})
//
// installMenuKeyboard() (main.tsx) adds one window keydown listener. While focus is
// inside such a menu: ArrowDown/ArrowUp (wrapping), Home/End move between items,
// Enter/Space choose (native for buttons, a click for other items), Escape closes
// the menu by clicking its trigger. Every key is kept away from the terminal and the
// global shortcuts. When a menu that the keyboard was used in goes away (a choice or
// Escape) and focus fell to <body>, focus returns to what it came from: the element
// passed to focusMenu (hint mode passes the terminal it parked), else the trigger.
//
// The mouse never moves focus into a menu: opening one by mouse leaves the keyboard
// with the terminal, and a press inside a menu keeps focus where it is (so a mouse
// pick or a pin toggle cannot leave keys stuck in the menu). Hint mode calls
// focusMenu after its pick opened a menu.
import { isHintModeActive } from './hintModeFlag';

export const MENU_NAV_ATTR = 'data-menu-nav';
export const MENU_NAV_SELECTOR = `[${MENU_NAV_ATTR}]`;
export const MENU_ITEM_SELECTOR = '[role="menuitem"]';

export type MenuNavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

const NAV_KEYS: ReadonlySet<string> = new Set<MenuNavKey>(['ArrowDown', 'ArrowUp', 'Home', 'End']);

export function isMenuNavKey(key: string): key is MenuNavKey {
  return NAV_KEYS.has(key);
}

/** Index to focus after `key`; `current` -1 means no item has focus yet. */
export function nextMenuIndex(count: number, current: number, key: MenuNavKey): number {
  if (count <= 0) return -1;
  switch (key) {
    case 'Home': return 0;
    case 'End': return count - 1;
    case 'ArrowDown': return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp': return current < 0 ? count - 1 : (current - 1 + count) % count;
  }
}

const isUsableItem = (item: HTMLElement, win: Window): boolean => {
  if ((item as HTMLButtonElement).disabled === true) return false;
  if (item.getAttribute('aria-disabled') === 'true') return false;
  const style = win.getComputedStyle(item);
  return style.display !== 'none' && style.visibility !== 'hidden';
};

/** The menu's items in DOM order, skipping disabled and hidden ones. */
export function menuItems(menu: Element): HTMLElement[] {
  const win = menu.ownerDocument.defaultView ?? window;
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter((item) => isUsableItem(item, win));
}

/** Where focus starts: the current choice (`.active` / aria-checked) or the first item. */
export function initialMenuItem(menu: Element): HTMLElement | null {
  const items = menuItems(menu);
  return items.find((item) => item.classList.contains('active') || item.getAttribute('aria-checked') === 'true')
    ?? items[0]
    ?? null;
}

const escapeId = (id: string): string => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&'));

/** The button whose aria-controls names this menu. */
export function menuTriggerOf(menu: Element): HTMLElement | null {
  if (!menu.id) return null;
  return menu.ownerDocument.querySelector<HTMLElement>(`[aria-controls="${escapeId(menu.id)}"]`);
}

/** The opted-in menu this trigger has open right now, or null. */
export function openedMenuOf(trigger: Element): HTMLElement | null {
  if (trigger.getAttribute('aria-expanded') !== 'true') return null;
  const id = trigger.getAttribute('aria-controls');
  if (!id) return null;
  const menu = trigger.ownerDocument.getElementById(id);
  return menu && menu.matches(MENU_NAV_SELECTOR) ? menu : null;
}

/** Explicit focus-return targets (set by focusMenu). */
const returnTargets = new WeakMap<Element, HTMLElement>();
/** Menus being watched for removal, with the function that stops watching. */
const watchers = new WeakMap<Element, () => void>();

const focusQuietly = (el: HTMLElement) => {
  try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
};

/**
 * Once the keyboard is used in a menu, wait for the menu to leave the DOM; if focus fell to
 * <body> with it, give focus back. Stops watching when focus moves to some other
 * element outside the menu (the user went elsewhere on purpose).
 */
function watchMenu(menu: HTMLElement): void {
  if (watchers.has(menu)) return;
  const doc = menu.ownerDocument;
  const win = doc.defaultView;
  if (!win || typeof win.MutationObserver !== 'function') return;
  const trigger = menuTriggerOf(menu);
  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof win.Node && !menu.contains(next)) stop();
  };
  const observer = new win.MutationObserver(() => {
    if (menu.isConnected) return;
    stop();
    const now = doc.activeElement;
    if (now && now !== doc.body) return;
    const target = returnTargets.get(menu) ?? trigger;
    if (target?.isConnected) focusQuietly(target);
  });
  function stop() {
    observer.disconnect();
    menu.removeEventListener('focusout', onFocusOut);
    watchers.delete(menu);
  }
  observer.observe(doc.body, { childList: true, subtree: true });
  menu.addEventListener('focusout', onFocusOut);
  watchers.set(menu, stop);
}

/**
 * Move keyboard focus into an open menu (current choice or first item). When the menu
 * closes, focus goes to `returnTo` (or the trigger). Returns false if nothing took focus.
 */
export function focusMenu(menu: HTMLElement, returnTo: HTMLElement | null = null): boolean {
  const item = initialMenuItem(menu);
  if (!item) return false;
  if (returnTo) returnTargets.set(menu, returnTo);
  focusQuietly(item);
  if (menu.ownerDocument.activeElement !== item) return false;
  watchMenu(menu);
  return true;
}

const isNativeActivator = (el: Element): boolean => el.tagName === 'BUTTON' || el.matches('a[href]');

/** One keydown while focus is in an opted-in menu. Returns false when focus is not in one. */
export function handleMenuKeyDown(event: KeyboardEvent, doc: Document = document): boolean {
  if (isHintModeActive(doc)) return false;
  const active = doc.activeElement;
  const menu = active instanceof Element ? active.closest<HTMLElement>(MENU_NAV_SELECTOR) : null;
  if (!menu) return false;
  watchMenu(menu);
  // The menu owns the keyboard: no terminal input, no global shortcut.
  event.stopPropagation();
  event.stopImmediatePropagation();
  if (event.isComposing) return true;
  const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
  const item = (active as Element).closest<HTMLElement>(MENU_ITEM_SELECTOR);
  if (plain && isMenuNavKey(event.key)) {
    event.preventDefault();
    const items = menuItems(menu);
    const next = items[nextMenuIndex(items.length, item ? items.indexOf(item) : -1, event.key)];
    if (next) focusQuietly(next);
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    menuTriggerOf(menu)?.click();
    return true;
  }
  if (plain && (event.key === 'Enter' || event.key === ' ') && item && !isNativeActivator(item)) {
    event.preventDefault();
    item.click();
  }
  return true;
}

const TEXT_ENTRY_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * A mouse press inside an opted-in menu does not move focus (the click still runs).
 * Text fields inside a menu keep the normal behaviour.
 */
export function keepFocusOnMenuPress(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!target.closest(MENU_NAV_SELECTOR) || target.closest(TEXT_ENTRY_SELECTOR)) return;
  event.preventDefault();
}

/**
 * Install the menu keyboard once per window. Call before React renders: window
 * capture listeners run in registration order, so this one sees keys before the
 * terminal and shortcut listeners that components add later.
 */
export function installMenuKeyboard(win: Window = window): () => void {
  const doc = win.document;
  const onKeyDown = (event: KeyboardEvent) => { handleMenuKeyDown(event, doc); };
  win.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('mousedown', keepFocusOnMenuPress, true);
  return () => {
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('mousedown', keepFocusOnMenuPress, true);
  };
}
