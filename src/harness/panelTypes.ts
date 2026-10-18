export type AgentMode =
  | 'flash'
  | 'thinking'
  | 'pro'
  | 'ultra'
  | 'deep-research'
  | 'image-gen'
  | 'video-gen'
  | 'coding';

export type AiProvider =
  | 'atlascloud'
  | 'ollama'
  | 'openai'
  | 'claude-api'
  | 'claude-cli'
  | 'codex-cli'
  | 'kimi-cli'
  | 'gemini-cli'
  | 'qwen-cli';

export interface ToolCall {
  id: string;
  name: string;
  args: string;
  result?: string;
  status: 'running' | 'done' | 'error';
  parentToolCallId?: string;
  subagentType?: string;
}

export interface Artifact {
  id: string;
  filename: string;
  language: string;
  content: string;
}

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ChatMessage {
  id: string;
  role: 'human' | 'assistant' | 'tool' | 'system';
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  artifacts?: Artifact[];
  images?: string[];
  timestamp: number;
  durationMs?: number;
  tokenUsage?: import('./tokenUsage').HarnessTokenUsage;
}

export interface ChatThread {
  id: string;
  title: string;
  summary?: string;
  messages: ChatMessage[];
  todos: TodoItem[];
  createdAt: number;
  targetProjectId?: string;
  targetProjectName?: string;
  targetWorkDir?: string;
  cliSessionId?: string;
  mode: AgentMode;
  provider: AiProvider;
  runState?: {
    status: 'running' | 'completed' | 'failed' | 'stopped';
    provider: AiProvider;
    model?: string;
    mode: AgentMode;
    startedAt: number;
    updatedAt: number;
    completedAt?: number;
    progressText?: string;
    thinkingText?: string;
    error?: string;
    targetProjectName?: string;
    targetWorkDir?: string;
    tokenUsage?: import('./tokenUsage').HarnessTokenUsage;
  };
  subTasks?: SubTask[];
}

export interface MemoryEntry {
  id: string;
  content: string;
  source: string;
  createdAt: number;
  pinned?: boolean;
}

export interface SubTask {
  id: string;
  description: string;
  provider: AiProvider;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  startedAt?: number;
  durationMs?: number;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  command: string;
  cliType: string;
  category: string;
  allowedTools?: string[];
  whenToUse?: string;
  disableModelInvocation?: boolean;
  paths?: string[];
  priority?: number;
  model?: string;
}

export interface Attachment {
  id: string;
  name: string;
  type: 'image' | 'text';
  mimeType: string;
  dataUrl: string;
  size: number;
}

export interface PendingWorkflowStart {
  threadId: string;
  message: string;
  startTime: number;
  attachments: Attachment[];
}
