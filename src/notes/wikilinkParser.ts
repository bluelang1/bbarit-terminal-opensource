/**
 * wikilinkParser.ts
 *
 * Utility functions for parsing [[wikilink]] syntax from markdown text.
 * Supports [[target]], [[target|alias]], [[target#heading]] and ![[embed]] forms.
 */

export interface WikiLink {
  /** Target note title (without heading part) */
  target: string;
  /** Optional heading within the target note ([[target#heading]]) */
  heading?: string;
  /** Optional display alias */
  alias?: string;
  /** True when written as ![[target]] (embed/transclusion) */
  embed?: boolean;
  /** Start offset in the document */
  from: number;
  /** End offset in the document */
  to: number;
}

const WIKILINK_REGEX = /(!)?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)\s]+)\)/g;

export interface MarkdownLink {
  target: string;
  from: number;
  to: number;
}

/**
 * Split a raw wikilink target into note name and optional heading.
 * "note#heading" -> { target: "note", heading: "heading" }
 * "#heading" (same-note link) keeps target empty.
 */
export function splitWikiLinkTarget(raw: string): { target: string; heading?: string } {
  const hashIdx = raw.indexOf('#');
  if (hashIdx === -1) return { target: raw.trim() };
  const target = raw.slice(0, hashIdx).trim();
  const heading = raw.slice(hashIdx + 1).trim();
  return heading ? { target, heading } : { target };
}

/**
 * Parse all wikilinks from a text string.
 */
export function parseWikiLinks(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  const regex = new RegExp(WIKILINK_REGEX.source, WIKILINK_REGEX.flags);

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const { target, heading } = splitWikiLinkTarget(match[2]);
    links.push({
      target,
      heading,
      alias: match[3] ? match[3].trim() : undefined,
      embed: match[1] === '!' || undefined,
      from: match.index,
      to: match.index + match[0].length,
    });
  }

  return links;
}

/**
 * Find the wikilink at a specific character position, or null if none.
 */
export function findWikiLinkAtPosition(text: string, pos: number): WikiLink | null {
  const links = parseWikiLinks(text);
  return links.find((link) => pos >= link.from && pos < link.to) ?? null;
}

export function findMarkdownLinkAtPosition(text: string, pos: number): MarkdownLink | null {
  const regex = new RegExp(MARKDOWN_LINK_REGEX.source, MARKDOWN_LINK_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    if (pos >= from && pos < to) {
      return {
        target: match[2].trim(),
        from,
        to,
      };
    }
  }
  return null;
}
