// Typed-key state machine for hint mode. Keys are read from `event.code`
// (Digit1, KeyA, …) so it works while a Korean IME is on and `event.key` is Hangul.

export interface HintKeyEventLike {
  code: string;
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

export type HintKeyResult =
  /** Keep hint mode open; show only labels starting with `buffer`. */
  | { type: 'narrow'; buffer: string }
  /** `label` was typed in full: close and activate its target. */
  | { type: 'activate'; label: string }
  /** Close without doing anything. */
  | { type: 'cancel' }
  /** Swallow the key and change nothing (modifier-only, IME composition). */
  | { type: 'ignore' };

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'AltGraph']);
const MODIFIER_CODE = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)(Left|Right|Lock)?$/;

export function isModifierOnlyKey(event: Pick<HintKeyEventLike, 'code' | 'key'>): boolean {
  return MODIFIER_KEYS.has(event.key) || MODIFIER_CODE.test(event.code);
}

/** The hint character for a physical key, lower case, or null when the key is not one. */
export function hintCharFromCode(code: string): string | null {
  let m = /^Digit([0-9])$/.exec(code) || /^Numpad([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  return null;
}

/**
 * One key press in hint mode. Labels are lower case and prefix-free (hintLabels.ts).
 * - Escape, any Ctrl/Cmd/Alt chord (including the hint shortcut itself) and keys that
 *   match no label cancel.
 * - Backspace removes the last typed character (ignored when nothing is typed).
 * - Modifier-only keys and keys reported mid IME composition are ignored.
 */
export function hintKeyStep(labels: readonly string[], buffer: string, event: HintKeyEventLike): HintKeyResult {
  if (isModifierOnlyKey(event)) return { type: 'ignore' };
  if (event.key === 'Escape' || event.code === 'Escape') return { type: 'cancel' };
  if (event.ctrlKey || event.metaKey || event.altKey) return { type: 'cancel' };
  if (event.key === 'Backspace' || event.code === 'Backspace') {
    return buffer ? { type: 'narrow', buffer: buffer.slice(0, -1) } : { type: 'ignore' };
  }
  if (event.isComposing) return { type: 'ignore' };

  const ch = hintCharFromCode(event.code);
  if (!ch) return { type: 'cancel' };
  const next = buffer + ch;
  if (labels.includes(next)) return { type: 'activate', label: next };
  if (labels.some((label) => label.startsWith(next))) return { type: 'narrow', buffer: next };
  return { type: 'cancel' };
}
