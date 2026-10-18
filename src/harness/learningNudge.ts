// 코딩비서 review nudge — ported from hermes' counter-based review trigger.
// Instead of reviewing every single turn, the agent reviews every N turns. The
// counter survives process restarts by rehydrating from the conversation length.

export const DEFAULT_REVIEW_NUDGE_INTERVAL = 3;

export interface NudgeState {
  turnsSinceReview: number;
  interval: number;
}

function normalizeInterval(interval: number): number {
  return Number.isFinite(interval) && interval >= 1 ? Math.floor(interval) : 1;
}

export function createNudgeState(interval: number = DEFAULT_REVIEW_NUDGE_INTERVAL): NudgeState {
  return { turnsSinceReview: 0, interval: normalizeInterval(interval) };
}

// True when completing the current turn would hit the interval.
export function shouldReviewNow(state: NudgeState): boolean {
  return state.turnsSinceReview + 1 >= state.interval;
}

// Call once per completed turn: bump the counter, and when it reaches the
// interval signal a review and reset.
export function advanceNudge(state: NudgeState): { state: NudgeState; shouldReview: boolean } {
  const turnsSinceReview = state.turnsSinceReview + 1;
  if (turnsSinceReview >= state.interval) {
    return { state: { ...state, turnsSinceReview: 0 }, shouldReview: true };
  }
  return { state: { ...state, turnsSinceReview }, shouldReview: false };
}

// Fresh agent instances (process restart, cache eviction) start at 0. Rebuild the
// effective counter from how many user turns already happened so a long session
// still triggers on schedule.
export function hydrateNudgeState(
  userTurnCount: number,
  interval: number = DEFAULT_REVIEW_NUDGE_INTERVAL,
): NudgeState {
  const normalized = normalizeInterval(interval);
  const turns = Number.isFinite(userTurnCount) && userTurnCount > 0 ? Math.floor(userTurnCount) : 0;
  return { turnsSinceReview: turns % normalized, interval: normalized };
}
