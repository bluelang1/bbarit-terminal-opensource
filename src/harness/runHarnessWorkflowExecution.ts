import type { SubTask } from './panelTypes';
import type { HarnessTurnControllerParams } from './turnControllerTypes';

interface RunHarnessWorkflowExecutionParams extends Pick<
  HarnessTurnControllerParams,
  | 'setIsStreaming'
  | 'streamingThreadIdRef'
  | 'uiText'
  | 'setStreamingContent'
  | 'setStreamingThinking'
  | 'setSubTasks'
  | 'abortRef'
  | 'threadsRef'
  | 'harnessRuntime'
  | 'workDir'
  | 'workflow'
  | 'executionProfile'
  | 'responseLanguage'
  | 'ensureCliProvider'
  | 'genId'
  | 'mode'
  | 'provider'
  | 'supportsWorkflowTimeoutFallback'
  | 'setError'
  | 'setShowWorkflowEditor'
  | 'setPendingWorkflowStart'
> {
  threadId: string;
  msgText: string;
  startTime: number;
  attachmentsSnapshot: HarnessTurnControllerParams['attachments'];
  applyAgentLoopOutcome: (params: {
    threadId: string;
    outcome: Exclude<
      Awaited<ReturnType<HarnessTurnControllerParams['harnessRuntime']['agentLoop']['runTurn']>>,
      null
    >;
  }) => void;
}

export async function runHarnessWorkflowExecution(
  params: RunHarnessWorkflowExecutionParams,
): Promise<void> {
  params.setIsStreaming(true);
  params.streamingThreadIdRef.current = params.threadId;
  params.setStreamingContent(params.uiText.codingStatus);
  params.setStreamingThinking('');
  params.setSubTasks([]);
  params.abortRef.current = false;

  try {
    const thread = params.threadsRef.current.find(
      (candidate) => candidate.id === params.threadId,
    );
    if (!thread) throw new Error('Missing workflow thread.');

    const outcome = await params.harnessRuntime.agentLoop.runTurn({
      kind: 'workflow',
      executePresentation: () => params.harnessRuntime.sessions.runWorkflowSessionStart({
        thread,
        threadId: params.threadId,
        msgText: params.msgText,
        startTime: params.startTime,
        attachments: params.attachmentsSnapshot,
        workDir: params.workDir,
        workflow: params.workflow,
        executionProfile: params.executionProfile,
        responseLanguage: params.responseLanguage,
        labels: {
          saved: params.uiText.saved,
          files: params.uiText.files,
        },
        ensureCliProvider: params.ensureCliProvider,
        onStreamingContent: params.setStreamingContent,
        onPipelineUpdate: (tasks) => params.setSubTasks(tasks as unknown as SubTask[]),
        threadMessages: params.harnessRuntime.submission.toConversationMessages(
          params.threadsRef.current.find(
            (candidate) => candidate.id === params.threadId,
          )?.messages || [],
        ),
        createId: params.genId,
        shouldAbort: () => params.abortRef.current,
      }),
      workDir: params.workDir,
      mode: params.mode,
      provider: params.provider,
      threadBefore: thread,
      userMessage: params.msgText,
      summaryTimeoutSecs: params.executionProfile.summaryTimeoutSecs,
      defaultFollowupProvider: params.ensureCliProvider(params.provider),
    });

    if (outcome) {
      params.applyAgentLoopOutcome({
        threadId: params.threadId,
        outcome,
      });
    }
  } catch (error) {
    const message = String(error);
    if (params.supportsWorkflowTimeoutFallback && /timed out/i.test(message)) {
      params.setError(null);
      params.setShowWorkflowEditor(false);
      params.setPendingWorkflowStart(
        params.harnessRuntime.submission.buildWorkflowStartSeed(
          params.threadId,
          params.msgText,
          params.startTime,
          params.attachmentsSnapshot,
        ),
      );
    } else {
      params.setError(message);
    }
  }

  params.setIsStreaming(false);
  params.setStreamingContent('');
  params.setStreamingThinking('');
}
