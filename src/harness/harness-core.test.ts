import { describe, expect, it, vi } from 'vitest';
import { authorizeHarnessToolCall } from './guardrails';
import { formatMemoryForInjection, buildHarnessSystemPrompt } from './prompting';
import { formatRecentConversationContext, getRecentConversationContext, shouldContinueCliSession } from './threadState';
import { buildStagePrompt, getWorkflowExecutionProfile } from './workflow';
import {
  getRunnableSelectedTodos,
  getSelectedOptionChips,
  getVisibleTodos,
  hasPendingSelectionReview,
  shouldShowFollowups,
  toggleSelectionId,
} from './panelState';
import {
  buildDirectCodingRuntimeUserMessage,
  buildWorkflowStartSeed,
  shouldStartCodingWorkflow,
  toConversationMessages,
} from './submissionRuntime';
import { determineSubmissionRoute } from './submissionCoordinator';
import { buildAssistantMessage, presentDirectResponse } from './chatOutput';
import {
  executePlanReviewSelection,
  executeSpecReviewSelection,
  getSelectedWorkflowOptions,
} from './workflowReviewExecutor';

vi.mock('./workflowExecutor', async () => {
  const actual = await vi.importActual<typeof import('./workflowExecutor')>('./workflowExecutor');
  return {
    ...actual,
    resumeWorkflowAfterSpecSelection: vi.fn(),
    resumeWorkflowAfterPlanSelection: vi.fn(),
  };
});

import {
  resumeWorkflowAfterPlanSelection,
  resumeWorkflowAfterSpecSelection,
} from './workflowExecutor';
import { getDirectResponseMiddlewareNames } from './middleware';
import { formatProjectDocsContext, formatProjectMap } from './projectDocs';
import {
  buildHarnessStorageKeys,
  parsePersistedValue,
  snapshotMemoriesForPersistence,
  snapshotThreadsForPersistence,
} from './threadRuntime';
import { renderHarnessStagePreview, sanitizeHarnessCliResult } from './responsePipeline';
import { buildWorkflowSelectionSummary, formatSelectedOptions } from './workflowExecutor';

describe('authorizeHarnessToolCall', () => {
  it('blocks dangerous bash patterns', () => {
    const decision = authorizeHarnessToolCall('bash', 'rm -rf /', '/tmp');
    expect(decision.allow).toBe(false);
    expect(decision.code).toBe('bash.blocked_pattern');
  });

  it('allows safe bash commands', () => {
    const decision = authorizeHarnessToolCall('bash', 'npm test', '/tmp');
    expect(decision.allow).toBe(true);
  });

  it('allows trusted project cleanup while still blocking root deletion', () => {
    expect(authorizeHarnessToolCall('bash', 'rm -rf build_dist', '/tmp/project', { shellPermission: 'trusted' }).allow).toBe(true);
    expect(authorizeHarnessToolCall('bash', 'rm -rf /', '/tmp/project', { shellPermission: 'trusted' }).allow).toBe(false);
  });

  it('allows read-only search commands with stderr redirected to /dev/null', () => {
    const decision = authorizeHarnessToolCall('bash', 'grep -r "hyperframe" /tmp/project 2>/dev/null | head -50', '/tmp');
    expect(decision.allow).toBe(true);
  });

  it('blocks protected write paths', () => {
    const decision = authorizeHarnessToolCall('write_file', '/etc/hosts\nhello', '/tmp');
    expect(decision.allow).toBe(false);
    expect(decision.code).toBe('write.protected_path');
  });
});

describe('formatMemoryForInjection', () => {
  it('prefers pinned memory first', () => {
    const result = formatMemoryForInjection([
      { content: 'recent fact', createdAt: 20 },
      { content: 'pinned fact', pinned: true, createdAt: 10 },
    ], 200);
    expect(result.split('\n')[0]).toContain('pinned fact');
  });

  it('respects token budget roughly', () => {
    const result = formatMemoryForInjection([
      { content: 'x'.repeat(2000), pinned: true },
      { content: 'keep me' },
    ], 50);
    expect(result).not.toContain('x'.repeat(50));
  });
});

describe('buildHarnessSystemPrompt', () => {
  it('injects tools and memory into coding mode prompt', () => {
    const prompt = buildHarnessSystemPrompt('coding', [{ content: 'user likes concise answers', pinned: true }], '/tmp/project', [
      { name: 'Deep Research', description: 'research workflow', cliType: 'claude-cli' },
    ]);
    expect(prompt).toContain('## Available Tools');
    expect(prompt).toContain('## Long-term Memory');
    expect(prompt).toContain('## Available Skills');
  });

  it('supports extreme effort prompt augmentation', () => {
    const prompt = buildHarnessSystemPrompt('coding', [], '/tmp/project', [], 'extreme');
    expect(prompt).toContain('EXTREME execution mode');
  });

  it('keeps coding mode Korean-first even when another response language is requested', () => {
    const prompt = buildHarnessSystemPrompt('coding', [], '/tmp/project', [], 'normal', 'en');
    expect(prompt).toContain('ALWAYS respond in Korean');
    expect(prompt).not.toContain('Always respond in English');
  });
});

describe('thread state helpers', () => {
  it('keeps only recent conversational turns and drops the newest user message', () => {
    const context = getRecentConversationContext([
      { role: 'human', content: 'first' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'human', content: '2 3 4' },
    ], 6);
    expect(context).toHaveLength(2);
    expect(context[1].content).toBe('reply 1');
  });

  it('keeps the latest assistant choice list when no new human message is appended yet', () => {
    const context = getRecentConversationContext([
      { role: 'human', content: '대대적인 업그레이드를 해줘' },
      { role: 'assistant', content: '1. 코드 구조 개선\n2. 최신 버전 업그레이드' },
    ], 6);
    expect(context).toHaveLength(2);
    expect(context[1].content).toContain('코드 구조 개선');
  });

  it('formats recent conversation context for workflow prompts', () => {
    const formatted = formatRecentConversationContext([
      { role: 'human', content: '원인을 정리해줘' },
      { role: 'assistant', content: '1. debugger 권한\n2. all_urls' },
    ]);
    expect(formatted).toContain('User: 원인을 정리해줘');
    expect(formatted).toContain('Assistant: 1. debugger 권한');
  });

  it('disables cli continue for direct conversation mode', () => {
    expect(shouldContinueCliSession(5, true)).toBe(false);
    expect(shouldContinueCliSession(5, false)).toBe(true);
  });
});

describe('thread runtime helpers', () => {
  it('builds consistent project-scoped storage keys', () => {
    expect(buildHarnessStorageKeys('bbarit-coding-secretary', '/tmp/app')).toEqual({
      stateKey: 'bbarit-coding-secretary:/tmp/app',
      memoryKey: 'bbarit-coding-secretary-memory:/tmp/app',
      workflowKey: 'bbarit-coding-secretary-workflow:/tmp/app',
    });
  });

  it('falls back safely when persisted json is malformed', () => {
    expect(parsePersistedValue('{oops', { threads: [] })).toEqual({ threads: [] });
  });

  it('clips threads and memories for persistence', () => {
    const threads = snapshotThreadsForPersistence([{ messages: [1, 2, 3, 4] }], 2);
    const memories = snapshotMemoriesForPersistence([1, 2, 3, 4], 2);
    expect(threads[0].messages).toEqual([3, 4]);
    expect(memories).toEqual([3, 4]);
  });
});

describe('response pipeline helpers', () => {
  it('sanitizes kimi cli trace output', () => {
    const raw = `TurnBegin(\nfoo\n)\nreal answer`;
    expect(sanitizeHarnessCliResult(raw, 'kimi-cli')).toBe('real answer');
  });

  it('strips selection payloads for stage preview', () => {
    const raw = `Summary\n\nSPEC_OPTIONS_JSON:\n[{"title":"A","summary":"B","spec":"C"}]`;
    expect(renderHarnessStagePreview(raw, 'claude-cli')).toBe('Summary');
  });
});

describe('workflow helpers', () => {
  it('returns longer timeouts for extreme profile', () => {
    expect(getWorkflowExecutionProfile({ id: 'x', name: 'Extreme', effort: 'extreme', stages: [] }).stageTimeoutSecs).toBe(1800);
    expect(getWorkflowExecutionProfile({ id: 'x', name: 'Normal', effort: 'normal', stages: [] }).stageTimeoutSecs).toBe(600);
  });

  it('injects effort guidance into stage prompts', () => {
    const prompt = buildStagePrompt(
      { id: 'research', name: 'Research', provider: 'kimi-cli', role: 'research', promptTemplate: 'research', enabled: true },
      { workDir: '/tmp/project', fileList: 'README.md', msgText: 'build it', previousResults: {}, effort: 'extreme' },
    );
    expect(prompt).toContain('Execution profile: EXTREME');
  });

  it('injects recent thread context into workflow prompts', () => {
    const prompt = buildStagePrompt(
      { id: 'research', name: 'Research', provider: 'kimi-cli', role: 'research', promptTemplate: 'research', enabled: true },
      {
        workDir: '/tmp/project',
        fileList: 'README.md',
        msgText: '고쳐줘',
        previousResults: {},
        conversationContext: 'User: 크롬 확장 프로그램 원인 분석\n\nAssistant: 1. debugger 권한',
        effort: 'normal',
      },
    );
    expect(prompt).toContain('Recent in-thread conversation context');
    expect(prompt).toContain('debugger 권한');
  });

  it('injects response language guidance into workflow prompts', () => {
    const prompt = buildStagePrompt(
      { id: 'research', name: 'Research', provider: 'kimi-cli', role: 'research', promptTemplate: 'research', enabled: true },
      {
        workDir: '/tmp/project',
        fileList: 'README.md',
        msgText: 'fix it',
        previousResults: {},
        responseLanguage: 'en',
      },
    );
    expect(prompt).toContain('Response language: write the entire response in en.');
  });

  it('injects project default docs into workflow prompts', () => {
    const projectDocsContext = formatProjectDocsContext([
      { path: 'AGENTS.md', content: 'Always run npm run tauri:dev.', truncated: false },
      { path: 'CLAUDE.md', content: 'Use the local project conventions.', truncated: false },
    ]);
    const prompt = buildStagePrompt(
      { id: 'research', name: 'Research', provider: 'atlascloud', role: 'research', promptTemplate: 'research', enabled: true },
      {
        workDir: '/tmp/project',
        fileList: 'AGENTS.md\nCLAUDE.md',
        msgText: 'fix it',
        previousResults: {},
        projectDocsContext,
      },
    );
    expect(prompt).toContain('Project default docs loaded automatically');
    expect(prompt).toContain('Always run npm run tauri:dev');
    expect(prompt).toContain('CLAUDE.md');
  });

  it('builds an auto project map from loaded docs and package scripts', () => {
    const map = formatProjectMap([
      { path: 'AGENTS.md', content: 'Always run npm run tauri:dev.', truncated: false },
      {
        path: 'package.json',
        content: JSON.stringify({
          scripts: { 'tauri:dev': 'tauri dev', build: 'tsc -b && vite build' },
          dependencies: { react: '^19.0.0', '@tauri-apps/api': '^2.0.0', 'lucide-react': '^0.468.0' },
          devDependencies: { vite: '^7.0.0', typescript: '^5.0.0', vitest: '^4.0.0' },
        }),
        truncated: false,
      },
      { path: 'src-tauri/Cargo.toml', content: '[dependencies]\ntauri = "2"', truncated: false },
    ]);
    expect(map).toContain('Auto Project Map');
    expect(map).toContain('Tauri desktop app');
    expect(map).toContain('React frontend');
    expect(map).toContain('npm run tauri:dev');
    expect(map).toContain('AGENTS.md');
  });

  it('requires incremental test-driven validation in review prompts', () => {
    const prompt = buildStagePrompt(
      { id: 'review', name: 'Review', provider: 'codex-cli', role: 'review', promptTemplate: 'review', enabled: true },
      {
        workDir: '/tmp/project',
        fileList: 'README.md',
        msgText: '하네스를 고쳐줘',
        previousResults: { implement: 'draft content' },
        effort: 'normal',
      },
    );
    expect(prompt).toContain('Testing is mandatory');
    expect(prompt).toContain('incremental test-driven standard');
    expect(prompt).toContain('default to CHANGES_REQUESTED');
    expect(prompt).toContain('Testing and validation review');
  });

  it('formats selected workflow options into compact handoff text', () => {
    const text = formatSelectedOptions([
      { id: 'a', title: 'Deep Refactor', summary: 'Split the runtime', spec: 'Create runtime core' },
      { id: 'b', title: 'UI Cleanup', summary: 'Slim the panel', spec: 'Move loops to executor' },
    ]);
    expect(text).toContain('Option 1: Deep Refactor');
    expect(text).toContain('Option 2: UI Cleanup');
  });

  it('builds a readable selection summary for specs and plans', () => {
    const summary = buildWorkflowSelectionSummary(
      [{ id: 'a', title: 'Spec A', summary: '', spec: '...' }],
      [{ id: 'b', title: 'Plan B', summary: '', spec: '...' }],
    );
    expect(summary).toContain('Selected spec bundles: Spec A');
    expect(summary).toContain('Approved plan bundles: Plan B');
  });
});

describe('panel state helpers', () => {
  it('flags pending selection review when either review state exists', () => {
    expect(hasPendingSelectionReview({ id: 1 }, null)).toBe(true);
    expect(hasPendingSelectionReview(null, { id: 2 })).toBe(true);
    expect(hasPendingSelectionReview(null, null)).toBe(false);
  });

  it('returns selected option chips only for checked ids', () => {
    const chips = getSelectedOptionChips([
      { id: 'a', title: 'Auto assign button', summary: '', spec: '' },
      { id: 'b', title: 'Dead code cleanup', summary: '', spec: '' },
    ], ['b']);
    expect(chips).toHaveLength(1);
    expect(chips[0].title).toBe('Dead code cleanup');
  });

  it('hides todos while selection review is pending', () => {
    const todos = [{ id: 't1', text: 'Do the thing', status: 'pending' as const }];
    expect(getVisibleTodos(todos, true, false)).toEqual([]);
    expect(getVisibleTodos(todos, false, false)).toEqual(todos);
  });

  it('hides todos while workflow streaming is active', () => {
    const todos = [{ id: 't1', text: 'Do the thing', status: 'pending' as const }];
    expect(getVisibleTodos(todos, false, true)).toEqual([]);
  });

  it('hides completed todos from the visible task list', () => {
    const todos = [
      { id: 't1', text: 'Done', status: 'completed' as const },
      { id: 't2', text: 'Doing', status: 'in_progress' as const },
      { id: 't3', text: 'Pending', status: 'pending' as const },
    ];
    expect(getVisibleTodos(todos, false, false)).toEqual([todos[1], todos[2]]);
  });

  it('toggles selected option ids predictably', () => {
    expect(toggleSelectionId([], 'a')).toEqual(['a']);
    expect(toggleSelectionId(['a', 'b'], 'b')).toEqual(['a']);
    expect(toggleSelectionId(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('shows followups only when no selection review or stream is active', () => {
    expect(shouldShowFollowups(['next'], false, false)).toBe(true);
    expect(shouldShowFollowups(['next'], true, false)).toBe(false);
    expect(shouldShowFollowups(['next'], false, true)).toBe(false);
    expect(shouldShowFollowups([], false, false)).toBe(false);
  });

  it('returns only runnable selected todos', () => {
    const todos = [
      { id: 't1', text: 'Do the thing', status: 'pending' as const },
      { id: 't2', text: 'Already done', status: 'completed' as const },
      { id: 't3', text: 'Still running', status: 'in_progress' as const },
    ];
    expect(getRunnableSelectedTodos(todos, new Set(['t1', 't2', 't3']))).toEqual([todos[0]]);
  });
});

describe('submission runtime helpers', () => {
  it('starts coding workflow only for coding mode requests that match workflow heuristics', () => {
    expect(shouldStartCodingWorkflow({
      mode: 'coding',
      messageText: '대대적인 업그레이드를 해줘',
      priorMessages: [],
    })).toBe(true);
    expect(shouldStartCodingWorkflow({
      mode: 'thinking',
      messageText: '대대적인 업그레이드를 해줘',
      priorMessages: [],
    })).toBe(false);
  });

  it('builds the direct coding conversation wrapper prompt', () => {
    const text = buildDirectCodingRuntimeUserMessage('이 프로젝트 구조를 설명해줘');
    expect(text).toContain('direct conversation turn inside coding mode');
    expect(text).toContain('이 프로젝트 구조를 설명해줘');
  });

  it('maps thread messages into conversation payloads', () => {
    expect(toConversationMessages([
      { role: 'human', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'tool', content: '' },
    ])).toEqual([
      { role: 'human', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('builds workflow start seed with copied attachments', () => {
    const attachments = [{ id: 'a1' }];
    const seed = buildWorkflowStartSeed('thread-1', 'fix it', 123, attachments);
    expect(seed).toEqual({
      threadId: 'thread-1',
      message: 'fix it',
      startTime: 123,
      attachments: [{ id: 'a1' }],
    });
    expect(seed.attachments).not.toBe(attachments);
  });

  it('routes coding workflow requests into immediate workflow run', () => {
    const route = determineSubmissionRoute({
      mode: 'coding',
      messageText: '대대적인 업그레이드를 해줘',
      priorMessages: [],
      threadId: 'thread-1',
      startTime: 123,
      attachments: [{ id: 'a1' }],
    });
    expect(route.kind).toBe('workflow-run');
    if (route.kind === 'workflow-run') {
      expect(route.runtimeMode).toBe('coding');
      expect(route.runtimeUserMsg).toBe('대대적인 업그레이드를 해줘');
      expect(route.isDirectCodingConversation).toBe(false);
    }
  });

  it('routes direct coding chat into direct-response thinking mode', () => {
    const route = determineSubmissionRoute({
      mode: 'coding',
      messageText: '이 프로젝트 구조를 설명해줘',
      priorMessages: [],
      threadId: 'thread-1',
      startTime: 123,
      attachments: [],
    });
    expect(route.kind).toBe('direct-response');
    if (route.kind === 'direct-response') {
      expect(route.runtimeMode).toBe('thinking');
      expect(route.isDirectCodingConversation).toBe(true);
    }
  });

  it('injects copied workspace attachment paths into direct agent requests', () => {
    const route = determineSubmissionRoute({
      mode: 'thinking',
      messageText: '이 이미지로 작업해줘',
      priorMessages: [],
      threadId: 'thread-1',
      startTime: 123,
      attachments: [{ id: 'a1' }],
      attachmentContext: '[Image: ref.png] copied into the workspace at bbarit-motion/refs/a1-ref.png',
    });

    expect(route.kind).toBe('direct-response');
    if (route.kind === 'direct-response') {
      expect(route.runtimeUserMsg).toContain('이 이미지로 작업해줘');
      expect(route.runtimeUserMsg).toContain('bbarit-motion/refs/a1-ref.png');
      expect(route.runtimeUserMsg).toContain('Use the copied workspace files');
    }
  });
});

describe('chat output helpers', () => {
  it('builds assistant messages with optional fields', () => {
    const message = buildAssistantMessage({
      id: 'm1',
      content: 'hello',
      timestamp: 123,
      artifacts: [],
      images: ['img'],
    });
    expect(message.role).toBe('assistant');
    expect(message.images).toEqual(['img']);
    expect(message.artifacts).toBeUndefined();
  });

  it('presents direct response output for the panel', () => {
    const presented = presentDirectResponse({
      mainContent: 'answer',
      thinking: 'reasoning',
      toolCalls: [{ id: 't1', name: 'bash', args: 'pwd', status: 'done' }],
      artifacts: [{ id: 'a1', filename: 'x.ts', language: 'ts', content: 'code' }],
      todos: [{ id: 'todo1', text: 'Do it', status: 'pending' }],
      postMessages: [{ content: 'step 1' }],
      durationMs: 100,
      followupSource: 'answer',
      followupProvider: 'claude-cli',
      memorySummary: 'remember this',
    }, (() => {
      let i = 0;
      return () => `id-${++i}`;
    })(), () => 999);

    expect(presented.primaryMessage.content).toBe('answer');
    expect(presented.primaryArtifact?.filename).toBe('x.ts');
    expect(presented.postMessages).toHaveLength(1);
    expect(presented.memorySummary).toBe('remember this');
    expect(presented.todos).toHaveLength(1);
  });
});

describe('middleware chain helpers', () => {
  it('exposes named direct-response middleware chain in deterministic order', () => {
    expect(getDirectResponseMiddlewareNames()).toEqual([
      'runtime_mode',
      'thread_context',
      'memory_and_prompt',
      'provider_and_messages',
    ]);
  });
});

describe('workflow review executor helpers', () => {
  it('filters selected workflow options by id', () => {
    const selected = getSelectedWorkflowOptions([
      { id: 'a', title: 'A', summary: '', spec: '' },
      { id: 'b', title: 'B', summary: '', spec: '' },
    ], ['b']);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe('b');
  });

  it('returns null when no spec review option is selected', async () => {
    const result = await executeSpecReviewSelection({
      pending: {
        threadId: 't1',
        message: 'msg',
        fileList: '',
        researchResult: 'research',
        options: [{ id: 'a', title: 'A', summary: '', spec: '' }],
        selectedIds: [],
      },
      selectedIds: [],
      startTime: 1,
      workDir: '/tmp/project',
      workflow: { id: 'w', name: 'Workflow', stages: [] },
      executionProfile: getWorkflowExecutionProfile(),
      responseLanguage: 'en',
      labels: { saved: 'Saved', files: 'files' },
      ensureCliProvider: (provider) => provider as any,
      onStreamingContent: () => {},
      onPipelineUpdate: () => {},
    });
    expect(result).toBeNull();
  });

  it('delegates selected spec review options to workflow executor', async () => {
    vi.mocked(resumeWorkflowAfterSpecSelection).mockResolvedValueOnce({
      kind: 'completed',
      responseContent: 'done',
      artifacts: [],
      todos: [],
      durationMs: 1,
      followupSource: 'done',
      followupProvider: 'claude-cli',
    });
    const result = await executeSpecReviewSelection({
      pending: {
        threadId: 't1',
        message: 'msg',
        fileList: '',
        researchResult: 'research',
        options: [{ id: 'a', title: 'A', summary: '', spec: '' }],
        selectedIds: ['a'],
      },
      selectedIds: ['a'],
      startTime: 1,
      workDir: '/tmp/project',
      workflow: { id: 'w', name: 'Workflow', stages: [] },
      executionProfile: getWorkflowExecutionProfile(),
      responseLanguage: 'en',
      labels: { saved: 'Saved', files: 'files' },
      ensureCliProvider: (provider) => provider as any,
      onStreamingContent: () => {},
      onPipelineUpdate: () => {},
    });
    expect(resumeWorkflowAfterSpecSelection).toHaveBeenCalledTimes(1);
    expect(result && result.kind).toBe('completed');
  });

  it('delegates selected plan review options to workflow executor', async () => {
    vi.mocked(resumeWorkflowAfterPlanSelection).mockResolvedValueOnce({
      kind: 'completed',
      responseContent: 'done',
      artifacts: [],
      todos: [],
      durationMs: 1,
      followupSource: 'done',
      followupProvider: 'claude-cli',
    });
    const result = await executePlanReviewSelection({
      pending: {
        threadId: 't1',
        message: 'msg',
        fileList: '',
        researchResult: 'research',
        selectedSpecs: [],
        planResult: 'plan',
        options: [{ id: 'a', title: 'A', summary: '', spec: '' }],
        selectedIds: ['a'],
      },
      selectedIds: ['a'],
      startTime: 1,
      workDir: '/tmp/project',
      workflow: { id: 'w', name: 'Workflow', stages: [] },
      executionProfile: getWorkflowExecutionProfile(),
      responseLanguage: 'en',
      labels: { saved: 'Saved', files: 'files' },
      ensureCliProvider: (provider) => provider as any,
      onStreamingContent: () => {},
      onPipelineUpdate: () => {},
    });
    expect(resumeWorkflowAfterPlanSelection).toHaveBeenCalledTimes(1);
    expect(result && result.kind).toBe('completed');
  });
});
