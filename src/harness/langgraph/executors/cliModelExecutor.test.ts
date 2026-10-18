import { describe, it, expect } from 'vitest';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { makeCliModelExecutor, extractFirstJsonObject } from './cliModelExecutor';
import { BUILTIN_TOOLS, buildAgentGraph, echoTool, mathTool } from '../index';

describe('extractFirstJsonObject', () => {
  it('parses plain JSON object', () => {
    expect(extractFirstJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it('tolerates json code fences', () => {
    expect(extractFirstJsonObject('```json\n{"x":2}\n```')).toEqual({ x: 2 });
  });
  it('extracts first object from surrounding prose', () => {
    const r = extractFirstJsonObject('Here you go: {"ok":true} — done');
    expect(r).toEqual({ ok: true });
  });
  it('handles nested objects and strings with braces', () => {
    const r = extractFirstJsonObject('prefix {"nested":{"k":"v}"}} suffix');
    expect(r).toEqual({ nested: { k: 'v}' } });
  });
  it('returns null for invalid input', () => {
    expect(extractFirstJsonObject('nothing valid here')).toBeNull();
  });
});

describe('makeCliModelExecutor', () => {
  it('parses tool_calls JSON into AIMessage with tool_calls[]', async () => {
    const model = makeCliModelExecutor({
      backend: 'claude',
      tools: BUILTIN_TOOLS,
      textExecutor: async () => JSON.stringify({
        tool_calls: [{ name: 'math', args: { op: 'add', a: 1, b: 2 } }],
      }),
    });
    const ai = await model([new HumanMessage('1+2?')]);
    expect(ai.tool_calls?.length).toBe(1);
    expect(ai.tool_calls?.[0].name).toBe('math');
    expect(ai.tool_calls?.[0].args).toEqual({ op: 'add', a: 1, b: 2 });
  });

  it('parses final answer JSON into plain AIMessage', async () => {
    const model = makeCliModelExecutor({
      backend: 'claude',
      tools: BUILTIN_TOOLS,
      textExecutor: async () => '```json\n{"final":"the answer is 3"}\n```',
    });
    const ai = await model([new HumanMessage('hi')]);
    expect(ai.content).toBe('the answer is 3');
    expect(ai.tool_calls ?? []).toEqual([]);
  });

  it('falls back to raw text when output is not JSON', async () => {
    const model = makeCliModelExecutor({
      backend: 'claude',
      tools: BUILTIN_TOOLS,
      textExecutor: async () => 'just some prose answer',
    });
    const ai = await model([new HumanMessage('hi')]);
    expect(ai.content).toBe('just some prose answer');
  });

  it('drives a full agent graph loop against scripted CLI responses', async () => {
    let turn = 0;
    const model = makeCliModelExecutor({
      backend: 'claude',
      tools: [echoTool, mathTool],
      textExecutor: async () => {
        turn++;
        if (turn === 1) return JSON.stringify({
          tool_calls: [{ name: 'math', args: { op: 'mul', a: 6, b: 7 } }],
        });
        return JSON.stringify({ final: 'Result is 42.' });
      },
    });
    const graph = buildAgentGraph({
      tools: [echoTool, mathTool],
      model,
    });
    const result = await graph.invoke({ messages: [new HumanMessage('6 times 7')] });
    const toolMsg = result.messages.find((m) => m instanceof ToolMessage) as ToolMessage;
    expect(toolMsg.content).toBe('42');
    const finalAi = result.messages[result.messages.length - 1] as AIMessage;
    expect(finalAi.content).toBe('Result is 42.');
  });
});
