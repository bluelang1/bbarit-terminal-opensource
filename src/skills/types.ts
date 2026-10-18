export type SkillCliType = 'shell' | 'claude' | 'codex' | 'cursor' | 'opencode' | 'kimi' | 'gemini' | 'ollama' | 'qwen' | 'pi' | 'reasonix' | 'bbarit';
export type SkillCategory = 'dev' | 'git' | 'ai' | 'ops' | 'custom'
  | 'docker' | 'k8s' | 'system' | 'network' | 'python' | 'rust' | 'db'
  | 'security' | 'testing' | 'frontend' | 'cloud' | 'go' | 'docs' | 'official'
  | 'refactor' | 'review' | 'debug' | 'architecture' | 'performance'
  | 'migration' | 'cicd' | 'react' | 'node' | 'mobile' | 'java' | 'api';
export type SkillSafetyLevel = 'safe' | 'caution' | 'dangerous';
export type SkillTrustLevel = 'builtin' | 'trusted' | 'community' | 'agent-created';

export interface Skill {
  id: string;
  name: string;
  description: string;
  emoji: string;
  command: string;
  cliType: SkillCliType;
  category: SkillCategory;
  tags?: string[];
  builtIn?: boolean;
  model?: string;
  allowedTools?: string[];
  whenToUse?: string;
  disableModelInvocation?: boolean;
  paths?: string[];
  priority?: number;
  /** English original name for project installation (official skills) */
  originalName?: string;
  /** English original command/prompt for project installation (official skills) */
  originalCommand?: string;
  /** English original description for project installation (official skills) */
  originalDescription?: string;
  /** Optional source pack name when installed from remote gallery pack */
  sourcePack?: string;
  /** Raw URL to the original SKILL.md on GitHub (for web-curated skills) */
  sourceUrl?: string;
  /** Safety classification for imported or community skills */
  safetyLevel?: SkillSafetyLevel;
  /** Short reasons that explain the safety classification */
  safetyReasons?: string[];
  /** Provenance trust class inspired by Hermes skill guard policy */
  trustLevel?: SkillTrustLevel;
}
