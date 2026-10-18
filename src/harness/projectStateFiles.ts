import { invoke } from '@tauri-apps/api/core';
import type { ChatThread } from './panelTypes';

export interface HarnessProjectStateSummary {
  updatedAt: number;
  threads: Array<{
    id: string;
    title: string;
    status?: NonNullable<ChatThread['runState']>['status'];
    provider?: ChatThread['provider'];
    mode?: ChatThread['mode'];
    targetProjectName?: string;
    targetWorkDir?: string;
    startedAt?: number;
    updatedAt?: number;
    completedAt?: number;
    error?: string;
  }>;
}

function normalizeWorkDir(workDir: string): string {
  return String(workDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function stateDir(workDir: string): string {
  return `${normalizeWorkDir(workDir)}/.bbarit/coding-secretary/state`;
}

function safeName(value: string): string {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  if (dir) await invoke('create_directory', { path: dir }).catch(() => {});
  await invoke('write_file', { path, content: JSON.stringify(value, null, 2) });
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await invoke<string>('read_file', { path });
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function persistHarnessProjectState(workDir: string, threads: ChatThread[]): Promise<void> {
  const root = stateDir(workDir);
  const summaries = threads.map((thread) => ({
    id: thread.id,
    title: thread.title,
    status: thread.runState?.status,
    provider: thread.provider,
    mode: thread.mode,
    targetProjectName: thread.runState?.targetProjectName || thread.targetProjectName,
    targetWorkDir: thread.runState?.targetWorkDir || thread.targetWorkDir,
    startedAt: thread.runState?.startedAt,
    updatedAt: thread.runState?.updatedAt,
    completedAt: thread.runState?.completedAt,
    error: thread.runState?.error,
  }));

  const index: HarnessProjectStateSummary = {
    updatedAt: Date.now(),
    threads: summaries,
  };

  await writeJson(`${root}/index.json`, index);
  await Promise.all(threads.map((thread) => writeJson(`${root}/threads/${safeName(thread.id)}.json`, {
    ...thread,
    persistedAt: Date.now(),
  })));
}

export async function loadHarnessProjectState(workDir: string): Promise<ChatThread[]> {
  if (!workDir || workDir.startsWith('ssh://')) return [];
  const root = stateDir(workDir);
  const index = await readJson<HarnessProjectStateSummary>(`${root}/index.json`);
  if (!index?.threads?.length) return [];

  const loaded = await Promise.all(index.threads.map(async (summary) => {
    const thread = await readJson<ChatThread>(`${root}/threads/${safeName(summary.id)}.json`);
    return thread;
  }));

  return loaded
    .filter((thread): thread is ChatThread => Boolean(thread?.id))
    .sort((a, b) => (b.messages?.[b.messages.length - 1]?.timestamp || b.createdAt || 0) - (a.messages?.[a.messages.length - 1]?.timestamp || a.createdAt || 0));
}

export async function clearHarnessProjectState(workDir: string): Promise<void> {
  if (!workDir || workDir.startsWith('ssh://')) return;
  await invoke('delete_path', { path: stateDir(workDir) }).catch(() => {});
}
