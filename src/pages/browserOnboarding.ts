// First-run onboarding state for the AI browser.
//
// New users (and users after a big capability drop) should be shown what the AI
// browser can do — not left to discover 13 tools by accident. This module owns the
// pure decision "should we show onboarding now?", version-gated so that when the
// capability set grows we can re-surface it once without nagging.
//
// D1: A single monotonically increasing ONBOARDING_VERSION gates re-display.
//     Reason: bumping it re-introduces new features exactly once; a stored version
//     >= current means "already seen the latest", so we stay quiet. Cost: a global
//     bump shows the panel to everyone once. Escape hatch: dismissing writes the
//     current version, and shouldShowOnboarding is a pure function the caller can
//     ignore entirely.

// Bump when a capability worth re-introducing ships. Keep it an integer.
export const ONBOARDING_VERSION = 3;

export interface OnboardingState {
  seenVersion: number;   // highest ONBOARDING_VERSION the user has dismissed
  dismissedAt: number;   // epoch ms of last dismissal (0 = never)
}

export const DEFAULT_ONBOARDING_STATE: OnboardingState = { seenVersion: 0, dismissedAt: 0 };

// Parse persisted state defensively; any corruption falls back to "never seen".
export function parseOnboardingState(raw: unknown): OnboardingState {
  let parsed: any = raw;
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { return { ...DEFAULT_ONBOARDING_STATE }; } }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_ONBOARDING_STATE };
  const seenVersion = Number(parsed.seenVersion);
  const dismissedAt = Number(parsed.dismissedAt);
  return {
    seenVersion: Number.isFinite(seenVersion) && seenVersion > 0 ? Math.floor(seenVersion) : 0,
    dismissedAt: Number.isFinite(dismissedAt) && dismissedAt > 0 ? Math.floor(dismissedAt) : 0,
  };
}

// Show onboarding when the user has never dismissed the current capability version.
export function shouldShowOnboarding(state: OnboardingState | null, version = ONBOARDING_VERSION): boolean {
  const s = state || DEFAULT_ONBOARDING_STATE;
  return (s.seenVersion || 0) < version;
}

// The state to persist after the user dismisses the panel.
export function markOnboardingSeen(now: number, version = ONBOARDING_VERSION): OnboardingState {
  return { seenVersion: version, dismissedAt: now };
}

export function serializeOnboardingState(state: OnboardingState): string {
  return JSON.stringify(state);
}
