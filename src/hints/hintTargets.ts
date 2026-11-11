// Which on-screen elements get a hint, in what order, where the badge goes,
// and how a picked element is activated. DOM-only; no React.

export type HintKind = 'project' | 'tab' | 'terminal' | 'nav';

/** `data-kind` on each hint box; per-kind colours are CSS-only (App.css `.hint-badge[data-kind=…]`). */
export type HintDataKind = HintKind;

export interface HintRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface HintTarget {
  element: HTMLElement;
  kind: HintKind;
  rect: HintRect;
}

/**
 * Hints are opt-in and only for navigation: things that move you somewhere or
 * show/hide a part of the screen. Project rows/tabs (`data-hint="project"`,
 * data-project-tab-id), terminal tabs (`data-hint="tab"`), terminal panes (the
 * XTerminal `[data-terminal-wrap]`) and controls tagged `data-hint="nav"` in the JSX.
 * Ordinary action buttons and close/delete buttons are never hinted.
 */
export const HINT_TERMINAL_SELECTOR = '[data-terminal-wrap]';
export const HINT_TARGET_SELECTOR = [
  HINT_TERMINAL_SELECTOR,
  '[data-hint="project"]',
  '[data-hint="tab"]',
  '[data-hint="nav"]',
  '[data-project-tab-id]',
].join(', ');

/** Never hinted: the xterm text surface and the hint layer itself. `data-hint="off"` opts out. */
export const HINT_EXCLUDED_SELECTOR = '.xterm, [data-hint-overlay], [data-hint="off"]';

/** Open modal layers; when one is open only elements inside the top-most one get hints. */
export const HINT_DIALOG_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '[class*="modal-overlay"]',
  '[class*="modal-backdrop"]',
  '.confirm-overlay',
  '.settings-overlay',
].join(', ');

export function hintKindOf(element: Element): HintKind {
  const declared = element.getAttribute('data-hint');
  if (declared === 'project' || declared === 'tab' || declared === 'terminal') return declared;
  if (element.hasAttribute('data-project-tab-id')) return 'project';
  if (element.hasAttribute('data-terminal-tab-id')) return 'tab';
  if (element.matches(HINT_TERMINAL_SELECTOR)) return 'terminal';
  return 'nav';
}

export function hintDataKind(target: Pick<HintTarget, 'kind'>): HintDataKind {
  return target.kind;
}

export function isHintExcluded(element: Element): boolean {
  return !!element.closest(HINT_EXCLUDED_SELECTOR);
}

export function isHintDisabled(element: Element): boolean {
  if ((element as HTMLButtonElement).disabled === true) return true;
  if (element.closest('[aria-disabled="true"]')) return true;
  if (element.closest('fieldset[disabled]')) return true;
  return false;
}

/** display:none / visibility:hidden / opacity:0 on the element or an ancestor, or pointer-events:none. */
export function isHintHiddenByStyle(element: Element, win: Window): boolean {
  const own = win.getComputedStyle(element);
  if (own.visibility === 'hidden' || own.visibility === 'collapse') return true;
  if (own.pointerEvents === 'none') return true;
  for (let el: Element | null = element; el && el !== el.ownerDocument.documentElement; el = el.parentElement) {
    const cs = el === element ? own : win.getComputedStyle(el);
    if (cs.display === 'none') return true;
    if (cs.opacity !== '' && Number(cs.opacity) === 0) return true;
  }
  return false;
}

export function hasHintArea(rect: HintRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

export function isRectInViewport(rect: HintRect, viewport: { width: number; height: number }): boolean {
  return rect.left + rect.width > 0
    && rect.top + rect.height > 0
    && rect.left < viewport.width
    && rect.top < viewport.height;
}

/**
 * True when the element is what a click at its centre would hit (it, or something
 * inside it). Without a hit test (jsdom) the element is accepted.
 */
export function isHintReachable(
  element: Element,
  rect: HintRect,
  hitTest: ((x: number, y: number) => Element | null) | null,
): boolean {
  if (!hitTest) return true;
  const hit = hitTest(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!hit) return true;
  return element === hit || element.contains(hit);
}

const zIndexOf = (element: Element, win: Window): number => {
  let best = 0;
  for (let el: Element | null = element; el; el = el.parentElement) {
    const z = Number.parseInt(win.getComputedStyle(el).zIndex, 10);
    if (Number.isFinite(z) && z > best) best = z;
  }
  return best;
};

/** The top-most open modal layer (highest stacking z-index; later in the DOM wins ties), or null. */
export function findTopHintDialog(doc: Document, win: Window): Element | null {
  let top: Element | null = null;
  let topZ = -Infinity;
  for (const el of Array.from(doc.querySelectorAll(HINT_DIALOG_SELECTOR))) {
    if (el.closest('[data-hint-overlay]')) continue;
    const r = el.getBoundingClientRect();
    if (!hasHintArea(r) || isHintHiddenByStyle(el, win)) continue;
    const z = zIndexOf(el, win);
    if (z >= topZ) {
      top = el;
      topZ = z;
    }
  }
  return top;
}

const READING_ROW_PX = 8;

/**
 * Projects first (DOM = on-screen list order), then terminal tabs, then terminal
 * panes, then nav controls top→bottom, left→right.
 */
export function orderHintTargets(targets: readonly HintTarget[]): HintTarget[] {
  const rank: Record<HintKind, number> = { project: 0, tab: 1, terminal: 2, nav: 3 };
  return targets
    .map((target, index) => ({ target, index }))
    .sort((a, b) => {
      const kind = rank[a.target.kind] - rank[b.target.kind];
      if (kind !== 0) return kind;
      if (a.target.kind !== 'nav') return a.index - b.index;
      const rowA = Math.round(a.target.rect.top / READING_ROW_PX);
      const rowB = Math.round(b.target.rect.top / READING_ROW_PX);
      if (rowA !== rowB) return rowA - rowB;
      if (a.target.rect.left !== b.target.rect.left) return a.target.rect.left - b.target.rect.left;
      return a.index - b.index;
    })
    .map(({ target }) => target);
}

/** Every element that should get a hint right now, in label order. */
export function collectHintTargets(doc: Document = document, win: Window = window): HintTarget[] {
  const viewport = { width: win.innerWidth, height: win.innerHeight };
  const hitTest = typeof doc.elementFromPoint === 'function' ? (x: number, y: number) => doc.elementFromPoint(x, y) : null;
  const scope: ParentNode = findTopHintDialog(doc, win) ?? doc;
  const seen = new Set<Element>();
  const targets: HintTarget[] = [];
  for (const element of Array.from(scope.querySelectorAll<HTMLElement>(HINT_TARGET_SELECTOR))) {
    if (seen.has(element)) continue;
    seen.add(element);
    if (isHintExcluded(element) || isHintDisabled(element)) continue;
    const r = element.getBoundingClientRect();
    const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    if (!hasHintArea(rect) || !isRectInViewport(rect, viewport)) continue;
    if (isHintHiddenByStyle(element, win)) continue;
    if (!isHintReachable(element, rect, hitTest)) continue;
    targets.push({ element, kind: hintKindOf(element), rect });
  }
  return orderHintTargets(targets);
}

/** Corner badges straddle the target's top-left corner: CSS shifts them by this much up-left. */
export const HINT_CORNER_OFFSET_PX = 4;
/** Rough badge size for clamping (normal size, border + padding). */
const BADGE_CHAR_PX = 8;
const BADGE_EXTRA_PX = 10;
const BADGE_HEIGHT_PX = 20;

export type HintPlacement = 'corner' | 'bottom-left';

/**
 * Where a badge is anchored. Most targets: their top-left corner, the badge
 * straddling it (CSS shifts it -4px, -4px). Terminal panes: their bottom-left
 * corner near the prompt (CSS shifts the badge up, inside the pane), because a
 * pane's top-left corner is where its header / tab hint already sits. The anchor
 * is clamped so the shifted badge stays inside the viewport.
 */
export function hintAnchor(
  rect: HintRect,
  kind: HintKind,
  viewport: { width: number; height: number },
  labelLength = 1,
): { x: number; y: number; placement: HintPlacement } {
  const off = HINT_CORNER_OFFSET_PX;
  const badgeWidth = labelLength * BADGE_CHAR_PX + BADGE_EXTRA_PX;
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  if (kind === 'terminal') {
    return {
      x: clamp(rect.left, 0, viewport.width - badgeWidth - 2 * off),
      y: clamp(rect.top + rect.height, BADGE_HEIGHT_PX + 2 * off, viewport.height),
      placement: 'bottom-left',
    };
  }
  return {
    x: clamp(rect.left, off, viewport.width - badgeWidth + off),
    y: clamp(rect.top, off, viewport.height - BADGE_HEIGHT_PX + off),
    placement: 'corner',
  };
}

const isFocusableOther = (element: HTMLElement): boolean => {
  // A mouse click on a <button> does not focus it in WebKit; focusing it would only
  // take keys away from the terminal.
  if (element.tagName === 'BUTTON') return false;
  return element.tabIndex >= 0 || element.matches('a[href]');
};

/**
 * Click the element the way a mouse would, so React onMouseDown/onClick handlers
 * (including the project-row drag code, which sees a press and release on the
 * same spot and treats it as a click) run as usual.
 */
export function activateHintTarget(element: HTMLElement, kind: HintKind): void {
  if (!element.isConnected) return;
  const r = element.getBoundingClientRect();
  const clientX = r.left + r.width / 2;
  const clientY = r.top + r.height / 2;
  if (kind === 'nav' && isFocusableOther(element)) {
    try { element.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
    button: 0,
    detail: 1,
  };
  element.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
  element.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
  element.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
}
