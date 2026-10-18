// Window-level editor shortcut handlers must not steal keys typed into another
// surface (terminal, chat input, another editor pane). Focus on <body> counts as
// the editor's own — grid/canvas clicks leave nothing focused.
export function focusOutsideEditor(root: HTMLElement | null, e: Event): boolean {
  const active = document.activeElement;
  const el = active && active !== document.body ? active : e.target;
  if (!(el instanceof HTMLElement) || el === document.body) return false;
  return !root || !root.contains(el);
}
