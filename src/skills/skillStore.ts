import type { Skill } from './types';

/** Generate a human-readable slug from a skill name.
 *  Preserves CJK characters, lowercases latin, replaces whitespace with hyphens. */
function nameToSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\/\\:*?"<>|]/g, '')   // remove filesystem-unsafe chars
    .replace(/\s+/g, '-')            // whitespace → hyphen
    .replace(/-{2,}/g, '-')          // collapse multiple hyphens
    .replace(/^-|-$/g, '')           // trim leading/trailing hyphens
    || `skill-${Date.now()}`;
}

export function createSkill(partial: Omit<Skill, 'id' | 'builtIn'>): Skill {
  const baseId = nameToSlug(partial.name);
  return {
    ...partial,
    id: baseId,
    builtIn: false,
  };
}

export function exportSkills(skills: Skill[]): string {
  return JSON.stringify(skills.filter(s => !s.builtIn), null, 2);
}

export function importSkills(json: string): Skill[] {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('Invalid skills JSON');
  return parsed.map((s: any) => ({
    id: s.id || nameToSlug(String(s.name || '')),
    name: String(s.name || ''),
    description: String(s.description || ''),
    emoji: String(s.emoji || '⚡'),
    command: String(s.command || ''),
    cliType: s.cliType || 'shell',
    category: s.category || 'custom',
    tags: Array.isArray(s.tags) ? s.tags : [],
    model: typeof s.model === 'string' ? s.model : undefined,
    allowedTools: Array.isArray(s.allowedTools) ? s.allowedTools : [],
    whenToUse: typeof s.whenToUse === 'string' ? s.whenToUse : undefined,
    disableModelInvocation: !!s.disableModelInvocation,
    paths: Array.isArray(s.paths) ? s.paths : [],
    priority: typeof s.priority === 'number' ? s.priority : undefined,
    originalName: typeof s.originalName === 'string' ? s.originalName : undefined,
    originalCommand: typeof s.originalCommand === 'string' ? s.originalCommand : undefined,
    originalDescription: typeof s.originalDescription === 'string' ? s.originalDescription : undefined,
    sourcePack: typeof s.sourcePack === 'string' ? s.sourcePack : undefined,
    sourceUrl: typeof s.sourceUrl === 'string' ? s.sourceUrl : undefined,
    safetyLevel: typeof s.safetyLevel === 'string' ? s.safetyLevel : undefined,
    safetyReasons: Array.isArray(s.safetyReasons) ? s.safetyReasons.map(String).filter(Boolean) : [],
    trustLevel: typeof s.trustLevel === 'string' ? s.trustLevel : undefined,
    builtIn: false,
  }));
}
