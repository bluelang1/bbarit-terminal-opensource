import { describe, expect, it } from 'vitest';
import type { LearnedSkillEntry } from './learningRuntime';
import {
  CURATOR_ARCHIVE_AFTER_DAYS,
  CURATOR_STALE_AFTER_DAYS,
  applyCuratorTransitions,
  classifySkillLifecycle,
  findConsolidationCandidates,
  isCuratorManaged,
  pinSkill,
  planCuratorTransitions,
  runCuratorPass,
  summarizeCuratorRun,
} from './learningCurator';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

function makeSkill(over: Partial<LearnedSkillEntry> & { name: string }): LearnedSkillEntry {
  const { name, ...rest } = over;
  return {
    id: name,
    name,
    description: over.description ?? 'desc',
    command: 'do',
    cliType: 'claude-cli',
    category: 'self-improving',
    createdBy: 'background_review',
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
  };
}

describe('isCuratorManaged', () => {
  it('manages only agent-created, unpinned skills', () => {
    expect(isCuratorManaged(makeSkill({ name: 'a' }))).toBe(true);
    expect(isCuratorManaged(makeSkill({ name: 'b', createdBy: 'foreground' }))).toBe(false);
    expect(isCuratorManaged(makeSkill({ name: 'c', pinned: true }))).toBe(false);
    expect(isCuratorManaged(makeSkill({ name: 'd', createdBy: undefined }))).toBe(false);
  });
});

describe('classifySkillLifecycle', () => {
  it('is active when recently used', () => {
    expect(classifySkillLifecycle(makeSkill({ name: 'a', lastUsedAt: NOW - 5 * DAY }), NOW)).toBe('active');
  });
  it('becomes stale past the stale threshold', () => {
    const s = makeSkill({ name: 'a', lastUsedAt: NOW - (CURATOR_STALE_AFTER_DAYS + 1) * DAY });
    expect(classifySkillLifecycle(s, NOW)).toBe('stale');
  });
  it('becomes archived past the archive threshold', () => {
    const s = makeSkill({ name: 'a', lastUsedAt: NOW - (CURATOR_ARCHIVE_AFTER_DAYS + 1) * DAY });
    expect(classifySkillLifecycle(s, NOW)).toBe('archived');
  });
  it('falls back to updatedAt when lastUsedAt missing', () => {
    const s = makeSkill({ name: 'a', updatedAt: NOW - (CURATOR_ARCHIVE_AFTER_DAYS + 5) * DAY, lastUsedAt: undefined });
    expect(classifySkillLifecycle(s, NOW)).toBe('archived');
  });
});

describe('planCuratorTransitions', () => {
  it('plans transitions only for managed skills that changed lifecycle', () => {
    const skills = [
      makeSkill({ name: 'fresh', lastUsedAt: NOW - DAY, lifecycle: 'active' }),
      makeSkill({ name: 'aging', lastUsedAt: NOW - (CURATOR_STALE_AFTER_DAYS + 2) * DAY, lifecycle: 'active' }),
      makeSkill({ name: 'user', createdBy: 'foreground', lastUsedAt: NOW - 999 * DAY, lifecycle: 'active' }),
      makeSkill({ name: 'pinned', pinned: true, lastUsedAt: NOW - 999 * DAY, lifecycle: 'active' }),
    ];
    const transitions = planCuratorTransitions(skills, NOW);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ name: 'aging', from: 'active', to: 'stale' });
  });
});

describe('applyCuratorTransitions', () => {
  it('updates managed lifecycle but never touches user or pinned skills', () => {
    const skills = [
      makeSkill({ name: 'aging', lastUsedAt: NOW - (CURATOR_ARCHIVE_AFTER_DAYS + 1) * DAY, lifecycle: 'active' }),
      makeSkill({ name: 'user', createdBy: 'foreground', lastUsedAt: NOW - 999 * DAY, lifecycle: 'active' }),
      makeSkill({ name: 'pinned', pinned: true, lastUsedAt: NOW - 999 * DAY, lifecycle: 'active' }),
    ];
    const out = applyCuratorTransitions(skills, NOW);
    expect(out[0].lifecycle).toBe('archived');
    expect(out[1].lifecycle).toBe('active');
    expect(out[2].lifecycle).toBe('active');
  });
});

describe('findConsolidationCandidates', () => {
  it('flags near-duplicate managed skills', () => {
    const skills = [
      makeSkill({ name: 'github pr review flow', description: 'review pull requests on github' }),
      makeSkill({ name: 'github pr review steps', description: 'review pull requests on github' }),
      makeSkill({ name: 'deploy rust binary', description: 'cargo build and ship' }),
    ];
    const candidates = findConsolidationCandidates(skills, 0.5);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect([candidates[0].a, candidates[0].b].sort()).toEqual(
      ['github pr review flow', 'github pr review steps'].sort(),
    );
  });

  it('ignores user-authored skills', () => {
    const skills = [
      makeSkill({ name: 'dup one two three', createdBy: 'foreground' }),
      makeSkill({ name: 'dup one two three', createdBy: 'foreground' }),
    ];
    expect(findConsolidationCandidates(skills, 0.5)).toHaveLength(0);
  });
});

describe('pinSkill / unpinSkill', () => {
  it('pinning removes a skill from curator management', () => {
    const skill = makeSkill({ name: 'keep' });
    expect(isCuratorManaged(skill)).toBe(true);
    expect(isCuratorManaged(pinSkill(skill))).toBe(false);
  });
});

describe('summarizeCuratorRun', () => {
  it('builds a 🧹 line', () => {
    const summary = summarizeCuratorRun(
      [{ id: '1', name: 'a', from: 'active', to: 'archived' }],
      [{ a: 'x', b: 'y', score: 0.7 }],
    );
    expect(summary.text).toContain('🧹 Curator:');
    expect(summary.text).toContain('1 archived');
    expect(summary.text).toContain('1 consolidation candidate');
  });
  it('is empty when nothing changed', () => {
    expect(summarizeCuratorRun([], []).text).toBe('');
  });
});

describe('runCuratorPass', () => {
  it('ages skills and reports a summary in one pass', () => {
    const skills = [
      makeSkill({ name: 'old', lastUsedAt: NOW - (CURATOR_ARCHIVE_AFTER_DAYS + 1) * DAY, lifecycle: 'active' }),
    ];
    const { skills: updated, summary } = runCuratorPass(skills, NOW);
    expect(updated[0].lifecycle).toBe('archived');
    expect(summary.text).toContain('1 archived');
  });
});
