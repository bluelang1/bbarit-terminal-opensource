import { compactAgentHandoff } from '../components/harness-utils';
import type { HarnessResponseLanguage } from './prompting';
import { ATLASCLOUD_PROVIDER } from './atlasCloudRuntime';
import type { HarnessShellPermission } from './guardrails';

export type WorkflowProvider =
  | typeof ATLASCLOUD_PROVIDER
  | 'claude-cli'
  | 'codex-cli'
  | 'kimi-cli'
  | 'gemini-cli'
  | 'qwen-cli'
  | 'ollama'
  | 'openai'
  | 'claude-api';
export type WorkflowEffort = 'normal' | 'extreme';

export interface WorkflowStage {
  id: string;
  name: string;
  provider: WorkflowProvider;
  model?: string;
  role: string;
  promptTemplate: 'research' | 'plan' | 'implement' | 'review' | 'custom';
  customPrompt?: string;
  enabled: boolean;
}

export interface WorkflowConfig {
  id: string;
  name: string;
  effort?: WorkflowEffort;
  stages: WorkflowStage[];
}

export interface WorkflowExecutionProfile {
  effort: WorkflowEffort;
  stageTimeoutSecs: number;
  directConversationTimeoutSecs: number;
  decomposeTimeoutSecs: number;
  subAgentTimeoutSecs: number;
  summaryTimeoutSecs: number;
  toolBashTimeoutSecs: number;
  shellPermission?: HarnessShellPermission;
  reviewRetryLimit: number;
}

export const ATLAS_CN_STAGE_MODELS = {
  research: 'moonshotai/kimi-k2.6',
  plan: 'deepseek-ai/deepseek-v4-flash',
  implement: 'qwen/qwen3-coder-next',
  review: 'deepseek-ai/deepseek-v4-flash',
  quick: 'deepseek-ai/deepseek-v4-flash',
  custom: 'deepseek-ai/deepseek-v4-flash',
  extremeResearch: 'moonshotai/kimi-k2.6',
  extremePlan: 'deepseek-ai/deepseek-v4-flash',
  extremeImplement: 'qwen/qwen3-coder-next',
  extremeReview: 'moonshotai/kimi-k2.6',
} as const;

export function getDefaultAtlasChinaStageModel(stage: Pick<WorkflowStage, 'role' | 'promptTemplate'>): string {
  if (stage.role === 'research' || stage.promptTemplate === 'research') return ATLAS_CN_STAGE_MODELS.research;
  if (stage.role === 'plan' || stage.promptTemplate === 'plan') return ATLAS_CN_STAGE_MODELS.plan;
  if (stage.role === 'review' || stage.promptTemplate === 'review') return ATLAS_CN_STAGE_MODELS.review;
  if (stage.role === 'implement' || stage.promptTemplate === 'implement') return ATLAS_CN_STAGE_MODELS.implement;
  return ATLAS_CN_STAGE_MODELS.custom;
}

export const DEFAULT_WORKFLOW: WorkflowConfig = {
  id: 'korini-orchestration',
  name: '코린이 기본 오케스트레이션',
  effort: 'normal',
  stages: [
    { id: 'understand', name: '1. 쉽게 이해하기 · Kimi', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.research, role: 'research', promptTemplate: 'research', enabled: true },
    { id: 'safe-plan', name: '2. 안전한 순서 정하기 · DeepSeek 4', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.plan, role: 'plan', promptTemplate: 'plan', enabled: true },
    { id: 'build', name: '3. 코드 만들기 · Qwen 코드', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.implement, role: 'implement', promptTemplate: 'implement', enabled: true },
    { id: 'check', name: '4. 보안/문서/동작 확인 · DeepSeek 4', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.review, role: 'review', promptTemplate: 'review', enabled: true },
  ],
};

export const WORKFLOW_PRESETS: WorkflowConfig[] = [
  DEFAULT_WORKFLOW,
  {
    id: 'extreme',
    name: '더 꼼꼼히',
    effort: 'extreme',
    stages: [
      { id: 'understand', name: '1. 깊게 이해하기 · Kimi', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.extremeResearch, role: 'research', promptTemplate: 'research', enabled: true },
      { id: 'safe-plan', name: '2. 안전하게 계획 · DeepSeek 4', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.extremePlan, role: 'plan', promptTemplate: 'plan', enabled: true },
      { id: 'build', name: '3. 코드 만들기 · Qwen 코드', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.extremeImplement, role: 'implement', promptTemplate: 'implement', enabled: true },
      { id: 'review', name: '4. 문서까지 꼼꼼 검토 · Kimi', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.extremeReview, role: 'review', promptTemplate: 'review', enabled: true },
    ],
  },
  {
    id: 'quick',
    name: '빠르게',
    effort: 'normal',
    stages: [
      { id: 'implement', name: '바로 만들기 · DeepSeek 4', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.quick, role: 'implement', promptTemplate: 'implement', enabled: true },
    ],
  },
  {
    id: 'research-first',
    name: '먼저 파악',
    effort: 'normal',
    stages: [
      { id: 'understand', name: '1. 쉽게 이해하기 · Kimi', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.research, role: 'research', promptTemplate: 'research', enabled: true },
      { id: 'safe-plan', name: '2. 안전한 순서 · DeepSeek 4', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.plan, role: 'plan', promptTemplate: 'plan', enabled: true },
      { id: 'build', name: '3. 코드 만들기 · Qwen 코드', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.implement, role: 'implement', promptTemplate: 'implement', enabled: true },
    ],
  },
  {
    id: 'dual-review',
    name: '검토까지',
    effort: 'normal',
    stages: [
      { id: 'safe-plan', name: '1. 안전한 순서 · DeepSeek 4', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.plan, role: 'plan', promptTemplate: 'plan', enabled: true },
      { id: 'build', name: '2. 코드 만들기 · Qwen 코드', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.implement, role: 'implement', promptTemplate: 'implement', enabled: true },
      { id: 'review', name: '3. 보안/문서/동작 확인 · DeepSeek 4', provider: ATLASCLOUD_PROVIDER, model: ATLAS_CN_STAGE_MODELS.review, role: 'review', promptTemplate: 'review', enabled: true },
    ],
  },
];

export function cloneWorkflowConfig(config: WorkflowConfig): WorkflowConfig {
  return {
    ...config,
    stages: config.stages.map(stage => ({
      ...stage,
      provider: normalizeWorkflowProvider(stage.provider),
      model: normalizeWorkflowStageModel(stage.model) || (
        normalizeWorkflowProvider(stage.provider) === ATLASCLOUD_PROVIDER
          ? getDefaultAtlasChinaStageModel(stage)
          : undefined
      ),
    })),
  };
}

export function normalizeWorkflowStageModel(model?: string | null): string | undefined {
  const normalized = String(model || '').trim();
  return normalized || undefined;
}

export function normalizeWorkflowProvider(provider?: WorkflowProvider | string): WorkflowProvider {
  if (
    provider === ATLASCLOUD_PROVIDER ||
    provider === 'claude-cli' ||
    provider === 'codex-cli' ||
    provider === 'kimi-cli' ||
    provider === 'gemini-cli' ||
    provider === 'qwen-cli' ||
    provider === 'ollama' ||
    provider === 'openai' ||
    provider === 'claude-api'
  ) {
    return provider;
  }
  return ATLASCLOUD_PROVIDER;
}

export function normalizeWorkflowConfig(config: WorkflowConfig): WorkflowConfig {
  return {
    ...config,
    stages: config.stages.map(stage => ({
      ...stage,
      provider: normalizeWorkflowProvider(stage.provider),
      model: normalizeWorkflowStageModel(stage.model) || (
        normalizeWorkflowProvider(stage.provider) === ATLASCLOUD_PROVIDER
          ? getDefaultAtlasChinaStageModel(stage)
          : undefined
      ),
    })),
  };
}

export function applyProviderToWorkflow(config: WorkflowConfig, nextProvider: WorkflowProvider, nextModel?: string): WorkflowConfig {
  const provider = normalizeWorkflowProvider(nextProvider);
  const model = normalizeWorkflowStageModel(nextModel);
  return {
    ...config,
    id: 'custom',
    name: config.id === 'custom' ? config.name : `${config.name}`,
    stages: config.stages.map(stage => ({
      ...stage,
      provider,
      model: model || (provider === ATLASCLOUD_PROVIDER ? getDefaultAtlasChinaStageModel(stage) : undefined),
    })),
  };
}

export function getWorkflowExecutionProfile(config?: WorkflowConfig): WorkflowExecutionProfile {
  const effort = config?.effort === 'extreme' ? 'extreme' : 'normal';
  if (effort === 'extreme') {
    return {
      effort,
      stageTimeoutSecs: 1800,
      directConversationTimeoutSecs: 900,
      decomposeTimeoutSecs: 180,
      subAgentTimeoutSecs: 1200,
      summaryTimeoutSecs: 120,
      toolBashTimeoutSecs: 120,
      shellPermission: 'standard',
      reviewRetryLimit: 4,
    };
  }
  return {
    effort,
    stageTimeoutSecs: 600,
    directConversationTimeoutSecs: 600,
    decomposeTimeoutSecs: 60,
    subAgentTimeoutSecs: 300,
    summaryTimeoutSecs: 30,
    toolBashTimeoutSecs: 120,
    shellPermission: 'standard',
    reviewRetryLimit: 2,
  };
}

export function buildStagePrompt(
  stage: WorkflowStage,
  ctx: {
    workDir: string;
    fileList: string;
    msgText: string;
    previousResults: Record<string, string>;
    projectDocsContext?: string;
    attachmentContext?: string;
    conversationContext?: string;
    learningContext?: string;
    effort?: WorkflowEffort;
    responseLanguage?: HarnessResponseLanguage;
  },
): string {
  const attachmentBlock = ctx.attachmentContext ? `\n\nAttached files:\n${ctx.attachmentContext}` : '';
  const projectDocsBlock = ctx.projectDocsContext ? `\n\nProject default docs loaded automatically:\n${ctx.projectDocsContext}` : '';
  const conversationBlock = ctx.conversationContext ? `\n\nRecent in-thread conversation context:\n${ctx.conversationContext}` : '';
  const learningBlock = ctx.learningContext ? `\n\nRelevant self-improving recall:\n${ctx.learningContext}` : '';
  const effort = ctx.effort === 'extreme' ? 'extreme' : 'normal';
  const responseLanguage = ctx.responseLanguage || 'auto';
  const languageBlock = responseLanguage === 'auto'
    ? '\n\nResponse language: use the same language as the user unless the user explicitly asks to switch.'
    : `\n\nResponse language: write the entire response in ${responseLanguage}.`;
  const effortBlock = effort === 'extreme'
    ? `\n\nExecution profile: EXTREME
- Time budget is intentionally large.
- Prefer depth over speed.
- Read more of the repository before deciding.
- Be exhaustive about edge cases, validation, migration impact, observability, and tests.
- Avoid MVP shortcuts unless the user explicitly asked for them.`
    : '';

  if (stage.promptTemplate === 'custom' && stage.customPrompt) {
    return stage.customPrompt
      .replace('{{workDir}}', ctx.workDir)
      .replace('{{fileList}}', ctx.fileList)
      .replace('{{message}}', ctx.msgText)
      .replace('{{previousResults}}', Object.values(ctx.previousResults).join('\n\n---\n\n'))
      + projectDocsBlock
      + attachmentBlock
      + conversationBlock
      + learningBlock
      + languageBlock
      + effortBlock;
  }

  if (stage.promptTemplate === 'research') {
    return `You are ${stage.name}, the research stage of a multi-agent implementation workflow.

Working directory: ${ctx.workDir}
${ctx.fileList ? `\nTop-level project files:\n${ctx.fileList}\n` : ''}
User request: ${ctx.msgText}${projectDocsBlock}${attachmentBlock}${conversationBlock}${learningBlock}${languageBlock}${effortBlock}

Your job:
1. First analyze the existing sourcebase and identify the likely affected files/modules.
2. Find and review all relevant internal documentation, and report their locations and links/paths.
3. If there are existing guides, conventions, or policies, explain how the implementation should follow them.
4. If this work touches existing UI or design, investigate the current design policy, component patterns, and what would fit naturally.
5. Review relevant API documentation, SDK usage, integration constraints, latest technical trends, useful open-source references, and web-search/source material. Kimi is especially responsible for strong source research and web-search synthesis.
6. Use the fixed Korini stack unless the existing web project clearly already uses compatible choices: Next.js, Vercel, Neon Postgres, Supabase Auth, Korean-first payments with Toss Payments or PortOne/Iamport, Vercel Blob, and Vercel AI SDK for AI/API features. Use Stripe only for global-payment needs or explicit user requests.
7. Compare the realistic implementation options.
8. From those findings, identify the most important technical decisions.
9. Define 3 to 5 easy Korean options the user can choose from. Include at least 2 design-style options when UI is involved.
10. Choose the recommended direction and explain why it is the best fit here.
11. Call out compatibility risks, breaking changes, or unknowns.
12. Identify relevant engineering methods and patterns to use: iterative delivery, TDD where practical, SOLID, object-oriented/domain modeling when useful, composition, repository/service/adapter/facade patterns, validation boundaries, and refactoring checkpoints.
13. Include security checkpoints for later phases, but make them stateful: do one full security check, mark it as "보안 점검 완료" in the progress note, then only re-check changed files/settings. Cover secrets, auth/permissions, input validation, XSS/CSRF/injection, unsafe env handling, dependency risk, deployment risk, and external service connection risk.
14. Produce a concise developer handoff for the next agent.
15. Include a beginner recovery note: where progress should be saved, how to resume if interrupted, and what the next single action should be.
16. In extreme mode, broaden the source review and call out deeper architecture risks, integration assumptions, and testing blind spots.

Output format:
- Summary
- Relevant files
- Sourcebase analysis
- Internal docs reviewed (include file paths / links)
- Existing guides / conventions / policies
- Existing UI / design policy fit
- API / SDK / documentation notes
- Latest trends / best practices
- Relevant open-source references
- Options considered
- Important findings to keep
- Desired technical spec
- Chosen direction
- Risks / unknowns
- Recommended implementation direction

At the very end, output exactly one line starting with:
SPEC_OPTIONS_JSON:

That line must contain a valid JSON array with 2 or 3 spec options.
Each item must be:
{"title":"short option title","summary":"one short summary","spec":"clear technical spec to implement"}
The options may overlap and the user may combine multiple options.`;
  }

  if (stage.promptTemplate === 'plan') {
    const researchHandoff = ctx.previousResults.research
      ? `\nResearch handoff:\n${compactAgentHandoff(ctx.previousResults.research, 10000)}`
      : '';
    return `You are ${stage.name}, the planning stage of a multi-agent workflow.

Working directory: ${ctx.workDir}
${ctx.fileList ? `\nTop-level project files:\n${ctx.fileList}\n` : ''}
User request: ${ctx.msgText}${projectDocsBlock}${attachmentBlock}${conversationBlock}${learningBlock}${languageBlock}${effortBlock}
${researchHandoff}

Your job:
1. Read the research findings and the user-selected technical direction.
2. Turn that into a concrete implementation plan that fits the existing sourcebase and docs.
3. Decide which files should be created or edited.
4. Decide the beginner-facing deliverables that should be created or updated: README/use guide, run/check steps, security notes, rollback notes, and result summary.
5. Include Vercel deployment/API/environment notes, Neon environment variable/database notes, Supabase Auth login notes with Korean social login considerations, Korean payment/webhook notes for Toss Payments or PortOne/Iamport, Vercel Blob image/file notes, Atlas Cloud key/model notes, and Vercel AI SDK/API key notes when relevant.
6. Identify meaningful implementation bundles or option groups the user may want to combine, including simple design-style choices when UI is involved.
7. Plan the engineering method and patterns to use: small iterative implementation, TDD or test-first checks where practical, SOLID/object boundaries, repository/service/adapter/facade patterns when they simplify the code, and explicit refactoring checkpoints after each implementation slice.
8. Add security gates without repeating the same work: one full security gate, then delta-only checks after each later change and before deploy.
9. Produce a TODO checklist that can be tracked in the UI.
10. Plan Playwright MCP as the default browser test path: local URL, main clicks, visible errors, screenshot, and what to do if MCP cannot run.
11. Plan interruption recovery: create/update .bbarit/korini/STATUS.md with done/current/next/errors/rollback after each major slice.
12. Ask only the remaining high-value decisions that materially affect the implementation.
13. Keep the plan concise enough to hand off cleanly to the implementation stage.
14. In extreme mode, include rollback/mitigation notes, validation checkpoints, and a stronger testing matrix.

Output format:
- Goal
- Recommended direction
- File-by-file plan
- Beginner deliverables / docs plan
- Implementation phases
- TODO checklist
- Open questions / decisions
- Recommended bundle choices

At the very end, output exactly one line starting with:
PLAN_OPTIONS_JSON:

That line must contain a valid JSON array with 2 to 4 plan options.
Each item must be:
{"title":"short option title","summary":"one short summary","spec":"clear implementation bundle or decision"}
The options may overlap and the user may combine multiple options.`;
  }

  if (stage.promptTemplate === 'implement') {
    const researchHandoff = ctx.previousResults.research ? `\nResearch handoff:\n${compactAgentHandoff(ctx.previousResults.research, 8000)}` : '';
    const planHandoff = ctx.previousResults.plan ? `\nApproved implementation plan:\n${compactAgentHandoff(ctx.previousResults.plan, 8000)}` : '';
    const reviewHandoff = ctx.previousResults.review ? `\nLatest review feedback to address before saving:\n${compactAgentHandoff(ctx.previousResults.review, 6000)}` : '';
    return `You are ${stage.name}, the architecture and implementation stage of a multi-agent workflow.

Working directory: ${ctx.workDir}
${ctx.fileList ? `\nTop-level project files:\n${ctx.fileList}\n` : ''}
User request: ${ctx.msgText}${projectDocsBlock}${attachmentBlock}${conversationBlock}${learningBlock}${languageBlock}${effortBlock}
${researchHandoff}
${planHandoff}
${reviewHandoff}

Your job:
1. Read the approved research findings and approved planning direction.
2. If review feedback is present, revise the draft to address every blocking issue before moving on.
3. Implement according to the approved direction without re-deciding the architecture.
4. Use mature engineering methods: small iterative slices, TDD/test-first where practical, object-oriented/domain modeling when it clarifies responsibilities, SOLID, composition, repository/service patterns for Neon data access when useful, adapter/facade patterns for Vercel/Supabase Auth/Korean payments/Vercel Blob/Vercel AI SDK integrations, and validation boundaries.
5. After every coherent implementation slice, run a delta security check and a refactoring pass before continuing. If a full security check already passed in this task, only re-check changed files/settings. Fix unsafe env handling, injection/XSS/CSRF risks, auth/permission gaps, duplicated code, confusing names, and unnecessary complexity.
5b. All Korini-managed apps must stay under the fixed Korini base folder. Create, repair, deploy, document, or delete only apps under that folder. If the user asks to delete an app, ask for one clear Korean confirmation and never delete anything outside the Korini base folder.
6. Follow incremental test-driven development: make the smallest coherent change, update or add tests for it, then move to the next step. For web UI behavior, Playwright MCP is the default verification path. Add or maintain strict CI/CD for Korini apps: GitHub Actions or equivalent should run install, lint/typecheck when available, unit tests when available, Playwright tests for the main web flow, build, secret-safety checks, and clear failure reporting before Vercel deployment.
7. Note important edge cases, validation, security, refactoring, and testing expectations.
8. Keep the TODO checklist aligned with the approved plan.
9. Produce the implementation draft yourself.
10. Also create or update beginner-friendly deliverables:
   - README.md or docs/korini-start.md when the project needs user-facing usage instructions.
   - .bbarit/korini/STATUS.md with: done so far, current step, next single action, commands already run, tests/screenshots checked, unresolved errors, and rollback point.
   - .bbarit/korini/RESULT.md with: what was made, how to run, how to check in the browser with Playwright MCP, how CI/CD checks run, which key values belong in .env.local and Vercel, security notes, refactoring notes, rollback notes, and changed files.
   - A simple .env.local guide. Explain .env.local as "내 컴퓨터에만 저장되는 비밀 메모장", ask only for key values, never ask the user to understand environment-variable jargon, keep .env.local out of git, and create/update .env.local.example with placeholder names only.
11. Before finishing, perform or specify the five final checks: CI/CD readiness, deployment readiness, Playwright MCP browser test, security review, and service connection review.
12. Output full file contents for every file you want to create or modify.
13. In extreme mode, prefer complete implementation, test coverage, instrumentation, docs, and cleanup over a minimal patch.

Output format:
- Goal
- Approved direction recap
- File-by-file implementation
- Implementation steps
- Beginner deliverables / docs
- TODO checklist (use markdown checkboxes or numbered tasks)
- Edge cases
- Testing checklist`;
  }

  if (stage.promptTemplate === 'review') {
    const implDraft = ctx.previousResults['plan+implement'] || ctx.previousResults.implement || '';
    return `You are ${stage.name}, the final review stage of a multi-agent workflow.

Working directory: ${ctx.workDir}
User request: ${ctx.msgText}${projectDocsBlock}${conversationBlock}${learningBlock}${effortBlock}

Implementation draft:
${compactAgentHandoff(implDraft, 12000)}

IMPORTANT:
1. You are NOT implementing here. You are reviewing the draft.
2. Start with exactly one line: Verdict: APPROVED or Verdict: CHANGES_REQUESTED
3. Then provide a concise review.
4. If there are blocking issues, list them first with file references if possible.
5. Testing is mandatory. Review the draft using an incremental test-driven standard, not just code style.
6. Require concrete validation logic: updated automated tests where practical, or explicit step-by-step verification commands when automation is not realistic.
7. If the draft lacks meaningful test updates or credible validation steps for the changed behavior, default to CHANGES_REQUESTED.
8. Beginner deliverables are mandatory for project changes. If there is no README/docs/RESULT summary explaining what changed, how to run/check it, security notes, resume point, and rollback notes, default to CHANGES_REQUESTED.
9. Security review is mandatory, but do not repeat an already approved full security review. If a previous stage marked "보안 점검 완료", review only changes since then plus deployment/service connection risks. Check for secrets, env file exposure, unsafe commands, broad permissions, missing .gitignore protection, and risky deployment assumptions.
10. Refactoring review is mandatory. Check whether responsibilities are clear, patterns are useful rather than decorative, duplication is controlled, naming is beginner-readable, and complexity was reduced after implementation.
11. Playwright MCP review is mandatory for web UI behavior unless explicitly impossible. If it was not run, require a clear reason and a manual fallback.
12. Deployment readiness and service connection review are mandatory when external services are involved: Atlas Cloud, Vercel, Neon, Supabase Auth, Toss Payments or PortOne/Iamport, Vercel Blob, and AI provider keys.
13. When you request changes, explain the next smallest test-backed revision that should happen before the next review.
14. If the draft is good enough to save, say why it is approved and summarize the exact test/verification/docs/security/refactoring coverage.
15. Do not rewrite the full files. This is review only.
16. In extreme mode, review more strictly for correctness, regressions, missing tests, missing docs, security, refactoring quality, and long-term maintainability.

Output format:
- Verdict line
- Blocking issues or approval summary
- Testing and validation review
- Docs / deliverables review
- Security review
- Refactoring / design-pattern review
- Next smallest revision (if changes are requested)`;
  }

  return `Working directory: ${ctx.workDir}\nUser request: ${ctx.msgText}${projectDocsBlock}${attachmentBlock}${conversationBlock}${learningBlock}${effortBlock}`;
}
