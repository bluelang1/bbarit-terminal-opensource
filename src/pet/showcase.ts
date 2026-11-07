// Character tour for the desktop pet. Pure.
//
// Help > Character Tour (src-tauri/src/pet.rs start_pet_tour) makes the pet page play this
// scripted tour once, then return to normal life; dev builds also play it each time the pet
// becomes visible while localStorage['bbarit.pet.showcase'] === '1'. Each step forces a pose
// (animation + small offsets from the spot the tour started on), and may override the
// calendar, lay an ice patch, fake a Claude summary for the bubble / badge, or fake the
// weather (so the weather steps work without location permission or network).
// The engine (engine.ts) is not stepped during the tour: its timings are random (snacks
// every 2-5 min, ice every 3-6 min), so the tour drives the pose directly instead.
// New cases (weather, new animations, ...): add a step to SHOWCASE_STEPS below, plus a
// field on ShowcaseStep / ShowcaseView if PetPage needs a new override.

import { FALL_G, GETUP_MS, ICE_FADE_MS, ICE_LIFE_MS, SLIDE_MS, SLIDE_PX_PER_S, SLIP_MS, WALK_PX_PER_S } from './engine';
import type { AnimName } from './pack';
import { calendarFor, type PetCalendar } from './calendar';
import { petBubble, type PetBubble, type PetLastDone } from './page';
import { moodFor, type ClaudeMood, type PetSummary, type PetTab } from './summary';
import type { PetWeather } from './weather';
import type { TranslationKey } from '../i18n/en';

/** localStorage key that also plays the tour on every show ('1'); dev builds only. */
export const SHOWCASE_KEY = 'bbarit.pet.showcase';

/** How far the pet is lifted above its spot while held (px). */
export const LIFT_PX = 60;
/** Pacing goes this far left / right of where the segment started (px). */
export const PACE_PX = 30;

/**
 * How the body moves during a segment: stand still, pace back and forth around the start
 * (starting to the right), walk right / left at walking speed, slide forward like a slip,
 * be lifted LIFT_PX, or drop back to the ground (then stands as idle).
 */
export type ShowcaseMotion = 'stand' | 'pace' | 'right' | 'left' | 'slide' | 'lift' | 'drop';

export type ShowcaseSegment = { anim: AnimName; ms: number; motion?: ShowcaseMotion };

export type ShowcaseStep = {
  id: string;
  /** i18n key (pet.tour.step.<id>) of the small label at the top of the pet window. */
  captionKey: TranslationKey;
  segments: ShowcaseSegment[];
  /** Calendar to wear (season accessories / particles, special day); none: the real one. */
  cal?: PetCalendar;
  /** An ice patch lies where the first `slip` segment starts (fades in from the step start). */
  ice?: boolean;
  /** Fake Claude summary (bubble / badge); none: an empty one. */
  summary?: PetSummary;
  /** Fake finished turn at the step start: the "done" bubble. */
  done?: PetLastDone['event'];
  /** Fake weather (as if weather were on and reporting this); none: no weather layer. */
  weather?: PetWeather;
};

export type ShowcaseIce = { dx: number; ms: number; used: boolean };

/** What the pet page applies on top of its normal inputs while the tour runs. */
export type ShowcaseView = {
  index: number;
  id: string;
  captionKey: TranslationKey;
  /** Time into the current step. */
  stepMs: number;
  anim: AnimName;
  dir: 1 | -1;
  /** Body offset from the tour's starting spot: right (dx) and up (dy, >= 0), px. */
  dx: number;
  dy: number;
  cal: PetCalendar | null;
  /** Ice patch center as an offset from the start spot's center; ms as in engine.ts Ice. */
  ice: ShowcaseIce | null;
  summary: PetSummary;
  /** In step time (atMs 0 = step start). */
  lastDone: PetLastDone | null;
  mood: ClaudeMood;
  /** The step's fake weather; null: none (the tour never shows the real weather). */
  weather: PetWeather | null;
};

const EMPTY: PetSummary = { blocked: [], working: [], unseenDone: 0 };

/** Representative dates (2026, local) for the calendar steps. */
const cal = (m: number, d: number) => calendarFor(new Date(2026, m - 1, d, 12));

function tab(n: number, project: string, name: string): PetTab {
  return { terminalId: `showcase-${n}`, projectId: `showcase-${project}`, project, tab: name, since: n };
}

const STEP = 6000;
const walkMs = (px: number) => Math.round((px / WALK_PX_PER_S) * 1000);
/** The slip walks in this far before stepping on the ice, then walks back to the start. */
const SLIP_WALK_PX = 45;
const SLIP_SLIDE_PX = (SLIDE_PX_PER_S * SLIDE_MS) / 1000;

/** Tour step ids; each has a caption `pet.tour.step.<id>` in every src/i18n locale. */
type StepId =
  | 'walk' | 'sit' | 'sleep' | 'held' | 'spring' | 'summer' | 'autumn' | 'winter' | 'ice'
  | 'pepero' | 'valentine' | 'white' | 'halloween' | 'christmas'
  | 'clear' | 'night' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'thunder' | 'snow'
  | 'busy' | 'done' | 'blocked' | 'unseen';

const captionKey = (id: StepId): TranslationKey => `pet.tour.step.${id}` satisfies TranslationKey;
const defineStep = (id: StepId, rest: Omit<ShowcaseStep, 'id' | 'captionKey'>): ShowcaseStep => ({
  id,
  captionKey: captionKey(id),
  ...rest,
});

const pace = (id: StepId, c?: PetCalendar): ShowcaseStep =>
  defineStep(id, { cal: c, segments: [{ anim: 'walk', ms: STEP, motion: 'pace' }] });

const wx = (kind: PetWeather['kind'], heavy = false, night = false): PetWeather => ({ kind, heavy, night });

/** Weather steps pace on a plain autumn day unless they say otherwise. */
const weatherPace = (id: StepId, weather: PetWeather, c: PetCalendar = cal(9, 20)): ShowcaseStep =>
  defineStep(id, { cal: c, weather, segments: [{ anim: 'walk', ms: STEP, motion: 'pace' }] });

const eat = (id: StepId, c: PetCalendar): ShowcaseStep =>
  defineStep(id, {
    cal: c,
    segments: [
      { anim: 'eat', ms: 4500 },
      { anim: 'idle', ms: 1500 },
    ],
  });

/**
 * The tour, in order. Each step is about 6 s (slip / eat steps long enough to finish).
 * Add new steps here (and their pet.tour.step.<id> caption in src/i18n); showcase.test.ts
 * pins the order.
 */
export const SHOWCASE_STEPS: ShowcaseStep[] = [
  pace('walk'),
  defineStep('sit', { segments: [{ anim: 'sit', ms: STEP }] }),
  defineStep('sleep', { segments: [{ anim: 'sleep', ms: STEP }] }),
  defineStep('held', {
    segments: [
      { anim: 'held', ms: 2500, motion: 'lift' },
      { anim: 'fall', ms: 3500, motion: 'drop' },
    ],
  }),
  pace('spring', cal(4, 10)),
  pace('summer', cal(7, 20)),
  pace('autumn', cal(10, 10)),
  pace('winter', cal(1, 10)),
  defineStep('ice', {
    cal: cal(1, 10),
    ice: true,
    segments: [
      { anim: 'walk', ms: walkMs(SLIP_WALK_PX), motion: 'right' },
      { anim: 'slip', ms: SLIP_MS, motion: 'slide' },
      { anim: 'getup', ms: GETUP_MS },
      { anim: 'walk', ms: walkMs(SLIP_WALK_PX + SLIP_SLIDE_PX), motion: 'left' },
      { anim: 'idle', ms: 600 },
    ],
  }),
  eat('pepero', cal(11, 11)),
  eat('valentine', cal(2, 14)),
  eat('white', cal(3, 14)),
  pace('halloween', cal(10, 31)),
  pace('christmas', cal(12, 25)),
  weatherPace('clear', wx('clear'), cal(7, 20)),
  defineStep('night', { cal: cal(9, 20), weather: wx('clear', false, true), segments: [{ anim: 'sit', ms: STEP }] }),
  weatherPace('cloudy', wx('cloudy')),
  weatherPace('fog', wx('fog')),
  weatherPace('drizzle', wx('drizzle')),
  // Walks (ripples, splashes at the feet), then stands while a puddle forms.
  defineStep('rain', {
    cal: cal(9, 20),
    weather: wx('rain', true),
    segments: [
      { anim: 'walk', ms: 3000, motion: 'pace' },
      { anim: 'idle', ms: 3500 },
    ],
  }),
  defineStep('thunder', { cal: cal(9, 20), weather: wx('thunder'), segments: [{ anim: 'idle', ms: STEP }] }),
  // There and back, leaving footprints in the snow.
  defineStep('snow', {
    cal: cal(1, 10),
    weather: wx('snow', true),
    segments: [
      { anim: 'walk', ms: 3000, motion: 'right' },
      { anim: 'walk', ms: 3000, motion: 'left' },
    ],
  }),
  defineStep('busy', {
    summary: { ...EMPTY, working: [tab(1, 'bbarit', 'Claude')] },
    segments: [{ anim: 'busy', ms: STEP }],
  }),
  defineStep('done', {
    done: { terminalId: 'showcase-2', turn: 1, project: 'bbarit', tab: 'Claude' },
    segments: [{ anim: 'happy', ms: STEP }],
  }),
  defineStep('blocked', {
    summary: {
      ...EMPTY,
      blocked: [tab(3, 'bbarit', 'Claude'), tab(4, 'api', 'Claude'), tab(5, 'web', 'Codex')],
    },
    segments: [{ anim: 'wave', ms: STEP }],
  }),
  defineStep('unseen', {
    summary: { ...EMPTY, unseenDone: 3, latestDone: tab(6, 'bbarit', 'Claude') },
    segments: [{ anim: 'sit', ms: STEP }],
  }),
];

export function stepMs(step: ShowcaseStep): number {
  return step.segments.reduce((sum, s) => sum + s.ms, 0);
}

export const SHOWCASE_TOTAL_MS = SHOWCASE_STEPS.reduce((sum, s) => sum + stepMs(s), 0);

/** Pacing offset `t` ms in: right PACE_PX, left to -PACE_PX, back; and the facing. */
function paceAt(t: number): { dx: number; dir: 1 | -1 } {
  const cycle = 4 * PACE_PX;
  const p = (((t / 1000) * WALK_PX_PER_S) % cycle + cycle) % cycle;
  if (p < PACE_PX) return { dx: p, dir: 1 };
  if (p < 3 * PACE_PX) return { dx: 2 * PACE_PX - p, dir: -1 };
  return { dx: p - cycle, dir: 1 };
}

type Pose = { anim: AnimName; dir: 1 | -1; dx: number; dy: number };

/** Pose `t` ms into `seg`, starting from `from` (the end pose of the previous segment). */
function segmentPose(seg: ShowcaseSegment, t: number, from: Pose): Pose {
  const s = t / 1000;
  switch (seg.motion ?? 'stand') {
    case 'pace': {
      const p = paceAt(t);
      return { anim: seg.anim, dir: p.dir, dx: from.dx + p.dx, dy: from.dy };
    }
    case 'right':
      return { anim: seg.anim, dir: 1, dx: from.dx + WALK_PX_PER_S * s, dy: from.dy };
    case 'left':
      return { anim: seg.anim, dir: -1, dx: from.dx - WALK_PX_PER_S * s, dy: from.dy };
    case 'slide':
      return { anim: seg.anim, dir: from.dir, dx: from.dx + from.dir * SLIDE_PX_PER_S * (Math.min(t, SLIDE_MS) / 1000), dy: from.dy };
    case 'lift':
      return { anim: seg.anim, dir: from.dir, dx: from.dx, dy: LIFT_PX };
    case 'drop': {
      const dy = Math.max(0, from.dy - 0.5 * FALL_G * s * s);
      return { anim: dy > 0 ? seg.anim : 'idle', dir: from.dir, dx: from.dx, dy };
    }
    default:
      return { anim: seg.anim, dir: from.dir, dx: from.dx, dy: from.dy };
  }
}

/** Pose `t` ms into `step`, plus where (dx) and when (ms) its first slip starts, if any. */
function stepPose(step: ShowcaseStep, t: number): { pose: Pose; slip: { dx: number; at: number } | null } {
  let pose: Pose = { anim: step.segments[0]?.anim ?? 'idle', dir: 1, dx: 0, dy: 0 };
  let at = 0;
  let slip: { dx: number; at: number } | null = null;
  let current: Pose | null = null;
  for (const seg of step.segments) {
    if (!slip && seg.anim === 'slip') slip = { dx: pose.dx, at };
    if (current === null && t < at + seg.ms) current = segmentPose(seg, t - at, pose);
    pose = segmentPose(seg, seg.ms, pose);
    at += seg.ms;
  }
  return { pose: current ?? pose, slip };
}

/** The ice patch `t` ms into a step whose slip starts at `slip`: fades in, melts after use. */
function iceAt(slip: { dx: number; at: number }, t: number): ShowcaseIce | null {
  if (t < slip.at) return { dx: slip.dx, ms: ICE_LIFE_MS - t, used: false };
  const left = Math.min(ICE_LIFE_MS - slip.at, SLIP_MS + ICE_FADE_MS) - (t - slip.at);
  return left > 0 ? { dx: slip.dx, ms: left, used: true } : null;
}

/** What the tour shows `elapsedMs` after it started; null once the last step has ended. */
export function showcaseAt(elapsedMs: number, steps: ShowcaseStep[] = SHOWCASE_STEPS): ShowcaseView | null {
  let t = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const ms = stepMs(step);
    if (t >= ms) {
      t -= ms;
      continue;
    }
    const { pose, slip } = stepPose(step, t);
    const summary = step.summary ?? EMPTY;
    const lastDone = step.done ? { atMs: 0, event: step.done } : null;
    return {
      index,
      id: step.id,
      captionKey: step.captionKey,
      stepMs: t,
      ...pose,
      cal: step.cal ?? null,
      ice: step.ice && slip ? iceAt(slip, t) : null,
      summary,
      lastDone,
      mood: moodFor(summary, t, lastDone?.atMs ?? null),
      weather: step.weather ?? null,
    };
  }
  return null;
}

/** The fake bubble for `view` (same text rules as the real one, page.ts petBubble). */
export function showcaseBubble(view: ShowcaseView, labels: { needsApproval: string; done: string }): PetBubble | null {
  return petBubble(view.summary, view.stepMs, view.lastDone, labels);
}

/** Dev trigger: dev build and the key set to '1'. */
export function showcaseRequested(isDev: boolean, storage: Pick<Storage, 'getItem'> | undefined): boolean {
  if (!isDev) return false;
  try {
    return storage?.getItem(SHOWCASE_KEY) === '1';
  } catch {
    return false;
  }
}
