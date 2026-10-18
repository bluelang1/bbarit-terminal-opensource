import { describe, expect, it } from 'vitest';
import {
  buildWikiIndexContent,
  classifyProjectDocsEntries,
  getProjectWikiPaths,
  getSharedWikiPaths,
  ingestSharedWikiRawSources,
  PROJECT_WIKI_NAME,
} from './wiki';

type MockFs = {
  files: Map<string, string>;
  dirs: Set<string>;
};

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function dirname(input: string): string {
  const normalized = normalizePath(input);
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx);
}

function basename(input: string): string {
  const normalized = normalizePath(input);
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function ensureParentDirs(fs: MockFs, path: string) {
  let current = dirname(path);
  while (current && !fs.dirs.has(current)) {
    fs.dirs.add(current);
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
}

function createMockInvoke(seedFiles: Record<string, string> = {}) {
  const fs: MockFs = {
    files: new Map<string, string>(),
    dirs: new Set<string>(['/']),
  };

  for (const [path, content] of Object.entries(seedFiles)) {
    const normalized = normalizePath(path);
    fs.files.set(normalized, content);
    ensureParentDirs(fs, normalized);
  }

  const invoke = async <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> => {
    switch (command) {
      case 'create_directory': {
        const path = normalizePath(String(args?.path || ''));
        fs.dirs.add(path);
        ensureParentDirs(fs, path);
        return undefined as T;
      }
      case 'write_file': {
        const path = normalizePath(String(args?.path || ''));
        const content = String(args?.content || '');
        ensureParentDirs(fs, path);
        fs.files.set(path, content);
        return undefined as T;
      }
      case 'read_file': {
        const path = normalizePath(String(args?.path || ''));
        if (!fs.files.has(path)) {
          throw new Error(`ENOENT: ${path}`);
        }
        return fs.files.get(path) as T;
      }
      case 'read_directory': {
        const path = normalizePath(String(args?.path || ''));
        const entries = new Map<string, { name: string; path: string; is_dir: boolean }>();

        for (const dir of fs.dirs) {
          if (dir === path) continue;
          if (dirname(dir) !== path) continue;
          entries.set(dir, { name: basename(dir), path: dir, is_dir: true });
        }
        for (const file of fs.files.keys()) {
          if (dirname(file) !== path) continue;
          entries.set(file, { name: basename(file), path: file, is_dir: false });
        }

        return Array.from(entries.values()).sort((a, b) => a.path.localeCompare(b.path)) as T;
      }
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  };

  return { invoke, fs };
}

describe('wiki helpers', () => {
  it('builds stable wiki paths for a project', () => {
    const paths = getProjectWikiPaths('/tmp/octo-project');
    expect(paths.rawDir).toBe('/tmp/octo-project/docs/raw');
    expect(paths.wikiDir).toBe('/tmp/octo-project/docs/wiki');
    expect(paths.indexFile).toBe('/tmp/octo-project/docs/wiki/index.md');
  });

  it('builds shared wiki paths under the shared notes folder', () => {
    const paths = getSharedWikiPaths('/tmp/octo-notes');
    expect(paths.docsDir).toBe('/tmp/octo-notes/Karpathy Wiki');
    expect(paths.rawDir).toBe('/tmp/octo-notes/Karpathy Wiki/raw');
    expect(paths.wikiDir).toBe('/tmp/octo-notes/Karpathy Wiki/wiki');
    expect(paths.indexFile).toBe('/tmp/octo-notes/Karpathy Wiki/wiki/index.md');
  });

  it('classifies wiki/raw directories apart from other docs entries', () => {
    const result = classifyProjectDocsEntries([
      { name: 'wiki', path: '/tmp/project/docs/wiki', is_dir: true },
      { name: 'raw', path: '/tmp/project/docs/raw', is_dir: true },
      { name: 'notes.md', path: '/tmp/project/docs/notes.md', is_dir: false },
    ]);
    expect(result.wikiEntry?.name).toBe('wiki');
    expect(result.rawEntry?.name).toBe('raw');
    expect(result.otherEntries).toHaveLength(1);
  });

  it('generates a wiki index with the expected core pages', () => {
    const content = buildWikiIndexContent('BBARIT Terminal');
    expect(content).toContain(`# BBARIT Terminal ${PROJECT_WIKI_NAME} Index`);
    expect(content).toContain('[overview]');
    expect(content).toContain('[schema]');
    expect(content).toContain('[log]');
  });

  it('ingests shared raw sources into source summaries and updates index/log', async () => {
    const notesDir = '/tmp/octo-notes';
    const shared = getSharedWikiPaths(notesDir);
    const { invoke, fs } = createMockInvoke({
      [`${shared.rawDir}/capture-one.md`]: '# Capture One\n\n- First finding\n- Second finding\n\nA quoted paragraph from the raw source.',
      [`${shared.rawDir}/nested/capture-two.txt`]: 'Capture two raw text.\n\nImportant detail line.\nAnother supporting detail.',
    });

    const result = await ingestSharedWikiRawSources(invoke, notesDir, 'BBARIT Terminal');

    expect(result.ingested).toHaveLength(2);
    expect(fs.files.has(`${shared.sourcesDir}/capture-one.md`)).toBe(true);
    expect(fs.files.has(`${shared.sourcesDir}/nested-capture-two.md`)).toBe(true);
    expect(fs.files.get(`${shared.sourcesDir}/capture-one.md`)).toContain('## Summary');
    expect(fs.files.get(shared.indexFile)).toContain('## Ingested Sources');
    expect(fs.files.get(shared.indexFile)).toContain('./sources/capture-one.md');
    expect(fs.files.get(shared.logFile)).toContain('ingest | 2 raw sources synchronized');
  });
});
