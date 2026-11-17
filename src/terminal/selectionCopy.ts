// Copy-on-select bookkeeping for one terminal.
//
// Two things used to go wrong (the clipboard kept returning to older text):
// - the mouseup handler re-copied a selection that was still on screen on every
//   click anywhere in the app, overwriting whatever was copied since;
// - the "last selection" fallback used by Cmd/Ctrl+C and right-click was never
//   forgotten, so with no selection left it copied text from long ago, also
//   over a fresh OSC 52 copy made by a TUI that owns the mouse (Claude Code).
export interface SelectionCopyState {
  /** xterm reported a selection change; `has` = a selection exists now. */
  selectionChanged(has: boolean): void;
  /** Mouse released: the text to copy now, or null when it was copied already. */
  takeForAutoCopy(selection: string): string | null;
  /** The program copied `text` itself (OSC 52). `clearing` = we are about to
   *  clear a visible xterm selection, whose change event must not forget it. */
  programCopied(text: string, clearing: boolean): void;
  /** Fallback text for an explicit copy when nothing is selected. */
  last(): string;
}

export function createSelectionCopyState(): SelectionCopyState {
  let dirty = false;
  let last = '';
  let keepOnNextEmpty = false;
  return {
    selectionChanged(has) {
      if (has) {
        dirty = true;
        keepOnNextEmpty = false;
        return;
      }
      dirty = false;
      if (keepOnNextEmpty) keepOnNextEmpty = false;
      else last = '';
    },
    takeForAutoCopy(selection) {
      if (!dirty || !selection) return null;
      dirty = false;
      last = selection;
      return selection;
    },
    programCopied(text, clearing) {
      dirty = false;
      last = text;
      keepOnNextEmpty = clearing;
    },
    last: () => last,
  };
}
