/**
 * Shared remote mirroring logic for Telegram and Discord.
 *
 * Extracted from telegramMirror.ts to avoid code duplication.
 */

import type { Terminal } from 'xterm';
import type { TerminalState } from './terminalStates';

// Lazy import to break circular dependency
let _getStates: () => Map<string, TerminalState>;
export const setTerminalStatesGetter = (getter: () => Map<string, TerminalState>) => {
  _getStates = getter;
};
const getStates = (): Map<string, TerminalState> => {
  if (typeof _getStates !== 'function') return new Map();
  return _getStates();
};

// Screen-snapshot mirroring timings (ms)
const SCREEN_IDLE_FLUSH_MS = 1500;
const SCREEN_MAX_WAIT_MS = 5000;

// ── Shared utilities ──

export const filterMirrorNoise = (text: string) => {
  const lines = String(text || '').split('\n');
  const kept: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t === '(thinking)') continue;
    if (!t) {
      blankRun++;
      if (blankRun > 1) continue;
      kept.push('');
      continue;
    }
    blankRun = 0;
    kept.push(line);
  }
  return kept.join('\n');
};

export const redactSecrets = (text: string) => {
  let out = text || '';
  const keys = [
    'OPENAI_API_KEY',
    'CONTEXT7_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_TOKEN',
    'TELEGRAM_CHAT_ID',
    'DISCORD_BOT_TOKEN',
    'DISCORD_TOKEN',
  ];
  for (const k of keys) {
    const re = new RegExp(`(${k}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s]+)`, 'gi');
    out = out.replace(re, `$1***`);
  }
  out = out.replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***');
  return out;
};

export const readTerminalScreen = (term: Terminal): string => {
  const buf = term.buffer.active;
  const baseY = buf.baseY;
  const lines: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(baseY + i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines.join('\n');
};

// ── Platform config ──

export interface RemotePlatformConfig {
  maxChunkSize: number;        // Telegram: 3900, Discord: 1950
  sendFn: (text: string, channelId?: string) => void;
  stateKey: 'telegram' | 'discord' | 'slack';
}

// Platform-specific state accessors
type PlatformState = {
  enabled: boolean;
  mirrorCommands: boolean;
  mirrorOutput: boolean;
  label?: string;
  chatId?: string;     // telegram
  channelId?: string;  // discord
};

type PlatformKey = 'telegram' | 'discord' | 'slack';

function getPlatformState(st: TerminalState, key: PlatformKey): PlatformState | undefined {
  return st[key] as PlatformState | undefined;
}

function getPlatformChannel(ps: PlatformState): string | undefined {
  return ps.chatId || ps.channelId;
}

// State field helpers — generic across platforms
type ScreenStateFields = {
  snapshot: string | undefined;
  timer: number | null | undefined;
  dirty: boolean | undefined;
  firstDirtyAt: number | null | undefined;
  lastSent: string | undefined;
  cmdBuffer: string | undefined;
};

function getScreenState(st: TerminalState, key: PlatformKey): ScreenStateFields {
  if (key === 'telegram') {
    return {
      snapshot: st.telegramScreenSnapshot,
      timer: st.telegramScreenTimer,
      dirty: st.telegramScreenDirty,
      firstDirtyAt: st.telegramScreenFirstDirtyAt,
      lastSent: st.telegramLastSent,
      cmdBuffer: st.telegramCmdBuffer,
    };
  }
  if (key === 'slack') {
    return {
      snapshot: st.slackScreenSnapshot,
      timer: st.slackScreenTimer,
      dirty: st.slackScreenDirty,
      firstDirtyAt: st.slackScreenFirstDirtyAt,
      lastSent: st.slackLastSent,
      cmdBuffer: st.slackCmdBuffer,
    };
  }
  return {
    snapshot: st.discordScreenSnapshot,
    timer: st.discordScreenTimer,
    dirty: st.discordScreenDirty,
    firstDirtyAt: st.discordScreenFirstDirtyAt,
    lastSent: st.discordLastSent,
    cmdBuffer: st.discordCmdBuffer,
  };
}

function setScreenSnapshot(st: TerminalState, key: PlatformKey, val: string) {
  if (key === 'telegram') st.telegramScreenSnapshot = val;
  else if (key === 'slack') st.slackScreenSnapshot = val;
  else st.discordScreenSnapshot = val;
}

function setScreenTimer(st: TerminalState, key: PlatformKey, val: number | null) {
  if (key === 'telegram') st.telegramScreenTimer = val;
  else if (key === 'slack') st.slackScreenTimer = val;
  else st.discordScreenTimer = val;
}

function setScreenDirty(st: TerminalState, key: PlatformKey, val: boolean) {
  if (key === 'telegram') st.telegramScreenDirty = val;
  else if (key === 'slack') st.slackScreenDirty = val;
  else st.discordScreenDirty = val;
}

function setScreenFirstDirtyAt(st: TerminalState, key: PlatformKey, val: number | null) {
  if (key === 'telegram') st.telegramScreenFirstDirtyAt = val;
  else if (key === 'slack') st.slackScreenFirstDirtyAt = val;
  else st.discordScreenFirstDirtyAt = val;
}

function setLastSent(st: TerminalState, key: PlatformKey, val: string) {
  if (key === 'telegram') st.telegramLastSent = val;
  else if (key === 'slack') st.slackLastSent = val;
  else st.discordLastSent = val;
}

function setCmdBuffer(st: TerminalState, key: PlatformKey, val: string) {
  if (key === 'telegram') st.telegramCmdBuffer = val;
  else if (key === 'slack') st.slackCmdBuffer = val;
  else st.discordCmdBuffer = val;
}

// ── Screen-snapshot flush ──

export const flushRemoteScreen = (terminalId: string, config: RemotePlatformConfig) => {
  const st = getStates().get(terminalId);
  if (!st || !st.term) return;

  const { stateKey, maxChunkSize, sendFn } = config;
  setScreenTimer(st, stateKey, null);
  setScreenFirstDirtyAt(st, stateKey, null);
  setScreenDirty(st, stateKey, false);

  const currentScreen = readTerminalScreen(st.term!);
  const cleaned = filterMirrorNoise(currentScreen);
  const trimmed = cleaned.replace(/\n{3,}/g, '\n\n').trimEnd();

  const ss = getScreenState(st, stateKey);
  if (!trimmed || trimmed === ss.snapshot) return;

  const prev = ss.snapshot || '';
  setScreenSnapshot(st, stateKey, trimmed);

  const prevLines = prev.split('\n');
  const currLines = trimmed.split('\n');

  let diffStart = 0;
  while (diffStart < prevLines.length && diffStart < currLines.length && prevLines[diffStart] === currLines[diffStart]) {
    diffStart++;
  }

  if (diffStart >= currLines.length) return;

  const newLines = currLines.slice(diffStart);
  const newText = newLines.join('\n').trim();
  if (!newText) return;

  let payload: string;
  if (diffStart < 3 || newLines.length > currLines.length * 0.7) {
    payload = trimmed;
  } else {
    payload = newText;
  }

  if (!payload.trim()) return;

  const ps = getPlatformState(st, stateKey);
  const label = ps?.label ? `[${ps.label}] ` : '';
  const channel = ps ? getPlatformChannel(ps) : undefined;
  const maxChunk = maxChunkSize - label.length;

  if (payload.length > maxChunk) {
    const bottomPayload = '...\n' + payload.slice(-maxChunk + 4);
    const topPayload = payload.slice(0, maxChunk);

    const bottomMsg = label + bottomPayload;
    if (ss.lastSent !== bottomMsg) {
      setLastSent(st, stateKey, bottomMsg);
      sendFn(bottomMsg, channel);
    }
    if (topPayload.trim() && topPayload.trim() !== bottomPayload.trim()) {
      sendFn(label + topPayload + '\n...', channel);
    }
  } else {
    const msg = label + payload;
    if (ss.lastSent === msg) return;
    setLastSent(st, stateKey, msg);
    sendFn(msg, channel);
  }
};

// ── Enqueue output (debounced screen snapshot) ──

export const enqueueRemoteOutput = (terminalId: string, _chunk: string, config: RemotePlatformConfig) => {
  void _chunk;
  const state = getStates().get(terminalId);
  if (!state?.term) return;

  const ps = getPlatformState(state, config.stateKey);
  if (!ps?.enabled || !ps.mirrorOutput) return;

  const ss = getScreenState(state, config.stateKey);
  setScreenDirty(state, config.stateKey, true);
  const now = Date.now();
  if (!ss.firstDirtyAt) setScreenFirstDirtyAt(state, config.stateKey, now);

  if (ss.timer) {
    clearTimeout(ss.timer);
    setScreenTimer(state, config.stateKey, null);
  }

  const firstDirty = getScreenState(state, config.stateKey).firstDirtyAt || now;
  const elapsed = now - firstDirty;
  if (elapsed >= SCREEN_MAX_WAIT_MS) {
    flushRemoteScreen(terminalId, config);
    return;
  }

  const remaining = Math.max(0, SCREEN_MAX_WAIT_MS - elapsed);
  const waitMs = Math.min(SCREEN_IDLE_FLUSH_MS, remaining);
  setScreenTimer(state, config.stateKey, window.setTimeout(() => flushRemoteScreen(terminalId, config), waitMs));
};

// ── Enqueue command from keystrokes ──

export const enqueueRemoteCommandFromKeystrokes = (terminalId: string, data: string, config: RemotePlatformConfig) => {
  const state = getStates().get(terminalId);
  if (!state) return;

  const ps = getPlatformState(state, config.stateKey);
  if (!ps?.enabled || !ps.mirrorCommands) return;

  const label = ps?.label ? `[${ps.label}] ` : '';
  const ss = getScreenState(state, config.stateKey);
  let buf = ss.cmdBuffer || '';

  const flush = () => {
    const cmd = (buf || '').trim();
    buf = '';
    setCmdBuffer(state, config.stateKey, '');
    if (!cmd) return;
    config.sendFn(`${label}$ ${redactSecrets(cmd)}`, ps ? getPlatformChannel(ps) : undefined);
  };

  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\r' || ch === '\n') {
      flush();
      continue;
    }
    if (ch === '\u007f' || ch === '\b') {
      buf = buf.slice(0, Math.max(0, buf.length - 1));
      continue;
    }
    if (ch === '\x1b') continue;
    const code = ch.charCodeAt(0);
    if (code < 0x20) continue;
    buf += ch;
    if (buf.length > 4000) buf = buf.slice(-4000);
  }

  setCmdBuffer(state, config.stateKey, buf);
};
