import type { DirectResponseResult } from './responseExecutor';
import type { Artifact } from '../components/harness-utils';
import type { HarnessTokenUsage } from './tokenUsage';

export interface HarnessAssistantMessage {
  id: string;
  role: 'assistant';
  content: string;
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: string;
    result?: string;
    status: 'running' | 'done' | 'error';
  }>;
  artifacts?: Artifact[];
  images?: string[];
  timestamp: number;
  durationMs?: number;
  tokenUsage?: HarnessTokenUsage;
}

export interface DirectResponsePresentation {
  primaryMessage: HarnessAssistantMessage;
  postMessages: HarnessAssistantMessage[];
  primaryArtifact?: Artifact;
  memorySummary?: string;
  followupSource?: string;
  followupProvider?: DirectResponseResult['followupProvider'];
  todos: DirectResponseResult['todos'];
}

export interface SimpleAssistantPresentation {
  primaryMessage: HarnessAssistantMessage;
  primaryArtifact?: Artifact;
  followups?: string[];
  followupSource?: string;
  followupProvider?: DirectResponseResult['followupProvider'];
}

export function buildAssistantMessage(params: {
  id: string;
  content: string;
  timestamp: number;
  durationMs?: number;
  thinking?: string;
  toolCalls?: HarnessAssistantMessage['toolCalls'];
  artifacts?: Artifact[];
  images?: string[];
  tokenUsage?: HarnessTokenUsage;
}): HarnessAssistantMessage {
  return {
    id: params.id,
    role: 'assistant',
    content: params.content,
    thinking: params.thinking,
    toolCalls: params.toolCalls,
    artifacts: params.artifacts && params.artifacts.length > 0 ? params.artifacts : undefined,
    images: params.images && params.images.length > 0 ? params.images : undefined,
    timestamp: params.timestamp,
    durationMs: params.durationMs,
    tokenUsage: params.tokenUsage,
  };
}

export function presentDirectResponse(
  result: DirectResponseResult,
  createId: () => string,
  now: () => number = () => Date.now(),
): DirectResponsePresentation {
  return {
    primaryMessage: buildAssistantMessage({
      id: createId(),
      content: result.mainContent,
      thinking: result.thinking,
      toolCalls: result.toolCalls,
      artifacts: result.artifacts,
      timestamp: now(),
      durationMs: result.durationMs,
      tokenUsage: result.tokenUsage,
    }),
    postMessages: result.postMessages.map((message) =>
      buildAssistantMessage({
        id: createId(),
        content: message.content,
        artifacts: message.artifacts,
        timestamp: now(),
      }),
    ),
    primaryArtifact: result.artifacts[0],
    memorySummary: result.memorySummary,
    followupSource: result.followupSource,
    followupProvider: result.followupProvider,
    todos: result.todos,
  };
}

export function presentSimpleAssistantResponse(params: {
  content: string;
  createId: () => string;
  timestamp?: number;
  durationMs?: number;
  artifacts?: Artifact[];
  images?: string[];
  followups?: string[];
  followupSource?: string;
  followupProvider?: DirectResponseResult['followupProvider'];
  tokenUsage?: HarnessTokenUsage;
}): SimpleAssistantPresentation {
  const primaryArtifact = params.artifacts?.[0];
  return {
    primaryMessage: buildAssistantMessage({
      id: params.createId(),
      content: params.content,
      artifacts: params.artifacts,
      images: params.images,
      timestamp: params.timestamp ?? Date.now(),
      durationMs: params.durationMs,
      tokenUsage: params.tokenUsage,
    }),
    primaryArtifact,
    followups: params.followups,
    followupSource: params.followupSource,
    followupProvider: params.followupProvider,
  };
}
