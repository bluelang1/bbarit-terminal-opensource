import { invoke } from '@tauri-apps/api/core';
import { runCliPrompt, type CliProvider } from './cliRuntime';
import { loadDurableMemories, loadLearnedSkills, type LearnedSkillEntry, type LearningDatagenBundle, type LearningDatagenCase, type LearningEvalBundle, type LearningEvalCase, type LearningExportBundle, type LearningTrajectoryEntry, type SessionIndexEntry } from './learningRuntime';

export async function appendLearningTrajectory(entry: LearningTrajectoryEntry): Promise<void> {
  await invoke('db_learning_append_trajectory', { entry }).catch(() => {});
}

export async function listLearningTrajectories(workDir: string): Promise<LearningTrajectoryEntry[]> {
  return invoke<LearningTrajectoryEntry[]>('db_learning_list_trajectories', { workDir }).catch(() => []);
}

export async function recordSessionEntry(
  workDir: string,
  entry: SessionIndexEntry,
): Promise<void> {
  await invoke('db_learning_upsert_session', {
    entry: { ...entry, workDir },
  }).catch(() => {});
}

export async function listSessionEntries(workDir: string): Promise<SessionIndexEntry[]> {
  return invoke<SessionIndexEntry[]>('db_learning_list_sessions', { workDir }).catch(() => []);
}

export async function exportLearningBundle(workDir: string): Promise<{ path: string; bundle: LearningExportBundle }> {
  const [memories, skills, sessions, trajectories] = await Promise.all([
    loadDurableMemories(workDir),
    loadLearnedSkills(workDir),
    listSessionEntries(workDir),
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

function summarizeTrajectoryForEval(entry: LearningTrajectoryEntry): string {
  const compact = `${entry.reviewJson || ''}\n${entry.messagesJson || ''}`
    .replace(/\s+/g, ' ')
    .trim();
  return compact.slice(0, 1400);
}

function buildSessionEvalCase(entry: SessionIndexEntry): LearningEvalCase {
  return {
    id: `session-${entry.id}`,
    kind: 'session-replay',
    title: entry.title || 'Untitled session',
    prompt: entry.userMessage,
    expectedSummary: entry.assistantSummary,
    workDir: entry.workDir,
    metadata: {
      threadId: entry.threadId,
      mode: entry.mode,
      provider: entry.provider,
      createdAt: entry.createdAt,
      savedFiles: entry.savedFiles,
      toolNames: entry.toolNames,
      artifactNames: entry.artifactNames,
    },
  };
}

function buildTrajectoryEvalCase(entry: LearningTrajectoryEntry): LearningEvalCase {
  return {
    id: `trajectory-${entry.id}`,
    kind: 'trajectory-replay',
    title: entry.title || 'Untitled trajectory',
    prompt: `Replay the intent and successful pattern from this prior execution.\n\n${summarizeTrajectoryForEval(entry)}`,
    expectedSummary: entry.reviewJson || entry.messagesJson.slice(0, 1400),
    workDir: entry.workDir,
    metadata: {
      threadId: entry.threadId,
      mode: entry.mode,
      provider: entry.provider,
      createdAt: entry.createdAt,
    },
  };
}

export async function exportLearningEvalBundle(workDir: string): Promise<{ path: string; bundle: LearningEvalBundle }> {
  const [sessions, trajectories] = await Promise.all([
    listSessionEntries(workDir),
    listLearningTrajectories(workDir),
  ]);

  const cases: LearningEvalCase[] = [
    ...sessions.slice(0, 80).map(buildSessionEvalCase),
    ...trajectories.slice(0, 80).map(buildTrajectoryEvalCase),
  ];

  const bundle: LearningEvalBundle = {
    exportedAt: Date.now(),
    workDir,
    cases,
  };

  const path = `${workDir.replace(/[\\\/]+$/, '')}/.octo-learning-eval.json`;
  await invoke('write_file', { path, content: JSON.stringify(bundle, null, 2) });
  return { path, bundle };
}

function buildSessionDatagenCase(entry: SessionIndexEntry): LearningDatagenCase {
  return {
    id: `session-sft-${entry.id}`,
    kind: 'session-sft',
    system: 'You are Coding Secretary. Produce a concise, useful implementation response in plain language.',
    instruction: entry.userMessage,
    response: entry.assistantSummary,
    workDir: entry.workDir,
    metadata: {
      sourceId: entry.id,
      threadId: entry.threadId,
      title: entry.title,
      mode: entry.mode,
      provider: entry.provider,
      createdAt: entry.createdAt,
      toolNames: entry.toolNames,
      savedFiles: entry.savedFiles,
      artifactNames: entry.artifactNames,
    },
  };
}

function buildTrajectoryDatagenCase(entry: LearningTrajectoryEntry): LearningDatagenCase {
  return {
    id: `trajectory-sft-${entry.id}`,
    kind: 'trajectory-sft',
    system: 'You are Coding Secretary. Follow the successful prior execution pattern and summarize the implementation path in plain language.',
    instruction: [
      'Replay the successful execution pattern from this prior run.',
      `Mode: ${entry.mode}`,
      `Provider: ${entry.provider}`,
      '',
      entry.messagesJson.slice(0, 3000),
    ].join('\n'),
    response: String(entry.reviewJson || entry.messagesJson).slice(0, 3000),
    workDir: entry.workDir,
    metadata: {
      sourceId: entry.id,
      threadId: entry.threadId,
      title: entry.title,
      mode: entry.mode,
      provider: entry.provider,
      createdAt: entry.createdAt,
    },
  };
}

function buildSkillDatagenCase(skill: LearnedSkillEntry, workDir: string): LearningDatagenCase {
  return {
    id: `skill-sft-${skill.id}`,
    kind: 'skill-sft',
    system: 'You are Coding Secretary. Apply the stored learned procedure faithfully and explain outcomes in plain language.',
    instruction: `Use the learned skill "${skill.name}" for a matching task.\n\nDescription: ${skill.description}`,
    response: skill.command,
    workDir,
    metadata: {
      sourceId: skill.id,
      title: skill.name,
      provider: skill.cliType,
      createdAt: skill.createdAt,
      skillName: skill.name,
    },
  };
}

export async function exportLearningDatagenBundle(workDir: string): Promise<{ path: string; bundle: LearningDatagenBundle }> {
  const [sessions, trajectories, skills] = await Promise.all([
    listSessionEntries(workDir),
    listLearningTrajectories(workDir),
    loadLearnedSkills(workDir),
  ]);

  const bundle: LearningDatagenBundle = {
    exportedAt: Date.now(),
    workDir,
    cases: [
      ...sessions.slice(0, 120).map(buildSessionDatagenCase),
      ...trajectories.slice(0, 120).map(buildTrajectoryDatagenCase),
      ...skills.slice(0, 80).map((skill) => buildSkillDatagenCase(skill, workDir)),
    ],
  };

  const path = `${workDir.replace(/[\\\/]+$/, '')}/.octo-learning-datagen.json`;
  await invoke('write_file', { path, content: JSON.stringify(bundle, null, 2) });
  return { path, bundle };
}

export interface LearningEvalRunCaseResult {
  id: string;
  kind: LearningEvalCase['kind'];
  title: string;
  score: number;
  passed: boolean;
  outputSummary: string;
  expectedSummary: string;
}

export interface LearningEvalRunReport {
  evaluatedAt: number;
  workDir: string;
  provider: CliProvider;
  caseCount: number;
  averageScore: number;
  passedCount: number;
  results: LearningEvalRunCaseResult[];
}

function tokenizeEvalText(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_가-힣]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function scoreEvalCase(outputSummary: string, expectedSummary: string): number {
  const outputTokens = new Set(tokenizeEvalText(outputSummary));
  const expectedTokens = Array.from(new Set(tokenizeEvalText(expectedSummary)));
  if (expectedTokens.length === 0) return outputSummary.trim().length > 0 ? 0.6 : 0;
  let matched = 0;
  for (const token of expectedTokens) {
    if (outputTokens.has(token)) matched += 1;
  }
  return Math.max(0, Math.min(1, matched / expectedTokens.length));
}

async function runEvalCase(params: {
  provider: CliProvider;
  workDir: string;
  timeoutSecs: number;
  evalCase: LearningEvalCase;
}): Promise<LearningEvalRunCaseResult> {
  const prompt = [
    'You are replaying a prior Coding Secretary evaluation case.',
    'Read the prompt and produce a concise but faithful implementation summary.',
    'Return plain text only.',
    '',
    `Case kind: ${params.evalCase.kind}`,
    `Title: ${params.evalCase.title}`,
    '',
    'Prompt:',
    params.evalCase.prompt,
  ].join('\n');

  let outputSummary = '';
  try {
    const raw = await runCliPrompt(params.provider, prompt, params.workDir, params.timeoutSecs);
    outputSummary = String(raw || '').trim().slice(0, 2000);
  } catch (error) {
    outputSummary = `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
  }

  const score = scoreEvalCase(outputSummary, params.evalCase.expectedSummary);
  return {
    id: params.evalCase.id,
    kind: params.evalCase.kind,
    title: params.evalCase.title,
    score,
    passed: score >= 0.35,
    outputSummary,
    expectedSummary: params.evalCase.expectedSummary.slice(0, 1600),
  };
}

export async function runLearningEvalBundle(params: {
  workDir: string;
  provider: CliProvider;
  timeoutSecs?: number;
  limit?: number;
}): Promise<{ path: string; report: LearningEvalRunReport }> {
  const evalPath = `${params.workDir.replace(/[\\\/]+$/, '')}/.octo-learning-eval.json`;
  let bundle: LearningEvalBundle | null = null;
  try {
    const raw = await invoke<string>('read_file', { path: evalPath });
    bundle = JSON.parse(raw) as LearningEvalBundle;
  } catch {
    bundle = (await exportLearningEvalBundle(params.workDir)).bundle;
  }

  const timeoutSecs = params.timeoutSecs ?? 45;
  const cases = Array.isArray(bundle?.cases) ? bundle!.cases.slice(0, Math.max(1, params.limit ?? 5)) : [];
  const results: LearningEvalRunCaseResult[] = [];
  for (const evalCase of cases) {
    results.push(await runEvalCase({
      provider: params.provider,
      workDir: params.workDir,
      timeoutSecs,
      evalCase,
    }));
  }

  const averageScore = results.length
    ? results.reduce((sum, item) => sum + item.score, 0) / results.length
    : 0;
  const report: LearningEvalRunReport = {
    evaluatedAt: Date.now(),
    workDir: params.workDir,
    provider: params.provider,
    caseCount: results.length,
    averageScore,
    passedCount: results.filter((item) => item.passed).length,
    results,
  };

  const reportPath = `${params.workDir.replace(/[\\\/]+$/, '')}/.octo-learning-eval-report.json`;
  await invoke('write_file', { path: reportPath, content: JSON.stringify(report, null, 2) });
  return { path: reportPath, report };
}
