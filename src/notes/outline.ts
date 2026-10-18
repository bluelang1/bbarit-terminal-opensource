/**
 * outline.ts
 *
 * Markdown heading outline parsing for the note outline (TOC) panel.
 */

export interface OutlineHeading {
  /** Heading level 1-6 */
  level: number;
  /** Heading text */
  text: string;
  /** 1-based line number in the document */
  line: number;
}

/**
 * Parse all markdown headings with their line numbers.
 * Lines inside code fences are ignored.
 */
export function parseOutline(content: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const lines = content.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
    }
  }
  return headings;
}
