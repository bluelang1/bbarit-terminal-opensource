// Keyboard key / shortcut parsing for the browser agent (ported from browser-use's
// send_keys action). Distinct from typing text: this presses special keys — Enter to
// submit, Escape to close a dialog, Tab to move focus, Ctrl+A to select all, arrows.
//
// The PARSING (combo string -> key + modifiers + a dispatchable KeyboardEvent init)
// is pure and tested here; dispatching is a thin in-page eval.
//
// D1: Accept human spellings ("ctrl", "cmd", "esc", "enter") and normalize to the
//     DOM KeyboardEvent `key` + modifier flags. Unknown single chars pass through as
//     the literal key. Reason: the agent/user shouldn't need exact DOM key names.

export interface KeyCombo {
  key: string;                 // DOM KeyboardEvent.key
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  valid: boolean;
}

// Named key aliases → DOM key value.
const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab',
  space: ' ', spacebar: ' ', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  esc_: 'Escape',
};

const MODIFIERS: Record<string, keyof Pick<KeyCombo, 'ctrl' | 'shift' | 'alt' | 'meta'>> = {
  ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl',
  shift: 'shift',
  alt: 'alt', option: 'alt',
  cmd: 'meta', command: 'meta', meta: 'meta', win: 'meta', super: 'meta',
};

export function parseKeyCombo(spec: string): KeyCombo {
  const combo: KeyCombo = { key: '', ctrl: false, shift: false, alt: false, meta: false, valid: false };
  const raw = String(spec || '').trim();
  if (!raw) return combo;
  // Split on + or - (but keep a trailing literal "+"/"-" as the key).
  const parts = raw.split(/[+\-]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return combo;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const low = p.toLowerCase();
    const isLast = i === parts.length - 1;
    if (!isLast && MODIFIERS[low]) { combo[MODIFIERS[low]] = true; continue; }
    // The last token (or a non-modifier) is the key.
    if (MODIFIERS[low] && isLast) { combo[MODIFIERS[low]] = true; continue; } // e.g. just "ctrl" alone
    combo.key = KEY_ALIASES[low] || (p.length === 1 ? p : p.charAt(0).toUpperCase() + p.slice(1));
  }
  combo.valid = !!combo.key;
  return combo;
}

// Build the JS expression that dispatches this key on the focused element (or body).
export function keyDispatchJs(combo: KeyCombo): string {
  const init = {
    key: combo.key,
    ctrlKey: combo.ctrl,
    shiftKey: combo.shift,
    altKey: combo.alt,
    metaKey: combo.meta,
    bubbles: true,
    cancelable: true,
  };
  const initStr = JSON.stringify(init);
  return `(() => { const el = document.activeElement || document.body; ['keydown','keyup'].forEach(t => el.dispatchEvent(new KeyboardEvent(t, ${initStr}))); return 'pressed ${describeCombo(combo).replace(/'/g, '')}'; })()`;
}

export function describeCombo(combo: KeyCombo): string {
  const mods = [combo.ctrl && 'Ctrl', combo.shift && 'Shift', combo.alt && 'Alt', combo.meta && 'Meta'].filter(Boolean);
  return [...mods, combo.key === ' ' ? 'Space' : combo.key].join('+');
}
