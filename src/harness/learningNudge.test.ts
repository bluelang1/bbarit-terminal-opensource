import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_NUDGE_INTERVAL,
  advanceNudge,
  createNudgeState,
  hydrateNudgeState,
  shouldReviewNow,
} from './learningNudge';

describe('createNudgeState', () => {
  it('starts at zero with the default interval', () => {
    const state = createNudgeState();
    expect(state.turnsSinceReview).toBe(0);
    expect(state.interval).toBe(DEFAULT_REVIEW_NUDGE_INTERVAL);
  });
  it('clamps invalid intervals to 1', () => {
    expect(createNudgeState(0).interval).toBe(1);
    expect(createNudgeState(-5).interval).toBe(1);
  });
});

describe('advanceNudge', () => {
  it('triggers a review every N turns and resets', () => {
    let state = createNudgeState(3);
    const results = [advanceNudge(state)];
    state = results[0].state;
    results.push(advanceNudge(state));
    state = results[1].state;
    results.push(advanceNudge(state));
    expect(results.map((r) => r.shouldReview)).toEqual([false, false, true]);
    expect(results[2].state.turnsSinceReview).toBe(0);
  });

  it('reviews every turn when interval is 1', () => {
    const { shouldReview, state } = advanceNudge(createNudgeState(1));
    expect(shouldReview).toBe(true);
    expect(state.turnsSinceReview).toBe(0);
  });
});

describe('shouldReviewNow', () => {
  it('predicts the trigger without mutating', () => {
    const state = { turnsSinceReview: 2, interval: 3 };
    expect(shouldReviewNow(state)).toBe(true);
    expect(shouldReviewNow({ turnsSinceReview: 1, interval: 3 })).toBe(false);
  });
});

describe('hydrateNudgeState', () => {
  it('reconstructs the counter from prior user turns', () => {
    expect(hydrateNudgeState(7, 3).turnsSinceReview).toBe(1);
    expect(hydrateNudgeState(6, 3).turnsSinceReview).toBe(0);
    expect(hydrateNudgeState(0, 3).turnsSinceReview).toBe(0);
  });
  it('survives a restart mid-session so the schedule holds', () => {
    // 5 prior turns at interval 3 → next turn (6th) should trigger
    const restored = hydrateNudgeState(5, 3);
    expect(advanceNudge(restored).shouldReview).toBe(true);
  });
});
