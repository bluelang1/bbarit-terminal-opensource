// useDialogFocus on a real (jsdom) DOM: focus in, Enter/Esc, Tab trap, focus return.
import { act, render } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusableIn, nextTrapTarget, shouldRestoreFocus, useDialogFocus } from './dialogFocus';

const onConfirm = vi.fn();
const onCancel = vi.fn();
const api: { setOpen: (v: boolean) => void } = { setOpen: () => {} };

function Dialog({ danger }: { danger: boolean }) {
  const [open, setOpen] = useState(false);
  api.setOpen = setOpen;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const okRef = useRef<HTMLButtonElement | null>(null);
  const close = () => { onCancel(); setOpen(false); };
  useDialogFocus(boxRef, open, {
    initialFocus: () => (danger ? cancelRef.current : okRef.current),
    onEscape: close,
  });
  if (!open) return null;
  return (
    <div ref={boxRef} role="alertdialog" aria-modal="true">
      <button ref={cancelRef} id="cancel" onClick={close}>Cancel</button>
      <button ref={okRef} id="ok" onClick={() => { onConfirm(); setOpen(false); }}>OK</button>
    </div>
  );
}

const key = (k: string, init: KeyboardEventInit = {}) => {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(e); });
  return e;
};

let terminal: HTMLTextAreaElement;
const later = vi.fn();

beforeEach(() => {
  onConfirm.mockReset();
  onCancel.mockReset();
  later.mockReset();
  terminal = document.createElement('textarea');
  terminal.className = 'xterm-helper-textarea';
  document.body.appendChild(terminal);
  terminal.focus();
  // Another window keydown handler that must not see keys the dialog handled.
  window.addEventListener('keydown', later, false);
});
afterEach(() => {
  window.removeEventListener('keydown', later, false);
  terminal.remove();
});

describe('useDialogFocus', () => {
  it('focuses the confirm button on open for a normal dialog; Enter outside the dialog confirms', () => {
    render(<Dialog danger={false} />);
    act(() => api.setOpen(true));
    expect(document.activeElement?.id).toBe('ok');
    // Focus got pulled out somehow (e.g. a terminal refocusing itself): Enter still acts on the default button.
    terminal.focus();
    const e = key('Enter');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
  });

  it('focuses Cancel on open for a destructive dialog; Enter outside the dialog cancels', () => {
    render(<Dialog danger />);
    act(() => api.setOpen(true));
    expect(document.activeElement?.id).toBe('cancel');
    terminal.focus();
    key('Enter');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('leaves Enter on a focused dialog button to the browser and stops other window handlers', () => {
    render(<Dialog danger={false} />);
    act(() => api.setOpen(true));
    key('Tab', { shiftKey: true });
    expect(document.activeElement?.id).toBe('cancel');
    const e = key('Enter');
    // Not prevented: the browser's own button activation clicks Cancel. The hook never confirms.
    expect(e.defaultPrevented).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
  });

  it('Escape cancels', () => {
    render(<Dialog danger={false} />);
    act(() => api.setOpen(true));
    const e = key('Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps Tab and Shift+Tab inside the dialog', () => {
    render(<Dialog danger />);
    act(() => api.setOpen(true));
    expect(document.activeElement?.id).toBe('cancel');
    key('Tab');
    expect(document.activeElement?.id).toBe('ok');
    key('Tab');
    expect(document.activeElement?.id).toBe('cancel');
    key('Tab', { shiftKey: true });
    expect(document.activeElement?.id).toBe('ok');
    // Ctrl+Tab is someone else's shortcut.
    const e = key('Tab', { ctrlKey: true });
    expect(e.defaultPrevented).toBe(false);
  });

  it('returns focus to the element that had it before opening', () => {
    render(<Dialog danger />);
    act(() => api.setOpen(true));
    expect(document.activeElement).not.toBe(terminal);
    key('Escape');
    expect(document.activeElement).toBe(terminal);
  });

  it('does not return focus to an element that left the document', () => {
    render(<Dialog danger />);
    act(() => api.setOpen(true));
    terminal.remove();
    key('Escape');
    expect(document.activeElement).toBe(document.body);
  });

  it('removes its key handler once closed', () => {
    render(<Dialog danger={false} />);
    act(() => api.setOpen(true));
    key('Escape');
    terminal.focus();
    key('Enter');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe('dialogFocus helpers', () => {
  it('nextTrapTarget wraps both ways and enters from outside', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((id) => Object.assign(document.createElement('button'), { id }));
    const list = [a, b, c];
    expect(nextTrapTarget(list, a, false)).toBe(b);
    expect(nextTrapTarget(list, c, false)).toBe(a);
    expect(nextTrapTarget(list, a, true)).toBe(c);
    expect(nextTrapTarget(list, null, false)).toBe(a);
    expect(nextTrapTarget(list, document.body, true)).toBe(c);
    expect(nextTrapTarget([], a, false)).toBeNull();
  });

  it('focusableIn skips disabled and inert controls', () => {
    const box = document.createElement('div');
    box.innerHTML = '<button id="x"></button><button id="d" disabled></button><div inert><button id="i"></button></div><span tabindex="0" id="s"></span><span tabindex="-1"></span>';
    expect(focusableIn(box).map((el) => el.id)).toEqual(['x', 's']);
  });

  it('shouldRestoreFocus only when focus was left nowhere or inside the dialog', () => {
    const prev = document.createElement('textarea');
    const dialog = document.createElement('div');
    const inner = document.createElement('button');
    const other = document.createElement('input');
    dialog.appendChild(inner);
    document.body.append(prev, dialog, other);
    expect(shouldRestoreFocus(prev, document.body, dialog, document)).toBe(true);
    expect(shouldRestoreFocus(prev, null, dialog, document)).toBe(true);
    expect(shouldRestoreFocus(prev, inner, dialog, document)).toBe(true);
    expect(shouldRestoreFocus(prev, other, dialog, document)).toBe(false);
    prev.remove();
    expect(shouldRestoreFocus(prev, document.body, dialog, document)).toBe(false);
    dialog.remove();
    other.remove();
  });
});
