import type { LearnedSkillEntry, SkillLifecycle } from './learningRuntime';

// 코딩비서 Curator — ported from hermes' skill curator. Autonomously ages
// agent-created skills (active → stale → archived) and surfaces near-duplicate
// consolidation candidates. It only ever touches skills the agent created during
// background review; user-authored and pinned skills are off-limits.

const DAY_MS = 24 * 60 * 60 * 1000;
export const CURATOR_STALE_AFTER_DAYS = 30;
export const CURATOR_ARCHIVE_AFTER_DAYS = 90;
const BACKGROUND_REVIEW: LearnedSkillEntry['createdBy'] = 'background_review';

export interface CuratorTransition {
  id: string;
  name: string;
  from: SkillLifecycle;
  to: SkillLifecycle;
}

export interface ConsolidationCandidate {
  a: string;
  b: string;
  score: number;
}

export interface CuratorRunSummary {
  text: string;
  transitions: CuratorTransition[];
  consolidations: ConsolidationCandidate[];
}

// Only autonomously-created, unpinned skills are the curator's business.
export function isCuratorManaged(skill: LearnedSkillEntry): boolean {
  return skill.createdBy === BACKGROUND_REVIEW && !skill.pinned;
}

export function classifySkillLifecycle(skill: LearnedSkillEntry, now: number): SkillLifecycle {
  const last = skill.lastUsedAt ?? skill.updatedAt ?? skill.createdAt ?? now;
  const idleDays = (now - last) / DAY_MS;
  if (idleDays >= CURATOR_ARCHIVE_AFTER_DAYS) return 'archived';
  if (idleDays >= CURATOR_STALE_AFTER_DAYS) return 'stale';
  return 'active';
}

export function planCuratorTransitions(skills: LearnedSkillEntry[], now: number): CuratorTransition[] {
  const out: CuratorTransition[] = [];
  for (const skill of skills) {
    if (!isCuratorManaged(skill)) continue;
    const from = skill.lifecycle ?? 'active';
    const to = classifySkillLifecycle(skill, now);
    if (from !== to) out.push({ id: skill.id, name: skill.name, from, to });
  }
  return out;
}

export function applyCuratorTransitions(skills: LearnedSkillEntry[], now: number): LearnedSkillEntry[] {
  return skills.map((skill) => {
    if (!isCuratorManaged(skill)) return skill;
    const lifecycle = classifySkillLifecycle(skill, now);
    return lifecycle !== (skill.lifecycle ?? 'active') ? { ...skill, lifecycle } : skill;
  });
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/)
      .filter((token) => token.length >= 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

// Near-duplicate detection via name+description token overlap, so the curator can
// propose merging skills instead of letting them sprawl.
export function findConsolidationCandidates(
  skills: LearnedSkillEntry[],
  threshold = 0.5,
): ConsolidationCandidate[] {
  const managed = skills.filter(isCuratorManaged);
  const tokens = managed.map((skill) => tokenize(`${skill.name} ${skill.description}`));
  const out: ConsolidationCandidate[] = [];
  for (let i = 0; i < managed.length; i += 1) {
    for (let j = i + 1; j < managed.length; j += 1) {
      const score = jaccard(tokens[i], tokens[j]);
      if (score >= threshold) {
        out.push({ a: managed[i].name, b: managed[j].name, score: Math.round(score * 100) / 100 });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

export function pinSkill(skill: LearnedSkillEntry): LearnedSkillEntry {
  return { ...skill, pinned: true };
}

export function unpinSkill(skill: LearnedSkillEntry): LearnedSkillEntry {
  return { ...skill, pinned: false };
}

// Compact "🧹" line for the same channels the review summary uses.
export function summarizeCuratorRun(
  transitions: CuratorTransition[],
  consolidations: ConsolidationCandidate[],
): CuratorRunSummary {
  const archived = transitions.filter((t) => t.to === 'archived').length;
  const staled = transitions.filter((t) => t.to === 'stale').length;
  const parts: string[] = [];
  if (archived) parts.push(archived === 1 ? '1 archived' : `${archived} archived`);
  if (staled) parts.push(staled === 1 ? '1 marked stale' : `${staled} marked stale`);
  if (consolidations.length) {
    parts.push(
      consolidations.length === 1
        ? '1 consolidation candidate'
        : `${consolidations.length} consolidation candidates`,
    );
  }
  return {
    text: parts.length ? `🧹 Curator: ${parts.join(' · ')}` : '',
    transitions,
    consolidations,
  };
}

// One-shot curator pass: ages skills and reports what changed. Returns the updated
// skill list plus a summary the caller can persist / deliver to channels.
export function runCuratorPass(
  skills: LearnedSkillEntry[],
  now: number = Date.now(),
): { skills: LearnedSkillEntry[]; summary: CuratorRunSummary } {
  const transitions = planCuratorTransitions(skills, now);
  const consolidations = findConsolidationCandidates(skills);
  return {
    skills: applyCuratorTransitions(skills, now),
    summary: summarizeCuratorRun(transitions, consolidations),
  };
}
