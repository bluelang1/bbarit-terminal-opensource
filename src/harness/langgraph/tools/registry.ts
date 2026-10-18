/**
 * Tool registry — first-class tools exposed to LangGraph agent loops.
 *
 * Each tool is defined with @langchain/core's `tool()` helper so ToolNode
 * can invoke them automatically based on the model's tool_calls.
 *
 * Adding a new tool: write `src/harness/langgraph/tools/myTool.ts` that
 * exports a `tool(...)` instance, then include it in `BUILTIN_TOOLS`.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/** Simple echo — useful for tests & smoke checks. */
export const echoTool = tool(
  async ({ text }): Promise<string> => `echo: ${text}`,
  {
    name: 'echo',
    description: 'Echoes the provided text back to the caller.',
    schema: z.object({ text: z.string().describe('Text to echo.') }),
  },
);

/** Arithmetic — runs locally, no network. */
export const mathTool = tool(
  async ({ op, a, b }): Promise<string> => {
    switch (op) {
      case 'add': return String(a + b);
      case 'sub': return String(a - b);
      case 'mul': return String(a * b);
      case 'div':
        if (b === 0) throw new Error('division by zero');
        return String(a / b);
    }
  },
  {
    name: 'math',
    description: 'Performs a basic arithmetic operation on two numbers.',
    schema: z.object({
      op: z.enum(['add', 'sub', 'mul', 'div']).describe('Operation to perform.'),
      a: z.number().describe('First operand.'),
      b: z.number().describe('Second operand.'),
    }),
  },
);

/** Current time — no args. */
export const timeTool = tool(
  async (): Promise<string> => new Date().toISOString(),
  {
    name: 'time',
    description: 'Returns the current time in ISO 8601 format.',
    schema: z.object({}),
  },
);

export const BUILTIN_TOOLS = [echoTool, mathTool, timeTool];

export function findTool(name: string) {
  return BUILTIN_TOOLS.find((t) => t.name === name);
}
