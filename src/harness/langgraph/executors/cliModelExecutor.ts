/**
 * CLI-backed ModelExecutor for the tool-using agent loop.
 *
 * Most CLIs (claude / codex / kimi) return free-form text, not OpenAI-style
 * tool_calls. This adapter wraps a CLI text executor with:
 *
 *   1. A structured prompt that describes the available tools in JSON schema.
 *   2. Instructions telling the model to respond with ONE of:
 *      - {"tool_calls": [{"name": ..., "args": {...}}]}   ← tool use
 *      - {"final": "..."}                                 ← direct answer
 *   3. Tolerant parsing (strips code fences, locates first JSON object).
 *
 * The result is a LangChain `AIMessage` with `tool_calls` populated when
 * applicable — drop-in compatible with `buildAgentGraph`.
 */
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import type { ModelExecutor } from '../agentGraph';
import type { CliBackend } from './cliExecutor';
import { makeCliTextExecutor } from './cliExecutor';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface CliModelExecutorOpts {
  backend: CliBackend;
  tools: StructuredTool[];
  workDir?: string;
  timeoutSecs?: number;
  /** Extra system instructions prepended to the tool-call protocol prompt. */
  extraSystem?: string;
  /** Test-only injection of a pre-built text executor. */
  textExecutor?: (prompt: string) => Promise<string>;
}

/** Convert a StructuredTool to a JSON-schema block the model can read. */
function describeTool(t: StructuredTool): Record<string, unknown> {
  let schema: unknown = {};
  try {
    schema = t.schema ? zodToJsonSchema(t.schema as any) : {};
  } catch { schema = {}; }
  return { name: t.name, description: t.description ?? '', parameters: schema };
}

const PROTOCOL_PROMPT = (tools: StructuredTool[], extra?: string) => [
  extra?.trim() || '',
  '',
  'You are an agent that uses tools to accomplish user requests.',
  'Respond with exactly one JSON object — no prose before or after, no markdown fences.',
  '',
  'Format (choose ONE):',
  '  Tool call:  {"tool_calls":[{"name":"<tool>","args":{...}}, ...]}',
  '  Final:      {"final":"<answer text>"}',
  '',
  'Tools available:',
  JSON.stringify(tools.map(describeTool), null, 2),
].filter(Boolean).join('\n');

function renderMessages(messages: BaseMessage[]): string {
  return messages.map((m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (m instanceof HumanMessage) return `USER: ${content}`;
    if (m instanceof AIMessage) {
      if (m.tool_calls && m.tool_calls.length > 0) {
        return `ASSISTANT: ${JSON.stringify({ tool_calls: m.tool_calls.map((tc) => ({ name: tc.name, args: tc.args })) })}`;
      }
      return `ASSISTANT: ${content}`;
    }
    if (m instanceof ToolMessage) return `TOOL[${m.tool_call_id}]: ${content}`;
    if (m instanceof SystemMessage) return `SYSTEM: ${content}`;
    return content;
  }).join('\n\n');
}

/** Extract first JSON object from text (tolerates code fences & surrounding prose). */
export function extractFirstJsonObject(raw: string): unknown | null {
  if (!raw) return null;
  const cleaned = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try { return JSON.parse(cleaned); } catch { /* keep trying */ }
  // Find first balanced {...} using brace counting (string-aware).
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const slice = cleaned.slice(start, i + 1);
        try { return JSON.parse(slice); } catch { /* keep scanning */ }
        start = -1;
      }
    }
  }
  return null;
}

/** Build an AIMessage from the parsed JSON object (tolerates shape drift). */
function toAIMessage(parsed: unknown, raw: string): AIMessage {
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const tcs = Array.isArray(obj.tool_calls) ? obj.tool_calls : null;
    if (tcs && tcs.length > 0) {
      const normalized = tcs
        .map((tc, i) => {
          if (!tc || typeof tc !== 'object') return null;
          const o = tc as Record<string, unknown>;
          const name = typeof o.name === 'string' ? o.name : null;
          if (!name) return null;
          const args = (o.args && typeof o.args === 'object')
            ? o.args
            : (o.arguments && typeof o.arguments === 'object' ? o.arguments : {});
          const id = typeof o.id === 'string' ? o.id : `call-${Date.now()}-${i}`;
          return { id, name, args: args as Record<string, unknown> };
        })
        .filter(Boolean) as Array<{ id: string; name: string; args: Record<string, unknown> }>;
      if (normalized.length > 0) {
        return new AIMessage({ content: '', tool_calls: normalized });
      }
    }
    if (typeof obj.final === 'string') {
      return new AIMessage({ content: obj.final });
    }
  }
  // Fallback: treat raw as final content.
  return new AIMessage({ content: raw.trim() });
}

export function makeCliModelExecutor(opts: CliModelExecutorOpts): ModelExecutor {
  const {
    backend, tools, workDir, timeoutSecs, extraSystem,
    textExecutor,
  } = opts;
  const runText = textExecutor || makeCliTextExecutor({ backend, workDir, timeoutSecs });
  const protocol = PROTOCOL_PROMPT(tools, extraSystem);

  return async function modelExec(messages: BaseMessage[]): Promise<AIMessage> {
    const convo = renderMessages(messages);
    const prompt = `${protocol}\n\n---CONVERSATION---\n${convo}\n\n---RESPONSE---\n`;
    let raw = '';
    try {
      raw = await runText(prompt);
    } catch (err) {
      return new AIMessage({ content: `[cliModelExecutor] error: ${String(err)}` });
    }
    const parsed = extractFirstJsonObject(raw);
    return toAIMessage(parsed, raw);
  };
}
