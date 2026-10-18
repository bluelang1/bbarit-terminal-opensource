import { invoke } from '@tauri-apps/api/core';
import {
  buildLearningContext,
  type LearnedSkillEntry,
  type LearningContextResult,
  type LearningMemoryEntry,
} from './learningRuntime';

export type LearningProviderName =
  | 'thread-handoff'
  | 'core-learning-recall'
  | 'external-memory-mirror'
  | 'durable-memory'
  | 'session-index'
  | 'trajectory-log'
  | 'learned-skill';

export interface LearningProviderContextRequest {
  workDir: string;
  query: string;
  threadId?: string;
  threadSummary?: string;
}

export interface LearningProviderContextContribution {
  provider: LearningProviderName;
  memories: LearningMemoryEntry[];
  skills: LearnedSkillEntry[];
}

export interface LearningProvider {
  name: LearningProviderName;
  initialize?: (workDir: string) => Promise<void> | void;
  loadContext: (request: LearningProviderContextRequest) => Promise<LearningProviderContextContribution>;
  syncTurn?: (params: {
    workDir: string;
    userMessage: string;
    assistantMessage: string;
    memories?: LearningMemoryEntry[];
    skills?: LearnedSkillEntry[];
  }) => Promise<void> | void;
  shutdown?: () => Promise<void> | void;
}

export interface LearningProviderRegistry {
  listProviders: () => LearningProvider[];
}

interface LearningExternalMirrorState {
  memories: LearningMemoryEntry[];
  skills: LearnedSkillEntry[];
  updatedAt?: number;
}

interface LearningExternalProviderConfig {
  type: 'filesystem-mirror' | 'directory-mirror' | 'markdown-vault';
  enabled: boolean;
  path?: string;
  maxMemories?: number;
  maxSkills?: number;
}

interface FsDirectoryEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

const DEFAULT_EXTERNAL_MIRROR_RELATIVE_PATH = '.octo-self-improving/providers/external-memory.json';
const DEFAULT_EXTERNAL_MIRROR_DIRECTORY = '.octo-self-improving/providers/external-memory';
const DEFAULT_EXTERNAL_MARKDOWN_VAULT_DIRECTORY = '.octo-self-improving/providers/external-vault';
const DEFAULT_EXTERNAL_MIRROR_MEMORY_LIMIT = 80;
const DEFAULT_EXTERNAL_MIRROR_SKILL_LIMIT = 40;

function trimTrailingSlashes(value: string): string {
  return String(value || '').replace(/[\\/]+$/, '');
}

function tokenizeRecallQuery(query: string): string[] {
  return String(query || '')
    .toLowerCase()
    .split(/[\s,./\\:;!?()[\]{}"'`|<>@#$%^&*+=~-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreDurableMemory(memory: LearningMemoryEntry, query: string): number {
  const haystack = `${memory.content} ${memory.source || ''}`.toLowerCase();
  const tokens = tokenizeRecallQuery(query);
  let score = memory.pinned ? 4 : 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 3;
  }
  return score;
}

function scoreLearnedSkill(skill: LearnedSkillEntry, queryTokens: string[]): number {
  const haystack = [
    skill.name,
    skill.description,
    skill.command,
    skill.sourceThread || '',
  ].join(' ').toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 3;
    if (skill.name.toLowerCase().includes(token)) score += 3;
    if (skill.description.toLowerCase().includes(token)) score += 2;
  }
  return score;
}

function slugifyLearningName(value: string, fallback: string): string {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

function summarizeSkillDescription(markdown: string): string {
  const cleaned = String(markdown || '')
    .replace(/^# .+$/m, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 220) || 'Imported external markdown skill.';
}

function extractSkillProcedure(markdown: string): string {
  const sectionMatch = String(markdown || '').match(/##\s+(Procedure|Steps|Workflow)\s*([\s\S]*?)(?:\n##\s+|$)/i);
  const body = sectionMatch?.[2] || markdown;
  return String(body || '').trim().slice(0, 6000);
}

function createExternalMarkdownSkill(params: {
  name: string;
  markdown: string;
  sourcePath: string;
}): LearnedSkillEntry {
  return {
    id: `external-skill:${slugifyLearningName(params.sourcePath, params.name)}`,
    name: params.name,
    description: summarizeSkillDescription(params.markdown),
    command: extractSkillProcedure(params.markdown),
    cliType: 'atlascloud',
    category: 'external-markdown-vault',
    sourceThread: params.sourcePath,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function normalizeExternalProviderConfig(value: unknown): LearningExternalProviderConfig | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.type !== 'filesystem-mirror' && raw.type !== 'directory-mirror' && raw.type !== 'markdown-vault') return null;
  return {
    type: raw.type,
    enabled: raw.enabled !== false,
    path: typeof raw.path === 'string' ? raw.path.trim() : undefined,
    maxMemories: typeof raw.maxMemories === 'number' ? Math.max(1, Math.floor(raw.maxMemories)) : undefined,
    maxSkills: typeof raw.maxSkills === 'number' ? Math.max(1, Math.floor(raw.maxSkills)) : undefined,
  };
}

async function loadConfiguredExternalProviders(): Promise<LearningExternalProviderConfig[]> {
  try {
    const raw = await invoke<string>('read_config');
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>;
    const candidates = [
      parsed.selfImproving,
      (parsed.harness && typeof parsed.harness === 'object')
        ? (parsed.harness as Record<string, unknown>).selfImproving
        : undefined,
    ];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const providers = (candidate as Record<string, unknown>).providers;
      if (!Array.isArray(providers)) continue;
      return providers
        .map(normalizeExternalProviderConfig)
        .filter((item): item is LearningExternalProviderConfig => !!item && item.enabled);
    }
  } catch {
    return [];
  }
  return [];
}

function resolveExternalMirrorPath(workDir: string, configuredPath?: string): string {
  const trimmedWorkDir = trimTrailingSlashes(workDir);
  const candidate = String(configuredPath || '').trim();
  if (!candidate) {
    return `${trimmedWorkDir}/${DEFAULT_EXTERNAL_MIRROR_RELATIVE_PATH}`;
  }
  if (/^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('/') || candidate.startsWith('\\')) {
    return candidate;
  }
  return `${trimmedWorkDir}/${candidate}`;
}

function resolveExternalMirrorDirectory(workDir: string, configuredPath?: string): string {
  const trimmedWorkDir = trimTrailingSlashes(workDir);
  const candidate = String(configuredPath || '').trim();
  if (!candidate) {
    return `${trimmedWorkDir}/${DEFAULT_EXTERNAL_MIRROR_DIRECTORY}`;
  }
  if (/^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('/') || candidate.startsWith('\\')) {
    return trimTrailingSlashes(candidate);
  }
  return `${trimmedWorkDir}/${trimTrailingSlashes(candidate)}`;
}

function resolveExternalMarkdownVaultDirectory(workDir: string, configuredPath?: string): string {
  const trimmedWorkDir = trimTrailingSlashes(workDir);
  const candidate = String(configuredPath || '').trim();
  if (!candidate) {
    return `${trimmedWorkDir}/${DEFAULT_EXTERNAL_MARKDOWN_VAULT_DIRECTORY}`;
  }
  if (/^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('/') || candidate.startsWith('\\')) {
    return trimTrailingSlashes(candidate);
  }
  return `${trimmedWorkDir}/${trimTrailingSlashes(candidate)}`;
}

async function readDirectoryEntries(path: string): Promise<FsDirectoryEntry[]> {
  try {
    const entries = await invoke<FsDirectoryEntry[]>('read_directory', { path });
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

async function readExternalMirrorState(path: string): Promise<LearningExternalMirrorState> {
  try {
    const raw = await invoke<string>('read_file', { path });
    const parsed = JSON.parse(String(raw || '{}')) as Partial<LearningExternalMirrorState>;
    return {
      memories: Array.isArray(parsed.memories)
        ? parsed.memories.filter((item): item is LearningMemoryEntry => !!item && typeof item.content === 'string')
        : [],
      skills: Array.isArray(parsed.skills)
        ? parsed.skills.filter((item): item is LearnedSkillEntry => !!item && typeof item.name === 'string' && typeof item.command === 'string')
        : [],
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined,
    };
  } catch {
    return { memories: [], skills: [] };
  }
}

async function writeExternalMirrorState(path: string, state: LearningExternalMirrorState): Promise<void> {
  const normalizedPath = path.replace(/\\/g, '/');
  const lastSlash = normalizedPath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash) : '';
  if (dir) {
    await invoke('create_directory', { path: dir }).catch(() => {});
  }
  await invoke('write_file', {
    path,
    content: JSON.stringify({
      updatedAt: Date.now(),
      memories: state.memories,
      skills: state.skills,
    }, null, 2),
  }).catch(() => {});
}

async function readExternalMirrorDirectoryState(path: string): Promise<LearningExternalMirrorState> {
  const base = trimTrailingSlashes(path.replace(/\\/g, '/'));
  const [memoryRaw, skillRaw] = await Promise.all([
    invoke<string>('read_file', { path: `${base}/memories.json` }).catch(() => ''),
    invoke<string>('read_file', { path: `${base}/skills.json` }).catch(() => ''),
  ]);

  let memories: LearningMemoryEntry[] = [];
  let skills: LearnedSkillEntry[] = [];

  try {
    const parsed = JSON.parse(String(memoryRaw || '[]'));
    if (Array.isArray(parsed)) {
      memories = parsed.filter((item): item is LearningMemoryEntry => !!item && typeof item.content === 'string');
    }
  } catch {
    memories = [];
  }

  try {
    const parsed = JSON.parse(String(skillRaw || '[]'));
    if (Array.isArray(parsed)) {
      skills = parsed.filter((item): item is LearnedSkillEntry => !!item && typeof item.name === 'string' && typeof item.command === 'string');
    }
  } catch {
    skills = [];
  }

  return { memories, skills };
}

async function writeExternalMirrorDirectoryState(path: string, state: LearningExternalMirrorState): Promise<void> {
  const base = trimTrailingSlashes(path.replace(/\\/g, '/'));
  await invoke('create_directory', { path: base }).catch(() => {});
  await Promise.all([
    invoke('write_file', {
      path: `${base}/memories.json`,
      content: JSON.stringify(state.memories, null, 2),
    }).catch(() => {}),
    invoke('write_file', {
      path: `${base}/skills.json`,
      content: JSON.stringify(state.skills, null, 2),
    }).catch(() => {}),
    invoke('write_file', {
      path: `${base}/meta.json`,
      content: JSON.stringify({ updatedAt: Date.now() }, null, 2),
    }).catch(() => {}),
  ]);
}

async function readExternalMarkdownVaultState(path: string): Promise<LearningExternalMirrorState> {
  const base = trimTrailingSlashes(path.replace(/\\/g, '/'));
  const memoryDir = `${base}/memories`;
  const skillDir = `${base}/skills`;
  const [memoryEntries, skillEntries] = await Promise.all([
    readDirectoryEntries(memoryDir),
    readDirectoryEntries(skillDir),
  ]);

  const memoryResults = await Promise.all(memoryEntries
    .filter((entry) => !entry.is_dir && /\.md$/i.test(entry.name))
    .map(async (entry) => {
      try {
        const content = String(await invoke<string>('read_file', { path: entry.path }) || '').trim();
        if (!content) return null;
        const title = entry.name.replace(/\.md$/i, '');
        return {
          content,
          source: `markdown-vault:${title}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as LearningMemoryEntry;
      } catch {
        return null;
      }
    }));
  const memories: LearningMemoryEntry[] = memoryResults.filter((entry): entry is LearningMemoryEntry => entry !== null);

  const directSkillFiles = skillEntries.filter((entry) => !entry.is_dir && /\.md$/i.test(entry.name));
  const nestedSkillDirs = skillEntries.filter((entry) => entry.is_dir);

  const directSkills = await Promise.all(directSkillFiles.map(async (entry) => {
    try {
      const markdown = String(await invoke<string>('read_file', { path: entry.path }) || '').trim();
      if (!markdown) return null;
      const name = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || entry.name.replace(/\.md$/i, '');
      return createExternalMarkdownSkill({
        name,
        markdown,
        sourcePath: entry.path,
      });
    } catch {
      return null;
    }
  }));

  const nestedSkills = await Promise.all(nestedSkillDirs.map(async (entry) => {
    const skillPath = `${entry.path.replace(/\\/g, '/')}/SKILL.md`;
    try {
      const markdown = String(await invoke<string>('read_file', { path: skillPath }) || '').trim();
      if (!markdown) return null;
      const name = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || entry.name;
      return createExternalMarkdownSkill({
        name,
        markdown,
        sourcePath: skillPath,
      });
    } catch {
      return null;
    }
  }));

  return {
    memories,
    skills: [...directSkills, ...nestedSkills].filter((entry): entry is LearnedSkillEntry => entry !== null),
    updatedAt: Date.now(),
  };
}

async function writeExternalMarkdownVaultState(path: string, state: LearningExternalMirrorState): Promise<void> {
  const base = trimTrailingSlashes(path.replace(/\\/g, '/'));
  const memoryDir = `${base}/memories`;
  const skillDir = `${base}/skills`;
  await Promise.all([
    invoke('create_directory', { path: memoryDir }).catch(() => {}),
    invoke('create_directory', { path: skillDir }).catch(() => {}),
  ]);

  await Promise.all([
    ...state.memories.map((memory, index) => {
      const slug = slugifyLearningName(memory.source || memory.content, `memory-${index + 1}`);
      return invoke('write_file', {
        path: `${memoryDir}/${slug}.md`,
        content: String(memory.content || '').trim(),
      }).catch(() => {});
    }),
    ...state.skills.map((skill, index) => {
      const slug = slugifyLearningName(skill.name, `skill-${index + 1}`);
      const skillPath = `${skillDir}/${slug}/SKILL.md`;
      const markdown = [
        `# ${skill.name}`,
        '',
        skill.description || 'Imported external markdown skill.',
        '',
        '## Procedure',
        '',
        skill.command || '',
        '',
      ].join('\n');
      return invoke('write_file', {
        path: skillPath,
        content: markdown,
      }).catch(() => {});
    }),
    invoke('write_file', {
      path: `${base}/meta.json`,
      content: JSON.stringify({ updatedAt: Date.now() }, null, 2),
    }).catch(() => {}),
  ]);
}

function dedupeMirrorMemories(memories: LearningMemoryEntry[], limit: number): LearningMemoryEntry[] {
  const seen = new Set<string>();
  const merged: LearningMemoryEntry[] = [];
  for (const memory of memories) {
    const content = String(memory.content || '').trim();
    if (!content) continue;
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      ...memory,
      content,
      source: memory.source || 'external-mirror',
      updatedAt: memory.updatedAt || Date.now(),
      createdAt: memory.createdAt || Date.now(),
    });
    if (merged.length >= limit) break;
  }
  return merged;
}

function dedupeMirrorSkills(skills: LearnedSkillEntry[], limit: number): LearnedSkillEntry[] {
  const seen = new Set<string>();
  const merged: LearnedSkillEntry[] = [];
  for (const skill of skills) {
    const name = String(skill.name || '').trim();
    const command = String(skill.command || '').trim();
    if (!name || !command) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      ...skill,
      name,
      command,
      updatedAt: skill.updatedAt || Date.now(),
      createdAt: skill.createdAt || Date.now(),
    });
    if (merged.length >= limit) break;
  }
  return merged;
}

const threadHandoffProvider: LearningProvider = {
  name: 'thread-handoff',
  async loadContext(request) {
    const summary = String(request.threadSummary || '').trim();
    if (!summary) {
      return { provider: 'thread-handoff', memories: [], skills: [] };
    }
    return {
      provider: 'thread-handoff',
      memories: [{
        content: `Compressed thread handoff: ${summary}`,
        pinned: true,
        createdAt: Date.now(),
        source: 'thread-handoff',
      }],
      skills: [],
    };
  },
};

const coreLearningRecallProvider: LearningProvider = {
  name: 'core-learning-recall',
  async loadContext(request) {
    const context = await buildLearningContext(request);
    return {
      provider: 'core-learning-recall',
      memories: context.memories,
      skills: context.skills,
    };
  },
  async syncTurn() {
    return undefined;
  },
};

const externalMemoryMirrorProvider: LearningProvider = {
  name: 'external-memory-mirror',
  async loadContext(request) {
    const configs = await loadConfiguredExternalProviders();
    if (configs.length === 0) {
      return { provider: 'external-memory-mirror', memories: [], skills: [] };
    }
    const queryTokens = tokenizeRecallQuery(request.query);
    const states = await Promise.all(configs.map(async (config) => {
      const state = config.type === 'directory-mirror'
        ? await readExternalMirrorDirectoryState(resolveExternalMirrorDirectory(request.workDir, config.path))
        : config.type === 'markdown-vault'
          ? await readExternalMarkdownVaultState(resolveExternalMarkdownVaultDirectory(request.workDir, config.path))
          : await readExternalMirrorState(resolveExternalMirrorPath(request.workDir, config.path));
      return { config, state };
    }));

    const memories = states.flatMap(({ state }) =>
      state.memories
        .map((entry) => ({ entry, score: scoreDurableMemory(entry, request.query) }))
        .filter((item) => item.entry.pinned || item.score > 2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((item) => ({
          content: `External mirror memory (${item.entry.source || 'mirror'}): ${item.entry.content}`,
          createdAt: item.entry.createdAt,
          pinned: item.entry.pinned,
          source: item.entry.source || 'external-mirror',
        })),
    );

    const skills = states.flatMap(({ state }) =>
      state.skills
        .map((entry) => ({ entry, score: scoreLearnedSkill(entry, queryTokens) }))
        .filter((item) => item.score > 2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
        .map((item) => item.entry),
    );

    return {
      provider: 'external-memory-mirror',
      memories: dedupeMirrorMemories(memories, 4),
      skills: dedupeMirrorSkills(skills, 3),
    };
  },
  async syncTurn(params) {
    const configs = await loadConfiguredExternalProviders();
    if (configs.length === 0) return;
    await Promise.all(configs.map(async (config) => {
      const current = config.type === 'directory-mirror'
        ? await readExternalMirrorDirectoryState(resolveExternalMirrorDirectory(params.workDir, config.path))
        : config.type === 'markdown-vault'
          ? await readExternalMarkdownVaultState(resolveExternalMarkdownVaultDirectory(params.workDir, config.path))
          : await readExternalMirrorState(resolveExternalMirrorPath(params.workDir, config.path));
      const nextState = {
        updatedAt: Date.now(),
        memories: dedupeMirrorMemories(
          [
            ...(params.memories || []).map((memory) => ({
              ...memory,
              source: memory.source || 'review',
              updatedAt: Date.now(),
            })),
            ...current.memories,
          ],
          config.maxMemories || DEFAULT_EXTERNAL_MIRROR_MEMORY_LIMIT,
        ),
        skills: dedupeMirrorSkills(
          [
            ...(params.skills || []).map((skill) => ({
              ...skill,
              category: skill.category || 'self-improving',
              updatedAt: Date.now(),
            })),
            ...current.skills,
          ],
          config.maxSkills || DEFAULT_EXTERNAL_MIRROR_SKILL_LIMIT,
        ),
      };
      if (config.type === 'directory-mirror') {
        await writeExternalMirrorDirectoryState(
          resolveExternalMirrorDirectory(params.workDir, config.path),
          nextState,
        );
        return;
      }
      if (config.type === 'markdown-vault') {
        await writeExternalMarkdownVaultState(
          resolveExternalMarkdownVaultDirectory(params.workDir, config.path),
          nextState,
        );
        return;
      }
      await writeExternalMirrorState(resolveExternalMirrorPath(params.workDir, config.path), nextState);
    }));
  },
};

export function createDefaultLearningProviders(extraProviders: LearningProvider[] = []): LearningProvider[] {
  return [
    threadHandoffProvider,
    coreLearningRecallProvider,
    externalMemoryMirrorProvider,
    ...extraProviders,
  ];
}

export function createLearningProviderRegistry(extraProviders: LearningProvider[] = []): LearningProviderRegistry {
  const providers = createDefaultLearningProviders(extraProviders);
  return {
    listProviders: () => [...providers],
  };
}

export const DEFAULT_LEARNING_PROVIDERS: LearningProvider[] = createDefaultLearningProviders();

export async function gatherLearningContext(
  request: LearningProviderContextRequest,
  providers: LearningProvider[] = DEFAULT_LEARNING_PROVIDERS,
): Promise<LearningContextResult> {
  const contributions = await Promise.all(providers.map((provider) => provider.loadContext(request)));
  return {
    memories: contributions.flatMap((item) => item.memories),
    skills: contributions.flatMap((item) => item.skills),
    sources: contributions
      .filter((item) => item.memories.length > 0 || item.skills.length > 0)
      .map((item) => `${item.provider}:${item.memories.length + item.skills.length}`),
  };
}

export async function gatherDefaultLearningContext(
  request: LearningProviderContextRequest,
  extraProviders: LearningProvider[] = [],
): Promise<LearningContextResult> {
  const registry = createLearningProviderRegistry(extraProviders);
  return gatherLearningContext(request, registry.listProviders());
}

export async function gatherLearningContextLegacy(
  request: LearningProviderContextRequest,
): Promise<LearningContextResult> {
  return buildLearningContext(request);
}
