/**
 * wikilinkHandlers.ts
 *
 * Click handler for note/document links inside a CodeMirror 6 editor.
 * Detects regular clicks on [[wikilink]] and markdown [label](target) links.
 */

import { EditorView } from '@codemirror/view';
import { findMarkdownLinkAtPosition, findWikiLinkAtPosition } from './wikilinkParser';

/**
 * Create a CM6 domEventHandlers extension for wikilink click navigation.
 *
 * @param onNavigate - called with the wikilink target string when a link is clicked.
 */
export function createWikilinkClickHandler(
  onNavigate: (target: string) => void,
): ReturnType<typeof EditorView.domEventHandlers> {
  return EditorView.domEventHandlers({
    click(event: MouseEvent, view: EditorView) {
      const target = event.target as HTMLElement;
      let pos = -1;
      try {
        pos = view.posAtDOM(target, 0);
      } catch {
        pos = -1;
      }
      if (pos < 0) return false;
      const text = view.state.doc.toString();
      const wikiLink = findWikiLinkAtPosition(text, pos);
      const markdownLink = findMarkdownLinkAtPosition(text, pos);
      // Preserve the heading part so the click handler can scroll to it
      const wikiTarget = wikiLink
        ? (wikiLink.heading ? `${wikiLink.target}#${wikiLink.heading}` : wikiLink.target)
        : undefined;
      const linkTarget = wikiTarget || markdownLink?.target;

      if (linkTarget) {
        event.preventDefault();
        event.stopPropagation();
        onNavigate(linkTarget);
        return true;
      }

      return false;
    },
  });
}
