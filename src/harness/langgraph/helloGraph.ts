/**
 * Phase 0 sanity check — minimal LangGraph StateGraph.
 *
 * Flow:
 *   __start__ → greet → shout → END
 *
 * Used only as a wiring/version verification. Not exposed to UI.
 */
import { StateGraph, END, START } from '@langchain/langgraph';
import { HelloState, type HelloStateType } from './state';

function greetNode(state: HelloStateType): Partial<HelloStateType> {
  return {
    steps: ['greet'],
    output: `Hello, ${state.input}!`,
  };
}

function shoutNode(state: HelloStateType): Partial<HelloStateType> {
  return {
    steps: ['shout'],
    output: (state.output || '').toUpperCase(),
  };
}

export const helloGraph = new StateGraph(HelloState)
  .addNode('greet', greetNode)
  .addNode('shout', shoutNode)
  .addEdge(START, 'greet')
  .addEdge('greet', 'shout')
  .addEdge('shout', END)
  .compile();

/**
 * Run the hello graph with a given input.
 * Returns the final state for inspection.
 */
export async function runHelloGraph(input: string): Promise<HelloStateType> {
  const result = await helloGraph.invoke({ input, steps: [], output: '' });
  return result;
}
