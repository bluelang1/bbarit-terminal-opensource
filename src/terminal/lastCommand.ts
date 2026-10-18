// 터미널별 "마지막으로 실행한 명령" 추적 — PTY로 가는 입력 스트림을 Enter 단위로
// 잘라 기록한다. 셸 히스토리(↑ 재실행)나 탭 완성은 입력 문자열 그대로만 보이는
// 근사치다(배지 용도로 충분). 표시 계층은 useSyncExternalStore로 구독한다.

const buffers = new Map<string, string>();
const lastCommands = new Map<string, string>();
let version = 0;
const listeners = new Set<() => void>();

export function feedTerminalInput(terminalId: string, data: string) {
  let buf = buffers.get(terminalId) || '';
  let committed = false;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\r' || ch === '\n') {
      const cmd = buf.trim();
      if (cmd) { lastCommands.set(terminalId, cmd); committed = true; }
      buf = '';
    } else if (ch === '\x7f' || ch === '\b') {
      buf = buf.slice(0, -1);
    } else if (ch === '\x03' || ch === '\x15') {
      // Ctrl+C / Ctrl+U — 입력 중이던 줄 폐기
      buf = '';
    } else if (ch === '\x1b') {
      // ESC 시퀀스(화살표·기능키·bracketed paste 마커)는 명령 텍스트가 아니다.
      const next = data[i + 1];
      if (next === '[') {
        i += 2;
        while (i < data.length && !(data.charCodeAt(i) >= 0x40 && data.charCodeAt(i) <= 0x7e)) i++;
      } else if (next === 'O') {
        i += 2;
      } else {
        i += 1;
      }
    } else if (ch >= ' ' || ch === '\t') {
      buf += ch;
    }
  }
  buffers.set(terminalId, buf);
  if (committed) {
    version++;
    listeners.forEach((fn) => fn());
  }
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
  buffers.delete(terminalId);
  lastCommands.delete(terminalId);
}
