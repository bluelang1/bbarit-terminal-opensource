import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { HarnessRuntime } from './runtimeFactory';
import type {
  AgentMode,
  AiProvider,
  ChatThread,
  MemoryEntry,
} from './panelTypes';
import type { WorkflowConfig } from './workflow';
import { normalizeWorkflowConfig, normalizeWorkflowProvider } from './workflow';
import type { HarnessResponseLanguage } from './prompting';
import { loadHarnessProjectState } from './projectStateFiles';

interface HarnessPersistenceParams {
  storageKey: string;
  memoryKey: string;
  workflowKey: string;
  languageKey: string;
  workDir: string;
  projectStateWorkDirs?: string[];
  threads: ChatThread[];
  activeThreadId: string | null;
  mode: AgentMode;
  provider: AiProvider;
  backgroundProvider: AiProvider;
  responseLanguage: HarnessResponseLanguage;
  memories: MemoryEntry[];
  workflow: WorkflowConfig;
  harnessRuntime: Pick<HarnessRuntime, 'storage' | 'selfImproving'>;
  kvGet: (key: string) => Promise<string | null>;
  kvSet: (key: string, value: string) => Promise<void>;
  setThreads: Dispatch<SetStateAction<ChatThread[]>>;
  setActiveThreadId: Dispatch<SetStateAction<string | null>>;
  setMode: Dispatch<SetStateAction<AgentMode>>;
  setProvider?: Dispatch<SetStateAction<AiProvider>>;
  setBackgroundProvider: Dispatch<SetStateAction<AiProvider>>;
  setResponseLanguage: Dispatch<SetStateAction<HarnessResponseLanguage>>;
  setMemories: Dispatch<SetStateAction<MemoryEntry[]>>;
  setWorkflow: Dispatch<SetStateAction<WorkflowConfig>>;
}

function buildConversationMemorySummary(threads: ChatThread[], maxThreads = 12): MemoryEntry[] {
  return [...threads]
    .sort((a, b) => (
      (b.messages?.[b.messages.length - 1]?.timestamp || b.createdAt || 0)
      - (a.messages?.[a.messages.length - 1]?.timestamp || a.createdAt || 0)
    ))
    .slice(0, maxThreads)
    .map((thread) => {
      const human = [...(thread.messages || [])].reverse().find(message => message.role === 'human')?.content || '';
      const assistant = [...(thread.messages || [])].reverse().find(message => message.role === 'assistant')?.content || '';
      const status = thread.runState?.status ? `상태: ${thread.runState.status}` : '';
      const project = thread.targetProjectName || thread.targetWorkDir || thread.title;
      const content = [
        `코린이모드 작업: ${thread.title}`,
        project ? `프로젝트: ${project}` : '',
        human ? `사용자 요청: ${human.slice(0, 260)}` : '',
        assistant ? `마지막 답변 요약: ${assistant.replace(/\s+/g, ' ').slice(0, 360)}` : '',
        status,
        thread.targetWorkDir ? `작업 위치: ${thread.targetWorkDir}` : '',
      ].filter(Boolean).join('\n');
      return {
        id: `conversation:${thread.id}`,
        content,
        source: 'conversation-history',
        createdAt: thread.messages?.[thread.messages.length - 1]?.timestamp || thread.createdAt || Date.now(),
        pinned: true,
      };
    });
}

const normalizeLoadedThreads = (threads: ChatThread[]): ChatThread[] => (
  threads.map(thread => {
    if (thread.runState?.status !== 'running') return thread;
    return {
      ...thread,
      runState: {
        ...thread.runState,
        status: 'stopped',
        completedAt: thread.runState.completedAt || Date.now(),
        error: thread.runState.error || '이전 실행이 앱 재시작 또는 연결 종료로 중단되었습니다.',
      },
    };
  })
);

export function useHarnessPersistence(params: HarnessPersistenceParams): void {
  const stateLoadKeyRef = useRef<string | null>(null);
  const workflowLoadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const loadKey = JSON.stringify([
      params.storageKey,
      params.languageKey,
      params.projectStateWorkDirs || [],
    ]);
    if (stateLoadKeyRef.current === loadKey) return;
    stateLoadKeyRef.current = loadKey;

    void (async () => {
      const [saved, savedLanguage] = await Promise.all([
        params.kvGet(params.storageKey),
        params.kvGet(params.languageKey),
      ]);
      const projectThreads = (await Promise.all(
        [...new Set(params.projectStateWorkDirs || [])].map(workDir => loadHarnessProjectState(workDir)),
      )).flat();
      if (projectThreads.length > 0) {
        const byId = new Map<string, ChatThread>();
        for (const thread of projectThreads) byId.set(thread.id, thread);
        if (saved) {
          const savedData = params.harnessRuntime.storage.parsePersistedValue<{ threads?: ChatThread[] }>(saved, {});
          for (const thread of savedData.threads || []) {
            if (!byId.has(thread.id)) byId.set(thread.id, thread);
          }
        }
        const threads = normalizeLoadedThreads([...byId.values()]).sort((a, b) => (
          (b.messages?.[b.messages.length - 1]?.timestamp || b.createdAt || 0)
          - (a.messages?.[a.messages.length - 1]?.timestamp || a.createdAt || 0)
        ));
        params.setThreads(threads);
        params.setActiveThreadId((current) => current || threads[0]?.id || null);
        params.setMode('coding');
        if (savedLanguage) params.setResponseLanguage(savedLanguage as HarnessResponseLanguage);
        return;
      }
      if (!saved) {
        params.setThreads([]);
        params.setActiveThreadId(null);
        params.setMode('coding');
        if (savedLanguage) params.setResponseLanguage(savedLanguage as HarnessResponseLanguage);
        return;
      }
      const data = params.harnessRuntime.storage.parsePersistedValue<{
        threads?: ChatThread[];
        activeThreadId?: string | null;
        provider?: AiProvider;
        backgroundProvider?: AiProvider;
        responseLanguage?: HarnessResponseLanguage;
      }>(saved, {});
      params.setThreads(normalizeLoadedThreads(data.threads || []));
      params.setActiveThreadId(data.activeThreadId || null);
      params.setMode('coding');
      params.setProvider?.(normalizeWorkflowProvider(data.provider) as AiProvider);
      params.setBackgroundProvider(normalizeWorkflowProvider(data.backgroundProvider) as AiProvider);
      if (data.responseLanguage || savedLanguage) {
        params.setResponseLanguage((data.responseLanguage || savedLanguage) as HarnessResponseLanguage);
      }
    })();
  }, [
    params.harnessRuntime.storage,
    params.kvGet,
    params.languageKey,
    params.projectStateWorkDirs,
    params.setActiveThreadId,
    params.setBackgroundProvider,
    params.setMode,
    params.setProvider,
    params.setResponseLanguage,
    params.setThreads,
    params.storageKey,
  ]);

  useEffect(() => {
    void (async () => {
      const durable = await params.harnessRuntime.selfImproving.loadDurableMemories(params.workDir);
      if (durable.length > 0) {
        params.setMemories(durable as MemoryEntry[]);
        return;
      }
      const saved = await params.kvGet(params.memoryKey);
      if (!saved) {
        params.setMemories([]);
        return;
      }
      params.setMemories(
        params.harnessRuntime.storage.parsePersistedValue(saved, [] as MemoryEntry[]),
      );
    })();
  }, [
    params.harnessRuntime.selfImproving,
    params.harnessRuntime.storage,
    params.kvGet,
    params.memoryKey,
    params.setMemories,
    params.workDir,
  ]);

  useEffect(() => {
    if (workflowLoadKeyRef.current === params.workflowKey) return;
    workflowLoadKeyRef.current = params.workflowKey;

    void (async () => {
      const saved = await params.kvGet(params.workflowKey);
      if (!saved) return;
      const parsed = params.harnessRuntime.storage.parsePersistedValue<WorkflowConfig | null>(saved, null);
      if (parsed?.stages?.length) params.setWorkflow(normalizeWorkflowConfig(parsed));
    })();
  }, [
    params.harnessRuntime.storage,
    params.kvGet,
    params.setWorkflow,
    params.workflowKey,
  ]);

  useEffect(() => {
    void params.kvSet(params.workflowKey, JSON.stringify(params.workflow));
  }, [params.kvSet, params.workflow, params.workflowKey]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void params.kvSet(params.storageKey, JSON.stringify({
        threads: params.harnessRuntime.storage.snapshotThreadsForPersistence(params.threads, 100),
        activeThreadId: params.activeThreadId,
        mode: params.mode,
        provider: params.provider,
        backgroundProvider: params.backgroundProvider,
        responseLanguage: params.responseLanguage,
      }));
      void params.kvSet(params.languageKey, params.responseLanguage);
    }, 500);
    return () => clearTimeout(timer);
  }, [
    params.activeThreadId,
    params.backgroundProvider,
    params.harnessRuntime.storage,
    params.kvSet,
    params.languageKey,
    params.mode,
    params.provider,
    params.responseLanguage,
    params.storageKey,
    params.threads,
  ]);

  useEffect(() => {
    void params.kvSet(
      params.memoryKey,
      JSON.stringify(params.harnessRuntime.storage.snapshotMemoriesForPersistence([
        ...params.memories.filter(memory => memory.source !== 'conversation-history'),
        ...buildConversationMemorySummary(params.threads),
      ], 80)),
    );
    void params.harnessRuntime.selfImproving.persistDurableMemories(params.workDir, [
      ...params.memories.filter(memory => memory.source !== 'conversation-history'),
      ...buildConversationMemorySummary(params.threads),
    ]);
  }, [
    params.harnessRuntime.selfImproving,
    params.harnessRuntime.storage,
    params.kvSet,
    params.memories,
    params.memoryKey,
    params.threads,
    params.workDir,
  ]);
}
