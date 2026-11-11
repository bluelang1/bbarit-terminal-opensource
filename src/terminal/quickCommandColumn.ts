// Quick commands shown in each terminal's floating button column (bottom-right).
// The first `!!` entry becomes the rerun slot between "clear all input" and "clear terminal";
// the rest follow a divider in config order. Entries with an empty command did nothing when
// clicked, so they are not shown at all.

export interface QuickCommandLike {
  command: string;
}

export interface QuickCommandColumn<T extends QuickCommandLike> {
  rerun?: T;
  custom: T[];
}

export const RERUN_COMMAND = '!!';

export function quickCommandColumn<T extends QuickCommandLike>(commands: readonly T[] | undefined): QuickCommandColumn<T> {
  let rerun: T | undefined;
  const custom: T[] = [];
  for (const cmd of commands ?? []) {
    const trimmed = (cmd.command ?? '').trim();
    if (!trimmed) continue;
    if (!rerun && trimmed === RERUN_COMMAND) rerun = cmd;
    else custom.push(cmd);
  }
  return { rerun, custom };
}

// The three defaults are stored with Korean names; show them in the UI language.
const DEFAULT_NAME_KEYS: Record<string, [string, string]> = {
  '다시실행해': ['settings.terminal.quickCommands.rerun', 'Run again'],
  '컴파일해': ['settings.terminal.quickCommands.compile', 'Compile'],
  '해줘': ['settings.terminal.quickCommands.doIt', 'Do it'],
};

export function quickCommandDisplayName(name: string, t: (key: never, fallback?: string) => string): string {
  const mapped = DEFAULT_NAME_KEYS[name];
  return mapped ? t(mapped[0] as never, mapped[1]) : name;
}
