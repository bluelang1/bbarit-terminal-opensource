/**
 * noteState.ts
 *
 * NoteState, NoteAction union, and noteReducer for the note system.
 * Follows the same Reducer + Context pattern as appState.ts.
 *
 * All collection types use arrays or Record<string, T> for JSON serialization compatibility.
 */

// ───────────────────────── Type Definitions ─────────────────────────

/**
 * Individual note metadata extracted from file content and filesystem.
 */
export interface NoteIndexEntry {
  /** Absolute file path (unique identifier) */
  path: string;

  /** Filename without extension */
  name: string;

  /** Note title (first # heading or filename) */
  title: string;

  /** YAML frontmatter key-value pairs */
  frontmatter: Record<string, unknown> | null;

  /** Tag list (inline #tags + frontmatter tags) */
  tags: string[];

  /** Frontmatter aliases (alternative names this note can be linked by) */
  aliases?: string[];

  /** Heading texts in document order (for [[note#heading]] completion/navigation) */
  headings?: string[];

  /** Outgoing wikilinks (notes this note links to) */
  outgoingLinks: string[];

  /** Incoming links (notes that link to this note) - computed from backlink index */
  incomingLinks: string[];

  /** Last modified (ISO 8601 string) */
  modifiedAt: string;

  /** File size in bytes */
  size: number;

  /** Excerpt (first ~200 chars of body, for search preview) */
  excerpt: string;

  /** Project name if this entry was added by project indexing (undefined = local note) */
  projectName?: string;
}

/**
 * Search result item returned by MiniSearch.
 */
export interface SearchResult {
  /** Note path */
  path: string;

  /** Note title */
  title: string;

  /** Matched excerpt */
  excerpt: string;

  /** Search relevance score (from MiniSearch) */
  score: number;

  /** Which fields matched */
  match: {
    title?: boolean;
    tags?: boolean;
    content?: boolean;
  };
}

/**
 * Tag index entry with usage frequency.
 */
export interface TagEntry {
  /** Tag name (without #) */
  tag: string;

  /** Usage count */
  count: number;

  /** Paths of notes using this tag */
  notePaths: string[];
}

// ───────────────────────── NoteState ─────────────────────────

/**
 * Complete state for the note system.
 */
export interface NoteState {
  // === Index ===
  /** Note metadata index (array for JSON serialization) */
  noteIndex: NoteIndexEntry[];

  /** Backlink reverse index { targetPath -> [sourcePaths] } */
  backlinkIndex: Record<string, string[]>;

  /** Indexing status */
  indexStatus: 'idle' | 'indexing' | 'ready' | 'error';

  /** Indexing error message */
  indexError: string | null;

  // === Search ===
  /** Current search query */
  searchQuery: string;

  /** Search results */
  searchResults: SearchResult[];

  /** Whether search modal is visible */
  showSearchModal: boolean;

  // === Note View ===
  /** Markdown view mode */
  viewMode: 'edit' | 'preview' | 'split';

  /** Show backlinks panel */
  showBacklinks: boolean;

  /** Show tags panel */
  showTags: boolean;

  // === Tags ===
  /** All tags with usage frequency */
  tagIndex: TagEntry[];

  /** Currently selected tag for filtering */
  selectedTag: string | null;

  // === Global Note Directory ===
  /** Global notes directory path (shared across all projects) */
  notesDir: string | null;

  /** Cache file path for index persistence */
  cacheFilePath: string | null;

  /** File modification timestamps for incremental indexing { path -> unix timestamp } */
  fileTimestamps: Record<string, number>;
}

// ───────────────────────── NoteAction ─────────────────────────

export type NoteAction =
  // === Index Management ===
  | { type: 'SET_NOTE_INDEX'; index: NoteIndexEntry[] }
  | { type: 'UPDATE_NOTE_ENTRY'; path: string; entry: NoteIndexEntry }
  | { type: 'REMOVE_NOTE_ENTRY'; path: string }
  | { type: 'SET_BACKLINK_INDEX'; index: Record<string, string[]> }
  | { type: 'SET_INDEX_STATUS'; status: 'idle' | 'indexing' | 'ready' | 'error'; error?: string | null }

  // === Search ===
  | { type: 'SET_SEARCH_QUERY'; query: string }
  | { type: 'SET_SEARCH_RESULTS'; results: SearchResult[] }
  | { type: 'SHOW_SEARCH_MODAL'; show: boolean }
  | { type: 'CLEAR_SEARCH' }

  // === Note View ===
  | { type: 'SET_VIEW_MODE'; mode: 'edit' | 'preview' | 'split' }
  | { type: 'TOGGLE_BACKLINKS'; show?: boolean }
  | { type: 'TOGGLE_TAGS'; show?: boolean }

  // === Tags ===
  | { type: 'SET_TAG_INDEX'; tags: TagEntry[] }
  | { type: 'SELECT_TAG'; tag: string | null }

  // === File Timestamps ===
  | { type: 'SET_FILE_TIMESTAMPS'; timestamps: Record<string, number> }

  // === Global Notes Dir ===
  | { type: 'SET_NOTES_DIR'; notesDir: string | null; cacheFilePath: string | null }
  | { type: 'RESET_NOTE_STATE' }
;

// ───────────────────────── Initial State ─────────────────────────

export function createInitialNoteState(): NoteState {
  return {
    noteIndex: [],
    backlinkIndex: {},
    indexStatus: 'idle',
    indexError: null,
    searchQuery: '',
    searchResults: [],
    showSearchModal: false,
    viewMode: 'edit',
    showBacklinks: false,
    showTags: false,
    tagIndex: [],
    selectedTag: null,
    notesDir: null,
    cacheFilePath: null,
    fileTimestamps: {},
  };
}

// ───────────────────────── Reducer ─────────────────────────

export function noteReducer(state: NoteState, action: NoteAction): NoteState {
  switch (action.type) {
    // === Index Management ===
    case 'SET_NOTE_INDEX':
      return { ...state, noteIndex: action.index };

    case 'UPDATE_NOTE_ENTRY': {
      const exists = state.noteIndex.some(e => e.path === action.path);
      if (exists) {
        return {
          ...state,
          noteIndex: state.noteIndex.map(e =>
            e.path === action.path ? action.entry : e
          ),
        };
      } else {
        return {
          ...state,
          noteIndex: [...state.noteIndex, action.entry],
        };
      }
    }

    case 'REMOVE_NOTE_ENTRY':
      return {
        ...state,
        noteIndex: state.noteIndex.filter(e => e.path !== action.path),
      };

    case 'SET_BACKLINK_INDEX':
      return { ...state, backlinkIndex: action.index };

    case 'SET_INDEX_STATUS':
      return {
        ...state,
        indexStatus: action.status,
        indexError: action.error ?? null,
      };

    // === Search ===
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.query };

    case 'SET_SEARCH_RESULTS':
      return { ...state, searchResults: action.results };

    case 'SHOW_SEARCH_MODAL':
      return { ...state, showSearchModal: action.show };

    case 'CLEAR_SEARCH':
      return { ...state, searchQuery: '', searchResults: [], showSearchModal: false };

    // === Note View ===
    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.mode };

    case 'TOGGLE_BACKLINKS':
      return {
        ...state,
        showBacklinks: action.show !== undefined ? action.show : !state.showBacklinks,
      };

    case 'TOGGLE_TAGS':
      return {
        ...state,
        showTags: action.show !== undefined ? action.show : !state.showTags,
      };

    // === Tags ===
    case 'SET_TAG_INDEX':
      return { ...state, tagIndex: action.tags };

    case 'SELECT_TAG':
      return { ...state, selectedTag: action.tag };

    // === File Timestamps ===
    case 'SET_FILE_TIMESTAMPS':
      return { ...state, fileTimestamps: action.timestamps };

    // === Project Switch ===
    case 'SET_NOTES_DIR':
      return {
        ...state,
        notesDir: action.notesDir,
        cacheFilePath: action.cacheFilePath,
      };

    case 'RESET_NOTE_STATE':
      return createInitialNoteState();

    default:
      return state;
  }
}

// ───────────────────────── Cache Types ─────────────────────────

/**
 * Shape of the .notes-cache.json file for persistence.
 */
export interface NoteCache {
  version: number;
  timestamp: string;
  noteIndex: NoteIndexEntry[];
  backlinkIndex: Record<string, string[]>;
  tagIndex: TagEntry[];
  fileTimestamps: Record<string, number>;
}
