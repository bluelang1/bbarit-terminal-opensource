// 자동 입력 게이트 — 사람 말고 다른 경로(ctl, 스케줄러, 메신저, 릴레이, 허브 등)가 사용자
// 터미널 PTY 에 쓰는 글자는 모두 여기를 거친다. 터미널마다 하나의 직렬 큐, 사람이 조용할
// 때까지 대기, bracketed paste, Enter 는 따로, OSC 7501 blocked 면 거부.
// 설계: docs/AGENT_INPUT_GATE.md
import { feedTerminalInput } from './lastCommand';
import type { AgentTabState } from './programStatus';
import { terminalSubmitDelayMs } from './terminalSubmit';
import { stripBracketedPasteEnd, writePasteChunked } from './pasteChunks';

export const QUIET_MS = 3000;
export const MAX_WAIT_MS = 20000;
/** 쓰기 함수가 없을 때 기다리는 시간(기존 Telegram 재시도 시간과 같다). */
export const WRITER_WAIT_MS = 7000;
export const POLL_MS = 100;
export const MIN_SUBMIT_DELAY_MS = 200;

export type AutoInputSource =
  | 'ctl' | 'scheduler' | 'telegram' | 'discord' | 'slack'
  | 'devreview' | 'hub' | 'editor' | 'kanban' | 'button' | 'agent' | 'model-fallback' | 'other';

export type PtyWriter = (data: string) => void;

export interface AutoInputOptions {
  /** 기본 true. 텍스트 뒤에 Enter 를 따로 보낸다. */
  submit?: boolean;
  /** blocked 상태여도 쓴다(사용자가 직접 누른 버튼 등). */
  force?: boolean;
  /**
   * Narrow exception for the model limit fallback (docs/MODEL_LIMIT_FALLBACK.md): a lone Esc with
   * `submit: false` may pass while the tab is blocked, to close Claude Code's rate-limit dialog
   * right after the limit event. Any other text still gets 'blocked'.
   */
  closeLimitDialog?: boolean;
  quietMs?: number;
  maxWaitMs?: number;
  /** 본문과 Enter 사이 간격. 기본 max(200, terminalSubmitDelayMs(text)) — 에이전트 TUI 용. 셸은 200. */
  submitDelayMs?: number;
  source: AutoInputSource;
  /** Submit key bytes, or bytes + presses (default: the resolver's answer for this terminal, else CR). */
  submitKey?: string | SubmitSpec;
  /**
   * 등록된 쓰기 함수가 없을 때 쓸 함수(예: 이 창에 마운트되지 않은 팝아웃 터미널에
   * invoke('write_to_pty') 로 직접 쓰기). 이 경우 blocked/bracketed 정보는 없다.
   */
  fallbackWrite?: PtyWriter;
}

export type AutoInputResult =
  | { ok: true; waitedMs: number }
  | { ok: false; reason: 'blocked' | 'typing' | 'no-writer' | 'disposed' | 'cancelled' | 'not-blocked' };

/** XTerminal 이 등록한다 — 마운트된 터미널의 writer, 7501 상태, bracketed paste 모드. */
export interface InputGateHost {
  getWriter?: (terminalId: string) => PtyWriter | null | undefined;
  getAgentState?: (terminalId: string) => AgentTabState | undefined;
  isBracketedPaste?: (terminalId: string) => boolean;
}

export interface InputGateClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultClock: InputGateClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
};

interface HeldInput { data: string; write: PtyWriter }

interface GateState {
  lastHumanAt: number;
  chain: Promise<unknown>;
  writing: boolean;
  /** 자동 쓰기 중 사람이 Ctrl-C 를 눌렀다 — 남은 Enter 를 보내지 않는다. */
  cancelled: boolean;
  held: HeldInput[];
  /** dropQueuedAutoInput 가 올린다 — 그 전에 들어온 요청은 쓰지 않고 'cancelled' 로 끝난다. */
  epoch: number;
}

let host: InputGateHost | null = null;
let fallbackWriterResolver: ((terminalId: string) => PtyWriter | null | undefined) | null = null;
/** Bytes for one submit press and how many presses (2: the first only closes a menu). */
export interface SubmitSpec { key: string; presses?: number }
type SubmitKeyResolver = (terminalId: string, text: string) => string | SubmitSpec | null | undefined;
let submitKeyResolver: SubmitKeyResolver | null = null;
/** Gap between two submit presses (Claude Code redraws after closing its autocomplete menu). */
export const SUBMIT_REPEAT_GAP_MS = 300;
let clock: InputGateClock = defaultClock;
const gates = new Map<string, GateState>();

function gateFor(terminalId: string): GateState {
  let g = gates.get(terminalId);
  if (!g) {
    g = { lastHumanAt: 0, chain: Promise.resolve(), writing: false, cancelled: false, held: [], epoch: 0 };
    gates.set(terminalId, g);
  }
  return g;
}

export function setInputGateHost(next: InputGateHost | null): void { host = next; }

/** App 이 terminalWritersRef 를 쓰기 함수 공급원으로 등록한다(호스트 다음 순위). */
export function setInputGateFallbackWriter(resolver: ((terminalId: string) => PtyWriter | null | undefined) | null): void {
  fallbackWriterResolver = resolver;
}

/**
 * App registers which bytes submit in a terminal (Claude Code may have Enter rebound to newline:
 * src/terminal/claudeSubmitKey.ts). Asked when the gate presses Enter.
 */
export function setInputGateSubmitKeyResolver(resolver: SubmitKeyResolver | null): void {
  submitKeyResolver = resolver;
}

function toSpec(value: string | SubmitSpec | null | undefined): SubmitSpec {
  if (!value) return { key: '\r', presses: 1 };
  if (typeof value === 'string') return { key: value, presses: 1 };
  return { key: value.key || '\r', presses: Math.max(1, Math.min(2, Math.floor(value.presses ?? 1))) };
}

/** The submit for a terminal and the text just typed (CR once unless the resolver says otherwise). */
export function submitKeyFor(terminalId: string, text = ''): SubmitSpec {
  try {
    return toSpec(submitKeyResolver?.(terminalId, text));
  } catch {
    return toSpec(null);
  }
}

export function setInputGateClock(next: Partial<InputGateClock> | null): void {
  clock = next ? { ...defaultClock, ...next } : defaultClock;
}

/** 테스트용: 모든 상태와 등록을 지운다. */
export function resetInputGate(): void {
  gates.clear();
  host = null;
  fallbackWriterResolver = null;
  submitKeyResolver = null;
  clock = defaultClock;
}

/** 터미널이 닫히면 기록과 보류 키를 버린다. 대기 중인 요청은 writer 가 없어 끝난다. */
export function disposeInputGate(terminalId: string): void {
  const g = gates.get(terminalId);
  if (!g) return;
  g.held = [];
  g.lastHumanAt = 0;
}

/**
 * 이 터미널에 쌓인 자동 입력을 버린다(agent stop). 아직 쓰지 않은 요청(쓰기 함수·조용함을
 * 기다리는 중이거나 줄 서 있는 것)은 쓰지 않고 'cancelled' 로 끝나고, 본문을 쓰는 중인 요청은
 * 남은 Enter 를 보내지 않는다. 이 뒤에 넣은 요청(인터럽트 키)은 그대로 돈다. 보류한 사람 키는
 * 건드리지 않는다.
 */
export function dropQueuedAutoInput(terminalId: string): void {
  const g = gates.get(terminalId);
  if (!g) return;
  g.epoch += 1;
  if (g.writing) g.cancelled = true;
}

// 사람이 "치는 중" 이 아닌 입력 — 마우스·포커스 보고와 터미널 질의 응답(DA, CPR, DECRPM,
// OSC/DCS 응답). xterm onData 로 오지만 사람이 친 글자가 아니다.
const NON_TYPING_INPUT = new RegExp([
  '^(?:\\x1b\\[<\\d+;\\d+;\\d+[Mm])+$',     // SGR 마우스
  '^(?:\\x1b\\[M[\\s\\S]{3})+$',            // X10 마우스
  '^\\x1b\\[[IO]$',                          // 포커스 in/out
  '^\\x1b\\[\\d+;\\d+R$',                    // 커서 위치 보고
  '^\\x1b\\[[?>=]?[\\d;]*c$',                // 장치 속성 응답
  '^\\x1b\\[\\??[\\d;]*\\$y$',               // DECRPM
  '^\\x1b\\][\\s\\S]*(?:\\x07|\\x1b\\\\)$',  // OSC 응답
  '^\\x1bP[\\s\\S]*\\x1b\\\\$',              // DCS 응답
].join('|'));

export function isNonTypingInput(data: string): boolean {
  return NON_TYPING_INPUT.test(data);
}

// 제어 문자와 이스케이프 시퀀스로만 된 텍스트(Ctrl+C, Esc, Enter, 화살표 등)나 한 글자는
// 키 입력으로 그대로 보낸다. bracketed paste 로 감싸면 키가 아니라 글자로 붙여넣어진다.
const KEY_SEQUENCE = /^(?:\x1b(?:\[[0-9;?<=>]*[ -/]*[@-~]|O[@-~]|[\s\S])?|[\x00-\x1f\x7f])+$/;

export function isKeyInput(text: string): boolean {
  return KEY_SEQUENCE.test(text) || Array.from(text).length === 1;
}

// 공백 없는 슬래시/달러 명령 하나(`/review`, `$skill`, `/mcp:list`)는 키 입력으로 보낸다.
// bracketed paste 로 감싸면 Claude/Codex 의 슬래시 자동완성이 키 입력을 보지 못한다.
const COMMAND_TOKEN = /^[/$][\w:.-]+$/;

export function isCommandToken(text: string): boolean {
  return COMMAND_TOKEN.test(text);
}

export function noteHumanInput(terminalId: string, at: number = clock.now()): void {
  gateFor(terminalId).lastHumanAt = at;
}

export function lastHumanInputAt(terminalId: string): number {
  return gates.get(terminalId)?.lastHumanAt || 0;
}

export function isHumanTyping(terminalId: string, quietMs: number = QUIET_MS, now: number = clock.now()): boolean {
  const last = gates.get(terminalId)?.lastHumanAt || 0;
  return last > 0 && now - last < quietMs;
}

/** 자동 쓰기(본문~Enter)가 진행 중인지. 이 동안 사람 키는 보류한다. */
export function isWriting(terminalId: string): boolean {
  return !!gates.get(terminalId)?.writing;
}

export function holdHumanInput(terminalId: string, data: string, write: PtyWriter): void {
  gateFor(terminalId).held.push({ data, write });
}

export function flushHeld(terminalId: string): void {
  const g = gates.get(terminalId);
  if (!g || g.held.length === 0) return;
  const held = g.held;
  g.held = [];
  for (const item of held) {
    try { item.write(item.data); } catch { /* ignore */ }
  }
}

/**
 * 사람 키 입력의 단일 출구(XTerminal sendToPty, IME 입력 막대, 붙여넣기). 입력 시각을
 * 기록하고, 자동 쓰기 중이면 보류했다가 끝난 뒤 순서대로 보낸다. 마우스·포커스·질의 응답은
 * 기록도 보류도 하지 않는다. Ctrl-C 는 바로 보내고, 보류한 키를 버리며, 남은 자동 Enter 를
 * 취소한다(사용자가 멈추려는 것이다).
 */
export function writeHumanInput(terminalId: string, data: string, writeRaw: PtyWriter): void {
  if (!data) return;
  // 사람 입력은 쓰이는 순서대로(보류 후 flush 포함) 마지막 명령 추적에도 넣는다.
  const write = trackedWriter(terminalId, writeRaw);
  if (isNonTypingInput(data)) { write(data); return; }
  noteHumanInput(terminalId);
  const g = gates.get(terminalId);
  if (g?.writing) {
    if (data.includes('\x03')) {
      g.held = [];
      g.cancelled = true;
      write(data);
      return;
    }
    holdHumanInput(terminalId, data, write);
    return;
  }
  write(data);
}

function trackedWriter(terminalId: string, write: PtyWriter): PtyWriter {
  return (data) => {
    // 질의 응답·마우스·포커스 보고는 사람이 친 글이 아니다(마지막 명령에 섞이지 않게).
    if (isNonTypingInput(data)) { write(data); return; }
    feedTerminalInput(terminalId, data);
    write(data);
  };
}

function resolveWriter(terminalId: string, opts: AutoInputOptions): PtyWriter | null {
  const write = host?.getWriter?.(terminalId)
    || fallbackWriterResolver?.(terminalId)
    || opts.fallbackWrite
    || null;
  // 자동 입력 중 사용자가 그 자리에서 누른 버튼(빠른 명령·스킬·저장된 명령 등)만 명령으로 센다.
  // 릴레이 알림·스케줄러·원격 메시지 같은 자동 입력은 마지막 명령이 아니다.
  return write && opts.source === 'button' ? trackedWriter(terminalId, write) : write;
}

function isBlocked(terminalId: string): boolean {
  return host?.getAgentState?.(terminalId) === 'blocked';
}

/** force, or the limit-dialog Esc exception (a lone Esc, no submit). */
function mayWriteWhileBlocked(text: string, opts: AutoInputOptions): boolean {
  if (opts.force) return true;
  return opts.closeLimitDialog === true && opts.submit === false && text === '\x1b';
}

async function runAutoInput(terminalId: string, text: string, opts: AutoInputOptions, epoch: number): Promise<AutoInputResult> {
  const quietMs = opts.quietMs ?? QUIET_MS;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const submit = opts.submit !== false;
  const startedAt = clock.now();
  const dropped = () => gateFor(terminalId).epoch !== epoch;
  if (dropped()) return { ok: false, reason: 'cancelled' };

  // 1. 쓰기 함수 확보
  let write = resolveWriter(terminalId, opts);
  while (!write) {
    if (clock.now() - startedAt >= WRITER_WAIT_MS) return { ok: false, reason: 'no-writer' };
    await clock.sleep(POLL_MS);
    if (dropped()) return { ok: false, reason: 'cancelled' };
    write = resolveWriter(terminalId, opts);
  }

  // 2. blocked 검사
  if (!mayWriteWhileBlocked(text, opts) && isBlocked(terminalId)) return { ok: false, reason: 'blocked' };

  // 3. 사람이 조용할 때까지 대기
  const quietStart = clock.now();
  while (isHumanTyping(terminalId, quietMs)) {
    if (clock.now() - quietStart >= maxWaitMs) return { ok: false, reason: 'typing' };
    await clock.sleep(POLL_MS);
    if (dropped()) return { ok: false, reason: 'cancelled' };
  }
  if (dropped()) return { ok: false, reason: 'cancelled' };
  // 기다리는 동안 에이전트가 승인 대기로 바뀌었을 수 있다.
  if (!mayWriteWhileBlocked(text, opts) && isBlocked(terminalId)) return { ok: false, reason: 'blocked' };
  write = resolveWriter(terminalId, opts);
  if (!write) return { ok: false, reason: 'disposed' };
  // The limit-dialog Esc only makes sense while the dialog is still open: if the person closed
  // it or picked an option meanwhile, the Esc would land in their prompt.
  if (opts.closeLimitDialog && !opts.force && !isBlocked(terminalId)) return { ok: false, reason: 'not-blocked' };

  const waitedMs = clock.now() - startedAt;
  const g = gateFor(terminalId);
  g.writing = true;
  g.cancelled = false;
  try {
    // 4. 본문. submit:false(write-raw)는 바이트 그대로 — 안의 \r 은 예전처럼 제출된다.
    if (text) {
      if (!submit || isKeyInput(text) || isCommandToken(text)) {
        write(text);
      } else {
        const bracketed = !!host?.isBracketedPaste?.(terminalId);
        const body = bracketed ? stripBracketedPasteEnd(text).replace(/\r?\n/g, '\r') : text;
        const w = write;
        await writePasteChunked((data) => w(data), body, bracketed, clock.sleep);
      }
    }
    // 5. Enter 는 따로
    if (submit) {
      await clock.sleep(opts.submitDelayMs ?? Math.max(MIN_SUBMIT_DELAY_MS, terminalSubmitDelayMs(text)));
      // Picked when Enter is pressed (the agent may have changed state meanwhile).
      const spec = opts.submitKey !== undefined ? toSpec(opts.submitKey) : submitKeyFor(terminalId, text);
      for (let i = 0; i < (spec.presses ?? 1); i++) {
        if (i > 0) await clock.sleep(SUBMIT_REPEAT_GAP_MS);
        if (g.cancelled) return { ok: false, reason: 'cancelled' };
        const enter = resolveWriter(terminalId, opts);
        if (!enter) return { ok: false, reason: 'disposed' };
        enter(spec.key);
      }
    }
  } finally {
    // 6. 보류한 사람 키를 순서대로(쓰기 함수가 던져도)
    g.writing = false;
    g.cancelled = false;
    flushHeld(terminalId);
  }
  return { ok: true, waitedMs };
}

/** 터미널마다 직렬로 실행한다. 앞 요청이 끝나야(성공·거부 무관) 다음 요청이 시작된다. */
export function queueAutoInput(terminalId: string, text: string, opts: AutoInputOptions): Promise<AutoInputResult> {
  const g = gateFor(terminalId);
  const epoch = g.epoch;
  const run = (): Promise<AutoInputResult> => runAutoInput(terminalId, text, opts, epoch)
    .catch((): AutoInputResult => ({ ok: false, reason: 'disposed' }));
  const result = g.chain.then(run, run);
  g.chain = result.catch(() => undefined);
  return result;
}

/** 거부 사유를 사용자에게 보여줄 한국어 문장으로. */
export function autoInputRefusalMessage(reason: Extract<AutoInputResult, { ok: false }>['reason']): string {
  switch (reason) {
    case 'blocked': return '에이전트가 입력을 기다리는 중이라 보내지 않았습니다';
    case 'typing': return '사용자가 입력 중이라 보내지 않았습니다';
    case 'no-writer': return '터미널이 준비되지 않아 보내지 않았습니다';
    case 'disposed': return '터미널이 닫혀 보내지 않았습니다';
    case 'cancelled': return '사용자가 Ctrl-C 로 멈춰 Enter 를 보내지 않았습니다';
    case 'not-blocked': return '안내 창이 이미 닫혀 보내지 않았습니다';
    default: return '보내지 않았습니다';
  }
}
