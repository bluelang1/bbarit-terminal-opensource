// Whether a refit changed the terminal grid, i.e. whether the PTY must be told its new size.
// Zero or missing sizes (terminal not laid out yet) never count as a change.
export interface GridSize { cols: number; rows: number }

export function ptySizeChanged(before: GridSize, after: GridSize): boolean {
  if (!(after.cols > 0) || !(after.rows > 0)) return false;
  return before.cols !== after.cols || before.rows !== after.rows;
}
