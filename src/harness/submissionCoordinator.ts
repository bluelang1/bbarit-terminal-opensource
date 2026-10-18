import type { SubmissionMode, WorkflowStartSeed } from './submissionRuntime';
import { buildDirectCodingRuntimeUserMessage, shouldStartCodingWorkflow } from './submissionRuntime';

export type SubmissionRoute =
  | { kind: 'workflow-pending'; pending: WorkflowStartSeed<any> }
  | { kind: 'workflow-run'; runtimeMode: 'coding'; runtimeUserMsg: string; isDirectCodingConversation: false }
  | { kind: 'image-gen'; runtimeMode: 'image-gen'; runtimeUserMsg: string; isDirectCodingConversation: false }
  | { kind: 'video-gen'; runtimeMode: 'video-gen'; runtimeUserMsg: string; isDirectCodingConversation: false }
  | { kind: 'ultra'; runtimeMode: 'ultra'; runtimeUserMsg: string; isDirectCodingConversation: false }
  | { kind: 'direct-response'; runtimeMode: Exclude<SubmissionMode, 'coding'> | 'thinking'; runtimeUserMsg: string; isDirectCodingConversation: boolean };

export function determineSubmissionRoute<TAttachment>(params: {
  mode: SubmissionMode;
  messageText: string;
  priorMessages: string[];
  threadId: string;
  startTime: number;
  attachments: TAttachment[];
  attachmentContext?: string;
  forceWorkflow?: boolean;
}): SubmissionRoute {
  const startWorkflow = shouldStartCodingWorkflow({
    mode: params.mode,
    messageText: params.messageText,
    priorMessages: params.priorMessages,
    forceWorkflow: params.forceWorkflow,
  });

  if (params.mode === 'coding' && startWorkflow) {
    return {
      kind: 'workflow-run',
      runtimeMode: 'coding',
      runtimeUserMsg: params.messageText,
      isDirectCodingConversation: false,
    };
  }

  const runtimeMode = params.mode === 'coding' ? 'thinking' : params.mode;
  const isDirectCodingConversation = params.mode === 'coding';
  const baseRuntimeUserMsg = isDirectCodingConversation
    ? buildDirectCodingRuntimeUserMessage(params.messageText)
    : params.messageText;
  const runtimeUserMsg = params.attachmentContext
    ? `${baseRuntimeUserMsg}\n\nAttached workspace files:\n${params.attachmentContext}\n\nUse the copied workspace files above as the source attachments for this request.`
    : baseRuntimeUserMsg;

  if (runtimeMode === 'image-gen') {
    return { kind: 'image-gen', runtimeMode, runtimeUserMsg, isDirectCodingConversation: false };
  }
  if (runtimeMode === 'video-gen') {
    return { kind: 'video-gen', runtimeMode, runtimeUserMsg, isDirectCodingConversation: false };
  }
  if (runtimeMode === 'ultra') {
    return { kind: 'ultra', runtimeMode, runtimeUserMsg, isDirectCodingConversation: false };
  }
  return { kind: 'direct-response', runtimeMode, runtimeUserMsg, isDirectCodingConversation };
}
