/**
 * wikilinkExtension.ts
 *
 * CodeMirror 6 ViewPlugin + Decoration that highlights [[wikilink]] syntax.
 * Applies CSS classes: cm-wikilink (whole range), cm-wikilink-bracket (the [[ ]]),
 * and cm-wikilink-target (the inner target/alias text).
 */

import { RangeSetBuilder } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';

const WIKILINK_REGEX = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

// Decoration marks
const wikilinkMark = Decoration.mark({ class: 'cm-wikilink', attributes: { 'data-wikilink': 'true' } });
const bracketMark = Decoration.mark({ class: 'cm-wikilink-bracket' });
const targetMark = Decoration.mark({ class: 'cm-wikilink-target' });

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();

  // We need to add decorations in document order, so collect them first
  const decos: Array<{ from: number; to: number; deco: Decoration }> = [];

  const regex = new RegExp(WIKILINK_REGEX.source, WIKILINK_REGEX.flags);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;

    // Whole wikilink
    decos.push({ from, to, deco: wikilinkMark });
    // Opening bracket [[
    decos.push({ from, to: from + 2, deco: bracketMark });
    // Closing bracket ]]
    decos.push({ from: to - 2, to, deco: bracketMark });
    // Inner target text (after [[ before | or ]])
    const innerFrom = from + 2;
    const innerTo = to - 2;
    if (innerTo > innerFrom) {
      decos.push({ from: innerFrom, to: innerTo, deco: targetMark });
    }
  }

  // Sort by from position, then by range length (wider first for nesting)
  decos.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from));

  for (const d of decos) {
    builder.add(d.from, d.to, d.deco);
  }

  return builder.finish();
}

/**
 * CodeMirror extension that highlights [[wikilink]] text with CSS classes.
 */
export function wikilinkExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
