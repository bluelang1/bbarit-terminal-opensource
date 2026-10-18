/**
 * CLI executor adapter — wraps BBARIT's `run_cli_oneshot` Tauri command so
 * LangGraph nodes (decompose/subAgent/synthesize/etc.) can invoke a real CLI.
 *
 * Supports three backends: Claude, Codex, Kimi.
 *   - claude : `cat <tmp> | claude -p --output-format text`
 *   - codex  : `cat <tmp> | codex exec --skip-git-repo-check - 2>&1`
 *   - kimi   : `kimi --quiet -p "$(cat <tmp>)"`
 *
 * The prompt is written to a temp file to avoid shell escaping issues with
 * newlines/quotes, mirroring `src/components/debateEngine.ts`.
 */
import { invoke } from '@tauri-apps/api/core';

export type CliBackend = 'claude' | 'codex' | 'kimi';

export interface CliExecutorOpts {
  backend: CliBackend;
  workDir?: string;
  /** Seconds before the one-shot is killed. Default 180. */
  timeoutSecs?: number;
  /** Optional system prompt prepended to every call. */
  systemPrompt?: string;
  /** Allows tests to mock the Tauri invoke. */
  invoker?: (command: string, args: Record<string, unknown>) => Promise<string>;
  /** Allows tests to mock the file writer (write_file). */
  fileWriter?: (path: string, content: string) => Promise<void>;
}

/**
 * Return an async function that takes a prompt and returns the CLI's stdout.
 * Compatible with `DecomposeExecutor`, `SubAgentExecutor`, `SynthesizeExecutor`,
 * `StageExecutor`, and can drive a `ModelExecutor` after wrapping.
 */
export function makeCliTextExecutor(opts: CliExecutorOpts): (prompt: string) => Promise<string> {
  const {
    backend,
    workDir,
    timeoutSecs = 180,
    systemPrompt,
    invoker = (cmd, a) => invoke<string>(cmd as any, a as any),
    fileWriter = async (path, content) => { await invoke('write_file', { path, content }); },
  } = opts;

  return async function runCliText(prompt: string): Promise<string> {
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const tmpPath = `/tmp/octo-lg-${ts}-${rand}-${backend}.txt`;
    await fileWriter(tmpPath, fullPrompt);
    const cmd = buildCliCommand(backend, tmpPath);
    try {
      const out = await invoker('run_cli_oneshot', { command: cmd, workDir, timeoutSecs });
      return String(out || '').trim();
    } finally {
      // best-effort cleanup (ignore errors)
      try { await invoker('run_cli_oneshot', { command: `rm -f '${tmpPath}'`, timeoutSecs: 5 }); } catch { /* noop */ }
    }
  };
}

function buildCliCommand(backend: CliBackend, tmpPath: string): string {
  switch (backend) {
    case 'claude':
      return `cat '${tmpPath}' | claude -p --output-format text`;
    case 'codex':
      // codex exec reads stdin via '-', prints to stdout, errors to stderr
      return `cat '${tmpPath}' | codex exec --skip-git-repo-check -`;
    case 'kimi':
      return `kimi --quiet -p "$(cat '${tmpPath}')"`;
  }
}
