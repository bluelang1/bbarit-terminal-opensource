// Routing for keydown events that may arrive while an IME composition is open.
//
// Esc must ALWAYS route to the terminal: pressing Esc in a terminal is a cancel
// intent (agent turn cancel, TUI overlay close), never IME navigation. macOS
// Hangul keeps a composition open indefinitely (the last syllable stays in
// preedit until unrelated typing closes it), so deferring Esc to the IME
// swallowed every press — the "Esc cancel does nothing" bug that hit the
// bbarit/bbarit-oss agent terminals for Korean input.
export type ImeKeyRoute = 'esc' | 'ime' | 'normal';

export function routeKeyDuringComposition(key: string, composing: boolean): ImeKeyRoute {
  if (key === 'Escape') return 'esc';
  return composing ? 'ime' : 'normal';
}
