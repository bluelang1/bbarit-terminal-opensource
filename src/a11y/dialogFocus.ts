// Keyboard focus for small modal dialogs (the app's confirm dialog): move focus in
// when it opens, keep Tab inside, let Enter/Space act on the focused button, Esc
// cancels, and give focus back to whatever had it (often a terminal) on close.
import { useLayoutEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Keyboard-reachable elements inside `container`, in DOM order. */
export function focusableIn(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => !el.closest('[inert]') && !el.hidden);
}

/**
 * Where Tab (or Shift+Tab) should go inside the dialog: the next/previous focusable,
 * wrapping at the ends. Focus outside the list goes to the first (or last) one.
 */
export function nextTrapTarget(
  focusables: readonly HTMLElement[],
  current: Element | null,
  backwards: boolean,
): HTMLElement | null {
  if (focusables.length === 0) return null;
  const i = current ? focusables.indexOf(current as HTMLElement) : -1;
  if (i < 0) return backwards ? focusables[focusables.length - 1] : focusables[0];
  const n = focusables.length;
  return focusables[(i + (backwards ? n - 1 : 1)) % n];
}

/**
 * Give focus back on close, but only when the dialog's closing left focus nowhere
 * (body / null / still inside the dialog). If the confirmed action moved focus
 * somewhere itself, that wins.
 */
export function shouldRestoreFocus(
  previous: Element | null,
  current: Element | null,
  dialog: Element | null,
  doc: Document,
): previous is HTMLElement {
  if (!previous || !(previous as HTMLElement).isConnected) return false;
  if (typeof (previous as HTMLElement).focus !== 'function') return false;
  if (!current || current === doc.body || current === doc.documentElement) return true;
  return !!dialog && dialog.contains(current);
}

const focusQuietly = (el: HTMLElement | null) => {
  if (!el) return;
  try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
};

export interface DialogFocusOptions {
  /** The button that gets focus on open (Cancel for destructive dialogs). Enter with focus outside the dialog clicks it. */
  initialFocus: () => HTMLElement | null;
  onEscape: () => void;
}

/**
 * While `open`, owns the keyboard for the dialog in `dialogRef`:
 * - on open, remembers document.activeElement and focuses `initialFocus`;
 * - Enter on a focused control inside the dialog is left to the browser (a button
 *   activates itself); Enter with focus elsewhere clicks `initialFocus`;
 * - Escape calls `onEscape`; Tab / Shift+Tab cycle inside the dialog;
 * - on close, focus returns to the remembered element if it is still connected.
 * The listener runs on window in the capture phase and stops other window handlers.
 */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  open: boolean,
  { initialFocus, onEscape }: DialogFocusOptions,
): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;

  useLayoutEffect(() => {
    if (!open) return;
    const doc = document;
    const previous = doc.activeElement;
    const dialog = dialogRef.current;
    focusQuietly(initialFocusRef.current());

    const onKeyDown = (e: KeyboardEvent) => {
      const box = dialogRef.current;
      if (!box) return;
      // An Enter that commits an IME composition is not a dialog key.
      if (e.isComposing || e.keyCode === 229) return;
      const active = doc.activeElement;
      const inside = !!active && box.contains(active);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) onEscapeRef.current();
        return;
      }
      if (e.key === 'Enter') {
        e.stopImmediatePropagation();
        if (inside && active !== box) return; // native: the focused button activates itself
        e.preventDefault();
        if (!e.repeat) initialFocusRef.current()?.click();
        return;
      }
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        focusQuietly(nextTrapTarget(focusableIn(box), inside ? active : null, e.shiftKey));
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (shouldRestoreFocus(previous, doc.activeElement, dialog, doc)) focusQuietly(previous);
    };
    // Callbacks are read through refs; re-run only when the dialog opens or closes.
  }, [open]);
}
