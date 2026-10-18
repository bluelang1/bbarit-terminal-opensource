/**
 * EditorPanel.tsx
 *
 * Editor area extracted from App.tsx
 * Handles editor tabs, toolbar, Monaco Editor, and image viewer
 */

import React, { useState, useRef, useEffect, useCallback, Suspense, useMemo } from 'react';
import Editor from '@monaco-editor/react';
import { FileSearch, ExternalLink, Download, FileDown, Sparkles, Wand2, Send, Eye, EyeOff, Code2, Palette, BookOpen, ImagePlus, Columns2, Rows2, X, Copy, Check, LayoutDashboard, ZoomIn, ZoomOut, PanelRight } from 'lucide-react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { OctoX } from '../octoIcons';
import { toRelativePath } from './filePathInsert';
import { NoteEditor } from '../notes/NoteEditor';
import { stripFrontmatter, sliceHeadingSection } from '../notes/embedExtension';
import type { EmbedResolution } from '../notes/embedExtension';
import { OutlinePanel } from '../notes/OutlinePanel';
import { BacklinksPanel } from '../notes/BacklinksPanel';
import { TagsPanel } from '../notes/TagsPanel';
import { SimilarNotesPanel } from '../notes/SimilarNotesPanel';
import { useRequestReindex } from '../notes/NoteContext';
import { List, Link2, Hash, Layers } from 'lucide-react';
import { EditorView as CMEditorView } from '@codemirror/view';
import { aiChat } from '../notes/ollamaTagging';
import { AiAutoTagSuggestion, isAutoTagEnabled } from '../notes/AiAutoTagSuggestion';
import type { NoteCompletionItem } from '../notes/wikilinkCompletion';
import type { NoteIndexEntry } from '../notes/noteState';
import type { OpenFile } from '../store/appState';
import type { EditorSettings } from './SettingsPanel';
import type { EditorView } from '@codemirror/view';
import { useTranslation } from '../i18n';
import type { SplitNode } from '../split/SplitTree';
import { createLeaf, createBranch, removeLeaf, collectLeafIds } from '../split/SplitTree';
import { SplitTreeView } from '../split/SplitTreeView';
import { formatFileSize } from '../utils/fileTreeMeta';

// Lazy-load all heavy editors — use default exports directly (avoids WebKit
// "Importing binding name 'default' cannot be resolved by star export entries")
const PdfEditor = React.lazy(() => import('./PdfEditor'));
const DocxEditor = React.lazy(() => import('./DocxEditor'));
const PptxEditor = React.lazy(() => import('./pptx/PptxEditor'));
const XlsxEditor = React.lazy(() => import('./XlsxEditor'));
const CssEditor = React.lazy(() => import('./CssEditor'));
const MarkdownEditor = React.lazy(() => import('./MarkdownEditor'));
const JsonEditor = React.lazy(() => import('./JsonEditor'));
const ImageViewer = React.lazy(() => import('./ImageViewer'));
const HtmlDesignEditor = React.lazy(() => import('./HtmlDesignEditor'));
const EpubReader = React.lazy(() => import('./EpubReader'));
const BookStudio = React.lazy(() => import('./BookStudio'));
const SqliteViewer = React.lazy(() => import('./SqliteViewer').then(m => ({ default: m.SqliteViewer })));
const MermaidFileEditor = React.lazy(() => import('./MermaidFileEditor'));
const VideoEditor = React.lazy(() => import('./VideoEditor'));
const NoteDashboard = React.lazy(() => import('../notes/NoteDashboard'));

// Preload MarkdownEditor chunk in background after app becomes idle
// This eliminates the loading delay when the user first opens a .md file
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(() => { import('./MarkdownEditor'); }, { timeout: 5000 });
} else {
  setTimeout(() => { import('./MarkdownEditor'); }, 3000);
}

// Per-editor error boundary to prevent one broken editor from crashing the entire panel
class EditorErrorBoundary extends React.Component<
  { name: string; children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(`[EditorErrorBoundary] ${this.props.name} failed:`, error); }
  render() {
    if (this.state.error) {
      return (
        <div className="editor-empty" style={{ textAlign: 'center', padding: 40 }}>
          <p style={{ fontSize: 13, opacity: 0.7, margin: '0 0 8px' }}>{this.props.name} — failed to load</p>
          <p style={{ fontSize: 11, opacity: 0.4, margin: '0 0 8px', maxWidth: 400, wordBreak: 'break-all' }}>{this.state.error.message}</p>
          {this.state.error.stack && (
            <pre style={{ fontSize: 9, opacity: 0.3, margin: '0 0 12px', maxWidth: 500, maxHeight: 80, overflow: 'auto', textAlign: 'left', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{this.state.error.stack.split('\n').slice(0, 5).join('\n')}</pre>
          )}
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: '4px 12px', borderRadius: 'var(--brutal-radius)', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: 'inherit', cursor: 'pointer', fontSize: 12 }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export interface EditorPanelProps {
  // File list
  openFiles: OpenFile[];
  activeFilePath: string | null;

  // File operations
  onFileClose: (path: string) => void;
  onFileSelect: (path: string) => void;
  onFileContentChange: (path: string, content: string) => void;
  onFileSave: () => void;
  onFilesReorder: (dragPath: string, dropPath: string) => void;

  // Toolbar actions
  onOpenDocument: () => void;
  onRevealLocation: () => void;

  // Theme/Style
  style: { bg: string; text: string; accent: string };
  fontFamily: string;
  isLightTheme: boolean;

  // Editor settings
  editorSettings: EditorSettings;

  // Monaco hooks
  onEditorBeforeMount: (monaco: any) => void;
  onEditorMount: (editor: any, monaco: any) => void;

  // Vim status element ref
  vimStatusElRef: React.RefObject<HTMLDivElement | null>;

  // Drag & drop support
  isDragDropHover: boolean;

  // NoteEditor (markdown) callbacks
  onWikiLinkClick?: (target: string) => void;
  getNoteList?: () => NoteCompletionItem[];

  // AI auto-tag suggestion
  onTagsAccepted?: (path: string, tags: string[]) => void;
  noteIndex?: NoteIndexEntry[];

  // Kanban tasks (for the note aside's linked-tasks section)
  kanbanTasks?: Array<{ id: string; title: string; column: string; priority: string; linkedNotes?: string[] }>;
  onOpenKanbanTask?: (taskId: string) => void;

  // AI note organize
  onOrganizeNote?: (content: string, filePath: string) => void;

  // Image editor saved callback
  onImageSaved?: (path: string) => void;

  // Office editors (docx/pptx/xlsx) dirty-state propagation to parent tabs
  onFileModifiedChange?: (path: string, modified: boolean) => void;

  // Batch EPUB from parent
  onBatchEpub?: () => void;

  // Open a produced file (e.g. Book Studio's exported EPUB) in this editor
  onOpenFileByPath?: (path: string, focus: boolean) => void;

  // Send generated image/edit jobs to the active terminal.
  onTerminalPrompt?: (prompt: string) => void;
  projectRoot?: string;
  batchEpubAvailable?: boolean;

  // Panel collapse
  onCollapse?: () => void;

  // Dashboard tab (shown as first pinned tab when notes sidebar is active)
  showDashboard?: boolean;
  dashboardProps?: {
    noteIndex: { path: string; title: string; modifiedAt: string; tags: string[]; excerpt: string }[];
    onOpenFile: (path: string) => void;
    projectName?: string;
    openFiles?: { path: string; name: string; kind?: string }[];
    projectId?: string;
  };
}

interface TabContextMenu {
  x: number;
  y: number;
  path: string;
}

function EditorTabContextMenu(props: {
  x: number;
  y: number;
  onClose: () => void;
  onCloseTab: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  onCloseAll: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) props.onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [props.onClose]);
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    let x = props.x;
    let y = props.y;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
  }, [props.x, props.y]);
  return (
    <div ref={ref} className="editor-tab-ctx-menu" style={{ top: pos.y, left: pos.x }}>
      <button onClick={props.onCopyPath} title={t('fileTree.copyPathDesc')}><Copy size={13} /> {t('fileTree.copyPath')}</button>
      <button onClick={props.onCopyRelativePath} title={t('fileTree.copyRelativePathDesc')}><Copy size={13} /> {t('fileTree.copyRelativePath')}</button>
      <div className="editor-tab-ctx-sep" />
      <button onClick={props.onCloseTab} title={t('editor.closeTab')}><OctoX size={13} /> {t('editor.closeBtn')}</button>
      <div className="editor-tab-ctx-sep" />
      <button onClick={props.onCloseOthers} title={t('editor.closeOthers')}><OctoX size={13} /> {t('editor.closeOthers')}</button>
      <button onClick={props.onCloseRight} title={t('editor.closeRight')}><OctoX size={13} /> {t('editor.closeRight')}</button>
      <div className="editor-tab-ctx-sep" />
      <button onClick={props.onCloseAll} title={t('editor.closeAll')}><OctoX size={13} /> {t('editor.closeAll')}</button>
    </div>
  );
}

export function EditorPanel(props: EditorPanelProps) {
  const { t } = useTranslation();
  const [tabCtxMenu, setTabCtxMenu] = useState<TabContextMenu | null>(null);
  const [mdWysiwyg, setMdWysiwyg] = useState(true);
  const [cssWysiwyg, setCssWysiwyg] = useState(true);
  const [jsonTree, setJsonTree] = useState(false);
  const [htmlWysiwyg, setHtmlWysiwyg] = useState(true);
  const [showAiBar, setShowAiBar] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [contentCopied, setContentCopied] = useState(false);
  const [dashboardActive, setDashboardActive] = useState(false);
  const [columnMode, setColumnMode] = useState(false);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorColumn, setCursorColumn] = useState(1);
  const [showNoteAside, setShowNoteAside] = useState(() => localStorage.getItem('octo-note-aside') === '1');
  const [noteAsideTab, setNoteAsideTab] = useState<'outline' | 'backlinks' | 'tags' | 'similar'>(() => {
    const saved = localStorage.getItem('octo-note-aside-tab');
    return saved === 'backlinks' || saved === 'tags' || saved === 'similar' ? saved : 'outline';
  });
  const noteEditorViewRef = useRef<EditorView | null>(null);
  const monacoEditorRef = useRef<any>(null);
  const requestReindex = useRequestReindex();

  useEffect(() => { localStorage.setItem('octo-note-aside', showNoteAside ? '1' : '0'); }, [showNoteAside]);
  useEffect(() => { localStorage.setItem('octo-note-aside-tab', noteAsideTab); }, [noteAsideTab]);

  const updateCursorStatus = useCallback((next: { line: number; column: number }) => {
    setCursorLine(Math.max(1, Number(next.line) || 1));
    setCursorColumn(Math.max(1, Number(next.column) || 1));
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ line?: number }>).detail;
      const requestedLine = Number.parseInt(String(detail?.line ?? ''), 10);
      if (!Number.isFinite(requestedLine) || requestedLine < 1) return;

      const noteView = noteEditorViewRef.current;
      if (noteView) {
        const safeLine = Math.min(requestedLine, noteView.state.doc.lines);
        const line = noteView.state.doc.line(safeLine);
        noteView.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
        noteView.focus();
        return;
      }

      const monacoEditor = monacoEditorRef.current;
      if (monacoEditor?.setPosition) {
        const model = monacoEditor.getModel?.();
        const maxLine = typeof model?.getLineCount === 'function' ? model.getLineCount() : requestedLine;
        const safeLine = Math.min(requestedLine, maxLine || requestedLine);
        monacoEditor.setPosition({ lineNumber: safeLine, column: 1 });
        monacoEditor.revealLineInCenter?.(safeLine);
        monacoEditor.focus?.();
      }
    };

    window.addEventListener('octo-go-to-line', handler as EventListener);
    return () => window.removeEventListener('octo-go-to-line', handler as EventListener);
  }, []);

  useEffect(() => {
    setCursorLine(1);
    setCursorColumn(1);
  }, [props.activeFilePath]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && String(e.key || '').toLowerCase() === 'c') {
        e.preventDefault();
        setColumnMode((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Editor Zoom ──
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3.0;
  const ZOOM_STEP = 0.1;
  const [editorZoom, setEditorZoom] = useState(1.0);
  const zoomedFontSize = Math.round(props.editorSettings.fontSize * editorZoom);

  const zoomIn = useCallback(() => {
    setEditorZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)));
  }, []);
  const zoomOut = useCallback(() => {
    setEditorZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)));
  }, []);
  const zoomReset = useCallback(() => setEditorZoom(1.0), []);

  // Keyboard shortcuts: Cmd+= / Cmd+- / Cmd+0
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomIn(); }
      else if (e.key === '-') { e.preventDefault(); zoomOut(); }
      else if (e.key === '0') { e.preventDefault(); zoomReset(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [zoomIn, zoomOut, zoomReset]);

  // Ctrl+Wheel zoom on editor area
  const editorAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = editorAreaRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else if (e.deltaY > 0) zoomOut();
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [zoomIn, zoomOut]);

  // AI Image generation state (NanoBanana inline)
  const [showImgBar, setShowImgBar] = useState(false);
  const [imgPrompt, setImgPrompt] = useState('');
  const [imgLoading, setImgLoading] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);

  // AI auto-tag suggestion state
  const [showTagSuggestion, setShowTagSuggestion] = useState(false);
  const [tagSuggestionPath, setTagSuggestionPath] = useState<string | null>(null);
  const [tagSuggestionContent, setTagSuggestionContent] = useState('');
  const [tagSuggestionExistingTags, setTagSuggestionExistingTags] = useState<string[]>([]);
  const lastSavedPathRef = useRef<string | null>(null);

  // ── Editor Split State ──
  const [splitTree, setSplitTree] = useState<SplitNode>(createLeaf('pane-0'));
  const [paneFiles, setPaneFiles] = useState<Record<string, string>>({});  // paneId → filePath
  const [focusedPaneId, setFocusedPaneId] = useState('pane-0');
  const paneIdCounter = useRef(1);

  // Sync activeFilePath → focused pane (only in non-split mode or when tab changes)
  const prevActiveFileRef = useRef(props.activeFilePath);
  useEffect(() => {
    // Only sync when activeFilePath actually changes from tab click (not from pane click)
    if (props.activeFilePath && props.activeFilePath !== prevActiveFileRef.current) {
      setPaneFiles(prev => ({ ...prev, [focusedPaneId]: props.activeFilePath! }));
    }
    prevActiveFileRef.current = props.activeFilePath;
  }, [props.activeFilePath, focusedPaneId]);

  const isSplit = splitTree.type === 'branch';

  const handleSplitRight = useCallback(() => {
    const newId = `pane-${paneIdCounter.current++}`;
    const currentFile = paneFiles[focusedPaneId] || props.activeFilePath || '';
    setSplitTree(prev => {
      if (prev.type === 'leaf') {
        return createBranch('horizontal', prev, createLeaf(newId));
      }
      // Split the focused pane
      const splitFocused = (node: SplitNode): SplitNode => {
        if (node.type === 'leaf') {
          if (node.id === focusedPaneId) {
            return createBranch('horizontal', node, createLeaf(newId));
          }
          return node;
        }
        return { ...node, first: splitFocused(node.first), second: splitFocused(node.second) };
      };
      return splitFocused(prev);
    });
    // Ensure BOTH the original pane and new pane have file mappings
    setPaneFiles(prev => ({
      ...prev,
      [focusedPaneId]: currentFile,
      [newId]: currentFile,
    }));
  }, [focusedPaneId, paneFiles, props.activeFilePath]);

  const handleSplitDown = useCallback(() => {
    const newId = `pane-${paneIdCounter.current++}`;
    const currentFile = paneFiles[focusedPaneId] || props.activeFilePath || '';
    setSplitTree(prev => {
      if (prev.type === 'leaf') {
        return createBranch('vertical', prev, createLeaf(newId));
      }
      const splitFocused = (node: SplitNode): SplitNode => {
        if (node.type === 'leaf') {
          if (node.id === focusedPaneId) {
            return createBranch('vertical', node, createLeaf(newId));
          }
          return node;
        }
        return { ...node, first: splitFocused(node.first), second: splitFocused(node.second) };
      };
      return splitFocused(prev);
    });
    // Ensure BOTH the original pane and new pane have file mappings
    setPaneFiles(prev => ({
      ...prev,
      [focusedPaneId]: currentFile,
      [newId]: currentFile,
    }));
  }, [focusedPaneId, paneFiles, props.activeFilePath]);

  const handleClosePane = useCallback((paneId: string) => {
    const leaves = collectLeafIds(splitTree);
    if (leaves.length <= 1) return; // Don't close last pane
    setSplitTree(prev => {
      const result = removeLeaf(prev, paneId);
      return result || createLeaf('pane-0');
    });
    setPaneFiles(prev => {
      const next = { ...prev };
      delete next[paneId];
      return next;
    });
    const remaining = collectLeafIds(splitTree).filter(id => id !== paneId);
    if (focusedPaneId === paneId && remaining.length > 0) {
      setFocusedPaneId(remaining[0]);
      const newActiveFile = paneFiles[remaining[0]];
      if (newActiveFile) props.onFileSelect(newActiveFile);
    }
  }, [splitTree, focusedPaneId, paneFiles, props.onFileSelect]);

  const handleSplitRatioChange = useCallback((path: number[], newRatio: number) => {
    setSplitTree(prev => {
      const update = (node: SplitNode, p: number[]): SplitNode => {
        if (node.type === 'leaf') return node;
        if (p.length === 0) return { ...node, ratio: Math.max(0.15, Math.min(0.85, newRatio)) };
        const [head, ...rest] = p;
        if (head === 0) return { ...node, first: update(node.first, rest) };
        return { ...node, second: update(node.second, rest) };
      };
      return update(prev, path);
    });
  }, []);

  const handleSplitEqualize = useCallback((_path: number[]) => {
    setSplitTree(prev => {
      const eq = (node: SplitNode): SplitNode => {
        if (node.type === 'leaf') return node;
        return { ...node, ratio: 0.5, first: eq(node.first), second: eq(node.second) };
      };
      return eq(prev);
    });
  }, []);

  const activeFile = props.openFiles.find(f => f.path === props.activeFilePath);
  const activeFileSizeLabel = useMemo(
    () => formatFileSize(activeFile?.sizeBytes),
    [activeFile?.sizeBytes],
  );

  // Helper: Get Monaco language from file extension
  const getLanguageFromPath = (path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
      c: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift',
      kt: 'kotlin', scala: 'scala', sh: 'shell', bash: 'shell', zsh: 'shell',
      html: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
      json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
      md: 'markdown', sql: 'sql', dockerfile: 'dockerfile',
    };
    return langMap[ext] || 'plaintext';
  };

  // Tab operations
  const handleTabDrop = (dragPath: string, dropPath: string) => {
    props.onFilesReorder(dragPath, dropPath);
  };

  const closeOtherFiles = (keepPath: string) => {
    const filesToClose = props.openFiles.filter(f => f.path !== keepPath);
    filesToClose.forEach(f => props.onFileClose(f.path));
  };

  const closeTabsToRight = (path: string) => {
    const idx = props.openFiles.findIndex(f => f.path === path);
    if (idx >= 0) {
      const filesToClose = props.openFiles.slice(idx + 1);
      filesToClose.forEach(f => props.onFileClose(f.path));
    }
  };

  const closeAllFiles = () => {
    props.openFiles.forEach(f => props.onFileClose(f.path));
  };

  const copyTabPath = (text: string) => {
    void invoke('copy_to_clipboard', { text }).catch(() => {
      void navigator.clipboard.writeText(text).catch(() => {});
    });
  };

  // AI generation handler
  const handleAiGenerate = async () => {
    if (!aiPrompt.trim() || aiLoading) return;
    if (!activeFile) return;

    setAiLoading(true);
    setAiError(null);
    try {
      const systemPrompt = `You are a technical writer assistant editing a markdown document.
Based on the user's instruction, generate content to add to the document.
- Write in the same language as the document or user prompt
- Output ONLY the content to insert, no explanations or wrapping
- Use proper markdown formatting`;

      const context = activeFile.content
        ? `Current document:\n\`\`\`\n${activeFile.content}\n\`\`\`\n\nInstruction: ${aiPrompt}`
        : aiPrompt;

      const result = await aiChat(systemPrompt, context);

      // CodeMirror: insert at cursor position
      const view = noteEditorViewRef.current;
      if (view) {
        const cursor = view.state.selection.main.head;
        const insert = (cursor > 0 ? '\n\n' : '') + result.trim() + '\n';
        view.dispatch({ changes: { from: cursor, insert } });
      } else {
        // Fallback: append to end
        const newContent = (activeFile.content || '') + '\n\n' + result.trim() + '\n';
        props.onFileContentChange(activeFile.path, newContent);
      }

      setAiPrompt('');
      setShowAiBar(false);
    } catch (err) {
      console.error('[AI] Editor generation failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setAiError(msg);
    } finally {
      setAiLoading(false);
    }
  };

  // Image generation handler — creates a target image path and sends the job to Codex terminal.
  const handleImgGenerate = async () => {
    if (!imgPrompt.trim() || imgLoading) return;
    if (!activeFile) return;

    setImgLoading(true);
    setImgError(null);
    try {
      const ts = Date.now();
      const filename = `img_${ts}`;
      const fileDir = activeFile.path.split('/').slice(0, -1).join('/') || props.projectRoot || '';
      const imageDir = `${fileDir}/img`;
      const savedPath = `${imageDir}/${filename}.png`;
      const promptPath = `${imageDir}/${filename}.prompt.md`;
      await invoke('create_directory', { path: imageDir });
      await invoke('write_file', {
        path: promptPath,
        content: `# Markdown Image Codex Prompt

## Job
- Source markdown: ${activeFile.path}
- Target image path: ${savedPath}
- Prompt file: ${promptPath}

## Hard Rules
- Use Codex for this image generation task.
- Do not use Gemini, Gemini API keys, or NanoBanana.
- If an external image API is needed, use only an API explicitly configured by the user/project.
- Save the final image exactly to the target image path above.
- After finishing, report the saved image path.

## User Prompt
${imgPrompt.trim()}
`,
      });

      // Build relative path from current file to saved image
      const imgFileName = savedPath ? savedPath.split('/').pop() : `${filename}.png`;
      let mdImgPath = `docs/img/${imgFileName}`;
      if (savedPath && activeFile.path) {
        const fileDir = activeFile.path.split('/').slice(0, -1).join('/');
        const imgDir = savedPath.split('/').slice(0, -1).join('/');
        if (savedPath.startsWith(fileDir)) {
          // Image is inside or near the file's directory
          mdImgPath = savedPath.substring(fileDir.length + 1);
        } else {
          // Find common prefix and build relative path
          const fileParts = fileDir.split('/');
          const imgParts = imgDir.split('/');
          let common = 0;
          while (common < fileParts.length && common < imgParts.length && fileParts[common] === imgParts[common]) common++;
          const ups = fileParts.length - common;
          const rel = imgParts.slice(common).join('/');
          mdImgPath = (ups > 0 ? '../'.repeat(ups) : './') + (rel ? rel + '/' : '') + imgFileName;
        }
      }
      const mdImg = `![${imgPrompt}](${mdImgPath})`;

      const view = noteEditorViewRef.current;
      if (view) {
        const cursor = view.state.selection.main.head;
        const insert = (cursor > 0 ? '\n\n' : '') + mdImg + '\n';
        view.dispatch({ changes: { from: cursor, insert } });
      } else {
        const newContent = (activeFile.content || '') + '\n\n' + mdImg + '\n';
        props.onFileContentChange(activeFile.path, newContent);
      }

      props.onTerminalPrompt?.(`Markdown 이미지 작업을 Codex로 실행해줘.

프롬프트 파일: ${promptPath}
결과 이미지 저장 경로: ${savedPath}

규칙:
1. 프롬프트 파일을 읽고 이미지 생성 작업을 수행해.
2. Gemini, Gemini API 키, NanoBanana는 절대 사용하지 마.
3. Codex의 이미지 생성 기능을 우선 사용하고, 필요하면 사용자가 설정한 이미지 API만 사용해.
4. 결과 이미지를 정확히 위 저장 경로에 저장해.
5. 완료 후 저장 경로만 짧게 알려줘.`);

      setImgPrompt('');
      setShowImgBar(false);
    } catch (err) {
      console.error('[AI Image] Generation failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setImgError(msg);
    } finally {
      setImgLoading(false);
    }
  };

  // Markdown to PDF export handler — saves to same folder as source file by default
  const handleExportPdf = useCallback(async () => {
    if (!activeFile || pdfExporting) return;
    const content = activeFile.content || '';
    if (!content.trim()) return;

    setPdfExporting(true);
    try {
      // Derive default filename and save path (same folder as source)
      const baseName = (activeFile.path.split('/').pop() || 'document').replace(/\.(md|markdown)$/i, '');
      const dir = activeFile.path.split('/').slice(0, -1).join('/');
      const savePath = `${dir}/${baseName}.pdf`;

      // Convert markdown to PDF (base64) — dynamic import to avoid eager loading of html2pdf.js
      const { markdownToPdfBase64 } = await import('../utils/mdToPdf');
      const base64Data = await markdownToPdfBase64({
        markdown: content,
        isLightTheme: props.isLightTheme,
        fontFamily: props.fontFamily,
        filename: baseName,
      });

      // Write PDF to disk (same folder as source .md file)
      await invoke('write_file_base64', { path: savePath, base64Data });
      console.log('[EditorPanel] PDF exported to:', savePath);
    } catch (err) {
      console.error('[EditorPanel] PDF export failed:', err);
    } finally {
      setPdfExporting(false);
    }
  }, [activeFile, pdfExporting, props.isLightTheme, props.fontFamily]);


  // Trigger AI auto-tag suggestion after markdown file save
  const triggerAutoTagSuggestion = useCallback(async (path: string, content: string, existingTags: string[]) => {
    if (!(await isAutoTagEnabled())) return;
    if (!path.endsWith('.md')) return;

    setTagSuggestionPath(path);
    setTagSuggestionContent(content);
    setTagSuggestionExistingTags(existingTags);
    setShowTagSuggestion(true);
  }, []);

  // Watch for saves on markdown files: detect when a file transitions from modified to not-modified
  useEffect(() => {
    if (!activeFile) return;
    if (activeFile.kind !== 'markdown') return;

    // When the file was just saved (modified becomes false after being true)
    if (!activeFile.modified && lastSavedPathRef.current === activeFile.path) {
      // File was saved - trigger auto-tag
      const noteEntry = props.noteIndex?.find(n => n.path === activeFile.path);
      const existingTags = noteEntry?.tags || [];
      triggerAutoTagSuggestion(activeFile.path, activeFile.content || '', existingTags);
      lastSavedPathRef.current = null;
    } else if (activeFile.modified) {
      // Track that this file is modified (so we can detect the save transition)
      lastSavedPathRef.current = activeFile.path;
    }
  }, [activeFile?.modified, activeFile?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAutoTagDismiss = useCallback(() => {
    setShowTagSuggestion(false);
    setTagSuggestionPath(null);
  }, []);

  const handleAutoTagAccept = useCallback((tags: string[]) => {
    if (tagSuggestionPath && props.onTagsAccepted) {
      props.onTagsAccepted(tagSuggestionPath, tags);
    }
  }, [tagSuggestionPath, props.onTagsAccepted]);

  // ![[embed]] resolution for NoteEditor transclusion previews
  const noteIndexForEmbedRef = useRef(props.noteIndex);
  useEffect(() => { noteIndexForEmbedRef.current = props.noteIndex; }, [props.noteIndex]);
  const resolveNoteEmbed = useCallback(async (rawTarget: string, fromPath: string): Promise<EmbedResolution | null> => {
    const target = rawTarget.trim();
    const hashIdx = target.indexOf('#');
    const namePart = (hashIdx === -1 ? target : target.slice(0, hashIdx)).trim();
    const heading = hashIdx === -1 ? '' : target.slice(hashIdx + 1).trim();
    if (!namePart) return null;
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(namePart)) {
      const sep = fromPath.includes('\\') ? '\\' : '/';
      const dir = fromPath.slice(0, fromPath.lastIndexOf(sep));
      const candidate = /^([a-zA-Z]:[\\/]|\/)/.test(namePart) ? namePart : `${dir}${sep}${namePart}`;
      try {
        await invoke('file_metadata', { path: candidate });
        return { kind: 'image', src: convertFileSrc(candidate) };
      } catch {
        return null;
      }
    }
    const lower = namePart.replace(/\.md$/i, '').toLowerCase();
    const entry = (noteIndexForEmbedRef.current || []).find(e =>
      e.name.toLowerCase() === lower ||
      e.title.toLowerCase() === lower ||
      (e.aliases || []).some(a => a.toLowerCase() === lower));
    if (!entry || entry.path === fromPath) return null;
    try {
      let content = stripFrontmatter(await invoke<string>('read_file', { path: entry.path }));
      if (heading) content = sliceHeadingSection(content, heading);
      return { kind: 'note', title: entry.title || entry.name, path: entry.path, content: content.trim() };
    } catch {
      return null;
    }
  }, []);

  // Outline panel: scroll the active markdown editor to a heading
  const handleOutlineHeadingClick = useCallback((line: number, text: string) => {
    const view = noteEditorViewRef.current;
    if (view && view.dom.isConnected) {
      const ln = Math.max(1, Math.min(line, view.state.doc.lines));
      const pos = view.state.doc.line(ln).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: CMEditorView.scrollIntoView(pos, { y: 'start' }),
      });
      view.focus();
      return;
    }
    // WYSIWYG (Tiptap) mode: find the rendered heading by text
    const area = editorAreaRef.current;
    if (!area) return;
    const lower = text.trim().toLowerCase();
    const headings = area.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const el of headings) {
      if ((el.textContent || '').trim().toLowerCase() === lower) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
    }
  }, []);

  // Render editor content for a given file (used by both single & split modes)
  const renderEditorContent = (file: OpenFile | undefined) => {
    if (!file) return <div className="editor-empty">{t('editor.openFile' as any)}</div>;
    if (file.kind === 'book') return <EditorErrorBoundary name="Book Studio" key={`eb-${file.path}`}><Suspense fallback={<div className="editor-empty">Loading Book Studio...</div>}><BookStudio filePath={file.path} style={props.style} isLightTheme={props.isLightTheme} fontFamily={props.fontFamily} onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(file.path, m)} onSaved={props.onImageSaved} onOpenFileByPath={props.onOpenFileByPath} /></Suspense></EditorErrorBoundary>;
    if (file.kind === 'sqlite') return <EditorErrorBoundary name="SQLite" key={`eb-${file.path}`}><Suspense fallback={<div className="editor-empty">Loading SQLite...</div>}><SqliteViewer filePath={file.path} style={props.style} /></Suspense></EditorErrorBoundary>;
    if (file.kind === 'epub') return <EditorErrorBoundary name="EPUB" key={`eb-${file.path}`}><EpubReader filePath={file.path} epubData={file.content || ''} style={props.style} onSaved={props.onImageSaved} onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(file.path, m)} /></EditorErrorBoundary>;
    if (file.kind === 'pdf') return <EditorErrorBoundary name="PDF" key={`eb-${file.path}`}><PdfEditor filePath={file.path} pdfData={file.content || ''} style={props.style} onSaved={props.onImageSaved} onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(file.path, m)} /></EditorErrorBoundary>;
    // 오피스 3종은 React.lazy 컴포넌트이므로 반드시 Suspense로 감싼다. 없으면
    // 청크 로딩이 pending일 때 React가 상위로 throw해 에디터가 마운트되지 못하고,
    // 그 결과 octo-<kind>-command 리스너가 등록되지 않아 에이전트/슬래시 명령의
    // 브릿지가 "editor not responding"으로 타임아웃한다(docx/pptx 실측).
    if (file.kind === 'pptx') return <EditorErrorBoundary name="PPTX" key={`eb-${file.path}`}><Suspense fallback={<div className="editor-empty">Loading PPTX...</div>}><PptxEditor filePath={file.path} pptxData={file.content || ''} style={props.style} onSaved={props.onImageSaved} onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(file.path, m)} /></Suspense></EditorErrorBoundary>;
    if (file.kind === 'docx') return <EditorErrorBoundary name="DOCX" key={`eb-${file.path}`}><Suspense fallback={<div className="editor-empty">Loading DOCX...</div>}><DocxEditor filePath={file.path} docData={file.content || ''} style={props.style} onSaved={props.onImageSaved} onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(file.path, m)} /></Suspense></EditorErrorBoundary>;
    if (file.kind === 'xlsx') return <EditorErrorBoundary name="XLSX" key={`eb-${file.path}`}><Suspense fallback={<div className="editor-empty">Loading XLSX...</div>}><XlsxEditor filePath={file.path} xlsxData={file.content || ''} style={props.style} onSaved={props.onImageSaved} onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(file.path, m)} /></Suspense></EditorErrorBoundary>;
    if (file.kind === 'video') return <EditorErrorBoundary name="Video" key={`eb-${file.path}`}><Suspense fallback={<div className="editor-empty">Loading Video...</div>}><VideoEditor filePath={file.path} videoUrl={file.content || ''} fileName={file.name} style={props.style} /></Suspense></EditorErrorBoundary>;
    if (file.kind === 'audio') return <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', gap: 16 }}><div style={{ fontSize: 48, opacity: 0.3 }}>&#9835;</div><p style={{ fontSize: 13, opacity: 0.7, margin: 0 }}>{file.name}</p><audio key={file.path} src={file.content} controls autoPlay={false} style={{ width: '80%', maxWidth: 500 }} /></div>;
    if (file.kind === 'image') return <EditorErrorBoundary name="Image" key={`eb-${file.path}`}><ImageViewer src={file.content} fileName={file.name} filePath={file.path} style={props.style} onSaved={props.onImageSaved} onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(file.path, m)} /></EditorErrorBoundary>;
    if (file.kind === 'mermaid') {
      return (
        <EditorErrorBoundary name="Mermaid" key={`eb-${file.path}`}>
          <Suspense fallback={<div className="editor-empty">Loading Mermaid...</div>}>
            <MermaidFileEditor content={file.content || ''} onChange={(value) => props.onFileContentChange(file.path, value)} onSave={props.onFileSave} style={props.style} fontFamily={props.fontFamily} fontSize={zoomedFontSize} isLightTheme={props.isLightTheme} />
          </Suspense>
        </EditorErrorBoundary>
      );
    }
    if (file.kind === 'markdown') {
      return mdWysiwyg ? (
        <EditorErrorBoundary name="Markdown" key={`eb-${file.path}`}>
          <MarkdownEditor content={file.content || ''} onChange={(value) => props.onFileContentChange(file.path, value)} onSave={props.onFileSave} style={props.style} fontFamily={props.fontFamily} fontSize={zoomedFontSize} isLightTheme={props.isLightTheme} />
        </EditorErrorBoundary>
      ) : (
        <NoteEditor key={file.path} content={file.content} onChange={(value) => props.onFileContentChange(file.path, value)} onSave={props.onFileSave} onWikiLinkClick={props.onWikiLinkClick} style={props.style} fontFamily={props.fontFamily} fontSize={zoomedFontSize} isLightTheme={props.isLightTheme} getNoteList={props.getNoteList} noteIndex={props.noteIndex} currentFilePath={file.path} editorViewRef={noteEditorViewRef} resolveEmbed={(target) => resolveNoteEmbed(target, file.path)} />
      );
    }
    if (jsonTree && file.kind === 'text' && file.path?.match(/\.json$/i)) return <EditorErrorBoundary name="JSON" key={`eb-${file.path}`}><JsonEditor content={file.content || ''} onChange={(value) => props.onFileContentChange(file.path, value)} onSave={props.onFileSave} style={props.style} fontFamily={props.fontFamily} fontSize={zoomedFontSize} isLightTheme={props.isLightTheme} /></EditorErrorBoundary>;
    if (cssWysiwyg && file.kind === 'text' && file.path?.match(/\.css$/i)) return <EditorErrorBoundary name="CSS" key={`eb-${file.path}`}><CssEditor content={file.content || ''} onChange={(value) => props.onFileContentChange(file.path, value)} onSave={props.onFileSave} style={props.style} fontFamily={props.fontFamily} fontSize={zoomedFontSize} isLightTheme={props.isLightTheme} /></EditorErrorBoundary>;
    if (htmlWysiwyg && file.kind === 'html') return <EditorErrorBoundary name="HTML" key={`eb-${file.path}`}><HtmlDesignEditor content={file.content || ''} onChange={(value) => props.onFileContentChange(file.path, value)} onSave={props.onFileSave} style={props.style} fontFamily={props.fontFamily} fontSize={zoomedFontSize} isLightTheme={props.isLightTheme} /></EditorErrorBoundary>;
    return (
      <Editor
        path={file.path || 'untitled'}
        language={getLanguageFromPath(file.path || '')}
        value={file.content || ''}
        theme={props.isLightTheme ? 'octo-light' : 'octo-dark'}
        onChange={(value) => {
          if (value === undefined) return;
          // Save/restore cursor to prevent jump when React re-renders with new value
          const ed = monacoEditorRef.current;
          const pos = ed?.getPosition();
          const scrollTop = ed?.getScrollTop();
          props.onFileContentChange(file.path, value);
          if (ed && pos) {
            requestAnimationFrame(() => {
              ed.setPosition(pos);
              if (scrollTop !== undefined) ed.setScrollTop(scrollTop);
            });
          }
        }}
        beforeMount={props.onEditorBeforeMount as any}
        onMount={(editor, monaco) => { monacoEditorRef.current = editor; props.onEditorMount(editor, monaco); }}
        loading={<div className="editor-empty">{t('editor.loadingEditor')}</div>}
        options={{
          minimap: { enabled: props.editorSettings.minimap, scale: 2 },
          fontSize: zoomedFontSize,
          fontFamily: props.fontFamily,
          fontLigatures: true,
          wordWrap: props.editorSettings.wordWrap ? 'on' : 'off',
          automaticLayout: true,
          scrollBeyondLastLine: false,
          lineNumbers: 'on',
          renderWhitespace: props.editorSettings.renderWhitespace,
          bracketPairColorization: { enabled: true },
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          padding: { top: 8, bottom: 8 },
          suggest: { preview: true },
          stickyScroll: { enabled: true },
        }}
      />
    );
  };

  // Auto-activate dashboard when notes tab is active and no file is selected
  const showDash = props.showDashboard && props.dashboardProps;
  const isDashboardView = showDash && (dashboardActive || !props.activeFilePath);

  // Empty state
  if (props.openFiles.length === 0 && !showDash) {
    return (
      <div className="editor-area">
        <div className="editor-empty">{t('editor.openFile' as any)}</div>
      </div>
    );
  }

  return (
    <div ref={editorAreaRef} className={`editor-area ${props.isDragDropHover ? 'drag-drop-hover' : ''}`}>
      {/* Editor Tabs */}
      <div className="editor-tabs">
        {props.onCollapse && (
          <button
            className="btn-panel-eye"
            onClick={props.onCollapse}
            title="Hide editor"
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.4, padding: '0 5px', display: 'flex', alignItems: 'center', flexShrink: 0, transition: 'opacity 0.05s' }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '0.4')}
          >
            <EyeOff size={13} />
          </button>
        )}
        <div className="editor-tabs-scroll">
        {showDash && (
          <div
            className={`editor-tab dashboard-tab ${isDashboardView ? 'active' : ''}`}
            onClick={() => { setDashboardActive(true); }}
            style={isDashboardView ? { borderBottomColor: props.style.accent } : undefined}
          >
            <LayoutDashboard size={12} style={{ marginRight: 3, opacity: 0.7 }} />
            <span>{t('dashboard.title' as any)}</span>
          </div>
        )}
        {props.openFiles.map(file => (
          <div
            key={file.path}
            className={`editor-tab ${file.path === props.activeFilePath && !isDashboardView ? 'active' : ''}`}
            title={file.name}
            draggable
            onClick={() => { setDashboardActive(false); props.onFileSelect(file.path); }}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                props.onFileClose(file.path);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setTabCtxMenu({ x: e.clientX, y: e.clientY, path: file.path });
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData('editor-tab-path', file.path);
              // Also expose the path as plain text so dropping a tab into a
              // terminal or the AI chat inserts the file path. 'copyMove' keeps
              // both tab reordering (move) and path insertion (copy) valid.
              e.dataTransfer.setData('text/plain', file.path);
              e.dataTransfer.effectAllowed = 'copyMove';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              e.currentTarget.classList.add('drag-over');
            }}
            onDragLeave={(e) => {
              e.currentTarget.classList.remove('drag-over');
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('drag-over');
              const dragPath = e.dataTransfer.getData('editor-tab-path');
              if (dragPath) handleTabDrop(dragPath, file.path);
            }}
          >
            <span className="editor-tab-label">{file.name}{file.modified && ' •'}</span>
            <span
              className="editor-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                props.onFileClose(file.path);
              }}
            >
              <OctoX size={14} />
            </span>
          </div>
        ))}
        </div>
        {props.openFiles.length > 0 && (
          <button className="btn-close-all-tabs" onClick={closeAllFiles} title={t('editor.closeAll')}>
            <OctoX size={12} /> {t('editor.closeAll')}
          </button>
        )}
      </div>

      {/* Tab Context Menu */}
      {tabCtxMenu && (
        <EditorTabContextMenu
          x={tabCtxMenu.x}
          y={tabCtxMenu.y}
          onClose={() => setTabCtxMenu(null)}
          onCloseTab={() => {
            props.onFileClose(tabCtxMenu.path);
            setTabCtxMenu(null);
          }}
          onCloseOthers={() => {
            closeOtherFiles(tabCtxMenu.path);
            setTabCtxMenu(null);
          }}
          onCloseRight={() => {
            closeTabsToRight(tabCtxMenu.path);
            setTabCtxMenu(null);
          }}
          onCloseAll={() => {
            closeAllFiles();
            setTabCtxMenu(null);
          }}
          onCopyPath={() => {
            copyTabPath(tabCtxMenu.path);
            setTabCtxMenu(null);
          }}
          onCopyRelativePath={() => {
            copyTabPath(toRelativePath(tabCtxMenu.path, props.projectRoot));
            setTabCtxMenu(null);
          }}
        />
      )}

      {/* Editor Toolbar */}
      <div className="editor-toolbar">
        <span
          className="editor-path"
          onClick={() => {
            if (!activeFile?.path) return;
            navigator.clipboard.writeText(activeFile.path).catch(() => {});
            setPathCopied(true);
            setTimeout(() => setPathCopied(false), 1500);
          }}
          style={{ cursor: activeFile?.path ? 'pointer' : 'default' }}
          title="Click to copy path"
        >
          {activeFile?.path}
          {activeFile?.path && (
            <span style={{ marginLeft: 4, opacity: 0.5, display: 'inline-flex', verticalAlign: 'middle' }}>
              {pathCopied ? <Check size={11} /> : <Copy size={11} />}
            </span>
          )}
        </span>
        <div
          ref={props.vimStatusElRef}
          className="editor-vim-status"
          style={{ display: (props.editorSettings.vimMode && activeFile?.kind !== 'image') ? 'block' : 'none' }}
        />
        <div className="editor-actions">
          {/* View mode toggles */}
          {(activeFile?.kind === 'markdown' || activeFile?.path?.match(/\.(md|markdown)$/i)) && (
            <div className="editor-action-group">
              <button
                className={`btn-save ${mdWysiwyg ? 'active' : ''}`}
                onClick={() => setMdWysiwyg(prev => !prev)}
                title={mdWysiwyg ? t('editor.switchToSource' as any) : t('editor.switchToWysiwyg' as any)}
              >
                {mdWysiwyg ? <Code2 size={13} /> : <Eye size={13} />}
              </button>
              <button
                className={`btn-save ${showNoteAside ? 'active' : ''}`}
                onClick={() => setShowNoteAside(prev => !prev)}
                title="Note panels (outline, backlinks, tags, similar)"
              >
                <PanelRight size={13} />
              </button>
              <button
                className={`btn-save ${showAiBar ? 'active' : ''}`}
                onClick={() => { setShowAiBar(prev => !prev); setShowImgBar(false); }}
                title={t('editor.aiAddContent' as any)}
              >
                <Sparkles size={13} />
              </button>
              <button
                className={`btn-save ${showImgBar ? 'active' : ''}`}
                onClick={() => { setShowImgBar(prev => !prev); setShowAiBar(false); }}
                title={t('editor.aiGenerateImage' as any)}
              >
                <ImagePlus size={13} />
              </button>
              {props.onOrganizeNote && activeFile && (
                <button
                  className="btn-save"
                  onClick={() => props.onOrganizeNote!(activeFile.content || '', activeFile.path)}
                  title={t('editor.aiOrganizeNote' as any)}
                >
                  <Wand2 size={13} />
                </button>
              )}
              <button
                className="btn-save"
                onClick={() => void handleExportPdf()}
                disabled={pdfExporting || !activeFile?.content?.trim()}
                title={pdfExporting ? t('editor.exportingPdf' as any) : t('editor.exportPdf' as any)}
              >
                {pdfExporting
                  ? <span className="editor-ai-spinner" style={{ width: 13, height: 13 }} />
                  : <FileDown size={13} />}
              </button>
            </div>
          )}
          {props.onBatchEpub && (
            <button
              className="btn-save"
              onClick={props.onBatchEpub}
              title="Export as EPUB"
            >
              <BookOpen size={13} />
            </button>
          )}
          {activeFile?.kind === 'text' && activeFile?.path?.match(/\.json$/i) && (
            <button
              className={`btn-save ${jsonTree ? 'active' : ''}`}
              onClick={() => setJsonTree(prev => !prev)}
              title={jsonTree ? t('editor.switchToMonaco' as any) : t('editor.switchToJsonTree' as any)}
            >
              {jsonTree ? <Code2 size={13} /> : <Eye size={13} />}
            </button>
          )}
          {activeFile?.kind === 'text' && activeFile?.path?.match(/\.css$/i) && (
            <button
              className={`btn-save ${cssWysiwyg ? 'active' : ''}`}
              onClick={() => setCssWysiwyg(prev => !prev)}
              title={cssWysiwyg ? t('editor.switchToMonaco' as any) : t('editor.switchToCssVisual' as any)}
            >
              {cssWysiwyg ? <Code2 size={13} /> : <Palette size={13} />}
            </button>
          )}
          {activeFile?.kind === 'html' && (
            <button
              className={`btn-save ${htmlWysiwyg ? 'active' : ''}`}
              onClick={() => setHtmlWysiwyg(prev => !prev)}
              title={htmlWysiwyg ? t('editor.switchToMonaco' as any) : t('editor.switchToHtmlDesign' as any)}
            >
              {htmlWysiwyg ? <Code2 size={13} /> : <Eye size={13} />}
            </button>
          )}
          <span className="editor-toolbar-sep" />
          {/* File actions */}
          <div className="editor-action-group">
            <button
              className="btn-save"
              onClick={props.onOpenDocument}
              title={t('editor.openDocument')}
            >
              <FileSearch size={13} />
            </button>
            <button
              className="btn-save"
              onClick={props.onRevealLocation}
              disabled={!props.activeFilePath}
              title={t('editor.revealInFinder')}
            >
              <ExternalLink size={13} />
            </button>
            <button
              className="btn-save"
              onClick={props.onFileSave}
              disabled={activeFile?.kind === 'image' || activeFile?.kind === 'video' || activeFile?.kind === 'audio' || activeFile?.kind === 'pdf' || activeFile?.kind === 'docx' || activeFile?.kind === 'pptx' || activeFile?.kind === 'xlsx' || activeFile?.kind === 'epub' || activeFile?.kind === 'sqlite' || activeFile?.kind === 'book' || !activeFile?.modified}
              title={t('editor.fileSave')}
            >
              <Download size={13} />
            </button>
          </div>
          <span className="editor-toolbar-sep" />
          {/* Zoom controls */}
          <div className="editor-action-group">
            <button className="btn-save" onClick={zoomOut} title="Zoom Out (Cmd+-)" disabled={editorZoom <= ZOOM_MIN}>
              <ZoomOut size={13} />
            </button>
            <button
              className="btn-save editor-zoom-label"
              onClick={zoomReset}
              title="Reset Zoom (Cmd+0)"
              style={{ fontSize: 10, minWidth: 36, justifyContent: 'center', opacity: editorZoom === 1.0 ? 0.5 : 1 }}
            >
              {Math.round(editorZoom * 100)}%
            </button>
            <button className="btn-save" onClick={zoomIn} title="Zoom In (Cmd+=)" disabled={editorZoom >= ZOOM_MAX}>
              <ZoomIn size={13} />
            </button>
          </div>
          <span className="editor-toolbar-sep" />
          {/* Split actions */}
          <div className="editor-action-group">
            <button className={`btn-save ${columnMode ? 'active' : ''}`} onClick={() => setColumnMode((prev) => !prev)} title="Column Mode (Alt+C)">
              <Columns2 size={13} />
            </button>
            <button className="btn-save" onClick={handleSplitRight} title="Split Right">
              <Columns2 size={13} />
            </button>
            <button className="btn-save" onClick={handleSplitDown} title="Split Down">
              <Rows2 size={13} />
            </button>
          </div>
          <span className="editor-toolbar-sep" />
          {/* Copy all content */}
          <button
            className="btn-save"
            onClick={() => {
              const text = activeFile?.content;
              if (!text) return;
              navigator.clipboard.writeText(text).catch(() => {});
              setContentCopied(true);
              setTimeout(() => setContentCopied(false), 1500);
            }}
            disabled={!activeFile?.content}
            title={t('editor.copyAll' as any) || 'Copy All'}
          >
            {contentCopied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      </div>

      {/* Editor Content Area */}
      <div className="editor-with-lines">
        {isDashboardView && props.dashboardProps ? (
          <Suspense fallback={null}>
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 0 }}>
              <NoteDashboard
                accent={props.style.accent}
                noteIndex={props.dashboardProps.noteIndex}
                onOpenFile={(path) => { setDashboardActive(false); props.dashboardProps!.onOpenFile(path); }}
                projectName={props.dashboardProps.projectName}
                openFiles={props.dashboardProps.openFiles}
                projectId={props.dashboardProps.projectId}
                collapsed={false}
                onToggleCollapse={() => {}}
              />
            </div>
          </Suspense>
        ) : isSplit ? (
          <SplitTreeView
            node={splitTree}
            accentColor={props.style.accent}
            onRatioChange={handleSplitRatioChange}
            onEqualize={handleSplitEqualize}
            renderLeaf={(paneId) => {
              const paneFilePath = paneFiles[paneId] || props.activeFilePath;
              const paneFile = props.openFiles.find(f => f.path === paneFilePath);
              const isFocused = paneId === focusedPaneId;
              return (
                <div
                  className={`editor-split-pane${isFocused ? ' focused' : ''}`}
                  onClick={() => {
                    setFocusedPaneId(paneId);
                    if (paneFilePath) props.onFileSelect(paneFilePath);
                  }}
                  style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}
                >
                  {/* Pane header: mini tab + close */}
                  <div className="editor-split-pane-header">
                    <select
                      className="editor-split-pane-select"
                      value={paneFilePath || ''}
                      onChange={(e) => {
                        const newPath = e.target.value;
                        setPaneFiles(prev => ({ ...prev, [paneId]: newPath }));
                        setFocusedPaneId(paneId);
                        props.onFileSelect(newPath);
                      }}
                    >
                      {props.openFiles.map(f => (
                        <option key={f.path} value={f.path}>{f.name}{f.modified ? ' •' : ''}</option>
                      ))}
                    </select>
                    {collectLeafIds(splitTree).length > 1 && (
                      <button
                        className="editor-split-pane-close"
                        onClick={(e) => { e.stopPropagation(); handleClosePane(paneId); }}
                        title="Close pane"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                    <Suspense fallback={<div className="editor-empty">{t('editor.loadingEditor')}</div>}>
                      {renderEditorContent(paneFile)}
                    </Suspense>
                  </div>
                </div>
              );
            }}
          />
        ) : (
        <Suspense fallback={<div className="editor-empty">{t('editor.loadingEditor')}</div>}>
        {activeFile?.kind === 'book' ? (
          <EditorErrorBoundary name="Book Studio" key={`eb-${activeFile.path}`}>
            <BookStudio
              filePath={activeFile.path}
              style={props.style}
              isLightTheme={props.isLightTheme}
              fontFamily={props.fontFamily}
              onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(activeFile.path, m)}
              onSaved={props.onImageSaved}
              onOpenFileByPath={props.onOpenFileByPath}
            />
          </EditorErrorBoundary>
        ) : activeFile?.kind === 'epub' ? (
          <EditorErrorBoundary name="EPUB" key={`eb-${activeFile.path}`}>
            <EpubReader
              filePath={activeFile.path}
              epubData={activeFile.content || ''}
              style={props.style}
              onSaved={props.onImageSaved}
              onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(activeFile.path, m)}
            />
          </EditorErrorBoundary>
        ) : activeFile?.kind === 'pdf' ? (
          <EditorErrorBoundary name="PDF" key={`eb-${activeFile.path}`}>
            <PdfEditor
              filePath={activeFile.path}
              pdfData={activeFile.content || ''}
              style={props.style}
              onSaved={props.onImageSaved}
              onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(activeFile.path, m)}
            />
          </EditorErrorBoundary>
        ) : activeFile?.kind === 'pptx' ? (
          <EditorErrorBoundary name="PPTX" key={`eb-${activeFile.path}`}>
            <Suspense fallback={<div className="editor-empty">Loading PPTX...</div>}>
              <PptxEditor
                filePath={activeFile.path}
                pptxData={activeFile.content || ''}
                style={props.style}
                onSaved={props.onImageSaved}
                onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(activeFile.path, m)}
              />
            </Suspense>
          </EditorErrorBoundary>
        ) : activeFile?.kind === 'docx' ? (
          <EditorErrorBoundary name="DOCX" key={`eb-${activeFile.path}`}>
            <Suspense fallback={<div className="editor-empty">Loading DOCX...</div>}>
              <DocxEditor
                filePath={activeFile.path}
                docData={activeFile.content || ''}
                style={props.style}
                onSaved={props.onImageSaved}
                onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(activeFile.path, m)}
              />
            </Suspense>
          </EditorErrorBoundary>
        ) : activeFile?.kind === 'xlsx' ? (
          <EditorErrorBoundary name="XLSX" key={`eb-${activeFile.path}`}>
            <Suspense fallback={<div className="editor-empty">Loading XLSX...</div>}>
              <XlsxEditor
                filePath={activeFile.path}
                xlsxData={activeFile.content || ''}
                style={props.style}
                onSaved={props.onImageSaved}
                onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(activeFile.path, m)}
              />
            </Suspense>
          </EditorErrorBoundary>
        ) : activeFile?.kind === 'video' ? (
          <EditorErrorBoundary name="Video" key={`eb-${activeFile.path}`}>
            <VideoEditor
              filePath={activeFile.path}
              videoUrl={activeFile.content || ''}
              fileName={activeFile.name}
              style={props.style}
            />
          </EditorErrorBoundary>
        ) : activeFile?.kind === 'audio' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', gap: 16 }}>
            <div style={{ fontSize: 48, opacity: 0.3 }}>&#9835;</div>
            <p style={{ fontSize: 13, opacity: 0.7, margin: 0 }}>{activeFile.name}</p>
            <audio
              key={activeFile.path}
              src={activeFile.content}
              controls
              autoPlay={false}
              style={{ width: '80%', maxWidth: 500 }}
            />
          </div>
        ) : activeFile?.kind === 'image' ? (
          <EditorErrorBoundary name="Image" key={`eb-${activeFile.path}`}>
            <ImageViewer
              src={activeFile.content}
              fileName={activeFile.name}
              filePath={activeFile.path}
              style={props.style}
              onSaved={props.onImageSaved}
              onModifiedChange={(m: boolean) => props.onFileModifiedChange?.(activeFile.path, m)}
            />
          </EditorErrorBoundary>
        ) : activeFile?.kind === 'mermaid' ? (
          <EditorErrorBoundary name="Mermaid" key={`eb-${activeFile.path}`}>
            <MermaidFileEditor
              content={activeFile.content || ''}
              onChange={(value) => props.onFileContentChange(activeFile.path, value)}
              onSave={props.onFileSave}
              style={props.style}
              fontFamily={props.fontFamily}
              fontSize={zoomedFontSize}
              isLightTheme={props.isLightTheme}
            />
          </EditorErrorBoundary>
        ) : activeFile?.kind === 'markdown' ? (
          (() => {
            const wikiStyleMarkdown = /[\\/]docs[\\/](wiki|raw)[\\/]/i.test(activeFile.path || '');
            return !wikiStyleMarkdown && mdWysiwyg ? (
            // WYSIWYG Markdown Editor (Tiptap)
            <EditorErrorBoundary name="Markdown" key={`eb-${activeFile.path}`}>
              <MarkdownEditor
                content={activeFile.content || ''}
                onChange={(value) => props.onFileContentChange(activeFile.path, value)}
                onSave={props.onFileSave}
                style={props.style}
                fontFamily={props.fontFamily}
                fontSize={zoomedFontSize}
                isLightTheme={props.isLightTheme}
              />
            </EditorErrorBoundary>
          ) : (
            // Source Markdown Editor (CodeMirror 6)
            // key: remount per file — swapping docs through one CM instance races
            // react-codemirror's reconfigure/value-sync dispatches (RangeError crash)
            <NoteEditor
              key={activeFile.path}
              content={activeFile.content}
              onChange={(value) => props.onFileContentChange(activeFile.path, value)}
              onSave={props.onFileSave}
              onWikiLinkClick={props.onWikiLinkClick}
              style={props.style}
              fontFamily={props.fontFamily}
              fontSize={zoomedFontSize}
              isLightTheme={props.isLightTheme}
              getNoteList={props.getNoteList}
              noteIndex={props.noteIndex}
              currentFilePath={activeFile.path}
              editorViewRef={noteEditorViewRef}
              resolveEmbed={(target) => resolveNoteEmbed(target, activeFile.path)}
              columnMode={columnMode}
              onCursorChange={updateCursorStatus}
            />
            );
          })()
        ) : jsonTree && activeFile?.kind === 'text' && activeFile?.path?.match(/\.json$/i) ? (
          // JSON Tree Editor
          <EditorErrorBoundary name="JSON" key={`eb-${activeFile.path}`}>
            <JsonEditor
              content={activeFile.content || ''}
              onChange={(value) => props.onFileContentChange(activeFile.path, value)}
              onSave={props.onFileSave}
              style={props.style}
              fontFamily={props.fontFamily}
              fontSize={zoomedFontSize}
              isLightTheme={props.isLightTheme}
            />
          </EditorErrorBoundary>
        ) : cssWysiwyg && activeFile?.kind === 'text' && activeFile?.path?.match(/\.css$/i) ? (
          // WYSIWYG CSS Visual Editor
          <EditorErrorBoundary name="CSS" key={`eb-${activeFile.path}`}>
            <CssEditor
              content={activeFile.content || ''}
              onChange={(value) => props.onFileContentChange(activeFile.path, value)}
              onSave={props.onFileSave}
              style={props.style}
              fontFamily={props.fontFamily}
              fontSize={zoomedFontSize}
              isLightTheme={props.isLightTheme}
            />
          </EditorErrorBoundary>
        ) : htmlWysiwyg && activeFile?.kind === 'html' ? (
          // WYSIWYG HTML Design Editor (GrapesJS)
          <EditorErrorBoundary name="HTML" key={`eb-${activeFile.path}`}>
            <HtmlDesignEditor
              content={activeFile.content || ''}
              onChange={(value) => props.onFileContentChange(activeFile.path, value)}
              onSave={props.onFileSave}
              style={props.style}
              fontFamily={props.fontFamily}
              fontSize={zoomedFontSize}
              isLightTheme={props.isLightTheme}
              currentFilePath={activeFile.path}
              onTerminalPrompt={props.onTerminalPrompt}
            />
          </EditorErrorBoundary>
        ) : (
          // Monaco Editor (for code/text files)
          <Editor
            path={activeFile?.path || 'untitled'}
            language={getLanguageFromPath(activeFile?.path || '')}
            value={activeFile?.content || ''}
            theme={props.isLightTheme ? 'octo-light' : 'octo-dark'}
            onChange={(value) => {
              if (value !== undefined && activeFile) {
                props.onFileContentChange(activeFile.path, value);
              }
            }}
            beforeMount={props.onEditorBeforeMount as any}
            onMount={(editor, monaco) => {
              monacoEditorRef.current = editor;
              props.onEditorMount(editor, monaco);
              const emitCursor = () => {
                const pos = editor.getPosition?.();
                if (!pos) return;
                updateCursorStatus({ line: pos.lineNumber, column: pos.column });
              };
              emitCursor();
              editor.onDidChangeCursorPosition?.((event: any) => {
                updateCursorStatus({ line: event.position.lineNumber, column: event.position.column });
              });
              editor.onDidFocusEditorText?.(() => emitCursor());
            }}
            loading={<div className="editor-empty">{t('editor.loadingEditor')}</div>}
            options={{
              minimap: { enabled: props.editorSettings.minimap, scale: 2 },
              fontSize: zoomedFontSize,
              fontFamily: props.fontFamily,
              fontLigatures: true,
              wordWrap: columnMode ? 'off' : (props.editorSettings.wordWrap ? 'on' : 'off'),
              automaticLayout: true,
              scrollBeyondLastLine: false,
              lineNumbers: 'on',
              columnSelection: columnMode,
              renderWhitespace: props.editorSettings.renderWhitespace,
              bracketPairColorization: { enabled: true },
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              padding: { top: 8, bottom: 8 },
              suggest: { preview: true },
              stickyScroll: { enabled: true },
            }}
          />
        )}
        </Suspense>
        )}

        {/* Note aside: outline / backlinks / tags / similar notes */}
        {showNoteAside && !isDashboardView && activeFile?.kind === 'markdown' && (
          <div className="note-aside">
            <div className="note-aside-tabs">
              <button
                className={`note-aside-tab ${noteAsideTab === 'outline' ? 'active' : ''}`}
                onClick={() => setNoteAsideTab('outline')}
                title="Outline"
              >
                <List size={13} />
              </button>
              <button
                className={`note-aside-tab ${noteAsideTab === 'backlinks' ? 'active' : ''}`}
                onClick={() => setNoteAsideTab('backlinks')}
                title="Backlinks"
              >
                <Link2 size={13} />
              </button>
              <button
                className={`note-aside-tab ${noteAsideTab === 'tags' ? 'active' : ''}`}
                onClick={() => setNoteAsideTab('tags')}
                title="Tags"
              >
                <Hash size={13} />
              </button>
              <button
                className={`note-aside-tab ${noteAsideTab === 'similar' ? 'active' : ''}`}
                onClick={() => setNoteAsideTab('similar')}
                title="Similar notes"
              >
                <Layers size={13} />
              </button>
              <button
                className="note-aside-close"
                onClick={() => setShowNoteAside(false)}
                title="Close panel"
              >
                <X size={12} />
              </button>
            </div>
            <div className="note-aside-body">
              {noteAsideTab === 'outline' && (
                <OutlinePanel
                  content={activeFile.content || ''}
                  onHeadingClick={handleOutlineHeadingClick}
                  style={props.style}
                />
              )}
              {noteAsideTab === 'backlinks' && (
                <BacklinksPanel
                  currentFilePath={activeFile.path}
                  onOpenFile={(path) => props.onOpenFileByPath?.(path, true)}
                  style={props.style}
                  linkedTasks={(props.kanbanTasks || [])
                    .filter(t => t.linkedNotes?.includes(activeFile.path))
                    .map(t => ({ id: t.id, title: t.title, column: t.column, priority: t.priority }))}
                  onOpenTask={props.onOpenKanbanTask}
                />
              )}
              {noteAsideTab === 'tags' && (
                <TagsPanel
                  onOpenFile={(path) => props.onOpenFileByPath?.(path, true)}
                  style={props.style}
                  onTagsChanged={requestReindex}
                />
              )}
              {noteAsideTab === 'similar' && (
                <SimilarNotesPanel
                  currentFilePath={activeFile.path}
                  onOpenFile={(path) => props.onOpenFileByPath?.(path, true)}
                  style={props.style}
                  noteIndex={props.noteIndex || []}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {activeFile && !['docx', 'xlsx', 'pptx', 'pdf', 'epub', 'image', 'book', 'mermaid'].includes(activeFile.kind as string) && (
        <div className="editor-statusbar">
          <div className="editor-statusbar-section">
            <span className="editor-statusbar-pill">{activeFile.kind}</span>
            {columnMode && <span className="editor-statusbar-pill accent">Column</span>}
          </div>
          <div className="editor-statusbar-section mono">
            <span>Ln {cursorLine}</span>
            <span>Col {cursorColumn}</span>
            {typeof activeFile.lineCount === 'number' && <span>{activeFile.lineCount} lines</span>}
            {activeFileSizeLabel && <span>{activeFileSizeLabel}</span>}
            <span>{Math.round(editorZoom * 100)}%</span>
          </div>
        </div>
      )}

      {/* AI Top Bar (markdown files only) */}
      {showAiBar && activeFile?.kind === 'markdown' && (
        <div className="editor-ai-topbar">
          <Sparkles size={13} className="editor-ai-topbar-icon" />
          <span className="editor-ai-topbar-label">{t('editor.aiContentLabel' as any)}</span>
          <input
            className="editor-ai-input"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            title={t('editor.aiContentDescribe' as any)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleAiGenerate();
              if (e.key === 'Escape') setShowAiBar(false);
            }}
            placeholder={t('editor.aiContentPlaceholder' as any)}
            disabled={aiLoading}
            autoFocus
          />
          {aiLoading ? (
            <>
              <span className="editor-ai-spinner" />
              <span className="editor-ai-status">{t('editor.generating' as any)}</span>
              <button className="editor-ai-cancel-btn" onClick={() => setAiLoading(false)} title={t('editor.cancelGenerate')}>{t('editor.cancelGenerate')}</button>
            </>
          ) : (
            <button className="editor-ai-send-btn" onClick={() => void handleAiGenerate()} disabled={!aiPrompt.trim()} title={t('editor.aiGenerateContentBtn' as any)}>
              <Send size={13} />
            </button>
          )}
          <button className="editor-ai-close-btn" onClick={() => { setShowAiBar(false); setAiError(null); }} title={t('editor.close')}>
            <span style={{ fontSize: 15, lineHeight: 1 }}>&times;</span>
          </button>
          {aiError && (
            <div className="editor-ai-error">
              <span className="editor-ai-error-text">{aiError}</span>
              <button className="editor-ai-error-close" onClick={() => setAiError(null)} title={t('editor.closeError')}>&times;</button>
            </div>
          )}
        </div>
      )}

      {/* AI Image Bar (markdown files only) */}
      {showImgBar && activeFile?.kind === 'markdown' && (
        <div className="editor-ai-topbar">
          <ImagePlus size={13} className="editor-ai-topbar-icon" />
          <span className="editor-ai-topbar-label">{t('editor.aiImageLabel' as any)}</span>
          <input
            className="editor-ai-input"
            value={imgPrompt}
            onChange={(e) => setImgPrompt(e.target.value)}
            title={t('editor.describeImage')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleImgGenerate();
              if (e.key === 'Escape') setShowImgBar(false);
            }}
            placeholder={t('editor.aiImagePlaceholder' as any)}
            disabled={imgLoading}
            autoFocus
          />
          {imgLoading ? (
            <>
              <span className="editor-ai-spinner" />
              <span className="editor-ai-status">{t('editor.generatingImage' as any)}</span>
              <button className="editor-ai-cancel-btn" onClick={() => setImgLoading(false)} title={t('editor.cancelGenerate')}>{t('editor.cancelGenerate')}</button>
            </>
          ) : (
            <button className="editor-ai-send-btn" onClick={() => void handleImgGenerate()} disabled={!imgPrompt.trim()} title={t('editor.aiGenerateImageBtn' as any)}>
              <Send size={13} />
            </button>
          )}
          <button className="editor-ai-close-btn" onClick={() => { setShowImgBar(false); setImgError(null); }} title={t('editor.close')}>
            <span style={{ fontSize: 15, lineHeight: 1 }}>&times;</span>
          </button>
          {imgError && (
            <div className="editor-ai-error">
              <span className="editor-ai-error-text">{imgError}</span>
              <button className="editor-ai-error-close" onClick={() => setImgError(null)} title={t('editor.closeError')}>&times;</button>
            </div>
          )}
        </div>
      )}

      {/* AI Auto-Tag Suggestion (after markdown save) */}
      {showTagSuggestion && tagSuggestionPath && (
        <AiAutoTagSuggestion
          notePath={tagSuggestionPath}
          noteContent={tagSuggestionContent}
          existingTags={tagSuggestionExistingTags}
          noteIndex={props.noteIndex || []}
          onAcceptTags={handleAutoTagAccept}
          onDismiss={handleAutoTagDismiss}
          style={props.style}
        />
      )}

    </div>
  );
}
