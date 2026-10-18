import type { Terminal } from 'xterm';

// 스크롤 핀 유지 로직 — XTerminal에서 추출한 write/뷰포트 보존 기계.
// TUI가 출력을 흘리는 동안 사용자가 스크롤업한 위치(바닥에서의 라인 수)를
// write 완료 시마다 복원한다. 핀 갱신은 휠 핸들러(applyWheelToScrollPin)와
// onScroll(가드 통과 시)이 담당한다.
export interface ScrollKeeperState {
  userScrolledUp?: boolean;
  scrollOffsetFromBottom?: number;
  _writePending?: number;
  lastPinRestoreAt?: number;
}

const XTERM_WRITE_TIMEOUT_MS = 2000;

// 프로그램적 복원(scrollToLine) 직후에는 write 자동스크롤/복원이 만든 비동기
// scroll 이벤트가 도착한다 — 이 창 안의 onScroll을 사용자 스크롤로 믿으면
// 핀이 임의 위치로 끌려간다.
export const PIN_RESTORE_GUARD_MS = 150;

export const shouldTrustScrollForPin = (state: ScrollKeeperState, now: number): boolean =>
  (state._writePending || 0) === 0 && now - (state.lastPinRestoreAt || 0) >= PIN_RESTORE_GUARD_MS;

export const preserveTerminalViewport = (
  term: Terminal,
  state: ScrollKeeperState | undefined,
  action: () => void,
  keepAtLeastOneLine = true,
  preserveWhenAwayFromBottom = false,
) => {
  const before = term.buffer.active;
  const beforeDist = Math.max(0, before.baseY - before.viewportY);
  // userScrolledUp 플래그가 명시적으로 설정된 경우에만 스크롤 위치 보존
  // beforeDist > 0만으로는 보존하지 않음 (write 중 일시적 오감지 방지)
  const wasUserScrolled = state?.userScrolledUp ?? false;
  const wasAwayFromBottom = preserveWhenAwayFromBottom && beforeDist > 0;
  const preserve = wasUserScrolled || wasAwayFromBottom;
  const requestedDist = preserve
    ? Math.max(
        keepAtLeastOneLine ? 1 : 0,
        wasUserScrolled ? (state?.scrollOffsetFromBottom ?? beforeDist) : beforeDist,
      )
    : 0;

  action();

  if (!preserve) {
    if (state) {
      state.userScrolledUp = false;
      state.scrollOffsetFromBottom = 0;
    }
    return;
  }

  const after = term.buffer.active;
  const targetY = Math.max(0, after.baseY - requestedDist);
  try {
    term.scrollToLine(targetY);
  } catch {
    // ignore
  }

  if (state) {
    state.userScrolledUp = wasUserScrolled || wasAwayFromBottom;
    state.scrollOffsetFromBottom = preserve ? requestedDist : 0;
    state.lastPinRestoreAt = Date.now();
  }
};

// 탭 전환(display:none) 동안 뷰포트 붕괴/가짜 스크롤 이벤트가 핀을 오염시킨다 —
// 숨기기 시점의 핀을 스냅샷해 두었다가 복귀 시 그대로 되살린다. 핀 해제 상태
// (바닥 추적)였다면 refit 후 명시적으로 맨 아래로 내린다: 코덱스처럼 스크롤백을
// 쌓는 인라인 TUI가 중간에 걸린 채 고정되는 것을 막는다.
export interface HiddenPinSnapshot {
  scrolledUp: boolean;
  offset: number;
}

export const captureHiddenPin = (state?: ScrollKeeperState): HiddenPinSnapshot => ({
  scrolledUp: !!state?.userScrolledUp,
  offset: state?.scrollOffsetFromBottom || 0,
});

export const restorePinAfterReveal = (
  term: Terminal,
  state: ScrollKeeperState | undefined,
  snapshot: HiddenPinSnapshot,
  refit: () => void,
) => {
  if (state) {
    state.userScrolledUp = snapshot.scrolledUp;
    state.scrollOffsetFromBottom = snapshot.offset;
  }
  preserveTerminalViewport(term, state, refit, true, false);
  if (!snapshot.scrolledUp) {
    try {
      term.scrollToBottom();
    } catch {
      // ignore
    }
    if (state) state.lastPinRestoreAt = Date.now();
  }
};

export const writeXterm = (term: Terminal, data: string, state?: ScrollKeeperState) =>
  new Promise<void>((resolve) => {
    try {
      const beginPendingWrite = () => {
        if (state) state._writePending = (state._writePending || 0) + 1;
        let settled = false;
        let timeoutId: number;
        const settle = (afterWrite?: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          try {
            afterWrite?.();
          } catch {
            // ignore render/scroll errors
          }
          if (state) state._writePending = Math.max(0, (state._writePending || 1) - 1);
          resolve();
        };
        timeoutId = window.setTimeout(() => settle(), XTERM_WRITE_TIMEOUT_MS);
        return settle;
      };

      const buf = term.buffer.active;
      const currentDist = Math.max(0, buf.baseY - buf.viewportY);
      // 명시적 userScrolledUp 플래그가 설정된 경우만 보존 모드 진입
      // currentDist > 0만으로는 진입하지 않음 (write 중 일시적 오감지 방지)
      const shouldPreserve = state?.userScrolledUp ?? false;

      if (!shouldPreserve) {
        // 핀이 해제된 상태는 항상 최신 출력 추적 모드다. xterm의 기본 자동
        // 스크롤은 새 줄에는 동작하지만 Codex 같은 인라인 TUI의 repaint-only
        // write(커서 이동 + 줄 지우기)에는 중간 뷰포트를 그대로 둘 수 있으므로
        // write 완료 뒤 명시적으로 바닥을 맞춘다. write 도중 사용자가 휠을
        // 올렸다면 userScrolledUp이 true가 되므로 그 새 핀은 건드리지 않는다.
        const settle = beginPendingWrite();
        term.write(data, () => {
          settle(() => {
            if (state?.userScrolledUp) return;
            try {
              term.scrollToBottom();
            } catch {
              // ignore
            }
            if (state) {
              state.userScrolledUp = false;
              state.scrollOffsetFromBottom = 0;
              state.lastPinRestoreAt = Date.now();
            }
          });
        });
        return;
      }

      // 대량 출력 시 스크롤 보존 비용이 높으므로, pending writes가 쌓이면 보존을 간소화
      const pendingCount = state?._writePending || 0;
      if (pendingCount > 4) {
        // 너무 많은 write가 대기 중 — 정밀 보존 대신 간단히 write 후 오프셋 유지
        const settle = beginPendingWrite();
        term.write(data, () => {
          settle(() => {
            if (!state) return;
            // 사용자가 스크롤업한 상태는 유지, 위치만 갱신
            if (state.userScrolledUp) {
              const newBuf = term.buffer.active;
              const distFromBottom = Math.max(1, state.scrollOffsetFromBottom || 1);
              const targetY = Math.max(0, newBuf.baseY - distFromBottom);
              try { term.scrollToLine(targetY); } catch { /* ignore */ }
              state.lastPinRestoreAt = Date.now();
            }
          });
        });
        return;
      }

      // 사용자가 스크롤업한 상태: write 중 onScroll이 userScrolledUp을 리셋하지 못하게 보호
      const settle = beginPendingWrite();
      const startDist = Math.max(1, state?.scrollOffsetFromBottom ?? currentDist);

      term.write(data, () => {
        settle(() => {
          // write 진행 중 휠로 핀이 움직였을 수 있다 — settle 시점의 라이브 핀으로 복원.
          // 이미 바닥으로 복귀했다면(핀 해제) 옛 핀을 되살리지 않는다.
          if (state && !state.userScrolledUp) return;
          const distFromBottom = Math.max(1, state?.scrollOffsetFromBottom ?? startDist);
          const newBuf = term.buffer.active;
          const targetY = Math.max(0, newBuf.baseY - distFromBottom);
          term.scrollToLine(targetY);
          // 복원 후 플래그 유지
          if (state) {
            state.userScrolledUp = true;
            state.scrollOffsetFromBottom = distFromBottom;
            state.lastPinRestoreAt = Date.now();
          }
        });
      });
    } catch {
      resolve();
    }
  });
