import { runCliPrompt, type CliProvider } from './cliRuntime';
// Type-only import keeps this module dependency-free at runtime so learningRuntime
// can import the enriched prompt builder back without a require cycle.
import type {
  LearnedSkillEntry,
  LearningReviewResult,
  SkillProvenance,
} from './learningRuntime';

// 코딩비서 (BBARIT Agent) — background self-improvement review, ported from
// hermes-agent. The foreground turn never waits on this; the review runs detached
// and reports a "💾" summary to whatever channels are wired (console, telegram,
// Cloudflare web channel).

export const BACKGROUND_REVIEW_ORIGIN: SkillProvenance = 'background_review';

export type SkillUpdateTier =
  | 'update_loaded_skill'
  | 'update_existing_umbrella'
  | 'add_support_file'
  | 'create_new_umbrella';

export interface BackgroundReviewSummary {
  text: string;
  actions: string[];
  memoriesAdded: number;
  skillsChanged: number;
  origin: SkillProvenance;
}

export interface BackgroundReviewChannel {
  name: string;
  deliver: (summary: BackgroundReviewSummary) => void | Promise<void>;
}

// hermes looks for five classes of learning signal, with user corrections as the
// highest-priority first-class signal. We keep our existing strict-JSON output
// shape so normalizeReview() downstream stays unchanged.
export function buildBackgroundReviewPrompt(params: {
  threadTitle?: string;
  userMessage: string;
  assistantContent: string;
  transcript: string;
  loadedSkillNames?: string[];
}): string {
  const loaded = (params.loadedSkillNames || []).filter(Boolean);
  return [
    'You are the background self-improvement reviewer for Coding Secretary.',
    'The user turn already finished. Review the trajectory for DURABLE learning and produce STRICT JSON only.',
    'Return shape: {"memories":["..."],"skills":[{"name":"...","description":"...","procedure":"..."}],"summary":"..."}',
    '',
    'Look for these signals, in priority order:',
    '1. USER CORRECTIONS (highest priority) — style/tone/format feedback, "stop doing X", "too verbose", workflow corrections. These are first-class skill signals, not just memories.',
    '2. Non-trivial techniques or fixes that emerged this session (workarounds, debugging paths, tool-usage patterns).',
    '3. Skills consulted this session that turned out wrong or outdated — patch them.',
    '',
    'Where to save, prefer in this order:',
    '- UPDATE a currently-loaded skill if one is relevant.',
    '- UPDATE an existing skill umbrella.',
    '- ADD a support procedure under an existing skill.',
    '- CREATE a new class-level skill only if nothing existing fits.',
    'Group related techniques under one umbrella. Do NOT create one skill per error.',
    '',
    'Do NOT capture:',
    '- Environment-dependent failures (missing binaries, fresh installs, "command not found").',
    '- Negative tool claims ("X is broken") — hardened refusals bite for months.',
    '- One-off session narratives that are not a recurring class of work.',
    '- Transient errors that resolved before the session ended.',
    '',
    'A pass that does nothing is a missed learning opportunity, not a neutral outcome — but never invent false positives.',
    'If nothing durable is worth storing, return {"memories":[],"skills":[],"summary":"Nothing to save."}',
    '',
    loaded.length ? `Currently loaded skills: ${loaded.join(', ')}` : 'No skills are currently loaded.',
    `Thread: ${params.threadTitle || 'untitled'}`,
    `Latest user request: ${params.userMessage.slice(0, 1200)}`,
    `Latest assistant response: ${params.assistantContent.slice(0, 2400)}`,
    '',
    'Recent transcript:',
    params.transcript,
  ].join('\n');
}

// Hierarchical skill placement: keep the agent from exploding into one skill per
// session by reusing a loaded/existing umbrella before creating a new one.
export function selectSkillUpdateTier(params: {
  skillName: string;
  loadedSkillNames?: string[];
  existingSkillNames?: string[];
  isSupportProcedure?: boolean;
}): SkillUpdateTier {
  const target = params.skillName.trim().toLowerCase();
  const loaded = (params.loadedSkillNames || []).map((s) => s.trim().toLowerCase());
  const existing = (params.existingSkillNames || []).map((s) => s.trim().toLowerCase());
  if (loaded.includes(target)) return 'update_loaded_skill';
  if (existing.includes(target)) return 'update_existing_umbrella';
  if (params.isSupportProcedure) return 'add_support_file';
  return 'create_new_umbrella';
}

export function markReviewProvenance(
  review: LearningReviewResult,
  origin: SkillProvenance = BACKGROUND_REVIEW_ORIGIN,
): LearningReviewResult {
  return {
    ...review,
    skills: (review.skills || []).map((skill): LearnedSkillEntry => ({ ...skill, createdBy: origin })),
  };
}

// Compact "💾" line, de-duplicated, mirroring hermes' delivery format.
export function summarizeReviewActions(
  review: LearningReviewResult | undefined,
  origin: SkillProvenance = BACKGROUND_REVIEW_ORIGIN,
): BackgroundReviewSummary {
  const memoriesAdded = review?.memories?.length || 0;
  const skills = review?.skills || [];
  const actions: string[] = [];
  if (memoriesAdded > 0) {
    actions.push(memoriesAdded === 1 ? 'Memory updated' : `${memoriesAdded} memories updated`);
  }
  for (const skill of skills) {
    const name = skill.name?.trim();
    actions.push(name ? `Skill '${name}' learned` : 'Skill learned');
  }
  const deduped = Array.from(new Set(actions));
  return {
    text: deduped.length ? `💾 Self-improvement review: ${deduped.join(' · ')}` : '',
    actions: deduped,
    memoriesAdded,
    skillsChanged: skills.length,
    origin,
  };
}

export function createConsoleReviewChannel(
  log: (text: string) => void = (text) => console.info(text),
): BackgroundReviewChannel {
  return {
    name: 'console',
    deliver: (summary) => {
      if (summary.text) log(summary.text);
    },
  };
}

// The "web channel" delivery target — posts the review summary to a Cloudflare
// Worker (or any HTTPS endpoint). Kept transport-agnostic via an injectable post.
export function createWebReviewChannel(params: {
  url: string;
  token?: string;
  post?: (url: string, body: string, headers: Record<string, string>) => Promise<void>;
  name?: string;
}): BackgroundReviewChannel {
  const post =
    params.post ||
    (async (url, body, headers) => {
      await fetch(url, { method: 'POST', headers, body });
    });
  return {
    name: params.name || 'web-cloudflare',
    deliver: async (summary) => {
      if (!summary.text) return;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (params.token) headers.Authorization = `Bearer ${params.token}`;
      await post(params.url, JSON.stringify({ kind: 'review.summary', ...summary }), headers);
    },
  };
}

async function deliverToChannels(
  summary: BackgroundReviewSummary,
  channels: BackgroundReviewChannel[],
  onError?: (err: unknown) => void,
): Promise<void> {
  for (const channel of channels) {
    try {
      await channel.deliver(summary);
    } catch (err) {
      onError?.(err);
    }
  }
}

// Fire-and-forget: returns immediately so the foreground turn is never blocked.
export function spawnBackgroundReview(params: {
  runReview: () => Promise<LearningReviewResult | undefined>;
  channels?: BackgroundReviewChannel[];
  origin?: SkillProvenance;
  onReview?: (review: LearningReviewResult, summary: BackgroundReviewSummary) => void | Promise<void>;
  onError?: (err: unknown) => void;
}): void {
  const origin = params.origin || BACKGROUND_REVIEW_ORIGIN;
  void (async () => {
    try {
      const review = await params.runReview();
      if (!review) return;
      const marked = markReviewProvenance(review, origin);
      const summary = summarizeReviewActions(marked, origin);
      if (params.onReview) await params.onReview(marked, summary);
      if (summary.actions.length) {
        await deliverToChannels(summary, params.channels || [], params.onError);
      }
    } catch (err) {
      params.onError?.(err);
    }
  })();
}

// Exported for callers that want to drive the enriched prompt through a custom
// runtime. The strict-JSON review wrapper (spawnBackgroundLearningReview) lives in
// learningRuntime to keep this module free of runtime value-imports.
export async function runEnrichedBackgroundReview(params: {
  provider: CliProvider;
  workDir: string;
  threadTitle?: string;
  userMessage: string;
  assistantContent: string;
  transcript: string;
  loadedSkillNames?: string[];
  timeoutSecs: number;
}): Promise<string> {
  const prompt = buildBackgroundReviewPrompt(params);
  return runCliPrompt(params.provider, prompt, params.workDir, params.timeoutSecs);
}
