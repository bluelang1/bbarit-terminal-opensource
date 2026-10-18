/**
 * NoteContext.tsx
 *
 * React Context Provider for the global note system.
 * Notes are project-independent — one shared vault for the entire app.
 *
 * Global notes directory: ~/Documents/octo-notes
 *
 * Provides:
 *   - NoteProvider: wraps children with state + dispatch contexts
 *   - useNoteState(): access NoteState
 *   - useNoteDispatch(): access dispatch function
 *   - useNoteIndex(): high-level note index operations
 *   - useNoteSearch(): MiniSearch-based full-text search
 */

/* eslint-disable react-refresh/only-export-components */

import React, { createContext, useContext, useReducer, useEffect, useCallback, useMemo, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import MiniSearch from 'minisearch';

import {
  type NoteState,
  type NoteAction,
  type NoteIndexEntry,
  type SearchResult,
  noteReducer,
  createInitialNoteState,
} from './noteState.ts';
import { buildNoteIndex, buildNoteIndexIncremental, loadNoteIndex, updateNoteIndexIncremental } from './noteIndexer.ts';
import { buildTfIdfIndex, findSimilarNotes, type TfIdfIndex, type SimilarNote } from './tfidf.ts';

// ───────────────────────── Constants ─────────────────────────

const NOTES_DIR_NAME = 'octo-notes';

// ───────────────────────── Contexts ─────────────────────────

const NoteStateContext = createContext<NoteState | null>(null);
const NoteDispatchContext = createContext<React.Dispatch<NoteAction> | null>(null);
const GlobalNotesDirContext = createContext<string | null>(null);
const RequestReindexContext = createContext<(() => void) | null>(null);

// ───────────────────────── Provider ─────────────────────────

export interface NoteProviderProps {
  children: React.ReactNode;
}

export function NoteProvider({ children }: NoteProviderProps) {
  const [state, dispatch] = useReducer(noteReducer, undefined, createInitialNoteState);
  const [globalNotesDir, setGlobalNotesDir] = useState<string | null>(null);
  const reindexTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Resolve global notes directory on mount: ~/Documents/octo-notes (cross-platform)
  useEffect(() => {
    let cancelled = false;
    invoke<string>('get_home_dir').then(home => {
      if (cancelled) return;
      const sep = home.includes('\\') ? '\\' : '/';
      const dir = [home, 'Documents', NOTES_DIR_NAME].join(sep);
      setGlobalNotesDir(dir);
    }).catch(err => {
      console.error('[NoteContext] Failed to get home dir:', err);
    });
    return () => { cancelled = true; };
  }, []);

  // When globalNotesDir is resolved, load/rebuild the index (once)
  useEffect(() => {
    if (!globalNotesDir) return;

    const cacheFilePath = `${globalNotesDir}/.notes-cache.json`;
    dispatch({ type: 'SET_NOTES_DIR', notesDir: globalNotesDir, cacheFilePath });

    // Ensure notes directory exists
    invoke('create_directory', { path: globalNotesDir }).catch(() => {});

    loadNoteIndex(globalNotesDir, cacheFilePath, dispatch).catch(err => {
      console.error('[NoteContext] Failed to load note index:', err);
      dispatch({ type: 'SET_INDEX_STATUS', status: 'error', error: String(err) });
    });
  }, [globalNotesDir]);

  // Periodic timestamp comparison (60s) to detect external edits → auto re-indexing
  useEffect(() => {
    if (!globalNotesDir) return;

    const interval = setInterval(() => {
      const s = stateRef.current;
      if (s.indexStatus !== 'ready' || !s.notesDir) return;

      buildNoteIndexIncremental(
        s.notesDir,
        dispatch,
        s.noteIndex,
        s.backlinkIndex,
        s.fileTimestamps,
      ).catch(err => {
        console.warn('[NoteContext] Periodic reindex failed:', err);
      });
    }, 60_000);

    return () => clearInterval(interval);
  }, [globalNotesDir]);

  // Debounced reindex request (exposed via context)
  const requestReindex = useCallback(() => {
    if (reindexTimerRef.current) clearTimeout(reindexTimerRef.current);
    reindexTimerRef.current = setTimeout(() => {
      const s = stateRef.current;
      if (!s.notesDir || s.indexStatus === 'indexing') return;

      buildNoteIndexIncremental(
        s.notesDir,
        dispatch,
        s.noteIndex,
        s.backlinkIndex,
        s.fileTimestamps,
      ).catch(err => {
        console.warn('[NoteContext] Debounced reindex failed:', err);
      });
    }, 1500);
  }, []);

  return (
    <GlobalNotesDirContext.Provider value={globalNotesDir}>
      <NoteStateContext.Provider value={state}>
        <NoteDispatchContext.Provider value={dispatch}>
          <RequestReindexContext.Provider value={requestReindex}>
            {children}
          </RequestReindexContext.Provider>
        </NoteDispatchContext.Provider>
      </NoteStateContext.Provider>
    </GlobalNotesDirContext.Provider>
  );
}

// ───────────────────────── Basic Hooks ─────────────────────────

/** Access the global notes directory path. */
export function useGlobalNotesDir(): string | null {
  return useContext(GlobalNotesDirContext);
}

/** Access the full NoteState. */
export function useNoteState(): NoteState {
  const ctx = useContext(NoteStateContext);
  if (!ctx) throw new Error('useNoteState must be used within NoteProvider');
  return ctx;
}

/** Access the dispatch function for NoteAction. */
export function useNoteDispatch(): React.Dispatch<NoteAction> {
  const ctx = useContext(NoteDispatchContext);
  if (!ctx) throw new Error('useNoteDispatch must be used within NoteProvider');
  return ctx;
}

// ───────────────────────── useNoteIndex Hook ─────────────────────────

/**
 * High-level hook for note index operations.
 * Provides lookup, filtering, backlink queries, and rebuild capability.
 */
export function useNoteIndex() {
  const state = useNoteState();
  const dispatch = useNoteDispatch();

  /** Look up a note by its absolute path. */
  const getNoteByPath = useCallback((path: string): NoteIndexEntry | undefined => {
    return state.noteIndex.find(e => e.path === path);
  }, [state.noteIndex]);

  /** Search notes by title substring (for wikilink autocomplete). */
  const searchByTitle = useCallback((query: string): NoteIndexEntry[] => {
    const lowerQuery = query.toLowerCase();
    return state.noteIndex.filter(e =>
      e.title.toLowerCase().includes(lowerQuery) ||
      e.name.toLowerCase().includes(lowerQuery)
    );
  }, [state.noteIndex]);

  /** Get all notes that have a specific tag. */
  const getNotesByTag = useCallback((tag: string): NoteIndexEntry[] => {
    return state.noteIndex.filter(e => e.tags.includes(tag));
  }, [state.noteIndex]);

  /** Get all notes that link to the given path (backlinks). */
  const getBacklinks = useCallback((path: string): NoteIndexEntry[] => {
    const incomingPaths = state.backlinkIndex[path] || [];
    return incomingPaths
      .map(p => state.noteIndex.find(e => e.path === p))
      .filter((e): e is NoteIndexEntry => e !== undefined);
  }, [state.backlinkIndex, state.noteIndex]);

  /** Manually rebuild the entire note index. */
  const rebuildIndex = useCallback(async () => {
    if (!state.notesDir) return;
    dispatch({ type: 'SET_INDEX_STATUS', status: 'indexing' });
    try {
      await buildNoteIndex(state.notesDir, dispatch);
      dispatch({ type: 'SET_INDEX_STATUS', status: 'ready' });
    } catch (err) {
      dispatch({ type: 'SET_INDEX_STATUS', status: 'error', error: String(err) });
    }
  }, [state.notesDir, dispatch]);

  /** Incrementally update a single note after save. */
  const updateNote = useCallback(async (path: string, content: string) => {
    await updateNoteIndexIncremental(path, content, state.noteIndex, dispatch);
  }, [state.noteIndex, dispatch]);

  return {
    noteIndex: state.noteIndex,
    indexStatus: state.indexStatus,
    indexError: state.indexError,
    notesDir: state.notesDir,
    getNoteByPath,
    searchByTitle,
    getNotesByTag,
    getBacklinks,
    rebuildIndex,
    updateNote,
  };
}

// ───────────────────────── useNoteSearch Hook ─────────────────────────

/** Document shape for MiniSearch indexing */
interface MiniSearchDocument {
  id: string;
  path: string;
  title: string;
  tags: string;
  excerpt: string;
}

/**
 * MiniSearch-based full-text note search.
 * Rebuilds the search engine whenever the note index changes.
 */
export function useNoteSearch() {
  const state = useNoteState();
  const dispatch = useNoteDispatch();

  // Build MiniSearch instance, memoized on noteIndex changes
  const searchEngine = useMemo(() => {
    const miniSearch = new MiniSearch<MiniSearchDocument>({
      fields: ['title', 'tags', 'excerpt'],
      storeFields: ['path', 'title', 'excerpt'],
      searchOptions: {
        boost: { title: 2 },
        fuzzy: 0.2,
        prefix: true,
      },
    });

    if (state.noteIndex.length > 0) {
      const docs: MiniSearchDocument[] = state.noteIndex.map(e => ({
        id: e.path,
        path: e.path,
        title: e.title,
        tags: e.tags.join(' '),
        excerpt: e.excerpt,
      }));
      miniSearch.addAll(docs);
    }

    return miniSearch;
  }, [state.noteIndex]);

  /** Execute a search query. */
  const search = useCallback((query: string) => {
    if (!query.trim()) {
      dispatch({ type: 'CLEAR_SEARCH' });
      return;
    }

    const rawResults = searchEngine.search(query);
    const results: SearchResult[] = rawResults.map(r => ({
      path: (r as unknown as MiniSearchDocument).path,
      title: (r as unknown as MiniSearchDocument).title,
      excerpt: (r as unknown as MiniSearchDocument).excerpt,
      score: r.score,
      match: {
        title: r.match.title !== undefined,
        tags: r.match.tags !== undefined,
        content: r.match.excerpt !== undefined,
      },
    }));

    dispatch({ type: 'SET_SEARCH_QUERY', query });
    dispatch({ type: 'SET_SEARCH_RESULTS', results });
  }, [searchEngine, dispatch]);

  /** Clear search state. */
  const clearSearch = useCallback(() => {
    dispatch({ type: 'CLEAR_SEARCH' });
  }, [dispatch]);

  /** Toggle search modal visibility. */
  const toggleSearchModal = useCallback((show?: boolean) => {
    dispatch({ type: 'SHOW_SEARCH_MODAL', show: show ?? !state.showSearchModal });
  }, [dispatch, state.showSearchModal]);

  return {
    searchQuery: state.searchQuery,
    searchResults: state.searchResults,
    showSearchModal: state.showSearchModal,
    search,
    clearSearch,
    toggleSearchModal,
  };
}

// ───────────────────────── useRequestReindex Hook ─────────────────────────

/** Request a debounced incremental re-index (1500ms). */
export function useRequestReindex(): () => void {
  const ctx = useContext(RequestReindexContext);
  return ctx || (() => {});
}

// ───────────────────────── useSimilarNotes Hook ─────────────────────────

/**
 * Returns similar notes for the given file path using TF-IDF.
 * Recomputes the TF-IDF index when noteIndex changes and
 * finds similar notes when the currentPath changes.
 */
export function useSimilarNotes(currentPath: string | null, topN: number = 8): SimilarNote[] {
  const state = useNoteState();

  const tfidfIndex = useMemo<TfIdfIndex>(() => {
    if (state.noteIndex.length === 0) return { vectors: {}, idf: {}, docCount: 0 };
    return buildTfIdfIndex(state.noteIndex.map(e => ({
      path: e.path,
      title: e.title,
      excerpt: e.excerpt,
      tags: e.tags,
    })));
  }, [state.noteIndex]);

  const similar = useMemo<SimilarNote[]>(() => {
    if (!currentPath || !currentPath.toLowerCase().endsWith('.md')) return [];
    if (tfidfIndex.docCount === 0) return [];
    return findSimilarNotes(tfidfIndex, currentPath, topN);
  }, [tfidfIndex, currentPath, topN]);

  return similar;
}
