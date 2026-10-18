import { loadDurableMemories, saveDurableMemories, type LearningMemoryEntry } from './learningRuntime';
import type { LearnedSkillEntry, LearningContextResult } from './learningRuntime';
import { gatherLearningContext, type LearningProvider, type LearningProviderContextRequest, type LearningProviderRegistry } from './learningProviders';

export class LearningMemoryManager {
  private readonly workDir: string;
  private readonly providers: LearningProvider[];

  constructor(workDir: string, providersOrRegistry: LearningProvider[] | LearningProviderRegistry) {
    this.workDir = workDir;
    this.providers = Array.isArray(providersOrRegistry)
      ? providersOrRegistry
      : providersOrRegistry.listProviders();
  }

  async initialize(): Promise<void> {
    for (const provider of this.providers) {
      await provider.initialize?.(this.workDir);
    }
  }

  async prefetch(request: Omit<LearningProviderContextRequest, 'workDir'>): Promise<LearningContextResult> {
    return gatherLearningContext({
      ...request,
      workDir: this.workDir,
    }, this.providers);
  }

  async loadDurableMemories(): Promise<LearningMemoryEntry[]> {
    return loadDurableMemories(this.workDir);
  }

  async persistDurableMemories(memories: LearningMemoryEntry[]): Promise<void> {
    await saveDurableMemories(this.workDir, memories);
  }

  async syncTurn(params: {
    userMessage: string;
    assistantMessage: string;
    memories?: LearningMemoryEntry[];
    skills?: LearnedSkillEntry[];
  }): Promise<void> {
    for (const provider of this.providers) {
      await provider.syncTurn?.({
        workDir: this.workDir,
        ...params,
      });
    }
    if (params.memories?.length) {
      await this.persistDurableMemories(params.memories);
    }
  }

  async shutdown(): Promise<void> {
    for (const provider of this.providers) {
      await provider.shutdown?.();
    }
  }
}

export function createLearningMemoryManager(
  workDir: string,
  providers: LearningProvider[] | LearningProviderRegistry,
): LearningMemoryManager {
  return new LearningMemoryManager(workDir, providers);
}
