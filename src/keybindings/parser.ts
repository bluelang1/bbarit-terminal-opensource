/**
 * Phase 4.1: Keybinding Parser
 *
 * Parses keybinding strings like "cmd+shift+p" into structured objects,
 * and matches them against KeyboardEvent instances.
 */

export interface KeyBinding {
  key: string;          // Lowercase key name (e.g., 'p', 'enter', 'arrowleft')
  meta: boolean;        // Cmd on Mac
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface KeyBindingEntry {
  id: string;           // Command ID (e.g., 'terminal.new')
  binding: KeyBinding;
  raw: string;          // Original string (e.g., 'cmd+t')
}

// Key aliases
const KEY_ALIASES: Record<string, string> = {
  'cmd': 'meta',
  'command': 'meta',
  'opt': 'alt',
  'option': 'alt',
  'esc': 'escape',
  'return': 'enter',
  'del': 'delete',
  'ins': 'insert',
  'space': ' ',
  'plus': '+',
  'minus': '-',
  'left': 'arrowleft',
  'right': 'arrowright',
  'up': 'arrowup',
  'down': 'arrowdown',
};

// KeyboardEvent.code fallback for non-Latin layouts (e.g. Korean IME)
// so Ctrl/Cmd shortcuts still resolve to physical keys.
const CODE_KEY_ALIASES: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
};

const codeToKey = (code?: string): string | null => {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return CODE_KEY_ALIASES[code] || null;
};

const isAsciiChar = (value: string) =>
  value.length === 1 && value.charCodeAt(0) <= 0x7f;

export function normalizeEventKeyForShortcut(event: Pick<KeyboardEvent, 'key' | 'code'>): string {
  const eventKey = (event.key || '').toLowerCase();
  const normalizedFromKey = KEY_ALIASES[eventKey] || eventKey;

  // Use event.key when it's already a stable ASCII shortcut character.
  if (isAsciiChar(normalizedFromKey)) return normalizedFromKey;

  // Fallback to physical key for IME/non-Latin layouts.
  const fromCode = codeToKey(event.code);
  if (fromCode) return fromCode;

  return normalizedFromKey;
}

/**
 * Parse a keybinding string like "cmd+shift+p" into a KeyBinding object.
 */
export function parseKeybinding(raw: string): KeyBinding {
  const parts = raw.toLowerCase().split('+').map(s => s.trim()).filter(Boolean);

  const binding: KeyBinding = {
    key: '',
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
  };

  for (const part of parts) {
    const alias = KEY_ALIASES[part] || part;
    switch (alias) {
      case 'meta': binding.meta = true; break;
      case 'ctrl': case 'control': binding.ctrl = true; break;
      case 'alt': binding.alt = true; break;
      case 'shift': binding.shift = true; break;
      default: binding.key = alias; break;
    }
  }

  return binding;
}

/**
 * Check if a KeyboardEvent matches a KeyBinding.
 */
export function matchesEvent(binding: KeyBinding, event: KeyboardEvent): boolean {
  if (binding.meta !== event.metaKey) return false;
  if (binding.ctrl !== event.ctrlKey) return false;
  if (binding.alt !== event.altKey) return false;
  if (binding.shift !== event.shiftKey) return false;

  const normalizedKey = normalizeEventKeyForShortcut(event);

  return normalizedKey === binding.key;
}

/**
 * Parse a list of keybinding definitions into KeyBindingEntry objects.
 */
export function parseKeybindings(
  defs: Array<{ id: string; keys: string }>
): KeyBindingEntry[] {
  return defs.map(def => ({
    id: def.id,
    binding: parseKeybinding(def.keys),
    raw: def.keys,
  }));
}

/**
 * Detect conflicts between keybinding entries.
 * Returns pairs of conflicting entries.
 */
export function detectConflicts(entries: KeyBindingEntry[]): Array<[KeyBindingEntry, KeyBindingEntry]> {
  const conflicts: Array<[KeyBindingEntry, KeyBindingEntry]> = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i].binding;
      const b = entries[j].binding;
      if (a.key === b.key && a.meta === b.meta && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift) {
        conflicts.push([entries[i], entries[j]]);
      }
    }
  }
  return conflicts;
}

/**
 * Format a KeyBinding back to a display string.
 */
export function formatKeybinding(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.meta) parts.push('⌘');
  if (binding.ctrl) parts.push('⌃');
  if (binding.alt) parts.push('⌥');
  if (binding.shift) parts.push('⇧');

  // Format the key nicely
  const keyDisplay = binding.key.length === 1
    ? binding.key.toUpperCase()
    : binding.key.charAt(0).toUpperCase() + binding.key.slice(1);

  parts.push(keyDisplay);
  return parts.join('');
}
