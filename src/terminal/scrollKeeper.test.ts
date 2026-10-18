import { describe, expect, it } from 'vitest';
import { Terminal } from 'xterm';
import {
  PIN_RESTORE_GUARD_MS,
  captureHiddenPin,
  preserveTerminalViewport,
  restorePinAfterReveal,
  shouldTrustScrollForPin,
  writeXterm,
  type ScrollKeeperState,
} from './scrollKeeper';
import { applyWheelToScrollPin } from './scrollPin';

const ROWS = 24;

// jsdom에는 matchMedia/캔버스 컨텍스트가 없다 — xterm DOM 렌더러 open()에 필요한 최소 스텁
(window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
  matches: false, media: q, onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
});
(HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = () => ({
  measureText: () => ({ width: 8 }),
  font: '',
  save() {}, restore() {}, fillRect() {}, clearRect() {}, fillText() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  canvas: { width: 8, height: 16 },
});

// 스크롤 API(scrollLines/scrollToLine)는 open() 전에는 no-op — 반드시 open한다
const makeTerm = () => {
  const term = new Terminal({ rows: ROWS, cols: 80, scrollback: 1000, allowProposedApi: true });
  const host = document.createElement('div');
  document.body.appendChild(host);
  term.open(host);
  return term;
};

const distFromBottom = (term: Terminal) => {
  const buf = term.buffer.active;
  return Math.max(0, buf.baseY - buf.viewportY);
};

const lines = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `line-${from + i}`).join('\r\n') + '\r\n';

// 스크롤백을 충분히 쌓아 뷰포트 이동이 가능한 상태로 만든다
const fillScrollback = async (term: Terminal, state: ScrollKeeperState, total = 100) => {
  await writeXterm(term, lines(0, total), state);
};

describe('writeXterm scroll pin', () => {
  it('should_follow_output_when_not_pinned', async () => {
    const term = makeTerm();
    const state: ScrollKeeperState = {};
    await fillScrollback(term, state);
    expect(distFromBottom(term)).toBe(0);
    await writeXterm(term, lines(100, 10), state);
    expect(distFromBottom(term)).toBe(0);
  });

  it('should_recover_a_stale_viewport_for_inline_tui_output_when_not_pinned', async () => {
    const term = makeTerm();
    const state: ScrollKeeperState = { userScrolledUp: false, scrollOffsetFromBottom: 0 };
    await fillScrollback(term, state);

    // Codex is an inline TUI: it often repaints the current row with cursor
    // movement/erase sequences instead of adding a newline. A restored or
    // refitted terminal can have a stale viewport even though its user pin is
    // released, and xterm does not move that viewport for a repaint-only write.
    term.scrollLines(-15);
    expect(distFromBottom(term)).toBe(15);

    await writeXterm(term, '\x1b[?25l\r\x1b[2KWorking…\x1b[?25h', state);

    expect(state.userScrolledUp).toBe(false);
    expect(state.scrollOffsetFromBottom).toBe(0);
    expect(distFromBottom(term)).toBe(0);
    expect(state.lastPinRestoreAt).toBeGreaterThan(0);
    expect(shouldTrustScrollForPin(state, Date.now())).toBe(false);
  });

  it('should_not_yank_a_deliberate_pin_for_inline_tui_repaints', async () => {
    const term = makeTerm();
    const state: ScrollKeeperState = {};
    await fillScrollback(term, state);
    term.scrollLines(-15);
    state.userScrolledUp = true;
    state.scrollOffsetFromBottom = 15;

    for (let i = 0; i < 8; i++) {
      await writeXterm(term, `\x1b[?25l\r\x1b[2KWorking ${i}…\x1b[?25h`, state);
    }

    expect(state.userScrolledUp).toBe(true);
    expect(state.scrollOffsetFromBottom).toBe(15);
    expect(distFromBottom(term)).toBe(15);
  });

  it('should_finish_rapid_repaint_writes_at_bottom_without_a_stuck_pending_guard', async () => {
    const term = makeTerm();
    const state: ScrollKeeperState = { userScrolledUp: false, scrollOffsetFromBottom: 0 };
    await fillScrollback(term, state);
    term.scrollLines(-12);

    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      writeXterm(term, `\x1b[?25l\r\x1b[2Kframe-${i}\x1b[?25h`, state),
    ));

    expect(state._writePending).toBe(0);
    expect(state.userScrolledUp).toBe(false);
    expect(state.scrollOffsetFromBottom).toBe(0);
    expect(distFromBottom(term)).toBe(0);
  });

  it('should_hold_pin_while_output_streams', async () => {
    const term = makeTerm();
    const state: ScrollKeeperState = {};
    await fillScrollback(term, state);

    term.scrollLines(-20);
    state.userScrolledUp = true;
    state.scrollOffsetFromBottom = 20;

    for (let i = 0; i < 10; i++) {
      await writeXterm(term, lines(100 + i * 5, 5), state);
    }
    expect(distFromBottom(term)).toBe(20);
    expect(state.scrollOffsetFromBottom).toBe(20);
    expect(state.userScrolledUp).toBe(true);
  });

  it('should_restore_to_live_pin_updated_by_wheel_down_mid_stream', async () => {
    const term = makeTerm();
    const state: ScrollKeeperState = {};
    await fillScrollback(term, state);

    term.scrollLines(-20);
    state.userScrolledUp = true;
    state.scrollOffsetFromBottom = 20;
    await writeXterm(term, lines(100, 5), state);

    // 휠 다운 한 틱: 핀 20 → 15 (write 사이에 발생)
    const next = applyWheelToScrollPin(
      { userScrolledUp: true, scrollOffsetFromBottom: 20 },
      120,
      distFromBottom(term),
      5,
    );
    state.userScrolledUp = next.userScrolledUp;
    state.scrollOffsetFromBottom = next.scrollOffsetFromBottom;

    await writeXterm(term, lines(105, 5), state);
    expect(distFromBottom(term)).toBe(15);
    expect(state.scrollOffsetFromBottom).toBe(15);
  });

  it('should_walk_pin_to_bottom_and_resume_following_output', async () => {
    const term = makeTerm();
    const state: ScrollKeeperState = {};
    await fillScrollback(term, state);

    term.scrollLines(-9);
    state.userScrolledUp = true;
    state.scrollOffsetFromBottom = 9;
    await writeXterm(term, lines(100, 3), state);

    // 휠 다운 반복: 9 → 4 → 해제(0)
    for (const dist of [9, 4]) {
      const next = applyWheelToScrollPin(
        { userScrolledUp: !!state.userScrolledUp, scrollOffsetFromBottom: state.scrollOffsetFromBottom || 0 },
        120,
        dist,
        5,
      );
      state.userScrolledUp = next.userScrolledUp;
      state.scrollOffsetFromBottom = next.scrollOffsetFromBottom;
      if (!next.userScrolledUp) term.scrollToBottom();
      await writeXterm(term, lines(110, 3), state);
    }

    expect(state.userScrolledUp).toBe(false);
    expect(distFromBottom(term)).toBe(0);
    // 이후 출력도 계속 바닥을 따라간다
    await writeXterm(term, lines(120, 10), state);
    expect(distFromBottom(term)).toBe(0);
  });

  it('should_not_resurrect_old_pin_when_released_while_write_in_flight', async () => {
    const term = makeTerm();
    const state: ScrollKeeperState = {};
    await fillScrollback(term, state);

    term.scrollLines(-20);
    state.userScrolledUp = true;
    state.scrollOffsetFromBottom = 20;

    // write가 날아가는 중에 사용자가 바닥으로 복귀(핀 해제)
    const inflight = writeXterm(term, lines(100, 5), state);
    state.userScrolledUp = false;
    state.scrollOffsetFromBottom = 0;
    term.scrollToBottom();
    await inflight;

    expect(state.userScrolledUp).toBe(false);
    expect(distFromBottom(term)).toBe(0);
  });
});

describe('shouldTrustScrollForPin', () => {
  it('should_distrust_scroll_while_writes_pending', () => {
    const now = 100_000;
    expect(shouldTrustScrollForPin({ _writePending: 1 }, now)).toBe(false);
  });

  it('should_distrust_scroll_right_after_pin_restore', () => {
    const now = 100_000;
    expect(shouldTrustScrollForPin({ lastPinRestoreAt: now - PIN_RESTORE_GUARD_MS + 1 }, now)).toBe(false);
  });

  it('should_trust_scroll_when_idle_past_guard_window', () => {
    const now = 100_000;
    expect(shouldTrustScrollForPin({ _writePending: 0, lastPinRestoreAt: now - PIN_RESTORE_GUARD_MS }, now)).toBe(true);
    expect(shouldTrustScrollForPin({}, now)).toBe(true);
  });
});

describe('preserveTerminalViewport', () => {
  it('should_keep_pinned_distance_across_action', async () => {
    const term = makeTerm();
    const state: ScrollKeeperState = {};
    await fillScrollback(term, state);
    term.scrollLines(-10);
    state.userScrolledUp = true;
    state.scrollOffsetFromBottom = 10;

    preserveTerminalViewport(term, state, () => {
      term.resize(80, ROWS - 4);
    });
    expect(distFromBottom(term)).toBe(10);
    expect(state.userScrolledUp).toBe(true);
  });

  it('should_reset_pin_when_not_scrolled_up', async () => {
    const term = makeTerm();
    const state: ScrollKeeperState = {};
    await fillScrollback(term, state);

    preserveTerminalViewport(term, state, () => {});
    expect(state.userScrolledUp).toBe(false);
    expect(state.scrollOffsetFromBottom).toBe(0);
  });
});

describe('hidden pin snapshot (tab switch away/back)', () => {
  // 코덱스류 인라인 TUI: 숨김(display:none) 동안 가짜 스크롤 이벤트가 핀을
  // 오염시켜 복귀 시 뷰포트가 중간에 고정되던 버그의 회귀 테스트.
  it('should_snap_back_to_bottom_when_pin_was_released_before_hiding', async () => {
    const term = makeTerm();
    const state: ScrollKeeperState = {};
    await fillScrollback(term, state);
    expect(distFromBottom(term)).toBe(0);

    // 숨기기 시점: 바닥 추적 중 → 스냅샷은 "핀 해제"
    const snapshot = captureHiddenPin(state);
    expect(snapshot.scrolledUp).toBe(false);

    // 숨김 구간의 오염: 출력이 더 쌓이고, 가짜 스크롤이 뷰포트를 중간으로
    // 끌어내리며 핀까지 세워버린 상황
    await writeXterm(term, lines(100, 40), state);
    term.scrollToLine(Math.floor(term.buffer.active.baseY / 2));
    state.userScrolledUp = true;
    state.scrollOffsetFromBottom = distFromBottom(term);
    expect(distFromBottom(term)).toBeGreaterThan(0);

    // 복귀: 스냅샷 기준으로 복원 → 맨 아래로
    restorePinAfterReveal(term, state, snapshot, () => {
      term.resize(80, ROWS - 2);
    });
    expect(distFromBottom(term)).toBe(0);
    expect(state.userScrolledUp).toBe(false);
    // 복원 직후 도착하는 에코 스크롤은 신뢰 금지 창 안이어야 한다
    expect(shouldTrustScrollForPin(state, Date.now())).toBe(false);
  });

  it('should_restore_a_deliberate_pin_from_before_hiding', async () => {
    const term = makeTerm();
    const state: ScrollKeeperState = {};
    await fillScrollback(term, state);
    // 사용자가 숨기기 전에 의도적으로 12줄 위를 보고 있었다
    term.scrollLines(-12);
    state.userScrolledUp = true;
    state.scrollOffsetFromBottom = 12;
    const snapshot = captureHiddenPin(state);

    // 숨김 구간 오염: 핀이 엉뚱한 위치로 덮임
    await writeXterm(term, lines(100, 30), state);
    state.scrollOffsetFromBottom = 3;

    restorePinAfterReveal(term, state, snapshot, () => {});
    expect(distFromBottom(term)).toBe(12);
    expect(state.userScrolledUp).toBe(true);
    expect(state.scrollOffsetFromBottom).toBe(12);
  });
});
