import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ONBOARDING_STATE,
  ONBOARDING_VERSION,
  markOnboardingSeen,
  parseOnboardingState,
  serializeOnboardingState,
  shouldShowOnboarding,
} from './browserOnboarding';

describe('parseOnboardingState', () => {
  // 정상: round-trips a valid state.
  it('parses a valid serialized state', () => {
    const s = markOnboardingSeen(1_700_000_000_000, 2);
    expect(parseOnboardingState(serializeOnboardingState(s))).toEqual({ seenVersion: 2, dismissedAt: 1_700_000_000_000 });
  });

  // None/변조: corruption falls back to never-seen.
  it('falls back to default on malformed input', () => {
    expect(parseOnboardingState('not json')).toEqual(DEFAULT_ONBOARDING_STATE);
    expect(parseOnboardingState(null)).toEqual(DEFAULT_ONBOARDING_STATE);
    expect(parseOnboardingState('{}')).toEqual(DEFAULT_ONBOARDING_STATE);
    expect(parseOnboardingState(JSON.stringify({ seenVersion: -3, dismissedAt: 'x' }))).toEqual(DEFAULT_ONBOARDING_STATE);
  });
});

describe('shouldShowOnboarding', () => {
  // 정상: a brand-new user sees onboarding.
  it('shows for a never-seen user', () => {
    expect(shouldShowOnboarding(null)).toBe(true);
    expect(shouldShowOnboarding(DEFAULT_ONBOARDING_STATE)).toBe(true);
  });

  // 매핑: version gating — seen current stays quiet, older re-surfaces.
  it('gates on version', () => {
    expect(shouldShowOnboarding({ seenVersion: ONBOARDING_VERSION, dismissedAt: 1 })).toBe(false);
    expect(shouldShowOnboarding({ seenVersion: 0, dismissedAt: 0 }, 2)).toBe(true);
    expect(shouldShowOnboarding({ seenVersion: 1, dismissedAt: 1 }, 2)).toBe(true);  // new features → re-show
    expect(shouldShowOnboarding({ seenVersion: 2, dismissedAt: 1 }, 2)).toBe(false); // already saw v2
  });
});

describe('markOnboardingSeen', () => {
  it('records the current version and dismissal time', () => {
    expect(markOnboardingSeen(999, 3)).toEqual({ seenVersion: 3, dismissedAt: 999 });
    // After marking seen, we no longer show for that version.
    expect(shouldShowOnboarding(markOnboardingSeen(999, ONBOARDING_VERSION))).toBe(false);
  });
});
