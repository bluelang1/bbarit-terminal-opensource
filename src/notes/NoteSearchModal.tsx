/**
 * NoteSearchModal.tsx
 *
 * Modal for searching notes by title, tags, and content.
 * Uses MiniSearch via useNoteSearch() for full-text search.
 * Supports search operators: tag:, file:, path:, -exclude
 * Supports match-case and regex toggle modes.
 * Context excerpts with highlighted matching lines.
 * Keyboard navigation: ArrowUp/Down, Enter, Escape.
 *
 * Props:
 *   - isOpen: whether the modal is visible
 *   - onClose: callback to close the modal
 *   - onOpenFile: callback when a note is selected
 *   - style: theme colors { bg, text, accent }
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, FileText } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useNoteSearch, useNoteState } from './NoteContext.tsx';
import { useTranslation } from '../i18n';
import type { NoteIndexEntry } from './noteState.ts';

import './NoteSearchModal.css';

export interface NoteSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  style: { bg: string; text: string; accent: string };
}

// ───────────────────────── Search Operator Parsing ─────────────────────────

interface ParsedQuery {
  /** Plain text terms for MiniSearch full-text search */
  plainTerms: string[];
  /** tag: filters (partial match) */
  tagFilters: string[];
  /** file: filters (partial match on filename) */
  fileFilters: string[];
  /** path: filters (partial match on file path) */
  pathFilters: string[];
  /** -exclude terms */
  excludeTerms: string[];
  /** Whether any operator was used */
  hasOperators: boolean;
}

function parseSearchQuery(query: string): ParsedQuery {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const result: ParsedQuery = {
    plainTerms: [],
    tagFilters: [],
    fileFilters: [],
    pathFilters: [],
    excludeTerms: [],
    hasOperators: false,
  };

  for (const token of tokens) {
    if (token.startsWith('tag:') && token.length > 4) {
      result.tagFilters.push(token.slice(4).toLowerCase());
      result.hasOperators = true;
    } else if (token.startsWith('file:') && token.length > 5) {
      result.fileFilters.push(token.slice(5).toLowerCase());
      result.hasOperators = true;
    } else if (token.startsWith('path:') && token.length > 5) {
      result.pathFilters.push(token.slice(5).toLowerCase());
      result.hasOperators = true;
    } else if (token.startsWith('-') && token.length > 1) {
      result.excludeTerms.push(token.slice(1).toLowerCase());
      result.hasOperators = true;
    } else {
      result.plainTerms.push(token);
    }
  }

  return result;
}

// ───────────────────────── Helpers ─────────────────────────

/** Compute relative path from notes root */
function getRelativePath(fullPath: string, noteIndex: NoteIndexEntry[]): string {
  if (noteIndex.length === 0) return fullPath;
  // Find common parent directory from any entry
  const sample = noteIndex[0].path;
  const sep = sample.includes('\\') ? '\\' : '/';
  const parts = fullPath.split(sep);
  // Find the "octo-notes" segment
  const notesIdx = parts.findIndex(p => p === 'octo-notes');
  if (notesIdx >= 0) {
    return parts.slice(notesIdx + 1).join('/');
  }
  // Fallback: just show filename
  return parts[parts.length - 1];
}

/** Highlight matching portions of text with <strong> */
function highlightMatch(text: string, query: string, matchCase: boolean, isRegex: boolean): React.ReactNode {
  if (!query.trim()) return text;

  try {
    let regex: RegExp;
    if (isRegex) {
      const flags = matchCase ? 'g' : 'gi';
      regex = new RegExp(`(${query})`, flags);
    } else {
      // Extract only plain terms (not operators) for highlighting
      const parsed = parseSearchQuery(query);
      const terms = parsed.plainTerms;
      if (terms.length === 0) return text;
      const flags = matchCase ? 'g' : 'gi';
      regex = new RegExp(
        `(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
        flags
      );
    }

    const parts = text.split(regex);
    return parts.map((part, i) => {
      const isMatch = i % 2 === 1; // split by capturing group alternates
      return isMatch ? <strong key={i}>{part}</strong> : part;
    });
  } catch {
    return text;
  }
}

// ───────────────────────── Context Excerpts ─────────────────────────

interface ContextSnippet {
  lineNum: number;
  lines: string[];
  matchLineIndex: number;
}

function findContextSnippets(
  content: string,
  searchTerms: string[],
  matchCase: boolean,
  isRegex: boolean,
  maxSnippets: number = 2,
): ContextSnippet[] {
  if (searchTerms.length === 0) return [];

  const lines = content.split('\n');
  const snippets: ContextSnippet[] = [];
  const usedLines = new Set<number>();

  let testFn: (line: string) => boolean;
  try {
    if (isRegex) {
      const flags = matchCase ? '' : 'i';
      const re = new RegExp(searchTerms.join('|'), flags);
      testFn = (line: string) => re.test(line);
    } else {
      const lowerTerms = matchCase ? searchTerms : searchTerms.map(t => t.toLowerCase());
      testFn = (line: string) => {
        const target = matchCase ? line : line.toLowerCase();
        return lowerTerms.some(t => target.includes(t));
      };
    }
  } catch {
    return [];
  }

  for (let i = 0; i < lines.length && snippets.length < maxSnippets; i++) {
    if (usedLines.has(i)) continue;
    if (!testFn(lines[i])) continue;

    const start = Math.max(0, i - 1);
    const end = Math.min(lines.length - 1, i + 1);
    const contextLines: string[] = [];
    for (let j = start; j <= end; j++) {
      usedLines.add(j);
      contextLines.push(lines[j]);
    }
    snippets.push({
      lineNum: i + 1, // 1-indexed
      lines: contextLines,
      matchLineIndex: i - start,
    });
  }

  return snippets;
}

// ───────────────────────── Display Result Type ─────────────────────────

interface DisplayResult {
  path: string;
  title: string;
  excerpt: string;
  tags: string[];
  relativePath: string;
  contextSnippets?: ContextSnippet[];
}

// ───────────────────────── Component ─────────────────────────

export function NoteSearchModal({ isOpen, onClose, onOpenFile, style }: NoteSearchModalProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [matchCase, setMatchCase] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [contentCache, setContentCache] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const readDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { search, searchResults, clearSearch } = useNoteSearch();
  const { noteIndex } = useNoteState();

  const parsed = useMemo(() => parseSearchQuery(query), [query]);

  // ── Operator-based filtering on noteIndex ──
  const operatorFilteredResults = useMemo((): NoteIndexEntry[] | null => {
    if (!parsed.hasOperators && !matchCase && !isRegex) return null;

    let candidates = [...noteIndex];

    // tag: filter
    for (const tf of parsed.tagFilters) {
      candidates = candidates.filter(e =>
        e.tags.some(t => t.toLowerCase().includes(tf))
      );
    }

    // file: filter
    for (const ff of parsed.fileFilters) {
      candidates = candidates.filter(e =>
        e.name.toLowerCase().includes(ff)
      );
    }

    // path: filter
    for (const pf of parsed.pathFilters) {
      candidates = candidates.filter(e =>
        e.path.toLowerCase().includes(pf)
      );
    }

    // -exclude filter (check title, excerpt, tags)
    for (const ex of parsed.excludeTerms) {
      candidates = candidates.filter(e => {
        const haystack = `${e.title} ${e.excerpt} ${e.tags.join(' ')}`.toLowerCase();
        return !haystack.includes(ex);
      });
    }

    // Plain text filter with match-case or regex
    if (parsed.plainTerms.length > 0) {
      const combinedQuery = parsed.plainTerms.join(' ');
      if (isRegex) {
        try {
          const flags = matchCase ? '' : 'i';
          const re = new RegExp(combinedQuery, flags);
          candidates = candidates.filter(e => {
            const haystack = `${e.title} ${e.excerpt} ${e.tags.join(' ')}`;
            return re.test(haystack);
          });
        } catch {
          // Invalid regex — return empty
          return [];
        }
      } else if (matchCase) {
        candidates = candidates.filter(e => {
          const haystack = `${e.title} ${e.excerpt} ${e.tags.join(' ')}`;
          return parsed.plainTerms.every(t => haystack.includes(t));
        });
      } else if (!parsed.hasOperators) {
        // Only plain terms with matchCase or regex active — filter noteIndex directly
        const lowerTerms = parsed.plainTerms.map(t => t.toLowerCase());
        candidates = candidates.filter(e => {
          const haystack = `${e.title} ${e.excerpt} ${e.tags.join(' ')}`.toLowerCase();
          return lowerTerms.every(t => haystack.includes(t));
        });
      } else {
        // Has operators + plain terms without special mode → use basic case-insensitive
        const lowerTerms = parsed.plainTerms.map(t => t.toLowerCase());
        candidates = candidates.filter(e => {
          const haystack = `${e.title} ${e.excerpt} ${e.tags.join(' ')}`.toLowerCase();
          return lowerTerms.every(t => haystack.includes(t));
        });
      }
    }

    return candidates;
  }, [noteIndex, parsed, matchCase, isRegex]);

  // ── Build display results ──
  const displayResults = useMemo((): DisplayResult[] => {
    if (!query.trim()) {
      // No query: show recent notes sorted by modification date
      return [...noteIndex]
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
        .slice(0, 15)
        .map(e => ({
          path: e.path,
          title: e.title,
          excerpt: e.excerpt,
          tags: e.tags,
          relativePath: getRelativePath(e.path, noteIndex),
        }));
    }

    // If operator-based results exist, use them
    if (operatorFilteredResults !== null) {
      return operatorFilteredResults.map(e => {
        const content = contentCache[e.path];
        let contextSnippets: ContextSnippet[] | undefined;
        if (content && parsed.plainTerms.length > 0) {
          contextSnippets = findContextSnippets(content, parsed.plainTerms, matchCase, isRegex);
        }
        return {
          path: e.path,
          title: e.title,
          excerpt: e.excerpt,
          tags: e.tags,
          relativePath: getRelativePath(e.path, noteIndex),
          contextSnippets,
        };
      });
    }

    // Plain MiniSearch results
    return searchResults.map(r => {
      const entry = noteIndex.find(e => e.path === r.path);
      const content = contentCache[r.path];
      let contextSnippets: ContextSnippet[] | undefined;
      if (content && parsed.plainTerms.length > 0) {
        contextSnippets = findContextSnippets(content, parsed.plainTerms, matchCase, isRegex);
      }
      return {
        path: r.path,
        title: r.title,
        excerpt: r.excerpt || '',
        tags: entry?.tags || [],
        relativePath: getRelativePath(r.path, noteIndex),
        contextSnippets,
      };
    });
  }, [query, searchResults, noteIndex, operatorFilteredResults, contentCache, parsed.plainTerms, matchCase, isRegex]);

  // ── Execute MiniSearch when plain query changes (only when no operators/special mode) ──
  useEffect(() => {
    if (query.trim() && operatorFilteredResults === null) {
      search(query);
    } else if (!query.trim()) {
      clearSearch();
    }
  }, [query, operatorFilteredResults]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Lazy read file contents for visible results (top 10) ──
  useEffect(() => {
    if (!query.trim()) return;

    const results = displayResults.slice(0, 10);
    const pathsToRead = results
      .filter(r => !(r.path in contentCache))
      .map(r => r.path);

    if (pathsToRead.length === 0) return;

    if (readDebounceRef.current) clearTimeout(readDebounceRef.current);
    readDebounceRef.current = setTimeout(() => {
      Promise.all(
        pathsToRead.map(async (path) => {
          try {
            const content = await invoke<string>('read_file', { path });
            return { path, content };
          } catch {
            return { path, content: '' };
          }
        })
      ).then(results => {
        setContentCache(prev => {
          const next = { ...prev };
          for (const { path, content } of results) {
            next[path] = content;
          }
          return next;
        });
      });
    }, 150);

    return () => {
      if (readDebounceRef.current) clearTimeout(readDebounceRef.current);
    };
  }, [query, displayResults.map(r => r.path).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-focus input when modal opens ──
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setContentCache({});
      clearSearch();
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scroll selected item into view ──
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll<HTMLElement>('.note-search-item');
    const item = items[selectedIndex];
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleSelect = useCallback((path: string) => {
    onOpenFile(path);
    onClose();
  }, [onOpenFile, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, displayResults.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const result = displayResults[selectedIndex];
      if (result) handleSelect(result.path);
      return;
    }
  }, [displayResults, selectedIndex, handleSelect, onClose]);

  // Determine if we should show grouped count header
  const showGroupHeader = parsed.hasOperators && query.trim() && displayResults.length > 0;

  if (!isOpen) return null;

  return (
    <div
      className="note-search-overlay"
      onMouseDown={onClose}
      style={{
        '--ns-bg': style.bg,
        '--ns-text': style.text,
        '--ns-accent': style.accent,
      } as React.CSSProperties}
    >
      <div
        className="note-search-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="note-search-input-wrapper">
          <Search size={16} className="note-search-input-icon" />
          <input
            ref={inputRef}
            className="note-search-input"
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            placeholder={t('notes.search.placeholder')}
            autoComplete="off"
            autoFocus
            spellCheck={false}
          />
        </div>

        {/* Search toggles */}
        <div className="note-search-toggles">
          <button
            className={`note-search-toggle ${matchCase ? 'active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMatchCase(prev => !prev)}
            title={t('notes.search.caseSensitive')}
          >
            Aa
          </button>
          <button
            className={`note-search-toggle ${isRegex ? 'active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setIsRegex(prev => !prev)}
            title={t('notes.search.regex')}
          >
            .*
          </button>
        </div>

        <div className="note-search-results" ref={listRef}>
          {displayResults.length === 0 ? (
            <div className="note-search-empty">
              {query.trim() ? t('notes.search.notFound') : t('notes.search.noNotes')}
            </div>
          ) : (
            <>
              {!query.trim() && (
                <div className="note-search-section-label">{t('notes.search.recent')}</div>
              )}
              {showGroupHeader && (
                <div className="note-search-section-label">
                  {displayResults.length} {t('notes.search.results')}
                </div>
              )}
              {displayResults.map((result, idx) => (
                <div
                  key={result.path}
                  className={`note-search-item ${idx === selectedIndex ? 'selected' : ''}`}
                  onMouseMove={() => setSelectedIndex(idx)}
                  onClick={() => handleSelect(result.path)}
                >
                  <FileText size={14} className="note-search-item-icon" />
                  <div className="note-search-item-info">
                    <div className="note-search-item-title">
                      {highlightMatch(result.title, query, matchCase, isRegex)}
                    </div>
                    <div className="note-search-item-path">{result.relativePath}</div>
                    {result.tags.length > 0 && (
                      <div className="note-search-item-tags">
                        {result.tags.slice(0, 5).map(tag => (
                          <span key={tag} className="note-search-tag">#{tag}</span>
                        ))}
                      </div>
                    )}
                    {result.contextSnippets && result.contextSnippets.length > 0 && (
                      <div className="note-search-item-context">
                        {result.contextSnippets.map((snippet, si) => (
                          <div key={si} className="note-search-item-context-block">
                            {snippet.lines.map((line, li) => (
                              <div key={li} className="note-search-item-context-line">
                                <span className="note-search-item-line-num">
                                  L{snippet.lineNum - snippet.matchLineIndex + li}:
                                </span>
                                <span>
                                  {li === snippet.matchLineIndex
                                    ? highlightMatch(line, parsed.plainTerms.join(' '), matchCase, isRegex)
                                    : line
                                  }
                                </span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
