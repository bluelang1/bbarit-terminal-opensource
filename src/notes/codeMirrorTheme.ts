/**
 * codeMirrorTheme.ts
 *
 * Converts BBARIT Terminal's STYLES (from theme.ts) into CodeMirror 6 themes.
 * Uses EditorView.theme() to produce an Extension.
 */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// ── Color utilities ──────────────────────────────────────────────

function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Mix two hex colors. t=0 returns `a`, t=1 returns `b`.
 */
function mixHex(a: string, b: string, ratio: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const tt = Math.max(0, Math.min(1, ratio));
  return toHex(
    ca.r + (cb.r - ca.r) * tt,
    ca.g + (cb.g - ca.g) * tt,
    ca.b + (cb.b - ca.b) * tt,
  );
}

/**
 * Determine whether a background color is light (brightness > 128).
 */
function isLightBg(bg: string): boolean {
  const { r, g, b } = parseHex(bg);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128;
}

// ── Public API ───────────────────────────────────────────────────

export interface CMThemeStyle {
  bg: string;
  text: string;
  accent: string;
}

/**
 * Create a CodeMirror 6 theme Extension from Octo's style palette.
 */
export function createCMTheme(
  style: CMThemeStyle,
  fontFamily: string,
  fontSize: number,
): Extension {
  const { bg, text, accent } = style;
  const light = isLightBg(bg);

  const editorTheme = EditorView.theme(
    {
      '&': {
        backgroundColor: bg,
        color: text,
        fontFamily,
        fontSize: `${fontSize}px`,
      },
      '.cm-content': {
        caretColor: accent,
        fontFamily,
        fontSize: `${fontSize}px`,
        lineHeight: '1.6',
        padding: '8px 0',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: accent,
        borderLeftWidth: '2px',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: mixHex(accent, bg, 0.75),
      },
      '.cm-activeLine': {
        backgroundColor: mixHex(text, bg, 0.95),
      },
      '.cm-gutters': {
        backgroundColor: mixHex(bg, light ? '#000000' : '#ffffff', light ? 0.03 : 0.05),
        color: mixHex(text, bg, 0.55),
        borderRight: `1px solid ${mixHex(text, bg, 0.88)}`,
        fontFamily,
        fontSize: `${fontSize}px`,
      },
      '.cm-activeLineGutter': {
        backgroundColor: mixHex(text, bg, 0.90),
      },
      '.cm-foldPlaceholder': {
        backgroundColor: mixHex(text, bg, 0.9),
        color: mixHex(text, bg, 0.4),
        border: 'none',
      },
      // Wikilink decoration
      '.cm-wikilink': {
        color: accent,
        textDecoration: 'underline',
        textDecorationColor: mixHex(accent, bg, 0.5),
        cursor: 'pointer',
      },
      '.cm-wikilink:hover': {
        textDecorationColor: accent,
      },
      // Autocomplete
      '.cm-tooltip': {
        backgroundColor: mixHex(bg, text, 0.05),
        border: `1px solid ${mixHex(text, bg, 0.85)}`,
        color: text,
      },
      '.cm-tooltip-autocomplete': {
        '& > ul > li[aria-selected]': {
          backgroundColor: mixHex(accent, bg, 0.8),
          color: text,
        },
      },
      // Scrollbar
      '.cm-scroller': {
        overflow: 'auto',
      },
    },
    { dark: !light },
  );

  // Markdown syntax highlighting
  const highlightStyle = HighlightStyle.define([
    // Headings
    { tag: t.heading1, fontWeight: 'bold', fontSize: '1.5em', color: accent },
    { tag: t.heading2, fontWeight: 'bold', fontSize: '1.3em', color: accent },
    { tag: t.heading3, fontWeight: 'bold', fontSize: '1.15em', color: accent },
    { tag: t.heading4, fontWeight: 'bold', color: accent },
    { tag: t.heading5, fontWeight: 'bold', color: accent },
    { tag: t.heading6, fontWeight: 'bold', color: accent },

    // Emphasis
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through', color: mixHex(text, bg, 0.4) },

    // Links
    { tag: t.link, color: accent, textDecoration: 'underline' },
    { tag: t.url, color: accent },

    // Code
    {
      tag: t.monospace,
      backgroundColor: mixHex(text, bg, 0.92),
      borderRadius: '3px',
      fontFamily: "'Fira Code', monospace",
    },

    // Blockquote
    { tag: t.quote, color: mixHex(text, bg, 0.35), fontStyle: 'italic' },

    // Lists
    { tag: t.list, color: mixHex(text, bg, 0.3) },

    // Meta (frontmatter, HR, etc.)
    { tag: t.meta, color: mixHex(text, bg, 0.4) },
    { tag: t.processingInstruction, color: mixHex(text, bg, 0.4) },

    // Content separators (---)
    { tag: t.separator, color: mixHex(text, bg, 0.5) },
  ]);

  return [editorTheme, syntaxHighlighting(highlightStyle)];
}
