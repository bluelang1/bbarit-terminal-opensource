import React, { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { advanceImeAnchor, shouldResyncImeAnchor } from './terminal/imeAnchor';
import { routeKeyDuringComposition } from './terminal/imeEscape';
import { applyWheelToScrollPin } from './terminal/scrollPin';
import { preserveTerminalViewport, writeXterm, shouldTrustScrollForPin, captureHiddenPin, restorePinAfterReveal, type HiddenPinSnapshot } from './terminal/scrollKeeper';
import {
  readImage as clipboardReadImage,
  readText as clipboardReadText,
  writeText as clipboardWriteText,
} from '@tauri-apps/plugin-clipboard-manager';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
// 주의: 코어가 구형 'xterm'(5.3)이므로 애드온도 구형 'xterm-addon-webgl'(0.16)이어야 한다.
// 신형 @xterm/addon-webgl(0.19)은 구형 코어 내부 API 부재로 TypeError → DOM 렌더러 폴백(2026-07 실측).
import { WebglAddon } from 'xterm-addon-webgl';
import { SearchAddon, type ISearchResultChangeEvent } from '@xterm/addon-search';
import { createTerminalLinkProvider } from './terminal/terminalLinks';
import { decodeOsc52Payload } from './terminal/osc52';
import { probeRestoredPty } from './terminal/restoredPty';
import { shouldNotifyReady } from './terminal/readyNotify';
import { shouldContinueClaudeSession } from './terminal/claudeSessionDir';
import { looksLikeAgentUiReady, looksLikePlainShellPrompt, stripTerminalControls, stripInjectedEcho } from './terminal/agentReadiness';
import { normalizeCliFlagLines, shellQuoteArg } from './terminal/cliCommandArgs';
import { htmlClipboardToText } from './terminal/htmlClipboard';
import { attachWindowFocusRestore } from './terminal/windowFocusRestore';
import { detectCliLaunchFailure, buildCliInstallGuide, type CliLaunchFailureKind, type CliInstallGuide } from './terminal/cliInstallGuard';
import { AGENT_INSTALL_COMMAND } from './config/endpoints';
import { Eraser, RotateCcw } from 'lucide-react';
import { useTranslation } from './i18n';
import 'xterm/css/xterm.css';
import { enqueueSlackCommandFromKeystrokes } from './terminal/slackMirror';
import { feedTerminalInput } from './terminal/lastCommand';
import { kvGet, kvSet } from './hooks/useKV';
import { savePromptToLibrary } from './components/PromptLibraryPanel';
import { ClampedMenu } from './components/ClampedMenu';


interface QuickCommand {
  id: string;
  name: string;
  command: string;
  icon: string;
  scope?: 'global' | 'project';
  projectRoot?: string;
}

interface XTerminalProps {
  terminalId: string;
  workDir: string;
  isActive: boolean;
  style?: {
    bg: string;
    text: string;
    accent: string;
    /** Full ANSI 16-color palette (imported themes). Falls back to the built-in palette. */
    ansi?: string[];
    cursor?: string;
    selectionBg?: string;
  };
  fontFamily?: string;
  fontSize?: number;
  cursorBlink?: boolean;
  cursorStyle?: 'block' | 'underline' | 'bar';
  scrollback?: number;
  cliType?: 'shell' | 'claude' | 'codex' | 'cursor' | 'opencode' | 'kimi' | 'gemini' | 'ollama' | 'qwen' | 'pi' | 'reasonix' | 'bbarit' | 'bbarit-oss' | 'gajae';
  autoAccept?: boolean;
  startupMode?: 'normal' | 'auto-accept' | 'bypass-permissions' | 'auto-edit' | 'full-auto' | 'yolo';
  codexWebSearch?: boolean;
  resumeLastSession?: boolean;
  extraFlags?: string[];
  modelId?: string;
  mcpConfigPath?: string;

  inputMode?: 'direct' | 'ime';
  shellType?: 'powershell' | 'cmd' | 'gitbash' | 'wsl';
  telegram?: {
    enabled: boolean;
    mirrorCommands?: boolean;
    mirrorOutput?: boolean;
    label?: string;
    chatId?: string;
    botToken?: string;
  };
  projectWorkDir?: string;
  isRestored?: boolean;
  deferStart?: boolean;
  playSoundWhenDone?: boolean;
  notifyWhenWaiting?: 'primary_screen' | 'all_screens' | 'never';
  tmuxAutoStart?: boolean;
  onReady?: (write: (text: string) => void) => void;
  onDispose?: () => void;
  onOutput?: (chunk: string) => void;
  /** Fires with the submitted command/prompt when the user presses Enter (used to title
   *  a broker harness by its last command). */
  onCommand?: (cmd: string) => void;
  skills?: import('./skills/types').Skill[];
  onRunSkill?: (skill: import('./skills/types').Skill) => void;
  quickCommands?: QuickCommand[];
  /** Extended keyboard: send kitty-style CSI-u sequences for Ctrl/Alt+Enter combos. */
  csiUKeys?: boolean;
  /** JIS keyboards: physical Yen (¥) key sends a backslash. */
  jisYenToBackslash?: boolean;
}

// Shell-quote a file path (escape spaces and special chars for shell input)
function shellQuotePath(p: string): string {
  // If path contains no special chars, return as-is
  if (/^[a-zA-Z0-9_./:@~-]+$/.test(p)) return p;
  // Otherwise, wrap in single quotes (escaping any existing single quotes)
  return "'" + p.replace(/'/g, "'\\''") + "'";
}


// Constants
const PTY_READ_INTERVAL = 33; // ~30fps (memory/CPU optimized)
const RESIZE_DEBOUNCE_MS = 250;
const TELEGRAM_SCREEN_SNAPSHOT_MAX_CHARS = 16000;
const TELEGRAM_LAST_SENT_MAX_CHARS = 4096;
const TELEGRAM_COMMAND_BUFFER_MAX_CHARS = 2000;

type ChatMessage = { role: string; content: string };
type OllamaTagModel = { name: string; size?: number | null; modified_at?: string | null };
type GeminiModelOption = { id: string; name: string };

type HttpResponseOutput = {
  status: number;
  status_text: string;
  headers: Array<[string, string]>;
  body: string;
  truncated: boolean;
};

// Prefer bundled fonts
const TERMINAL_FONT_FAMILY = [
  "Fira Code",       // bundled font
  "JetBrains Mono",  // bundled font
  "SF Mono",         // macOS (optional)
  "Menlo",           // macOS default
  "Monaco",          // macOS fallback
  "D2Coding",        // KR dev favorite (if installed)
  "NanumGothicCoding",
  "Noto Sans Mono CJK KR",
  "Noto Sans CJK KR",
  "Apple SD Gothic Neo",
  "monospace",       // final fallback
].join(", ");

const isMacOrIos = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator.platform || '').toLowerCase();
  const userAgent = (navigator.userAgent || '').toLowerCase();
  if (platform.includes('mac') || platform.includes('ipad') || platform.includes('iphone') || platform.includes('ipod')) return true;
  return userAgent.includes('macintosh') || userAgent.includes('mac os x') || userAgent.includes('ipad') || userAgent.includes('iphone') || userAgent.includes('ipod');
};

const isWindows = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator.platform || '').toLowerCase();
  const userAgent = (navigator.userAgent || '').toLowerCase();
  return platform.includes('win') || userAgent.includes('windows');
};

// IME 브릿지 대상 OS — Windows와 macOS는 조합(IME) 전략을 완전히 분리한다.
//   'mac' → 숨긴 textarea + 글자만 있는 프리에딧 오버레이를 살짝 아래로 그림 (WKWebView)
//   'win' → 숨긴 textarea + 커스텀 프리에딧 오버레이로 조합 중 글자를 그림 (WebView2)
// 이 둘은 서로의 코드 경로에 절대 끼어들지 않는다.
const IME_BRIDGE_OS: 'mac' | 'win' | 'other' = isMacOrIos() ? 'mac' : isWindows() ? 'win' : 'other';
const IS_WIN_IME = IME_BRIDGE_OS === 'win';
const IS_MAC_IME = IME_BRIDGE_OS === 'mac';
const MAC_IME_PREEDIT_TOP_OFFSET_PX = 2;
// 조합 중 앵커 재동기화: 마지막 렌더 후 이 시간 이상 잠잠해야 커서를 믿는다.
const IME_ANCHOR_RESYNC_QUIET_MS = 50;


const SHORTCUT_CODE_KEY_MAP: Record<string, string> = {
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

const shortcutKeyFromCode = (code?: string | null): string | null => {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return SHORTCUT_CODE_KEY_MAP[code] || null;
};

// Keep shortcuts stable under non-Latin keyboard layouts (e.g. Korean IME).
const getShortcutKey = (event: { key: string; code?: string | null }): string => {
  const key = (event.key || '').toLowerCase();
  if (key.length === 1 && key.charCodeAt(0) <= 0x7f) return key;
  return shortcutKeyFromCode(event.code) || key;
};

// Enable IME bridge/preedit rendering for stable Korean composition in Tauri WebKit.
const IME_SAFE_MODE = false;

// Generic disposable addon reference
interface DisposableAddon { dispose: () => void }

// Global terminal state management - persists PTY and xterm across component remounts
interface TerminalState {
  ptyCreated: boolean;
  term: Terminal | null;
  fitAddon: FitAddon | null;
  searchAddon: SearchAddon | null;
  webglAddon: DisposableAddon | null;
  unicode11Addon: DisposableAddon | null;
  webLinksAddon: DisposableAddon | null;
  terminalElement: HTMLDivElement | null;  // fixed DOM element where xterm is rendered
  readLoopActive: boolean;
  writeToPty: ((data: string) => void) | null;
  inputMode?: 'direct' | 'ime';
  shellType?: XTerminalProps['shellType'];
  inputDisposable?: { dispose: () => void } | null;
  onOutputChunk?: (chunk: string) => void;
  onOutputExternal?: (chunk: string) => void;
  telegram?: {
    enabled: boolean;
    mirrorCommands: boolean;
    mirrorOutput: boolean;
    label?: string;
    chatId?: string;
    botToken?: string;
  };
  telegramCmdBuffer?: string;
  telegramOutBuffer?: string;
  telegramOutFlushTimer?: number | null;
  telegramScreenSnapshot?: string;
  telegramScreenTimer?: number | null;
  telegramScreenDirty?: boolean;
  telegramScreenFirstDirtyAt?: number | null;
  telegramLastSent?: string;
  userScrolledUp?: boolean;  // 사용자가 스크롤업한 상태 추적
  scrollOffsetFromBottom?: number;  // 사용자가 바닥에서 얼마나 위에 있는지(라인 수)
  _writePending?: number;    // writeXterm 진행 중 카운터 (onScroll 보호용)
  lastPinRestoreAt?: number; // 마지막 프로그램적 스크롤 복원 시각 — 직후 onScroll 오감지 방지
  _idleCount?: number;       // adaptive polling: consecutive empty reads
  _readErrorStreak?: number; // 연속 read 실패 수 — 10회면 죽은 PTY로 보고 루프 중단
  usesEventTransport?: boolean;
  ptyDataUnlisten?: (() => void) | null;
  ptyExitUnlisten?: (() => void) | null;
  outputChain?: Promise<void>;
  autoStartedCliType?: string;
  startupRepairAttemptedCliType?: string;
  injectedStartupCommand?: string; // the CLI start command we typed, to skip its echo (P2-2)
  recentOutputText?: string;
  agentUiReadyCliType?: string;
  agentReadyHandler?: (() => void) | null;
  cliLaunchFailure?: CliLaunchFailureKind | null; // 미설치/깨진 설치 감지 시 재시도 중단 + 배너
  cliLaunchFailureHandler?: ((kind: CliLaunchFailureKind) => void) | null;
  agentReadyNotified?: boolean;
}
const terminalStates = new Map<string, TerminalState>();
// dev 전용 노출 — dev:screen js로 스크롤 핀 등 터미널 상태를 실측하기 위함
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__octoTerminalStates = terminalStates;

// Track last I/O activity per terminal (exported for status display)
const _terminalLastActivity = new Map<string, number>();
export function isTerminalBusy(terminalId: string, thresholdMs = 3000): boolean {
  const t = _terminalLastActivity.get(terminalId);
  if (!t) return false;
  return Date.now() - t < thresholdMs;
}

export function isTerminalAgentStarted(terminalId: string, cliType?: XTerminalProps['cliType']): boolean {
  const state = terminalStates.get(terminalId);
  if (!state?.ptyCreated) return false;
  if (!cliType || cliType === 'shell') return true;
  return state.autoStartedCliType === cliType;
}

function updateAgentUiReadyFromOutput(terminalId: string, data: string): void {
  const state = terminalStates.get(terminalId);
  if (!state || !data) return;
  state.recentOutputText = `${state.recentOutputText || ''}${data}`.slice(-24000);
  const cliType = state.autoStartedCliType as XTerminalProps['cliType'] | undefined;
  if (!cliType || cliType === 'shell') return;
  if (state.agentUiReadyCliType === cliType) return;
  // 실패가 확정되면 Retry(버퍼 초기화)까지 준비/실패 판정을 멈춘다 — 에러 문구에
  // bin 이름이 들어 있어 느슨한 준비 정규식이 ready로 오판하는 것을 막는다.
  if (state.cliLaunchFailure) return;
  const cleaned = stripInjectedEcho(state.recentOutputText, state.injectedStartupCommand);
  // 기동 실패(미설치·깨진 npm 셔임) 감지가 준비 감지보다 먼저다: not-found 에코에도
  // bin 이름이 포함돼 준비 정규식이 매칭될 수 있다.
  const failureKind = detectCliLaunchFailure(cliType, cleaned);
  if (failureKind) {
    state.cliLaunchFailure = failureKind;
    state.cliLaunchFailureHandler?.(failureKind);
    return;
  }
  if (!looksLikeAgentUiReady(cliType, cleaned)) return;
  state.agentUiReadyCliType = cliType;
  const handler = state.agentReadyHandler;
  handler?.();
}

export function isTerminalAgentUiReady(terminalId: string, cliType?: XTerminalProps['cliType']): boolean {
  const state = terminalStates.get(terminalId);
  if (!state?.ptyCreated) return false;
  if (!cliType || cliType === 'shell') return true;
  if (state.agentUiReadyCliType === cliType) return true;
  // Detect readiness by the agent's OWN output signature (Claude Code / OpenAI Codex
  // welcome, etc.), not by autoStartedCliType bookkeeping — a late-mounted broker window
  // or a manually-started CLI can leave that flag unset while the agent is clearly up.
  if (state.recentOutputText && looksLikeAgentUiReady(cliType, stripInjectedEcho(state.recentOutputText, state.injectedStartupCommand))) {
    state.agentUiReadyCliType = cliType;
    return true;
  }
  return false;
}

export function getTerminalRecentOutput(terminalId: string): string {
  const state = terminalStates.get(terminalId);
  if (!state?.recentOutputText) return '';
  // P2-2: drop the broker's own injected start-command echo so readiness/prompt checks
  // see the agent's response, not our keystrokes.
  return stripInjectedEcho(state.recentOutputText, state.injectedStartupCommand);
}

// Check if PTY output contains meaningful content vs control-only TUI refreshes.
// Agent CLIs such as Codex repaint spinners frequently; treating those frames as
// user-visible activity makes the terminal chrome flicker between busy/idle.
const _ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const _SPINNER_ONLY_RE = /^[\s|/\\\-_.:;()[\]{}<>*+=~`'"!?,•·…⠁-⣿◐◓◑◒◴◷◶◵▁-█]+$/u;
function hasMeaningfulOutput(data: string): boolean {
  const visible = data
    .replace(_ANSI_RE, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  if (!visible) return false;
  return !_SPINNER_ONLY_RE.test(visible);
}

// Global read loop management (one loop per terminal)
const readLoops = new Map<string, number>();

const processTerminalOutput = (terminalId: string, data: string) => {
  const state = terminalStates.get(terminalId);
  if (!state?.term || !data) return Promise.resolve();

  const run = async () => {
    try {
      updateAgentUiReadyFromOutput(terminalId, data);
      if (hasMeaningfulOutput(data)) _terminalLastActivity.set(terminalId, Date.now());
      await writeWithDsrHandling(state, data);
      state.onOutputChunk?.(data);
      state.onOutputExternal?.(data);
      enqueueTelegramOutput(terminalId, data);
    } catch (err) {
      console.warn('[PTY] output processing error for', terminalId, err);
      // 에러 발생해도 체인이 계속 진행되도록 catch 내에서 처리
    }
  };

  const next = (state.outputChain || Promise.resolve())
    .catch(() => {})
    .then(run);
  state.outputChain = next;
  return next;
};

// preserveTerminalViewport / writeXterm 본체는 ./terminal/scrollKeeper로 추출됨
// (실제 xterm 버퍼를 붙인 scrollKeeper.test.ts로 검증)

// Some TUIs (including cursor-positioning helpers) use DSR queries.
// If we reply using xterm's cursor BEFORE the chunk is processed, the reported position can be stale.
const writeWithDsrHandling = async (state: TerminalState, data: string) => {
  const term = state.term;
  if (!term || !data) return;

  const writeToPty = state.writeToPty;
  const hasDsr = data.includes('\x1b[6n') || data.includes('\x1b[5n');

  if (!hasDsr) {
    await writeXterm(term, data, state);
    return;
  }

  // Process in-order so the cursor position reflects everything before each query.
  let i = 0;
  while (i < data.length) {
    const idx6 = data.indexOf('\x1b[6n', i);
    const idx5 = data.indexOf('\x1b[5n', i);
    let next = -1;
    let kind: '6n' | '5n' | null = null;

    if (idx6 !== -1 && (idx5 === -1 || idx6 < idx5)) {
      next = idx6;
      kind = '6n';
    } else if (idx5 !== -1) {
      next = idx5;
      kind = '5n';
    }

    if (next === -1) {
      const rest = data.slice(i);
      if (rest) await writeXterm(term, rest, state);
      break;
    }

    const before = data.slice(i, next);
    if (before) await writeXterm(term, before, state);

    if (kind === '6n') {
      const cursorY = term.buffer.active.cursorY + 1;
      const cursorX = term.buffer.active.cursorX + 1;
      // Respond with CPR (Cursor Position Report).
      if (writeToPty) writeToPty(`\x1b[${cursorY};${cursorX}R`);
      i = next + 4; // len('\x1b[6n')
      continue;
    }

    if (kind === '5n') {
      // "Device status report" (OK).
      if (writeToPty) writeToPty('\x1b[0n');
      i = next + 4; // len('\x1b[5n')
      continue;
    }

    // Should be unreachable, but avoid infinite loops.
    i = next + 1;
  }
};

const tokenizeArgs = (input: string): string[] => {
  const out: string[] = [];
  const s = input.trim();
  if (!s) return out;

  let current = '';
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current) out.push(current);
  return out;
};

const shellQuote = (value: string): string => `'${String(value || '').replace(/'/g, `'\\''`)}'`;

type ParsedSshWorkDir = {
  username: string;
  host: string;
  port: number;
  identityFile?: string;
  basePath: string;
};

const decodeSshKeyToken = (token: string): string => {
  const raw = String(token || '').trim();
  if (!raw) return '';
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLen);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes).trim();
  } catch {
    return '';
  }
};

const parseSshWorkDir = (value: string): ParsedSshWorkDir | null => {
  const raw = String(value || '').trim();
  if (!raw.startsWith('ssh://')) return null;
  const body = raw.slice('ssh://'.length);
  const sep = body.indexOf('::');
  if (sep < 0) return null;

  const meta = body.slice(0, sep).trim();
  const basePathRaw = body.slice(sep + 2).trim();
  const keyIndex = meta.indexOf(';key=');
  const main = keyIndex >= 0 ? meta.slice(0, keyIndex) : meta;
  const keyToken = keyIndex >= 0 ? meta.slice(keyIndex + ';key='.length) : '';

  const at = main.lastIndexOf('@');
  if (at < 1) return null;
  const username = main.slice(0, at).trim();
  const hostPort = main.slice(at + 1).trim();
  if (!username || !hostPort) return null;

  const colon = hostPort.lastIndexOf(':');
  let host = hostPort;
  let port = 22;
  if (colon > 0) {
    const maybePort = parseInt(hostPort.slice(colon + 1), 10);
    if (Number.isFinite(maybePort) && maybePort > 0) {
      host = hostPort.slice(0, colon).trim();
      port = maybePort;
    }
  }
  if (!host) return null;

  let basePath = basePathRaw || '~';
  if (!basePath.startsWith('/') && !basePath.startsWith('~')) basePath = `/${basePath}`;
  if (basePath.length > 1 && basePath.endsWith('/')) basePath = basePath.replace(/\/+$/g, '');

  const identityFile = decodeSshKeyToken(keyToken) || undefined;
  return { username, host, port, identityFile, basePath };
};

const buildSshStartupCommand = async (workDir: string): Promise<string | null> => {
  const info = parseSshWorkDir(workDir);
  if (!info) return null;

  const remoteScript = [
    `if [ -d ${shellQuote(info.basePath)} ]; then`,
    `  cd -- ${shellQuote(info.basePath)};`,
    'else',
    `  echo "[octo] remote path not found: ${info.basePath}";`,
    'fi;',
    'exec ${SHELL:-/bin/bash} -l',
  ].join(' ');

  // Fix SSH key permissions (chmod 600) before use
  let keyPath = info.identityFile;
  if (keyPath) {
    try {
      keyPath = await invoke<string>('ssh_fix_key_permissions', { keyPath });
    } catch (e) {
      console.warn('[SSH] Key permission fix failed, using original:', e);
    }
  }

  const sshOptions = [
    '-t',  // Force PTY allocation for interactive shell
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=5',
    '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'NumberOfPasswordPrompts=0',
    '-p', String(info.port),
    ...(keyPath ? ['-i', keyPath] : []),
  ];

  return [
    'ssh',
    ...sshOptions.map(a => shellQuote(a)),
    shellQuote(`${info.username}@${info.host}`),
    shellQuote(remoteScript),
  ].join(' ');
};

const normalizeNewlines = (text: string) => text.replace(/\r?\n/g, '\r\n');
const normalizeInputNewlines = (text: string) => text.replace(/\r?\n/g, '\r');
const submitDroppedPaths = (paths: string[]) => `${paths.map(shellQuotePath).join(' ')}\r`;
const isImagePath = (path: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(path.trim().replace(/^file:\/\//i, ''));
const normalizeMaybeFileUrlPath = (path: string) => {
  const trimmed = path.trim();
  if (!trimmed.toLowerCase().startsWith('file://')) return trimmed;
  try {
    const path = decodeURIComponent(new URL(trimmed).pathname);
    return /^\/[a-zA-Z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return trimmed;
  }
};
const normalizeBbaritImagePath = (path: string) => (
  normalizeMaybeFileUrlPath(path)
    .trim()
    .replace(/^@+/, '')
    .replace(/^['"]|['"]$/g, '')
);
const bbaritImageToken = (path: string) => `@${shellQuotePath(normalizeBbaritImagePath(path))} `;
// Both bbarit agent TUIs (built-in and OSS) accept the `@<path>` vision token.
// Only gating on 'bbarit' is why captures pasted into a bbarit-oss terminal
// arrived as a bare auto-submitted path and were never attached as an image.
const isBbaritAgentCli = (cliType?: string) => cliType === 'bbarit' || cliType === 'bbarit-oss';

const parsePastedImagePathList = (text: string): string[] => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => normalizeBbaritImagePath(line))
    .filter(Boolean);
  if (lines.length === 0) return [];
  if (!lines.every(isImagePath)) return [];
  return lines;
};

// Bracketed paste mode: wrap pasted text with escape sequences so shells (bash, zsh, fish)
// handle multi-line paste correctly instead of executing each line immediately.
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

// Write large paste data in chunks to avoid shell buffer overflow.
// Most terminal PTY buffers handle ~4KB at a time reliably.
const PASTE_CHUNK_SIZE = 4096;
const PASTE_CHUNK_DELAY_MS = 5;

async function writePasteChunked(
  writeFn: (data: string) => void,
  text: string,
  useBracketedPaste = true,
) {
  if (!text) return;
  if (useBracketedPaste) {
    writeFn(BRACKETED_PASTE_START);
    await new Promise(r => setTimeout(r, PASTE_CHUNK_DELAY_MS));
  }

  if (text.length <= PASTE_CHUNK_SIZE) {
    writeFn(text);
  } else {
    for (let i = 0; i < text.length; ) {
      let end = Math.min(i + PASTE_CHUNK_SIZE, text.length);
      // 서로게이트 페어(이모지 등) 한가운데서 자르면 IPC 직렬화에서 U+FFFD로 깨진다.
      if (end < text.length) {
        const c = text.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end -= 1;
      }
      writeFn(text.slice(i, end));
      i = end;
      await new Promise(r => setTimeout(r, PASTE_CHUNK_DELAY_MS));
    }
  }

  // Do not append the bracketed-paste terminator in the same event-loop turn as
  // the final payload chunk. Some PTY/WebView backends coalesce fast writes and
  // interactive terminal apps can consume the end marker before the last bytes,
  // which made the tail of pasted Korean/long text disappear.
  await new Promise(r => setTimeout(r, PASTE_CHUNK_DELAY_MS));

  if (useBracketedPaste) writeFn(BRACKETED_PASTE_END);
}

const capTail = (text: string, maxChars: number) => (
  text.length > maxChars ? text.slice(-maxChars) : text
);

// Screen-snapshot mirroring timings (ms)
const TELEGRAM_SCREEN_IDLE_FLUSH_MS = 1500;
const TELEGRAM_SCREEN_MAX_WAIT_MS = 5000;

const filterTelegramNoise = (text: string) => {
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

const redactTelegramSecrets = (text: string) => {
  // Prevent accidentally leaking common secrets when mirroring commands to Telegram.
  // This is best-effort and intentionally conservative.
  let out = text || '';

  const keys = [
    'OPENAI_API_KEY',
    'CONTEXT7_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_TOKEN',
    'TELEGRAM_CHAT_ID',
  ];

  for (const k of keys) {
    // Matches: KEY=value, KEY="value", KEY='value' (with optional whitespace).
    const re = new RegExp(`(${k}\\s*=\\s*)(\"[^\"]*\"|'[^']*'|[^\\s]+)`, 'gi');
    out = out.replace(re, `$1***`);
  }

  // Generic OpenAI-style key prefix (sk-...). Avoid over-matching short strings.
  out = out.replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***');

  return out;
};

const telegramSendBestEffort = (text: string, botToken: string | undefined, chatId?: string) => {
  const t = (text || '').trim();
  if (!t) return;
  const token = (botToken || '').trim();
  const chat = (chatId || '').trim();
  if (!chat) return; // 1:1 mapping: only mirror when a chat is explicitly linked.
  invoke('telegram_send_message_with_token', { botToken: token, chatId: chat, text: t }).catch(() => {});
};

/**
 * Read the current visible screen content from xterm.js buffer.
 * This preserves cursor-moved UIs (menus, prompts) far better than raw chunk mirroring.
 */
const readTerminalScreen = (term: Terminal): string => {
  const buf = term.buffer.active;
  const baseY = buf.baseY;
  const lines: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(baseY + i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines.join('\n');
};

const flushTelegramScreen = (terminalId: string) => {
  const st = terminalStates.get(terminalId);
  if (!st?.term) return;
  st.telegramScreenTimer = null;
  st.telegramScreenFirstDirtyAt = null;
  st.telegramScreenDirty = false;

  const currentScreen = readTerminalScreen(st.term);
  const cleaned = filterTelegramNoise(currentScreen);
  const trimmed = capTail(cleaned.replace(/\n{3,}/g, '\n\n').trimEnd(), TELEGRAM_SCREEN_SNAPSHOT_MAX_CHARS);
  if (!trimmed || trimmed === st.telegramScreenSnapshot) return;

  const prev = st.telegramScreenSnapshot || '';
  st.telegramScreenSnapshot = trimmed;

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
  if (diffStart < 3 || newLines.length > currLines.length * 0.7) payload = trimmed;
  else payload = newText;

  payload = redactTelegramSecrets(payload);
  if (!payload.trim()) return;

  const label = st.telegram?.label ? `[${st.telegram.label}] ` : '';
  const chatId = st.telegram?.chatId;
  const botToken = st.telegram?.botToken;

  const maxChunk = 3900 - label.length;
  if (payload.length > maxChunk) {
    const bottomPayload = '...\n' + payload.slice(-maxChunk + 4);
    const topPayload = payload.slice(0, maxChunk);

    const bottomMsg = label + bottomPayload;
    if (st.telegramLastSent !== bottomMsg) {
      st.telegramLastSent = capTail(bottomMsg, TELEGRAM_LAST_SENT_MAX_CHARS);
      telegramSendBestEffort(bottomMsg, botToken, chatId);
    }
    if (topPayload.trim() && topPayload.trim() !== bottomPayload.trim()) {
      telegramSendBestEffort(label + topPayload + '\n...', botToken, chatId);
    }
  } else {
    const msg = label + payload;
    if (st.telegramLastSent === msg) return;
    st.telegramLastSent = capTail(msg, TELEGRAM_LAST_SENT_MAX_CHARS);
    telegramSendBestEffort(msg, botToken, chatId);
  }
};

const enqueueTelegramOutput = (terminalId: string, chunk: string) => {
  const state = terminalStates.get(terminalId);
  if (!state?.telegram?.enabled || !state.telegram.mirrorOutput) return;
  if (!state.term) return;

  // We still consume the chunk to avoid "unused" warnings and to allow future heuristics.
  void chunk;
  state.telegramScreenDirty = true;
  const now = Date.now();
  if (!state.telegramScreenFirstDirtyAt) state.telegramScreenFirstDirtyAt = now;

  if (state.telegramScreenTimer) {
    clearTimeout(state.telegramScreenTimer);
    state.telegramScreenTimer = null;
  }

  const elapsed = now - (state.telegramScreenFirstDirtyAt || now);
  if (elapsed >= TELEGRAM_SCREEN_MAX_WAIT_MS) {
    flushTelegramScreen(terminalId);
    return;
  }

  const remaining = Math.max(0, TELEGRAM_SCREEN_MAX_WAIT_MS - elapsed);
  const waitMs = Math.min(TELEGRAM_SCREEN_IDLE_FLUSH_MS, remaining);
  state.telegramScreenTimer = window.setTimeout(() => flushTelegramScreen(terminalId), waitMs);
};

const enqueueTelegramCommandFromKeystrokes = (terminalId: string, data: string) => {
  const state = terminalStates.get(terminalId);
  if (!state?.telegram?.enabled || !state.telegram.mirrorCommands) return;

  const label = state.telegram?.label ? `[${state.telegram.label}] ` : '';
  let buf = state.telegramCmdBuffer || '';

  const flush = () => {
    const cmd = (buf || '').trim();
    buf = '';
    state.telegramCmdBuffer = '';
    if (!cmd) return;
    telegramSendBestEffort(`${label}$ ${redactTelegramSecrets(cmd)}`, state.telegram?.botToken, state.telegram?.chatId);
  };

  // Best-effort: we only track printable chars + backspace and flush on Enter.
  // This won't perfectly match complex line editing, but is good enough for "what was executed".
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
    if (ch === '\x1b') {
      // Ignore escape sequences (arrows, etc.)
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) continue; // other control chars
    buf += ch;
    if (buf.length > TELEGRAM_COMMAND_BUFFER_MAX_CHARS) {
      buf = buf.slice(-TELEGRAM_COMMAND_BUFFER_MAX_CHARS);
    }
  }

  state.telegramCmdBuffer = buf;
};

// xterm selects whole cells, so a drag past the text grabs the trailing space
// padding of each line. Strip trailing spaces/tabs per line on copy so the
// clipboard holds just the characters (leading indentation is preserved).
const trimSelectionTrailingWhitespace = (text: string): string =>
  text.replace(/\r/g, '').split('\n').map((line) => line.replace(/[ \t]+$/g, '')).join('\n');

const fixWebKitImeForXterm = (wrap: HTMLElement | null, cursorX?: number, cursorY?: number, _cellW?: number, _cellH?: number) => {
  // In IME bridge mode, we use our own textarea for IME input.
  // xterm's helper textarea must be fully hidden to prevent double composition display
  // which causes flickering (characters appear then disappear) on Windows.
  if (!wrap) return;

  try {
    // Hide xterm's helper textarea
    const els = Array.from(wrap.querySelectorAll<HTMLElement>('.xterm-helper-textarea'));
    const left = cursorX !== undefined ? cursorX : 0;
    const top = cursorY !== undefined ? cursorY : 0;

    for (const el of els) {
      el.style.position = 'absolute';
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = '1px';
      el.style.height = '1px';
      el.style.opacity = '0';
      el.style.zIndex = '-1';
      el.style.pointerEvents = 'none';
      el.style.border = 'none';
      el.style.outline = 'none';
      el.style.padding = '0';
      el.style.margin = '0';
      el.style.overflow = 'hidden';
    }

    // Hide xterm's composition view (class is "composition-view", not "xterm-composition-view")
    // This prevents the yellow/white composition text from showing alongside our overlay.
    const compViews = Array.from(wrap.querySelectorAll<HTMLElement>('.composition-view'));
    for (const el of compViews) {
      el.style.display = 'none';
      el.style.opacity = '0';
    }
  } catch {
    // ignore
  }
};

// NOTE: We intentionally do NOT hide xterm's cursor by default. Some TUIs may render their own cursor,
// but hiding xterm's cursor caused "no cursor" reports and made IME positioning harder to reason about.


// Start terminal read loop (ignore if already running)
const startReadLoop = (terminalId: string) => {
  if (readLoops.has(terminalId)) return; // already running

  const readFromPty = async () => {
    const state = terminalStates.get(terminalId);
    if (!state?.term || !state.readLoopActive) {
      readLoops.delete(terminalId);
      return;
    }
    if (state.usesEventTransport) {
      readLoops.delete(terminalId);
      return;
    }

    let hasData = false;
    try {
      const data = await invoke<string | null>('read_from_pty', { terminalId });
      if (data && state.term) {
        hasData = true;
        await processTerminalOutput(terminalId, data);
      }
      state._readErrorStreak = 0;
    } catch (err) {
      // 죽은 PTY를 영원히 폴링하던 누수: 에러가 연속되면 루프를 멈춘다.
      // (설치본에서 죽은 에이전트/셸 탭들이 각각 5Hz로 무한 폴링하며
      //  웹뷰 CPU를 상시 점유하던 실측 원인)
      const streak = (state._readErrorStreak || 0) + 1;
      state._readErrorStreak = streak;
      if (streak >= 10) {
        console.warn('[PTY] read_from_pty failed 10x — stopping read loop for', terminalId, err);
        state.readLoopActive = false;
        readLoops.delete(terminalId);
        return;
      }
      console.warn('[PTY] read_from_pty error for', terminalId, err);
    }

    if (state?.readLoopActive) {
      // Adaptive interval: fast when data flowing, slow when idle. 창이
      // 백그라운드(document.hidden)면 바닥을 500ms로 올려 숨은 앱이 CPU를
      // 태우지 않게 한다 — 출력은 계속 드레인되므로 유실 없음.
      const idleCount = hasData ? 0 : (state._idleCount || 0) + 1;
      if (state) state._idleCount = idleCount;
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const interval = hidden
        ? Math.min(500 + idleCount * 10, 1000)
        : hasData
          ? PTY_READ_INTERVAL
          : Math.min(PTY_READ_INTERVAL + idleCount * 10, 200);
      const timeoutId = window.setTimeout(() => readFromPty(), interval);
      readLoops.set(terminalId, timeoutId);
    } else {
      readLoops.delete(terminalId);
    }
  };

  const state = terminalStates.get(terminalId);
  if (state) state.readLoopActive = true;

  const timeoutId = window.setTimeout(readFromPty, PTY_READ_INTERVAL);
  readLoops.set(terminalId, timeoutId);
};

// Stop terminal read loop (used when deleting terminal)
const _stopReadLoop = (terminalId: string) => {
  const timeoutId = readLoops.get(terminalId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    readLoops.delete(terminalId);
  }
  const state = terminalStates.get(terminalId);
  if (state) state.readLoopActive = false;
};
export { _stopReadLoop as stopReadLoop };

// Fully dispose terminal (free memory)
const disposeTerminalRuntime = (terminalId: string, closePty: boolean) => {
  // Process asynchronously to avoid conflicts with React rendering
  setTimeout(() => {
    _stopReadLoop(terminalId);

    const state = terminalStates.get(terminalId);
      if (state) {
        if (state.ptyDataUnlisten) {
          try {
            state.ptyDataUnlisten();
          } catch {
            // ignore
          }
          state.ptyDataUnlisten = null;
        }
        if (state.ptyExitUnlisten) {
          try {
            state.ptyExitUnlisten();
          } catch {
            // ignore
          }
          state.ptyExitUnlisten = null;
        }
        if (state.telegramOutFlushTimer) {
          clearTimeout(state.telegramOutFlushTimer);
          state.telegramOutFlushTimer = null;
        }
        if (state.telegramScreenTimer) {
          clearTimeout(state.telegramScreenTimer);
          state.telegramScreenTimer = null;
        }
        if (state.inputDisposable) {
          try {
            state.inputDisposable.dispose();
          } catch {
            // ignore
        }
        state.inputDisposable = null;
      }
      // Dispose all addons before xterm instance
      const addonsToDispose: (DisposableAddon | null | undefined)[] = [
        state.webglAddon, state.unicode11Addon, state.webLinksAddon,
        state.searchAddon, state.fitAddon,
      ];
      for (const addon of addonsToDispose) {
        if (addon) {
          try { addon.dispose(); } catch { /* ignore */ }
        }
      }
      state.webglAddon = null;
      state.unicode11Addon = null;
      state.webLinksAddon = null;
      state.searchAddon = null;
      state.fitAddon = null;
      // xterm instance dispose
      if (state.term) {
        try {
          state.term.dispose();
        } catch {
          // ignore
        }
      }
      // Break references for GC
      state.term = null;
      state.onOutputChunk = undefined;
      state.onOutputExternal = undefined;
      state.outputChain = undefined;
      state.usesEventTransport = false;
      _terminalLastActivity.delete(terminalId);
      // DOM elements are managed by React, so don't remove directly
      // Remove from Map
      terminalStates.delete(terminalId);
    }

  // Clean up PTY as well
    // Prefer the canonical command name, but keep compatibility with older backend builds.
    if (closePty) {
      invoke('close_pty', { terminalId }).catch(() => {
        invoke('destroy_pty', { terminalId }).catch(() => {});
      });
    }
  }, 0);
};
const _disposeTerminal = (terminalId: string) => disposeTerminalRuntime(terminalId, true);
export { _disposeTerminal as disposeTerminal };

// Popout support: release this window's runtime for a terminal (xterm instance,
// PTY read loop, listeners) while keeping the PTY itself alive. The PTY output
// channel is single-consumer, so the main window must fully let go while a
// popout window owns the stream; re-attach goes through the restored-PTY path
// which replays the backend output buffer.
export const releaseTerminalRuntime = (terminalId: string) => disposeTerminalRuntime(terminalId, false);

// Stable empty default for extraFlags. A `= []` default param creates a NEW array on
// every render, and extraFlags is in the main setup-effect's dependency list — so the
// default would re-run the effect (dispose + re-mount the PTY) on EVERY parent re-render.
// In the broker harness window (which re-renders frequently on status polling) that meant
// the agent CLI start command was lost to a constant remount and the terminal sat at a
// raw shell. A module-level constant keeps the identity stable across renders.
const EMPTY_EXTRA_FLAGS: string[] = [];

export const XTerminal = React.memo(function XTerminal({ terminalId, workDir, isActive, style, fontFamily, fontSize: fontSizeProp = 14, cursorBlink = false, cursorStyle = 'bar', scrollback = 5000, cliType = 'shell', autoAccept = false, startupMode, codexWebSearch = true, resumeLastSession = false, extraFlags = EMPTY_EXTRA_FLAGS, modelId, mcpConfigPath, inputMode = 'direct', shellType, telegram, projectWorkDir, isRestored: _isRestored = false, deferStart = false, playSoundWhenDone = false, tmuxAutoStart = false, onReady, onDispose, onOutput, onCommand, skills, onRunSkill, quickCommands, csiUKeys = true, jisYenToBackslash = false }: XTerminalProps) {
  // Validate fontSize range (8-20px only, defaults to 14px otherwise)
  const { t } = useTranslation();
  const fontSize = (fontSizeProp && fontSizeProp >= 8 && fontSizeProp <= 20) ? fontSizeProp : 14;
  const terminalWrapRef = useRef<HTMLDivElement>(null);
  const terminalMountRef = useRef<HTMLDivElement>(null);
  const clickFlashFrameRef = useRef<number | null>(null);
  const clickFlashTimerRef = useRef<number | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [searchBarVisible, setSearchBarVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchResult, setSearchResult] = useState<{ resultIndex: number; resultCount: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Extended keyboard flags live in refs — the key handler is attached once in the
  // main setup effect and must see the latest prop values without re-mounting the PTY.
  const csiUKeysRef = useRef(csiUKeys);
  useEffect(() => { csiUKeysRef.current = csiUKeys; }, [csiUKeys]);
  const jisYenRef = useRef(jisYenToBackslash);
  useEffect(() => { jisYenRef.current = jisYenToBackslash; }, [jisYenToBackslash]);
  const initRef = useRef(false);
  const isDisposedRef = useRef(false);
  // Set when the user submits input (Enter); gates the "task completed" toast so it
  // only fires after an actual request (not on the CLI's startup banner).
  const taskPendingRef = useRef(false);
  const taskPromptRef = useRef('');     // the prompt the user submitted
  const onCommandRef = useRef(onCommand);
  useEffect(() => { onCommandRef.current = onCommand; }, [onCommand]);
  // bbarit-ctl CLI의 terminal.read용 전역 버퍼 리더 — 터미널별로 마지막 N줄을
  // 텍스트로 돌려준다 (read_from_pty를 건드리면 앱 폴링과 경쟁하므로 금지).
  useEffect(() => {
    const g = window as unknown as { __BBARIT_TERM_READERS__?: Record<string, (lines?: number) => string> };
    if (!g.__BBARIT_TERM_READERS__) g.__BBARIT_TERM_READERS__ = {};
    g.__BBARIT_TERM_READERS__[terminalId] = (lines = 80) => {
      const term = termRef.current;
      if (!term) return '';
      const buf = term.buffer.active;
      const all: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        all.push(line ? line.translateToString(true) : '');
      }
      // 새 셸은 프롬프트가 버퍼 위쪽에 있고 아래는 빈 줄이다 — 뒤쪽 공백을
      // 걷어낸 뒤 마지막 N줄을 돌려줘야 "마지막 출력"이 나온다.
      let end = all.length;
      while (end > 0 && all[end - 1].trim() === '') end -= 1;
      return all.slice(Math.max(0, end - Math.max(1, lines)), end).join('\n');
    };
    return () => { delete g.__BBARIT_TERM_READERS__?.[terminalId]; };
  }, [terminalId]);
  const taskStartedAtRef = useRef(0);   // when the task started (for duration)
  const writeToPtyRef = useRef<((data: string) => void) | null>(null);
  const lastNativePasteAtRef = useRef(0);
  const pendingPasteFallbackTimerRef = useRef<number | null>(null);
  const lastTerminalSelectionRef = useRef('');
  const isReadyRef = useRef(false);
  // 마운트마다 새로 만들어지는 ref — writer 재등록 여부를 추적한다.
  const writerRegisteredRef = useRef(false);
  // Cmd (macOS) / Ctrl (other) held — gates iTerm2-style clickable links.
  const cmdHeldRef = useRef(false);
  // IME input bar is useful for shells, but it fights with interactive TUIs (Claude/Codex) that already
  // render their own input UI inside the terminal. In those cases, we force "direct" mode.
  const requestedImeInput = inputMode === 'ime';
  const isTauri = (() => {
    const w = window as unknown as Record<string, unknown>;
    return ('__TAURI__' in w) || ('__TAURI_INTERNALS__' in w);
  })();
  const useImeInput = requestedImeInput && cliType === 'shell';
  const isImeBridgePlatform = isTauri && (isMacOrIos() || isWindows());
  const useTauriImeBridge =
    !IME_SAFE_MODE &&
    !useImeInput &&
    isImeBridgePlatform &&
    (cliType === 'shell' || cliType === 'claude' || cliType === 'codex' || cliType === 'cursor' || cliType === 'opencode' || cliType === 'kimi' || cliType === 'ollama' || cliType === 'qwen' || cliType === 'pi' || cliType === 'reasonix' || cliType === 'bbarit' || cliType === 'bbarit-oss' || cliType === 'gajae');

  // Input field (needed for Korean input in Tauri WebKit)
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const imeBridgeRef = useRef<HTMLTextAreaElement | null>(null);
  const imeBridgeComposingRef = useRef(false);
  // Esc discarded the open composition: swallow the IME's late compositionend
  // commit so the half-typed syllable doesn't get typed into the PTY.
  const imeBridgeDiscardCompositionEndRef = useRef(false);
  const imeBridgeCompositionTextRef = useRef('');
  const imeBridgePendingEnterRef = useRef<'enter' | 'shift-enter' | false>(false);
  const imeBridgeLastCommittedRef = useRef('');
  const imeBridgeLastCommittedAtRef = useRef(0);
  // 재동기화 게이트용 타임스탬프 — imeBridgeLastCommittedAtRef는 compositionstart가
  // 0으로 리셋하므로(중복 커밋 dedup 용도) 별도로 둔다.
  const imeLastPtySendAtRef = useRef(0);
  const imeLastRenderAtRef = useRef(0);
  const imeBridgeCompositionStartValueRef = useRef('');
  // Show composition text as overlay at cursor position
  const [imePreeditText, setImePreeditText] = useState('');
  const [cursorOverlay, setCursorOverlay] = useState<{ left: number; top: number; cellW: number; cellH: number } | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // CLI 기동 실패(미설치·깨진 npm 셔임) 감지 시 설치 안내 배너
  const [cliInstallFailure, setCliInstallFailure] = useState<CliLaunchFailureKind | null>(null);
  const cliInstallGuide: CliInstallGuide | null =
    cliInstallFailure && cliType !== 'shell'
      ? buildCliInstallGuide(cliType, cliInstallFailure, isWindows())
      : null;
  const runCliInstallFix = useCallback(() => {
    const st = terminalStates.get(terminalId);
    const fix = cliInstallFailure && cliType !== 'shell'
      ? buildCliInstallGuide(cliType, cliInstallFailure, isWindows()).fixCommand
      : null;
    if (fix && st?.writeToPty) st.writeToPty(fix + '\r');
  }, [terminalId, cliType, cliInstallFailure]);
  const retryCliLaunch = useCallback(() => {
    const st = terminalStates.get(terminalId);
    setCliInstallFailure(null);
    if (!st) return;
    st.cliLaunchFailure = null;
    st.recentOutputText = ''; // 이전 실패 출력이 곧바로 재감지되지 않게 초기화
    if (st.injectedStartupCommand && st.writeToPty) st.writeToPty(st.injectedStartupCommand + '\r');
  }, [terminalId]);
  const dismissCliInstallGuide = useCallback(() => {
    // st.cliLaunchFailure는 남겨 재시도 스팸을 계속 차단하고, 배너만 닫는다
    setCliInstallFailure(null);
  }, []);
  // When pressing Enter during IME composition, the composition is finalized first,
  // then onChange fires. We defer sending on composition end so a single Enter does "finalize + send".
  const pendingSendOnCompositionEndRef = useRef(false);
  // Flag to suppress the onChange (reflecting finalized text) that fires right after composition end,
  // which would otherwise re-fill the input after we've already cleared it.
  const suppressNextOnChangeRef = useRef(false);

  // Minimal beep support for "done" notifications (best-effort; gated by settings).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastBeepAtRef = useRef<number>(0);
  const ensureAudio = useCallback(() => {
    try {
      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctx) return null;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') void ctx.resume();
      return ctx;
    } catch {
      return null;
    }
  }, []);

  const playBeep = useCallback(() => {
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = Date.now();
    if (now - lastBeepAtRef.current < 1500) return;
    lastBeepAtRef.current = now;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      const t0 = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      osc.stop(t0 + 0.14);
    } catch {
      // ignore
    }
  }, [ensureAudio]);

  const triggerTerminalClickFlash = useCallback(() => {
    const xtermEl = (termRef.current as any)?.element as HTMLElement | undefined;
    if (!xtermEl) return;
    if (clickFlashFrameRef.current !== null) {
      window.cancelAnimationFrame(clickFlashFrameRef.current);
      clickFlashFrameRef.current = null;
    }
    if (clickFlashTimerRef.current !== null) {
      window.clearTimeout(clickFlashTimerRef.current);
      clickFlashTimerRef.current = null;
    }
    xtermEl?.classList.remove('terminal-click-flash-direct');
    void xtermEl.offsetWidth;
    clickFlashFrameRef.current = window.requestAnimationFrame(() => {
      xtermEl?.classList.add('terminal-click-flash-direct');
      clickFlashFrameRef.current = null;
      clickFlashTimerRef.current = window.setTimeout(() => {
        xtermEl?.classList.remove('terminal-click-flash-direct');
        clickFlashTimerRef.current = null;
      }, 560);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (clickFlashFrameRef.current !== null) {
        window.cancelAnimationFrame(clickFlashFrameRef.current);
      }
      if (clickFlashTimerRef.current !== null) {
        window.clearTimeout(clickFlashTimerRef.current);
      }
    };
  }, []);


  // ── Ollama chat mode state ──
  const ollamaChatHistoryRef = useRef<ChatMessage[]>([]);
  const ollamaLineBufRef = useRef('');
  const ollamaBusyRef = useRef(false);
  const ollamaModeActiveRef = useRef(false);
  const ollamaInputHandlerRef = useRef<((data: string) => void) | null>(null);

  // Persist telegram forwarding settings into the global terminal state (read loop runs outside React).
  useEffect(() => {
    const state = terminalStates.get(terminalId);
    if (!state) return;
    if (!telegram?.enabled) {
      state.telegram = { enabled: false, mirrorCommands: false, mirrorOutput: false };
      return;
    }
    state.telegram = {
      enabled: true,
      mirrorCommands: !!telegram.mirrorCommands,
      mirrorOutput: !!telegram.mirrorOutput,
      label: telegram.label,
      chatId: telegram.chatId,
      botToken: telegram.botToken,
    };
  }, [terminalId, telegram?.enabled, telegram?.mirrorCommands, telegram?.mirrorOutput, telegram?.label, telegram?.chatId, telegram?.botToken]);

  // Notify when an AI CLI finishes a turn. Keyword matching on raw output is
  // noisy, so we detect completion by activity going idle: once output stops for
  // a while after the CLI was busy, its turn is done. (Plain shells go idle after
  // every command, so they are skipped.)
  useEffect(() => {
    const state = terminalStates.get(terminalId);
    if (!state) return;
    if (cliType === 'shell') return;

    // This effect only runs for AGENT CLIs (shell returned above). Agents routinely pause
    // output for several seconds while THINKING or running a tool — a 3s idle there is NOT
    // "done", it's mid-task, and it fired false "task completed / stopped" alarms. Wait long
    // enough to ride out normal thinking/tool pauses before declaring the turn finished.
    const IDLE_DONE_MS = 12000;
    let busy = false;
    let idleTimer: number | null = null;
    let recent = ''; // rolling buffer of recent output, for the summary

    const handler = (chunk: string) => {
      const s = String(chunk || '');
      if (!s) return;

      recent = (recent + s).slice(-6000);

      // (Re)arm the idle countdown on every output; when it elapses the turn is done.
      busy = true;
      if (idleTimer != null) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        idleTimer = null;
        if (!busy) return;
        busy = false;
        // Only notify if the user actually started something (not the startup banner).
        if (!taskPendingRef.current) { recent = ''; return; }
        taskPendingRef.current = false;
        recent = '';
        if (playSoundWhenDone) playBeep();
        // Dispatch a rich event; App.tsx fills in project/terminal names and renders
        // the in-app flash toast + (when backgrounded) the OS banner.
        const durationMs = taskStartedAtRef.current ? Date.now() - taskStartedAtRef.current : 0;
        window.dispatchEvent(new CustomEvent('octo-task-toast', {
          detail: {
            id: `${terminalId}-${Date.now()}`,
            terminalId,
            cliType,
            prompt: taskPromptRef.current || '',
            durationMs,
          },
        }));
      }, IDLE_DONE_MS);
    };

    state.onOutputChunk = handler;
    return () => {
      if (idleTimer != null) window.clearTimeout(idleTimer);
      const st = terminalStates.get(terminalId);
      if (st?.onOutputChunk === handler) st.onOutputChunk = undefined;
    };
  }, [cliType, playBeep, playSoundWhenDone, terminalId]);

  // onOutput prop → state.onOutputExternal
  useEffect(() => {
    const state = terminalStates.get(terminalId);
    if (state) state.onOutputExternal = onOutput;
    return () => {
      const st = terminalStates.get(terminalId);
      if (st && st.onOutputExternal === onOutput) st.onOutputExternal = undefined;
    };
  }, [onOutput, terminalId]);

  const writeLocal = useCallback((text: string) => {
    const term = termRef.current;
    if (!term) return;
    const normalized = normalizeNewlines(text);
    term.write(normalized);
    enqueueTelegramOutput(terminalId, normalized);
  }, [terminalId]);

  const writeClipboardTextSafe = useCallback(async (text: string) => {
    // Only ever called with terminal selection text — strip the trailing cell
    // padding (spaces/tabs) per line so the clipboard holds just the characters.
    const v = trimSelectionTrailingWhitespace(String(text || ''));
    if (!v) return;
    try {
      await clipboardWriteText(v);
      console.log('[Clipboard] writeClipboardText OK via tauri plugin');
      return;
    } catch (e) {
      console.warn('[Clipboard] tauri plugin write failed:', e);
    }
    try {
      await invoke('copy_to_clipboard', { text: v });
      console.log('[Clipboard] writeClipboardText OK via invoke');
      return;
    } catch (e) {
      console.warn('[Clipboard] invoke write failed:', e);
    }
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(v);
        console.log('[Clipboard] writeClipboardText OK via navigator');
        return;
      }
    } catch (e) {
      console.warn('[Clipboard] navigator write failed:', e);
    }
    // Final fallback for restricted clipboard contexts.
    try {
      const ta = document.createElement('textarea');
      ta.value = v;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
      document.body.removeChild(ta);
      if (ok) {
        console.log('[Clipboard] writeClipboardText OK via execCommand fallback');
        return;
      }
    } catch (e) {
      console.warn('[Clipboard] execCommand write failed:', e);
    }
    console.warn('[Clipboard] writeClipboardText: all methods failed');
  }, []);

  const readClipboardTextSafe = useCallback(async (): Promise<string> => {
    try {
      const t = await clipboardReadText();
      if (t) { console.log('[Clipboard] readClipboardText OK via tauri plugin, len=', t.length); return t; }
    } catch (e) {
      console.warn('[Clipboard] tauri plugin read failed:', e);
    }
    try {
      const t = await invoke<string>('read_clipboard_text');
      if (t) { console.log('[Clipboard] readClipboardText OK via invoke, len=', t.length); return t; }
    } catch (e) {
      console.warn('[Clipboard] invoke read failed:', e);
    }
    try {
      if (navigator?.clipboard?.readText) {
        const t = await navigator.clipboard.readText();
        if (t) { console.log('[Clipboard] readClipboardText OK via navigator, len=', t.length); return t; }
      }
    } catch (e) {
      console.warn('[Clipboard] navigator read failed:', e);
    }
    console.warn('[Clipboard] readClipboardText: all methods failed, returning empty');
    return '';
  }, []);

  const maybeMirrorCommandToTelegram = useCallback((rawCommand: string) => {
    if (!telegram?.enabled || !telegram.mirrorCommands) return;
    const cmd = (rawCommand || '').trim();
    if (!cmd) return;
    const label = telegram?.label ? `[${telegram.label}] ` : '';
    telegramSendBestEffort(`${label}$ ${redactTelegramSecrets(cmd)}`, telegram.botToken, telegram.chatId);
  }, [telegram?.enabled, telegram?.mirrorCommands, telegram?.label, telegram?.chatId, telegram?.botToken]);

  // Track Cmd/Ctrl so terminal links only light up while the modifier is held.
  useEffect(() => {
    const sync = (e: KeyboardEvent) => { cmdHeldRef.current = e.metaKey || e.ctrlKey; };
    const clear = () => { cmdHeldRef.current = false; };
    window.addEventListener('keydown', sync, true);
    window.addEventListener('keyup', sync, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', sync, true);
      window.removeEventListener('keyup', sync, true);
      window.removeEventListener('blur', clear);
    };
  }, []);

  // Line buffer for skill detection in CLI terminals (claude/codex/kimi)
  const lineBufferRef = useRef('');
  // Shell line buffer for auto-saving prompts to library
  const shellLineBufferRef = useRef('');

  const sendToPty = useCallback((data: string) => {
    // A submitted line (Enter) means the user kicked off work — arm the
    // "task completed" notification for the next idle period.
    if (/[\r\n]/.test(data)) taskPendingRef.current = true;

    // In ollama chat mode, feed data into the chat input handler
    if (ollamaModeActiveRef.current && ollamaInputHandlerRef.current) {
      ollamaInputHandlerRef.current(data);
      return;
    }

    // ── Skill interception (Claude only): "/" prefix → intercept on Enter ──
    // Codex uses native $skill system via .agents/skills/ — no interception needed
    if (onRunSkill && cliType === 'claude') {
      const isEnter = data === '\x0d' || data === '\n' || data === '\r';
      const hasNewline = !isEnter && /[\r\n]/.test(data);

      if (!isEnter && !hasNewline) {
        if (data === '\x7f' || data === '\b') {
          lineBufferRef.current = lineBufferRef.current.slice(0, -1);
        } else if (data === '\x15' || data === '\x03') {
          lineBufferRef.current = '';
        } else if (data.length > 0 && data.charCodeAt(0) >= 32) {
          lineBufferRef.current += data;
        }
      }

      if (isEnter || hasNewline) {
        if (hasNewline && data.length > 1) {
          const textBefore = data.split(/[\r\n]/)[0] || '';
          if (textBefore) lineBufferRef.current += textBefore;
        }
        let line = lineBufferRef.current.trim().normalize('NFC');
        lineBufferRef.current = '';

        // Fallback: read current line from xterm screen if lineBuffer is empty
        if (!line) {
          const term = termRef.current;
          if (term) {
            const bufY = term.buffer.active.baseY + term.buffer.active.cursorY;
            const row = term.buffer.active.getLine(bufY);
            if (row) {
              const raw = row.translateToString(true).normalize('NFC');
              const m = raw.match(/\/[^\s/].*$/);
              if (m) line = m[0].trim();
            }
          }
        }

        if (line.startsWith('/') && !line.startsWith('//')) {
          const query = line.slice(1).trim();
          const qLower = query.toLowerCase().normalize('NFC');
          const qNorm = qLower.replace(/\s+/g, '-');

          const skill = skills?.find(s => {
            const sid = s.id.toLowerCase().normalize('NFC');
            const sname = s.name.toLowerCase().normalize('NFC');
            const sdesc = s.description.toLowerCase().normalize('NFC');
            return sid === qLower || sid === qNorm || sid === query
              || sname === qLower || sname.replace(/\s+/g, '-') === qNorm
              || sdesc === qLower || sdesc.replace(/\s+/g, '-') === qNorm;
          });

          if (skill) {
            const st = terminalStates.get(terminalId);
            st?.writeToPty?.('\x15');
            onRunSkill(skill);
            return;
          }
        }
      }
    }

    // ── Auto-save shell commands to Prompt Library ──
    {
      const hasNewline = /[\r\n]/.test(data);
      if (!hasNewline) {
        if (data === '\x7f' || data === '\b') {
          shellLineBufferRef.current = shellLineBufferRef.current.slice(0, -1);
        } else if (data === '\x15' || data === '\x03') {
          shellLineBufferRef.current = '';
        } else if (data.length > 0 && data.charCodeAt(0) >= 32) {
          shellLineBufferRef.current += data;
        }
      } else {
        // data may contain text + newline (e.g. "hello\r" from IME)
        const parts = data.split(/[\r\n]/);
        if (parts[0]) shellLineBufferRef.current += parts[0];
        let cmd = shellLineBufferRef.current.trim();
        shellLineBufferRef.current = '';
        // Fallback: 버퍼가 비면 xterm 화면에서 현재 라인 읽기
        if (!cmd) {
          const term = termRef.current;
          if (term) {
            const bufY = term.buffer.active.baseY + term.buffer.active.cursorY;
            const row = term.buffer.active.getLine(bufY);
            if (row) {
              const raw = row.translateToString(true).trim();
              // 프롬프트 기호 제거 ($ % > 등)
              const m = raw.match(/(?:[%$>›❯]\s*)(.+)/);
              if (m) cmd = m[1].trim();
            }
          }
        }
        // Capture the submitted prompt + start time for the task-complete toast.
        taskPromptRef.current = cmd;
        taskStartedAtRef.current = Date.now();
        if (cmd.length >= 2) {
          onCommandRef.current?.(cmd); // title a broker harness by its last command
        }
        if (cmd.length >= 3) {
          void savePromptToLibrary(cmd, workDir);
        }
      }
    }

    const st = terminalStates.get(terminalId);
    // 사용자가 입력하면 항상 뷰포트를 맨 아래로 내려 현재 입력 위치를 따라가게 유지
    if (st) {
      st.userScrolledUp = false;
      st.scrollOffsetFromBottom = 0;
      try { st.term?.scrollToBottom(); } catch { /* ignore */ }
      // CLI TUI(Claude 등)는 입력 후 약간의 지연 후 화면을 업데이트하므로 추가 스크롤
      requestAnimationFrame(() => {
        try { st.term?.scrollToBottom(); } catch { /* ignore */ }
      });
      setTimeout(() => {
        if (st) { st.userScrolledUp = false; st.scrollOffsetFromBottom = 0; }
        try { st.term?.scrollToBottom(); } catch { /* ignore */ }
      }, 150);
    }
    st?.writeToPty?.(data);
    enqueueTelegramCommandFromKeystrokes(terminalId, data);
    enqueueSlackCommandFromKeystrokes(terminalId, data);
  }, [terminalId, skills, onRunSkill, cliType, workDir]);

  // Native OS file drop routed from App.tsx (getCurrentWindow().onDragDropEvent).
  // The drop is matched to this terminal by id; we insert the real file paths.
  useEffect(() => {
    const onOsDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail as { terminalId?: string; paths?: string[] } | undefined;
      if (!detail || detail.terminalId !== terminalId) return;
      const paths = Array.isArray(detail.paths) ? detail.paths.filter(Boolean) : [];
      if (!paths.length) return;
      sendToPty(submitDroppedPaths(paths));
    };
    window.addEventListener('octo-terminal-os-drop', onOsDrop as EventListener);
    return () => window.removeEventListener('octo-terminal-os-drop', onOsDrop as EventListener);
  }, [terminalId, sendToPty]);

  const activeOllamaPullModelRef = useRef<string | null>(null);
  const ollamaPullUnlistenRef = useRef<(() => void) | null>(null);
  const lastOllamaPullPrintRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (ollamaPullUnlistenRef.current) {
        try {
          ollamaPullUnlistenRef.current();
        } catch {
          // ignore
        }
      }
      ollamaPullUnlistenRef.current = null;
    };
  }, []);

  const ensureOllamaPullListener = useCallback(() => {
    if (ollamaPullUnlistenRef.current) return;

    listen<any>('ollama_pull_progress', (event) => {
      const payload = (event as any)?.payload as any;
      const activeModel = activeOllamaPullModelRef.current;
      if (!payload || !activeModel) return;
      if (payload.model !== activeModel) return;

      // Throttle output a bit so we don't spam the terminal.
      const now = Date.now();
      if (now - lastOllamaPullPrintRef.current < 200) return;
      lastOllamaPullPrintRef.current = now;

      const status = payload.status ? String(payload.status) : '';
      const total = typeof payload.total === 'number' ? payload.total : null;
      const completed = typeof payload.completed === 'number' ? payload.completed : null;
      const pct =
        total && completed != null && total > 0 ? `${Math.floor((completed / total) * 100)}%` : '';
      const line = `[ollama] ${status}${pct ? ` (${pct})` : ''}${payload.error ? ` ERROR: ${payload.error}` : ''}`;
      writeLocal(`\r\n\x1b[90m${line}\x1b[0m\r\n`);

      if (payload.done) {
        activeOllamaPullModelRef.current = null;
        writeLocal(`\x1b[90m[ollama] pull finished\x1b[0m\r\n`);
      }
    })
      .then((unlisten) => {
        ollamaPullUnlistenRef.current = unlisten;
      })
      .catch(() => {
        // ignore
      });
  }, [writeLocal]);

  const tryRunOctoCommand = useCallback(async (rawInput: string): Promise<boolean> => {
    const input = rawInput.trim();
    if (!input.startsWith(':')) return false;

    const tokens = tokenizeArgs(input);
    const cmd = (tokens[0] || ':').slice(1).toLowerCase();
    const args = tokens.slice(1);

    const echo = () => {
      writeLocal(`\r\n\x1b[90m[octo]\x1b[0m ${input}\r\n`);
    };

    const printHelp = () => {
      writeLocal(
        [
          '\r\nOcto commands:',
          '  :help',
          '  :http <METHOD> <URL> [-H|--header \"Key: Value\"]... [-d|--data \"...\"]',
          '  :ollama models',
          '  :ollama chat <model> <prompt>',
          '  :ollama pull <model>',
          '  :gemini models',
          '  :gemini chat <model> <prompt>     (default model: gemini-1.5-flash)',
          '  :minimax models',
          '  :minimax chat <model> <prompt>',
          '',
        ].join('\r\n')
      );
    };

    echo();

    try {
      if (cmd === '' || cmd === 'help') {
        printHelp();
        return true;
      }

      if (cmd === 'http') {
        const method = (args[0] || '').toUpperCase();
        const url = args[1] || '';
        if (!method || !url) {
          writeLocal('Usage: :http <METHOD> <URL> [-H|--header \"Key: Value\"]... [-d|--data \"...\"]\r\n');
          return true;
        }

        const headers: Record<string, string> = {};
        let body: string | undefined;

        let i = 2;
        while (i < args.length) {
          const tok = args[i];
          if (tok === '-H' || tok === '--header') {
            const hv = args[i + 1];
            if (!hv) break;
            const idx = hv.indexOf(':');
            if (idx > 0) {
              const k = hv.slice(0, idx).trim();
              const v = hv.slice(idx + 1).trim();
              if (k) headers[k] = v;
            }
            i += 2;
            continue;
          }
          if (tok === '-d' || tok === '--data' || tok === '--body') {
            const bv = args[i + 1];
            body = bv ?? '';
            i += 2;
            continue;
          }
          if (tok.startsWith('-')) {
            writeLocal(`Unknown option: ${tok}\r\n`);
            return true;
          }
          // Treat remaining tokens as body.
          body = args.slice(i).join(' ');
          break;
        }

        const resp = await invoke<HttpResponseOutput>('http_request', {
          input: {
            method,
            url,
            headers,
            body: body == null ? null : body,
            timeout_ms: 30_000,
          },
        });

        const statusLine = `${resp.status} ${resp.status_text || ''}`.trim();
        writeLocal(`\x1b[1m${statusLine}\x1b[0m\r\n`);

        const headerLines = (resp.headers || [])
          .slice(0, 50)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');
        if (headerLines) {
          writeLocal(`\x1b[90m${headerLines}\x1b[0m\r\n`);
        }

        if (resp.body) {
          writeLocal(`${normalizeNewlines(resp.body)}\r\n`);
        }
        if (resp.truncated) {
          writeLocal('\x1b[90m[octo] response truncated\x1b[0m\r\n');
        }
        return true;
      }

      if (cmd === 'ollama') {
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'models') {
          const models = await invoke<OllamaTagModel[]>('ollama_list_models');
          if (!models?.length) {
            writeLocal('(no installed models)\r\n');
            return true;
          }
          const lines = models.map((m) => `- ${m.name}`).join('\r\n');
          writeLocal(`${lines}\r\n`);
          return true;
        }

        if (sub === 'chat') {
          const model = args[1];
          const prompt = args.slice(2).join(' ').trim();
          if (!model || !prompt) {
            writeLocal('Usage: :ollama chat <model> <prompt>\r\n');
            return true;
          }
          const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
          const reply = await invoke<string>('ollama_chat', { model, messages });
          writeLocal(`\r\n${normalizeNewlines(reply || '(empty response)')}\r\n`);
          return true;
        }

        if (sub === 'pull') {
          const model = args[1];
          if (!model) {
            writeLocal('Usage: :ollama pull <model>\r\n');
            return true;
          }
          ensureOllamaPullListener();
          activeOllamaPullModelRef.current = model;
          lastOllamaPullPrintRef.current = 0;
          writeLocal(`Starting pull: ${model}\r\n`);
          await invoke<void>('ollama_pull_model', { name: model });
          return true;
        }

        writeLocal('Usage: :ollama models | :ollama chat <model> <prompt> | :ollama pull <model>\r\n');
        return true;
      }

      if (cmd === 'gemini') {
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'models') {
          const models = await invoke<GeminiModelOption[]>('gemini_list_models');
          if (!models?.length) {
            writeLocal('(no models)\r\n');
            return true;
          }
          const lines = models.map((m) => `- ${m.id} (${m.name})`).join('\r\n');
          writeLocal(`${lines}\r\n`);
          return true;
        }
        if (sub === 'chat') {
          const model = args[1] || 'gemini-1.5-flash';
          const prompt = args.slice(2).join(' ').trim();
          if (!prompt) {
            writeLocal('Usage: :gemini chat <model> <prompt>\r\n');
            return true;
          }
          const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
          const reply = await invoke<string>('gemini_chat', { model, messages });
          writeLocal(`\r\n${normalizeNewlines(reply || '(empty response)')}\r\n`);
          return true;
        }
        writeLocal('Usage: :gemini models | :gemini chat <model> <prompt>\r\n');
        return true;
      }

      if (cmd === 'minimax') {
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'models') {
          const ids = await invoke<string[]>('minimax_list_models', { filter: null });
          if (!ids?.length) {
            writeLocal('(no models)\r\n');
            return true;
          }
          writeLocal(ids.map((id) => `- ${id}`).join('\r\n') + '\r\n');
          return true;
        }
        if (sub === 'chat') {
          const model = args[1];
          const prompt = args.slice(2).join(' ').trim();
          if (!model || !prompt) {
            writeLocal('Usage: :minimax chat <model> <prompt>\r\n');
            return true;
          }
          const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
          const reply = await invoke<string>('minimax_chat', { model, messages });
          writeLocal(`\r\n${normalizeNewlines(reply || '(empty response)')}\r\n`);
          return true;
        }
        writeLocal('Usage: :minimax models | :minimax chat <model> <prompt>\r\n');
        return true;
      }

      writeLocal(`Unknown octo command: ${cmd}. Type :help\r\n`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      writeLocal(`\x1b[31m[octo] error:\x1b[0m ${normalizeNewlines(msg)}\r\n`);
      return true;
    }
  }, [ensureOllamaPullListener, writeLocal]);

  const isTerminalVisible = useCallback(() => {
    const wrap = terminalWrapRef.current;
    if (!wrap) return false;
    // Check if the terminal wrapper is actually visible on screen (not hidden by viewMode)
    return wrap.offsetParent !== null;
  }, []);

  const focusActiveInput = useCallback(() => {
    // Don't steal focus if terminal is not visible (e.g. kanban, editor-only mode)
    if (!isTerminalVisible()) return;
    // Resume AudioContext from user gestures so later beeps are allowed.
    ensureAudio();
    if (useImeInput) inputRef.current?.focus({ preventScroll: true });
    else if (useTauriImeBridge) {
      // xterm may try to focus its own helper textarea on click; refocus ours on the next frame.
      imeBridgeRef.current?.focus({ preventScroll: true });
      requestAnimationFrame(() => imeBridgeRef.current?.focus({ preventScroll: true }));
    }
    else termRef.current?.focus();
  }, [ensureAudio, useImeInput, useTauriImeBridge, isTerminalVisible]);

  // Coming back from another app leaves typing dead until the terminal is clicked — see
  // attachWindowFocusRestore.
  useEffect(() => {
    const ownsFocus = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      if (el === inputRef.current || el === imeBridgeRef.current) return true;
      return terminalWrapRef.current?.contains(el) ?? false;
    };

    return attachWindowFocusRestore({
      win: window,
      ownsFocus,
      isDisposed: () => isDisposedRef.current,
      refocus: (isRetry) => {
        if (!isRetry && ownsFocus()) (document.activeElement as HTMLElement | null)?.blur();
        focusActiveInput();
      },
    });
  }, [focusActiveInput]);

  const updateScrollButtonVisibility = useCallback(() => {
    const term = terminalStates.get(terminalId)?.term || termRef.current;
    if (!term) {
      setShowScrollToBottom(false);
      return;
    }
    try {
      const activeBuffer = term.buffer.active as typeof term.buffer.active & { viewportY?: number };
      const viewportY = typeof activeBuffer.viewportY === 'number' ? activeBuffer.viewportY : activeBuffer.baseY;
      setShowScrollToBottom(viewportY < activeBuffer.baseY);
    } catch {
      setShowScrollToBottom(false);
    }
  }, [terminalId]);

  // Reopening/switching panes can race with fit/refresh timing. Retry a few times so the viewport
  // consistently lands on the latest output.
  const scrollActiveTerminalToBottom = useCallback((force = false) => {
    const doScroll = () => {
      const state = terminalStates.get(terminalId);
      const term = state?.term || termRef.current;
      if (!term) return;
      if (!force) {
        try {
          const buf = term.buffer.active;
          const atBottom = buf.viewportY >= buf.baseY;
          if (!atBottom) {
            setShowScrollToBottom(true);
            return;
          }
        } catch {
          // ignore
        }
      }
      try { term.scrollToBottom(); } catch { /* ignore */ }
      if (state) {
        state.userScrolledUp = false;
        state.scrollOffsetFromBottom = 0;
      }
      setShowScrollToBottom(false);
    };
    doScroll();
    requestAnimationFrame(doScroll);
    window.setTimeout(doScroll, 120);
    window.setTimeout(doScroll, 320);
  }, [terminalId]);

  const clearTerminalView = useCallback(() => {
    const term = terminalStates.get(terminalId)?.term || termRef.current;
    if (!term) return;
    try {
      term.clear();
      scrollActiveTerminalToBottom(true);
    } catch {
      // ignore
    }
    setShowScrollToBottom(false);
    if (cliType === 'bbarit') {
      const st = terminalStates.get(terminalId);
      st?.writeToPty?.('\x15/clear\x0d');
    }
    focusActiveInput();
  }, [cliType, focusActiveInput, scrollActiveTerminalToBottom, terminalId]);

  const clearTerminalInput = useCallback(() => {
    setInputValue('');
    setIsComposing(false);
    pendingSendOnCompositionEndRef.current = false;
    lineBufferRef.current = '';
    shellLineBufferRef.current = '';
    if (inputRef.current) inputRef.current.value = '';
    if (imeBridgeRef.current) imeBridgeRef.current.value = '';
    imeBridgeComposingRef.current = false;
    imeBridgeCompositionTextRef.current = '';
    setImePreeditText('');
    const st = terminalStates.get(terminalId);
    st?.writeToPty?.('\x05\x15');
    focusActiveInput();
  }, [focusActiveInput, terminalId]);

  // Codex is an inline TUI that keeps scrollback, so activating its tab could
  // land on a stale mid-buffer viewport. Snap to the latest output whenever a
  // codex terminal becomes the active tab (the user asked for focus = bottom).
  useEffect(() => {
    if (!isActive || cliType !== 'codex') return;
    scrollActiveTerminalToBottom(true);
  }, [isActive, cliType, scrollActiveTerminalToBottom]);

  // In bridge mode, xterm might steal focus (its helper textarea). Keep the bridge focused so input works.
  useEffect(() => {
    if (!useTauriImeBridge || !isActive) return;
    const wrap = terminalWrapRef.current;
    const bridge = imeBridgeRef.current;
    if (!wrap || !bridge) return;

    const helper = wrap.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    let refocusTimer: number | null = null;

    const refocusBridge = () => {
      // Debounce to avoid rapid-fire focus bouncing (causes cursor jumps in TUI apps like Kimi)
      if (refocusTimer != null) return;
      refocusTimer = window.setTimeout(() => {
        refocusTimer = null;
        if (!isActive) return;
        if (wrap.offsetParent === null) return;
        if (document.activeElement === bridge) return;
        try {
          bridge.focus({ preventScroll: true });
        } catch {
          // ignore
        }
      }, 50);
    };

    // If xterm's textarea gets focus, bounce focus back to our bridge.
    helper?.addEventListener('focus', refocusBridge, true);
    // On pointer interaction, keep focus on the bridge.
    wrap.addEventListener('pointerdown', refocusBridge, true);

    // Initial focus.
    refocusBridge();

    return () => {
      if (refocusTimer != null) window.clearTimeout(refocusTimer);
      helper?.removeEventListener('focus', refocusBridge, true);
      wrap.removeEventListener('pointerdown', refocusBridge, true);
    };
  }, [isActive, useTauriImeBridge]);

  // Global window-level handler for Ctrl+C (SIGINT) to ensure it always works in terminal
  // This runs in ALL modes (bridge and non-bridge) to guarantee Ctrl+C functionality
  useEffect(() => {
    if (!isActive) return;
    const wrap = terminalWrapRef.current;
    const term = termRef.current;
    if (!wrap || !term) {
      console.log('[SIGINT Debug] Effect skipped: wrap=', !!wrap, 'term=', !!term);
      return;
    }

    console.log('[SIGINT Debug] Installing global keydown handler for terminal:', terminalId);

    const onKeyDown = (e: KeyboardEvent) => {
      const k = getShortcutKey(e);
      const ctrl = e.ctrlKey;
      const meta = e.metaKey;
      
      // Log all key events for debugging
      if (k === 'c' && (ctrl || meta)) {
        console.log('[SIGINT Debug] Ctrl/Cmd+C detected:', { ctrl, meta, key: e.key, defaultPrevented: e.defaultPrevented });
      }
      
      // Check if event originated within this terminal.
      // Do not use activeElement here, otherwise shortcuts from other panes/editors
      // can be incorrectly treated as terminal shortcuts.
      const t = e.target as HTMLElement | null;
      const isInTerminalEl = (el: HTMLElement | null) =>
        !!el && (
          wrap.contains(el) ||
          !!el.closest?.('.xterm') ||
          !!el.closest?.('[data-terminal-scope]') ||
          !!el.closest?.('[data-terminal-wrap]') ||
          el === inputRef.current ||
          el === imeBridgeRef.current ||
          !!el.classList?.contains?.('xterm-helper-textarea')
        );
      const activeEl = document.activeElement as HTMLElement | null;
      const activeInThisTerminal = isInTerminalEl(activeEl);
      if (!activeInThisTerminal) return;
      const inThisTerminal = isInTerminalEl(t) || activeInThisTerminal;
      if (!inThisTerminal) {
        if (k === 'c' && (ctrl || meta)) {
          console.log('[SIGINT Debug] Event outside terminal, ignoring');
        }
        return;
      }
      
      if (k === 'c' && (ctrl || meta)) {
        console.log('[SIGINT Debug] Event in terminal, hasSelection:', term.hasSelection());
      }
      
      // Handle Ctrl+C at window level to ensure SIGINT always works in terminal
      if (ctrl && !meta && k === 'c') {
        // If text is selected, copy it directly. We stop the event so Ctrl+C does
        // not also reach the PTY as SIGINT.
        const inputEl = inputRef.current;
        if (
          activeEl === inputEl &&
          inputEl &&
          ((inputEl.selectionStart ?? 0) !== (inputEl.selectionEnd ?? 0))
        ) {
          return;
        }
        const sel = ((term.getSelection?.() || '') as string) || lastTerminalSelectionRef.current;
        if (sel) {
          console.log('[SIGINT Debug] Copying selection via native copy event');
          lastTerminalSelectionRef.current = sel;
          e.preventDefault();
          e.stopImmediatePropagation();
          void writeClipboardTextSafe(sel);
          return;
        }
        // No selection: send SIGINT
        console.log('[SIGINT Debug] Sending SIGINT to PTY');
        e.preventDefault();
        e.stopPropagation();
        sendToPty('\x03');
        return;
      }

      // Handle Cmd+C (macOS) for copy when text is selected
      if (meta && !ctrl && k === 'c') {
        const inputEl = inputRef.current;
        if (
          activeEl === inputEl &&
          inputEl &&
          ((inputEl.selectionStart ?? 0) !== (inputEl.selectionEnd ?? 0))
        ) {
          return;
        }
        const sel = (term.getSelection() || '') || lastTerminalSelectionRef.current;
        if (sel) {
          console.log('[SIGINT Debug] Cmd+C copying selection');
          lastTerminalSelectionRef.current = sel;
          e.preventDefault();
          e.stopImmediatePropagation();
          void writeClipboardTextSafe(sel);
          return;
        }
        // No selection: let default behavior (usually nothing in terminal)
        console.log('[SIGINT Debug] Cmd+C with no selection, letting through');
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    console.log('[SIGINT Debug] Handler installed');
    return () => {
      console.log('[SIGINT Debug] Handler removed');
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isActive, sendToPty, writeClipboardTextSafe, terminalId]);

  // Paste fallback: prefer native paste events, but if WebView fails to emit one for Ctrl/Cmd+V,
  // read clipboard text and inject it after a short delay.
  useEffect(() => {
    if (!isActive) return;
    const wrap = terminalWrapRef.current;
    if (!wrap) return;

    const isEditable = (el: HTMLElement | null) => {
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
    };
    const inThisTerminal = (el: HTMLElement | null) =>
      !!el && (
        wrap.contains(el) ||
        !!el.closest?.('.xterm') ||
        !!el.closest?.('[data-terminal-scope]') ||
        !!el.closest?.('[data-terminal-wrap]') ||
        el === inputRef.current ||
        el === imeBridgeRef.current ||
        !!el.classList?.contains?.('xterm-helper-textarea')
      );
    const insertIntoImeInput = (text: string) => {
      const el = inputRef.current;
      if (!el) return false;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`;
      setInputValue(next);
      requestAnimationFrame(() => {
        try {
          el.focus({ preventScroll: true });
          const pos = start + text.length;
          el.setSelectionRange(pos, pos);
        } catch {
          // ignore
        }
      });
      return true;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const k = getShortcutKey(e);
      const key = e.key;
      const ctrl = e.ctrlKey;
      const meta = e.metaKey;
      const shift = e.shiftKey;
      const isPasteShortcut =
        (meta && k === 'v') ||
        (ctrl && !meta && !e.altKey && k === 'v') ||
        (shift && key === 'Insert' && !ctrl && !meta);
      if (!isPasteShortcut) return;

      const target = e.target as HTMLElement | null;
      const activeEl = document.activeElement as HTMLElement | null;
      const inTerm = inThisTerminal(activeEl) || inThisTerminal(target);
      // Never hijack paste that belongs to an external editable (Monaco/CodeMirror editor,
      // settings inputs, modal fields): let that element paste natively.
      if (!inTerm && (isEditable(activeEl) || isEditable(target))) {
        return;
      }
      // Focus-drift fallback: the user copied elsewhere and pressed Ctrl+V WITHOUT first
      // clicking the terminal, so focus sits on <body>/a non-editable element. This effect
      // already runs only for the single active terminal (isActive gate above), so route the
      // paste here — but skip when the terminal panel is hidden (editor-only/kanban view),
      // matching the user's intent rather than silently dropping the paste.
      if (!inTerm && !isTerminalVisible()) {
        return;
      }

      e.preventDefault();
      e.stopImmediatePropagation();
      if (pendingPasteFallbackTimerRef.current != null) {
        window.clearTimeout(pendingPasteFallbackTimerRef.current);
        pendingPasteFallbackTimerRef.current = null;
      }
      void (async () => {
        try {
          console.log('[ClipDebug] Ctrl/Cmd+V: reading clipboard directly');
          const text = await readClipboardTextSafe();
          if (!text) {
            // No text on the clipboard — it may hold an image. Only auto-save +
            // insert the clipboard image when focus is genuinely IN this
            // terminal. The focus-drift fallback (paste without clicking the
            // terminal) is fine for TEXT, but for images it means the user is
            // very likely pasting a screenshot somewhere ELSE (the browser
            // view, another input, or an external app) — hijacking it would
            // dump `'C:\...\clipboard_x.png'` into the terminal against intent.
            // Exception (issue mac#3): right after an interactive screenshot the
            // focus sits on <body> with no click in between — that IS the
            // "capture → Cmd+V into the terminal" flow, so allow neutral focus.
            if (!inTerm) {
              const neutralFocus = !activeEl || activeEl === document.body || activeEl === document.documentElement;
              if (!neutralFocus) {
                return;
              }
            }
            // HTML-only 클립보드(일부 앱의 리치 복사): 이미지 폴백 전에 HTML을
            // 텍스트(표는 마크다운 파이프)로 변환해 붙여넣는다.
            try {
              const items = await navigator.clipboard?.read?.();
              for (const item of items || []) {
                if (!item.types?.includes('text/html')) continue;
                const html = await (await item.getType('text/html')).text();
                const converted = htmlClipboardToText(html);
                if (converted) {
                  void writePasteChunked(sendToPty, normalizeInputNewlines(converted));
                  console.log('[ClipDebug] Ctrl/Cmd+V: pasted converted text/html');
                  return;
                }
              }
            } catch {
              // async clipboard read unavailable — continue to image fallback
            }
            // The internal bbarit agent TUI recognises a leading `@<path>` with
            // an image extension as a vision attachment WITHOUT auto-submitting;
            // other CLIs expect a bare, shell-quoted path + Enter.
            try {
              const filePath = await invoke<string>('save_clipboard_image_from_system_clipboard');
              if (filePath) {
                console.log('[ClipDebug] Ctrl/Cmd+V: pasted clipboard image →', filePath);
                sendToPty(isBbaritAgentCli(cliType) ? bbaritImageToken(filePath) : submitDroppedPaths([filePath]));
              }
            } catch {
              // No image in clipboard either — nothing to paste.
            }
            return;
          }
          if (useImeInput && document.activeElement === inputRef.current) {
            if (insertIntoImeInput(text)) {
              console.log('[ClipDebug] Ctrl/Cmd+V: inserted into IME input');
              return;
            }
          }
          const normalized = normalizeInputNewlines(text);
          void writePasteChunked(sendToPty, normalized);
          console.log('[ClipDebug] Ctrl/Cmd+V: sent to PTY (chunked)');
        } catch {
          // ignore
        }
      })();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (pendingPasteFallbackTimerRef.current != null) {
        window.clearTimeout(pendingPasteFallbackTimerRef.current);
        pendingPasteFallbackTimerRef.current = null;
      }
    };
  }, [isActive, readClipboardTextSafe, sendToPty, useImeInput, isTerminalVisible]);

  // In bridge mode, keep xterm's composition-view hidden at all times.
  // xterm's CompositionHelper adds ".active" class on compositionstart which sets display:block,
  // overriding our CSS. Use MutationObserver to force it hidden whenever xterm activates it.
  useEffect(() => {
    if (!useTauriImeBridge || !isActive) return;
    const wrap = terminalWrapRef.current;
    if (!wrap) return;

    const hideCompView = () => {
      const views = wrap.querySelectorAll<HTMLElement>('.composition-view');
      for (const el of Array.from(views)) {
        if (el.style.display !== 'none') {
          el.style.display = 'none';
          el.style.opacity = '0';
        }
      }
    };

    hideCompView();

    const observer = new MutationObserver(() => hideCompView());
    observer.observe(wrap, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });

    return () => observer.disconnect();
  }, [isActive, useTauriImeBridge]);

  // Safety net: if focus is lost (or never acquired) in bridge mode, typing can feel "dead"
  // because xterm stdin is disabled. Re-focus the bridge on the next keystroke.
  useEffect(() => {
    if (!useTauriImeBridge || !isActive) return;
    const bridge = imeBridgeRef.current;
    const wrap = terminalWrapRef.current;
    if (!bridge || !wrap) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Don't steal focus if terminal is not visible
      if (wrap.offsetParent === null) return;
      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl === bridge) return;

      // Don't steal focus from other UI inputs/editors outside this terminal.
      const isOtherInput = activeEl && (
        (activeEl.tagName === 'INPUT' && activeEl !== bridge) ||
        (activeEl.tagName === 'TEXTAREA' && activeEl !== bridge) ||
        (activeEl as HTMLElement).isContentEditable
      );
      if (isOtherInput && !activeEl?.closest?.('.xterm')) return;

      // If the event originated outside this terminal, ignore.
      const t = e.target as HTMLElement | null;
      if (t && !wrap.contains(t) && !t.closest?.('.xterm')) return;

      try { bridge.focus({ preventScroll: true }); } catch { /* ignore */ }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isActive, useTauriImeBridge]);

  // Bridge mode safety net for copy/paste/select-all when focus momentarily drifts.
  // This keeps Cmd/Ctrl shortcuts reliable without hijacking non-terminal inputs.
  useEffect(() => {
    if (!useTauriImeBridge || !isActive) return;
    const wrap = terminalWrapRef.current;
    if (!wrap) return;

    const isEditable = (el: HTMLElement | null) => {
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
    };
    const inThisTerminal = (el: HTMLElement | null) => {
      if (!el) return false;
      return (
        wrap.contains(el) ||
        !!el.closest?.('.xterm') ||
        !!el.closest?.('[data-terminal-scope]') ||
        !!el.closest?.('[data-terminal-wrap]') ||
        el === imeBridgeRef.current ||
        !!el.classList?.contains?.('xterm-helper-textarea')
      );
    };

    const onWindowKeyDown = (e: KeyboardEvent) => {
      const key = e.key;
      const k = getShortcutKey(e);
      const ctrl = e.ctrlKey;
      const shift = e.shiftKey;
      const meta = e.metaKey;

      const isCopy =
        (meta && k === 'c') ||
        (ctrl && !meta && !e.altKey && (k === 'c' || (shift && k === 'c') || key === 'Insert'));
      const isPaste =
        (meta && k === 'v') ||
        (ctrl && !meta && !e.altKey && k === 'v') ||
        (shift && key === 'Insert' && !ctrl && !meta);
      const isCut = meta && k === 'x';
      const isSelectAll = meta && k === 'a';
      if (!isCopy && !isPaste && !isCut && !isSelectAll) return;

      console.log('[ClipDebug] bridge onWindowKeyDown:', { isCopy, isPaste, isCut, isSelectAll, key, defaultPrevented: e.defaultPrevented, target: (e.target as HTMLElement)?.tagName });

      const target = e.target as HTMLElement | null;
      const activeEl = document.activeElement as HTMLElement | null;
      // Never hijack shortcuts unless this terminal currently owns focus.
      if (!inThisTerminal(activeEl)) {
        return;
      }
      // Never hijack shortcuts coming from outside this terminal.
      if (!inThisTerminal(target) && !inThisTerminal(activeEl)) {
        return;
      }

      // For paste: don't intercept. Let the native paste event flow through.
      // The container-level paste handler (handlePaste on terminalWrapRef) will
      // catch it synchronously via clipboardData.getData('text/plain').
      if (isPaste) {
        console.log('[ClipDebug] bridge: letting paste through to native handler');
        return;
      }

      // Respect external editors/inputs (settings panel, modals, etc).
      if ((isEditable(target) && !inThisTerminal(target)) || (isEditable(activeEl) && !inThisTerminal(activeEl))) {
        return;
      }

      const term = termRef.current;

      if (isSelectAll) {
        if (!term) return;
        e.preventDefault();
        term.selectAll();
        return;
      }

      if (isCopy || isCut) {
        const selected = term?.getSelection() || window.getSelection()?.toString() || '';
        if (selected) {
          // Don't preventDefault — let native copy event fire (handleCopy listener will set clipboard)
          void writeClipboardTextSafe(selected);
          return;
        }
        // Ctrl+C with no selection should still interrupt.
        if (ctrl && !meta && !e.altKey && k === 'c') {
          e.preventDefault();
          sendToPty('\x03');
        }
        return;
      }
    };

    window.addEventListener('keydown', onWindowKeyDown, true);
    return () => window.removeEventListener('keydown', onWindowKeyDown, true);
  }, [isActive, sendToPty, useTauriImeBridge, writeClipboardTextSafe]);

  // In direct shell mode on macOS WebKit, keep xterm's hidden helper textarea near the real cursor
  // so native IME preedit/candidate UI doesn't drift to screen edges.
  useEffect(() => {
    if (!isActive) return;
    if (IME_SAFE_MODE) return;
    if (useTauriImeBridge || useImeInput) return;
    if (!isImeBridgePlatform) return;

    const wrap = terminalWrapRef.current;
    const term = termRef.current as any;
    if (!wrap || !term) return;

    let raf: number | null = null;
    const disposables: Array<{ dispose: () => void }> = [];

    const placeHelper = () => {
      if (raf != null) return;
      raf = window.requestAnimationFrame(() => {
        raf = null;
        const helper = wrap.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        if (!helper) return;

        const dims = term?._core?._renderService?.dimensions;
        const cellW =
          typeof dims?.actualCellWidth === 'number' && dims.actualCellWidth > 0
            ? dims.actualCellWidth
            : typeof dims?.css?.cell?.width === 'number' && dims.css.cell.width > 0
              ? dims.css.cell.width
              : null;
        const cellH =
          typeof dims?.actualCellHeight === 'number' && dims.actualCellHeight > 0
            ? dims.actualCellHeight
            : typeof dims?.css?.cell?.height === 'number' && dims.css.cell.height > 0
              ? dims.css.cell.height
              : null;
        if (!cellW || !cellH) return;

        const x = typeof term?.buffer?.active?.cursorX === 'number' ? term.buffer.active.cursorX : 0;
        const y = typeof term?.buffer?.active?.cursorY === 'number' ? term.buffer.active.cursorY : 0;

        // CRITICAL: Position helper EXACTLY at cursor position (not below)
        // This ensures Korean/Chinese/Japanese composition appears exactly at cursor
        const cursorLeft = Math.max(0, Math.round(x * cellW));
        const cursorTop = Math.max(0, Math.round(y * cellH));

        helper.style.position = 'absolute';
        helper.style.left = `${cursorLeft}px`;
        helper.style.top = `${cursorTop}px`;
        // Size should match character cell for precise composition
        helper.style.width = `${cellW}px`;
        helper.style.height = `${cellH}px`;
        // Nearly invisible. Must NOT capture the mouse, or it breaks text selection;
        // IME is keyboard/focus based, so pointer-events: none is safe.
        helper.style.opacity = '0.01';
        helper.style.zIndex = '100';
        helper.style.pointerEvents = 'none';
        helper.style.border = '0';
        helper.style.outline = 'none';
        helper.style.boxShadow = 'none';
        helper.style.background = 'transparent';
        helper.style.color = 'transparent';
        helper.style.caretColor = 'transparent';
        helper.style.fontFamily = 'inherit';
        helper.style.fontSize = 'inherit';
        helper.style.lineHeight = 'inherit';
        (helper.style as CSSStyleDeclaration & { WebkitTextFillColor?: string }).WebkitTextFillColor = 'transparent';
        helper.style.fontSize = '1px';
        helper.style.lineHeight = '1';
        helper.style.padding = '0';
        helper.style.margin = '0';
        helper.style.resize = 'none';
        helper.style.overflow = 'hidden';
      });
    };

    placeHelper();
    try { disposables.push(term.onCursorMove(placeHelper)); } catch { /* ignore */ }
    try { disposables.push(term.onRender(() => placeHelper())); } catch { /* ignore */ }
    const id = window.setInterval(placeHelper, 500);

    return () => {
      if (raf != null) window.cancelAnimationFrame(raf);
      window.clearInterval(id);
      for (const d of disposables) {
        try { d.dispose(); } catch { /* ignore */ }
      }
    };
  }, [isActive, isImeBridgePlatform, useImeInput, useTauriImeBridge]);

  const getSelectionColor = (accent?: string) => {
    if (!accent || !accent.startsWith('#') || (accent.length !== 7 && accent.length !== 4)) return undefined;
    const hex = accent.length === 4
      ? `#${accent[1]}${accent[1]}${accent[2]}${accent[2]}${accent[3]}${accent[3]}`
      : accent;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, 0.35)`;
  };

  // ANSI 16-color palette: imported themes (Ghostty/Warp) carry their own palette in
  // style.ansi; built-in themes fall back to the Catppuccin Mocha palette.
  const getAnsiTheme = (ansi?: string[]) => {
    const p = Array.isArray(ansi) && ansi.length >= 16 ? ansi : null;
    return {
      black: p?.[0] || '#45475a',
      red: p?.[1] || '#f38ba8',
      green: p?.[2] || '#a6e3a1',
      yellow: p?.[3] || '#f9e2af',
      blue: p?.[4] || '#89b4fa',
      magenta: p?.[5] || '#f5c2e7',
      cyan: p?.[6] || '#94e2d5',
      white: p?.[7] || '#bac2de',
      brightBlack: p?.[8] || '#585b70',
      brightRed: p?.[9] || '#f38ba8',
      brightGreen: p?.[10] || '#a6e3a1',
      brightYellow: p?.[11] || '#f9e2af',
      brightBlue: p?.[12] || '#89b4fa',
      brightMagenta: p?.[13] || '#f5c2e7',
      brightCyan: p?.[14] || '#94e2d5',
      brightWhite: p?.[15] || '#ffffff',
    };
  };

  useEffect(() => {
    const mount = terminalMountRef.current;
    const wrap = terminalWrapRef.current;
    if (!mount || !wrap || initRef.current) return;

    initRef.current = true;
    isDisposedRef.current = false;
    isReadyRef.current = false;

    // Check existing terminal state
    const existingState = terminalStates.get(terminalId);
    const effectiveShellType = shellType || undefined;
    const shellTypeChanged = existingState?.shellType !== effectiveShellType;
    const canReuseTerminalState = !!existingState?.term
      && !!existingState.terminalElement
      // Changing the global terminal shell setting must not kill an already
      // running agent session. Apply shell-type changes only before PTY creation.
      && (!shellTypeChanged || !!existingState.ptyCreated);
    const shouldResetExistingPty = !!existingState && !canReuseTerminalState;
    let term: Terminal;
    let fitAddon: FitAddon;
    let ptyAlreadyExists = false;
    let terminalReused = false;

    if (shouldResetExistingPty) {
      try { existingState.inputDisposable?.dispose(); } catch { /* ignore */ }
      try { existingState.ptyDataUnlisten?.(); } catch { /* ignore */ }
      try { existingState.ptyExitUnlisten?.(); } catch { /* ignore */ }
      try { existingState.term?.dispose(); } catch { /* ignore */ }
      terminalStates.delete(terminalId);
    }

    if (canReuseTerminalState && existingState?.term && existingState.terminalElement) {
      // Reuse existing terminal - move fixed DOM element to new container
      term = existingState.term;
      fitAddon = existingState.fitAddon!;
      ptyAlreadyExists = existingState.ptyCreated;
      terminalReused = true;

      // Get fixed DOM element from store and place in new container
      const terminalElement = existingState.terminalElement;
      terminalElement.style.cssText = 'width:100%;height:100%;overflow:hidden;';
      // Update cliType data attribute for CSS targeting
      terminalElement.setAttribute('data-clitype', cliType);
      terminalElement.setAttribute('data-shelltype', effectiveShellType || '');
      if (terminalElement.parentElement !== mount) {
        mount.appendChild(terminalElement);
      }
      if (useTauriImeBridge) fixWebKitImeForXterm(wrap);

      // Refresh and fit immediately after DOM move (restore terminal content)
      requestAnimationFrame(() => {
        try {
          preserveTerminalViewport(term, existingState, () => {
            fitAddon.fit();
            term.refresh(0, term.rows - 1);
          }, true, true);
        } catch {
          // ignore
        }
      });

      termRef.current = term;
      fitRef.current = fitAddon;
      searchAddonRef.current = existingState.searchAddon;
    } else {
      // Create new terminal - render in fixed DOM element
      const terminalElement = document.createElement('div');
      terminalElement.style.cssText = 'width:100%;height:100%;overflow:hidden;';
      // Add cliType as data attribute for CSS targeting
      terminalElement.setAttribute('data-clitype', cliType);
      terminalElement.setAttribute('data-shelltype', effectiveShellType || '');
      mount.appendChild(terminalElement);

      const isWindows = navigator.platform?.startsWith('Win') || navigator.userAgent.includes('Windows');
      term = new Terminal({
        cols: 80,
        rows: 24,
        fontSize: fontSize,
        fontFamily: fontFamily || TERMINAL_FONT_FAMILY,
        cursorBlink: cursorBlink,
        cursorStyle: cursorStyle,
        // Keep the cursor visible even when the xterm textarea isn't focused.
        // (In Tauri IME-bridge mode, the hidden textarea holds focus.)
        cursorInactiveStyle: cursorStyle,
        disableStdin: useImeInput || useTauriImeBridge,
        allowProposedApi: true,
        // Windows: enable proper Alt key handling so Alt+M etc. pass through to CLI (#43)
        windowsMode: isWindows,
	        theme: {
	          background: style?.bg || '#1e1e2e',
	          foreground: style?.text || '#cdd6f4',
	          // Use text color for the cursor so it's visible in both light/dark themes.
	          cursor: style?.cursor || style?.text || '#cdd6f4',
	          cursorAccent: style?.bg || '#1e1e2e',
	          selectionBackground: style?.selectionBg || getSelectionColor(style?.accent),
          ...getAnsiTheme(style?.ansi),
        },
        scrollback: scrollback,
        allowTransparency: true,
        // 다크 테마에서 프로그램이 검정/어두운 색으로 글자를 출력하면 배경과
        // 대비가 낮아 안 보이던 문제(사용자 실측) — xterm이 전경/배경 대비가
        // 이 비율 미만이면 자동으로 전경색을 조정해 항상 읽히게 한다. 대비가
        // 충분한 정상 색은 건드리지 않으므로 테마 느낌은 유지된다(WCAG AA 4.5).
        minimumContrastRatio: 4.5,
      });

      fitAddon = new FitAddon();
      const unicode11Addon = new Unicode11Addon();
      const searchAddon = new SearchAddon();

      term.open(terminalElement);
      
      // Position helper textarea at cursor for natural OS IME composition
      if (cursorOverlay) {
        fixWebKitImeForXterm(wrap, cursorOverlay.left, cursorOverlay.top, cursorOverlay.cellW, cursorOverlay.cellH);
      } else {
        fixWebKitImeForXterm(wrap);
      }
      
      // Let xterm handle composition naturally - don't interfere

      term.loadAddon(fitAddon);
      term.loadAddon(unicode11Addon);
      term.loadAddon(searchAddon);
      // iTerm2-style links: Cmd/Ctrl+click opens URLs in the browser and local
      // files in the editor. The returned disposable is stored in the webLinksAddon
      // slot so existing cleanup tears it down.
      const webLinksAddon = term.registerLinkProvider(createTerminalLinkProvider(term, {
        isModifierHeld: () => cmdHeldRef.current,
        openUrl: (uri) => {
          // window.open is blocked in WebView, so route through the Tauri shell plugin.
          invoke('plugin:shell|open', { path: uri }).catch(() => {
            window.open(uri, '_blank');
          });
        },
        openPath: (path, line) => {
          window.dispatchEvent(new CustomEvent('octo-open-terminal-path', {
            detail: { path, line, workDir },
          }));
        },
      }));
      // OSC 52: TUIs that grab the mouse (Claude/Codex CLI, tmux set-clipboard,
      // vim) copy by emitting OSC 52 — without a handler xterm drops it silently,
      // so their "copied" toast lies (issue mac#2). Mirror it into the OS
      // clipboard. Disposed with the terminal, no manual cleanup needed.
      term.parser.registerOscHandler(52, (data) => {
        const text = decodeOsc52Payload(data);
        if (text) void writeClipboardTextSafe(text);
        return true;
      });
      term.unicode.activeVersion = '11';

      termRef.current = term;
      fitRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      // Save to global state (including terminalElement and all addon refs for cleanup)
      terminalStates.set(terminalId, { ptyCreated: false, term, fitAddon, searchAddon, webglAddon: null, unicode11Addon, webLinksAddon, terminalElement, readLoopActive: true, writeToPty: null, inputMode, shellType: effectiveShellType, inputDisposable: null });
    }

    // Ensure newer state fields exist on reused terminals.
    const ensured = terminalStates.get(terminalId);
    if (ensured) {
      ensured.inputMode = inputMode;
      ensured.readLoopActive = true;  // Reset read loop flag on terminal reuse
      if (ensured.inputDisposable === undefined) ensured.inputDisposable = null;
      if (ensured.telegramCmdBuffer === undefined) ensured.telegramCmdBuffer = '';
      if (ensured.ptyDataUnlisten === undefined) ensured.ptyDataUnlisten = null;
      if (ensured.ptyExitUnlisten === undefined) ensured.ptyExitUnlisten = null;
      if (ensured.usesEventTransport === undefined) ensured.usesEventTransport = false;
      if (ensured.cliLaunchFailure === undefined) ensured.cliLaunchFailure = null;
      ensured.cliLaunchFailureHandler = (kind) => setCliInstallFailure(kind);
      if (ensured.cliLaunchFailure) setCliInstallFailure(ensured.cliLaunchFailure);
      try {
        const buf = ensured.term?.buffer.active;
        const dist = buf ? Math.max(0, buf.baseY - buf.viewportY) : 0;
        ensured.userScrolledUp = dist > 0;
        ensured.scrollOffsetFromBottom = dist;
      } catch {
        ensured.userScrolledUp = !!ensured.userScrolledUp;
        ensured.scrollOffsetFromBottom = Math.max(0, ensured.scrollOffsetFromBottom || 0);
      }
    }

    // The active-tab effect can run before a newly mounted/restored xterm exists
    // and exhaust its short retry window. Re-assert Codex's latest-output view
    // here, after the terminal has definitely been created or reattached.
    if (isActive && cliType === 'codex') {
      scrollActiveTerminalToBottom(true);
    }

    let disposed = false;
    // Startup once-gate rollback: autoStartedCliType is pre-set synchronously so a
    // remount within the startup delay can't double-inject. But if THIS mount disposes
    // before the delayed write fires (StrictMode double-mount, harness-window remount,
    // layout churn), the write is lost yet the gate stays set in the shared state map —
    // and the remount then skips injection, so the CLI never starts (raw shell forever).
    // Track whether the write actually fired; if not, roll the gate back on dispose.
    let startupGatePreset = false;
    let startupWriteFired = false;
    const isTauri = (() => {
      const w = window as unknown as Record<string, unknown>;
      return ('__TAURI__' in w) || ('__TAURI_INTERNALS__' in w);
    })();
    let webglAddon: WebglAddon | null = null;

    // Fix font issues in Tauri WebKit: force-modify DOM styles
    const actualFontFamily = fontFamily || TERMINAL_FONT_FAMILY;
    const fixTerminalStyle = () => {
      wrap.style.fontFamily = actualFontFamily;
      const rows = wrap.querySelector('.xterm-rows') as HTMLElement;
      if (rows) {
        rows.style.fontSize = `${fontSize}px`;
        rows.style.fontFamily = actualFontFamily;
        rows.style.lineHeight = 'normal';
      }
      // Apply font to xterm-screen as well
      const screen = wrap.querySelector('.xterm-screen') as HTMLElement;
      if (screen) {
        screen.style.fontFamily = actualFontFamily;
      }
    };

    let lastFitKey = '';
    let lastFitAt = 0;
    // Safe fit function - checks minimum size and coalesces duplicate transition-time refreshes.
    const safeFit = (force = false) => {
      if (disposed || !fitRef.current || !wrap || !termRef.current) return;
      const fitHost = terminalMountRef.current || wrap;
      if (fitHost.offsetWidth < 100 || fitHost.offsetHeight < 100) return;
      const fitKey = `${fitHost.offsetWidth}x${fitHost.offsetHeight}:${fontSize}:${actualFontFamily}`;
      const now = Date.now();
      if (!force && fitKey === lastFitKey && now - lastFitAt < 250) {
        fixTerminalStyle();
        return;
      }
      lastFitKey = fitKey;
      lastFitAt = now;
      try {
        const state = terminalStates.get(terminalId);
        preserveTerminalViewport(termRef.current, state, () => {
          fitRef.current?.fit();
          termRef.current?.refresh(0, termRef.current.rows - 1);
          fixTerminalStyle();
        }, true, true);
      } catch {
        // ignore fit error
      }
    };

    // Initial font-size fix
    setTimeout(fixTerminalStyle, 50);
    // If fonts load late, xterm's character width/height calculations can be off, so fit again.
    // (especially in Tauri/WebKit where bundled woff2 loading timing can be inconsistent)
    const fontsReady = (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
    if (fontsReady && typeof (fontsReady as any).then === 'function') {
      fontsReady.then(() => {
        if (disposed) return;
        safeFit(true);
      }).catch(() => {});
    }

    // Load WebGL renderer.
    // D2: Tauri에서는 역사적으로 전면 비활성(초기 WKWebView IME/커서 이슈)이었으나, DOM 렌더러는
    // 에이전트 스트리밍 출력에서 렌더러 CPU를 코어 1.5개+ 점유(2026-07 실측)해 시스템 전체를 버벅이게 함.
    // Windows WebView2는 WebGL 정상 동작을 실측 확인 → Windows에 한해 활성화, macOS(WKWebView)는 기존 유지.
    // 탈출구: 생성 실패 시 try/catch로 DOM 렌더러 폴백, 컨텍스트 손실 시 재장착(총 5회 상한).
    const allowWebgl = !isTauri || navigator.userAgent.includes('Windows');
    let webglRetryCount = 0;
    let webglPermanentlyOff = false; // context가 반복 유실되면 DOM 렌더러로 확정
    let lastContextLossAt = 0;
    const tryLoadWebgl = () => {
      if (disposed || webglAddon || webglPermanentlyOff) return;
      try {
        const addon = new WebglAddon();
        webglAddon = addon;
        addon.onContextLoss(() => {
          // 유실된 WebGL 캔버스는 드라이버에 따라 흰색으로 페인트된 채 dispose까지
          // 화면을 가린다(실측된 "순간 흰 화면") — 같은 태스크에서 동기적으로 숨겨
          // 플래시를 제거하고, dispose 후 DOM 렌더러가 그리도록 즉시 refresh 한다.
          try {
            term.element?.querySelectorAll('canvas').forEach((c: HTMLCanvasElement) => {
              c.style.visibility = 'hidden';
            });
          } catch { /* element may be gone */ }
          try { addon.dispose(); } catch { /* already disposed */ }
          if (webglAddon === addon) webglAddon = null;
          const st = terminalStates.get(terminalId);
          if (st) st.webglAddon = null;
          if (!disposed) {
            // dispose가 WebGL 캔버스를 제거하고 xterm은 DOM 렌더러로 되돌아가므로
            // 즉시 리페인트하면 "사라진" 화면이 곧바로 DOM으로 다시 그려진다.
            try { term.refresh(0, term.rows - 1); } catch { /* term may be disposed */ }
            // 핵심: 짧은 시간(30s) 안에 또 유실되면 이 기기의 GPU/WebView2 조합에서
            // WebGL이 불안정하다는 신호다. 계속 재장착하면 유실↔재장착이 반복되어
            // 터미널이 "사라졌다 다시 보이는" 깜빡임이 된다. 이 경우 재장착을 멈추고
            // DOM 렌더러로 확정 전환해 깜빡임을 끝낸다. 어쩌다 1회 유실(백그라운드
            // 복귀 등)만 재장착을 허용해 평상시 WebGL 성능은 유지한다.
            const now = Date.now();
            const rapidRelapse = lastContextLossAt !== 0 && now - lastContextLossAt < 30000;
            lastContextLossAt = now;
            if (rapidRelapse || webglRetryCount >= 2) {
              webglPermanentlyOff = true;
              try {
                term.element?.querySelectorAll('canvas').forEach((c: HTMLCanvasElement) => {
                  c.style.visibility = ''; // 혹시 남은 캔버스가 화면을 가리지 않게
                });
              } catch { /* ignore */ }
              try { term.refresh(0, term.rows - 1); } catch { /* ignore */ }
            } else {
              webglRetryCount += 1;
              setTimeout(tryLoadWebgl, 1000 * webglRetryCount);
            }
          }
        });
        term.loadAddon(addon);
        const st = terminalStates.get(terminalId);
        if (st) st.webglAddon = addon;
        // 재장착 직후 새 캔버스가 첫 draw 전까지 비어 보이지 않게 즉시 전체 리페인트.
        // 재장착 경로로 들어온 경우 이전에 숨겨둔 캔버스가 남아있을 수 있으므로
        // 먼저 모두 다시 보이게 되돌린다 (안 되돌리면 터미널이 영구히 안 보인다).
        try {
          term.element?.querySelectorAll('canvas').forEach((c: HTMLCanvasElement) => {
            c.style.visibility = '';
          });
        } catch { /* element not attached yet */ }
        try { term.refresh(0, term.rows - 1); } catch { /* not yet renderable */ }
        // Chromium(WebView2)은 GPU 콘텐츠가 유실된 캔버스를 '흰 배경 + 얼굴 아이콘'
        // 플레이스홀더로 그린다(사용자 스크린샷 실측). 유실 순간만 잠깐 숨기고,
        // 반드시 복구(restored) 시 다시 보이게 한다 — 숨기기만 하면 GPU 압박(예:
        // 브라우저의 실제 Chrome/GPU 사용)으로 context가 주기적으로 유실될 때
        // 터미널이 통째로 사라져 다시 나타나지 않는다. preventDefault로 브라우저가
        // context를 복원하도록 허용하고, once:false 로 반복 유실도 처리한다.
        try {
          term.element?.querySelectorAll('canvas').forEach((c: HTMLCanvasElement) => {
            c.addEventListener('webglcontextlost', (e: Event) => {
              e.preventDefault(); // 이걸 호출해야 webglcontextrestored 가 발동한다
              c.style.visibility = 'hidden';
            });
            c.addEventListener('webglcontextrestored', () => {
              c.style.visibility = '';
              try { term.refresh(0, term.rows - 1); } catch { /* term disposed */ }
            });
          });
        } catch { /* element not attached yet */ }
      } catch (e) {
        webglAddon = null;
        // Fall back to DOM renderer on WebGL failure — 침묵 실패 금지, 원인을 남긴다
        console.warn('[XTerminal] WebGL addon failed, falling back to DOM renderer:', e);
        try { (window as unknown as Record<string, unknown>).__octoWebglError = String(e); } catch { /* ignore */ }
      }
    };

    requestAnimationFrame(() => {
      if (disposed) return;

      if (allowWebgl) tryLoadWebgl();

      safeFit(true);
      fixTerminalStyle();
    });

    // Write data to PTY (works regardless of disposed state)
    const writeToPty = (data: string) => {
      _terminalLastActivity.set(terminalId, Date.now());
      feedTerminalInput(terminalId, data);
      // Always works as long as PTY exists
      invoke('write_to_pty', { terminalId, data }).catch((err) => {
        console.error('[PTY] write_to_pty failed for', terminalId, ':', err);
      });
    };

    writeToPtyRef.current = writeToPty;

    // Save writeToPty in global state (always keep latest function)
    const currentState = terminalStates.get(terminalId);
    if (currentState) currentState.writeToPty = writeToPty;

    const ensurePtyListeners = async () => {
      const st = terminalStates.get(terminalId);
      if (!st || st.ptyDataUnlisten) return;

      try {
        const unlistenData = await listen<string>(`pty-data-${terminalId}`, (event) => {
          const payload = typeof event.payload === 'string' ? event.payload : '';
          if (!payload) return;
          const live = terminalStates.get(terminalId);
          if (live) {
            live.usesEventTransport = true;
          }
          void processTerminalOutput(terminalId, payload);
        });
        st.ptyDataUnlisten = unlistenData;

        const unlistenExit = await listen<string>('pty-exit', (event) => {
          if (event.payload !== terminalId) return;
          const live = terminalStates.get(terminalId);
          if (!live) return;
          live.readLoopActive = false;
          _stopReadLoop(terminalId);
        });
        st.ptyExitUnlisten = unlistenExit;
      } catch (err) {
        console.warn('[PTY] Event listener setup failed, falling back to polling:', err);
        st.usesEventTransport = false;
        // Ensure polling read loop is (re)started as fallback
        startReadLoop(terminalId);
      }
    };

    // Terminal fit and PTY resize
    const fitTerminal = () => {
      if (disposed) return;
      safeFit();
      if (termRef.current && cliType !== 'ollama') {
        invoke('resize_pty', {
          terminalId,
          rows: termRef.current.rows,
          cols: termRef.current.cols,
        }).catch(() => {});
      }
    };

    // ── Ollama chat mode (no PTY) ──
    const initializeOllamaChat = async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (disposed) return;
      safeFit(true);

      const ollamaUrl = ((await kvGet('octo-ollama-url')) || '').trim() || 'http://localhost:11434';
      const ollamaModel = ((await kvGet('octo-ollama-model')) || '').trim();

      ollamaModeActiveRef.current = true;
      ollamaChatHistoryRef.current = [];
      ollamaLineBufRef.current = '';
      ollamaBusyRef.current = false;

      const accent = style?.accent || '#22c55e';
      term.write(`\x1b[1;36m🦙 Ollama Chat\x1b[0m\r\n`);
      term.write(`\x1b[90mServer: ${ollamaUrl}\x1b[0m\r\n`);
      if (ollamaModel) {
        term.write(`\x1b[90mModel:  ${ollamaModel}\x1b[0m\r\n`);
      } else {
        term.write(`\x1b[1;33m⚠ ${t('terminal.ollamaNoModelSettings')}\x1b[0m\r\n`);
      }
      term.write(`\x1b[90m${t('terminal.ollamaIntro')}\x1b[0m\r\n`);
      term.write('\r\n');
      const writePrompt = () => term.write(`\x1b[38;2;${parseInt(accent.slice(1,3),16)};${parseInt(accent.slice(3,5),16)};${parseInt(accent.slice(5,7),16)}mollama>\x1b[0m `);
      writePrompt();

      const sendToOllama = async (userMsg: string) => {
        const url = ((await kvGet('octo-ollama-url')) || '').trim() || 'http://localhost:11434';
        const model = ((await kvGet('octo-ollama-model')) || '').trim();
        if (!model) {
          term.write(`\x1b[1;33m⚠ ${t('terminal.ollamaNoModelUse')}\x1b[0m\r\n`);
          writePrompt();
          return;
        }
        ollamaChatHistoryRef.current.push({ role: 'user', content: userMsg });
        ollamaBusyRef.current = true;
        term.write(`\x1b[90m${t('terminal.thinking')}\x1b[0m`);

        try {
          const res = await invoke<{ status: number; body: string }>('http_request', {
            input: {
              method: 'POST',
              url: `${url}/api/chat`,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                messages: ollamaChatHistoryRef.current,
                stream: false,
              }),
            },
          });
          // Clear "thinking..."
          term.write('\x1b[2K\r');
          if (res.status >= 400) {
            term.write(`\x1b[1;31m✗ Error ${res.status}: ${res.body.slice(0, 200)}\x1b[0m\r\n`);
          } else {
            const data = JSON.parse(res.body) as { message?: { content?: string } };
            const reply = data.message?.content || t('terminal.emptyResponse');
            ollamaChatHistoryRef.current.push({ role: 'assistant', content: reply });
            // Render reply with line breaks
            const lines = reply.split('\n');
            for (let i = 0; i < lines.length; i++) {
              term.write(lines[i]);
              if (i < lines.length - 1) term.write('\r\n');
            }
            term.write('\r\n');
          }
        } catch (e) {
          term.write('\x1b[2K\r');
          term.write(`\x1b[1;31m✗ ${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`);
        }
        ollamaBusyRef.current = false;
        term.write('\r\n');
        writePrompt();
      };

      // Handle keyboard input directly (no PTY)
      const handleOllamaInput = (data: string) => {
        if (ollamaBusyRef.current) return;
        for (const ch of data) {
          if (ch === '\r' || ch === '\n') {
            // Enter
            const line = ollamaLineBufRef.current.trim();
            ollamaLineBufRef.current = '';
            term.write('\r\n');
            if (!line) {
              writePrompt();
              continue;
            }
            // Commands
            if (line === '/clear') {
              ollamaChatHistoryRef.current = [];
              term.write(`\x1b[90m${t('terminal.chatCleared')}\x1b[0m\r\n`);
              writePrompt();
              continue;
            }
            if (line.startsWith('/model ')) {
              const newModel = line.slice(7).trim();
              if (newModel) {
                void kvSet('octo-ollama-model', newModel);
                term.write(`\x1b[90m${t('terminal.modelSwitched').replace('{model}', newModel)}\x1b[0m\r\n`);
              }
              writePrompt();
              continue;
            }
            if (line === '/help') {
              term.write(`\x1b[90m/clear   - ${t('terminal.helpClear')}\x1b[0m\r\n`);
              term.write(`\x1b[90m/model <name> - ${t('terminal.helpModel')}\x1b[0m\r\n`);
              term.write(`\x1b[90m/help    - ${t('terminal.helpHelp')}\x1b[0m\r\n`);
              writePrompt();
              continue;
            }
            void sendToOllama(line);
          } else if (ch === '\x7f' || ch === '\b') {
            // Backspace
            if (ollamaLineBufRef.current.length > 0) {
              ollamaLineBufRef.current = ollamaLineBufRef.current.slice(0, -1);
              term.write('\b \b');
            }
          } else if (ch === '\x03') {
            // Ctrl+C
            ollamaLineBufRef.current = '';
            term.write('^C\r\n');
            writePrompt();
          } else if (ch === '\x15') {
            // Ctrl+U - clear line
            const len = ollamaLineBufRef.current.length;
            ollamaLineBufRef.current = '';
            term.write('\b \b'.repeat(len));
          } else if (ch >= ' ') {
            // Printable
            ollamaLineBufRef.current += ch;
            term.write(ch);
          }
        }
      };

      ollamaInputHandlerRef.current = handleOllamaInput;
      term.onData(handleOllamaInput);

      isReadyRef.current = true;
      onReady?.(() => {}); // no-op writeToPty for ollama mode

      // Do not auto-focus terminal on init; user interaction should decide focus.
    };

    // Initialization sequence
    const initialize = async () => {
      // Fresh terminals need a short settle delay; reused terminals should reconnect immediately
      // so project/terminal switching stays snappy.
      await new Promise(resolve => setTimeout(resolve, terminalReused ? 0 : 200));
      if (disposed) return;

      safeFit(true);

      // CLI type startup commands — normalize/dedupe flags first.
      const isWindows = navigator.platform?.startsWith('Win') || navigator.userAgent?.includes('Windows');
      const argShell = effectiveShellType || (isWindows ? 'powershell' : 'posix');
      const normalizedFlags = normalizeCliFlagLines((extraFlags || []).map((raw) => {
        const v = String(raw || '').trim();
        return (v === '--yolo' && cliType === 'codex')
          ? '--dangerously-bypass-approvals-and-sandbox'
          : v;
      }), argShell);
      const hasFlag = (flag: string) => normalizedFlags.includes(flag);
      const flagsToString = (flags: string[]) => (flags.length > 0 ? ' ' + flags.join(' ') : '');
      const wrapCliCheck = (cmd: string, binName: string, installHint?: string): string => {
        const hint = installHint ? ` Install: ${installHint}` : '';
        if (isWindows) {
          // PowerShell: avoid ScriptBlock { } which can misparse CLI flags.
          // Use simple cmd.exe-style: check then run with semicolon.
          return `${cmd}`;
        }
        return `command -v ${binName} >/dev/null 2>&1 && ${cmd} || echo "${binName} CLI not found.${hint}"`;
      };

      // Resolve the bundled internal bbarit agent binary (vendored + shipped inside
      // the app). Falls back to the PATH name `bbarit` if the resolver finds nothing.
      let bbaritBinary = 'bbarit';
      let browserCli = '';
      let bridgeBasePort = 0;
      if (cliType === 'bbarit') {
        try {
          const resolved = await invoke<string | null>('resolve_bundled_agent', { name: 'bbarit' });
          if (resolved) bbaritBinary = resolved;
        } catch { /* fall back to PATH */ }
        // Path to the BBARIT Browser CLI so the agent's `browser` tool can drive
        // our real-Chrome (CDP) browser instead of its own extension bridge.
        try {
          const cli = await invoke<string | null>('resolve_browser_cli');
          if (cli) browserCli = cli;
        } catch { /* no browser CLI available */ }
        // This app's mcp-bridge base port (dev 9323 / installed 9223) so the
        // browser CLI targets the very app that launched this agent.
        try {
          bridgeBasePort = await invoke<number>('mcp_bridge_base_port');
        } catch { /* default scan */ }
      }

      // `claude --continue` fails on a project that has no Claude session yet
      // ("No conversation found to continue"), so drop the flag on the first run.
      let claudeCanContinue = resumeLastSession;
      if (cliType === 'claude' && resumeLastSession) {
        claudeCanContinue = await shouldContinueClaudeSession(workDir, {
          getHomeDir: () => invoke<string>('get_home_dir'),
          readDirectory: (path) => invoke<Array<{ name: string; is_dir: boolean }>>('read_directory', { path }),
        });
      }

      const cliCommands: Record<string, string> = {
        claude: (() => {
          let cmd = 'claude';
          // Legacy mode compat + flags
          if (startupMode === 'bypass-permissions' || autoAccept) cmd += ' --dangerously-skip-permissions';
          if (claudeCanContinue && !hasFlag('--continue') && !hasFlag('-c') && !hasFlag('--resume') && !hasFlag('-r')) cmd += ' --continue';
          // Inject --model if set and not already in flags
          if (modelId && !hasFlag('--model') && !normalizedFlags.some(f => f.startsWith('--model'))) {
            cmd += ` --model ${shellQuoteArg(modelId, argShell)}`;
          }
          // Inject --mcp-config if set and not already in flags
          if (mcpConfigPath && !hasFlag('--mcp-config') && !normalizedFlags.some(f => f.startsWith('--mcp-config'))) {
            cmd += ` --mcp-config ${shellQuoteArg(mcpConfigPath, argShell)}`;
          }
          cmd += flagsToString(normalizedFlags);
          return wrapCliCheck(cmd, 'claude', 'npm i -g @anthropic-ai/claude-code');
        })(),
        codex: (() => {
          const modeFlags: string[] = [];
          // Codex yolo mode now maps to dangerous bypass flag (avoid deprecated --yolo noise).
          if (startupMode === 'yolo' && !hasFlag('--dangerously-bypass-approvals-and-sandbox')) {
            modeFlags.push('--dangerously-bypass-approvals-and-sandbox');
          } else if (startupMode === 'full-auto' && !hasFlag('--full-auto') && !hasFlag('--dangerously-bypass-approvals-and-sandbox')) {
            modeFlags.push('--full-auto');
          } else if (startupMode === 'auto-edit' && !hasFlag('--auto-edit')) {
            modeFlags.push('--auto-edit');
          }
          if (codexWebSearch && !hasFlag('--search')) modeFlags.push('--search');
          // Inject --model if set and not already in flags
          if (modelId && !hasFlag('--model') && !normalizedFlags.some(f => f.startsWith('--model'))) {
            modeFlags.push('--model', shellQuoteArg(modelId, argShell));
          }
          const cmd = resumeLastSession
            ? `codex resume --last${flagsToString([...modeFlags, ...normalizedFlags])}`
            : `codex${flagsToString([...modeFlags, ...normalizedFlags])}`;
          return wrapCliCheck(cmd, 'codex', 'npm i -g @openai/codex');
        })(),
        cursor: (() => {
          let cmd = 'cursor-agent';
          if ((autoAccept || hasFlag('--force') || hasFlag('-f')) && !hasFlag('--force') && !hasFlag('-f')) {
            cmd += ' --force';
          }
          if (resumeLastSession && !hasFlag('--resume') && !normalizedFlags.some(f => f.startsWith('--resume'))) cmd += ' --resume';
          if (modelId && !hasFlag('--model') && !hasFlag('-m') && !normalizedFlags.some(f => f.startsWith('--model'))) {
            cmd += ` --model ${shellQuoteArg(modelId, argShell)}`;
          }
          cmd += flagsToString(normalizedFlags);
          return wrapCliCheck(cmd, 'cursor-agent', 'curl https://cursor.com/install -fsS | bash');
        })(),
        opencode: (() => {
          let cmd = 'opencode';
          cmd += flagsToString(normalizedFlags);
          // opencode installs to ~/.opencode/bin — ensure PATH includes it
          const pathPrefix = 'export PATH="$HOME/.opencode/bin:$PATH"; ';
          return pathPrefix + wrapCliCheck(cmd, 'opencode', 'curl -fsSL https://opencode.ai/install | bash');
        })(),
        gajae: (() => {
          // Gajae-Code (가재코드): external coding-agent harness, launched via `gjc`.
          let cmd = 'gjc';
          cmd += flagsToString(normalizedFlags);
          // gjc runs on the bun runtime, so install both.
          return wrapCliCheck(cmd, 'gjc', 'npm i -g bun gajae-code');
        })(),
        kimi: (() => {
          let cmd = 'kimi';
          // Legacy mode compat
          if ((startupMode === 'yolo' || autoAccept) && !hasFlag('--yolo')) cmd += ' --yolo';
          if (resumeLastSession && !hasFlag('--continue') && !hasFlag('-c')) cmd += ' --continue';
          cmd += flagsToString(normalizedFlags);
          return wrapCliCheck(cmd, 'kimi', 'npm i -g @moonshot-ai/kimi-cli');
        })(),
        gemini: (() => {
          let cmd = 'gemini';
          if (modelId && !hasFlag('--model') && !normalizedFlags.some(f => f.startsWith('--model'))) {
            cmd += ` --model ${shellQuoteArg(modelId, argShell)}`;
          }
          cmd += flagsToString(normalizedFlags);
          return wrapCliCheck(cmd, 'gemini', 'npm i -g @google/gemini-cli');
        })(),
        qwen: (() => {
          let cmd = 'qwen';
          if ((startupMode === 'yolo' || autoAccept) && !hasFlag('--approval-mode') && !normalizedFlags.some(f => f.startsWith('--approval-mode'))) {
            cmd += ' --approval-mode=yolo';
          }
          if (modelId && !hasFlag('--model') && !normalizedFlags.some(f => f.startsWith('--model'))) {
            cmd += ` --model ${shellQuoteArg(modelId, argShell)}`;
          }
          cmd += flagsToString(normalizedFlags);
          return wrapCliCheck(cmd, 'qwen', 'npm i -g @qwen-code/qwen-code');
        })(),
        'bbarit-oss': (() => {
          // Standalone open-source agent: the installed `bbarit-oss` binary on
          // PATH. Fully independent of this app (its own ~/.bbarit-oss home);
          // no app bridges are injected.
          let cmd = 'bbarit-oss';
          if (resumeLastSession && !hasFlag('--continue') && !hasFlag('-c') && !hasFlag('--resume') && !hasFlag('-r')) {
            cmd += ' -c';
          }
          cmd += flagsToString(normalizedFlags);
          return wrapCliCheck(cmd, 'bbarit-oss', AGENT_INSTALL_COMMAND);
        })(),
        pi: (() => {
          let cmd = 'pi';
          if (resumeLastSession && !hasFlag('--continue') && !hasFlag('-c') && !hasFlag('--resume') && !hasFlag('-r') && !normalizedFlags.some(f => f.startsWith('--session'))) {
            cmd += ' -c';
          }
          cmd += flagsToString(normalizedFlags);
          return wrapCliCheck(cmd, 'pi', 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent');
        })(),
        reasonix: (() => {
          let cmd = 'reasonix code';
          cmd += flagsToString(normalizedFlags);
          if (isWindows) return cmd;
          return `command -v reasonix >/dev/null 2>&1 && ${cmd} || command -v npx >/dev/null 2>&1 && npx -y reasonix@latest code${flagsToString(normalizedFlags)} || echo "reasonix CLI not found. Install: npm i -g reasonix"`;
        })(),
        bbarit: (() => {
          // Internalized agent: launch THIS app's own executable with
          // BBARIT_AGENT_MODE so it runs the embedded agent TUI in-process — no
          // separate bbarit.exe. --no-pick is belt-and-suspenders (the picker is
          // also disabled in source); the host terminal supplies the project cwd.
          const quoted = shellQuoteArg(bbaritBinary, argShell);
          const hasTrustOverride = normalizedFlags.some((flag) => flag === '--approve' || flag === '-a' || flag === '--no-approve' || flag === '-A' || flag === '-na');
          const launchFlags = hasTrustOverride ? normalizedFlags : ['--approve', ...normalizedFlags];
          const flags = flagsToString(launchFlags);
          // Hand the agent the BBARIT Browser CLI path so its `browser` tool drives
          // our real-Chrome (CDP) browser, plus the bridge base port + allow-release
          // so the CLI targets THIS app (works for both dev and installed builds).
          // Empty when unavailable (agent then falls back to its extension bridge).
          // Editor bridge URL for the agent's `xlsx` tool — the port pairs with
          // the mcp-bridge split (dev 9323→19981, installed 9223→19980).
          const editorBridge = bridgeBasePort > 0
            ? `http://127.0.0.1:${bridgeBasePort === 9323 ? 19981 : 19980}/editor`
            : '';
          if (isWindows) {
            let browserEnv = '';
            if (browserCli) {
              browserEnv = `$env:BBARIT_BROWSER_CLI=${shellQuoteArg(browserCli, argShell)}; $env:BBARIT_BROWSER_SESSION=${shellQuoteArg(terminalId, argShell)}; $env:BBARIT_BRIDGE_ALLOW_RELEASE='1'; `;
              if (bridgeBasePort > 0) browserEnv += `$env:TAURI_DEV_BASE_PORT='${bridgeBasePort}'; `;
            }
            if (editorBridge) browserEnv += `$env:BBARIT_EDITOR_BRIDGE='${editorBridge}'; `;
            // D6(2026-07-04): release octo-ui.exe is GUI-subsystem (console subsystem
            // left the Win32 owner thread unresponsive — see main.rs top comment), so
            // `& exe` returns to the PowerShell prompt immediately while the agent
            // attaches to the same ConPTY console. Both then read keystrokes
            // concurrently: typing "HI" fed 'H' to the TUI and executed 'I' in
            // PowerShell. Fix: launch via Diagnostics.Process + WaitForExit() so
            // PowerShell blocks (not reading input) until the TUI exits.
            // UseShellExecute=$false keeps console/handle inheritance identical to
            // `&`; dev (console-subsystem) builds behave the same as before.
            // Rollback: revert to `& ${quoted} --no-pick${flags}`.
            // StartInfo.Arguments is a raw Win32 command line, so re-quote the flags
            // cmd-style ("value") — `flags` above carries PowerShell quoting.
            const winFlags = normalizeCliFlagLines(extraFlags || [], 'cmd');
            const launchWinFlags = hasTrustOverride ? winFlags : ['--approve', ...winFlags];
            const argsLine = `--no-pick${flagsToString(launchWinFlags)}`;
            const psExe = shellQuoteArg(bbaritBinary, 'powershell');
            const psArgs = `'${argsLine.replace(/'/g, "''")}'`;
            return `$env:BBARIT_AGENT_MODE='1'; ${browserEnv}$bbaritP = New-Object System.Diagnostics.Process; $bbaritP.StartInfo.FileName = ${psExe}; $bbaritP.StartInfo.Arguments = ${psArgs}; $bbaritP.StartInfo.UseShellExecute = $false; [void]$bbaritP.Start(); $bbaritP.WaitForExit()`;
          }
          let browserEnv = '';
          if (browserCli) {
            browserEnv = `BBARIT_BROWSER_CLI=${shellQuoteArg(browserCli, argShell)} BBARIT_BROWSER_SESSION=${shellQuoteArg(terminalId, argShell)} BBARIT_BRIDGE_ALLOW_RELEASE=1 `;
            if (bridgeBasePort > 0) browserEnv += `TAURI_DEV_BASE_PORT=${bridgeBasePort} `;
          }
          if (editorBridge) browserEnv += `BBARIT_EDITOR_BRIDGE=${editorBridge} `;
          const cwdEnv = workDir && !String(workDir).startsWith('ssh://') ? `BBARIT_AGENT_CWD=${shellQuoteArg(workDir, argShell)} ` : '';
          return `BBARIT_AGENT_MODE=1 ${cwdEnv}${browserEnv}${quoted} --no-pick${flags}`;
        })(),
      };

      try {
        await ensurePtyListeners();

        const restoredProbe = await probeRestoredPty({
          invokeFn: invoke,
          terminalId,
          cliType,
          isRestored: _isRestored,
          ptyAlreadyExists,
        });
        if (restoredProbe.ptyAlreadyExists && !ptyAlreadyExists) {
          ptyAlreadyExists = true;
          const restoredState = terminalStates.get(terminalId);
          if (restoredState) {
            restoredState.ptyCreated = true;
            if (restoredProbe.markCliAutoStarted) restoredState.autoStartedCliType = cliType;
          }
          if (restoredProbe.bufferedOutput && !disposed) {
            await processTerminalOutput(terminalId, restoredProbe.bufferedOutput);
          }
        }

        // Skip create_shell if PTY already exists
        if (!ptyAlreadyExists) {
          if (shouldResetExistingPty) {
            await invoke('destroy_pty', { terminalId }).catch(() => invoke('close_pty', { terminalId }).catch(() => {}));
          }
          await invoke('create_shell', {
            terminalId,
            workDir,
            rows: term.rows || 24,
            cols: term.cols || 80,
            shellType: effectiveShellType,
          });
          const currentState = terminalStates.get(terminalId);
          if (currentState) currentState.ptyCreated = true;
        }

        if (disposed) {
          return;
        }

        // Ensure read loop flag is set before starting the loop
        const initState = terminalStates.get(terminalId);
        if (initState) {
          initState.readLoopActive = true;
        }

        // Event transport is preferred; polling remains as a fallback.
        if (!initState?.usesEventTransport) {
          startReadLoop(terminalId);
        }

        isReadyRef.current = true;

        if (cliType !== 'shell' && ptyAlreadyExists) {
          const startupProbeState = terminalStates.get(terminalId);
          const startupProbeText = startupProbeState?.recentOutputText || '';
          const needsStartupProbe = !startupProbeText
            || (
              startupProbeState?.autoStartedCliType === cliType
              && !looksLikeAgentUiReady(cliType, startupProbeText)
            );
          if (needsStartupProbe) {
            const backendBuffer = await invoke<string>('read_pty_output_buffer', { terminalId }).catch(() => '');
            if (backendBuffer && startupProbeState) {
              startupProbeState.recentOutputText = `${startupProbeState.recentOutputText || ''}${backendBuffer}`.slice(-24000);
            }
          }
        }

        const startupCommand = await (async () => {
          if (cliType === 'shell') {
            // On Windows the backend launches ssh directly as the PTY for ssh://
            // work dirs (create_shell → build_ssh_pty_command). PowerShell/cmd.exe
            // can't parse the POSIX-quoted ssh command, so don't type it here.
            if (isWindows) return null;
            const cmd = await buildSshStartupCommand(workDir);
            if (!cmd && projectWorkDir) return buildSshStartupCommand(projectWorkDir);
            return cmd;
          }
          return cliCommands[cliType] || null;
        })();

        // Auto-run startup command when PTY is newly created. Reasonix also gets
        // a one-time repair path for existing PTYs, because older builds could
        // create the tab but leave it sitting at the plain shell prompt.
        // (B) Start the CLI at most ONCE per terminal: on a fresh PTY, or on an
        // existing PTY whose CLI was never auto-started yet. markCliAutoStarted()
        // sets autoStartedCliType right after injecting, so it never re-injects
        // after that. The old banner-based "repair" branches (re-inject whenever the
        // screen still looked like a raw shell) are removed — those re-typed the
        // start command into already-running agents and spammed the harness.
        const stateBeforeStartup = terminalStates.get(terminalId);
        const existingRawShell =
          !!stateBeforeStartup?.recentOutputText
          && cliType !== 'shell'
          && stateBeforeStartup.autoStartedCliType === cliType
          && stateBeforeStartup.agentUiReadyCliType !== cliType
          && stateBeforeStartup.startupRepairAttemptedCliType !== cliType
          && looksLikePlainShellPrompt(stateBeforeStartup.recentOutputText);
        const shouldRunStartupCommand =
          !!startupCommand &&
          (!ptyAlreadyExists ||
            (cliType !== 'shell' && stateBeforeStartup?.autoStartedCliType !== cliType) ||
            existingRawShell);

        const notifyReadyOnce = () => {
          const st = terminalStates.get(terminalId);
          if (!shouldNotifyReady(!!st?.agentReadyNotified, writerRegisteredRef.current)) return;
          if (st) {
            st.agentReadyNotified = true;
            st.agentReadyHandler = null;
          }
          writerRegisteredRef.current = true;
          onReady?.(writeToPty);
        };

        if (shouldRunStartupCommand && startupCommand) {
          // Mark started synchronously (before the scheduled write) so a remount
          // within the startup delay window can't schedule a duplicate injection —
          // autoStartedCliType is the once-gate in shouldRunStartupCommand above.
          if (stateBeforeStartup) stateBeforeStartup.autoStartedCliType = cliType;
          startupGatePreset = true;
          if (existingRawShell && stateBeforeStartup) stateBeforeStartup.startupRepairAttemptedCliType = cliType;
          const markCliAutoStarted = () => {
            const st = terminalStates.get(terminalId);
            if (st) {
              st.autoStartedCliType = cliType;
              st.injectedStartupCommand = startupCommand; // P2-2: skip this command's echo
              st.agentUiReadyCliType = undefined;
              st.agentReadyNotified = false;
              st.agentReadyHandler = notifyReadyOnce;
            }
          };
          setTimeout(() => {
            if (!disposed) {
              if (cliType === 'cursor' || cliType === 'qwen' || cliType === 'pi' || cliType === 'reasonix' || cliType === 'bbarit') {
                term.write(`\x1b[90m${t('terminal.startingCli').replace('{name}', cliType === 'cursor' ? 'Cursor Agent' : cliType === 'qwen' ? 'Qwen Code' : cliType === 'pi' ? 'Pi' : cliType === 'bbarit' ? 'BBARIT Agent' : 'Reasonix')}\x1b[0m\r\n`);
              }
              markCliAutoStarted();
              startupWriteFired = true;
              writeToPty((existingRawShell ? '\x03' : '') + startupCommand + '\r');
              // onReady means "the PTY writer is available", not "the agent UI is
              // ready". Broker harnesses still gate briefing injection through
              // isTerminalAgentUiReady(), so registering the writer here is safe
              // and avoids deadlock when an agent welcome screen is visible but a
              // readiness handler misses the exact output frame.
              notifyReadyOnce();
              setTimeout(fitTerminal, 1000);
            }
          }, ptyAlreadyExists ? 50 : 500);
        } else {
          notifyReadyOnce();
        }

        // Bounded reliability retry (max 3): the once-gate + delayed write can lose the
        // CLI start command to a mount/dispose race (StrictMode double-mount, harness-
        // window remount), stranding the agent at a raw shell. Verify via the child
        // PROCESS (reliable — not prose regex) and re-inject only when the CLI genuinely
        // never started. If a CLI is running, pty_terminal_has_child is true so this is a
        // no-op — it can NEVER spam an already-running agent (the old repair-loop bug).
        if (cliType !== 'shell' && startupCommand) {
          const scheduleStartRetry = (attempt: number) => {
            if (attempt > 3) return;
            setTimeout(() => {
              if (disposed) return;
              void invoke<boolean>('pty_terminal_has_child', { terminalId }).then((hasChild) => {
                if (disposed || hasChild) return; // CLI is running (or gone) — done
                const st = terminalStates.get(terminalId);
                if (!st) return;
                if (st.cliLaunchFailure) return; // CLI 미설치/깨짐 — 재주입해봤자 같은 에러 스팸
                st.injectedStartupCommand = startupCommand;
                st.autoStartedCliType = cliType;
                writeToPty(startupCommand + '\r');
                scheduleStartRetry(attempt + 1);
              }).catch(() => {});
            }, 7000);
          };
          scheduleStartRetry(1);
        }

        // tmux auto-start: inject tmux command after shell is ready (for shell type, not CLI agents)
        if (!ptyAlreadyExists && tmuxAutoStart && cliType === 'shell') {
          const delay = startupCommand ? 1500 : 800; // SSH startup needs more time
          setTimeout(() => {
            if (!disposed) {
              const sessionName = `octo-${terminalId.slice(-6)}`;
              writeToPty(`tmux new-session -A -s ${sessionName}\r`);
            }
          }, delay);
        }

        setTimeout(() => {
          // Keep viewport in sync, but avoid stealing global keyboard focus.
          scrollActiveTerminalToBottom(false);
        }, 100);

      } catch (error) {
        if (term) {
          term.write(`\x1b[1;31m✗ ${t('terminal.ptyConnectFailed')}\x1b[0m\r\n`);
          term.write(`\x1b[90m${String(error)}\x1b[0m\r\n`);
        }
      }
    };

    // Resize handler
    let resizeTimeout: number | null = null;
    const handleResize = () => {
      if (resizeTimeout) return;
      resizeTimeout = window.setTimeout(() => {
        resizeTimeout = null;
        fitTerminal();
      }, RESIZE_DEBOUNCE_MS);
    };

    window.addEventListener('resize', handleResize);

    // Recover from blackout when tab/window becomes visible again
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !disposed) {
        // Force terminal refresh after returning from background/sleep
        setTimeout(() => {
          if (disposed) return;
          const st = terminalStates.get(terminalId);
          if (st?.term) {
            st.term.refresh(0, st.term.rows - 1);
            safeFit(true);
          }
        }, 100);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Periodic refresh to prevent long-running blackout (every 30s)
    const blackoutGuard = window.setInterval(() => {
      if (disposed) return;
      const st = terminalStates.get(terminalId);
      if (st?.term && document.visibilityState === 'visible') {
        st.term.refresh(0, st.term.rows - 1);
      }
    }, 30000);

    // Restored inactive terminals should not spawn shell processes on app startup.
    // They will initialize normally when the user activates the terminal.
    const shouldDeferStart = deferStart && !ptyAlreadyExists;
    if (shouldDeferStart) {
      term.write(`\x1b[2m${t('terminal.clickToRestore')}\x1b[0m\r\n`);
    } else if (cliType === 'ollama') {
      initializeOllamaChat();
    } else {
      initialize();
    }

    return () => {
      disposed = true;
      isDisposedRef.current = true;

      // If we pre-set the startup once-gate but disposed before the delayed write
      // fired, roll the gate back so the next mount actually injects the CLI start
      // command (otherwise the terminal stays a raw shell forever).
      if (startupGatePreset && !startupWriteFired) {
        const st = terminalStates.get(terminalId);
        if (st && st.autoStartedCliType === cliType) st.autoStartedCliType = undefined;
      }

      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }

      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(blackoutGuard);

      // Dispose local webglAddon ref (also stored in state, but clean up local ref)
      if (webglAddon) {
        try { webglAddon.dispose(); } catch { /* ignore */ }
        webglAddon = null;
        const st = terminalStates.get(terminalId);
        if (st) st.webglAddon = null;
      }

      // Clean up local refs
      termRef.current = null;
      fitRef.current = null;
      writeToPtyRef.current = null;
      initRef.current = false;
      isReadyRef.current = false;
      ollamaModeActiveRef.current = false;

      onDispose?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, workDir, cliType, autoAccept, startupMode, codexWebSearch, resumeLastSession, extraFlags, deferStart, _isRestored, focusActiveInput, scrollActiveTerminalToBottom]);

  const enableDirectInput = useCallback(() => {
    const state = terminalStates.get(terminalId);
    const term = state?.term;
    if (!state || !term) return;

    state.inputMode = 'direct';

    // Ollama chat mode handles its own input via onData; skip registering additional listeners.
    if (ollamaModeActiveRef.current) {
      try { term.options.disableStdin = true; } catch { /* ignore */ }
      return;
    }

    // In Tauri/WKWebView we bridge IME via our own hidden textarea. Keep xterm stdin disabled
    // so it doesn't swallow key events or break composition.
    // However, we still need onData + onBinary listeners to forward mouse events (generated by
    // xterm.js CoreMouseService) to the PTY. TUI apps like Bubble Tea rely on mouse
    // tracking escape sequences that xterm.js emits via onData/onBinary even when disableStdin=true.
    // DEFAULT mouse encoding uses onBinary; SGR encoding uses onData.
    if (useTauriImeBridge) {
      try {
        term.options.disableStdin = true;
      } catch {
        // ignore
      }
      if (!state.inputDisposable) {
        // Only forward mouse escape sequences to PTY.
        // Keyboard/IME input is handled exclusively by the IME bridge textarea.
        // WKWebView leaks composition data through onData even with disableStdin=true.
        const d1 = term.onData((data: string) => {
          if (data.startsWith('\x1b[<') || data.startsWith('\x1b[M') ||
              (data.length > 3 && data.startsWith('\x1b[') && (data.endsWith('M') || data.endsWith('m')))) {
            sendToPty(data);
          }
        });
        const d2 = term.onBinary((data: string) => {
          sendToPty(data);
        });
        state.inputDisposable = { dispose: () => { d1.dispose(); d2.dispose(); } };
      }
      return;
    }

    try {
      term.options.disableStdin = false;
    } catch {
      // ignore
    }

    // In direct shell mode, keep xterm's native helper textarea behavior to avoid ghost UI artifacts.

    // Intercept Shift+Enter to send CSI u sequence (used by Claude Code, etc.)
    // Intercept Cmd/Ctrl+F for terminal search
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;

      const key = e.key;
      const k = getShortcutKey(e);
      const ctrl = e.ctrlKey;
      const shift = e.shiftKey;
      const meta = e.metaKey;

      // Modified Enter → kitty-style CSI-u sequence. Shift+Enter is always on
      // (Claude Code newline); Ctrl/Alt combos are gated by the extended-keyboard setting.
      if (key === 'Enter' && !meta && (shift || ctrl || e.altKey)) {
        const mod = 1 + (shift ? 1 : 0) + (e.altKey ? 2 : 0) + (ctrl ? 4 : 0);
        if (mod === 2 || csiUKeysRef.current) {
          e.preventDefault();
          sendToPty(`\x1b[13;${mod}u`);
          return false;
        }
      }

      // JIS keyboards: physical Yen key types a backslash instead of ¥
      if (jisYenRef.current && !ctrl && !meta && !e.altKey && (e.code === 'IntlYen' || key === '¥')) {
        e.preventDefault();
        sendToPty('\\');
        return false;
      }

      // Cmd/Ctrl+F: Open search
      if (k === 'f' && (meta || ctrl) && !shift) {
        e.preventDefault();
        setSearchBarVisible(true);
        requestAnimationFrame(() => searchInputRef.current?.focus({ preventScroll: true }));
        return false;
      }

      // Copy: Cmd+C (macOS) or Ctrl+Shift+C (Linux/Windows) or Ctrl+C with selection
      if ((meta && k === 'c') || (ctrl && shift && k === 'c') || (ctrl && k === 'c' && term.hasSelection())) {
        const selected = term.getSelection() || '';
        if (selected) {
          // Don't preventDefault — let native copy event fire (handleCopy listener will set clipboard)
          void writeClipboardTextSafe(selected);
          return false;
        }
        // No selection + Ctrl+C → let xterm send SIGINT
        if (ctrl && !meta && k === 'c') return true;
      }

      // Paste: let native paste event flow.
      // The container-level paste handler is the source of truth for text/image paste.
      if ((meta && k === 'v') || (ctrl && k === 'v')) {
        return true;
      }

      // Select All: Cmd+A
      if (meta && k === 'a') {
        e.preventDefault();
        term.selectAll();
        return false;
      }

      return true;
    });
    
    // Clipboard shortcuts - handle at window level
    const handleWindowKeyDown = (e: KeyboardEvent) => {
      if (!isActive) return;
      const wrap = terminalWrapRef.current;
      const target = e.target as HTMLElement | null;
      const activeEl = document.activeElement as HTMLElement | null;
      const isEditable = (el: HTMLElement | null) => {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
      };
      const inThisTerminal = (el: HTMLElement | null) => {
        if (!el) return false;
        return !!(wrap && (
          wrap.contains(el) ||
          el.closest?.('.xterm') ||
          el.closest?.('[data-terminal-scope]') ||
          el.closest?.('[data-terminal-wrap]') ||
          el === imeBridgeRef.current ||
          el.classList?.contains?.('xterm-helper-textarea')
        ));
      };
      // Never hijack global shortcuts unless this terminal currently owns focus.
      if (!inThisTerminal(activeEl)) {
        return;
      }
      // Never hijack global shortcuts from outside this terminal.
      if (!inThisTerminal(target) && !inThisTerminal(activeEl)) {
        return;
      }
      // Don't steal shortcuts from non-terminal inputs (e.g. Settings textareas).
      if ((isEditable(target) && !inThisTerminal(target)) || (isEditable(activeEl) && !inThisTerminal(activeEl))) {
        return;
      }

      const key = e.key;
      const k = getShortcutKey(e);
      const ctrl = e.ctrlKey;
      const shift = e.shiftKey;
      const meta = e.metaKey;

      // Copy:
      // - Cmd+C (macOS)
      // - Ctrl+C / Ctrl+Shift+C (Windows/Linux)
      // - Ctrl+Insert (Windows/Linux)
      const isCopyShortcut =
        (meta && k === 'c') ||
        (ctrl && !meta && !e.altKey && (k === 'c' || (shift && k === 'c') || key === 'Insert'));
      if (isCopyShortcut) {
        const selected = term.getSelection() || window.getSelection()?.toString() || '';
        if (selected) {
          // Don't preventDefault — let native copy event fire as backup
          void writeClipboardTextSafe(selected);
          return;
        }
        // No selection: keep Ctrl+C behavior for SIGINT.
        if (ctrl && !meta && !e.altKey && k === 'c') return;
      }

      // Paste:
      // - Cmd+V (macOS)
      // - Ctrl+V / Ctrl+Shift+V (Windows/Linux)
      // - Shift+Insert (Windows/Linux)
      if (
        (meta && k === 'v') ||
        (ctrl && !meta && !e.altKey && k === 'v') ||
        (shift && key === 'Insert' && !ctrl && !meta)
      ) {
        // Let native paste event flow to container-level paste handler.
        return;
      }

      // Cut: Cmd+X (macOS) - copy selection
      if (meta && key === 'x' && term.hasSelection()) {
        e.preventDefault();
        const sel = term.getSelection() || '';
        if (sel) void writeClipboardTextSafe(sel);
      }

      // Select All: Cmd+A (macOS)
      if (meta && key === 'a') {
        e.preventDefault();
        term.selectAll();
      }
    };

    // Guard: if listeners are already registered, dispose them first to prevent
    // duplicate event handlers which cause double-character input (#34).
    if (state.inputDisposable) {
      try { state.inputDisposable.dispose(); } catch { /* ignore */ }
      state.inputDisposable = null;
    }

    window.addEventListener('keydown', handleWindowKeyDown, true);

    const d1 = term.onData((data: string) => {
      sendToPty(data);
    });
    // Forward binary mouse events (DEFAULT encoding) to the PTY.
    const d2 = term.onBinary((data: string) => {
      sendToPty(data);
    });
    state.inputDisposable = {
      dispose: () => {
        d1.dispose();
        d2.dispose();
        window.removeEventListener('keydown', handleWindowKeyDown, true);
      }
    };
  }, [sendToPty, terminalId, useTauriImeBridge, isActive, readClipboardTextSafe, writeClipboardTextSafe]);

  const enableImeInput = useCallback(() => {
    const state = terminalStates.get(terminalId);
    const term = state?.term;
    if (!state || !term) return;

    state.inputMode = 'ime';
    try {
      term.options.disableStdin = true;
    } catch {
      // ignore
    }

    if (!state.inputDisposable) return;
    try {
      state.inputDisposable.dispose();
    } catch {
      // ignore
    }
    state.inputDisposable = null;
  }, [terminalId]);

  // Keep terminal input in sync with settings (direct xterm input vs IME input bar).
  useEffect(() => {
    if (useImeInput) enableImeInput();
    else enableDirectInput();
  }, [enableDirectInput, enableImeInput, useImeInput]);

  // WKWebView wheel → PTY mouse escape sequence bridge.
  // xterm.js's internal wheel handler calls coreMouseService.triggerMouseEvent() → triggerDataEvent(),
  // but in Tauri's WKWebView, triggerDataEvent never reaches our onData callback for wheel events.
  // Furthermore, xterm.js calls stopPropagation() on wheel events when mouse tracking is active,
  // preventing parent-level handlers from firing.
  //
  // Solution: attach a wheel listener directly on `term.element` (the .xterm div) — the same
  // element where xterm.js attaches its own handlers. Handlers on the same element are NOT blocked
  // by stopPropagation (only stopImmediatePropagation would do that). We then send SGR/DEFAULT
  // mouse escape sequences directly to the PTY via invoke().
  useEffect(() => {
    const term = termRef.current as any;
    if (!term?.element) return;
    const xtermEl = term.element as HTMLElement;

    const handleWheel = (e: WheelEvent) => {
      const t = termRef.current as any;
      if (!t) return;

      const mouseService = t._core?.coreMouseService;
      const activeProtocol = mouseService?.activeProtocol;
      const activeEncoding = mouseService?.activeEncoding;

      // When running in alternate screen buffer (e.g. Claude Code NO_FLICKER mode),
      // the app may handle mouse internally. Check if buffer has switched.
      const isAltBuffer = t._core?.buffers?.active === t._core?.buffers?.alt;

      if (!activeProtocol || activeProtocol === 'NONE') {
        // Even without mouse protocol, if we're in alternate screen buffer,
        // convert wheel events to arrow key sequences so apps can handle scrolling.
        if (isAltBuffer) {
          e.preventDefault();
          const dims = t._core?._renderService?.dimensions;
          const cellH = dims?.css?.cell?.height || 18;
          const scrollLines = Math.max(1, Math.ceil(Math.abs(e.deltaY) / cellH));
          const arrowKey = e.deltaY < 0 ? '\x1b[A' : '\x1b[B'; // Up / Down arrow
          for (let i = 0; i < scrollLines; i++) {
            invoke('write_to_pty', { terminalId, data: arrowKey }).catch(() => {});
          }
          return;
        }
        return;
      }

      // Mouse tracking is active — send mouse wheel events to PTY.
      e.preventDefault();
      e.stopImmediatePropagation(); // prevent xterm.js's own (broken in WKWebView) handler

      // Calculate cell position from pixel coordinates (1-based, as required by SGR/DEFAULT mouse protocols)
      const dims = t._core?._renderService?.dimensions;
      const cellW = dims?.css?.cell?.width || 9;
      const cellH = dims?.css?.cell?.height || 18;
      const screenEl = xtermEl.querySelector('.xterm-screen');
      const rect = (screenEl || xtermEl).getBoundingClientRect();
      const colRaw = Math.floor((e.clientX - rect.left) / cellW) + 1;
      const rowRaw = Math.floor((e.clientY - rect.top) / cellH) + 1;
      const col = Math.max(1, Math.min(colRaw, t.cols || 9999));
      const row = Math.max(1, Math.min(rowRaw, t.rows || 9999));
      const scrollLines = Math.max(1, Math.ceil(Math.abs(e.deltaY) / cellH));

      // SGR button: 64 = scroll up, 65 = scroll down (matches xterm.js eventCode for WHEEL)
      const button = e.deltaY < 0 ? 64 : 65;

      if (activeEncoding === 'SGR') {
        // SGR format: CSI < button ; col ; row M  (col/row are 1-based)
        const seq = `\x1b[<${button};${col};${row}M`;
        for (let i = 0; i < scrollLines; i++) {
          invoke('write_to_pty', { terminalId, data: seq }).catch((err: unknown) => {
            void err;
          });
        }
      } else {
        // DEFAULT encoding: ESC [ M cb cx cy
        const cb = 32 + button;
        const cx = 32 + Math.min(col, 223);
        const cy = 32 + Math.min(row, 223);
        const seq = `\x1b[M${String.fromCharCode(cb, cx, cy)}`;
        for (let i = 0; i < scrollLines; i++) {
          invoke('write_to_pty', { terminalId, data: seq }).catch((err: unknown) => {
            void err;
          });
        }
      }
    };

    // Add on the same element as xterm.js's handlers. Use capture phase to run first,
    // and stopImmediatePropagation to prevent xterm's broken WKWebView handler from running.
    xtermEl.addEventListener('wheel', handleWheel, { passive: false, capture: true });

    // ── Mouse click/drag bridge for WKWebView ──
    // Similar to wheel: xterm.js's mouse events don't reach onData in Tauri WKWebView.
    // We manually send SGR/DEFAULT mouse escape sequences for click, drag, and release.
    const getCellPos = (e: MouseEvent) => {
      const t = termRef.current as any;
      if (!t) return null;
      const dims = t._core?._renderService?.dimensions;
      const cellW = dims?.css?.cell?.width || 9;
      const cellH = dims?.css?.cell?.height || 18;
      const screenEl = xtermEl.querySelector('.xterm-screen');
      const rect = (screenEl || xtermEl).getBoundingClientRect();
      const col = Math.max(1, Math.min(Math.floor((e.clientX - rect.left) / cellW) + 1, t.cols || 9999));
      const row = Math.max(1, Math.min(Math.floor((e.clientY - rect.top) / cellH) + 1, t.rows || 9999));
      return { col, row };
    };

    const getMouseProtocol = () => {
      const t = termRef.current as any;
      const ms = t?._core?.coreMouseService;
      return { protocol: ms?.activeProtocol, encoding: ms?.activeEncoding };
    };

    const sendMouseSeq = (button: number, col: number, row: number, release: boolean, encoding: string) => {
      if (encoding === 'SGR') {
        const seq = `\x1b[<${button};${col};${row}${release ? 'm' : 'M'}`;
        invoke('write_to_pty', { terminalId, data: seq }).catch(() => {});
      } else {
        const cb = 32 + button;
        const cx = 32 + Math.min(col, 223);
        const cy = 32 + Math.min(row, 223);
        const seq = `\x1b[M${String.fromCharCode(cb, cx, cy)}`;
        invoke('write_to_pty', { terminalId, data: seq }).catch(() => {});
      }
    };

    let mouseTracking = false;
    let lastButton = 0;

    const handleMouseDown = (e: MouseEvent) => {
      // Shift+drag forces LOCAL text selection even when the app (Claude/Codex CLI,
      // vim, htop, …) has mouse tracking on — the standard terminal convention.
      // Without this, every drag is forwarded to the app and text can't be selected.
      if (e.shiftKey) return;
      const { protocol, encoding } = getMouseProtocol();
      if (!protocol || protocol === 'NONE') return;
      const pos = getCellPos(e);
      if (!pos) return;

      mouseTracking = true;
      lastButton = e.button; // 0=left, 1=middle, 2=right
      sendMouseSeq(lastButton, pos.col, pos.row, false, encoding);
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!mouseTracking) return;
      const { protocol, encoding } = getMouseProtocol();
      if (!protocol || protocol === 'NONE') return;
      // Only DRAG and ANY protocols report motion
      if (protocol !== 'DRAG' && protocol !== 'ANY') return;
      const pos = getCellPos(e);
      if (!pos) return;
      // Motion: button + 32
      sendMouseSeq(lastButton + 32, pos.col, pos.row, false, encoding);
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (!mouseTracking) return;
      mouseTracking = false;
      const { protocol, encoding } = getMouseProtocol();
      if (!protocol || protocol === 'NONE') return;
      const pos = getCellPos(e);
      if (!pos) return;
      // Release: button 3 for DEFAULT encoding, actual button for SGR
      if (encoding === 'SGR') {
        sendMouseSeq(lastButton, pos.col, pos.row, true, encoding);
      } else {
        sendMouseSeq(3, pos.col, pos.row, false, encoding);
      }
    };

    // Right-click must NOT clear the current selection (xterm clears it on mousedown).
    // Intercept the right-button mousedown in the capture phase when something is selected
    // so the selection survives for the contextmenu copy.
    const handleRightDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const t = termRef.current as any;
      const sel = (t?.getSelection?.() || '') as string;
      if (sel) lastTerminalSelectionRef.current = sel;
      if (t?.hasSelection?.() || lastTerminalSelectionRef.current) { e.preventDefault(); e.stopPropagation(); }
    };
    // Copy-on-select: when a drag-selection settles, copy it to the clipboard — so
    // "drag → it's copied" just works everywhere. We DON'T bail on mouseTracking: when a
    // TUI app (Claude/Codex/vim) owns the mouse, a plain drag is forwarded to the app and
    // produces NO xterm selection, so hasSelection() is false and nothing is copied anyway.
    // But if a selection genuinely exists (e.g. Shift+drag, or the protocol was misreported),
    // copying it is always the right thing — this is the regression that made drag-copy
    // silently stop working inside agent terminals.
    const handleSelectCopy = () => {
      try {
        const t = termRef.current as any;
        if (t?.hasSelection?.()) {
          const sel = (t.getSelection?.() || '') as string;
          if (sel) {
            lastTerminalSelectionRef.current = sel;
            void writeClipboardTextSafe(sel);
          }
        }
      } catch { /* ignore */ }
    };
    // Right-click: copy the selection (fallback when Ctrl/Cmd+C is awkward); if nothing is
    // selected, paste the clipboard — the usual terminal right-click convention.
    const handleContextMenu = (e: MouseEvent) => {
      try {
        const t = termRef.current as any;
        const sel = ((t?.getSelection?.() || '') as string) || lastTerminalSelectionRef.current;
        if (sel) {
          lastTerminalSelectionRef.current = sel;
          e.preventDefault();
          void writeClipboardTextSafe(sel);
          return;
        }
        e.preventDefault();
        void readClipboardTextSafe().then((txt) => { if (txt) sendToPty(txt); });
      } catch { /* ignore */ }
    };
    xtermEl.addEventListener('mousedown', handleRightDown, { capture: true });
    xtermEl.addEventListener('mousedown', handleMouseDown, { capture: true });
    document.addEventListener('mousemove', handleMouseMove, { capture: true });
    document.addEventListener('mouseup', handleMouseUp, { capture: true });
    // Copy-on-select on DOCUMENT mouseup (catches drags that end outside the terminal);
    // it only copies when THIS term actually holds the selection, so it's safe per-pane.
    document.addEventListener('mouseup', handleSelectCopy);
    xtermEl.addEventListener('contextmenu', handleContextMenu);

    return () => {
      xtermEl.removeEventListener('wheel', handleWheel, { capture: true });
      xtermEl.removeEventListener('mousedown', handleRightDown, { capture: true });
      xtermEl.removeEventListener('mousedown', handleMouseDown, { capture: true });
      document.removeEventListener('mousemove', handleMouseMove, { capture: true });
      document.removeEventListener('mouseup', handleMouseUp, { capture: true });
      document.removeEventListener('mouseup', handleSelectCopy);
      xtermEl.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [terminalId]);

  const computeCursorOverlay = useCallback((): { left: number; top: number; cellW: number; cellH: number } | null => {
    const term = termRef.current as any;
    const wrap = terminalWrapRef.current;
    if (!term || !wrap) return null;

    try {
      const dims = term?._core?._renderService?.dimensions;
      // Use CSS pixel dimensions for overlay positioning (not actualCellWidth which is device pixels).
      // On Windows with display scaling (DPR != 1), actualCellWidth causes overlay to drift.
      let cellW: number | null =
        typeof dims?.css?.cell?.width === 'number' && dims.css.cell.width > 0
          ? dims.css.cell.width
          : typeof dims?.actualCellWidth === 'number' && dims.actualCellWidth > 0
            ? dims.actualCellWidth / (window.devicePixelRatio || 1)
            : null;
      let cellH: number | null =
        typeof dims?.css?.cell?.height === 'number' && dims.css.cell.height > 0
          ? dims.css.cell.height
          : typeof dims?.actualCellHeight === 'number' && dims.actualCellHeight > 0
            ? dims.actualCellHeight / (window.devicePixelRatio || 1)
            : null;

      // Fallback: estimate cell size from .xterm-screen element dimensions.
      if (!cellW || !cellH) {
        const screen = wrap.querySelector('.xterm-screen') as HTMLElement | null;
        if (screen) {
          const screenRect = screen.getBoundingClientRect();
          const cols = typeof term.cols === 'number' && term.cols > 0 ? term.cols : 0;
          const rows = typeof term.rows === 'number' && term.rows > 0 ? term.rows : 0;
          if (!cellW && cols > 0 && screenRect.width > 0) cellW = screenRect.width / cols;
          if (!cellH && rows > 0 && screenRect.height > 0) cellH = screenRect.height / rows;
        }
      }
      if (!cellW || !cellH) return null;

      // 실제 터미널 커서 위치를 사용한다. TUI 앱(Claude/Codex 등)도 입력 캐럿에
      // 하드웨어 커서를 두므로 cursorX/cursorY가 곧 조합이 들어갈 자리다.
      // (과거 Windows+TUI에서 "줄의 마지막 비어있지 않은 셀"을 스캔하던 로직은
      //  TUI가 화면을 다시 그릴 때마다 위치가 사방으로 튀어 제거했다.)
      const x = typeof term?.buffer?.active?.cursorX === 'number' ? term.buffer.active.cursorX : 0;
      const y = typeof term?.buffer?.active?.cursorY === 'number' ? term.buffer.active.cursorY : 0;

      const screen = wrap.querySelector('.xterm-screen') as HTMLElement | null;
      const wrapRect = wrap.getBoundingClientRect();
      const screenRect = screen?.getBoundingClientRect();
      const originLeft = screenRect ? screenRect.left - wrapRect.left : 0;
      const originTop = screenRect ? screenRect.top - wrapRect.top : 0;

      const left = Math.round(originLeft + x * cellW);
      const top = Math.round(originTop + y * cellH);
      return { left, top, cellW, cellH };
    } catch {
      return null;
    }
  }, [cliType]);

  useEffect(() => {
    if (!useTauriImeBridge) {
      setCursorOverlay(null);
      return;
    }
    // Keep tracking cursor while bridge mode is enabled.
    // Some TUI layouts can momentarily desync active state and break IME anchor updates.

    const term = termRef.current;
    if (!term) return;

    let raf: number | null = null;
    let resyncRaf: number | null = null;
    const update = () => {
      // While composing, the anchor is FROZEN: after each syllable commit the
      // PTY echo is still in flight (cursorX points at the previous cell),
      // and TUI redraws expose mid-frame cursor positions — both made the
      // preedit overlay jump ahead/overlap during Hangul composition. The
      // per-commit local advance happens in commitImeBridgeText instead.
      //
      // But the local advance can't model line wraps or TUI composer
      // re-layout (빠릿에이전트 redraws its whole composer per commit), so once
      // the echo has painted and the terminal goes quiet, resync the frozen
      // anchor to the real cursor — it is where the next preedit belongs in
      // any layout.
      if (imeBridgeComposingRef.current) {
        if (!shouldResyncImeAnchor(
          Date.now(),
          imeLastRenderAtRef.current,
          imeLastPtySendAtRef.current,
          IME_ANCHOR_RESYNC_QUIET_MS,
        )) return;
        if (resyncRaf != null) return;
        resyncRaf = window.requestAnimationFrame(() => {
          resyncRaf = null;
          if (!imeBridgeComposingRef.current) return;
          const next = computeCursorOverlay();
          if (!next) return;
          setCursorOverlay((prev) =>
            prev &&
            prev.left === next.left &&
            prev.top === next.top &&
            prev.cellW === next.cellW &&
            prev.cellH === next.cellH
              ? prev
              : next,
          );
        });
        return;
      }
      if (raf != null) return;
      raf = window.requestAnimationFrame(() => {
        raf = null;
        // A composition may have started between queueing and this frame.
        if (imeBridgeComposingRef.current) return;
        const next = computeCursorOverlay();
        setCursorOverlay((prev) => {
          // If we temporarily fail to compute dimensions, keep the last known cursor position
          // instead of flickering the cursor on/off.
          if (!next) return prev;
          if (
            prev &&
            prev.left === next.left &&
            prev.top === next.top &&
            prev.cellW === next.cellW &&
            prev.cellH === next.cellH
          ) {
            return prev;
          }
          return next;
        });
      });
    };

    update();

    const disposables: Array<{ dispose: () => void }> = [];
    try {
      disposables.push(term.onCursorMove(() => {
        imeLastRenderAtRef.current = Date.now();
        update();
      }));
    } catch {
      // ignore
    }
    try {
      disposables.push(term.onRender(() => {
        imeLastRenderAtRef.current = Date.now();
        update();
      }));
    } catch {
      // ignore
    }

    // As a fallback, refresh periodically in case the cursor moves without firing events.
    const id = window.setInterval(update, 120);

    return () => {
      if (raf != null) window.cancelAnimationFrame(raf);
      if (resyncRaf != null) window.cancelAnimationFrame(resyncRaf);
      window.clearInterval(id);
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          // ignore
        }
      }
    };
  }, [computeCursorOverlay, useTauriImeBridge]);

  // NOTE: native composition UI can draw an unwanted highlighted box. Keep the
  // textarea hidden and render clean preedit text ourselves.

  const updateImeBridgeComposition = useCallback((nextRaw: string) => {
    const raw = (nextRaw || '').toString();
    const startedFrom = (imeBridgeCompositionStartValueRef.current || '').toString();
    let next = raw;
    if (startedFrom && next.startsWith(startedFrom)) {
      next = next.slice(startedFrom.length);
    }
    next = next.replace(/\r?\n/g, '');
    // Safety cap: prevent oversized preedit overlays from covering the terminal.
    if (next.length > 24) next = next.slice(-24);

    const prev = imeBridgeCompositionTextRef.current || '';
    if (next === prev) return;

    // Never push preedit text into the PTY. Keep it visible only in the local
    // composition surface until compositionend commits the final text.
    imeBridgeCompositionTextRef.current = next;
    setImePreeditText(next);
  }, []);

  const commitImeBridgeText = useCallback((raw: string) => {
    const finalText = raw ? raw.replace(/\r?\n/g, '').normalize('NFC') : '';
    const now = Date.now();
    const last = imeBridgeLastCommittedRef.current;
    const lastAt = imeBridgeLastCommittedAtRef.current;

    // Some WebKit builds emit commit-equivalent events twice (input + compositionend).
    // Dedupe same payload in a short window so Hangul does not get duplicated/garbled.
    // Windows IME tends to fire more duplicate events, so use a wider dedup window.
    const dedupWindowMs = IS_MAC_IME ? 700 : 300;
    if (finalText && last && finalText === last && now - lastAt < dedupWindowMs) {
      return;
    }

    imeBridgeLastCommittedRef.current = finalText;
    imeBridgeLastCommittedAtRef.current = now;
    if (finalText) {
      sendToPty(normalizeInputNewlines(finalText));
      imeLastPtySendAtRef.current = now;
      // The cursor-overlay anchor is frozen during composition (see the
      // tracking effect); when the next syllable's composition starts right
      // after this commit, the PTY echo hasn't come back yet, so advance the
      // anchor locally by the committed width — otherwise the new preedit
      // draws on top of the syllable just committed. Line wraps and TUI
      // composer re-layout are corrected by the settled-cursor resync in the
      // tracking effect; the advance only clamps at the right edge.
      setCursorOverlay((prev) => {
        if (!prev) return prev;
        const wrapWidth = terminalWrapRef.current?.clientWidth ?? Infinity;
        return advanceImeAnchor(prev, finalText, wrapWidth);
      });
    }
  }, [sendToPty, readClipboardTextSafe, writeClipboardTextSafe]);

  const resolveImeCommitText = useCallback((el: HTMLTextAreaElement, eventData?: string | null) => {
    const current = (el.value || '').toString();
    const startedFrom = (imeBridgeCompositionStartValueRef.current || '').toString();
    if (current) {
      if (startedFrom && current.startsWith(startedFrom)) {
        return current.slice(startedFrom.length);
      }
      return current;
    }
    // Fallback 1: use compositionend e.data (some Windows IMEs clear el.value before compositionend)
    const fromEvent = (eventData || '').toString();
    if (fromEvent) return fromEvent;
    // Fallback 2: use the last known composition text (preedit overlay value)
    return (imeBridgeCompositionTextRef.current || '').toString();
  }, [writeClipboardTextSafe]);

  const handleImeBridgeKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While composing, let the IME handle most keys. If Enter is pressed, we defer sending it to
    // the terminal until the composition commits.
    const ne = e.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number; which?: number };
    const key229 = ne?.keyCode === 229 || ne?.which === 229;
    const nativeIsComposing = ne?.isComposing === true || key229 || e.key === 'Process';
    // Note: Do NOT preventDefault for key229 — it blocks Windows IME from processing the keystroke.
    // keyCode 229 is the "IME is processing" signal; let it flow through to composition events.
    // If the textarea currently holds any text, treat Enter as "commit first" (IME or in-flight input).
    if (e.key === 'Enter') {
      const current = (e.currentTarget.value || '').toString();
      if (imeBridgeComposingRef.current || nativeIsComposing || current.length > 0) {
        e.preventDefault();
        imeBridgePendingEnterRef.current = e.shiftKey ? 'shift-enter' : 'enter';
        return;
      }
    }

    // Esc is a cancel intent (agent turn / TUI overlay) — never defer it to the
    // IME: macOS Hangul keeps a composition open indefinitely, so the old guard
    // swallowed every Esc until unrelated typing closed the syllable. Discard
    // the preedit and deliver the key (routeKeyDuringComposition contract).
    if (routeKeyDuringComposition(e.key, imeBridgeComposingRef.current || nativeIsComposing) === 'esc') {
      e.preventDefault();
      if (imeBridgeComposingRef.current || nativeIsComposing) {
        imeBridgeDiscardCompositionEndRef.current = true;
        imeBridgeComposingRef.current = false;
        imeBridgeCompositionStartValueRef.current = '';
        imeBridgeCompositionTextRef.current = '';
        imeBridgePendingEnterRef.current = false;
        setImePreeditText('');
        const el = e.currentTarget;
        el.value = '';
        // Blur+refocus tears down the OS-level composition; otherwise the next
        // keystroke resumes the stale preedit and re-arms the guard.
        el.blur();
        requestAnimationFrame(() => el.focus({ preventScroll: true }));
      }
      sendToPty('\x1b');
      return;
    }

    if (imeBridgeComposingRef.current || nativeIsComposing) {
      if (e.key === 'Enter') imeBridgePendingEnterRef.current = e.shiftKey ? 'shift-enter' : 'enter';
      return;
    }

    // Cmd-based shortcuts (macOS) in bridge mode.
    if (e.metaKey && !e.ctrlKey && !e.altKey) {
      const k = getShortcutKey(e);
      console.log('[ClipDebug] handleImeBridgeKeyDown Cmd+' + k, { composing: imeBridgeComposingRef.current, defaultPrevented: e.nativeEvent?.defaultPrevented });
      if (k === 'c') {
        const term = termRef.current;
        const selected = term?.getSelection() || window.getSelection()?.toString() || '';
        console.log('[ClipDebug] Cmd+C in bridge textarea, selection=', selected ? `"${selected.slice(0, 50)}..."` : '(none)');
        if (selected) {
          // Don't preventDefault — let native copy event fire as backup
          void writeClipboardTextSafe(selected);
          return;
        }
        // No selection: allow default Cmd+C behavior.
        return;
      }
      if (k === 'v') return;
      if (k === 'x') {
        const term = termRef.current;
        const selected = term?.getSelection() || window.getSelection()?.toString() || '';
        if (selected) {
          // Don't preventDefault — let native cut event fire as backup
          void writeClipboardTextSafe(selected);
        }
        return;
      }
      if (k === 'a') {
        const term = termRef.current;
        if (term) {
          e.preventDefault();
          term.selectAll();
        }
        return;
      }
      return;
    }

    const key = e.key;
    const ctrl = e.ctrlKey;
    const alt = e.altKey;
    const shift = e.shiftKey;
    const meta = e.metaKey;
    const term = termRef.current;

    // Clipboard shortcuts in bridge mode.
    // - Ctrl+C: Smart behavior - copy selection if present, else send SIGINT
    // - Ctrl+V / Shift+Insert: Don't intercept. Let native paste event flow.
    // - Ctrl+Insert: copies selection.
    if (ctrl && !alt && !meta) {
      const k = getShortcutKey(e);
      // Smart Ctrl+C: Copy if selection exists, else send SIGINT
      if (k === 'c') {
        if (term && term.hasSelection()) {
          // Don't preventDefault — let native copy event fire as backup
          const sel = term.getSelection() || '';
          if (sel) void writeClipboardTextSafe(sel);
          return;
        }
        // No selection: send SIGINT explicitly (disableStdin=true so xterm won't do it)
        e.preventDefault();
        sendToPty('\x03');
        return;
      }
      // Ctrl+Insert: Always copy selection
      if (k === 'insert' && term && term.hasSelection()) {
        // Don't preventDefault — let native copy event fire as backup
        const sel = term.getSelection() || '';
        if (sel) void writeClipboardTextSafe(sel);
        return;
      }
      // Ctrl+V: Don't intercept. Let native paste event flow to container paste handler.
      if (k === 'v') return;
    }
    // Shift+Insert: Don't intercept. Let native paste event flow.
    if (!ctrl && shift && !alt && !meta && key === 'Insert') return;

    // Enter
    if (key === 'Enter') {
      e.preventDefault();
      // Modified Enter: send kitty-style CSI-u sequence (Shift always; Ctrl/Alt when
      // extended keyboard is enabled). Plain Enter stays a carriage return.
      if (shift || ((ctrl || alt) && csiUKeysRef.current)) {
        const mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
        sendToPty(`\x1b[13;${mod}u`);
      } else {
        sendToPty('\x0d');
      }
      return;
    }

    // JIS keyboards: physical Yen key types a backslash instead of ¥
    if (jisYenRef.current && !ctrl && !meta && !alt && (e.code === 'IntlYen' || key === '¥')) {
      e.preventDefault();
      sendToPty('\\');
      return;
    }

    // Tab
    if (key === 'Tab') {
      e.preventDefault();
      if (shift) sendToPty('\x1b[Z');
      else sendToPty('\x09');
      return;
    }

    // Escape is handled above the composition guard (routeKeyDuringComposition).

    // Backspace
    if (key === 'Backspace') {
      e.preventDefault();
      if (ctrl) sendToPty('\x08');
      else if (alt) sendToPty('\x1b\x7f');
      else sendToPty('\x7f');
      return;
    }

    // Arrow keys
    if (key === 'ArrowUp') {
      e.preventDefault();
      sendToPty(ctrl || meta ? '\x1b[1;5A' : '\x1b[A');
      return;
    }
    if (key === 'ArrowDown') {
      e.preventDefault();
      sendToPty(ctrl || meta ? '\x1b[1;5B' : '\x1b[B');
      return;
    }
    if (key === 'ArrowLeft') {
      e.preventDefault();
      if (ctrl || meta) sendToPty('\x1b[1;5D');
      else if (alt) sendToPty('\x1bb');
      else sendToPty('\x1b[D');
      return;
    }
    if (key === 'ArrowRight') {
      e.preventDefault();
      if (ctrl || meta) sendToPty('\x1b[1;5C');
      else if (alt) sendToPty('\x1bf');
      else sendToPty('\x1b[C');
      return;
    }

    // Home/End
    if (key === 'Home') {
      e.preventDefault();
      sendToPty('\x1b[H');
      return;
    }
    if (key === 'End') {
      e.preventDefault();
      sendToPty('\x1b[F');
      return;
    }

    // Page Up/Down
    if (key === 'PageUp') {
      e.preventDefault();
      sendToPty('\x1b[5~');
      return;
    }
    if (key === 'PageDown') {
      e.preventDefault();
      sendToPty('\x1b[6~');
      return;
    }

    // Delete
    if (key === 'Delete') {
      e.preventDefault();
      sendToPty('\x1b[3~');
      return;
    }

    // Ctrl key combos (terminal control codes)
    // Note: Ctrl+C is handled above (copy/SIGINT), Ctrl+V is intentionally omitted
    // so native paste events can flow to the container paste handler.
    if (ctrl && !alt && !meta) {
      const ctrlKey = getShortcutKey(e);
      const ctrlCodes: Record<string, string> = {
        'a': '\x01', 'b': '\x02', 'd': '\x04',
        'e': '\x05', 'f': '\x06', 'g': '\x07', 'h': '\x08',
        'i': '\x09', 'j': '\x0a', 'k': '\x0b', 'l': '\x0c',
        'm': '\x0d', 'n': '\x0e', 'o': '\x0f', 'p': '\x10',
        'q': '\x11', 'r': '\x12', 's': '\x13', 't': '\x14',
        'u': '\x15', 'w': '\x17', 'x': '\x18',
        'y': '\x19', 'z': '\x1a',
        '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f',
        ' ': '\x00', '?': '\x7f',
      };
      if (ctrlCodes[ctrlKey]) {
        e.preventDefault();
        e.stopPropagation();
        sendToPty(ctrlCodes[ctrlKey]);
        return;
      }
    }

    // Alt key combos: send ESC + key (e.g. Alt+M → ESC m) (#43)
    if (alt && !ctrl && !meta && key.length === 1) {
      e.preventDefault();
      sendToPty('\x1b' + key.toLowerCase());
      return;
    }

    // F1-F12 keys
    const fKeys: Record<string, string> = {
      'F1': '\x1bOP', 'F2': '\x1bOQ', 'F3': '\x1bOR', 'F4': '\x1bOS',
      'F5': '\x1b[15~', 'F6': '\x1b[17~', 'F7': '\x1b[18~', 'F8': '\x1b[19~',
      'F9': '\x1b[20~', 'F10': '\x1b[21~', 'F11': '\x1b[23~', 'F12': '\x1b[24~',
    };
    if (fKeys[key]) {
      e.preventDefault();
      sendToPty(fKeys[key]);
      return;
    }
  }, [sendToPty]);

  const handleImeBridgeBeforeInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const ne = e.nativeEvent as unknown as { inputType?: string; isComposing?: boolean; data?: string };
    const inputType = ne?.inputType || '';
    const nativeIsComposing = ne?.isComposing === true;
    const looksLikeComposition =
      nativeIsComposing || /composition/i.test(inputType) || inputType === 'insertCompositionText';
    if (looksLikeComposition) {
      // Esc discarded the composition — ignore its trailing events entirely.
      if (imeBridgeDiscardCompositionEndRef.current) return;
      const next = (e.currentTarget.value || ne?.data || '').toString();
      if (next) updateImeBridgeComposition(next);
      return;
    }
    if (inputType !== 'insertParagraph' && inputType !== 'insertLineBreak') return;

    const value = (e.currentTarget.value || '').toString();
    const hasJamo = /[\u1100-\u11FF\u3130-\u318F]/.test(value);
    if (imeBridgeComposingRef.current || nativeIsComposing || value.length > 0 || hasJamo) {
      e.preventDefault();
      imeBridgePendingEnterRef.current = 'enter';
      return;
    }

    e.preventDefault();
    sendToPty('\x0d');
  }, [sendToPty, updateImeBridgeComposition]);

  const handleImeBridgePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    lastNativePasteAtRef.current = Date.now();
    if (pendingPasteFallbackTimerRef.current != null) {
      window.clearTimeout(pendingPasteFallbackTimerRef.current);
      pendingPasteFallbackTimerRef.current = null;
    }
    // Prevent text from being inserted into the hidden bridge textarea.
    // The actual paste is handled by the container-level paste handler on terminalWrapRef
    // which fires before this React handler and sends text to PTY via writeToPtyRef.
    e.preventDefault();
  }, []);

  const handleImeBridgeInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const value = el.value || '';
    if (!value) return;

    const ne = e.nativeEvent as unknown as { isComposing?: boolean; inputType?: string };
    const nativeIsComposing = ne?.isComposing === true;
    const inputType = ne?.inputType || '';
    const looksLikeComposition =
      nativeIsComposing || /composition/i.test(inputType) || inputType === 'insertCompositionText';

    // Strict rule: while composing, never send text directly to PTY.
    // We only commit on compositionend to avoid preedit/output overlap.
    if (imeBridgeComposingRef.current || looksLikeComposition) {
      // Esc discarded the composition — don't let a trailing composition event
      // re-arm the guard or repaint the dropped preedit.
      if (imeBridgeDiscardCompositionEndRef.current) {
        el.value = '';
        return;
      }
      if (!imeBridgeComposingRef.current) imeBridgeComposingRef.current = true;
      updateImeBridgeComposition(value);
      return;
    }

    // After compositionend, WKWebView/Windows WebView2 can fire multiple input events:
    // 1st: the full committed text (e.g. "게") — exact match of committed
    // 2nd: just the trailing jamo (e.g. "ㅔ") — partial echo of composition
    // Both must be suppressed since commitImeBridgeText already sent the text.
    // Use wider window on Windows to catch delayed echo events.
    const suppressWindowMs = IS_MAC_IME ? 1200 : 500;
    const timeSinceCommit = Date.now() - imeBridgeLastCommittedAtRef.current;
    if (timeSinceCommit < suppressWindowMs) {
      const committed = imeBridgeLastCommittedRef.current;
      // Suppress exact match of committed text
      if (committed && (value === committed || value === `${committed}\n` || value === `${committed}\r\n`)) {
        el.value = '';
        return;
      }
      // Suppress lone Korean jamo that are echo artifacts of the composition.
      // Jamo ranges: Hangul Compatibility Jamo U+3130-318F, Hangul Jamo U+1100-11FF
      const isJamoEcho = /^[\u1100-\u11FF\u3130-\u318F]+$/.test(value);
      if (isJamoEcho) {
        el.value = '';
        return;
      }
    }

    sendToPty(normalizeInputNewlines(value));
    el.value = '';
  }, [commitImeBridgeText, sendToPty, updateImeBridgeComposition]);

  const handleImeBridgeCompositionStart = useCallback((e: React.CompositionEvent<HTMLTextAreaElement>) => {
    // IME 조합 시작 시 스크롤을 맨 아래로 리셋 (위로 스크롤된 상태에서 입력하면 조합창 위치가 어긋남)
    const st = terminalStates.get(terminalId);
    if (st?.userScrolledUp) {
      st.userScrolledUp = false;
      st.scrollOffsetFromBottom = 0;
      try { st.term?.scrollToBottom(); } catch { /* ignore */ }
    }
    imeBridgeComposingRef.current = true;
    imeBridgeDiscardCompositionEndRef.current = false;
    imeBridgeCompositionStartValueRef.current = (e.currentTarget.value || '').toString();
    imeBridgeCompositionTextRef.current = '';
    imeBridgeLastCommittedRef.current = '';
    imeBridgeLastCommittedAtRef.current = 0;
    imeBridgePendingEnterRef.current = false;
    setImePreeditText('');
  }, [terminalId]);

  const handleImeBridgeCompositionUpdate = useCallback((e: React.CompositionEvent<HTMLTextAreaElement>) => {
    if (!imeBridgeComposingRef.current) imeBridgeComposingRef.current = true;
    // On Windows, e.data contains the full preedit text (e.g. "한").
    // On macOS, e.currentTarget.value may include prior committed text as prefix.
    // Prefer e.data for preedit display as it always represents the current composition.
    const preedit = e.data ?? '';
    if (preedit) {
      // Use e.data directly for overlay - no startedFrom stripping needed
      const prev = imeBridgeCompositionTextRef.current || '';
      const normalized = preedit.replace(/\r?\n/g, '');
      if (normalized !== prev) {
        imeBridgeCompositionTextRef.current = normalized;
        setImePreeditText(normalized);
      }
    } else {
      // Fallback: use textarea value with startedFrom stripping
      updateImeBridgeComposition(e.currentTarget.value ?? '');
    }
  }, [updateImeBridgeComposition]);

  const handleImeBridgeCompositionEnd = useCallback((e: React.CompositionEvent<HTMLTextAreaElement>) => {
    if (imeBridgeDiscardCompositionEndRef.current) {
      // Esc discarded this composition — drop the IME's late commit entirely.
      imeBridgeDiscardCompositionEndRef.current = false;
      imeBridgeComposingRef.current = false;
      imeBridgeCompositionStartValueRef.current = '';
      imeBridgeCompositionTextRef.current = '';
      imeBridgePendingEnterRef.current = false;
      setImePreeditText('');
      e.currentTarget.value = '';
      return;
    }
    const raw = resolveImeCommitText(e.currentTarget, e.data);

    imeBridgeComposingRef.current = false;
    imeBridgeCompositionStartValueRef.current = '';
    imeBridgeCompositionTextRef.current = '';

    // Clear preedit overlay
    setImePreeditText('');

    commitImeBridgeText(raw);

    // Keep the bridge empty to avoid affecting OS shortcuts and to ensure the next input is delta-only.
    e.currentTarget.value = '';

    if (imeBridgePendingEnterRef.current) {
      const pending = imeBridgePendingEnterRef.current;
      imeBridgePendingEnterRef.current = false;
      sendToPty(pending === 'shift-enter' ? '\x1b[13;2u' : '\x0d');
    }
  }, [commitImeBridgeText, resolveImeCommitText, sendToPty]);

  // ResizeObserver로 컨테이너 크기 변경 감지
  useEffect(() => {
    const wrap = terminalWrapRef.current;
    const mount = terminalMountRef.current;
    if (!wrap) return;

    let resizeTimeout: number | null = null;
    // 탭 전환으로 숨겨졌다 돌아올 때는 숨김 구간의 핀 오염을 무시하고 숨기기
    // 시점의 핀으로 복원한다 (captureHiddenPin/restorePinAfterReveal 참조).
    let hiddenPin: HiddenPinSnapshot | null = null;
    const handleResize = () => {
      if (resizeTimeout) return;
      resizeTimeout = window.setTimeout(() => {
        resizeTimeout = null;
        if (isDisposedRef.current || !fitRef.current || !termRef.current) return;
        const fitHost = terminalMountRef.current || wrap;
        if (fitHost.offsetHeight <= 0 || fitHost.offsetWidth <= 0) {
          if (!hiddenPin) hiddenPin = captureHiddenPin(terminalStates.get(terminalId));
          return;
        }
        const returningPin = hiddenPin;
        hiddenPin = null;
        try {
          const state = terminalStates.get(terminalId);
          const refit = () => {
            fitRef.current?.fit();
          };
          if (returningPin) {
            restorePinAfterReveal(termRef.current, state, returningPin, refit);
          } else {
            preserveTerminalViewport(termRef.current, state, refit, true, true);
          }
          invoke('resize_pty', {
            terminalId,
            rows: termRef.current.rows,
            cols: termRef.current.cols,
          }).catch(() => {});
        } catch {
          // ignore
        }
      }, RESIZE_DEBOUNCE_MS);
    };

    const ro = new ResizeObserver(handleResize);
    ro.observe(wrap);
    if (mount) ro.observe(mount);

    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      ro.disconnect();
    };
  }, [terminalId]);

  // 테마/설정 변경 처리
  useEffect(() => {
    if (!termRef.current || isDisposedRef.current || !terminalWrapRef.current) return;

    const actualFont = fontFamily || TERMINAL_FONT_FAMILY;
    const wrap = terminalWrapRef.current;

    const applyTerminalFont = () => {
      if (!termRef.current || !wrap || isDisposedRef.current) return;

      termRef.current.options.fontFamily = actualFont;
      termRef.current.options.fontSize = fontSize;
      termRef.current.options.cursorBlink = cursorBlink;
      termRef.current.options.cursorStyle = cursorStyle;
      termRef.current.options.cursorInactiveStyle = cursorStyle;
      termRef.current.options.theme = {
        background: style?.bg || '#1e1e2e',
        foreground: style?.text || '#cdd6f4',
        // Use text color for cursor for visibility in light themes as well.
        cursor: style?.cursor || style?.text || '#cdd6f4',
        cursorAccent: style?.bg || '#1e1e2e',
        selectionBackground: style?.selectionBg || getSelectionColor(style?.accent),
        ...getAnsiTheme(style?.ansi),
      };

      wrap.style.fontFamily = actualFont;

      // DOM 스타일 강제 적용 (Tauri WebKit 호환성)
      const rows = wrap.querySelector('.xterm-rows') as HTMLElement;
      if (rows) {
        rows.style.fontSize = `${fontSize}px`;
        rows.style.fontFamily = actualFont;
      }
      const screen = wrap.querySelector('.xterm-screen') as HTMLElement;
      if (screen) {
        screen.style.fontFamily = actualFont;
      }

      if (fitRef.current) {
        const state = terminalStates.get(terminalId);
        preserveTerminalViewport(termRef.current, state, () => {
          fitRef.current?.fit();
          termRef.current?.refresh(0, termRef.current.rows - 1);
        }, true, true);
      }
    };

    try {
      applyTerminalFont();
    } catch {
      // ignore
    }

    const fontsApi = (document as Document & {
      fonts?: {
        load?: (font: string, text?: string) => Promise<unknown>;
      };
    }).fonts;
    if (fontsApi?.load) {
      void fontsApi.load(`${fontSize}px ${actualFont}`, 'ABCDEFGHIJKLMnopqrstuvwxyz0123456789')
        .then(() => {
          applyTerminalFont();
        })
        .catch(() => {});
    }
  }, [cursorBlink, cursorStyle, fontFamily, fontSize, style?.bg, style?.text, style?.accent]);

  // 활성화시 fit + resize + 스크롤 위치 복원
  // 에디터 모드에서 돌아올 때 xterm 크기가 어긋나는 문제 해결 (#39)
  const wasActiveRef = useRef(false);
  useEffect(() => {
    const timers: number[] = [];
    if (isActive && !wasActiveRef.current) {
      // Force fit + resize when terminal becomes active again (e.g. returning from editor mode)
      const doFitAndRefresh = () => {
        const term = termRef.current;
        const fit = fitRef.current;
        if (!term || !fit || isDisposedRef.current) return;
        const wrap = terminalWrapRef.current;
        if (!wrap || wrap.offsetWidth <= 0 || wrap.offsetHeight <= 0) return;
        try {
          const state = terminalStates.get(terminalId);
          preserveTerminalViewport(term, state, () => {
            fit.fit();
            term.refresh(0, term.rows - 1);
          }, true, true);
          invoke('resize_pty', {
            terminalId,
            rows: term.rows,
            cols: term.cols,
          }).catch(() => {});
        } catch { /* ignore */ }
      };
      // Immediate + delayed fit to handle layout settling
      doFitAndRefresh();
      timers.push(window.setTimeout(doFitAndRefresh, 150));
      // 에디터에서 돌아올 때 포커스 + 커서 위치 복원 (#39)
      timers.push(window.setTimeout(() => { if (!isDisposedRef.current) focusActiveInput(); }, 200));

      const state = terminalStates.get(terminalId);
      const term = state?.term || termRef.current;
      // 실제 버퍼 위치와 플래그 모두 확인하여, 위로 스크롤된 상태면 강제 이동하지 않음
      const bufAtBottom = term ? term.buffer.active.viewportY >= term.buffer.active.baseY : true;
      if (bufAtBottom && !state?.userScrolledUp) {
        scrollActiveTerminalToBottom();
      }
    }
    wasActiveRef.current = isActive;
    return () => { timers.forEach((t) => window.clearTimeout(t)); };
  }, [isActive, scrollActiveTerminalToBottom, terminalId]);

  // Track viewport position so we can show a floating "scroll to bottom" button only when needed.
  // Also listen for wheel events to immediately set userScrolledUp before onScroll fires.
  useEffect(() => {
    let disposed = false;
    let rafId: number | null = null;
    let vpRafId: number | null = null;
    let scrollDisposable: { dispose: () => void } | null = null;
    let viewportEl: Element | null = null;

    // 마우스 휠/트랙패드 스크롤 시 즉시 핀(userScrolledUp/scrollOffsetFromBottom) 갱신.
    // write 진행 중에는 onScroll이 핀을 못 만지므로(오감지 방지) 휠에서 양방향 모두
    // 예측 갱신해야 한다 — 휠 다운을 무시하면 write 복원이 옛 핀으로 계속 끌어올려
    // 출력이 흐르는 동안(Kimi TUI + Windows ConPTY 상시 리페인트) 바닥까지 못 내려간다.
    const wrap = terminalWrapRef.current;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      const state = terminalStates.get(terminalId);
      if (!state) return;
      const term = state.term as any;
      if (!term) return;
      // alt buffer(전체화면 TUI)에는 스크롤백이 없다 — 핀을 건드리면 alt 종료 후 오작동
      if (term._core?.buffers?.active === term._core?.buffers?.alt) return;
      const buf = term.buffer.active;
      const dist = Math.max(0, buf.baseY - buf.viewportY);
      const cellH = term._core?._renderService?.dimensions?.css?.cell?.height || 18;
      // deltaMode: 0=pixel(맥 트랙패드), 1=line(Windows 휠 기본), 2=page.
      // line/page 모드를 픽셀로 나누면 틱당 이동이 과소평가돼 휠이 느리게 먹는다.
      const wheelLines = e.deltaMode === 1
        ? Math.max(1, Math.ceil(Math.abs(e.deltaY)))
        : e.deltaMode === 2
          ? Math.max(1, Math.ceil(Math.abs(e.deltaY)) * (term.rows || 24))
          : Math.ceil(Math.abs(e.deltaY) / cellH);
      const next = applyWheelToScrollPin(
        { userScrolledUp: !!state.userScrolledUp, scrollOffsetFromBottom: state.scrollOffsetFromBottom || 0 },
        e.deltaY,
        dist,
        wheelLines,
      );
      const releasedToBottom = state.userScrolledUp && !next.userScrolledUp;
      state.userScrolledUp = next.userScrolledUp;
      state.scrollOffsetFromBottom = next.scrollOffsetFromBottom;
      if (releasedToBottom) {
        try { state.term?.scrollToBottom(); } catch { /* ignore */ }
      }
    };
    if (wrap) {
      wrap.addEventListener('wheel', onWheel, { passive: true });
    }

    const connect = () => {
      if (disposed) return;
      const term = terminalStates.get(terminalId)?.term || termRef.current;
      if (!term) {
        rafId = window.requestAnimationFrame(connect);
        return;
      }

      updateScrollButtonVisibility();

      try {
        scrollDisposable = term.onScroll(() => {
          updateScrollButtonVisibility();
          // userScrolledUp 플래그 업데이트
          const state = terminalStates.get(terminalId);
          if (state && term) {
            const buf = term.buffer.active;
            const dist = Math.max(0, buf.baseY - buf.viewportY);
            // write 진행 중이거나 프로그램적 복원 직후: write 자동스크롤/복원이 만든
            // 비동기 scroll 이벤트가 핀을 임의 위치로 덮지 못하게 보호.
            // 휠 스크롤은 onWheel에서 양방향으로 핀을 직접 갱신하므로 여기 안 걸린다.
            // 숨김(display:none) 상태의 스크롤 이벤트도 신뢰 금지 — 뷰포트 붕괴가
            // 만든 가짜 dist로 핀이 오염되면 복귀 시 중간에 멈춘 채 고정된다.
            const wrapHidden = !wrap || wrap.offsetHeight <= 0;
            if (wrapHidden || !shouldTrustScrollForPin(state, Date.now())) {
              // 맨 아래 도달 시에만 userScrolledUp 리셋 허용
              // (위로 스크롤된 것처럼 오감지하는 것은 방지하되, 맨 아래 복귀는 감지)
              if (dist === 0) {
                state.userScrolledUp = false;
                state.scrollOffsetFromBottom = 0;
              }
            } else {
              state.userScrolledUp = dist > 0;
              state.scrollOffsetFromBottom = dist;
            }
          }
        });
      } catch {
        // ignore
      }

      // 사용자 휠/스크롤바 스크롤은 xterm이 suppressScrollEvent로 버퍼에 동기화해
      // term.onScroll이 발화하지 않는다 — viewport DOM scroll을 직접 구독해야
      // 조용한 터미널에서도 위로 스크롤하면 버튼이 뜬다.
      const attachViewportScroll = () => {
        if (disposed || !wrap) return;
        const vp = wrap.querySelector('.xterm-viewport');
        if (!vp) {
          vpRafId = window.requestAnimationFrame(attachViewportScroll);
          return;
        }
        viewportEl = vp;
        vp.addEventListener('scroll', updateScrollButtonVisibility, { passive: true });
      };
      attachViewportScroll();
    };

    connect();

    return () => {
      disposed = true;
      if (rafId != null) window.cancelAnimationFrame(rafId);
      if (vpRafId != null) window.cancelAnimationFrame(vpRafId);
      if (viewportEl) {
        viewportEl.removeEventListener('scroll', updateScrollButtonVisibility);
      }
      if (scrollDisposable) {
        try {
          scrollDisposable.dispose();
        } catch {
          // ignore
        }
      }
      if (wrap) {
        wrap.removeEventListener('wheel', onWheel);
      }
    };
  }, [terminalId, updateScrollButtonVisibility]);

  // macOS native Edit menu triggers copy/cut events (not keydown) when Cmd+C/X is pressed.
  // xterm.js uses canvas-based selection that the browser Selection API cannot see,
  // so we must intercept the copy/cut events and provide xterm's selection data.
  useEffect(() => {
    const container = terminalWrapRef.current;
    if (!container) return;
    const term = termRef.current;
    if (!term) return;

    const handleCopy = (e: ClipboardEvent) => {
      // Use termRef.current (live reference) instead of captured `term` to avoid
      // accessing a disposed terminal instance which causes SIGSEGV on macOS ARM64.
      const liveTerm = termRef.current;
      if (!liveTerm) return;
      try {
        const selected = trimSelectionTrailingWhitespace(liveTerm.getSelection() || '');
        if (selected) {
          e.preventDefault();
          e.clipboardData?.setData('text/plain', selected);
        }
      } catch {
        // Terminal may have been disposed between the null check and getSelection()
      }
    };
    const handleCut = (e: ClipboardEvent) => {
      const liveTerm = termRef.current;
      if (!liveTerm) return;
      try {
        const selected = trimSelectionTrailingWhitespace(liveTerm.getSelection() || '');
        if (selected) {
          e.preventDefault();
          e.clipboardData?.setData('text/plain', selected);
        }
      } catch {
        // Terminal may have been disposed between the null check and getSelection()
      }
    };

    container.addEventListener('copy', handleCopy);
    container.addEventListener('cut', handleCut);
    return () => {
      container.removeEventListener('copy', handleCopy);
      container.removeEventListener('cut', handleCut);
    };
  }, [terminalId]);

  // 클립보드 이미지 붙여넣기 핸들러
  useEffect(() => {
    const container = terminalWrapRef.current;
    if (!container) return;

    const handlePaste = async (e: ClipboardEvent) => {
      lastNativePasteAtRef.current = Date.now();
      if (pendingPasteFallbackTimerRef.current != null) {
        window.clearTimeout(pendingPasteFallbackTimerRef.current);
        pendingPasteFallbackTimerRef.current = null;
      }
      console.log('[ClipDebug] container paste event fired, text=', e.clipboardData?.getData('text/plain')?.slice(0, 50));
      // The internal bbarit agent TUI recognises a leading `@<path>` with an image
      // extension as a vision attachment and does NOT auto-submit, so the user can
      // add a prompt before sending (mirrors the TUI's own Ctrl+V `@path` token).
      // Other CLIs (claude/codex) expect a bare, shell-quoted path submitted
      // immediately — submitDroppedPaths appends `\r`. Sending the bbarit agent a
      // bare path + Enter is why pasted images were ignored: no `@`, auto-submitted.
      const insertAttachmentPath = (filePath: string) => {
        if (!writeToPtyRef.current) return;
        if (isBbaritAgentCli(cliType)) {
          writeToPtyRef.current(bbaritImageToken(filePath));
        } else {
          writeToPtyRef.current(submitDroppedPaths([filePath]));
        }
      };
      const saveAndInsertClipboardImage = async (base64: string, extension = 'png') => {
        const filePath = await invoke<string>('save_clipboard_image', {
          base64Data: base64,
          extension,
        });
        if (filePath) insertAttachmentPath(filePath);
      };

      // Text paste first: robust path for macOS bridge mode and direct mode.
      // Uses bracketed paste mode + chunked writes for long text.
      const textPlain = e.clipboardData?.getData('text/plain') || '';
      const pastedImagePaths = isBbaritAgentCli(cliType) ? parsePastedImagePathList(textPlain) : [];
      if (pastedImagePaths.length > 0 && writeToPtyRef.current) {
        e.preventDefault();
        writeToPtyRef.current(pastedImagePaths.map(bbaritImageToken).join(''));
        return;
      }
      if (textPlain && writeToPtyRef.current) {
        e.preventDefault();
        const normalized = normalizeInputNewlines(textPlain);
        void writePasteChunked(writeToPtyRef.current, normalized);
        return;
      }

      // 일부 앱은 표/리치 콘텐츠를 text/plain 없이 text/html로만 복사한다.
      // HTML을 텍스트(표는 마크다운 파이프)로 복원해 붙여넣는다 — 이 폴백이 없으면
      // 아래 이미지 폴백이 시스템 클립보드의 무관한 이미지를 붙여넣는 오동작을 한다.
      const textHtml = e.clipboardData?.getData('text/html') || '';
      if (textHtml && writeToPtyRef.current) {
        const converted = htmlClipboardToText(textHtml);
        if (converted) {
          e.preventDefault();
          void writePasteChunked(writeToPtyRef.current, normalizeInputNewlines(converted));
          return;
        }
      }

      // File path paste: when files are copied in Finder/Explorer (Cmd+C),
      // clipboardData has no text/plain but the OS clipboard holds file references.
      // Try reading file paths from the system clipboard via Rust.
      if (!textPlain && writeToPtyRef.current) {
        try {
          const filePaths = await invoke<string[]>('read_clipboard_file_paths');
          if (filePaths && filePaths.length > 0) {
            e.preventDefault();
            if (isBbaritAgentCli(cliType) && filePaths.every(isImagePath)) {
              writeToPtyRef.current(filePaths.map(bbaritImageToken).join(''));
            } else {
              writeToPtyRef.current(submitDroppedPaths(filePaths));
            }
            return;
          }
        } catch { /* no file paths in clipboard, continue to image paste */ }
      }

      // Debug logging for Windows troubleshooting
      const isDebug = false; // Set to true for debugging
      const log = (...args: unknown[]) => {
        if (isDebug) console.log('[Octo Image Paste]', ...args);
      };

      const items = e.clipboardData?.items;
      log('Clipboard items:', items?.length, items);
      
      if (items && items.length > 0) {
        for (const item of items) {
          log('Item type:', item.type);
          if (item.type.startsWith('image/')) {
            e.preventDefault();
            const blob = item.getAsFile();
            if (!blob) {
              log('No blob from item');
              return;
            }

            const ext = item.type.split('/')[1] || 'png';
            const reader = new FileReader();
            reader.onload = async () => {
              const base64 = (reader.result as string).split(',')[1];
              if (!base64) {
                log('No base64 from FileReader');
                return;
              }
              try {
                log('Saving image from ClipboardEvent, ext:', ext);
                await saveAndInsertClipboardImage(base64, ext);
              } catch (err) {
                log('Error saving image from ClipboardEvent:', err);
              }
            };
            reader.readAsDataURL(blob);
            return;
          }
        }
      }

      // Windows/WebView fallback: some clipboard image formats (e.g. DIB) are not exposed via ClipboardEvent items.
      // Try Tauri clipboard plugin image read as a secondary path.
      log('Trying Tauri clipboard plugin...');
      try {
        const img = await clipboardReadImage();
        const [size, rgba] = await Promise.all([img.size(), img.rgba()]);
        log('Tauri clipboard image size:', size);
        if (!size?.width || !size?.height || !rgba?.byteLength) {
          log('Invalid image data from Tauri clipboard');
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          log('Failed to get canvas context');
          return;
        }

        const pixels = new Uint8ClampedArray(rgba.byteLength);
        pixels.set(rgba);
        const imageData = new ImageData(pixels, size.width, size.height);
        ctx.putImageData(imageData, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];
        if (!base64) {
          log('No base64 from canvas');
          return;
        }

        try {
          e.preventDefault();
          log('Saving image from Tauri clipboard');
          await saveAndInsertClipboardImage(base64, 'png');
          return;
        } catch (err) {
          log('Error saving image from Tauri clipboard:', err);
        }
      } catch (err) {
        log('Tauri clipboard read failed:', err);
        // Continue to Rust-side fallback
      }

      // Final fallback (especially for Windows): read image directly from system clipboard in Rust.
      log('Trying Rust system clipboard fallback...');
      try {
        const filePath = await invoke<string>('save_clipboard_image_from_system_clipboard');
        if (filePath && writeToPtyRef.current) {
          e.preventDefault();
          log('Image saved from Rust clipboard:', filePath);
          insertAttachmentPath(filePath);
          return;
        }
      } catch (err) {
        log('Rust clipboard fallback failed:', err);
        // No image in system clipboard - this is expected for text paste
      }
    };

    container.addEventListener('paste', handlePaste);
    return () => container.removeEventListener('paste', handlePaste);
  }, [terminalId, cliType]);

  // 전역 키 핸들러 - 활성화 시 자동 포커스
  useEffect(() => {
    if (!isActive) return;
    if (!useImeInput) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const wrap = terminalWrapRef.current;
      // Don't steal focus if terminal is not visible
      if (wrap && wrap.offsetParent === null) return;
      const inThisTerminal = (el: HTMLElement | null) => {
        if (!el) return false;
        return !!(wrap && (
          wrap.contains(el) ||
          el.closest?.('.xterm') ||
          el.closest?.('[data-terminal-scope]') ||
          el.closest?.('[data-terminal-wrap]') ||
          el === inputRef.current ||
          el.classList?.contains?.('xterm-helper-textarea')
        ));
      };
      const target = e.target as HTMLElement | null;
      // Ignore if another input field has focus (e.g., project name editing)
      const activeEl = document.activeElement as HTMLElement | null;
      // Do not re-focus terminal input when shortcut is from outside this terminal.
      if (!inThisTerminal(target) && !inThisTerminal(activeEl)) return;
      const isOtherInput = activeEl && (
        (activeEl.tagName === 'INPUT' && activeEl !== inputRef.current) ||
        activeEl.tagName === 'TEXTAREA' ||
        (activeEl as HTMLElement).isContentEditable
      );
      if (isOtherInput) return;

      // 시스템 단축키는 무시 (Cmd+C, Cmd+V 등) - Enter 제외
      if ((e.metaKey || (e.ctrlKey && !e.altKey)) && e.key !== 'Enter') return;

      // ESC 키는 바로 전송
      if (e.key === 'Escape' && writeToPtyRef.current) {
        e.preventDefault();
        writeToPtyRef.current('\x1b');
        return;
      }

      // Enter 키 처리
      if (e.key === 'Enter') {
        // Let handleKeyDown handle if input field is focused
        if (document.activeElement === inputRef.current) {
          return;
        }

        // 포커스가 없을 때만 직접 처리
        if (writeToPtyRef.current) {
          e.preventDefault();
          e.stopImmediatePropagation();
          writeToPtyRef.current('\x0d');
        }
        return;
      }

      // Auto-focus input field when pressing keys outside
      if (document.activeElement !== inputRef.current) {
        if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Tab') {
          inputRef.current?.focus({ preventScroll: true });
        }
      }
    };

    // 캡처 단계에서 먼저 처리
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [isActive, useImeInput]);

  // Zed 스타일 키보드 이벤트 처리
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const writeToPty = writeToPtyRef.current;
    const submitLine = (value: string) => {
      const v = value ?? '';
      // Skill detection: /skillId, /skillName, or $skillId (Codex)
      if (((v.startsWith('/') && !v.startsWith('//')) || (v.startsWith('$') && !v.startsWith('$$'))) && skills?.length) {
        const skillQuery = v.slice(1).trim();
        const skillLower = skillQuery.toLowerCase();
        const skillNorm = skillLower.replace(/\s+/g, '-');
        const skill = skills.find(s =>
          s.id === skillLower || s.id === skillNorm ||
          s.id === skillQuery ||
          s.name.toLowerCase() === skillLower ||
          s.name.toLowerCase().replace(/\s+/g, '-') === skillNorm ||
          s.description.toLowerCase() === skillLower ||
          s.description.toLowerCase().replace(/\s+/g, '-') === skillNorm
        );
        if (skill && onRunSkill) {
          setInputValue('');
          onRunSkill(skill);
          return;
        }
      }
      maybeMirrorCommandToTelegram(v);
      setInputValue('');
      void (async () => {
        const handled = await tryRunOctoCommand(v);
        if (handled) return;
        if (writeToPtyRef.current) {
          writeToPtyRef.current(v + '\x0d');
        }
      })();
    };

    const key = e.key;
    const ctrl = e.ctrlKey;
    const alt = e.altKey;
    const shift = e.shiftKey;
    const meta = e.metaKey;
    const term = termRef.current;

    // Windows-friendly clipboard shortcuts in IME input-bar mode.
    // Let native copy/paste work in the input, and support terminal selection copy.
    if (ctrl && !alt && !meta) {
      const k = getShortcutKey(e);
      const hasInputSelection =
        (e.currentTarget.selectionStart ?? 0) !== (e.currentTarget.selectionEnd ?? 0);

      if (k === 'c') {
        if (term && term.hasSelection()) {
          // Don't preventDefault — let native copy event fire as backup
          const sel = term.getSelection() || '';
          if (sel) void writeClipboardTextSafe(sel);
          return;
        }
        if (hasInputSelection) return; // native input copy
      }

      if (k === 'v') {
        return; // native input paste
      }

      if (k === 'insert') {
        if (term && term.hasSelection()) {
          // Don't preventDefault — let native copy event fire as backup
          const sel = term.getSelection() || '';
          if (sel) void writeClipboardTextSafe(sel);
          return;
        }
        if (hasInputSelection) return; // native copy
      }
    }
    if (!ctrl && shift && !alt && !meta && key === 'Insert') {
      return; // native input paste
    }

    // Enter 키 처리 (글로벌 핸들러에서 Claude/Codex 체크 완료됨)
    if (key === 'Enter') {
      const nativeIsComposing = (e.nativeEvent as unknown as { isComposing?: boolean }).isComposing === true;
      // IME 조합 중에는 Enter가 "조합 확정"으로 먼저 쓰이므로,
      // 조합 종료 이벤트에서 확정된 문자열을 받아 한 번만 전송한다.
      if (isComposing || nativeIsComposing) {
        pendingSendOnCompositionEndRef.current = true;
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      // Shift+Enter: send CSI u sequence for newline (used by Claude Code, etc.)
      if (shift) {
        const pending = e.currentTarget.value;
        if (pending) {
          maybeMirrorCommandToTelegram(pending);
          writeToPty?.(pending);
          setInputValue('');
        }
        writeToPty?.('\x1b[13;2u');
        return;
      }

      submitLine(e.currentTarget.value);
      return;
    }

    // Escape: cancel intent — never defer to the IME (a Hangul composition can
    // stay open indefinitely and would swallow every press). Close the stale
    // composition and deliver the key.
    if (routeKeyDuringComposition(key, isComposing) === 'esc') {
      e.preventDefault();
      const nativeComposing = (e.nativeEvent as unknown as { isComposing?: boolean }).isComposing === true;
      if (isComposing || nativeComposing) {
        setIsComposing(false);
        pendingSendOnCompositionEndRef.current = false;
        const el = e.currentTarget;
        // Blur commits the half-typed syllable into the input (no data loss)
        // and forces the OS IME out of composition; refocus keeps typing flow.
        el.blur();
        requestAnimationFrame(() => el.focus({ preventScroll: true }));
      }
      writeToPty?.('\x1b');
      return;
    }

    // 나머지 키는 조합 중이면 무시
    if (isComposing) return;

    // Tab
    if (key === 'Tab') {
      e.preventDefault();
      if (shift) {
        writeToPty?.('\x1b[Z');
      } else {
        writeToPty?.(inputValue + '\x09');
        setInputValue('');
      }
      return;
    }

    // Backspace
    if (key === 'Backspace') {
      if (ctrl) {
        e.preventDefault();
        writeToPty?.('\x08');
      } else if (alt) {
        e.preventDefault();
        writeToPty?.('\x1b\x7f');
      }
      return;
    }

    // 화살표 키
    if (key === 'ArrowUp') {
      e.preventDefault();
      writeToPty?.(ctrl || meta ? '\x1b[1;5A' : '\x1b[A');
      return;
    }
    if (key === 'ArrowDown') {
      e.preventDefault();
      writeToPty?.(ctrl || meta ? '\x1b[1;5B' : '\x1b[B');
      return;
    }
    if (key === 'ArrowLeft') {
      if (e.currentTarget.selectionStart === 0 || ctrl || meta || alt) {
        e.preventDefault();
        if (ctrl || meta) {
          writeToPty?.('\x1b[1;5D');
        } else if (alt) {
          writeToPty?.('\x1bb');
        } else {
          writeToPty?.('\x1b[D');
        }
      }
      return;
    }
    if (key === 'ArrowRight') {
      if (e.currentTarget.selectionStart === inputValue.length || ctrl || meta || alt) {
        e.preventDefault();
        if (ctrl || meta) {
          writeToPty?.('\x1b[1;5C');
        } else if (alt) {
          writeToPty?.('\x1bf');
        } else {
          writeToPty?.('\x1b[C');
        }
      }
      return;
    }

    // Home/End
    if (key === 'Home') {
      e.preventDefault();
      writeToPty?.('\x1b[H');
      return;
    }
    if (key === 'End') {
      e.preventDefault();
      writeToPty?.('\x1b[F');
      return;
    }

    // Page Up/Down
    if (key === 'PageUp') {
      e.preventDefault();
      writeToPty?.('\x1b[5~');
      return;
    }
    if (key === 'PageDown') {
      e.preventDefault();
      writeToPty?.('\x1b[6~');
      return;
    }

    // Delete
    if (key === 'Delete') {
      e.preventDefault();
      writeToPty?.('\x1b[3~');
      return;
    }

    // Ctrl+키 조합
    if (ctrl && !alt && !meta) {
      const ctrlKey = getShortcutKey(e);
      const ctrlCodes: Record<string, string> = {
        'a': '\x01', 'b': '\x02', 'c': '\x03', 'd': '\x04',
        'e': '\x05', 'f': '\x06', 'g': '\x07', 'h': '\x08',
        'i': '\x09', 'j': '\x0a', 'k': '\x0b', 'l': '\x0c',
        'm': '\x0d', 'n': '\x0e', 'o': '\x0f', 'p': '\x10',
        'q': '\x11', 'r': '\x12', 's': '\x13', 't': '\x14',
        'u': '\x15', 'v': '\x16', 'w': '\x17', 'x': '\x18',
        'y': '\x19', 'z': '\x1a',
        '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f',
        ' ': '\x00', '?': '\x7f',
      };
      if (ctrlCodes[ctrlKey]) {
        e.preventDefault();
        if (ctrlKey === 'c' || ctrlKey === 'u') {
          setInputValue('');
        }
        writeToPty?.(ctrlCodes[ctrlKey]);
        return;
      }
    }

    // Alt key combos: send ESC + key (e.g. Alt+M → ESC m) (#43)
    if (alt && !ctrl && !meta && key.length === 1) {
      e.preventDefault();
      writeToPty?.('\x1b' + key.toLowerCase());
      return;
    }

    // F1-F12 키
    const fKeys: Record<string, string> = {
      'F1': '\x1bOP', 'F2': '\x1bOQ', 'F3': '\x1bOR', 'F4': '\x1bOS',
      'F5': '\x1b[15~', 'F6': '\x1b[17~', 'F7': '\x1b[18~', 'F8': '\x1b[19~',
      'F9': '\x1b[20~', 'F10': '\x1b[21~', 'F11': '\x1b[23~', 'F12': '\x1b[24~',
    };
    if (fKeys[key]) {
      e.preventDefault();
      writeToPty?.(fKeys[key]);
      return;
    }
  };

  // 우클릭 컨텍스트 메뉴 상태
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const ctxCopy = useCallback(() => {
    const term = termRef.current;
    const sel = (term?.getSelection?.() || '') || lastTerminalSelectionRef.current;
    if (sel) {
      lastTerminalSelectionRef.current = sel;
      void writeClipboardTextSafe(sel);
    }
    setCtxMenu(null);
  }, [writeClipboardTextSafe]);

  const ctxPaste = useCallback(async () => {
    try {
      const text = await readClipboardTextSafe();
      if (text && writeToPtyRef.current) {
        writeToPtyRef.current(normalizeInputNewlines(text));
      }
    } catch { /* ignore */ }
    setCtxMenu(null);
  }, [readClipboardTextSafe]);

  // Copy Context: copy a capped transcript of the scrollback (last 2000 non-blank-trailing
  // lines) so recent agent output can be pasted into other tools.
  const ctxCopyContext = useCallback(() => {
    const term = termRef.current;
    if (term) {
      const buf = term.buffer.active;
      const all: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        all.push(line ? line.translateToString(true) : '');
      }
      let end = all.length;
      while (end > 0 && all[end - 1].trim() === '') end -= 1;
      const text = all.slice(Math.max(0, end - 2000), end).join('\n');
      if (text) void writeClipboardTextSafe(text);
    }
    setCtxMenu(null);
  }, [writeClipboardTextSafe]);

  // Quick command from the context menu: insert the command into this terminal
  // without executing it (the user presses Enter to run).
  const ctxInsertQuickCommand = useCallback((command: string) => {
    if (command && writeToPtyRef.current) {
      writeToPtyRef.current(normalizeInputNewlines(command));
    }
    setCtxMenu(null);
  }, []);

  const ctxQuickCommands = (quickCommands || []).filter((c) => c.command.trim()).slice(0, 6);

  // Search options shared by every find call. Decorations are required for
  // onDidChangeResults (match counter) to fire.
  const searchAccent = style?.accent || '#89b4fa';
  const searchOptions = useCallback((incremental = false) => ({
    caseSensitive: searchCaseSensitive,
    regex: searchRegex,
    wholeWord: searchWholeWord,
    incremental,
    decorations: {
      matchBackground: '#51576d',
      activeMatchBackground: searchAccent,
      matchOverviewRuler: searchAccent,
      activeMatchColorOverviewRuler: '#ffffff',
    },
  }), [searchCaseSensitive, searchRegex, searchWholeWord, searchAccent]);

  const runSearch = useCallback((dir: 'next' | 'prev') => {
    const addon = searchAddonRef.current;
    if (!addon || !searchQuery) return;
    try {
      if (dir === 'prev') addon.findPrevious(searchQuery, searchOptions(false));
      else addon.findNext(searchQuery, searchOptions(false));
    } catch { /* invalid regex while typing */ }
  }, [searchQuery, searchOptions]);

  const closeSearchBar = useCallback(() => {
    searchAddonRef.current?.clearDecorations();
    setSearchBarVisible(false);
    setSearchQuery('');
    setSearchResult(null);
    termRef.current?.focus();
  }, []);

  // Match counter: subscribe while the search bar is open.
  useEffect(() => {
    if (!searchBarVisible) return;
    const addon = searchAddonRef.current;
    if (!addon) return;
    const disp = addon.onDidChangeResults((r: ISearchResultChangeEvent) => setSearchResult(r));
    return () => { disp.dispose(); };
  }, [searchBarVisible]);

  // Re-run the search when an option toggle changes.
  useEffect(() => {
    if (!searchBarVisible || !searchQuery) return;
    try { searchAddonRef.current?.findNext(searchQuery, searchOptions(true)); } catch { /* invalid regex */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchCaseSensitive, searchRegex, searchWholeWord]);

  // xterm 엘리먼트에 직접 contextmenu 이벤트 연결
  useEffect(() => {
    const wrap = terminalWrapRef.current;
    if (!wrap) return;
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const term = termRef.current;
      const sel = (term?.getSelection?.() || '') || lastTerminalSelectionRef.current;
      if (sel) {
        lastTerminalSelectionRef.current = sel;
        void writeClipboardTextSafe(sel);
      }
      setCtxMenu({ x: e.clientX, y: e.clientY });
    };
    wrap.addEventListener('contextmenu', handler, true);
    return () => wrap.removeEventListener('contextmenu', handler, true);
  }, [writeClipboardTextSafe]);

  // 컨텍스트 메뉴 외부 클릭 닫기
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = (e: MouseEvent) => {
      const menu = document.querySelector('.terminal-ctx-menu');
      if (menu && menu.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ctxMenu]);

  return (
    <div
      data-terminal-scope
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: style?.bg || '#1e1e2e',
      }}
    >
      {/* Terminal search bar */}
      {searchBarVisible && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          background: `color-mix(in srgb, ${style?.bg || '#1e1e2e'} 85%, white 15%)`,
          borderBottom: `1px solid ${style?.accent || '#89b4fa'}44`,
          flexShrink: 0,
        }}>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value) {
                try { searchAddonRef.current?.findNext(e.target.value, searchOptions(true)); } catch { /* invalid regex */ }
              } else {
                searchAddonRef.current?.clearDecorations();
                setSearchResult(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runSearch(e.shiftKey ? 'prev' : 'next');
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                closeSearchBar();
              }
            }}
            placeholder={t('terminal.searchPlaceholder')}
            style={{
              flex: 1,
              padding: '3px 8px',
              border: `1px solid ${style?.accent || '#89b4fa'}44`,
              borderRadius: 'var(--brutal-radius)',
              background: style?.bg || '#1e1e2e',
              color: '#ffffff',
              fontSize: 12,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          {searchQuery && searchResult && (
            <span style={{ fontSize: 11, color: style?.text || '#cdd6f4', opacity: 0.8, whiteSpace: 'nowrap' }}>
              {searchResult.resultCount > 0
                ? `${Math.max(0, searchResult.resultIndex) + 1}/${searchResult.resultCount}`
                : '0/0'}
            </span>
          )}
          <button
            onClick={() => setSearchCaseSensitive((v) => !v)}
            style={{
              padding: '2px 6px', borderRadius: 'var(--brutal-radius)',
              border: searchCaseSensitive ? `1px solid ${searchAccent}` : '1px solid transparent',
              background: searchCaseSensitive ? `${searchAccent}55` : `${searchAccent}22`,
              color: style?.text || '#cdd6f4', fontSize: 11, cursor: 'pointer', fontWeight: 700,
            }}
            title="Match case"
          >Aa</button>
          <button
            onClick={() => setSearchWholeWord((v) => !v)}
            style={{
              padding: '2px 6px', borderRadius: 'var(--brutal-radius)',
              border: searchWholeWord ? `1px solid ${searchAccent}` : '1px solid transparent',
              background: searchWholeWord ? `${searchAccent}55` : `${searchAccent}22`,
              color: style?.text || '#cdd6f4', fontSize: 11, cursor: 'pointer', fontWeight: 700,
            }}
            title="Whole word"
          >W</button>
          <button
            onClick={() => setSearchRegex((v) => !v)}
            style={{
              padding: '2px 6px', borderRadius: 'var(--brutal-radius)',
              border: searchRegex ? `1px solid ${searchAccent}` : '1px solid transparent',
              background: searchRegex ? `${searchAccent}55` : `${searchAccent}22`,
              color: style?.text || '#cdd6f4', fontSize: 11, cursor: 'pointer', fontWeight: 700,
            }}
            title="Regular expression"
          >.*</button>
          <button
            onClick={() => runSearch('prev')}
            style={{
              padding: '2px 6px', border: 'none', borderRadius: 'var(--brutal-radius)',
              background: `${style?.accent || '#89b4fa'}33`, color: style?.text || '#cdd6f4',
              fontSize: 11, cursor: 'pointer',
            }}
            title={t('editor.prevMatch')}
          >▲</button>
          <button
            onClick={() => runSearch('next')}
            style={{
              padding: '2px 6px', border: 'none', borderRadius: 'var(--brutal-radius)',
              background: `${style?.accent || '#89b4fa'}33`, color: style?.text || '#cdd6f4',
              fontSize: 11, cursor: 'pointer',
            }}
            title={t('editor.nextMatch')}
          >▼</button>
          <button
            onClick={closeSearchBar}
            style={{
              padding: '2px 6px', border: 'none', borderRadius: 'var(--brutal-radius)',
              background: `${style?.accent || '#89b4fa'}33`, color: style?.text || '#cdd6f4',
              fontSize: 11, cursor: 'pointer',
            }}
            title={t('editor.close')}
          >✕</button>
        </div>
      )}

      {/* 터미널 출력 영역 */}
      <div
        ref={terminalWrapRef}
        data-terminal-wrap
        data-terminal-id={terminalId}
        className={[
          useTauriImeBridge ? 'octo-ime-bridge' : '',
          imePreeditText ? 'octo-ime-preedit' : '',
        ].filter(Boolean).join(' ') || undefined}
        onClick={() => {
          focusActiveInput();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // NOTE: macOS WKWebView never fires this for OS file drops — those are
          // handled natively via getCurrentWindow().onDragDropEvent in App.tsx
          // (routed back here through the 'octo-terminal-os-drop' event). This DOM
          // handler still serves internal drags (file tree) and other platforms.
          // 1. File tree drag (internal): read path from dataTransfer
          const octoData = e.dataTransfer.getData('application/x-octo-filetree');
          if (octoData) {
            try {
              const paths: string[] = JSON.parse(octoData);
              const clean = paths.filter(Boolean);
              if (clean.length) sendToPty(submitDroppedPaths(clean));
            } catch { /* ignore */ }
            return;
          }
          const textPath = e.dataTransfer.getData('text/plain');
          if (textPath && (textPath.startsWith('/') || /^[a-zA-Z]:\\/.test(textPath))) {
            sendToPty(submitDroppedPaths([textPath]));
            return;
          }
          // 2. External file drop: try text/uri-list first (file:// URIs from Finder/Explorer)
          const uriList = e.dataTransfer.getData('text/uri-list');
          if (uriList) {
            const paths = uriList
              .split(/[\r\n]+/)
              .filter(l => l.startsWith('file://'))
              .map(uri => {
                try { return decodeURIComponent(new URL(uri).pathname); } catch { return ''; }
              })
              .filter(Boolean);
            if (paths.length > 0) {
              sendToPty(submitDroppedPaths(paths));
              return;
            }
          }
          // 3. External file drop (OS Finder/Explorer): use a real path when the
          //    webview exposes one. macOS WKWebView hides it (dragDropEnabled is off
          //    for HTML5 DnD), so for dropped images we save the bytes to a temp file
          //    and insert that path — mirroring the clipboard image-paste flow.
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const files = Array.from(e.dataTransfer.files);
            void (async () => {
              const parts: string[] = [];
              const rawPaths: string[] = [];
              for (const f of files) {
                const fp = (f as unknown as { path?: string }).path;
                if (fp) {
                  rawPaths.push(fp);
                  parts.push(shellQuotePath(fp));
                  continue;
                }
                if (!f.type.startsWith('image/')) continue;
                const base64 = await new Promise<string>((resolve) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
                  reader.onerror = () => resolve('');
                  reader.readAsDataURL(f);
                });
                if (!base64) continue;
                const ext = (f.type.split('/')[1] || 'png').toLowerCase();
                try {
                  const tmpPath = await invoke<string>('save_clipboard_image', { base64Data: base64, extension: ext });
                  if (tmpPath) {
                    rawPaths.push(tmpPath);
                    parts.push(shellQuotePath(tmpPath));
                  }
                } catch { /* ignore */ }
              }
              if (parts.length > 0) {
                if (isBbaritAgentCli(cliType) && rawPaths.length === parts.length && rawPaths.every(isImagePath)) {
                  sendToPty(rawPaths.map(bbaritImageToken).join(''));
                } else {
                  sendToPty(`${parts.join(' ')}\r`);
                }
              }
            })();
          }
        }}
        style={{
          flex: 1,
          minHeight: '150px',
          height: '100%',
          overflow: 'hidden',
          position: 'relative',
          overscrollBehavior: 'none',
          touchAction: 'none',
          WebkitUserSelect: 'none',
          userSelect: 'none',
        }}
      >
        <div
          ref={terminalMountRef}
          data-terminal-mount
          style={{
            position: 'absolute',
            inset: 8,
          }}
        />


        {useTauriImeBridge && (
          <textarea
            ref={imeBridgeRef}
            tabIndex={-1}
            onBlur={() => {
              imeBridgeComposingRef.current = false;
              imeBridgeCompositionTextRef.current = '';
            }}
            onMouseDown={(e) => {
              // Keep clicks behaving like terminal clicks; we only need focus.
              e.preventDefault();
              e.stopPropagation();
              try { imeBridgeRef.current?.focus({ preventScroll: true }); } catch { /* ignore */ }
            }}
		            autoCorrect="off"
		            autoCapitalize="off"
		            spellCheck={false}
		            onKeyDown={handleImeBridgeKeyDown}
		            onPaste={handleImeBridgePaste}
		            onBeforeInput={handleImeBridgeBeforeInput}
	            onInput={handleImeBridgeInput}
	            onCompositionStart={handleImeBridgeCompositionStart}
	            onCompositionUpdate={handleImeBridgeCompositionUpdate}
	            onCompositionEnd={handleImeBridgeCompositionEnd}
	            style={
              IS_WIN_IME
                ? {
                    // Windows (WebView2/Chromium): textarea를 커서 위치에 앵커링하되 opacity 0.01로
                    // 거의 투명하게 둔다. 이렇게 하면 Chromium이 조합 글자에 그리는 네이티브 IME
                    // 하이라이트(대비색 네모박스)까지 함께 투명해져 안 보인다. 깨끗한 조합 글자는
                    // 아래 커스텀 오버레이가 커서 자리에 그린다(배경은 터미널색이라 박스로 안 보임).
                    position: 'absolute',
                    ...(cursorOverlay ? { left: cursorOverlay.left, top: cursorOverlay.top } : { left: 12, top: 12 }),
                    width: 1,
                    height: 1,
                    opacity: 0.01,
                    border: 'none',
                    outline: 'none',
                    boxShadow: 'none',
                    padding: 0,
                    margin: 0,
                    background: 'transparent',
                    color: 'transparent',
                    WebkitTextFillColor: 'transparent',
                    WebkitAppearance: 'none',
                    caretColor: 'transparent',
                    zIndex: 55,
                    pointerEvents: 'auto',
                    resize: 'none',
                    overflow: 'hidden',
                  }
                : {
                    // macOS (WKWebView): keep the textarea anchored at the cursor
                    // for IME/candidate positioning, but hide its native preedit
                    // box. A clean text-only overlay is rendered below.
                    position: 'absolute',
                    ...(cursorOverlay
                      ? { left: cursorOverlay.left, top: cursorOverlay.top + MAC_IME_PREEDIT_TOP_OFFSET_PX }
                      : { left: 12, top: 12 + MAC_IME_PREEDIT_TOP_OFFSET_PX }),
                    width: cursorOverlay ? Math.max(cursorOverlay.cellW * 24, 120) : 120,
                    height: cursorOverlay ? cursorOverlay.cellH : fontSize + 4,
                    opacity: 0.01,
                    border: 'none',
                    outline: 'none',
                    boxShadow: 'none',
                    padding: 0,
                    margin: 0,
                    background: 'transparent',
                    color: 'transparent',
                    WebkitTextFillColor: 'transparent',
                    WebkitAppearance: 'none',
                    caretColor: 'transparent',
                    fontFamily: fontFamily || TERMINAL_FONT_FAMILY,
                    fontSize,
                    lineHeight: cursorOverlay ? `${cursorOverlay.cellH}px` : `${fontSize + 4}px`,
                    zIndex: 55,
                    pointerEvents: 'auto',
                    resize: 'none',
                    overflow: 'hidden',
                  }
            }
          />
        )}

        {/* 
          NOTE: macOS renders a text-only overlay. Windows renders an overlay
          with terminal background to cover WebView2's native composition box.
        */}

        {IS_MAC_IME && imePreeditText && cursorOverlay && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: cursorOverlay.left,
              top: cursorOverlay.top + MAC_IME_PREEDIT_TOP_OFFSET_PX,
              width: 'auto',
              minWidth: `${cursorOverlay.cellW}px`,
              height: `${cursorOverlay.cellH}px`,
              background: 'transparent',
              color: style?.text || '#ffffff',
              fontFamily: fontFamily || TERMINAL_FONT_FAMILY,
              fontSize,
              lineHeight: `${cursorOverlay.cellH}px`,
              whiteSpace: 'pre',
              pointerEvents: 'none',
              userSelect: 'none',
              zIndex: 100,
              display: 'inline-block',
            }}
          >
            {imePreeditText}
          </div>
        )}

        {/* Composition overlay - Windows only. 거의 투명한 textarea가 네이티브 조합
            하이라이트(박스)를 가리고, 깨끗한 조합 글자는 이 오버레이가 커서 자리에 그린다.
            macOS는 위의 글자 전용 오버레이를 사용한다. */}
        {IS_WIN_IME && imePreeditText && cursorOverlay && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: cursorOverlay.left,
              top: cursorOverlay.top,
              // Exact character cell size
              width: 'auto',
              minWidth: `${cursorOverlay.cellW}px`,
              height: `${cursorOverlay.cellH}px`,
              // Black background (terminal bg) with white text (terminal fg)
              background: style?.bg || '#000000',
              color: style?.text || '#ffffff',
              // Match terminal text style
              fontFamily: fontFamily || TERMINAL_FONT_FAMILY,
              fontSize,
              lineHeight: `${cursorOverlay.cellH}px`,
              whiteSpace: 'pre',
              pointerEvents: 'none',
              userSelect: 'none',
              zIndex: 100,
              // Ensure it covers the underlying character
              display: 'inline-block',
            }}
          >
            {imePreeditText}
          </div>
        )}

        {cliInstallGuide && (
          <div
            style={{
              position: 'absolute',
              left: 12,
              right: 12,
              bottom: 12,
              zIndex: 190,
              padding: '10px 12px',
              borderRadius: 'var(--brutal-radius)',
              border: `1px solid ${style?.accent || '#89b4fa'}88`,
              background: `color-mix(in srgb, ${style?.bg || '#1e1e2e'} 88%, black 12%)`,
              color: style?.text || '#cdd6f4',
              fontSize: 12,
              boxShadow: '0 4px 16px rgba(0,0,0,0.45)',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{cliInstallGuide.title}</div>
            {cliInstallGuide.lines.map((line, i) => (
              <div key={i} style={{ opacity: 0.85 }}>{line}</div>
            ))}
            {cliInstallGuide.fixCommand && (
              <div
                style={{
                  margin: '6px 0 0',
                  padding: '4px 6px',
                  borderRadius: 4,
                  background: '#00000055',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  userSelect: 'text',
                  WebkitUserSelect: 'text',
                  wordBreak: 'break-all',
                }}
              >
                {cliInstallGuide.fixCommand}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              {cliInstallGuide.fixCommand && (
                <button
                  type="button"
                  onClick={runCliInstallFix}
                  style={{
                    padding: '3px 10px',
                    borderRadius: 'var(--brutal-radius)',
                    border: 'none',
                    background: style?.accent || '#89b4fa',
                    color: style?.bg || '#1e1e2e',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  Run Fix
                </button>
              )}
              <button
                type="button"
                onClick={retryCliLaunch}
                style={{
                  padding: '3px 10px',
                  borderRadius: 'var(--brutal-radius)',
                  border: `1px solid ${style?.accent || '#89b4fa'}66`,
                  background: 'transparent',
                  color: style?.text || '#cdd6f4',
                  cursor: 'pointer',
                  fontSize: 11,
                }}
              >
                Retry
              </button>
              <button
                type="button"
                onClick={dismissCliInstallGuide}
                style={{
                  padding: '3px 10px',
                  borderRadius: 'var(--brutal-radius)',
                  border: `1px solid ${style?.accent || '#89b4fa'}33`,
                  background: 'transparent',
                  color: style?.text || '#cdd6f4',
                  opacity: 0.7,
                  cursor: 'pointer',
                  fontSize: 11,
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {showScrollToBottom && (
          <button
            type="button"
            title={t('terminal.scrollToBottom')}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              scrollActiveTerminalToBottom(true);
              focusActiveInput();
            }}
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 12,
              transform: 'translateX(-50%)',
              zIndex: 180,
              pointerEvents: 'auto',
              height: 30,
              padding: '0 14px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              whiteSpace: 'nowrap',
              borderRadius: 15,
              border: `1px solid ${style?.accent || '#89b4fa'}66`,
              background: `color-mix(in srgb, ${style?.bg || '#1e1e2e'} 82%, black 18%)`,
              color: style?.text || '#cdd6f4',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              lineHeight: 1,
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
            }}
          >
            ↓ {t('terminal.scrollToBottom')}
          </button>
        )}
        <div
          style={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            zIndex: 180,
            pointerEvents: 'auto',
          }}
        >
          <button
            type="button"
            title={t('terminal.clear')}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              clearTerminalView();
            }}
            style={{
              height: 20,
              minWidth: 20,
              padding: 0,
              borderRadius: 'var(--brutal-radius)',
              border: `1px solid ${style?.accent || '#89b4fa'}66`,
              background: `color-mix(in srgb, ${style?.bg || '#1e1e2e'} 88%, black 12%)`,
              color: style?.text || '#cdd6f4',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            <Eraser size={10} />
          </button>
          <button
            type="button"
            title={t('terminal.clearInput')}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              clearTerminalInput();
            }}
            style={{
              height: 20,
              minWidth: 20,
              padding: 0,
              borderRadius: 'var(--brutal-radius)',
              border: `1px solid ${style?.accent || '#89b4fa'}66`,
              background: `color-mix(in srgb, ${style?.bg || '#1e1e2e'} 88%, black 12%)`,
              color: style?.text || '#cdd6f4',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            <RotateCcw size={10} />
          </button>
        </div>
      </div>

      {/* 터미널 우클릭 컨텍스트 메뉴 */}
      {ctxMenu && (
        <ClampedMenu
          className="terminal-ctx-menu"
          x={ctxMenu.x}
          y={ctxMenu.y}
          style={{
            zIndex: 9999,
            background: style?.bg || '#1e1e2e',
            border: `1px solid ${style?.accent || '#89b4fa'}44`,
            borderRadius: 'var(--brutal-radius)',
            padding: '4px 0',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            minWidth: 140,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '6px 14px', border: 'none', background: 'transparent',
              color: style?.text || '#cdd6f4', fontSize: 13, cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = `${style?.accent || '#89b4fa'}22`; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            onClick={ctxCopy}
          >
            {t('common.copy')}
          </button>
          <button
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '6px 14px', border: 'none', background: 'transparent',
              color: style?.text || '#cdd6f4', fontSize: 13, cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = `${style?.accent || '#89b4fa'}22`; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            onClick={ctxCopyContext}
          >
            Copy Context
          </button>
          <button
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '6px 14px', border: 'none', background: 'transparent',
              color: style?.text || '#cdd6f4', fontSize: 13, cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = `${style?.accent || '#89b4fa'}22`; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            onClick={() => void ctxPaste()}
          >
            {t('common.paste')}
          </button>
          {ctxQuickCommands.length > 0 && (
            <>
              <div style={{ height: 1, margin: '4px 0', background: `${style?.accent || '#89b4fa'}33` }} />
              {ctxQuickCommands.map((cmd) => (
                <button
                  key={cmd.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '6px 14px', border: 'none', background: 'transparent',
                    color: style?.text || '#cdd6f4', fontSize: 13, cursor: 'pointer',
                    fontFamily: 'inherit', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = `${style?.accent || '#89b4fa'}22`; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  onClick={() => ctxInsertQuickCommand(cmd.command)}
                  title={cmd.command}
                >
                  {cmd.name || cmd.command}
                </button>
              ))}
            </>
          )}
        </ClampedMenu>
      )}

      {/* Input Field (IME mode) */}
      {useImeInput && (
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '10px 16px',
          // Keep the input bar mostly neutral so themes with a strong accent (e.g. green) don't look "washed".
          background: `linear-gradient(180deg, color-mix(in srgb, ${style?.bg || '#1e1e2e'} 92%, black 8%), color-mix(in srgb, ${style?.bg || '#1e1e2e'} 86%, black 14%))`,
          borderTop: `1px solid ${style?.accent || '#89b4fa'}22`,
        }}
      >
        <span style={{
          color: style?.accent || '#89b4fa',
          marginRight: 10,
          fontSize: 14,
          fontFamily: fontFamily || 'monospace',
        }}>❯</span>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => {
            if (suppressNextOnChangeRef.current) {
              suppressNextOnChangeRef.current = false;
              return;
            }
            setInputValue(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onPaste={() => {
            lastNativePasteAtRef.current = Date.now();
            if (pendingPasteFallbackTimerRef.current != null) {
              window.clearTimeout(pendingPasteFallbackTimerRef.current);
              pendingPasteFallbackTimerRef.current = null;
            }
          }}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={(e) => {
            setIsComposing(false);
            if (!pendingSendOnCompositionEndRef.current) return;
            pendingSendOnCompositionEndRef.current = false;

            // 조합 확정으로 발생하는 onChange(확정 텍스트 반영)를 무시하고,
            // 확정된 값을 바로 전송한 뒤 입력창은 비운다.
            suppressNextOnChangeRef.current = true;
            const value = e.currentTarget.value;
            // Skill detection for compositionEnd: / or $ prefix
            if (((value.startsWith('/') && !value.startsWith('//')) || (value.startsWith('$') && !value.startsWith('$$'))) && skills?.length) {
              const skillQuery = value.slice(1).trim();
              const skillLower = skillQuery.toLowerCase();
              const skillNorm = skillLower.replace(/\s+/g, '-');
              const skill = skills.find(s =>
                s.id === skillLower || s.id === skillNorm ||
                s.id === skillQuery ||
                s.name.toLowerCase() === skillLower ||
                s.name.toLowerCase().replace(/\s+/g, '-') === skillNorm ||
                s.description.toLowerCase() === skillLower ||
                s.description.toLowerCase().replace(/\s+/g, '-') === skillNorm
              );
              if (skill && onRunSkill) {
                setInputValue('');
                onRunSkill(skill);
                return;
              }
            }
            maybeMirrorCommandToTelegram(value);
            setInputValue('');
            void (async () => {
              const handled = await tryRunOctoCommand(value);
              if (handled) return;
              if (writeToPtyRef.current) {
                writeToPtyRef.current(value + '\x0d');
              }
            })();
          }}
          autoFocus
          spellCheck={false}
          placeholder={t('terminal.inputPlaceholder')}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: style?.text || '#cdd6f4',
            fontFamily: fontFamily || TERMINAL_FONT_FAMILY,
            fontSize: 14,
            padding: 0,
            caretColor: style?.accent || '#89b4fa',
          }}
        />
      </div>
      )}

    </div>
  );
});
