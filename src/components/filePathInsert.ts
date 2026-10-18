// Pure helpers for inserting dropped file paths into text inputs and for
// deriving a path relative to a project root. Shared by the editor tab bar
// (drag a tab into a terminal / copy path) and the agent chat composer
// (drop a file to insert its path).

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|tiff?|ico)$/i;

export function isImagePath(path: string): boolean {
  return IMAGE_EXT_RE.test(path.trim());
}

// True when a string looks like an absolute filesystem path (unix, home,
// Windows drive, or UNC) on a single line. Used to tell a dropped file path
// apart from ordinary dragged text so we only hijack real path drops.
export function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return false;
  return /^(\/|~\/|[a-zA-Z]:[\\/]|\\\\)/.test(trimmed);
}

export function toRelativePath(absPath: string, root?: string | null): string {
  if (!root) return absPath;
  return absPath.startsWith(root) ? absPath.slice(root.length).replace(/^[/\\]/, '') : absPath;
}

export interface InsertResult {
  text: string;
  cursor: number;
}

// Insert `insert` into `text` replacing the [selStart, selEnd] selection,
// keeping a single space between it and any surrounding non-space text. The
// returned cursor sits right after the inserted text (before a trailing space).
export function insertTextAtSelection(text: string, selStart: number, selEnd: number, insert: string): InsertResult {
  const start = Math.max(0, Math.min(selStart, text.length));
  const end = Math.max(start, Math.min(selEnd, text.length));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
  const trail = after.length > 0 && !after.startsWith(' ') ? ' ' : '';
  const middle = `${lead}${insert}${trail}`;
  return { text: `${before}${middle}${after}`, cursor: before.length + lead.length + insert.length };
}
