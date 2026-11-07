// Getting-started steps. Adding a step = one entry here + guide.step.<id>.* keys
// in src/i18n/en.ts and ko.ts (+ an illustration in illustrations.tsx).

export type GuideStepId = 'project' | 'ai-terminal' | 'status' | 'keep-running' | 'git-keys' | 'pet';

export interface GuideTarget {
  /** `[data-guide="…"]` on the real control — never a shared class. */
  selector: string;
  /** Preferred when present (e.g. the new-project modal's folder field). */
  altSelector?: string;
  captionKey: string;
  /** Where to find the control when it is hidden or absent. */
  missingKey: string;
}

export type GuideAction = 'pet-tour' | 'open-settings-terminal';

export interface GuideStep {
  id: GuideStepId;
  titleKey: string;
  bodyKey: string;
  target?: GuideTarget;
  action?: GuideAction;
  macOnly?: boolean;
}

const keys = (id: GuideStepId) => ({ titleKey: `guide.step.${id}.title`, bodyKey: `guide.step.${id}.body` });
const target = (id: GuideStepId, guide: string, alt?: string): GuideTarget => ({
  selector: `[data-guide="${guide}"]`,
  ...(alt ? { altSelector: `[data-guide="${alt}"]` } : {}),
  captionKey: `guide.step.${id}.caption`,
  missingKey: `guide.step.${id}.missing`,
});

export const GUIDE_STEPS: GuideStep[] = [
  { id: 'project', ...keys('project'), target: target('project', 'project-open', 'new-project-folder') },
  { id: 'ai-terminal', ...keys('ai-terminal'), target: target('ai-terminal', 'ai-terminal') },
  // The status dot lives on whichever tab is active; there is no stable target.
  { id: 'status', ...keys('status') },
  { id: 'keep-running', ...keys('keep-running'), action: 'open-settings-terminal' },
  { id: 'git-keys', ...keys('git-keys'), target: target('git-keys', 'git') },
  { id: 'pet', ...keys('pet'), action: 'pet-tour', macOnly: true },
];

export function visibleSteps(isMac: boolean): GuideStep[] {
  return GUIDE_STEPS.filter(s => isMac || !s.macOnly);
}

export function isGuideStepId(v: unknown): v is GuideStepId {
  return typeof v === 'string' && GUIDE_STEPS.some(s => s.id === v);
}

/** stepId → first time it was done (ms). */
export type GuideProgress = Partial<Record<GuideStepId, number>>;

export function markDone(p: GuideProgress, id: GuideStepId, now: number): GuideProgress {
  if (p[id] != null) return p;
  return { ...p, [id]: now };
}

export function doneCount(p: GuideProgress, steps: GuideStep[]): number {
  return steps.filter(s => p[s.id] != null).length;
}

/** Sanitise a stored progress value (kv JSON may be anything). */
export function normalizeProgress(v: unknown): GuideProgress {
  const out: GuideProgress = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, ts] of Object.entries(v as Record<string, unknown>)) {
    if (isGuideStepId(k) && typeof ts === 'number' && Number.isFinite(ts)) out[k] = ts;
  }
  return out;
}

export const GUIDE_PROGRESS_KEY = 'bbarit-guide-progress';
export const GUIDE_FIRSTRUN_KEY = 'bbarit-guide-firstrun';
export const LAST_SEEN_VERSION_KEY = 'bbarit-last-seen-version';
export const GUIDE_WINDOW_LABEL = 'tool-guide';
