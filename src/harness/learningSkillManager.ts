import {
  loadLearnedSkills,
  upsertLearnedSkills,
  type LearnedSkillEntry,
  type LearningReviewResult,
} from './learningRuntime';
import { createOrReplaceFileBackedSkill, listFileBackedSkills } from './learningSkillFilesystem';

export interface RuntimeSkillShape {
  name: string;
  description: string;
  command?: string;
  cliType?: string;
  category?: string;
  allowedTools?: string[];
  whenToUse?: string;
  disableModelInvocation?: boolean;
  paths?: string[];
  priority?: number;
  model?: string;
}

export async function loadManagedSkills(workDir: string): Promise<LearnedSkillEntry[]> {
  const [dbSkills, fileSkills] = await Promise.all([
    loadLearnedSkills(workDir),
    listFileBackedSkills(workDir),
  ]);
  return mergeRuntimeSkills(dbSkills, fileSkills) as LearnedSkillEntry[];
}

export function mergeRuntimeSkills(
  learnedSkills: RuntimeSkillShape[],
  providedSkills: RuntimeSkillShape[],
): RuntimeSkillShape[] {
  const merged = [...learnedSkills, ...providedSkills];
  const seen = new Set<string>();
  return merged.filter((skill) => {
    const key = skill.name.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => {
    const priorityDelta = (b.priority || 0) - (a.priority || 0);
    if (priorityDelta !== 0) return priorityDelta;
    return a.name.localeCompare(b.name);
  });
}

export async function persistReviewSkills(
  workDir: string,
  review?: LearningReviewResult,
): Promise<LearnedSkillEntry[]> {
  if (!review?.skills?.length) return loadManagedSkills(workDir);
  await upsertLearnedSkills(workDir, review.skills);
  for (const skill of review.skills) {
    await createOrReplaceFileBackedSkill({
      workDir,
      name: skill.name,
      description: skill.description,
      procedure: skill.command,
      cliType: skill.cliType,
    }).catch(() => {});
  }
  return loadManagedSkills(workDir);
}
