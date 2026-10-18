import { describe, it, expect } from 'vitest';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { buildAgentGraph, BUILTIN_TOOLS, echoTool, mathTool } from './index';

describe('Agent graph with ToolNode', () => {
  it('runs model→tools→model loop and terminates when no more tool_calls', async () => {
    // Scripted model: first turn asks for a math call, second turn returns final text.
    let turn = 0;
    const graph = buildAgentGraph({
      tools: [mathTool],
      model: async () => {
        turn++;
        if (turn === 1) {
          return new AIMessage({
            content: '',
            tool_calls: [{ id: 'call-1', name: 'math', args: { op: 'add', a: 2, b: 3 } }],
          });
        }
        return new AIMessage({ content: 'Answer: 5' });
      },
    });

    const result = await graph.invoke({
      messages: [new HumanMessage('What is 2+3?')],
    });

    const names = result.messages.map((m) => m.constructor.name);
    expect(names).toEqual(['HumanMessage', 'AIMessage', 'ToolMessage', 'AIMessage']);
    const toolMsg = result.messages.find((m) => m instanceof ToolMessage) as ToolMessage;
    expect(toolMsg.content).toBe('5');
    const finalAi = result.messages[result.messages.length - 1] as AIMessage;
    expect(finalAi.content).toBe('Answer: 5');
    expect(turn).toBe(2);
  });

  it('supports multiple tool calls in one turn', async () => {
    let turn = 0;
    const graph = buildAgentGraph({
      tools: BUILTIN_TOOLS,
      model: async () => {
        turn++;
        if (turn === 1) {
          return new AIMessage({
            content: '',
            tool_calls: [
              { id: 'c-echo', name: 'echo', args: { text: 'hi' } },
              { id: 'c-math', name: 'math', args: { op: 'mul', a: 4, b: 5 } },
            ],
          });
        }
        return new AIMessage({ content: 'done' });
      },
    });

    const result = await graph.invoke({
      messages: [new HumanMessage('Echo "hi" and compute 4*5')],
    });
    const toolMsgs = result.messages.filter((m) => m instanceof ToolMessage) as ToolMessage[];
    expect(toolMsgs.map((m) => m.content).sort()).toEqual(['20', 'echo: hi']);
  });

  it('aborts after maxSteps to avoid runaway loops', async () => {
    const graph = buildAgentGraph({
      tools: [echoTool],
      model: async () =>
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'c', name: 'echo', args: { text: 'again' } }],
        }),
      maxSteps: 3,
    });

    const result = await graph.invoke({ messages: [new HumanMessage('loop')] });
    const lastAi = result.messages[result.messages.length - 1] as AIMessage;
    const content = typeof lastAi.content === 'string' ? lastAi.content : JSON.stringify(lastAi.content);
    expect(content).toMatch(/maxSteps/);
  });

  it('terminates immediately if model returns no tool_calls', async () => {
    const graph = buildAgentGraph({
      tools: BUILTIN_TOOLS,
      model: async () => new AIMessage({ content: 'hello world' }),
    });
    const result = await graph.invoke({ messages: [new HumanMessage('say hi')] });
    expect(result.messages.length).toBe(2);
    expect((result.messages[1] as AIMessage).content).toBe('hello world');
  });
});
