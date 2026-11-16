// Which key submits Claude Code's prompt. Claude Code lets users rebind keys in
// keybindings.json ("Chat" context); with `"enter": "chat:newline"` a plain CR only adds a
// newline, so automatic input (relay briefs, agent send, notes, ctl writes) would sit in the
// input box. The Rust command `claude_chat_keybindings` returns only the Chat bindings; this
// module picks the bytes the app can send for chat:submit and caches the pick.
// Shift+Enter and Cmd+Enter use the same kitty CSI-u bytes the terminal sends for a person's
// key press (ENTER_BYTES in src/XTerminal.tsx; neither is gated by the csiUKeys setting).
import type { AgentTabState } from './programStatus';

export type ChatBindings = Record<string, string | null | undefined>;
/** What `claude_chat_keybindings` returns: only the Chat and Autocomplete contexts. */
export interface ClaudeKeybindings { chat?: ChatBindings; autocomplete?: ChatBindings }

/** Bytes for one submit and how many presses (2 when the first only closes autocomplete). */
export interface SubmitSpec { key: string; presses?: number }

export const CLAUDE_SUBMIT_BYTES = { enter: '\r', 'shift+enter': '\x1b[13;2u', 'cmd+enter': '\x1b[13;9u' } as const;
export type ClaudeSubmitVia = keyof typeof CLAUDE_SUBMIT_BYTES;

export interface ClaudeSubmitPick {
  key: string;
  via: ClaudeSubmitVia;
  /**
   * The submit key is bound to autocomplete:dismiss in the Autocomplete context: when the text
   * opens the menu (slash command, @mention) the first press only closes it.
   */
  dismissesAutocomplete?: boolean;
  /** Set when Enter no longer submits and no submit key the app can encode is bound. */
  reason?: string;
}

const MODIFIER_ALIASES: Record<string, string> = {
  command: 'cmd', meta: 'cmd', super: 'cmd', win: 'cmd',
  control: 'ctrl', option: 'alt', opt: 'alt',
};
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'cmd'];

/** `Meta+Return` → `cmd+enter`; modifiers in a fixed order. */
export function normalizeKeyName(raw: string): string {
  const parts = String(raw || '').toLowerCase().split('+').map((p) => p.trim()).filter(Boolean)
    .map((p) => MODIFIER_ALIASES[p] || (p === 'return' ? 'enter' : p));
  const mods = parts.filter((p) => MODIFIER_ORDER.includes(p)).sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  const rest = parts.filter((p) => !MODIFIER_ORDER.includes(p));
  return [...new Set(mods), ...rest].join('+');
}

function bindingMap(bindings: ChatBindings | null | undefined): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const [k, v] of Object.entries(bindings || {})) {
    if (v === undefined) continue;
    map.set(normalizeKeyName(k), typeof v === 'string' ? v : null);
  }
  return map;
}

export function pickClaudeSubmitKey(bindings: ChatBindings | null | undefined, autocomplete?: ChatBindings | null): ClaudeSubmitPick {
  const map = bindingMap(bindings);
  const ac = bindingMap(autocomplete);
  const withMenu = (pick: ClaudeSubmitPick): ClaudeSubmitPick => (
    ac.get(pick.via) === 'autocomplete:dismiss' ? { ...pick, dismissesAutocomplete: true } : pick
  );
  const enter = map.get('enter');
  if (enter === undefined || enter === 'chat:submit') return withMenu({ key: CLAUDE_SUBMIT_BYTES.enter, via: 'enter' });
  for (const via of ['shift+enter', 'cmd+enter'] as const) {
    if (map.get(via) === 'chat:submit') return withMenu({ key: CLAUDE_SUBMIT_BYTES[via], via });
  }
  return {
    key: CLAUDE_SUBMIT_BYTES.enter,
    via: 'enter',
    reason: `Claude submit key is not Enter and cannot be sent (Enter is ${enter === null ? 'unbound' : enter}; bind shift+enter or cmd+enter to chat:submit in Claude Code's keybindings.json)`,
  };
}

/** Text that leaves Claude Code's autocomplete menu open: a slash command or a trailing @mention. */
export function opensAutocomplete(text: string): boolean {
  const t = String(text || '');
  if (/^\s*\//.test(t)) return true;
  const tokens = t.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens[tokens.length - 1].startsWith('@');
}

/** Submit spec for this pick and text: twice when the first press only closes the menu. */
export function submitSpecFor(pick: ClaudeSubmitPick, text: string): SubmitSpec {
  return pick.dismissesAutocomplete && opensAutocomplete(text) ? { key: pick.key, presses: 2 } : { key: pick.key, presses: 1 };
}

// ── cache ──────────────────────────────────────────────────────────────────
const DEFAULT_PICK: ClaudeSubmitPick = { key: CLAUDE_SUBMIT_BYTES.enter, via: 'enter' };
export const REFRESH_MIN_INTERVAL_MS = 2000;
let current: ClaudeSubmitPick = DEFAULT_PICK;
let lastLoadAt = Number.NEGATIVE_INFINITY;
let inflight: Promise<void> | null = null;

export function claudeSubmitKey(): ClaudeSubmitPick {
  return current;
}

export function resetClaudeSubmitKey(): void {
  current = DEFAULT_PICK;
  lastLoadAt = Number.NEGATIVE_INFINITY;
  inflight = null;
}

/**
 * Reload the bindings (startup, window focus, before a relay run). A failed load keeps the
 * last pick; calls within REFRESH_MIN_INTERVAL_MS share one load unless forced.
 */
export function refreshClaudeSubmitKey(
  load: () => Promise<ClaudeKeybindings | null | undefined>,
  opts: { force?: boolean; now?: number } = {},
): Promise<void> {
  const now = opts.now ?? Date.now();
  if (inflight) return inflight;
  if (!opts.force && now - lastLoadAt < REFRESH_MIN_INTERVAL_MS) return Promise.resolve();
  lastLoadAt = now;
  inflight = load()
    .then((b) => { current = pickClaudeSubmitKey(b?.chat, b?.autocomplete); })
    .catch(() => { /* keep the last pick */ })
    .finally(() => { inflight = null; });
  return inflight;
}

/** The configured Claude submit for this text (the relay brief uses it before any 7501 report). */
export function claudeSubmitSpec(text = ''): SubmitSpec {
  return submitSpecFor(current, text);
}

/**
 * What presses "submit" in this terminal. Only a Claude tab where Claude Code is running now
 * (`agentRunning`: an OSC 7501 record is held — see agentProgramRunning; Claude clears it on
 * exit) uses the configured key. A tab where Claude exited or has not started is a zsh prompt
 * and gets CR, and so does a permission/question dialog (blocked: not the Chat context).
 */
export function submitKeyForTerminal(t: { cliType?: string; state?: AgentTabState; agentRunning?: boolean; text?: string }): SubmitSpec {
  if (t.cliType !== 'claude' || !t.agentRunning || t.state === 'blocked') return { key: CLAUDE_SUBMIT_BYTES.enter, presses: 1 };
  return claudeSubmitSpec(t.text || '');
}
