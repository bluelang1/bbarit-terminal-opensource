export type AgentCliKind =
  | 'shell'
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'opencode'
  | 'kimi'
  | 'gemini'
  | 'ollama'
  | 'qwen'
  | 'pi'
  | 'reasonix'
  | 'bbarit'
  | 'bbarit-oss'
  | 'gajae';

const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

export function stripTerminalControls(text: string): string {
  return String(text || '')
    .replace(ANSI_RE, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// Cline VscodeTerminalProcess.ts:331 removeLastLineArtifacts — strip a single
// trailing prompt char (`% $ # >`) + trailing whitespace from ONLY the last line,
// so a leftover prompt artifact (e.g. zsh `% `) doesn't skew banner/agent-UI matching.
// NOTE: deliberately NOT applied inside looksLikePlainShellPrompt — that check keys
// on the very `>`/`PS …>` this would eat. Use it where eating a prompt char is safe.
export function removeLastLineArtifacts(output: string): string {
  const lines = String(output || '').trimEnd().split('\n');
  if (lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/[%$#>]\s*$/, '');
  }
  return lines.join('\n').trimEnd();
}

// Cline integrations/terminal/constants.ts:85 — compile/build output should extend
// the "settle" window so a mid-build pause (vite/tsc/webpack) isn't misread as ready.
// A terminating word ("compiled"/"done"/"error") nullifies the hold immediately.
const COMPILING_MARKERS = ['compiling', 'building', 'bundling', 'transpiling', 'generating', 'starting'];
const COMPILING_NULLIFIERS = ['compiled', 'success', 'finish', 'complete', 'succeed', 'done',
  'end', 'stop', 'exit', 'terminate', 'error', 'fail'];
export function looksLikeCompiling(text: string): boolean {
  const t = stripTerminalControls(text || '').toLowerCase();
  const hasMarker = COMPILING_MARKERS.some((m) => t.includes(m));
  const hasNullifier = COMPILING_NULLIFIERS.some((n) => t.includes(n));
  return hasMarker && !hasNullifier;
}

// Cline VscodeTerminalProcess.ts:159 — when the broker injects a command, the PTY echoes
// it back. Drop the leading lines that merely echo the injected command (substring match,
// stopping at the first real-output line) so readiness reflects the agent's response, not
// our own keystrokes. Returns `output` unchanged when no injected command is given.
export function stripInjectedEcho(output: string, injected?: string): string {
  const cmd = String(injected || '').trim();
  if (!cmd) return String(output || '');
  const lines = String(output || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed && cmd.includes(trimmed)) { i += 1; continue; }
    break;
  }
  return lines.slice(i).join('\n');
}

export function looksLikeAgentUiReady(cliType: AgentCliKind | undefined, text: string): boolean {
  if (!cliType || cliType === 'shell') return true;
  const visible = removeLastLineArtifacts(stripTerminalControls(text));
  if (!visible.trim()) return false;
  if (cliType === 'codex') {
    return /OpenAI\s+Codex|Codex\s*\(v|model:\s*.+|directory:\s*.+|permissions:\s*.+|Tip:\s+.*Codex/i.test(visible);
  }
  if (cliType === 'claude') {
    return /Claude\s+Code|Welcome\s+(?:to\s+Claude|back)|Claude\s+(?:Max|Opus|Sonnet|Haiku)|Opus\s+\d|bypass\s+permissions\s+on|cwd:\s*.+|accept\s+edits/i.test(visible);
  }
  if (cliType === 'cursor') return /Cursor\s+Agent|cursor-agent|model:\s*.+|permissions:\s*.+/i.test(visible);
  if (cliType === 'qwen') return /Qwen\s+Code|qwen/i.test(visible);
  if (cliType === 'gemini') return /Gemini/i.test(visible);
  if (cliType === 'kimi') return /Kimi/i.test(visible);
  if (cliType === 'reasonix') return /Reasonix/i.test(visible);
  if (cliType === 'bbarit') return /Tab to complete|bbarit/i.test(visible);
  if (cliType === 'bbarit-oss') return /Tab to complete|bbarit-oss|bbarit/i.test(visible);
  if (cliType === 'gajae') return /Gajae|gajae|\bgjc\b|deep-interview|ralplan|ultragoal/i.test(visible);
  if (cliType === 'opencode') return /OpenCode|opencode/i.test(visible);
  if (cliType === 'pi') return /\bPi\b|coding agent/i.test(visible);
  return true;
}

export function looksLikePlainShellPrompt(text: string): boolean {
  const visible = stripTerminalControls(text || '').trimEnd();
  if (!visible) return false;
  const tail = visible.split(/\r?\n/).slice(-4).join('\n');
  return /(?:^|\n)\s*PS\s+[^>\n]+>\s*$/i.test(tail)
    || /(?:^|\n)\s*PS\s+[\s\S]{1,500}>\s*$/i.test(tail)
    || /(?:^|\n)\s*[A-Za-z]:\\[^>\n]+>\s*$/.test(tail)
    // A lone `>` is the Claude/Codex agent INPUT prompt, not a shell prompt;
    // matching it makes the broker keep re-injecting the CLI start command into
    // an already-running agent. Only `>>`+ (PowerShell continuation) counts here.
    || /(?:^|\n)\s*(?:[$#]|>{2,})\s*$/.test(tail);
}
