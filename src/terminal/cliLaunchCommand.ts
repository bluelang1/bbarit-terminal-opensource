// POSIX launch lines for agent CLI tabs. The PTY shell off Windows is always
// `/bin/zsh -l` (pty_backend::build_shell_command), so this is sh/bash/zsh syntax;
// fish is not a PTY shell here. Windows launches the bare command instead.
//
// Shape: `if command -v <bin> …; then <cmd>; else echo "<bin> CLI not found. …"; fi`.
// Not `command -v <bin> && <cmd> || echo …`: with `A && B || C` the echo also runs
// when the CLI is installed but exits non-zero, which printed "CLI not found" for
// an installed CLI. cliInstallGuard matches the echo only at the start of a line,
// so the echoed command itself (`… else echo "…"`) is not a match.

export interface CliFallback {
  /** Binary that must be on PATH for the fallback to run (e.g. `npx`). */
  binName: string;
  /** Command to run when the main binary is missing but `binName` is present. */
  cmd: string;
}

const onPath = (bin: string): string => `command -v ${bin} >/dev/null 2>&1`;

export function cliNotFoundMessage(binName: string, installHint?: string): string {
  return `${binName} CLI not found.${installHint ? ` Install: ${installHint}` : ''}`;
}

/**
 * Run `cmd` when `binName` is on PATH, else `fallback.cmd` when its binary is on
 * PATH, else print the not-found line. The chosen command's exit status and output
 * are left alone.
 */
export function wrapPosixCliCheck(cmd: string, binName: string, installHint?: string, fallback?: CliFallback): string {
  const missing = `echo "${cliNotFoundMessage(binName, installHint)}"`;
  const alt = fallback ? ` elif ${onPath(fallback.binName)}; then ${fallback.cmd};` : '';
  return `if ${onPath(binName)}; then ${cmd};${alt} else ${missing}; fi`;
}
