/**
 * unlinkedMentions.ts
 *
 * Obsidian-style "Unlinked mentions": find notes whose text mentions the
 * current note's name/title/aliases without linking to it via [[wikilink]].
 * Uses the Rust search_files command for vault-wide content search.
 */

import { invoke } from '@tauri-apps/api/core';

interface SearchFileResult {
  path: string;
  name: string;
  matches: { line_number: number; line_text: string }[];
  is_name_match: boolean;
}

export interface UnlinkedMention {
  path: string;
  name: string;
  line: number;
  lineText: string;
  term: string;
}

/**
 * True when the line contains `term` outside of any [[wikilink]] span.
 */
export function lineHasUnlinkedMention(line: string, term: string): boolean {
  const stripped = line.replace(/!?\[\[[^\]]*\]\]/g, '');
  return stripped.toLowerCase().includes(term.toLowerCase());
}

/**
 * Collect the search terms for a note: file name, title, and aliases.
 * Very short terms (<3 chars) are dropped to avoid noise.
 */
export function mentionTerms(name: string, title: string, aliases: string[] | undefined): string[] {
  const terms = [...new Set([name, title, ...(aliases || [])].map(t => t.trim()).filter(Boolean))];
  return terms.filter(t => t.length >= 3);
}

/**
 * Search the vault for unlinked mentions of the given terms.
 * Excludes the note itself and notes that already link to it.
 */
export async function findUnlinkedMentions(opts: {
  notesDir: string;
  currentPath: string;
  terms: string[];
  linkedPaths: Set<string>;
}): Promise<UnlinkedMention[]> {
  const { notesDir, currentPath, terms, linkedPaths } = opts;
  const seen = new Set<string>();
  const mentions: UnlinkedMention[] = [];

  for (const term of terms) {
    let results: SearchFileResult[];
    try {
      results = await invoke<SearchFileResult[]>('search_files', {
        root: notesDir,
        query: term,
        searchContent: true,
        limit: 100,
      });
    } catch {
      continue;
    }
    for (const result of results) {
      if (!result.path.toLowerCase().endsWith('.md')) continue;
      if (result.path === currentPath) continue;
      if (linkedPaths.has(result.path)) continue;
      if (seen.has(result.path)) continue;
      const match = result.matches.find(m => lineHasUnlinkedMention(m.line_text, term));
      if (!match) continue;
      seen.add(result.path);
      mentions.push({
        path: result.path,
        name: result.name.replace(/\.md$/i, ''),
        line: match.line_number,
        lineText: match.line_text.trim(),
        term,
      });
    }
  }

  return mentions;
}
