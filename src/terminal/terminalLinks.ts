import type { Terminal, ILink, ILinkProvider } from 'xterm';

// iTerm2-style Cmd/Ctrl+click link provider: detects URLs and local file paths
// in terminal output. URLs are always underlined on hover so they're visibly
// links; file paths only surface while the modifier is held (they over-match).
// Opening still requires Cmd/Ctrl+click, so plain clicks keep selecting text.

export interface TerminalLinkHandlers {
  isModifierHeld: () => boolean;
  openUrl: (url: string) => void;
  openPath: (path: string, line?: number) => void;
}

interface LinkMatch {
  kind: 'url' | 'path';
  start: number; // 0-based, inclusive
  end: number;   // 0-based, exclusive
  text: string;
  path?: string; // file path without :line:col suffix (path kind only)
  line?: number;
}

const URL_RE = /\b(?:https?|file):\/\/[^\s"'`<>]+/g;
// Path-like tokens: Windows (C:\…), home (~/…), explicit relative (./ ../),
// absolute (/…), and bare relative paths that contain a slash and a file
// extension (e.g. src/App.tsx:42 from compiler/linter output).
const PATH_RE = /(?:[A-Za-z]:\\[^\s"'`<>|]+|~\/[^\s"'`<>|]+|\.\.?\/[^\s"'`<>|]+|\/[^\s"'`<>|]+|[\w@.+-]+\/[\w@./+-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?)/g;
const TRAILING_RE = /[)\].,;:'"]+$/;
const LINE_SUFFIX_RE = /^(.*?):(\d+)(?::\d+)?$/;

function stripTrailing(s: string): string {
  return s.replace(TRAILING_RE, '');
}

function findMatches(text: string): LinkMatch[] {
  const matches: LinkMatch[] = [];
  const urlRanges: Array<[number, number]> = [];

  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    const stripped = stripTrailing(m[0]);
    if (!stripped) continue;
    const start = m.index;
    const end = start + stripped.length;
    urlRanges.push([start, end]);
    matches.push({ kind: 'url', start, end, text: stripped });
  }

  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    const start = m.index;
    // Skip the path-looking tail of an already-matched URL.
    if (urlRanges.some(([s, e]) => start >= s && start < e)) continue;
    // Require a boundary before the path to avoid matching mid-word slashes (e.g. "and/or").
    const prev = start > 0 ? text[start - 1] : '';
    if (prev && !/[\s"'`(<>=:[\]{}]/.test(prev)) continue;

    const stripped = stripTrailing(m[0]);
    if (stripped.length < 2) continue;
    const end = start + stripped.length;
    let path = stripped;
    let line: number | undefined;
    const lm = stripped.match(LINE_SUFFIX_RE);
    if (lm) {
      path = lm[1];
      line = parseInt(lm[2], 10);
    }
    matches.push({ kind: 'path', start, end, text: stripped, path, line });
  }

  return matches;
}

export function createTerminalLinkProvider(term: Terminal, handlers: TerminalLinkHandlers): ILinkProvider {
  return {
    provideLinks(lineNumber, callback) {
      const buf = term.buffer.active;
      const row = lineNumber - 1;
      if (!buf.getLine(row)) {
        callback(undefined);
        return;
      }
      // Terminal-width wraps split long paths/URLs across buffer rows; join the
      // wrapped rows back into the logical line so a match can span the wrap.
      let startRow = row;
      while (startRow > 0 && buf.getLine(startRow)?.isWrapped) startRow--;
      let endRow = row;
      while (buf.getLine(endRow + 1)?.isWrapped) endRow++;
      let text = '';
      const rowOffsets: number[] = [];
      for (let r = startRow; r <= endRow; r++) {
        rowOffsets.push(text.length);
        const l = buf.getLine(r);
        if (!l) break;
        // Intermediate rows keep their full width so string indices stay aligned
        // with buffer columns; only the final row is right-trimmed.
        text += l.translateToString(r === endRow);
      }
      if (!text) {
        callback(undefined);
        return;
      }
      const posOf = (idx: number) => {
        let r = rowOffsets.length - 1;
        while (r > 0 && rowOffsets[r] > idx) r--;
        return { x: idx - rowOffsets[r] + 1, y: startRow + r + 1 };
      };
      const modifierHeld = handlers.isModifierHeld();
      // URLs always surface; file paths only while the modifier is held.
      const found = findMatches(text).filter((mt) => mt.kind === 'url' || modifierHeld);
      if (!found.length) {
        callback(undefined);
        return;
      }
      const links: ILink[] = found.map((mt) => ({
        range: { start: posOf(mt.start), end: posOf(mt.end - 1) },
        text: mt.text,
        // Underline so it reads as a link; the finger cursor only appears with the
        // modifier down, keeping plain hover/selection unobtrusive.
        decorations: { pointerCursor: modifierHeld, underline: true },
        activate: (event) => {
          if (!(event.metaKey || event.ctrlKey)) return;
          if (mt.kind === 'url') handlers.openUrl(mt.text);
          else if (mt.path) handlers.openPath(mt.path, mt.line);
        },
      }));
      callback(links);
    },
  };
}
