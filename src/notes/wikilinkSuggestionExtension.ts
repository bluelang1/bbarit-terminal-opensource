/**
 * wikilinkSuggestionExtension.ts
 *
 * CodeMirror 6 extension that shows dotted underline decorations on text
 * that matches other note titles (potential wikilinks).
 * Clicking on a suggestion wraps the matched text with [[ ]].
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import type { NoteIndexEntry } from './noteState';
import { findWikilinkSuggestions, type WikilinkSuggestion } from './wikilinkSuggestion';

/** CSS class applied to suggestion marks */
const SUGGESTION_CLASS = 'cm-wikilink-suggestion';

/** Debounce delay in ms before recomputing suggestions after a doc change */
const DEBOUNCE_MS = 500;

/**
 * Create a CodeMirror extension that shows dotted underline decorations
 * on text that matches other note titles (potential wikilinks).
 * Clicking on a suggestion wraps it with [[ ]].
 */
export function wikilinkSuggestionExtension(
  getNoteIndex: () => NoteIndexEntry[],
  getCurrentPath: () => string,
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      suggestions: WikilinkSuggestion[];
      debounceTimer: ReturnType<typeof setTimeout> | null;

      constructor(view: EditorView) {
        this.debounceTimer = null;
        this.suggestions = [];
        this.decorations = Decoration.none;
        // Compute initial decorations asynchronously
        this.scheduleUpdate(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.scheduleUpdate(update.view);
        }
      }

      scheduleUpdate(view: EditorView) {
        if (this.debounceTimer !== null) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.computeDecorations(view);
        }, DEBOUNCE_MS);
      }

      computeDecorations(view: EditorView) {
        const content = view.state.doc.toString();
        const noteIndex = getNoteIndex();
        const currentPath = getCurrentPath();

        this.suggestions = findWikilinkSuggestions(content, noteIndex, currentPath);
        this.decorations = this.buildDecorationSet();

        // Force the editor to re-render decorations
        view.dispatch({ effects: [] });
      }

      buildDecorationSet(): DecorationSet {
        if (this.suggestions.length === 0) return Decoration.none;

        const builder = new RangeSetBuilder<Decoration>();

        // Suggestions are already sorted by position from findWikilinkSuggestions
        for (const s of this.suggestions) {
          builder.add(
            s.from,
            s.to,
            Decoration.mark({
              class: SUGGESTION_CLASS,
              attributes: {
                'data-suggestion-path': s.targetPath,
                'data-suggestion-title': s.targetTitle,
                title: `Link to "${s.targetTitle}" — click to create wikilink`,
              },
            }),
          );
        }

        return builder.finish();
      }

      destroy() {
        if (this.debounceTimer !== null) {
          clearTimeout(this.debounceTimer);
        }
      }
    },
    {
      decorations: (v) => v.decorations,

      eventHandlers: {
        click(event: MouseEvent, view: EditorView) {
          const target = event.target as HTMLElement;
          const suggestionEl = target.closest(`.${SUGGESTION_CLASS}`) as HTMLElement | null;
          if (!suggestionEl) return false;

          // Find the position of the click in the document
          const pos = view.posAtDOM(target);
          const content = view.state.doc.toString();

          // Find which suggestion this click corresponds to
          const plugin = view.plugin(wikilinkSuggestionPlugin);
          if (!plugin) return false;

          const matched = plugin.suggestions.find(
            (s) => pos >= s.from && pos <= s.to,
          );
          if (!matched) return false;

          // Verify the text at the position still matches
          const currentText = content.slice(matched.from, matched.to);
          if (currentText !== matched.matchText) return false;

          event.preventDefault();
          event.stopPropagation();

          // Wrap the text with [[ ]]
          view.dispatch({
            changes: [
              { from: matched.to, insert: ']]' },
              { from: matched.from, insert: '[[' },
            ],
          });

          return true;
        },
      },
    },
  );

  // Store reference so we can access it from the click handler
  const wikilinkSuggestionPlugin = plugin;

  return plugin;
}
