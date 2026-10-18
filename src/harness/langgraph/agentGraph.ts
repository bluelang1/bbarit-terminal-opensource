/**
 * Generic tool-using agent StateGraph.
 *
 * Flow:
 *   START → model → (toolsCondition)
 *                      ├─ has tool_calls → tools → model (loop)
 *                      └─ no tool_calls  → END
 *
 * The model itself is injected as an async executor so tests can drive
 * exact tool_call sequences without hitting a real LLM.
 */
import { StateGraph, START, END, MessagesAnnotation } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import {
  AIMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';

/**
 * Executor that takes the full message history and returns the next AIMessage
 * (possibly with tool_calls). Implementations can wrap any LLM or CLI.
 */
export type ModelExecutor = (messages: BaseMessage[]) => Promise<AIMessage>;

export interface AgentGraphOpts {
  tools: StructuredTool[];
  model: ModelExecutor;
  /** Hard limit on agent-loop iterations (prevents runaway loops). Default 10. */
  maxSteps?: number;
}

export function buildAgentGraph(opts: AgentGraphOpts) {
  const { tools, model, maxSteps = 10 } = opts;
  const toolNode = new ToolNode(tools);

  let stepCount = 0;

  async function callModel(state: typeof MessagesAnnotation.State) {
    stepCount++;
    if (stepCount > maxSteps) {
      return {
        messages: [
          new AIMessage({
            content: `[agent] aborted: exceeded maxSteps (${maxSteps})`,
          }),
        ],
      };
    }
    const ai = await model(state.messages);
    return { messages: [ai] };
  }

  return new StateGraph(MessagesAnnotation)
    .addNode('model', callModel)
    .addNode('tools', toolNode)
    .addEdge(START, 'model')
    .addConditionalEdges('model', toolsCondition, {
      tools: 'tools',
      [END]: END,
    })
    .addEdge('tools', 'model')
    .compile();
}
