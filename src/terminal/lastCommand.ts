// 터미널별 "마지막으로 실행한 명령" — 하단 상태 막대 왼쪽, 터미널 탭·하단 pill 배지가 읽는다.
//
// 입력원: 사람이 친 입력(inputGate.writeHumanInput)과 사용자가 누른 버튼 입력(source 'button')
// 만 들어온다. 시작 명령 주입·릴레이 알림·스케줄러 같은 자동 입력은 명령이 아니다.
//
// 셸 탭: 커서 위치까지 따라가는 한 줄 버퍼를 Enter(CR/LF)에서 커밋한다. CSI-u Enter
// (Shift/Cmd+Enter, `ESC[13;<mod>u`)는 셸이 실행하지 않으므로 커밋하지 않는다. 히스토리 호출
// (↑/↓)과 Tab 완성은 줄 내용을 알 수 없게 만들어, 그 줄은 아무것도 기록하지 않는다(틀린 명령보다
// 빈 표시가 낫다). bracketed paste 안의 줄바꿈은 줄 안에 남아 "첫 줄 …"로 보인다.
// 에코 확인(호스트가 커서 줄을 줄 때): Enter 를 PTY 에 쓰기 직전에 커서가 있는 논리 줄(줄바꿈으로
// 접힌 행 포함)을 읽어, 친 글이 화면에 찍히지 않았으면(비밀번호 입력처럼 에코가 꺼진 줄) 버리고
// 이전 명령을 유지한다 — isEchoedOnRow 규칙. 커서 줄이 password/passphrase/암호/비밀번호 를
// 담고 있어도 버린다. 대체 버퍼(vim·less·htop 같은 전체 화면 프로그램)가 켜져 있는 동안의
// 키 입력은 명령이 아니므로 기록하지 않고 대기 글을 버린다.
//
// 에이전트 탭(cliType 이 셸이 아니거나 OSC 7501 을 보고한 탭): 어떤 Enter 변형이 제출인지는
// 사용자 키 설정에 달렸으므로 Enter 는 모두 줄바꿈이고, 7501 상태가 working 으로 바뀌는 순간
// 대기 중인 글을 한 줄로 접어 커밋한다. `/`·`!` 로 시작하는 글은 working 전환이 없으니 Enter 에서
// 바로 커밋한다(첫 토큰에 `/` 가 더 없을 때만 슬래시 명령이다 — `/Users/foo` 는 경로). Option+Enter
// (ESC CR)도 다른 Enter 변형처럼 줄바꿈이다. 커밋되지 않은 글은 Ctrl+C·Ctrl+U·Esc·입력 지우기
// 버튼과 승인 대기(blocked)에서 벗어날 때만 버린다. 작업 중에 미리 쳐 둔 글은 입력창에 남아
// 있으므로 idle/done 전환에서 버리지 않는다. 7501 을 아직 보고하지 않은 에이전트 탭은 일반
// Enter 에서 커밋한다(7501 없는 CLI 의 기본 제출 키). 대기 글은 MAX_PENDING 글자에서 멈춘다.
//
// 한국어 IME: XTerminal 의 IME 브리지는 조합 중에는 아무것도 보내지 않고 compositionend 마다
// 확정된 글자(NFC)만 한 번 보낸다. 그래서 여기서는 확정 글자만 보이고, Backspace 는 코드포인트
// 하나(완성형 음절 하나)를 지운다.

import type { AgentTabState } from './programStatus';

export type LastCommandMode = 'shell' | 'agent';

/** XTerminal 이 주는 화면 상태. 없으면 에코 확인·대체 버퍼 무시를 하지 않는다. */
export interface LastCommandHost {
  /** 커서가 있는 논리 줄(접힌 행을 이어 붙인 것). 모르면 null. */
  cursorLineText?: (terminalId: string) => string | null;
  /** 전체 화면 프로그램이 대체 버퍼를 쓰는 중인지. */
  isAlternateBuffer?: (terminalId: string) => boolean;
}

let host: LastCommandHost | null = null;

export function setLastCommandHost(next: LastCommandHost | null) {
  host = next;
}

/** 대기 글 상한(코드포인트). 넘으면 앞부분만 남기고 더 붙이지 않는다. */
const MAX_PENDING = 4000;
/** 에코가 아직 도착하지 않았을 수 있는 마지막 키 수. */
const ECHO_LAG = 3;
const SECRET_PROMPT = /password|passphrase|암호|비밀번호/i;

const squash = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ');

/**
 * 친 글이 커서 줄에 찍혔는지. Enter 직전에는 마지막 몇 키의 에코가 아직 오지 않았을 수 있어,
 * 앞쪽 max(3, 길이-3) 글자(3 글자 이하면 전부)가 커서 줄에 그대로 있으면 에코된 것으로 본다.
 * 공백은 한 칸으로 접어 비교한다.
 */
export function isEchoedOnRow(text: string, row: string): boolean {
  const t = Array.from(squash(text).trim());
  if (t.length === 0) return true;
  const need = t.length <= ECHO_LAG ? t.length : Math.max(ECHO_LAG, t.length - ECHO_LAG);
  return squash(row).includes(t.slice(0, need).join('').trimEnd());
}

/** 셸 줄이 실제로 화면에 찍힌 명령인지(비밀번호 프롬프트가 아니고 에코됐는지). */
const shellLineVisible = (id: string, raw: string): boolean => {
  const row = host?.cursorLineText?.(id);
  if (row == null) return true;
  if (SECRET_PROMPT.test(row)) return false;
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  return isEchoedOnRow(lines[lines.length - 1] || '', row);
};

/** 셸 탭에서 `/` 뒤 첫 토큰에 `/` 가 더 없으면 슬래시 명령, `!` 로 시작하면 셸 명령. */
const isInstantCommand = (text: string) => text.startsWith('!') || /^\/[^\s/]*(?:\s|$)/.test(text);

interface Pending {
  chars: string[];
  cursor: number;
  /** 히스토리 호출·Tab 완성처럼 줄 내용을 알 수 없게 된 상태. */
  unknown: boolean;
  inPaste: boolean;
}

const pendings = new Map<string, Pending>();
const lastCommands = new Map<string, string>();
const modes = new Map<string, LastCommandMode>();
const agentStates = new Map<string, AgentTabState>();
let version = 0;
const listeners = new Set<() => void>();

const pendingOf = (id: string): Pending => {
  let p = pendings.get(id);
  if (!p) {
    p = { chars: [], cursor: 0, unknown: false, inPaste: false };
    pendings.set(id, p);
  }
  return p;
};

const resetPending = (p: Pending) => {
  p.chars = [];
  p.cursor = 0;
  p.unknown = false;
};

const isAgent = (id: string) => modes.get(id) === 'agent' || agentStates.has(id);

const notify = () => {
  version++;
  listeners.forEach((fn) => fn());
};

/** 대기 중인 글을 커밋한다. 바뀌었으면 true. */
const commit = (id: string, p: Pending): boolean => {
  const unknown = p.unknown;
  const raw = p.chars.join('').normalize('NFC');
  resetPending(p);
  if (!unknown && !isAgent(id) && !shellLineVisible(id, raw)) return false;
  let cmd: string;
  if (isAgent(id)) {
    cmd = raw.replace(/\s+/g, ' ').trim();
  } else {
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    cmd = lines.length > 1 ? `${lines[0]} …` : (lines[0] || '');
  }
  if (unknown) {
    if (!lastCommands.has(id)) return false;
    lastCommands.delete(id);
    return true;
  }
  if (!cmd || lastCommands.get(id) === cmd) return false;
  lastCommands.set(id, cmd);
  return true;
};

const insert = (p: Pending, ch: string) => {
  if (p.chars.length >= MAX_PENDING) return;
  p.chars.splice(p.cursor, 0, ch);
  p.cursor++;
};

const deleteBefore = (p: Pending, n = 1) => {
  const from = Math.max(0, p.cursor - n);
  p.chars.splice(from, p.cursor - from);
  p.cursor = from;
};

const wordStartBefore = (p: Pending): number => {
  let i = p.cursor;
  while (i > 0 && /\s/.test(p.chars[i - 1])) i--;
  while (i > 0 && !/\s/.test(p.chars[i - 1])) i--;
  return i;
};

const wordEndAfter = (p: Pending): number => {
  let i = p.cursor;
  while (i < p.chars.length && /\s/.test(p.chars[i])) i++;
  while (i < p.chars.length && !/\s/.test(p.chars[i])) i++;
  return i;
};

/** Enter 변형 하나. CSI-u 이면 `csiU`. 커밋했으면 true. */
const enter = (id: string, p: Pending, csiU: boolean): boolean => {
  if (isAgent(id)) {
    const text = p.chars.join('').trimStart();
    if (isInstantCommand(text)) return commit(id, p);
    // 7501 을 아직 보고하지 않은 에이전트: 일반 Enter 가 제출.
    if (!csiU && !p.inPaste && !agentStates.has(id)) return commit(id, p);
    insert(p, '\n');
    return false;
  }
  if (csiU) return false;
  if (p.inPaste) { insert(p, '\n'); return false; }
  return commit(id, p);
};

/** 사람 입력 또는 사용자가 누른 버튼 입력을 PTY 에 쓰는 순서대로 넣는다. */
export function feedTerminalInput(terminalId: string, data: string) {
  const p = pendingOf(terminalId);
  const agent = isAgent(terminalId);
  if (!agent && host?.isAlternateBuffer?.(terminalId)) {
    // vim·less·htop 같은 전체 화면 프로그램의 키는 셸 명령이 아니다.
    resetPending(p);
    p.inPaste = false;
    return;
  }
  let changed = false;
  const chars = Array.from(data);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\x1b') {
      const next = chars[i + 1];
      if (next === undefined || next === '\x1b') {
        // Esc 단독: 에이전트 TUI 에서는 입력 취소.
        if (agent) resetPending(p);
        continue;
      }
      if (next === '[') {
        // CSI: 매개변수(0x30–0x3f)·중간(0x20–0x2f) 다음 마지막 바이트(0x40–0x7e).
        let j = i + 2;
        let params = '';
        while (j < chars.length && /[\x20-\x3f]/.test(chars[j])) params += chars[j++];
        const final = chars[j] ?? '';
        i = j;
        if (final === 'M' && params === '') { i += 3; continue; } // X10 마우스: ESC [ M b x y
        if (final === '~') {
          if (params === '200') p.inPaste = true;
          else if (params === '201') p.inPaste = false;
          else if (params === '3') p.chars.splice(p.cursor, 1);
          continue;
        }
        if (final === 'u' && /^13(;|$)/.test(params)) { changed = enter(terminalId, p, true) || changed; continue; }
        if (params === '' || /^1;\d+$/.test(params)) {
          const word = params !== '';
          if (final === 'A' || final === 'B') p.unknown = true;
          else if (final === 'D') p.cursor = word ? wordStartBefore(p) : Math.max(0, p.cursor - 1);
          else if (final === 'C') p.cursor = word ? wordEndAfter(p) : Math.min(p.chars.length, p.cursor + 1);
          else if (final === 'H') p.cursor = 0;
          else if (final === 'F') p.cursor = p.chars.length;
        }
        continue;
      }
      if (next === ']' || next === 'P') {
        // OSC(예: 7501 질의 응답)·DCS(예: DECRQSS 응답)는 BEL 또는 ST(ESC \) 까지 건너뛴다.
        let j = i + 2;
        while (j < chars.length && chars[j] !== '\x07' && !(chars[j] === '\x1b' && chars[j + 1] === '\\')) j++;
        i = chars[j] === '\x1b' ? j + 1 : j;
        continue;
      }
      if (next === 'O') {
        const k = chars[i + 2];
        if (k === 'A' || k === 'B') p.unknown = true;
        else if (k === 'D') p.cursor = Math.max(0, p.cursor - 1);
        else if (k === 'C') p.cursor = Math.min(p.chars.length, p.cursor + 1);
        else if (k === 'H') p.cursor = 0;
        else if (k === 'F') p.cursor = p.chars.length;
        i += 2;
        continue;
      }
      // Option+Enter(ESC CR): 다른 Enter 변형과 같다(에이전트는 줄바꿈, 셸은 실행 안 함).
      if (next === '\r') { changed = enter(terminalId, p, true) || changed; i += 1; continue; }
      // Alt+키: ESC + 글자.
      if (next === '\x7f' || next === '\b') deleteBefore(p, p.cursor - wordStartBefore(p));
      else if (next === 'b') p.cursor = wordStartBefore(p);
      else if (next === 'f') p.cursor = wordEndAfter(p);
      else if (next === 'd') p.chars.splice(p.cursor, wordEndAfter(p) - p.cursor);
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      // CRLF 는 Enter 한 번.
      if (ch === '\r' && chars[i + 1] === '\n') i++;
      changed = enter(terminalId, p, false) || changed;
      continue;
    }
    switch (ch) {
      case '\x7f': case '\b': deleteBefore(p); continue;
      case '\x03': resetPending(p); continue; // Ctrl+C
      case '\x15': // Ctrl+U: 셸은 줄 앞까지, 에이전트는 입력 전체를 버린 것으로 본다.
        if (agent) resetPending(p); else deleteBefore(p, p.cursor);
        continue;
      case '\x17': deleteBefore(p, p.cursor - wordStartBefore(p)); continue; // Ctrl+W
      case '\x0b': p.chars.splice(p.cursor); continue; // Ctrl+K
      case '\x01': p.cursor = 0; continue; // Ctrl+A
      case '\x05': p.cursor = p.chars.length; continue; // Ctrl+E
      case '\x02': p.cursor = Math.max(0, p.cursor - 1); continue; // Ctrl+B
      case '\x06': p.cursor = Math.min(p.chars.length, p.cursor + 1); continue; // Ctrl+F
      case '\x04': p.chars.splice(p.cursor, 1); continue; // Ctrl+D
      case '\x10': case '\x0e': if (!agent) p.unknown = true; continue; // Ctrl+P/N: 히스토리
      case '\x12': if (!agent) p.unknown = true; continue; // Ctrl+R: 히스토리 검색
      case '\t': if (!agent) p.unknown = true; continue; // 셸: Tab 완성
      default:
        if (ch >= ' ') insert(p, ch);
    }
  }
  if (changed) notify();
}

/** 이 탭이 셸인지 에이전트 TUI 인지. XTerminal 이 cliType 으로 정한다. */
export function setLastCommandMode(terminalId: string, mode: LastCommandMode) {
  modes.set(terminalId, mode);
}

/**
 * OSC 7501 상태 전환. working 으로 바뀌면 대기 글을 커밋하고, 승인 대기(blocked)에서 벗어나면
 * 커밋되지 않은 글(승인 답)을 버린다. idle/done 에서는 버리지 않는다 — 작업 중에 미리 친 글은
 * 입력창에 남아 다음 제출에 쓰인다. 재생(replay) 중인 보고는 넘기지 않는다.
 */
export function noteAgentStatus(terminalId: string, state: AgentTabState, opts?: { cleared?: boolean }) {
  if (opts?.cleared) {
    // 프로그램이 상태를 지웠다(에이전트 종료 → 셸로 복귀): 탭의 원래 모드로 돌아간다.
    agentStates.delete(terminalId);
    clearPendingCommand(terminalId);
    return;
  }
  const prev = agentStates.get(terminalId);
  agentStates.set(terminalId, state);
  if (prev === state) return;
  const p = pendingOf(terminalId);
  if (prev === 'blocked') { resetPending(p); return; }
  if (state === 'working' && commit(terminalId, p)) notify();
}

/** 입력 지우기 버튼 등 — 대기 중인 글을 버린다. */
export function clearPendingCommand(terminalId: string) {
  const p = pendings.get(terminalId);
  if (p) resetPending(p);
}

export function lastCommandOf(terminalId: string): string {
  return lastCommands.get(terminalId) || '';
}

export function subscribeLastCommands(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function lastCommandsVersion(): number {
  return version;
}

export function dropLastCommand(terminalId: string) {
  pendings.delete(terminalId);
  modes.delete(terminalId);
  agentStates.delete(terminalId);
  if (lastCommands.delete(terminalId)) notify();
}
