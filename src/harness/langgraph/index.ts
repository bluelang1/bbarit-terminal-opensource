/**
 * LangGraph entry point for Coding Secretary.
 *
 * Exposes StateGraphs and runner helpers. Used by agentLoopRunner
 * and optional debug UI.
 */
export { helloGraph, runHelloGraph } from './helloGraph';
export { HelloState, UltraState, WorkflowState } from './state';
export type {
  HelloStateType,
  UltraStateType,
  WorkflowStateType,
  WorkflowStage,
  ReviewDecision,
} from './state';

// Workflow mode
export { buildWorkflowGraph, runWorkflowGraph, MemorySaver } from './workflowGraph';
export type { WorkflowGraphExecutors } from './workflowGraph';

// Checkpoint persistence
export { KvCheckpointSaver, InMemoryKvAdapter, makeBbaritKvAdapter } from './checkpointer';
export type { KvAdapter } from './checkpointer';

// Tool-using agent
export { buildAgentGraph } from './agentGraph';
export type { ModelExecutor, AgentGraphOpts } from './agentGraph';
export { echoTool, mathTool, timeTool, BUILTIN_TOOLS, findTool } from './tools/registry';
export {
  BBARIT_TOOLS, findBbaritTool, setTauriInvoker,
  kanbanListTool, kanbanAddTool, kanbanMoveTool,
  calendarListTool, calendarAddTool,
  noteReadTool, noteWriteTool, dirListTool,
} from './tools/bbaritTools';

// CLI executors
export { makeCliTextExecutor } from './executors/cliExecutor';
export type { CliBackend, CliExecutorOpts } from './executors/cliExecutor';

// CLI-backed ModelExecutor (for agent loop with real CLI)
export { makeCliModelExecutor, extractFirstJsonObject } from './executors/cliModelExecutor';
export type { CliModelExecutorOpts } from './executors/cliModelExecutor';

// High-level runners (recommended entry points for UI code)
export { runUltraMode } from './runners/ultraRunner';
export type { RunUltraModeOpts, UltraRunResult } from './runners/ultraRunner';
export { runWorkflowMode } from './runners/workflowRunner';
export type { RunWorkflowModeOpts, WorkflowRunResult } from './runners/workflowRunner';

// Streaming runners (yield per-node events for live UI)
export { streamUltraMode } from './runners/streamUltra';
export type { StreamUltraModeOpts } from './runners/streamUltra';
export { streamWorkflowMode } from './runners/streamWorkflow';
export type { StreamWorkflowModeOpts } from './runners/streamWorkflow';
export { startEvent, nodeEvent, errorEvent, endEvent } from './runners/streamEvents';
export type { StreamEvent } from './runners/streamEvents';
export {
  makeSpecNode,
  makeDesignNode,
  makeImplNode,
  makeTestNode,
  makeReviewNode,
  makeFinalizeNode,
  MAX_REVISIONS_PER_STAGE,
} from './nodes/workflowStages';
export type { StageExecutor, Reviewer } from './nodes/workflowStages';

// Ultra mode
export { buildUltraGraph, runUltraGraph } from './ultraModeGraph';
export type { UltraGraphExecutors } from './ultraModeGraph';
export { makeDecomposeNode, extractTaskList } from './nodes/decompose';
export type { DecomposeExecutor } from './nodes/decompose';
export { makeExecuteParallelNode } from './nodes/executeParallel';
export type { SubAgentExecutor } from './nodes/executeParallel';
export { makeSynthesizeNode } from './nodes/synthesize';
export type { SynthesizeExecutor } from './nodes/synthesize';
