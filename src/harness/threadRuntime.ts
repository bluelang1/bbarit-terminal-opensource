export interface PersistableThread<TMessage = unknown> {
  messages: TMessage[];
}

export interface HarnessStorageKeys {
  stateKey: string;
  memoryKey: string;
  workflowKey: string;
}

export function buildHarnessStorageKeys(prefix: string, workDir: string): HarnessStorageKeys {
  return {
    stateKey: `${prefix}:${workDir}`,
    memoryKey: `${prefix}-memory:${workDir}`,
    workflowKey: `${prefix}-workflow:${workDir}`,
  };
}

export function parsePersistedValue<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function snapshotThreadsForPersistence<T extends PersistableThread>(
  threads: T[],
  maxMessages = 100,
): T[] {
  return (threads || []).map(thread => ({
    ...thread,
    messages: (thread.messages || []).slice(-maxMessages),
  }));
}

export function snapshotMemoriesForPersistence<T>(memories: T[], maxItems = 50): T[] {
  return (memories || []).slice(-maxItems);
}
