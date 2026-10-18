import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileCode2, Loader2, RefreshCcw, Search, Sparkles, X } from 'lucide-react';

const SEARCH_MODE = 'bm25';

type CodeSearchResult = {
  path: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language?: string | null;
  score: number;
  source: string;
  snippet: string;
};

type CodeSearchStats = {
  indexed_files: number;
  total_chunks: number;
  files_scanned: number;
  languages: Record<string, number>;
};

type CodeSearchSavings = {
  calls: number;
  saved_tokens: number;
  saved_percent: number;
};

interface CodeSearchSidebarProps {
  workDir?: string;
  accentColor: string;
  onOpenResult: (path: string, line: number) => void | Promise<void>;
}

const DEFAULT_QUERY = '';

function formatLanguages(languages: Record<string, number> | undefined): string {
  const entries = Object.entries(languages || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return 'No index';
  return entries.slice(0, 3).map(([lang, count]) => `${lang} ${count}`).join(' · ');
}

function queryTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const orGroup of query.split('|')) {
    for (const t of orGroup.split(/\s+/)) {
      const trimmed = t.trim();
      if (trimmed) tokens.add(trimmed);
    }
  }
  return Array.from(tokens);
}

function findMatchLine(snippet: string, query: string, startLine: number): number {
  const tokens = queryTokens(query).map((t) => t.toLowerCase());
  if (tokens.length === 0) return startLine;
  const lines = snippet.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (tokens.some((t) => lower.includes(t))) return startLine + i;
  }
  return startLine;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return text;
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  const segments = text.split(pattern);
  return segments.map((seg, i) => {
    if (!seg) return null;
    if (i % 2 === 1) {
      return (
        <mark
          key={i}
          style={{
            background: 'rgba(255, 213, 79, 0.45)',
            color: 'inherit',
            padding: 0,
            borderRadius: 2,
          }}
        >
          {seg}
        </mark>
      );
    }
    return <React.Fragment key={i}>{seg}</React.Fragment>;
  });
}

export function CodeSearchSidebar({ workDir, accentColor, onOpenResult }: CodeSearchSidebarProps) {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [includeTextFiles, setIncludeTextFiles] = useState(false);
  const [results, setResults] = useState<CodeSearchResult[]>([]);
  const [stats, setStats] = useState<CodeSearchStats | null>(null);
  const [savings, setSavings] = useState<CodeSearchSavings | null>(null);
  const [loading, setLoading] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSearch = Boolean(workDir && query.trim());

  const loadStats = useCallback(async () => {
    if (!workDir) {
      setStats(null);
      return;
    }
    setStatsLoading(true);
    try {
      const [nextStats, nextSavings] = await Promise.all([
        invoke<CodeSearchStats>('code_search_stats', { root: workDir, includeTextFiles }),
        invoke<CodeSearchSavings>('code_search_savings'),
      ]);
      setStats(nextStats);
      setSavings(nextSavings);
    } catch (err) {
      setError(String(err));
    } finally {
      setStatsLoading(false);
    }
  }, [includeTextFiles, workDir]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const runSearch = useCallback(async () => {
    if (!canSearch || !workDir) return;
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<CodeSearchResult[]>('code_search', {
        root: workDir,
        query: query.trim(),
        limit: 8,
        mode: SEARCH_MODE,
        includeTextFiles,
      });
      setResults(next);
      void loadStats();
    } catch (err) {
      setResults([]);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [canSearch, includeTextFiles, loadStats, query, workDir]);

  const clearIndex = useCallback(async () => {
    if (!workDir) return;
    setError(null);
    try {
      await invoke('code_search_clear_cache', { root: workDir });
      setResults([]);
      await loadStats();
    } catch (err) {
      setError(String(err));
    }
  }, [loadStats, workDir]);

  const statsLine = useMemo(() => {
    if (!stats) return statsLoading ? 'Indexing...' : 'Ready';
    return `${stats.indexed_files} files · ${stats.total_chunks} chunks`;
  }, [stats, statsLoading]);

  return (
    <div
      className="code-search-sidebar"
      style={{ '--code-search-accent': accentColor } as React.CSSProperties}
    >
      <div className="code-search-head">
        <div className="code-search-title">
          <FileCode2 size={14} />
          <span>Code Search</span>
        </div>
        <button className="code-search-icon-btn" type="button" onClick={clearIndex} title="Rebuild index">
          <RefreshCcw size={12} />
        </button>
      </div>

      <form
        className="code-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <div className="code-search-input-row">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search code (공백=AND, |=OR)"
            autoComplete="off"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} title="Clear">
              <X size={12} />
            </button>
          )}
        </div>
        <div className="code-search-controls">
          <label className="code-search-check">
            <input
              type="checkbox"
              checked={includeTextFiles}
              onChange={(event) => setIncludeTextFiles(event.target.checked)}
            />
            <span>Docs</span>
          </label>
          <button type="submit" disabled={!canSearch || loading}>
            {loading ? <Loader2 size={12} className="code-search-spin" /> : <Search size={12} />}
          </button>
        </div>
      </form>

      <div className="code-search-meta">
        <span>{statsLine}</span>
        <span>{formatLanguages(stats?.languages)}</span>
        {savings && savings.calls > 0 && (
          <span>{savings.saved_tokens.toLocaleString()} tokens saved · {savings.saved_percent}%</span>
        )}
      </div>

      {error && <div className="code-search-error">{error}</div>}

      <div className="code-search-results">
        {!workDir ? (
          <div className="code-search-empty">Open a project first.</div>
        ) : results.length === 0 && !loading ? (
          <div className="code-search-empty">{query.trim() ? 'No results yet.' : 'Type a query to search this project.'}</div>
        ) : (
          results.map((result, index) => (
            <button
              key={`${result.file_path}:${result.start_line}:${index}`}
              className="code-search-result"
              type="button"
              onClick={() => {
                const line = findMatchLine(result.snippet, query, result.start_line);
                void onOpenResult(result.path, line);
              }}
              title={`${result.file_path}:${result.start_line}-${result.end_line}`}
            >
              <span className="code-search-result-top">
                <span className="code-search-path">{highlightMatch(result.file_path, query)}</span>
                <span className="code-search-score">{result.score.toFixed(3)}</span>
              </span>
              <span className="code-search-result-sub">
                <span>{result.language || 'text'}</span>
                <span>{result.start_line}-{result.end_line}</span>
                <span>{result.source}</span>
              </span>
              <pre>{highlightMatch(result.snippet, query)}</pre>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export default CodeSearchSidebar;
