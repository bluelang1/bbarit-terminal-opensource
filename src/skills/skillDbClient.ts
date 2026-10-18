import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Skill } from './types';

type SkillBootstrapResult = {
  seededGallery: boolean;
  myCount: number;
  galleryCount: number;
  gallerySeed: string;
};

const RETRYABLE_DB_ERRORS = [
  'surrealdb not initialized',
  'db not initialized',
  'resource temporarily unavailable',
  'db locked',
  'lock',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDbError(err: unknown): boolean {
  const message = String(err || '').toLowerCase();
  return RETRYABLE_DB_ERRORS.some((pattern) => message.includes(pattern));
}

async function withDbRetry<T>(fn: () => Promise<T>, retries = 12, delayMs = 180): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isRetryableDbError(err)) break;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

function normalizeSkillArray(input: unknown): Skill[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item && typeof item === 'object')
    .map((item) => item as Skill)
    .filter((skill) => typeof skill.id === 'string' && !!skill.id.trim())
    .map((skill) => ({
      ...skill,
      tags: Array.isArray(skill.tags) ? skill.tags : [],
      builtIn: !!skill.builtIn,
      model: skill.model || undefined,
      allowedTools: Array.isArray(skill.allowedTools) ? skill.allowedTools : [],
      whenToUse: skill.whenToUse || undefined,
      disableModelInvocation: !!skill.disableModelInvocation,
      paths: Array.isArray(skill.paths) ? skill.paths : [],
      priority: typeof skill.priority === 'number' ? skill.priority : undefined,
      sourcePack: skill.sourcePack || undefined,
      sourceUrl: skill.sourceUrl || undefined,
      originalName: skill.originalName || undefined,
      originalCommand: skill.originalCommand || undefined,
      originalDescription: skill.originalDescription || undefined,
      safetyLevel: skill.safetyLevel || undefined,
      safetyReasons: Array.isArray(skill.safetyReasons) ? skill.safetyReasons : [],
      trustLevel: skill.trustLevel || undefined,
    }));
}

export async function dbBootstrapSkills(
  defaultSkills: Skill[],
  gallerySkills: Skill[],
  gallerySeed: string,
): Promise<SkillBootstrapResult | null> {
  if (!isTauri()) return null;
  return withDbRetry(() => invoke<SkillBootstrapResult>('db_skills_bootstrap', {
    defaultSkills,
    gallerySkills,
    gallerySeed,
  }));
}

export async function dbListMySkills(): Promise<Skill[]> {
  if (!isTauri()) return [];
  const rows = await withDbRetry(() => invoke<Skill[]>('db_skills_list_my'));
  return normalizeSkillArray(rows);
}

export async function dbSetMySkills(skills: Skill[]): Promise<number> {
  if (!isTauri()) return skills.length;
  return withDbRetry(() => invoke<number>('db_skills_set_my', { skills }));
}
