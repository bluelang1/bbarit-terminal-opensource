/**
 * wikilinkSuggestion.ts
 *
 * Engine for finding places in markdown content where other note titles
 * are mentioned but not wrapped in [[wikilink]] syntax.
 * Returns suggestions sorted by position, limited to 20.
 */

import type { NoteIndexEntry } from './noteState';

export interface WikilinkSuggestion {
  /** Start offset in the content */
  from: number;
  /** End offset in the content */
  to: number;
  /** The matched text */
  matchText: string;
  /** Target note path */
  targetPath: string;
  /** Target note title */
  targetTitle: string;
}

/** Minimum title length to consider for suggestions */
const MIN_TITLE_LENGTH = 3;

/** Maximum suggestions to return */
const MAX_SUGGESTIONS = 20;

// ───────────────────────── Exclusion Zone Helpers ─────────────────────────

interface ExcludeRange {
  from: number;
  to: number;
}

/**
 * Build a list of character ranges that should be excluded from suggestion matching.
 * Excludes: YAML frontmatter, fenced code blocks, inline code, existing wikilinks.
 */
function buildExcludeRanges(content: string): ExcludeRange[] {
  const ranges: ExcludeRange[] = [];

  // 1. YAML frontmatter (--- ... --- at start of document)
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('\n---', 3);
    if (endIdx !== -1) {
      // Include the closing --- line
      const closingEnd = content.indexOf('\n', endIdx + 4);
      ranges.push({ from: 0, to: closingEnd !== -1 ? closingEnd : endIdx + 4 });
    }
  }

  // 2. Fenced code blocks (``` ... ```)
  const fencedRegex = /^(`{3,})[^\n]*\n[\s\S]*?\n\1\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = fencedRegex.exec(content)) !== null) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }

  // 3. Inline code (` ... `)
  const inlineCodeRegex = /`[^`\n]+`/g;
  while ((match = inlineCodeRegex.exec(content)) !== null) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }

  // 4. Existing wikilinks ([[ ... ]])
  const wikilinkRegex = /\[\[[^\]]*\]\]/g;
  while ((match = wikilinkRegex.exec(content)) !== null) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }

  return ranges;
}

/**
 * Check if a given range overlaps with any exclusion zone.
 */
function isExcluded(from: number, to: number, excludes: ExcludeRange[]): boolean {
  for (const ex of excludes) {
    if (from < ex.to && to > ex.from) return true;
  }
  return false;
}

// ───────────────────────── Word Boundary Helpers ─────────────────────────

/**
 * Check if a character is a word boundary (not alphanumeric or CJK).
 * For CJK characters, any position is considered a valid boundary.
 */
function isWordBoundary(content: string, idx: number): boolean {
  if (idx < 0 || idx >= content.length) return true;
  const ch = content.charCodeAt(idx);
  // ASCII letters and digits
  if ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A) || ch === 0x5F) {
    return false;
  }
  return true;
}

// ───────────────────────── Main Function ─────────────────────────

/**
 * Find places in content where other note titles are mentioned but not wikilinked.
 * Excludes: existing [[]] wikilinks, code blocks, frontmatter.
 * Minimum title length: 3 characters.
 * Case-insensitive matching.
 */
export function findWikilinkSuggestions(
  content: string,
  noteIndex: NoteIndexEntry[],
  currentPath: string,
): WikilinkSuggestion[] {
  if (!content || noteIndex.length === 0) return [];

  // Build exclusion zones
  const excludeRanges = buildExcludeRanges(content);

  // Collect candidate titles/names (min length 3), excluding the current note
  const candidates: Array<{ text: string; path: string; title: string }> = [];
  const seenTexts = new Set<string>();

  for (const entry of noteIndex) {
    if (entry.path === currentPath) continue;

    // Add title
    if (entry.title.length >= MIN_TITLE_LENGTH) {
      const lower = entry.title.toLowerCase();
      if (!seenTexts.has(lower)) {
        seenTexts.add(lower);
        candidates.push({ text: entry.title, path: entry.path, title: entry.title });
      }
    }

    // Add filename (name) if different from title
    if (entry.name.length >= MIN_TITLE_LENGTH) {
      const lower = entry.name.toLowerCase();
      if (!seenTexts.has(lower)) {
        seenTexts.add(lower);
        candidates.push({ text: entry.name, path: entry.path, title: entry.title });
      }
    }
  }

  // Sort candidates by length descending so longer matches take priority
  candidates.sort((a, b) => b.text.length - a.text.length);

  const suggestions: WikilinkSuggestion[] = [];
  const occupiedRanges: ExcludeRange[] = [];

  const contentLower = content.toLowerCase();

  for (const candidate of candidates) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;

    const searchText = candidate.text.toLowerCase();
    let searchFrom = 0;

    while (searchFrom < contentLower.length && suggestions.length < MAX_SUGGESTIONS) {
      const idx = contentLower.indexOf(searchText, searchFrom);
      if (idx === -1) break;

      const matchEnd = idx + candidate.text.length;
      searchFrom = matchEnd;

      // Check word boundaries (character before start and after end)
      if (!isWordBoundary(content, idx - 1) || !isWordBoundary(content, matchEnd)) {
        continue;
      }

      // Check exclusion zones
      if (isExcluded(idx, matchEnd, excludeRanges)) continue;

      // Check overlap with already-occupied ranges
      if (isExcluded(idx, matchEnd, occupiedRanges)) continue;

      const matchText = content.slice(idx, matchEnd);

      suggestions.push({
        from: idx,
        to: matchEnd,
        matchText,
        targetPath: candidate.path,
        targetTitle: candidate.title,
      });

      occupiedRanges.push({ from: idx, to: matchEnd });
    }
  }

  // Sort by position in document
  suggestions.sort((a, b) => a.from - b.from);

  return suggestions.slice(0, MAX_SUGGESTIONS);
}
