// Hint mode: press the hint shortcut (keybinding `hints.toggle`), small labelled
// boxes appear on navigation targets, typing a label clicks that thing.
//   labels  → hintLabels.ts      typed keys → hintMatch.ts
//   targets → hintTargets.ts     badges     → HintOverlay.tsx
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { HintSize, HintStyle } from '../config/schema';
import { HintOverlay, type HintBadge } from './HintOverlay';
import { assignHintLabels } from './hintLabels';
import { hintKeyStep } from './hintMatch';
import { HINT_MODE_ATTR } from './hintModeFlag';
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

export function useHintMode(appearance: { style?: HintStyle; size?: HintSize } = {}): HintModeApi {
  const [session, setSession] = useState<HintSession | null>(null);
  const sessionRef = useRef<HintSession | null>(null);
  // Whatever had keyboard focus (usually a terminal) when hint mode opened.
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const update = (next: HintSession | null) => {
    sessionRef.current = next;
    setSession(next);
  };

  const close = useCallback(() => {
    if (!sessionRef.current) return;
    update(null);
    document.documentElement.removeAttribute(HINT_MODE_ATTR);
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    if (previous?.isConnected) {
      try { previous.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }, []);

  const open = useCallback(() => {
    if (sessionRef.current) return;
    const entries = buildHintEntries(
      collectHintTargets(document, window),
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (entries.length === 0) return;
    // Park keyboard focus so no input (an xterm textarea, an IME composition) sees
    // the typed label; it comes back on close.
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
      const result = hintKeyStep(current.entries.map((entry) => entry.label), current.typed, event);
      if (result.type === 'ignore') return;
      if (result.type === 'narrow') {
        update({ ...current, typed: result.buffer });
        return;
      }
      if (result.type === 'cancel') {
        close();
        return;
      }
      const entry = current.entries.find((candidate) => candidate.label === result.label);
      close();
      if (entry) activateHintTarget(entry.target.element, entry.target.kind);
    };
    const dismiss = () => close();
    const onScroll = (event: Event) => {
      // xterm scrolls its own viewport as output arrives; that does not move any hint.
      const target = event.target;
      if (target instanceof Element && target.closest('.xterm')) return;
      close();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', dismiss, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', dismiss, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [isActive, close]);

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
