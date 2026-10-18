/**
 * KV-backed CheckpointSaver for LangGraph.
 *
 * Persists StateGraph checkpoints into an async key-value store so agent
 * sessions can resume across process restarts. The production adapter uses
 * BBARIT's KV store (`src/hooks/useKV.ts`); tests inject an in-memory Map.
 *
 * Schema (all strings):
 *   <prefix>:idx:<thread_id>                        → JSON array of checkpoint IDs (newest first)
 *   <prefix>:ck:<thread_id>:<checkpoint_id>         → JSON { checkpoint, metadata, parentCheckpointId }
 *   <prefix>:w:<thread_id>:<checkpoint_id>:<taskId> → JSON writes payload
 */
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type CheckpointListOptions,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';

export interface KvAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory adapter useful for tests or anonymous sessions. */
export class InMemoryKvAdapter implements KvAdapter {
  private store = new Map<string, string>();
  async get(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  async set(key: string, value: string) { this.store.set(key, value); }
  async delete(key: string) { this.store.delete(key); }
}

function getThreadId(config: RunnableConfig): string {
  const tid = (config.configurable as any)?.thread_id;
  if (!tid) throw new Error('[KvCheckpointSaver] missing thread_id in configurable');
  return String(tid);
}

function getCheckpointNs(config: RunnableConfig): string {
  return String((config.configurable as any)?.checkpoint_ns ?? '');
}

interface StoredCheckpoint {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  checkpoint: Checkpoint;
  metadata: CheckpointMetadata;
}

export class KvCheckpointSaver extends BaseCheckpointSaver {
  readonly kv: KvAdapter;
  readonly prefix: string;

  constructor(kv: KvAdapter, prefix = 'octo-lg-ckpt') {
    super();
    this.kv = kv;
    this.prefix = prefix;
  }

  private ckKey(threadId: string, ns: string, ckId: string) {
    return `${this.prefix}:ck:${threadId}:${ns}:${ckId}`;
  }
  private idxKey(threadId: string, ns: string) {
    return `${this.prefix}:idx:${threadId}:${ns}`;
  }
  private wKey(threadId: string, ns: string, ckId: string, taskId: string) {
    return `${this.prefix}:w:${threadId}:${ns}:${ckId}:${taskId}`;
  }

  private async loadIndex(threadId: string, ns: string): Promise<string[]> {
    const raw = await this.kv.get(this.idxKey(threadId, ns));
    if (!raw) return [];
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  }

  private async saveIndex(threadId: string, ns: string, ids: string[]): Promise<void> {
    await this.kv.set(this.idxKey(threadId, ns), JSON.stringify(ids));
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = getThreadId(config);
    const ns = getCheckpointNs(config);
    const requested = (config.configurable as any)?.checkpoint_id as string | undefined;
    let targetId = requested;
    if (!targetId) {
      const idx = await this.loadIndex(threadId, ns);
      if (idx.length === 0) return undefined;
      targetId = idx[0];
    }
    const raw = await this.kv.get(this.ckKey(threadId, ns, targetId));
    if (!raw) return undefined;
    let stored: StoredCheckpoint;
    try { stored = JSON.parse(raw) as StoredCheckpoint; } catch { return undefined; }
    return {
      config: {
        configurable: {
          thread_id: stored.thread_id,
          checkpoint_ns: stored.checkpoint_ns,
          checkpoint_id: stored.checkpoint_id,
        },
      },
      checkpoint: stored.checkpoint,
      metadata: stored.metadata,
      parentConfig: stored.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: stored.thread_id,
              checkpoint_ns: stored.checkpoint_ns,
              checkpoint_id: stored.parent_checkpoint_id,
            },
          }
        : undefined,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = getThreadId(config);
    const ns = getCheckpointNs(config);
    const idx = await this.loadIndex(threadId, ns);
    let count = 0;
    const limit = options?.limit ?? Infinity;
    for (const ckId of idx) {
      if (count >= limit) break;
      const raw = await this.kv.get(this.ckKey(threadId, ns, ckId));
      if (!raw) continue;
      let stored: StoredCheckpoint;
      try { stored = JSON.parse(raw) as StoredCheckpoint; } catch { continue; }
      yield {
        config: {
          configurable: {
            thread_id: stored.thread_id,
            checkpoint_ns: stored.checkpoint_ns,
            checkpoint_id: stored.checkpoint_id,
          },
        },
        checkpoint: stored.checkpoint,
        metadata: stored.metadata,
        parentConfig: stored.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: stored.thread_id,
                checkpoint_ns: stored.checkpoint_ns,
                checkpoint_id: stored.parent_checkpoint_id,
              },
            }
          : undefined,
      };
      count++;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const threadId = getThreadId(config);
    const ns = getCheckpointNs(config);
    const ckId = checkpoint.id;
    const parentCheckpointId = (config.configurable as any)?.checkpoint_id as string | undefined;

    const stored: StoredCheckpoint = {
      thread_id: threadId,
      checkpoint_ns: ns,
      checkpoint_id: ckId,
      parent_checkpoint_id: parentCheckpointId,
      checkpoint,
      metadata,
    };
    await this.kv.set(this.ckKey(threadId, ns, ckId), JSON.stringify(stored));
    // Prepend to index (newest first)
    const idx = await this.loadIndex(threadId, ns);
    const deduped = [ckId, ...idx.filter((x) => x !== ckId)];
    await this.saveIndex(threadId, ns, deduped);
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: ckId,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const threadId = getThreadId(config);
    const ns = getCheckpointNs(config);
    const ckId = (config.configurable as any)?.checkpoint_id as string | undefined;
    if (!ckId) return;
    await this.kv.set(this.wKey(threadId, ns, ckId, taskId), JSON.stringify(writes));
  }

  /** Remove all checkpoints for a thread (useful when resetting a session). */
  async deleteThread(threadId: string, ns: string = ''): Promise<void> {
    const idx = await this.loadIndex(threadId, ns);
    for (const ckId of idx) {
      await this.kv.delete(this.ckKey(threadId, ns, ckId));
    }
    await this.kv.delete(this.idxKey(threadId, ns));
  }
}

/**
 * Production KV adapter using BBARIT's async KV store.
 * Keep imports dynamic so tests don't pull Tauri-bound modules.
 */
export async function makeBbaritKvAdapter(): Promise<KvAdapter> {
  const { kvGet, kvSet, kvDelete } = await import('../../hooks/useKV');
  return {
    async get(key) { return await kvGet(key); },
    async set(key, value) { await kvSet(key, value); },
    async delete(key) { await kvDelete(key); },
  };
}
