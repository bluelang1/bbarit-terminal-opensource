/**
 * wikilinkCompletion.ts
 *
 * CodeMirror 6 autocompletion source for [[wikilink]] syntax.
 * Completes note titles, frontmatter aliases, and [[note#heading]] targets.
 * Uses a factory pattern so it does not directly depend on NoteContext.
 */

import { CompletionContext } from '@codemirror/autocomplete';
import type { Completion, CompletionResult } from '@codemirror/autocomplete';

export interface NoteCompletionItem {
  path: string;
  title: string;
  aliases?: string[];
  headings?: string[];
}

/**
 * Factory: creates a CM6 autocompletion source for wikilinks.
 *
 * @param getNotes - callback that returns the current list of note items.
 *                   Defaults to returning an empty array if not provided.
 */
export function createWikilinkCompletion(
  getNotes: () => NoteCompletionItem[] = () => [],
) {
  return (context: CompletionContext): CompletionResult | null => {
    // Match [[ followed by optional text (no ] or newline)
    const before = context.matchBefore(/\[\[[^\]\n]*$/);
    if (!before) return null;

    const query = before.text.slice(2); // strip the leading [[
    const notes = getNotes();

    // [[note#... -> complete headings of the target note
    const hashIdx = query.indexOf('#');
    if (hashIdx !== -1) {
      const notePart = query.slice(0, hashIdx).trim().toLowerCase();
      const headingQuery = query.slice(hashIdx + 1).toLowerCase();
      const note = notes.find((n) =>
        n.title.toLowerCase() === notePart ||
        (n.aliases || []).some((a) => a.toLowerCase() === notePart),
      );
      const headings = note?.headings || [];
      const filtered = headingQuery
        ? headings.filter((h) => h.toLowerCase().includes(headingQuery))
        : headings;
      if (filtered.length === 0) return null;
      return {
        from: before.from + 2 + hashIdx + 1, // start after #
        options: filtered.map((heading) => ({
          label: heading,
          apply: `${heading}]]`,
          type: 'text' as const,
        })),
      };
    }

    // Filter notes by query (case-insensitive substring match on title + aliases)
    const lowerQuery = query.toLowerCase();
    const options: Completion[] = [];
    for (const note of notes) {
      if (!lowerQuery || note.title.toLowerCase().includes(lowerQuery)) {
        options.push({
          label: note.title,
          detail: note.path,
          apply: `${note.title}]]`,
          type: 'text' as const,
        });
      }
      for (const alias of note.aliases || []) {
        if (!lowerQuery || alias.toLowerCase().includes(lowerQuery)) {
          options.push({
            label: alias,
            detail: `→ ${note.title}`,
            apply: `${note.title}|${alias}]]`,
            type: 'text' as const,
          });
        }
      }
    }

    return {
      from: before.from + 2, // start after [[
      options,
    };
  };
}
