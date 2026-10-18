/**
 * noteIndexer.ts
 *
 * Index building logic for the note system.
 * Scans .md files in a directory, parses wikilinks/tags/frontmatter,
 * and builds backlink + tag indices.
 *
 * Uses Tauri invoke calls to interact with the Rust backend:
 *   - list_markdown_files: recursively list .md files
 *   - read_file: read file content
 *   - write_file: write cache file
 *   - file_metadata: get file metadata for incremental updates
 */

import { invoke } from '@tauri-apps/api/core';
import type { NoteIndexEntry, TagEntry, NoteAction, NoteCache } from './noteState.ts';

// ───────────────────────── Rust Backend Types ─────────────────────────

/** Return type from Rust list_markdown_files command */
interface MarkdownFileEntry {
  path: string;
  name: string;
  modified: number;  // Unix timestamp (seconds)
  size: number;
}

/** Return type from Rust file_metadata command */
interface FileMetadataResult {
  path: string;
  modified: number;  // Unix timestamp (seconds)
  created: number;
  size: number;
  is_readonly: boolean;
}

// ───────────────────────── Content Parsing ─────────────────────────

/** Result of parsing a note's content */
interface ParsedNoteContent {
  title: string;
  frontmatter: Record<string, unknown> | null;
  tags: string[];
  aliases: string[];
  headings: string[];
  outgoingLinks: string[];
  excerpt: string;
}

/**
 * Parse frontmatter from note content.
 * Handles simple YAML frontmatter delimited by --- blocks.
 */
function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const lines = content.split('\n');

  // Must start with ---
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { data: {}, body: content };
  }

  // Find closing ---
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    return { data: {}, body: content };
  }

  // Parse YAML key-value pairs (simple line-based parsing)
  const yamlLines = lines.slice(1, endIdx);
  const data: Record<string, unknown> = {};
  let currentKey = '';
  let inArray = false;
  const arrayValues: string[] = [];

  for (const line of yamlLines) {
    // Detect array item (- value)
    if (inArray && line.match(/^\s+-\s+/)) {
      const value = line.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, '');
      arrayValues.push(value);
      continue;
    }

    // If we were in an array, save it
    if (inArray) {
      data[currentKey] = [...arrayValues];
      inArray = false;
      arrayValues.length = 0;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (!key) continue;

    if (rawValue === '' || rawValue === '|' || rawValue === '>') {
      // Might be an array or multiline value that follows
      currentKey = key;
      inArray = true;
      arrayValues.length = 0;
      continue;
    }

    // Inline array: [tag1, tag2]
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1);
      data[key] = inner
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(s => s.length > 0);
      continue;
    }

    // Simple value
    data[key] = rawValue.replace(/^["']|["']$/g, '');
  }

  // Save last array if still pending
  if (inArray && arrayValues.length > 0) {
    data[currentKey] = [...arrayValues];
  }

  const body = lines.slice(endIdx + 1).join('\n');
  return { data, body };
}

/**
 * Parse a note file's content to extract metadata.
 *
 * Extracts:
 *   - Title: first # heading or filename
 *   - Frontmatter: YAML block between --- delimiters
 *   - Tags: inline #tags + frontmatter tags (supports Korean/CJK characters)
 *   - Wikilinks: [[link]] patterns (handles [[page|display]] syntax)
 *   - Excerpt: first 200 characters of body text
 */
export function parseNoteContent(
  content: string,
  fallbackName: string,
): ParsedNoteContent {
  const { data: frontmatter, body } = parseFrontmatter(content);

  // Title: first # heading or filename
  const titleMatch = body.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : fallbackName;

  // Inline tags: #tag (supports CJK characters)
  // Negative lookbehind (?<!\[) avoids matching tags inside wikilinks
  const tagRegex = /(?:^|\s)#([a-zA-Z\u3131-\uD79D][a-zA-Z0-9\u3131-\uD79D_-]*)/g;
  const inlineTags: string[] = [];
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(body)) !== null) {
    inlineTags.push(tagMatch[1]);
  }

  // Frontmatter tags
  const fmTags: string[] = [];
  const rawTags = frontmatter.tags;
  if (Array.isArray(rawTags)) {
    for (const t of rawTags) {
      fmTags.push(String(t));
    }
  } else if (typeof rawTags === 'string') {
    fmTags.push(rawTags);
  }

  // Deduplicate tags
  const tags = [...new Set([...inlineTags, ...fmTags])];

  // Frontmatter aliases: aliases: [a, b] / aliases: a / alias: a
  const aliases: string[] = [];
  for (const key of ['aliases', 'alias']) {
    const raw = frontmatter[key];
    if (Array.isArray(raw)) {
      for (const a of raw) {
        const s = String(a).trim();
        if (s) aliases.push(s);
      }
    } else if (typeof raw === 'string' && raw.trim()) {
      aliases.push(raw.trim());
    }
  }

  // Headings in document order (skip lines inside code fences)
  const headings: string[] = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const hm = line.match(/^#{1,6}\s+(.+)/);
    if (hm) headings.push(hm[1].trim());
  }

  // Wikilinks: [[page]], [[page|display]], [[page#heading]], ![[embed]]
  const wikilinkRegex = /\[\[([^\]]+)\]\]/g;
  const outgoingLinks: string[] = [];
  let wlMatch: RegExpExecArray | null;
  while ((wlMatch = wikilinkRegex.exec(body)) !== null) {
    const raw = wlMatch[1];
    // Extract page name (before | alias and # heading if present)
    const pageName = raw.split('|')[0].split('#')[0].trim();
    if (pageName) {
      outgoingLinks.push(pageName);
    }
  }

  // Excerpt: first 200 characters of body, newlines replaced with spaces
  const excerpt = body.slice(0, 200).replace(/\n/g, ' ').trim();

  return {
    title,
    frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : null,
    tags,
    aliases: [...new Set(aliases)],
    headings,
    outgoingLinks,
    excerpt,
  };
}

// ───────────────────────── Index Building ─────────────────────────

/**
 * Build a complete note index by scanning all .md files in the directory.
 * Dispatches index data to the NoteContext reducer.
 * @param existingProjectEntries - project-indexed entries to preserve (optional)
 */
export async function buildNoteIndex(
  notesDir: string,
  dispatch: React.Dispatch<NoteAction>,
  existingProjectEntries?: NoteIndexEntry[],
): Promise<void> {
  try {
    // 1. List all .md files via Rust backend
    let mdFiles: MarkdownFileEntry[];
    try {
      mdFiles = await invoke<MarkdownFileEntry[]>(
        'list_markdown_files',
        { dir: notesDir },
      );
    } catch {
      // Directory doesn't exist yet — treat as empty
      mdFiles = [];
    }

    const entries: NoteIndexEntry[] = [];
    const outgoingLinksMap: Record<string, string[]> = {};
    const fileTimestamps: Record<string, number> = {};

    // 2. Read and parse each file (batch reading for performance)
    const filePaths = mdFiles.map(f => f.path);
    const fileContents = await batchReadFiles(filePaths);

    for (const file of mdFiles) {
      try {
        const content = fileContents[file.path];
        if (content === undefined) continue;

        const name = file.name.replace(/\.md$/, '');
        const parsed = parseNoteContent(content, name);

        // Convert Unix timestamp to ISO 8601
        const modifiedAt = new Date(file.modified * 1000).toISOString();

        const entry: NoteIndexEntry = {
          path: file.path,
          name,
          title: parsed.title,
          frontmatter: parsed.frontmatter,
          tags: parsed.tags,
          aliases: parsed.aliases,
          headings: parsed.headings,
          outgoingLinks: parsed.outgoingLinks,
          incomingLinks: [],  // Filled after backlink index is built
          modifiedAt,
          size: file.size,
          excerpt: parsed.excerpt,
        };

        entries.push(entry);
        outgoingLinksMap[file.path] = parsed.outgoingLinks;
        fileTimestamps[file.path] = file.modified;
      } catch (err) {
        console.warn('[NoteIndexer] Failed to parse file:', file.path, err);
      }
    }

    // 3. Build backlink (reverse reference) index
    const backlinkIndex = buildBacklinkIndex(outgoingLinksMap, entries);

    // 4. Populate incomingLinks on each entry
    for (const entry of entries) {
      entry.incomingLinks = backlinkIndex[entry.path] || [];
    }

    // 5. Merge with project entries if provided
    const projectEntries = existingProjectEntries || [];
    const allEntries = [...entries, ...projectEntries];

    // 6. Build tag index
    const tagIndex = buildTagIndex(allEntries);

    // 7. Dispatch state updates
    dispatch({ type: 'SET_NOTE_INDEX', index: allEntries });
    dispatch({ type: 'SET_BACKLINK_INDEX', index: backlinkIndex });
    dispatch({ type: 'SET_TAG_INDEX', tags: tagIndex });
    dispatch({ type: 'SET_FILE_TIMESTAMPS', timestamps: fileTimestamps });

    // 8. Save cache to file
    await saveCacheToFile(notesDir, allEntries, backlinkIndex, tagIndex, fileTimestamps);

  } catch (err) {
    console.error('[NoteIndexer] Failed to build index:', err);
    dispatch({ type: 'SET_INDEX_STATUS', status: 'error', error: String(err) });
  }
}

/**
 * Build the backlink (reverse reference) index.
 *
 * For each note's outgoing wikilinks, resolve the link name to a file path
 * and record the source note as a backlink for the target.
 */
export function buildBacklinkIndex(
  outgoingLinksMap: Record<string, string[]>,
  entries: NoteIndexEntry[],
): Record<string, string[]> {
  // Use Set for O(1) dedup instead of Array.includes() O(n)
  const backlinkSets: Record<string, Set<string>> = {};

  // Build a lookup map: normalized name -> path
  const nameToPath: Record<string, string> = {};
  for (const entry of entries) {
    // Match by filename (case-insensitive)
    nameToPath[entry.name.toLowerCase()] = entry.path;
    // Also match by title (case-insensitive)
    nameToPath[entry.title.toLowerCase()] = entry.path;
    // Also match by frontmatter aliases (case-insensitive)
    for (const alias of entry.aliases || []) {
      nameToPath[alias.toLowerCase()] = entry.path;
    }
  }

  for (const [sourcePath, links] of Object.entries(outgoingLinksMap)) {
    for (const linkName of links) {
      // Resolve wikilink name to file path
      const targetPath = nameToPath[linkName.toLowerCase()];
      if (!targetPath) continue;

      if (!backlinkSets[targetPath]) {
        backlinkSets[targetPath] = new Set();
      }
      backlinkSets[targetPath].add(sourcePath);
    }
  }

  // Convert Sets to arrays for the return type
  const backlinkIndex: Record<string, string[]> = {};
  for (const [path, set] of Object.entries(backlinkSets)) {
    backlinkIndex[path] = Array.from(set);
  }
  return backlinkIndex;
}

/**
 * Build a tag index from note entries.
 * Groups notes by tag with usage frequency.
 */
export function buildTagIndex(entries: NoteIndexEntry[]): TagEntry[] {
  const tagMap = new Map<string, Set<string>>();

  for (const entry of entries) {
    for (const tag of entry.tags) {
      if (!tagMap.has(tag)) {
        tagMap.set(tag, new Set());
      }
      tagMap.get(tag)!.add(entry.path);
    }
  }

  return Array.from(tagMap.entries()).map(([tag, paths]) => ({
    tag,
    count: paths.size,
    notePaths: Array.from(paths),
  }));
}

// ───────────────────────── Incremental Update ─────────────────────────

/**
 * Incrementally update the index when a single note is saved.
 * Re-parses only the changed file and updates its entry.
 */
export async function updateNoteIndexIncremental(
  path: string,
  content: string,
  currentIndex: NoteIndexEntry[],
  dispatch: React.Dispatch<NoteAction>,
): Promise<void> {
  try {
    // Get fresh file metadata
    const meta = await invoke<FileMetadataResult>(
      'file_metadata',
      { path },
    );

    const name = path.split('/').pop()?.replace(/\.md$/, '') || '';
    const parsed = parseNoteContent(content, name);
    const modifiedAt = new Date(meta.modified * 1000).toISOString();

    const entry: NoteIndexEntry = {
      path,
      name,
      title: parsed.title,
      frontmatter: parsed.frontmatter,
      tags: parsed.tags,
      aliases: parsed.aliases,
      headings: parsed.headings,
      outgoingLinks: parsed.outgoingLinks,
      incomingLinks: [],  // Will be recomputed below
      modifiedAt,
      size: meta.size,
      excerpt: parsed.excerpt,
    };

    // Update the entry in the index
    dispatch({ type: 'UPDATE_NOTE_ENTRY', path, entry });

    // Rebuild backlink index with updated outgoing links
    // (Replace outgoing links for this path, keep others)
    const updatedIndex = currentIndex.map(e =>
      e.path === path ? entry : e
    );
    if (!currentIndex.some(e => e.path === path)) {
      updatedIndex.push(entry);
    }

    const outgoingLinksMap: Record<string, string[]> = {};
    for (const e of updatedIndex) {
      outgoingLinksMap[e.path] = e.outgoingLinks;
    }

    const backlinkIndex = buildBacklinkIndex(outgoingLinksMap, updatedIndex);
    dispatch({ type: 'SET_BACKLINK_INDEX', index: backlinkIndex });

    // Rebuild tag index
    const tagIndex = buildTagIndex(updatedIndex);
    dispatch({ type: 'SET_TAG_INDEX', tags: tagIndex });

  } catch (err) {
    console.error('[NoteIndexer] Failed incremental update:', err);
  }
}

// ───────────────────────── Batch File Reading ─────────────────────────

/**
 * Read multiple files in parallel, chunked to avoid overwhelming the backend.
 * Returns a map of path -> content for successfully read files.
 */
export async function batchReadFiles(
  paths: string[],
  chunkSize: number = 20,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (let i = 0; i < paths.length; i += chunkSize) {
    const chunk = paths.slice(i, i + chunkSize);
    const settled = await Promise.allSettled(
      chunk.map(async (path) => {
        const content = await invoke<string>('read_file', { path });
        return { path, content };
      }),
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        result[outcome.value.path] = outcome.value.content;
      }
    }
  }

  return result;
}

// ───────────────────────── Incremental Index Building ─────────────────────────

/**
 * Build the note index incrementally by comparing cached timestamps
 * against current file timestamps. Only re-parses changed/new files
 * and removes deleted files from the index.
 */
export async function buildNoteIndexIncremental(
  notesDir: string,
  dispatch: React.Dispatch<NoteAction>,
  cachedIndex: NoteIndexEntry[],
  cachedBacklinks: Record<string, string[]>,
  cachedTimestamps: Record<string, number>,
): Promise<void> {
  try {
    // 1. List current .md files
    let mdFiles: MarkdownFileEntry[];
    try {
      mdFiles = await invoke<MarkdownFileEntry[]>(
        'list_markdown_files',
        { dir: notesDir },
      );
    } catch {
      mdFiles = [];
    }

    // 2. Build current timestamp map
    const currentTimestamps: Record<string, number> = {};
    for (const file of mdFiles) {
      currentTimestamps[file.path] = file.modified;
    }

    // 3. Determine changed, new, and deleted files
    const currentPaths = new Set(mdFiles.map(f => f.path));
    const cachedPaths = new Set(Object.keys(cachedTimestamps));

    const newPaths: string[] = [];
    const changedPaths: string[] = [];
    const deletedPaths: string[] = [];

    for (const file of mdFiles) {
      if (!cachedPaths.has(file.path)) {
        newPaths.push(file.path);
      } else if (cachedTimestamps[file.path] !== file.modified) {
        changedPaths.push(file.path);
      }
    }

    for (const path of cachedPaths) {
      if (!currentPaths.has(path)) {
        deletedPaths.push(path);
      }
    }

    // 4. If nothing changed, just use the cache as-is
    if (newPaths.length === 0 && changedPaths.length === 0 && deletedPaths.length === 0) {
      dispatch({ type: 'SET_NOTE_INDEX', index: cachedIndex });
      dispatch({ type: 'SET_BACKLINK_INDEX', index: cachedBacklinks });
      dispatch({ type: 'SET_FILE_TIMESTAMPS', timestamps: cachedTimestamps });
      return;
    }

    console.log(
      `[NoteIndexer] Incremental: ${newPaths.length} new, ${changedPaths.length} changed, ${deletedPaths.length} deleted`,
    );

    // 5. Build a lookup for mdFiles by path
    const mdFileMap: Record<string, MarkdownFileEntry> = {};
    for (const file of mdFiles) {
      mdFileMap[file.path] = file;
    }

    // 6. Read only new/changed files
    const pathsToRead = [...newPaths, ...changedPaths];
    const fileContents = await batchReadFiles(pathsToRead);

    // 7. Parse new/changed files into entries
    const freshEntries: NoteIndexEntry[] = [];
    for (const path of pathsToRead) {
      const content = fileContents[path];
      if (content === undefined) continue;

      const file = mdFileMap[path];
      if (!file) continue;

      const name = file.name.replace(/\.md$/, '');
      const parsed = parseNoteContent(content, name);
      const modifiedAt = new Date(file.modified * 1000).toISOString();

      freshEntries.push({
        path: file.path,
        name,
        title: parsed.title,
        frontmatter: parsed.frontmatter,
        tags: parsed.tags,
        aliases: parsed.aliases,
        headings: parsed.headings,
        outgoingLinks: parsed.outgoingLinks,
        incomingLinks: [],
        modifiedAt,
        size: file.size,
        excerpt: parsed.excerpt,
      });
    }

    // 8. Merge: keep unchanged entries, replace changed, add new, remove deleted
    const deletedSet = new Set(deletedPaths);
    const changedSet = new Set(changedPaths);
    const freshMap = new Map(freshEntries.map(e => [e.path, e]));

    const mergedEntries: NoteIndexEntry[] = [];

    // Keep unchanged cached entries
    for (const entry of cachedIndex) {
      if (deletedSet.has(entry.path)) continue;
      if (changedSet.has(entry.path)) {
        const fresh = freshMap.get(entry.path);
        if (fresh) mergedEntries.push(fresh);
      } else {
        mergedEntries.push(entry);
      }
    }

    // Add new entries
    for (const path of newPaths) {
      const fresh = freshMap.get(path);
      if (fresh) mergedEntries.push(fresh);
    }

    // 9. Rebuild backlink index
    const outgoingLinksMap: Record<string, string[]> = {};
    for (const e of mergedEntries) {
      outgoingLinksMap[e.path] = e.outgoingLinks;
    }
    const backlinkIndex = buildBacklinkIndex(outgoingLinksMap, mergedEntries);

    // 10. Populate incomingLinks
    for (const entry of mergedEntries) {
      entry.incomingLinks = backlinkIndex[entry.path] || [];
    }

    // 11. Build tag index
    const tagIndex = buildTagIndex(mergedEntries);

    // 12. Dispatch updates
    dispatch({ type: 'SET_NOTE_INDEX', index: mergedEntries });
    dispatch({ type: 'SET_BACKLINK_INDEX', index: backlinkIndex });
    dispatch({ type: 'SET_TAG_INDEX', tags: tagIndex });
    dispatch({ type: 'SET_FILE_TIMESTAMPS', timestamps: currentTimestamps });

    // 13. Save cache
    await saveCacheToFile(notesDir, mergedEntries, backlinkIndex, tagIndex, currentTimestamps);

  } catch (err) {
    console.error('[NoteIndexer] Incremental index failed, falling back to full rebuild:', err);
    await buildNoteIndex(notesDir, dispatch);
  }
}

// ───────────────────────── Cache Persistence ─────────────────────────

const CACHE_VERSION = 3;

/**
 * Save the note index to a cache file in the notes directory.
 */
export async function saveCacheToFile(
  notesDir: string,
  noteIndex: NoteIndexEntry[],
  backlinkIndex: Record<string, string[]>,
  tagIndex: TagEntry[],
  fileTimestamps?: Record<string, number>,
): Promise<void> {
  const cacheFilePath = `${notesDir}/.notes-cache.json`;
  const cache: NoteCache = {
    version: CACHE_VERSION,
    timestamp: new Date().toISOString(),
    noteIndex,
    backlinkIndex,
    tagIndex,
    fileTimestamps: fileTimestamps || {},
  };

  try {
    await invoke('write_file', {
      path: cacheFilePath,
      content: JSON.stringify(cache, null, 2),
    });
  } catch (err) {
    console.warn('[NoteIndexer] Failed to save cache:', err);
  }
}

/**
 * Load the note index from cache, or rebuild if cache is missing/invalid.
 * When a valid v2 cache exists, performs incremental comparison instead of
 * blindly trusting the cache or doing a full rebuild.
 */
export async function loadNoteIndex(
  notesDir: string,
  cacheFilePath: string,
  dispatch: React.Dispatch<NoteAction>,
): Promise<void> {
  dispatch({ type: 'SET_INDEX_STATUS', status: 'indexing' });

  try {
    // Try loading from cache
    const cacheContent = await invoke<string>('read_file', { path: cacheFilePath });
    const cache = JSON.parse(cacheContent) as NoteCache;

    // Validate cache version and structure
    if (
      cache.version === CACHE_VERSION &&
      Array.isArray(cache.noteIndex) &&
      cache.fileTimestamps
    ) {
      // Perform incremental comparison against cached timestamps
      await buildNoteIndexIncremental(
        notesDir,
        dispatch,
        cache.noteIndex,
        cache.backlinkIndex || {},
        cache.fileTimestamps,
      );
      dispatch({ type: 'SET_INDEX_STATUS', status: 'ready' });
      return;
    }
  } catch {
    // Cache file missing or corrupted - fall through to full rebuild
  }

  // Full index rebuild (no cache or invalid/old cache version)
  try {
    await buildNoteIndex(notesDir, dispatch);
    dispatch({ type: 'SET_INDEX_STATUS', status: 'ready' });
  } catch (err) {
    console.error('[NoteIndexer] Full rebuild failed:', err);
    dispatch({ type: 'SET_INDEX_STATUS', status: 'error', error: String(err) });
  }
}
