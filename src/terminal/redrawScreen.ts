// "Redraw screen" button in the terminal's right strip (XTerminal `[data-terminal-gutter]`).
//
// Claude Code repaints incrementally; when the screen gets out of sync, Ctrl+L forces a full
// redraw. Claude Code changelog (installed 2.1.322, ~/.claude/cache/changelog.md):
//   2.1.126 "Fixed `Ctrl+L` clearing the prompt input — it now only forces a screen redraw,
//            matching readline behavior"
//   2.1.280 "Reverted `ctrl+l` / `cmd+k` in fullscreen mode clearing the transcript view …;
//            they redraw the screen again"
// so the key is safe with a half-typed prompt and works in the fullscreen (alternate buffer) TUI.
//
// Codex is left out on purpose: its TUI (codex-cli 0.147) ships "Ctrl+L is disabled while a task
// is in progress." next to the ClearUi event behind `/clear` ("clear the terminal and start a new
// chat"), so Ctrl+L there is a clear, not a pure repaint. Plain shells are left out too: Ctrl+L is
// the shell's own clear-screen, which the strip's Clear terminal button already covers.
//
// The byte goes through queueButtonInput with `submit: false` (raw, no bracketed paste, no Enter);
// the last-command tracker ignores C0 control bytes it does not know, so it never records it.

/** Ctrl+L (form feed). */
export const CLAUDE_REDRAW_KEY = '\x0c';

/** Bytes the redraw button sends for this tab's CLI, or null when the tab gets no button. */
export function redrawScreenKeyFor(cliType: string | undefined): string | null {
  return cliType === 'claude' ? CLAUDE_REDRAW_KEY : null;
}
