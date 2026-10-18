/**
 * Shared State types for LangGraph-based Coding Secretary flows.
 *
 * LangGraph 공식 패턴에 맞춰 Annotation 기반으로 정의.
 * See: https://langchain-ai.github.io/langgraphjs/how-tos/define-state/
 */
import { Annotation } from '@langchain/langgraph';

/**
 * Minimal hello-world state — Phase 0 sanity check.
 * input: 사용자 입력
 * steps: 각 node가 덧붙이는 추적 로그
 * output: 최종 결과
 */
export const HelloState = Annotation.Root({
  input: Annotation<string>(),
  steps: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  output: Annotation<string>(),
});

export type HelloStateType = typeof HelloState.State;

/**
 * Ultra 모드 State — Phase 1에서 사용 예정.
 * tasks: decompose 결과
 * subResults: 각 sub-agent 실행 결과 (task id → result)
 */
export const UltraState = Annotation.Root({
  userInput: Annotation<string>(),
  tasks: Annotation<Array<{ id: string; description: string }>>({
    reducer: (_old, next) => next,
    default: () => [],
  }),
  subResults: Annotation<Record<string, string>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  finalAnswer: Annotation<string | undefined>({
    reducer: (_old, next) => next,
    default: () => undefined,
  }),
  errors: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

export type UltraStateType = typeof UltraState.State;

/**
 * Workflow 모드 State — Phase 2.
 *
 * 흐름: spec → reviewSpec → design → reviewDesign → impl → reviewImpl → test → END
 * 각 review 단계에서 approved/revise/reject 결정에 따라 다음 노드가 달라짐.
 */
export type WorkflowStage = 'spec' | 'design' | 'impl' | 'test' | 'done';
export type ReviewDecision = 'approved' | 'revise' | 'reject' | 'pending';

export const WorkflowState = Annotation.Root({
  userGoal: Annotation<string>(),
  currentStage: Annotation<WorkflowStage>({
    reducer: (_old, next) => next,
    default: () => 'spec' as WorkflowStage,
  }),
  // Accumulated outputs by stage
  outputs: Annotation<Partial<Record<WorkflowStage, string>>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  // Review decision bus (consumed by the conditional edge)
  reviewDecision: Annotation<ReviewDecision>({
    reducer: (_old, next) => next,
    default: () => 'pending' as ReviewDecision,
  }),
  // How many times each stage has been revised (prevents infinite loops)
  revisionCounts: Annotation<Partial<Record<WorkflowStage, number>>>({
    reducer: (a, b) => {
      const out = { ...a };
      for (const [k, v] of Object.entries(b)) out[k as WorkflowStage] = v as number;
      return out;
    },
    default: () => ({}),
  }),
  errors: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  finalAnswer: Annotation<string | undefined>({
    reducer: (_old, next) => next,
    default: () => undefined,
  }),
});

export type WorkflowStateType = typeof WorkflowState.State;
