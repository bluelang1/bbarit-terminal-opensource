export type TerminalCliType =
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

export function isInteractiveAgentTerminal(cliType: string | undefined): boolean {
  return Boolean(cliType && cliType !== 'shell');
}

export function terminalSubmitDelayMs(text: string): number {
  return Math.min(5000, Math.max(1200, 600 + Math.ceil(text.length / 2)));
}
