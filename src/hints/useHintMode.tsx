// Hint mode: press the hint shortcut (keybinding `hints.toggle`), small labelled
// boxes appear on navigation targets, typing a label clicks that thing.
//   labels  → hintLabels.ts      typed keys → hintMatch.ts
//   targets → hintTargets.ts     badges     → HintOverlay.tsx
//   a pick that opens a menu → menuKeyboard.ts
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { HintSize, HintStyle } from '../config/schema';
import { HintOverlay, type HintBadge } from './HintOverlay';
import { assignHintLabels } from './hintLabels';
import { hintKeyStep } from './hintMatch';
import { HINT_MODE_ATTR } from './hintModeFlag';
import { focusMenu, openedMenuOf } from './menuKeyboard';
import {
  activateHintTarget,
  collectHintTargets,
  hintAnchor,
  hintDataKind,
  type HintTarget,
} from './hintTargets';

interface HintEntry {
  label: string;
  target: HintTarget;
  badge: HintBadge;
}

interface HintSession {
  entries: HintEntry[];
  typed: string;
}

export interface HintModeApi {
  active: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Mount once; renders nothing while hint mode is off. */
  overlay: ReactNode;
}

export function buildHintEntries(
  targets: readonly HintTarget[],
  viewport: { width: number; height: number },
): HintEntry[] {
  const labels = assignHintLabels(targets.length);
  return labels.map((label, index) => {
    const target = targets[index];
    const anchor = hintAnchor(target.rect, target.kind, viewport, label.length);
    return {
      label,
      target,
      badge: { label, x: anchor.x, y: anchor.y, placement: anchor.placement, dataKind: hintDataKind(target) },
    };
  });
}

/** How long a key that closed hint mode stays swallowed if its keyup never arrives. */
const KEY_RELEASE_GUARD_MS = 1500;

/**
 * After a key closes hint mode, keep its auto-repeat keydowns and its keyup from
 * reaching the terminal (a held label key would otherwise type into the PTY).
 */
function swallowUntilKeyUp(code: string): void {
  if (!code) return;
  let timer = 0;
  const stop = () => {
    window.clearTimeout(timer);
    window.removeEventListener('keydown', onDown, true);
    window.removeEventListener('keyup', onUp, true);
  };
  const swallow = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  const onDown = (event: KeyboardEvent) => {
    if (event.code !== code) return;
    if (event.repeat) swallow(event);
    else stop();
  };
  const onUp = (event: KeyboardEvent) => {
    if (event.code !== code) return;
    swallow(event);
    stop();
  };
  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  timer = window.setTimeout(stop, KEY_RELEASE_GUARD_MS);
}

export function useHintMode(appearance: { style?: HintStyle; size?: HintSize } = {}): HintModeApi {
  const [session, setSession] = useState<HintSession | null>(null);
  const sessionRef = useRef<HintSession | null>(null);
  // Whatever had keyboard focus (usually a terminal) when hint mode opened.
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const update = (next: HintSession | null) => {
    sessionRef.current = next;
    setSession(next);
  };

  /**
   * Leave hint mode. Returns the element that had focus before it opened. Focus is
   * given back only when `restoreFocus` is set (cancel paths); after a pick the
   * picked target decides where focus goes.
   */
  const shut = useCallback((restoreFocus: boolean): HTMLElement | null => {
    if (!sessionRef.current) return null;
    update(null);
    document.documentElement.removeAttribute(HINT_MODE_ATTR);
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    if (restoreFocus && previous?.isConnected) {
      try { previous.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    return previous;
  }, []);

  /** Cancel: close and give focus back to what had it (usually the terminal). */
  const close = useCallback(() => { shut(true); }, [shut]);

  const open = useCallback(() => {
    if (sessionRef.current) return;
    const entries = buildHintEntries(
      collectHintTargets(document, window),
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (entries.length === 0) return;
    // Park keyboard focus so no input (an xterm textarea, an IME composition) sees
    // the typed label.
    const active = document.activeElement;
    previousFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    try { previousFocusRef.current?.blur(); } catch { /* ignore */ }
    document.documentElement.setAttribute(HINT_MODE_ATTR, '');
    update({ entries, typed: '' });
  }, []);

  const toggle = useCallback(() => {
    if (sessionRef.current) close();
    else open();
  }, [close, open]);

  const isActive = session !== null;
  useEffect(() => {
    if (!isActive) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      const current = sessionRef.current;
      if (!current) return;
      // Nothing else (terminal, other shortcuts) may see keys while hints are up.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      const result = hintKeyStep(current.entries.map((entry) => entry.label), current.typed, event);
      if (result.type === 'ignore') return;
      if (result.type === 'narrow') {
        update({ ...current, typed: result.buffer });
        return;
      }
      swallowUntilKeyUp(event.code);
      if (result.type === 'cancel') {
        close();
        return;
      }
      const entry = current.entries.find((candidate) => candidate.label === result.label);
      const previous = shut(false);
      if (!entry) return;
      const { element, kind } = entry.target;
      activateHintTarget(element, kind);
      // A pick that opened a menu (menuKeyboard.ts) moves focus into it, so arrows
      // and Enter work; closing the menu gives focus back to `previous`. A panel/view
      // toggle does not take focus: hand it back to the terminal on the next frame
      // unless the click moved focus somewhere itself. Project, tab and pane picks
      // leave focus to the terminal they activate.
      if (kind === 'nav' || kind === 'tool') {
        window.requestAnimationFrame(() => {
          const menu = openedMenuOf(element);
          if (menu && focusMenu(menu, previous)) return;
          if (!previous) return;
          const now = document.activeElement;
          if ((!now || now === document.body) && previous.isConnected) {
            try { previous.focus({ preventScroll: true }); } catch { /* ignore */ }
          }
        });
      }
    };
    const dismiss = () => close();

    // Positions are computed once, so only things that move the layout close hint
    // mode: a mouse press, a user wheel/touch scroll, a resize or leaving the window.
    // Programmatic scrolls (auto-scrolling panels, terminal output) are ignored.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', dismiss, true);
    window.addEventListener('wheel', dismiss, { capture: true, passive: true });
    window.addEventListener('touchmove', dismiss, { capture: true, passive: true });
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', dismiss, true);
      window.removeEventListener('wheel', dismiss, true);
      window.removeEventListener('touchmove', dismiss, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [isActive, close, shut]);

  useEffect(() => () => {
    document.documentElement.removeAttribute(HINT_MODE_ATTR);
  }, []);

  const overlay = session
    ? (
      <HintOverlay
        badges={session.entries.map((entry) => entry.badge)}
        typed={session.typed}
        hintStyle={appearance.style}
        hintSize={appearance.size}
      />
    )
    : null;

  return { active: isActive, open, close, toggle, overlay };
}
