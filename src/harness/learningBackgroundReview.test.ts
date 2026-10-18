import { describe, expect, it } from 'vitest';
import type { LearnedSkillEntry, LearningReviewResult } from './learningRuntime';
import {
  BACKGROUND_REVIEW_ORIGIN,
  buildBackgroundReviewPrompt,
  createWebReviewChannel,
  markReviewProvenance,
  selectSkillUpdateTier,
  spawnBackgroundReview,
  summarizeReviewActions,
  type BackgroundReviewSummary,
} from './learningBackgroundReview';

function makeSkill(name: string): LearnedSkillEntry {
  return {
    id: '',
    name,
    description: 'desc',
    command: 'do the thing',
    cliType: 'claude-cli',
    category: 'self-improving',
    createdAt: 1,
    updatedAt: 1,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('buildBackgroundReviewPrompt', () => {
  it('prioritizes user corrections as a first-class signal', () => {
    const prompt = buildBackgroundReviewPrompt({
      userMessage: 'stop being so verbose',
      assistantContent: 'ok',
      transcript: 'HUMAN: stop being so verbose',
    });
    expect(prompt).toContain('USER CORRECTIONS (highest priority)');
    expect(prompt).toContain('first-class skill signals');
  });

  it('includes guardrails against false positives', () => {
    const prompt = buildBackgroundReviewPrompt({
      userMessage: 'x',
      assistantContent: 'y',
      transcript: 't',
    });
    expect(prompt).toContain('Do NOT capture');
    expect(prompt).toContain('command not found');
    expect(prompt).toContain('Nothing to save.');
  });

  it('lists currently loaded skills when provided', () => {
    const prompt = buildBackgroundReviewPrompt({
      userMessage: 'x',
      assistantContent: 'y',
      transcript: 't',
      loadedSkillNames: ['release-flow', 'ssh-startup'],
    });
    expect(prompt).toContain('Currently loaded skills: release-flow, ssh-startup');
  });
});

describe('selectSkillUpdateTier', () => {
  it('prefers updating a currently-loaded skill', () => {
    expect(
      selectSkillUpdateTier({ skillName: 'Release Flow', loadedSkillNames: ['release flow'] }),
    ).toBe('update_loaded_skill');
  });

  it('falls back to an existing umbrella before creating new', () => {
    expect(
      selectSkillUpdateTier({ skillName: 'ssh', existingSkillNames: ['SSH'] }),
    ).toBe('update_existing_umbrella');
  });

  it('adds a support file when flagged and no umbrella matches', () => {
    expect(
      selectSkillUpdateTier({ skillName: 'new-thing', isSupportProcedure: true }),
    ).toBe('add_support_file');
  });

  it('creates a new umbrella only when nothing fits', () => {
    expect(selectSkillUpdateTier({ skillName: 'totally-new' })).toBe('create_new_umbrella');
  });
});

describe('markReviewProvenance', () => {
  it('stamps every skill as background_review by default', () => {
    const review: LearningReviewResult = { memories: [], skills: [makeSkill('a'), makeSkill('b')] };
    const marked = markReviewProvenance(review);
    expect(marked.skills.every((s) => s.createdBy === BACKGROUND_REVIEW_ORIGIN)).toBe(true);
  });

  it('does not mutate the original review', () => {
    const review: LearningReviewResult = { memories: [], skills: [makeSkill('a')] };
    markReviewProvenance(review);
    expect(review.skills[0].createdBy).toBeUndefined();
  });
});

describe('summarizeReviewActions', () => {
  it('builds a deduplicated 💾 line for memories and skills', () => {
    const summary = summarizeReviewActions({
      memories: [{ content: 'm1' }, { content: 'm2' }],
      skills: [makeSkill('github-flow')],
    });
    expect(summary.text).toContain('💾 Self-improvement review:');
    expect(summary.text).toContain('2 memories updated');
    expect(summary.text).toContain("Skill 'github-flow' learned");
    expect(summary.skillsChanged).toBe(1);
    expect(summary.memoriesAdded).toBe(2);
  });

  it('returns empty text when nothing was learned', () => {
    const summary = summarizeReviewActions({ memories: [], skills: [] });
    expect(summary.text).toBe('');
    expect(summary.actions).toEqual([]);
  });
});

describe('createWebReviewChannel (Cloudflare web channel)', () => {
  it('posts the review summary with auth header and review.summary kind', async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const channel = createWebReviewChannel({
      url: 'https://octo.example.workers.dev/review',
      token: 'secret-token',
      post: async (url, body, headers) => {
        calls.push({ url, body, headers });
      },
    });
    await channel.deliver(summarizeReviewActions({ memories: [{ content: 'm' }], skills: [] }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://octo.example.workers.dev/review');
    expect(calls[0].headers.Authorization).toBe('Bearer secret-token');
    const payload = JSON.parse(calls[0].body);
    expect(payload.kind).toBe('review.summary');
    expect(payload.memoriesAdded).toBe(1);
  });

  it('skips delivery when there is nothing to report', async () => {
    let posted = false;
    const channel = createWebReviewChannel({
      url: 'https://x',
      post: async () => {
        posted = true;
      },
    });
    await channel.deliver(summarizeReviewActions({ memories: [], skills: [] }));
    expect(posted).toBe(false);
  });
});

describe('spawnBackgroundReview', () => {
  it('delivers to channels out-of-band and returns immediately', async () => {
    const delivered: BackgroundReviewSummary[] = [];
    let resolvedSynchronously = true;
    spawnBackgroundReview({
      runReview: async () => {
        await Promise.resolve();
        resolvedSynchronously = false;
        return { memories: [{ content: 'm' }], skills: [makeSkill('a')] };
      },
      channels: [{ name: 'test', deliver: (s) => { delivered.push(s); } }],
    });
    // spawn returns before the async review runs
    expect(resolvedSynchronously).toBe(true);
    await tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].skillsChanged).toBe(1);
  });

  it('does not deliver when the review found nothing', async () => {
    const delivered: BackgroundReviewSummary[] = [];
    spawnBackgroundReview({
      runReview: async () => ({ memories: [], skills: [] }),
      channels: [{ name: 'test', deliver: (s) => { delivered.push(s); } }],
    });
    await tick();
    expect(delivered).toHaveLength(0);
  });

  it('routes channel failures to onError without throwing', async () => {
    const errors: unknown[] = [];
    spawnBackgroundReview({
      runReview: async () => ({ memories: [{ content: 'm' }], skills: [] }),
      channels: [{ name: 'boom', deliver: () => { throw new Error('channel down'); } }],
      onError: (err) => { errors.push(err); },
    });
    await tick();
    expect(errors).toHaveLength(1);
  });
});
