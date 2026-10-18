import { describe, expect, it } from 'vitest';
import {
  assembleDirectResponseMiddlewares,
  getDirectResponseMiddlewareNames,
  nextAfter,
  prepareDirectResponseContext,
  prevBefore,
} from './middleware';
import { getWorkflowExecutionProfile } from './workflow';

describe('middleware assembly', () => {
  it('keeps the DeerFlow-style built-in order by default', () => {
    expect(getDirectResponseMiddlewareNames()).toEqual([
      'runtime_mode',
      'thread_context',
      'memory_and_prompt',
      'provider_and_messages',
    ]);
  });

  it('allows built-in middleware replacement via features', () => {
    const chain = assembleDirectResponseMiddlewares({
      features: {
        threadContext: {
          name: 'custom_thread_context',
          run: (ctx) => ctx,
        },
      },
    });
    expect(chain.map((middleware) => middleware.name)).toEqual([
      'runtime_mode',
      'custom_thread_context',
      'memory_and_prompt',
      'provider_and_messages',
    ]);
  });

  it('supports ordered extra middleware insertion with anchors', () => {
    const chain = assembleDirectResponseMiddlewares({
      extraMiddleware: [
        nextAfter('thread_context', { name: 'post_thread_context', run: (ctx) => ctx }),
        prevBefore('provider_and_messages', { name: 'pre_provider', run: (ctx) => ctx }),
      ],
    });
    expect(chain.map((middleware) => middleware.name)).toEqual([
      'runtime_mode',
      'thread_context',
      'post_thread_context',
      'memory_and_prompt',
      'pre_provider',
      'provider_and_messages',
    ]);
  });

  it('rejects full takeover mixed with features', () => {
    expect(() => assembleDirectResponseMiddlewares({
      middleware: [{ name: 'custom', run: (ctx) => ctx }],
      features: { runtimeMode: true },
    })).toThrow(/Cannot specify both 'middleware' and 'features'/);
  });

  it('keeps the selected provider for direct coding conversations', () => {
    const context = prepareDirectResponseContext({
      mode: 'coding',
      provider: 'codex-cli',
      runtimeUserMsg: 'Explain this codebase',
      workDir: '/tmp/project',
      memories: [],
      skills: [],
      threadMessages: [],
      executionProfile: getWorkflowExecutionProfile(),
      isDirectCodingConversation: true,
      responseLanguage: 'en',
      ensureCliProvider: (provider) => provider as any,
    });

    expect(context.runtimeMode).toBe('thinking');
    expect(context.effectiveProvider).toBe('codex-cli');
    expect(context.hasSession).toBe(false);
  });

  it('injects loaded project docs into the direct response system prompt', () => {
    const context = prepareDirectResponseContext({
      mode: 'thinking',
      provider: 'atlascloud',
      runtimeUserMsg: 'Fix the harness',
      workDir: '/tmp/project',
      projectDocsContext: '--- CLAUDE.md ---\nAlways read this file first.',
      memories: [],
      skills: [],
      threadMessages: [],
      executionProfile: getWorkflowExecutionProfile(),
      isDirectCodingConversation: false,
      responseLanguage: 'en',
      ensureCliProvider: (provider) => provider as any,
    });

    expect(context.systemPrompt).toContain('Project Default Docs');
    expect(context.systemPrompt).toContain('CLAUDE.md');
    expect(context.apiMessages[0].content).toContain('Always read this file first');
  });
});
