import { buildHarnessSystemPrompt } from './prompting';
import type { HarnessResponseLanguage } from './prompting';
import { getRecentConversationContext, shouldContinueCliSession, type HarnessMessageLike } from './threadState';
import { buildCompressedConversationContext } from './learningCompressionManager';
import type { WorkflowExecutionProfile } from './workflow';
import type { CliProvider } from './cliRuntime';

export type MiddlewareMode = 'flash' | 'thinking' | 'pro' | 'ultra' | 'deep-research' | 'image-gen' | 'video-gen' | 'coding';
export type MiddlewareProvider = 'atlascloud' | 'ollama' | 'openai' | 'claude-api' | 'claude-cli' | 'codex-cli' | 'kimi-cli' | 'gemini-cli' | 'qwen-cli';

export interface MiddlewareMemory {
  content: string;
  pinned?: boolean;
  createdAt?: number;
}

export interface MiddlewareSkill {
  name: string;
  description: string;
  cliType?: string;
  category?: string;
  command?: string;
}

export interface DirectResponseMiddlewareInput {
  mode: MiddlewareMode;
  provider: MiddlewareProvider;
  runtimeUserMsg: string;
  workDir: string;
  projectDocsContext?: string;
  memories: MiddlewareMemory[];
  skills: MiddlewareSkill[];
  threadMessages: HarnessMessageLike[];
  threadSummary?: string;
  executionProfile: WorkflowExecutionProfile;
  isDirectCodingConversation: boolean;
  responseLanguage: HarnessResponseLanguage;
  forceProviderForMode?: MiddlewareProvider;
  ensureCliProvider: (provider: MiddlewareProvider) => CliProvider;
}

export interface DirectResponseMiddlewareContext extends DirectResponseMiddlewareInput {
  runtimeMode: MiddlewareMode;
  promptMemories: MiddlewareMemory[];
  historyMsgs: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt: string;
  apiMessages: Array<{ role: string; content: string }>;
  effectiveProvider: CliProvider;
  hasSession: boolean;
}

export interface NamedDirectResponseMiddleware {
  name: string;
  run: (ctx: DirectResponseMiddlewareContext) => DirectResponseMiddlewareContext;
  nextAnchor?: string;
  prevAnchor?: string;
}

type DirectResponseFeatureFlag = boolean | NamedDirectResponseMiddleware;

export interface DirectResponseRuntimeFeatures {
  runtimeMode?: DirectResponseFeatureFlag;
  threadContext?: DirectResponseFeatureFlag;
  memoryAndPrompt?: DirectResponseFeatureFlag;
  providerAndMessages?: DirectResponseFeatureFlag;
}

export interface DirectResponseAssemblyOptions {
  middleware?: NamedDirectResponseMiddleware[];
  features?: DirectResponseRuntimeFeatures;
  extraMiddleware?: NamedDirectResponseMiddleware[];
}

function withRuntimeMode(ctx: DirectResponseMiddlewareContext): DirectResponseMiddlewareContext {
  return {
    ...ctx,
    runtimeMode: ctx.mode === 'coding' ? 'thinking' : ctx.mode,
  };
}

function withThreadContext(ctx: DirectResponseMiddlewareContext): DirectResponseMiddlewareContext {
  const historyMsgs = ctx.isDirectCodingConversation
    ? getRecentConversationContext(ctx.threadMessages)
    : (() => {
        const compressed = buildCompressedConversationContext({
          messages: ctx.threadMessages,
          threadSummary: ctx.threadSummary,
        });
        if (compressed.trim()) {
          return [{ role: 'assistant' as const, content: compressed }];
        }
        return ctx.threadMessages
          .map((message) => (
            message.role === 'human' || message.role === 'assistant'
              ? { role: message.role === 'human' ? 'user' as const : 'assistant' as const, content: message.content }
              : null
          ))
          .filter((message): message is { role: 'user' | 'assistant'; content: string } => !!message);
      })();

  return { ...ctx, historyMsgs };
}

function withMemoryAndPrompt(ctx: DirectResponseMiddlewareContext): DirectResponseMiddlewareContext {
  const promptMemories = ctx.isDirectCodingConversation
    ? []
    : [
        ...(ctx.threadSummary ? [{ content: `Compressed thread handoff: ${ctx.threadSummary}`, pinned: true, createdAt: Date.now() }] : []),
        ...ctx.memories,
      ];
  const systemPrompt = buildHarnessSystemPrompt(
    ctx.runtimeMode,
    promptMemories,
    ctx.workDir,
    ctx.skills,
    ctx.executionProfile.effort,
    ctx.responseLanguage,
  );
  const projectDocsPrompt = ctx.projectDocsContext
    ? `${systemPrompt}\n\n## Project Default Docs\n${ctx.projectDocsContext}`
    : systemPrompt;
  return { ...ctx, promptMemories, systemPrompt: projectDocsPrompt };
}

function withProviderAndMessages(ctx: DirectResponseMiddlewareContext): DirectResponseMiddlewareContext {
  const effectiveProvider = ctx.ensureCliProvider(ctx.forceProviderForMode || ctx.provider);
  const hasSession = effectiveProvider.endsWith('-cli')
    && shouldContinueCliSession(ctx.threadMessages.length, ctx.isDirectCodingConversation);
  const apiMessages = [
    { role: 'system', content: ctx.systemPrompt },
    ...ctx.historyMsgs,
    { role: 'user', content: ctx.runtimeUserMsg },
  ];
  return { ...ctx, effectiveProvider, hasSession, apiMessages };
}

const BUILTIN_MIDDLEWARES = {
  runtimeMode: { name: 'runtime_mode', run: withRuntimeMode } satisfies NamedDirectResponseMiddleware,
  threadContext: { name: 'thread_context', run: withThreadContext } satisfies NamedDirectResponseMiddleware,
  memoryAndPrompt: { name: 'memory_and_prompt', run: withMemoryAndPrompt } satisfies NamedDirectResponseMiddleware,
  providerAndMessages: { name: 'provider_and_messages', run: withProviderAndMessages } satisfies NamedDirectResponseMiddleware,
} as const;

function cloneMiddleware(middleware: NamedDirectResponseMiddleware): NamedDirectResponseMiddleware {
  return {
    name: middleware.name,
    run: middleware.run,
    ...(middleware.nextAnchor ? { nextAnchor: middleware.nextAnchor } : {}),
    ...(middleware.prevAnchor ? { prevAnchor: middleware.prevAnchor } : {}),
  };
}

function resolveFeatureMiddleware(
  feature: DirectResponseFeatureFlag | undefined,
  builtin: NamedDirectResponseMiddleware,
): NamedDirectResponseMiddleware | null {
  if (feature === false) return null;
  if (feature && typeof feature === 'object' && typeof feature.run === 'function') {
    return cloneMiddleware(feature);
  }
  return cloneMiddleware(builtin);
}

function insertExtraMiddleware(
  chain: NamedDirectResponseMiddleware[],
  extras: NamedDirectResponseMiddleware[],
): NamedDirectResponseMiddleware[] {
  const nextTargets = new Map<string, string>();
  const prevTargets = new Map<string, string>();
  const anchored: NamedDirectResponseMiddleware[] = [];
  const unanchored: NamedDirectResponseMiddleware[] = [];

  for (const middleware of extras) {
    if (middleware.nextAnchor && middleware.prevAnchor) {
      throw new Error(`${middleware.name} cannot define both nextAnchor and prevAnchor`);
    }
    if (middleware.nextAnchor) {
      if (nextTargets.has(middleware.nextAnchor)) {
        throw new Error(`Multiple extra middlewares target nextAnchor=${middleware.nextAnchor}`);
      }
      nextTargets.set(middleware.nextAnchor, middleware.name);
      anchored.push(cloneMiddleware(middleware));
      continue;
    }
    if (middleware.prevAnchor) {
      if (prevTargets.has(middleware.prevAnchor)) {
        throw new Error(`Multiple extra middlewares target prevAnchor=${middleware.prevAnchor}`);
      }
      prevTargets.set(middleware.prevAnchor, middleware.name);
      anchored.push(cloneMiddleware(middleware));
      continue;
    }
    unanchored.push(cloneMiddleware(middleware));
  }

  const nextChain = [...chain];
  nextChain.push(...unanchored);

  const pending = [...anchored];
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    for (let index = 0; index < pending.length; index += 1) {
      const middleware = pending[index];
      const anchor = middleware.nextAnchor || middleware.prevAnchor;
      const anchorIndex = anchor ? nextChain.findIndex((item) => item.name === anchor) : -1;
      if (anchorIndex === -1) continue;
      const insertAt = middleware.nextAnchor ? anchorIndex + 1 : anchorIndex;
      nextChain.splice(insertAt, 0, middleware);
      pending.splice(index, 1);
      progressed = true;
      index -= 1;
    }
  }

  if (pending.length > 0) {
    throw new Error(`Unresolved middleware anchors: ${pending.map((middleware) => middleware.name).join(', ')}`);
  }
  return nextChain;
}

export function nextAfter(anchor: string, middleware: NamedDirectResponseMiddleware): NamedDirectResponseMiddleware {
  return { ...cloneMiddleware(middleware), nextAnchor: anchor, prevAnchor: undefined };
}

export function prevBefore(anchor: string, middleware: NamedDirectResponseMiddleware): NamedDirectResponseMiddleware {
  return { ...cloneMiddleware(middleware), prevAnchor: anchor, nextAnchor: undefined };
}

export function assembleDirectResponseMiddlewares(
  options: DirectResponseAssemblyOptions = {},
): NamedDirectResponseMiddleware[] {
  if (options.middleware && options.features) {
    throw new Error("Cannot specify both 'middleware' and 'features'. Use one or the other.");
  }
  if (options.middleware && options.extraMiddleware?.length) {
    throw new Error("Cannot use 'extraMiddleware' with 'middleware' full takeover.");
  }

  if (options.middleware) {
    return options.middleware.map(cloneMiddleware);
  }

  const features = options.features || {};
  const builtins = [
    resolveFeatureMiddleware(features.runtimeMode, BUILTIN_MIDDLEWARES.runtimeMode),
    resolveFeatureMiddleware(features.threadContext, BUILTIN_MIDDLEWARES.threadContext),
    resolveFeatureMiddleware(features.memoryAndPrompt, BUILTIN_MIDDLEWARES.memoryAndPrompt),
    resolveFeatureMiddleware(features.providerAndMessages, BUILTIN_MIDDLEWARES.providerAndMessages),
  ].filter((middleware): middleware is NamedDirectResponseMiddleware => !!middleware);

  if (!options.extraMiddleware?.length) return builtins;
  return insertExtraMiddleware(builtins, options.extraMiddleware);
}

export const DIRECT_RESPONSE_MIDDLEWARES: NamedDirectResponseMiddleware[] = assembleDirectResponseMiddlewares();

export function getDirectResponseMiddlewareNames(options?: DirectResponseAssemblyOptions): string[] {
  return assembleDirectResponseMiddlewares(options).map((middleware) => middleware.name);
}

export function prepareDirectResponseContext(
  input: DirectResponseMiddlewareInput,
  options?: DirectResponseAssemblyOptions,
): DirectResponseMiddlewareContext {
  const initial: DirectResponseMiddlewareContext = {
    ...input,
    runtimeMode: input.mode,
    promptMemories: input.memories,
    historyMsgs: [],
    systemPrompt: '',
    apiMessages: [],
    effectiveProvider: input.ensureCliProvider(input.provider),
    hasSession: false,
  };
  return assembleDirectResponseMiddlewares(options).reduce((ctx, middleware) => middleware.run(ctx), initial);
}
