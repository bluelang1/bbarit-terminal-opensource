import { invoke } from '@tauri-apps/api/core';
import { runCliPrompt, type CliProvider } from './cliRuntime';
import { buildBackgroundReviewPrompt, spawnBackgroundReview } from './learningBackgroundReview';
import type { BackgroundReviewChannel, BackgroundReviewSummary } from './learningBackgroundReview';

export interface LearningMemoryEntry {
  id?: string;
  content: string;
  source?: string;
  pinned?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export type SkillProvenance = 'foreground' | 'background_review';
export type SkillLifecycle = 'active' | 'stale' | 'archived';

export interface LearnedSkillEntry {
  id: string;
  name: string;
  description: string;
  command: string;
  cliType: CliProvider;
  category: string;
  sourceThread?: string;
  // Distinguishes autonomous background-review writes from user-directed ones,
  // so the curator manages only what the agent created on its own.
  createdBy?: SkillProvenance;
  // Curator lifecycle tracking.
  lastUsedAt?: number;
  pinned?: boolean;
  lifecycle?: SkillLifecycle;
  createdAt: number;
  updatedAt: number;
}

export interface SessionIndexEntry {
  id: string;
  threadId: string;
  title: string;
  workDir: string;
  mode: string;
  provider: string;
  userMessage: string;
  assistantSummary: string;
  toolNames: string[];
  savedFiles: string[];
  artifactNames: string[];
  createdAt: number;
}

export interface LearningReviewResult {
  memories: LearningMemoryEntry[];
  skills: LearnedSkillEntry[];
  summary?: string;
}

export interface LearningTrajectoryEntry {
  id: string;
  threadId: string;
  workDir: string;
  title: string;
  mode: string;
  provider: string;
  messagesJson: string;
  reviewJson?: string | null;
  createdAt: number;
}

export interface LearningContextResult {
  memories: LearningMemoryEntry[];
  skills: LearnedSkillEntry[];
  sources: string[];
}

export interface LearningUnifiedSearchResult {
  sessions: SessionIndexEntry[];
  skills: LearnedSkillEntry[];
  memories: LearningMemoryEntry[];
  trajectories: LearningTrajectoryEntry[];
  sources: string[];
}

export interface LearningExportBundle {
  exportedAt: number;
  workDir: string;
  memories: LearningMemoryEntry[];
  skills: LearnedSkillEntry[];
  sessions: SessionIndexEntry[];
  trajectories: LearningTrajectoryEntry[];
}

export interface LearningEvalCase {
  id: string;
  kind: 'session-replay' | 'trajectory-replay';
  title: string;
  prompt: string;
  expectedSummary: string;
  workDir: string;
  metadata: {
    threadId?: string;
    mode?: string;
    provider?: string;
    createdAt?: number;
    savedFiles?: string[];
    toolNames?: string[];
    artifactNames?: string[];
  };
}

export interface LearningEvalBundle {
  exportedAt: number;
  workDir: string;
  cases: LearningEvalCase[];
}

export interface LearningDatagenCase {
  id: string;
  kind: 'session-sft' | 'trajectory-sft' | 'skill-sft';
  instruction: string;
  response: string;
  system?: string;
  workDir: string;
  metadata: {
    sourceId?: string;
    threadId?: string;
    title?: string;
    mode?: string;
    provider?: string;
    createdAt?: number;
    toolNames?: string[];
    savedFiles?: string[];
    artifactNames?: string[];
    skillName?: string;
  };
}

export interface LearningDatagenBundle {
  exportedAt: number;
  workDir: string;
  cases: LearningDatagenCase[];
}

export async function summarizeThreadForCompression(params: {
  provider: CliProvider;
  workDir: string;
  threadTitle?: string;
  messages: Array<{ role: 'human' | 'assistant' | 'tool' | 'system'; content: string }>;
  timeoutSecs: number;
}): Promise<string | undefined> {
  const candidates = params.messages
    .filter((message) => message.role === 'human' || message.role === 'assistant')
    .slice(-20);
  if (candidates.length < 10) return undefined;

  const transcript = candidates
    .map((message) => `${message.role === 'human' ? 'User' : 'Assistant'}: ${message.content.slice(0, 1200)}`)
    .join('\n\n');
  const prompt = [
    'Summarize this long-running Coding Secretary thread for future handoff.',
    'Return plain text only.',
    'Include:',
    '- overall goal',
    '- key decisions and constraints',
    '- files/components touched',
    '- unresolved items',
    '- reusable lessons',
    '',
    `Thread: ${params.threadTitle || 'untitled'}`,
    '',
    transcript,
  ].join('\n');

  try {
    const raw = await runCliPrompt(params.provider, prompt, params.workDir, params.timeoutSecs);
    const summary = String(raw || '').trim();
    return summary.length >= 80 ? summary.slice(0, 2400) : undefined;
  } catch {
    return undefined;
  }
}

export async function appendLearningTrajectory(entry: LearningTrajectoryEntry): Promise<void> {
  await invoke('db_learning_append_trajectory', { entry }).catch(() => {});
}

const SESSION_INDEX_LIMIT = 120;
const LEARNED_SKILL_LIMIT = 80;
const DURABLE_MEMORY_LIMIT = 120;
const RECALL_LIMIT = 3;
const TRAJECTORY_RECALL_LIMIT = 2;
const SKILL_RECALL_LIMIT = 4;

function sanitizeKeyPart(value: string): string {
  return (value || 'global')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'global';
}

function buildStorageKey(kind: 'index' | 'skills' | 'memories', workDir: string): string {
  return `octo-harness-learning:${kind}:${sanitizeKeyPart(workDir)}`;
}

async function kvGet(key: string): Promise<string | null> {
  try {
    return await invoke<string>('kv_get', { key });
  } catch {
    return null;
  }
}

async function kvSet(key: string, value: string): Promise<void> {
  await invoke('kv_set', { key, value }).catch(() => {});
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function ensureArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function tokenizeForRecall(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_가-힣]+/i)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function scoreSessionEntry(entry: SessionIndexEntry, queryTokens: string[]): number {
  const haystack = [
    entry.title,
    entry.userMessage,
    entry.assistantSummary,
    entry.savedFiles.join(' '),
    entry.toolNames.join(' '),
    entry.artifactNames.join(' '),
  ].join(' ').toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 3;
    if (entry.title.toLowerCase().includes(token)) score += 2;
    if (entry.userMessage.toLowerCase().includes(token)) score += 2;
  }

  const ageHours = Math.max(1, (Date.now() - (entry.createdAt || 0)) / 3_600_000);
  score += Math.max(0, 4 - Math.log10(ageHours));
  return score;
}

function scoreLearnedSkill(entry: LearnedSkillEntry, queryTokens: string[]): number {
  const haystack = [
    entry.name,
    entry.description,
    entry.command,
    entry.sourceThread || '',
  ].join(' ').toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 3;
    if (entry.name.toLowerCase().includes(token)) score += 3;
    if (entry.description.toLowerCase().includes(token)) score += 2;
  }
  return score;
}

function scoreTrajectoryEntry(entry: LearningTrajectoryEntry, queryTokens: string[]): number {
  const haystack = [
    entry.title,
    entry.mode,
    entry.provider,
    entry.messagesJson,
    entry.reviewJson || '',
  ].join(' ').toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 2;
    if (entry.title.toLowerCase().includes(token)) score += 2;
  }

  const ageHours = Math.max(1, (Date.now() - (entry.createdAt || 0)) / 3_600_000);
  score += Math.max(0, 3 - Math.log10(ageHours));
  return score;
}

function summarizeTrajectory(entry: LearningTrajectoryEntry): string {
  const raw = `${entry.reviewJson || ''}\n${entry.messagesJson || ''}`.slice(0, 2800);
  const compact = raw
    .replace(/\s+/g, ' ')
    .replace(/[{}[\]"]/g, ' ')
    .trim();
  return compact.slice(0, 360);
}

function dedupeLearningMemories(memories: LearningMemoryEntry[], limit = 12): LearningMemoryEntry[] {
  const seen = new Set<string>();
  const deduped = memories
    .filter((entry) => !!entry?.content?.trim())
    .map((entry) => ({
      ...entry,
      content: entry.content.trim(),
    }))
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
    })
    .filter((entry) => {
      const key = entry.content.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return deduped.slice(0, limit);
}

function dedupeLearnedSkills(skills: LearnedSkillEntry[], limit = 6): LearnedSkillEntry[] {
  const seen = new Set<string>();
  const deduped = skills
    .filter((entry) => !!entry?.name?.trim() && !!entry?.command?.trim())
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    .filter((entry) => {
      const key = entry.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return deduped.slice(0, limit);
}

export async function searchAllLearning(params: {
  workDir: string;
  query: string;
  threadId?: string;
}): Promise<LearningUnifiedSearchResult | null> {
  const backendBundle = await invoke<LearningUnifiedSearchResult>('db_learning_search_all', {
    params: {
      workDir: params.workDir,
      query: params.query,
      threadId: params.threadId,
      sessionLimit: RECALL_LIMIT,
      skillLimit: SKILL_RECALL_LIMIT,
      memoryLimit: 4,
      trajectoryLimit: TRAJECTORY_RECALL_LIMIT,
    },
  }).catch(() => null);
  if (backendBundle) {
    return {
      ...backendBundle,
      memories: dedupeLearningMemories(backendBundle.memories, 8),
      skills: dedupeLearnedSkills(backendBundle.skills, SKILL_RECALL_LIMIT),
    };
  }
  return null;
}

export async function loadLearnedSkills(workDir: string): Promise<LearnedSkillEntry[]> {
  const entries = await invoke<LearnedSkillEntry[]>('db_learning_list_skills', { workDir })
    .catch(async () => parseJsonArray<LearnedSkillEntry>(await kvGet(buildStorageKey('skills', workDir))));
  return ensureArray(entries)
    .filter((entry) => !!entry?.name && !!entry?.command)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

export async function listLearningTrajectories(workDir: string): Promise<LearningTrajectoryEntry[]> {
  const entries = await invoke<LearningTrajectoryEntry[]>('db_learning_list_trajectories', { workDir }).catch(() => []);
  return ensureArray<LearningTrajectoryEntry>(entries);
}

export async function exportLearningBundle(workDir: string): Promise<{ path: string; bundle: LearningExportBundle }> {
  const [memories, skills, sessions, trajectories] = await Promise.all([
    loadDurableMemories(workDir),
    loadLearnedSkills(workDir),
    invoke<SessionIndexEntry[]>('db_learning_list_sessions', { workDir })
      .catch(async () => parseJsonArray<SessionIndexEntry>(await kvGet(buildStorageKey('index', workDir)))),
    listLearningTrajectories(workDir),
  ]);

  const bundle: LearningExportBundle = {
    exportedAt: Date.now(),
    workDir,
    memories,
    skills,
    sessions,
    trajectories,
  };

  const path = `${workDir.replace(/[\\\/]+$/, '')}/.octo-learning-export.json`;
  await invoke('write_file', { path, content: JSON.stringify(bundle, null, 2) });
  return { path, bundle };
}

async function saveLearnedSkills(workDir: string, skills: LearnedSkillEntry[]): Promise<void> {
  const normalized = [...skills]
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    .slice(0, LEARNED_SKILL_LIMIT);
  const persisted = normalized.map((skill) => ({ ...skill, workDir }));
  const saved = await invoke('db_learning_upsert_skills', { skills: persisted }).then(() => true).catch(() => false);
  if (!saved) {
    await kvSet(buildStorageKey('skills', workDir), JSON.stringify(normalized));
  }
}

export async function loadDurableMemories(workDir: string): Promise<LearningMemoryEntry[]> {
  const entries = await invoke<LearningMemoryEntry[]>('db_learning_list_memories', { workDir })
    .catch(async () => parseJsonArray<LearningMemoryEntry>(await kvGet(buildStorageKey('memories', workDir))));
  return ensureArray(entries)
    .filter((entry) => !!entry?.content)
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
    });
}

export async function searchDurableMemories(
  workDir: string,
  query: string,
  limit = 4,
): Promise<LearningMemoryEntry[]> {
  const backendResults = await invoke<LearningMemoryEntry[]>('db_learning_search_memories', {
    params: {
      workDir,
      query,
      limit,
    },
  }).catch(() => null);
  if (backendResults && backendResults.length > 0) {
    return backendResults;
  }

  const memories = await loadDurableMemories(workDir);
  return memories
    .map((entry) => ({ entry, score: scoreSessionEntry({
      id: entry.id || '',
      threadId: '',
      title: entry.source || 'memory',
      workDir,
      mode: 'memory',
      provider: 'memory',
      userMessage: entry.content,
      assistantSummary: entry.content,
      toolNames: [],
      savedFiles: [],
      artifactNames: [],
      createdAt: entry.updatedAt || entry.createdAt || 0,
    }, tokenizeForRecall(query)) + (entry.pinned ? 2 : 0) }))
    .filter((item) => item.entry.pinned || item.score > 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.entry);
}

export async function saveDurableMemories(workDir: string, memories: LearningMemoryEntry[]): Promise<void> {
  const normalized = [...memories]
    .filter((entry) => !!entry.content?.trim())
    .map((entry, index) => ({
      id: entry.id || `${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      content: entry.content.trim(),
      source: entry.source || 'manual',
      pinned: !!entry.pinned,
      createdAt: entry.createdAt || Date.now(),
      updatedAt: Date.now(),
    }))
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
    })
    .slice(0, DURABLE_MEMORY_LIMIT);
  const persisted = normalized.map((memory) => ({ ...memory, workDir }));
  const saved = await invoke('db_learning_upsert_memories', { memories: persisted }).then(() => true).catch(() => false);
  if (!saved) {
    await kvSet(buildStorageKey('memories', workDir), JSON.stringify(normalized));
  }
}

export async function upsertLearnedSkills(
  workDir: string,
  skills: LearnedSkillEntry[],
): Promise<LearnedSkillEntry[]> {
  if (skills.length === 0) return loadLearnedSkills(workDir);
  const existing = await loadLearnedSkills(workDir);
  const merged = [...existing];

  for (const skill of skills) {
    const idx = merged.findIndex((entry) => entry.name.trim().toLowerCase() === skill.name.trim().toLowerCase());
    if (idx >= 0) {
      merged[idx] = {
        ...merged[idx],
        ...skill,
        id: merged[idx].id,
        updatedAt: Date.now(),
      };
    } else {
      merged.push({
        ...skill,
        id: skill.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: skill.createdAt || Date.now(),
        updatedAt: skill.updatedAt || Date.now(),
      });
    }
  }

  await saveLearnedSkills(workDir, merged);
  return loadLearnedSkills(workDir);
}

export async function recordSessionEntry(
  workDir: string,
  entry: SessionIndexEntry,
): Promise<void> {
  const persisted = await invoke('db_learning_upsert_session', {
    entry: { ...entry, workDir },
  }).then(() => true).catch(() => false);
  if (persisted) return;
  const key = buildStorageKey('index', workDir);
  const entries = parseJsonArray<SessionIndexEntry>(await kvGet(key))
    .filter((item) => item.threadId !== entry.threadId || item.userMessage !== entry.userMessage);

  entries.unshift({
    ...entry,
    assistantSummary: entry.assistantSummary.slice(0, 2400),
    userMessage: entry.userMessage.slice(0, 1200),
    title: entry.title.slice(0, 200),
    savedFiles: entry.savedFiles.slice(0, 12),
    artifactNames: entry.artifactNames.slice(0, 12),
    toolNames: entry.toolNames.slice(0, 12),
  });

  await kvSet(key, JSON.stringify(entries.slice(0, SESSION_INDEX_LIMIT)));
}

export async function searchSessionRecall(
  workDir: string,
  query: string,
  threadId?: string,
  limit = RECALL_LIMIT,
): Promise<SessionIndexEntry[]> {
  const backendResults = await invoke<SessionIndexEntry[]>('db_learning_search_sessions', {
    params: {
      workDir,
      query,
      threadId,
      limit,
    },
  }).catch(() => null);
  if (backendResults && backendResults.length > 0) {
    return backendResults;
  }

  const entries = await invoke<SessionIndexEntry[]>('db_learning_list_sessions', { workDir })
    .catch(async () => parseJsonArray<SessionIndexEntry>(await kvGet(buildStorageKey('index', workDir))));
  const queryTokens = tokenizeForRecall(query);
  if (queryTokens.length === 0) return [];

  return ensureArray(entries)
    .filter((entry) => entry.threadId !== threadId)
    .map((entry) => ({ entry, score: scoreSessionEntry(entry, queryTokens) }))
    .filter((item) => item.score > 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.entry);
}

export async function searchRelevantSkills(
  workDir: string,
  query: string,
  limit = SKILL_RECALL_LIMIT,
): Promise<LearnedSkillEntry[]> {
  const backendResults = await invoke<LearnedSkillEntry[]>('db_learning_search_skills', {
    params: {
      workDir,
      query,
      limit,
    },
  }).catch(() => null);
  if (backendResults && backendResults.length > 0) {
    return backendResults;
  }

  const entries = await loadLearnedSkills(workDir);
  const queryTokens = tokenizeForRecall(query);
  if (queryTokens.length === 0) return [];

  return entries
    .map((entry) => ({ entry, score: scoreLearnedSkill(entry, queryTokens) }))
    .filter((item) => item.score > 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.entry);
}

export async function searchTrajectoryRecall(
  workDir: string,
  query: string,
  threadId?: string,
  limit = TRAJECTORY_RECALL_LIMIT,
): Promise<LearningTrajectoryEntry[]> {
  const backendResults = await invoke<LearningTrajectoryEntry[]>('db_learning_search_trajectories', {
    params: {
      workDir,
      query,
      threadId,
      limit,
    },
  }).catch(() => null);
  if (backendResults && backendResults.length > 0) {
    return backendResults;
  }

  const entries = await listLearningTrajectories(workDir);
  const queryTokens = tokenizeForRecall(query);
  if (queryTokens.length === 0) return [];

  return entries
    .filter((entry) => entry.threadId !== threadId)
    .map((entry) => ({ entry, score: scoreTrajectoryEntry(entry, queryTokens) }))
    .filter((item) => item.score > 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.entry);
}

export async function buildRecallMemoryEntries(params: {
  workDir: string;
  query: string;
  threadId?: string;
}): Promise<LearningMemoryEntry[]> {
  const matches = await searchSessionRecall(params.workDir, params.query, params.threadId);
  return matches.map((entry) => ({
    content: `Past relevant work (${entry.title || 'untitled'}): ${entry.assistantSummary}`,
    createdAt: entry.createdAt,
    pinned: false,
  }));
}

export async function buildLearningContext(params: {
  workDir: string;
  query: string;
  threadId?: string;
}): Promise<LearningContextResult> {
  const backendBundle = await searchAllLearning(params);
  if (backendBundle) {
    return {
      memories: dedupeLearningMemories([
        ...backendBundle.memories.map((entry) => ({
          content: `Durable memory (${entry.source || 'manual'}): ${entry.content}`,
          createdAt: entry.createdAt,
          pinned: entry.pinned,
        })),
        ...backendBundle.sessions.map((entry) => ({
          content: `Past relevant work (${entry.title || 'untitled'}): ${entry.assistantSummary}`,
          createdAt: entry.createdAt,
          pinned: false,
        })),
        ...backendBundle.trajectories.map((entry) => ({
          content: `Past successful trajectory (${entry.title || 'untitled'}): ${summarizeTrajectory(entry)}`,
          createdAt: entry.createdAt,
          pinned: false,
        })),
      ]),
      skills: dedupeLearnedSkills(backendBundle.skills, SKILL_RECALL_LIMIT),
      sources: backendBundle.sources,
    };
  }

  const [sessionMatches, trajectoryMatches, relevantSkills, durableMemories] = await Promise.all([
    searchSessionRecall(params.workDir, params.query, params.threadId),
    searchTrajectoryRecall(params.workDir, params.query, params.threadId),
    searchRelevantSkills(params.workDir, params.query),
    searchDurableMemories(params.workDir, params.query),
  ]);
  const queryTokens = tokenizeForRecall(params.query);

  const sessionMemories = sessionMatches.map((entry) => ({
    content: `Past relevant work (${entry.title || 'untitled'}): ${entry.assistantSummary}`,
    createdAt: entry.createdAt,
    pinned: false,
  }));

  const trajectoryMemories = trajectoryMatches.map((entry) => ({
    content: `Past successful trajectory (${entry.title || 'untitled'}): ${summarizeTrajectory(entry)}`,
    createdAt: entry.createdAt,
    pinned: false,
  }));

  const recalledDurableMemories = durableMemories
    .map((entry) => {
      const haystack = `${entry.content} ${entry.source || ''}`.toLowerCase();
      let score = entry.pinned ? 4 : 0;
      for (const token of queryTokens) {
        if (haystack.includes(token)) score += 3;
      }
      return { entry, score };
    })
    .filter((item) => item.entry.pinned || item.score > 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((item) => ({
      content: `Durable memory (${item.entry.source || 'manual'}): ${item.entry.content}`,
      createdAt: item.entry.createdAt,
      pinned: item.entry.pinned,
    }));

  const sources = [
    ...(recalledDurableMemories.length ? [`memory:${recalledDurableMemories.length}`] : []),
    ...(sessionMatches.length ? [`session:${sessionMatches.length}`] : []),
    ...(trajectoryMatches.length ? [`trajectory:${trajectoryMatches.length}`] : []),
    ...(relevantSkills.length ? [`skill:${relevantSkills.length}`] : []),
  ];

  return {
    memories: dedupeLearningMemories([...recalledDurableMemories, ...sessionMemories, ...trajectoryMemories]),
    skills: dedupeLearnedSkills(relevantSkills, SKILL_RECALL_LIMIT),
    sources,
  };
}

function stripFence(text: string): string {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJsonObject(text: string): string | null {
  const raw = stripFence(text);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function normalizeReview(raw: unknown, provider: CliProvider, threadTitle?: string): LearningReviewResult {
  const parsed = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const memories = Array.isArray(parsed.memories)
    ? parsed.memories
      .filter((item): item is string => typeof item === 'string')
      .map((content) => ({ content: content.trim(), createdAt: Date.now() }))
      .filter((item) => item.content.length >= 12)
      .slice(0, 4)
    : [];

  const skills = Array.isArray(parsed.skills)
    ? parsed.skills
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => {
        const name = String(item.name || '').trim();
        const description = String(item.description || '').trim();
        const procedure = String(item.procedure || item.command || '').trim();
        if (!name || !description || !procedure) return null;
        return {
          id: '',
          name,
          description,
          command: procedure,
          cliType: provider,
          category: 'self-improving',
          sourceThread: threadTitle,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as LearnedSkillEntry;
      })
      .filter(Boolean)
      .slice(0, 3) as LearnedSkillEntry[]
    : [];

  return {
    memories,
    skills,
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined,
  };
}

export async function runBackgroundLearningReview(params: {
  provider: CliProvider;
  workDir: string;
  threadTitle?: string;
  userMessage: string;
  assistantContent: string;
  threadMessages: Array<{ role: 'human' | 'assistant' | 'tool' | 'system'; content: string }>;
  timeoutSecs: number;
  loadedSkillNames?: string[];
}): Promise<LearningReviewResult | undefined> {
  const transcript = params.threadMessages
    .slice(-8)
    .map((message) => `${message.role.toUpperCase()}: ${message.content.slice(0, 1200)}`)
    .join('\n\n');
  const prompt = buildBackgroundReviewPrompt({
    threadTitle: params.threadTitle,
    userMessage: params.userMessage,
    assistantContent: params.assistantContent,
    transcript,
    loadedSkillNames: params.loadedSkillNames,
  });

  try {
    const raw = await runCliPrompt(params.provider, prompt, params.workDir, params.timeoutSecs);
    const jsonText = extractJsonObject(raw);
    if (!jsonText) return undefined;
    const review = normalizeReview(JSON.parse(jsonText), params.provider, params.threadTitle);
    if (review.skills.length > 0) {
      await upsertLearnedSkills(params.workDir, review.skills);
    }
    return review;
  } catch {
    return undefined;
  }
}

// Fire-and-forget 코딩비서 review: runs the strict-JSON review off the
// foreground turn and reports the "💾" summary to the wired channels.
export function spawnBackgroundLearningReview(params: {
  provider: CliProvider;
  workDir: string;
  threadTitle?: string;
  userMessage: string;
  assistantContent: string;
  threadMessages: Array<{ role: 'human' | 'assistant' | 'tool' | 'system'; content: string }>;
  timeoutSecs: number;
  loadedSkillNames?: string[];
  channels?: BackgroundReviewChannel[];
  onReview?: (review: LearningReviewResult, summary: BackgroundReviewSummary) => void | Promise<void>;
  onError?: (err: unknown) => void;
}): void {
  spawnBackgroundReview({
    runReview: () =>
      runBackgroundLearningReview({
        provider: params.provider,
        workDir: params.workDir,
        threadTitle: params.threadTitle,
        userMessage: params.userMessage,
        assistantContent: params.assistantContent,
        threadMessages: params.threadMessages,
        timeoutSecs: params.timeoutSecs,
        loadedSkillNames: params.loadedSkillNames,
      }),
    channels: params.channels,
    onReview: params.onReview,
    onError: params.onError,
  });
}
