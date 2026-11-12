// Layout modes that stack every terminal of the project on top of each other and
// show only the active one (the rest sit underneath at opacity 0). Those hidden
// panes are also `inert`, so Tab cannot walk into a terminal or its buttons that
// are not on screen. Split/grid modes show every pane and never mark one inert.

const STACKED_MODES: ReadonlySet<string> = new Set(['tabs', 'tiled', 'tiled_tb', 'tree']);

/** True when `mode` shows only the active terminal of a stack (see App's calculateTerminalPosition). */
export function isStackedTerminalMode(mode: string): boolean {
  return STACKED_MODES.has(mode);
}

/** True for a pane that is in the DOM but not visible: a non-active terminal in a stacked mode. */
export function isHiddenStackedPane(mode: string, isActive: boolean): boolean {
  return !isActive && isStackedTerminalMode(mode);
}
