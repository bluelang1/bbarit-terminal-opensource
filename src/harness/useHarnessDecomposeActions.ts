import { useCallback } from 'react';
import type { ChatMessage, ChatThread, SubTask } from './panelTypes';
import type { HarnessAgentLoopOutcome } from './agentLoopRunner';
import {
  beginHarnessStreamingState,
  finishHarnessStreamingState,
} from './turnControllerState';
import { estimateTokenUsage } from './tokenUsage';
import type { HarnessTurnControllerParams, PendingDecomposeTask } from './turnControllerTypes';

interface HarnessDecomposeActionsParams extends Pick<
  HarnessTurnControllerParams,
  | 'activeThreadId'
  | 'pendingMsgRef'
  | 'setPendingDecompose'
  | 'setIsStreaming'
  | 'streamingThreadIdRef'
  | 'threadsRef'
  | 'harnessRuntime'
  | 'ensureCliProvider'
  | 'provider'
  | 'workDir'
  | 'executionProfile'
  | 'setSubTasks'
  | 'setStreamingContent'
  | 'mode'
  | 'genId'
  | 'setError'
> {
  applyAgentLoopOutcome: (params: {
    threadId: string;
    outcome: HarnessAgentLoopOutcome;
  }) => void;
}

export function useHarnessDecomposeActions(params: HarnessDecomposeActionsParams) {
  const executeDecomposed = useCallback(async (tasks: PendingDecomposeTask[]) => {
    const msgText = params.pendingMsgRef.current;
    const threadId = params.activeThreadId;

    params.setPendingDecompose(null);

    if (!threadId) return;

    beginHarnessStreamingState({
      threadId,
      streamingThreadIdRef: params.streamingThreadIdRef,
      setIsStreaming: params.setIsStreaming,
      setStreamingContent: params.setStreamingContent,
      setSubTasks: params.setSubTasks,
    });

    try {
      const threadBefore = params.threadsRef.current.find((candidate) => candidate.id === threadId);
      if (!threadBefore) throw new Error('Missing sub-agent thread.');

      const outcome = await params.harnessRuntime.agentLoop.runTurn({
        kind: 'subagent',
        executeSubAgents: () => params.harnessRuntime.sessions.executeDecomposedSubAgents({
          userMessage: msgText,
          selectedTasks: tasks.map((task) => ({
            ...task,
            provider: params.ensureCliProvider(task.provider),
          })),
          workDir: params.workDir,
          synthesisProvider: params.ensureCliProvider(params.provider),
          executionProfile: params.executionProfile,
          threadSummary: threadBefore.summary,
          onPipelineUpdate: (pipeline) => params.setSubTasks(pipeline as unknown as SubTask[]),
          onStreamingContent: params.setStreamingContent,
        }),
        workDir: params.workDir,
        mode: params.mode,
        provider: params.provider,
        threadBefore,
        userMessage: msgText,
        summaryTimeoutSecs: params.executionProfile.summaryTimeoutSecs,
        defaultFollowupProvider: params.ensureCliProvider(params.provider),
        appendAssistantMessage: (result) => {
          const assistantMessage: ChatMessage = {
            id: params.genId(),
            role: 'assistant',
            content: result.mainContent,
            artifacts: result.artifacts,
            timestamp: Date.now(),
            durationMs: result.durationMs,
            tokenUsage: estimateTokenUsage({
              promptText: msgText,
              completionText: result.mainContent,
              warning: 'Sub-agent token usage is estimated from the final synthesis; individual CLI/API usage was not reported.',
            }),
          };

          return params.harnessRuntime.thread.appendAssistantMessageToThread(
            threadBefore,
            assistantMessage,
          ) as ChatThread;
        },
      });

      if (!outcome) {
        throw new Error('Sub-agent turn returned no outcome.');
      }

      params.applyAgentLoopOutcome({ threadId, outcome });
    } catch (error) {
      params.setError(String(error));
    }

    finishHarnessStreamingState({
      setIsStreaming: params.setIsStreaming,
      setStreamingContent: params.setStreamingContent,
      setStreamingThinking: undefined,
    });
  }, [params]);

  return {
    executeDecomposed,
  };
}
