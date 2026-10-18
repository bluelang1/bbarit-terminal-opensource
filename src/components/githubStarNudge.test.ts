import { describe, expect, it } from 'vitest';

import { pickBegLine, readNudgeState, shouldShowNudge } from './GithubStarNudge';

const WEEK = 7 * 24 * 60 * 60 * 1000;

describe('readNudgeState', () => {
  it('parses stored state and fills defaults', () => {
    expect(readNudgeState(null)).toEqual({ launches: 0, lastShown: 0, shows: 0, done: false });
    expect(readNudgeState('{"launches":5,"lastShown":100,"shows":2,"done":true}'))
      .toEqual({ launches: 5, lastShown: 100, shows: 2, done: true });
  });

  it('survives corrupted storage', () => {
    expect(readNudgeState('not json')).toEqual({ launches: 0, lastShown: 0, shows: 0, done: false });
    expect(readNudgeState('{"launches":"x","done":"yes"}')).toEqual({ launches: 0, lastShown: 0, shows: 0, done: false });
  });
});

describe('shouldShowNudge', () => {
  const now = WEEK * 10;

  it('waits for a few launches', () => {
    expect(shouldShowNudge({ launches: 2, lastShown: 0, shows: 0, done: false }, now)).toBe(false);
    expect(shouldShowNudge({ launches: 3, lastShown: 0, shows: 0, done: false }, now)).toBe(true);
  });

  it('shows at most once a week', () => {
    expect(shouldShowNudge({ launches: 9, lastShown: now - WEEK + 1000, shows: 1, done: false }, now)).toBe(false);
    expect(shouldShowNudge({ launches: 9, lastShown: now - WEEK - 1000, shows: 1, done: false }, now)).toBe(true);
  });

  it('keeps begging weekly until starred, then stops forever', () => {
    expect(shouldShowNudge({ launches: 99, lastShown: 0, shows: 50, done: false }, now)).toBe(true);
    expect(shouldShowNudge({ launches: 99, lastShown: 0, shows: 50, done: true }, now)).toBe(false);
  });
});

describe('pickBegLine', () => {
  it('escalates per appearance and clamps at the most desperate line', () => {
    const first = pickBegLine(0);
    const second = pickBegLine(1);
    expect(first).not.toBe(second);
    expect(pickBegLine(999)).toBe(pickBegLine(4));
    expect(pickBegLine(-1)).toBe(first);
  });
});
