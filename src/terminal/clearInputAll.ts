// "Clear all input" for agent TUIs (Claude Code, Codex, ...). The single-line
// button sends Ctrl+E Ctrl+U, which empties only the line the cursor is on.
// To empty a multi-line prompt, repeat: Backspace (join with the line above),
// Ctrl+E (end of that line), Ctrl+U (kill to its start). Each step is its own
// small write with a short pause, because a large burst of bytes is treated
// as a paste by these TUIs and the control keys would be ignored.

export const CLEAR_LINE = '\x05\x15';
export const CLEAR_PREVIOUS_LINE = '\x7f\x05\x15';

/** Upper bound of lines removed per click; prompts are rarely longer. */
export const CLEAR_ALL_MAX_LINES = 60;

export function clearAllInputSteps(maxLines = CLEAR_ALL_MAX_LINES): string[] {
  const steps = [CLEAR_LINE];
  for (let i = 1; i < maxLines; i += 1) steps.push(CLEAR_PREVIOUS_LINE);
  return steps;
}

export async function runClearAllInput(
  write: (data: string) => void,
  options: { maxLines?: number; delayMs?: number; isCancelled?: () => boolean } = {},
): Promise<void> {
  const { maxLines = CLEAR_ALL_MAX_LINES, delayMs = 8, isCancelled } = options;
  for (const step of clearAllInputSteps(maxLines)) {
    if (isCancelled?.()) return;
    write(step);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
