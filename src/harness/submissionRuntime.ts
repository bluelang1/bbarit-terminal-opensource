import { shouldStartWorkflowForRequest } from '../components/harness-utils';

export type SubmissionMode = 'flash' | 'thinking' | 'pro' | 'ultra' | 'deep-research' | 'image-gen' | 'video-gen' | 'coding';

export interface SubmissionMessageLike {
  role: 'human' | 'assistant' | 'tool' | 'system';
  content: string;
}

export interface WorkflowStartSeed<TAttachment> {
  threadId: string;
  message: string;
  startTime: number;
  attachments: TAttachment[];
}

export function shouldStartCodingWorkflow(params: {
  mode: SubmissionMode;
  messageText: string;
  priorMessages: string[];
  forceWorkflow?: boolean;
}): boolean {
  if (params.mode !== 'coding') return false;
  if (params.forceWorkflow === true) return true;
  return shouldStartWorkflowForRequest(params.messageText, params.priorMessages);
}

export function buildDirectCodingRuntimeUserMessage(messageText: string): string {
  return `This is a direct conversation turn inside coding mode, not an automatic implementation workflow.
Inspect the local repository before answering. Prefer README.md, AGENTS.md, docs/, package manifests, and key source entrypoints.
Answer naturally and directly about the current repository only.
Do not rely on generic prior knowledge about some other project.
Keep the recent in-thread context in mind, especially if the user is replying with shorthand like numbers or short follow-ups.
Do not create plans, spec options, TODOs, or file outputs unless the user explicitly asks for implementation work.

User request: ${messageText}`;
}

export function toConversationMessages(
  messages: SubmissionMessageLike[],
): Array<{ role: 'human' | 'assistant' | 'tool' | 'system'; content: string }> {
  return messages
    .filter((message) => !!message.content)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

export function buildWorkflowStartSeed<TAttachment>(
  threadId: string,
  message: string,
  startTime: number,
  attachments: TAttachment[],
): WorkflowStartSeed<TAttachment> {
  return {
    threadId,
    message,
    startTime,
    attachments: [...attachments],
  };
}
