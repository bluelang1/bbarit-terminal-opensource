// Keyboard regions: F6 / Shift+F6 (keybindings focus.nextRegion / focus.prevRegion) move
// focus between the big parts of the window, including out of a terminal.
//
// A region is every element carrying `data-kbd-region="<name>"`; several elements with the
// same name form one region (the top project tabs are siblings of the left controls, so
// each tab carries the attribute itself). A region element nested in another region is
// its own region and is excluded from the outer one. Order is KBD_REGION_ORDER, not DOM
// order: the top bar positions its children with CSS `order`.
//
// Landing spot in a region: the element there that last had focus (if still usable), else
// the current item (aria-current / aria-selected / the active project or terminal tab),
// else the first focusable, visible, enabled element. A region with none is skipped. The
// terminal region lands on the active terminal through the focus function that terminal
// registered (XTerminal's focusActiveInput — what a click on the terminal does).
//
// "Keyboard is in chrome": set when F6 lands outside a terminal or Tab is pressed outside
// one; cleared by any mouse press, by focus entering a terminal, by the terminal/project
// switch shortcuts (noteTerminalNavigation) and by Enter/Space on a project row/tab or a
// terminal tab (which then focuses that terminal). Other chrome buttons keep focus. While it is set and focus sits in a chrome
// region, terminal auto-focus paths (activation refocus, IME bridge initial focus) stand
// down — see shouldTerminalTakeFocus. Mouse users never set it, so their flow is unchanged.

import { isHintModeActive } from '../hints/hintModeFlag';
import {
  activateHintTarget,
  findTopHintDialog,
  hasHintArea,
  hintKindOf,
  isHintDisabled,
  isHintHiddenByStyle,
  isHintReachable,
} from '../hints/hintTargets';

export const KBD_REGION_ATTR = 'data-kbd-region';
export const TERMINAL_REGION = 'terminal';

/** Visual order of the regions (top-left to bottom-right). Unknown names follow in DOM order. */
export const KBD_REGION_ORDER = [
  'topbar',          // left controls of the top bar (.project-tabs)
  'toolbar',         // top toolbar (.top-toolbar)
  'projects',        // left project panel, or the top project tabs
  'sidebar',         // file tree / notes / skills sidebar (.file-tree-sidebar)
  'editor',          // editor area
  'terminal-header', // terminal header + tab strip
  'terminal',        // the active terminal (its input)
  'terminal-strip',  // the active terminal's right quick-command strip
  'panel',           // tool panels rendered in the main window (Git, MCP, Skills, DB, dashboard)
  'prompts',         // right prompt-library panel
  'statusbar',       // bottom status bar
] as const;

/** Set on elements this module made focusable (tabindex=-1) so Enter/Space can click them. */
export const KBD_ITEM_ATTR = 'data-kbd-item';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[tabindex]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  'summary',
].join(', ');

const CURRENT_ITEM_SELECTOR = [
  '[aria-current]:not([aria-current="false"])',
  '[aria-selected="true"]',
  '[data-project-tab-id].active',
  '[data-terminal-tab-id].active',
  '[data-hint="project"].active',
  '[data-hint="tab"].active',
].join(', ');

export interface RegionEnv {
  doc: Document;
  win: Window;
}

const defaultEnv = (): RegionEnv | null =>
  (typeof document === 'undefined' || typeof window === 'undefined') ? null : { doc: document, win: window };

// ── module state ────────────────────────────────────────────────────────────────────────
const lastFocused = new Map<string, HTMLElement>();
let lastRegion: string | null = null;
let keyboardInChrome = false;
/** Active terminals: their region element → the function a click on the terminal runs. */
const terminalFocusers = new Map<HTMLElement, () => void>();

/** Test helper: forget everything remembered. */
export function resetKbdRegionsForTest(): void {
  lastFocused.clear();
  lastRegion = null;
  keyboardInChrome = false;
  terminalFocusers.clear();
}

// ── DOM helpers ─────────────────────────────────────────────────────────────────────────
export function regionRootOf(el: Element | null | undefined): HTMLElement | null {
  return (el?.closest?.(`[${KBD_REGION_ATTR}]`) as HTMLElement | null) ?? null;
}

export function regionNameOf(el: Element | null | undefined): string | null {
  return regionRootOf(el)?.getAttribute(KBD_REGION_ATTR) || null;
}

const rankOf = (name: string): number => {
  const i = (KBD_REGION_ORDER as readonly string[]).indexOf(name);
  return i < 0 ? KBD_REGION_ORDER.length : i;
};

/** Laid out, not hidden by style, not disabled. */
export function isShown(el: Element, win: Window): boolean {
  if (!el.isConnected) return false;
  if (!hasHintArea(el.getBoundingClientRect())) return false;
  return !isHintHiddenByStyle(el, win);
}

/** What a click at its centre would hit (no hit test available in jsdom → true). */
const isReachable = (el: Element, doc: Document): boolean => {
  const hitTest = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint.bind(doc) : null;
  return isHintReachable(el, el.getBoundingClientRect(), hitTest);
};

const isUsable = (el: HTMLElement, env: RegionEnv): boolean =>
  !isHintDisabled(el) && isShown(el, env.win) && isReachable(el, env.doc);

/** The region element `el` belongs to is `root` (not a region nested inside it). */
const ownedBy = (root: HTMLElement, el: Element): boolean => regionRootOf(el) === root;

const visibleRoots = (name: string, env: RegionEnv): HTMLElement[] =>
  Array.from(env.doc.querySelectorAll<HTMLElement>(`[${KBD_REGION_ATTR}]`))
    .filter((el) => el.getAttribute(KBD_REGION_ATTR) === name && isShown(el, env.win));

/** Tab-order focusables of a region element (plus the element itself if it has a tabindex). */
export function regionFocusables(root: HTMLElement, env: RegionEnv): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (root.hasAttribute('tabindex') && isUsable(root, env)) out.push(root);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))) {
    if (el.tabIndex < 0) continue;
    if (!ownedBy(root, el)) continue;
    if (el.closest('.xterm, [data-hint-overlay]')) continue;
    if (isUsable(el, env)) out.push(el);
  }
  return out;
}

function currentItem(root: HTMLElement, env: RegionEnv): HTMLElement | null {
  const candidates = [
    ...(root.matches(CURRENT_ITEM_SELECTOR) ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>(CURRENT_ITEM_SELECTOR)),
  ];
  return candidates.find((el) => ownedBy(root, el) && isUsable(el, env)) ?? null;
}

/** The active terminal (registered focuser) that is on screen, preferring the remembered one. */
function activeTerminal(env: RegionEnv): { el: HTMLElement; focus: () => void } | null {
  const shown = Array.from(terminalFocusers.entries())
    .filter(([el]) => regionNameOf(el) === TERMINAL_REGION && isShown(el, env.win))
    .sort(([a], [b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  if (shown.length === 0) return null;
  const remembered = lastFocused.get(TERMINAL_REGION);
  const hit = remembered ? shown.find(([el]) => el.contains(remembered)) : undefined;
  const [el, focus] = hit ?? shown[0];
  return { el, focus };
}

/** Where focus would land in a non-terminal region, or null when it has nothing focusable. */
export function regionLanding(name: string, env: RegionEnv): HTMLElement | null {
  let roots = visibleRoots(name, env);
  if (name === 'terminal-strip') {
    // Only the active terminal's strip; other panes' strips belong to their own terminal.
    const term = activeTerminal(env);
    const own = term ? roots.filter((r) => term.el.contains(r)) : [];
    if (own.length > 0) roots = own;
  }
  if (roots.length === 0) return null;
  const remembered = lastFocused.get(name);
  if (remembered && remembered.isConnected) {
    const root = regionRootOf(remembered);
    if (root && roots.includes(root) && isUsable(remembered, env)) return remembered;
  }
  for (const root of roots) {
    const cur = currentItem(root, env);
    if (cur) return cur;
  }
  for (const root of roots) {
    const first = regionFocusables(root, env)[0];
    if (first) return first;
  }
  return null;
}

interface AvailableRegion {
  name: string;
  land: () => void;
}

function regionNamesInDom(env: RegionEnv): string[] {
  const names: string[] = [];
  for (const el of Array.from(env.doc.querySelectorAll(`[${KBD_REGION_ATTR}]`))) {
    const name = el.getAttribute(KBD_REGION_ATTR);
    if (name && !names.includes(name)) names.push(name);
  }
  return names
    .map((name, domIndex) => ({ name, domIndex }))
    .sort((a, b) => rankOf(a.name) - rankOf(b.name) || a.domIndex - b.domIndex)
    .map((x) => x.name);
}

/** Regions that are on screen and have somewhere to land, in visual order. */
export function availableRegions(env: RegionEnv): AvailableRegion[] {
  const out: AvailableRegion[] = [];
  for (const name of regionNamesInDom(env)) {
    if (name === TERMINAL_REGION) {
      const term = activeTerminal(env);
      if (term) out.push({ name, land: () => { keyboardInChrome = false; term.focus(); } });
      continue;
    }
    const target = regionLanding(name, env);
    if (target) out.push({ name, land: () => focusLanding(target, name) });
  }
  return out;
}

function focusLanding(el: HTMLElement, name: string): void {
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) {
    // A clickable item (project tab, terminal tab) that is not focusable by itself.
    el.setAttribute('tabindex', '-1');
    el.setAttribute(KBD_ITEM_ATTR, '');
  }
  keyboardInChrome = true;
  try { el.focus(); } catch { /* ignore */ }
  lastFocused.set(name, el);
  lastRegion = name;
}

/**
 * Move focus to the next (+1) or previous (-1) region. Does nothing while hint mode is open
 * or a modal dialog is up. Returns the region it moved to, or null.
 */
export function cycleKeyboardRegion(delta: 1 | -1, env: RegionEnv | null = defaultEnv()): string | null {
  if (!env) return null;
  if (isHintModeActive(env.doc)) return null;
  if (findTopHintDialog(env.doc, env.win)) return null;
  const regions = availableRegions(env);
  if (regions.length === 0) return null;
  const active = env.doc.activeElement;
  const current = (active && active !== env.doc.body ? regionNameOf(active) : null) ?? lastRegion;
  let index: number;
  const at = current ? regions.findIndex((r) => r.name === current) : -1;
  if (at >= 0) {
    index = (at + delta + regions.length) % regions.length;
  } else if (current) {
    // The current region is gone (hidden); continue from where it sits in the order.
    const rank = rankOf(current);
    if (delta > 0) {
      index = regions.findIndex((r) => rankOf(r.name) > rank);
      if (index < 0) index = 0;
    } else {
      index = -1;
      regions.forEach((r, i) => { if (rankOf(r.name) < rank) index = i; });
      if (index < 0) index = regions.length - 1;
    }
  } else {
    index = delta > 0 ? 0 : regions.length - 1;
  }
  const target = regions[index];
  target.land();
  return target.name;
}

/**
 * Keybinding handler body. The move runs after the keydown finishes dispatching: other
 * window keydown listeners (XTerminal's bridge refocus safety net among them) would
 * otherwise see focus already outside the terminal they got the event from and pull it back.
 */
export function requestRegionCycle(delta: 1 | -1): true {
  setTimeout(() => { cycleKeyboardRegion(delta); }, 0);
  return true;
}

// ── terminal side ───────────────────────────────────────────────────────────────────────
/** XTerminal registers its region element + focusActiveInput while it is the active terminal. */
export function registerActiveTerminal(el: HTMLElement, focus: () => void): () => void {
  terminalFocusers.set(el, focus);
  return () => {
    if (terminalFocusers.get(el) === focus) terminalFocusers.delete(el);
  };
}

/** A terminal/project switch the user asked for: the terminal may take focus again. */
export function noteTerminalNavigation(): void {
  keyboardInChrome = false;
}

export function isKeyboardInChrome(): boolean {
  return keyboardInChrome;
}

/**
 * May a terminal auto-focus path take focus now? False only while the keyboard user is in
 * another region: the flag is set and focus sits in a non-terminal region outside a modal.
 */
export function shouldTerminalTakeFocus(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  if (!keyboardInChrome || !doc) return true;
  const active = doc.activeElement;
  if (!active || active === doc.body) return true;
  const name = regionNameOf(active);
  if (!name || name === TERMINAL_REGION) return true;
  if (active.closest('[aria-modal="true"], .confirm-overlay, .settings-overlay')) return true;
  return false;
}

/** Project rows/tabs and terminal tabs: choosing one by keyboard goes to its terminal. */
const PICK_ITEM_SELECTOR = '[data-project-tab-id], [data-terminal-tab-id], [data-hint="project"], [data-hint="tab"]';
/** After a pick that switches terminals, XTerminal's activation refocus (200 ms) normally wins. */
export const PICK_FOCUS_FALLBACK_MS = 250;

function focusTerminalAfterPick(env: RegionEnv, delayMs: number): void {
  setTimeout(() => {
    if (keyboardInChrome) return; // the user moved on (F6 / Tab) in the meantime
    const active = env.doc.activeElement;
    if (active && active !== env.doc.body && regionNameOf(active) === TERMINAL_REGION) return;
    activeTerminal(env)?.focus();
  }, delayMs);
}

// ── listeners ───────────────────────────────────────────────────────────────────────────
let installCount = 0;
let uninstall: (() => void) | null = null;

/**
 * Focus memory, the chrome flag, and Enter/Space on items made focusable here. Ref-counted;
 * KeybindingManager.attach installs it and detach removes it.
 */
export function installKbdRegions(win: Window = window): () => void {
  installCount += 1;
  if (installCount === 1) {
    const doc = win.document;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      const name = regionNameOf(target);
      if (!target || !name) return;
      lastFocused.set(name, target);
      lastRegion = name;
      if (name === TERMINAL_REGION) keyboardInChrome = false;
    };
    const onPointer = () => { keyboardInChrome = false; };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isHintModeActive(doc)) return;
      const target = e.target as HTMLElement | null;
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Tab inside a terminal goes to the shell (completion); anywhere else it walks the chrome.
        if (regionNameOf(target) !== TERMINAL_REGION) keyboardInChrome = true;
        return;
      }
      if (!(e.key === 'Enter' || e.key === ' ') || e.repeat || e.isComposing
        || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey
        || !target || doc.activeElement !== target) return;
      if (target.matches?.(PICK_ITEM_SELECTOR)) {
        // Picking a project or terminal tab by keyboard goes to that terminal, like a click
        // or a switch shortcut: the activation refocus may run, and when the item was
        // already the current one (no activation happens) the terminal is focused here.
        const wasCurrent = target.classList.contains('active');
        keyboardInChrome = false;
        if (target.hasAttribute(KBD_ITEM_ATTR)) {
          e.preventDefault();
          e.stopPropagation();
          activateHintTarget(target, hintKindOf(target));
        } // native rows (role=button) run their own Enter/Space handler
        focusTerminalAfterPick({ doc, win }, wasCurrent ? 0 : PICK_FOCUS_FALLBACK_MS);
        return;
      }
      if (target.hasAttribute(KBD_ITEM_ATTR)) {
        // Any other item made focusable here: click it, keyboard stays (like a native button);
        // the synthetic mousedown must not count as the mouse user coming back.
        e.preventDefault();
        e.stopPropagation();
        activateHintTarget(target, hintKindOf(target));
        keyboardInChrome = true;
      }
    };
    doc.addEventListener('focusin', onFocusIn, true);
    win.addEventListener('mousedown', onPointer, true);
    win.addEventListener('pointerdown', onPointer, true);
    win.addEventListener('keydown', onKeyDown, true);
    uninstall = () => {
      doc.removeEventListener('focusin', onFocusIn, true);
      win.removeEventListener('mousedown', onPointer, true);
      win.removeEventListener('pointerdown', onPointer, true);
      win.removeEventListener('keydown', onKeyDown, true);
    };
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    installCount -= 1;
    if (installCount === 0) {
      uninstall?.();
      uninstall = null;
    }
  };
}
