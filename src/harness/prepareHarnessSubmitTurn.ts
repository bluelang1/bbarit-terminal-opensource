import type { BeginSubmissionResult } from './panelSessionRuntime';
import type { ChatMessage, ChatThread } from './panelTypes';
import type { SubmissionRoute } from './submissionCoordinator';
import type { HarnessRuntime } from './runtimeFactoryTypes';

export interface PrepareHarnessSubmitTurnParams {
  activeThreadId: string | null;
  messageText: string;
  mode: 'flash' | 'thinking' | 'pro' | 'ultra' | 'deep-research' | 'image-gen' | 'video-gen' | 'coding';
  provider: ChatThread['provider'];
  attachments: Parameters<HarnessRuntime['submission']['determineSubmissionRoute']>[0]['attachments'];
  attachmentContext?: string;
  threads: ChatThread[];
  genId: () => string;
  forceWorkflow?: boolean;
  threadTarget?: {
    projectId?: string;
    projectName?: string;
    workDir?: string;
  };
  harnessRuntime: Pick<HarnessRuntime, 'panel' | 'submission'>;
}

export interface PreparedHarnessSubmitTurn {
  humanMessage: ChatMessage;
  submissionStart: BeginSubmissionResult<ChatThread>;
  submissionRoute: SubmissionRoute;
  startTime: number;
}

export function prepareHarnessSubmitTurn(
  params: PrepareHarnessSubmitTurnParams,
): PreparedHarnessSubmitTurn {
  const humanMessage: ChatMessage = {
    id: params.genId(),
    role: 'human',
    content: params.messageText,
    timestamp: Date.now(),
  };

  const submissionStart = params.harnessRuntime.panel.beginSubmission({
    threads: params.threads,
    activeThreadId: params.activeThreadId,
    humanMessage,
    buildNewThread: (message) => params.harnessRuntime.panel.createNewCodingThread<ChatThread>({
      thread: {
        id: params.genId(),
        createdAt: Date.now(),
        targetProjectId: params.threadTarget?.projectId,
        targetProjectName: params.threadTarget?.projectName,
        targetWorkDir: params.threadTarget?.workDir,
        mode: 'coding',
        provider: params.provider,
      } as Omit<ChatThread, 'title' | 'messages' | 'todos'>,
      title: params.messageText.slice(0, 50),
      initialMessages: [message],
    }),
  });

  const startTime = Date.now();
  const priorMessages = (submissionStart.existingThreadBeforeSubmit?.messages || [])
    .map((message) => message.content)
    .filter(Boolean);
  const submissionRoute = params.harnessRuntime.submission.determineSubmissionRoute({
    mode: params.mode,
    messageText: params.messageText,
    priorMessages,
    threadId: submissionStart.threadId,
    startTime,
    attachments: params.attachments,
    attachmentContext: params.attachmentContext,
    forceWorkflow: params.forceWorkflow,
  });

  return {
    humanMessage,
    submissionStart,
    submissionRoute,
    startTime,
  };
}
