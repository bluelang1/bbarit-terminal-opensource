/**
 * MarkdownEditor.tsx
 *
 * WYSIWYG Markdown editor based on Tiptap.
 * Supports headings, bold, italic, underline, strikethrough, highlight,
 * code, code blocks (with syntax highlighting), blockquote, lists,
 * task lists, tables, images, horizontal rules, and links.
 *
 * Accepts raw markdown string and emits markdown string on change.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, EditorContent, NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react';
import type { Fragment as ProseMirrorFragment, Node as ProseMirrorNode, Slice as ProseMirrorSlice } from '@tiptap/pm/model';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import Image from '@tiptap/extension-image';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Markdown } from 'tiptap-markdown';
import { createLowlight } from 'lowlight';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import java from 'highlight.js/lib/languages/java';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Code, Heading1, Heading2, Heading3, List, ListOrdered, ListChecks,
  Quote, Minus, Table as TableIcon, ImageIcon, Undo2, Redo2,
  WrapText, RemoveFormatting, Smile,
  Search, Replace, ChevronDown, ChevronUp, X,
  Plus, Trash2, Copy, Baseline,
  ArrowUpFromLine, ArrowDownFromLine, ArrowLeftFromLine, ArrowRightFromLine,
} from 'lucide-react';
import { IconPicker } from './IconPicker';
import { useTranslation } from '../i18n';
import './MarkdownEditor.css';

const lowlight = createLowlight();
lowlight.register('javascript', javascript);
lowlight.register('js', javascript);
lowlight.register('typescript', typescript);
lowlight.register('ts', typescript);
lowlight.register('python', python);
lowlight.register('py', python);
lowlight.register('rust', rust);
lowlight.register('rs', rust);
lowlight.register('go', go);
lowlight.register('json', json);
lowlight.register('bash', bash);
lowlight.register('sh', bash);
lowlight.register('shell', shell);
lowlight.register('css', css);
lowlight.register('html', xml);
lowlight.register('xml', xml);
lowlight.register('sql', sql);
lowlight.register('yaml', yaml);
lowlight.register('yml', yaml);
lowlight.register('markdown', markdown);
lowlight.register('md', markdown);
lowlight.register('diff', diff);
lowlight.register('c', c);
lowlight.register('cpp', cpp);
lowlight.register('java', java);

/* ─── Search & Replace Extension ─── */

const searchPluginKey = new PluginKey('search-highlight');

interface SearchState {
  query: string;
  caseSensitive: boolean;
  results: { from: number; to: number }[];
  currentIndex: number;
}

const defaultSearchState: SearchState = {
  query: '',
  caseSensitive: false,
  results: [],
  currentIndex: -1,
};

// tiptap-markdown은 GFM로 변환 불가한 표(헤더 없는 표, 셀 단위 부분 선택 등)를 [table] 플레이스홀더로 직렬화한다.
// (?!\() 로 마크다운 링크 [table](url) 는 오탐하지 않는다.
const TABLE_PLACEHOLDER_PATTERN = /\[(table|tableRow|tableCell|tableHeader)\](?!\()/;

function getClipboardNodeText(node: ProseMirrorNode): string {
  return node.textBetween(0, node.content.size, '\n', '\n').replace(/\uFFFC/g, '').trim();
}

function serializeClipboardTableRow(row: ProseMirrorNode): string {
  const cells: string[] = [];
  row.forEach((cell) => {
    if (cell.type.name === 'tableCell' || cell.type.name === 'tableHeader') {
      cells.push(getClipboardNodeText(cell));
    }
  });
  return cells.join('\t');
}

function serializeClipboardTableFragment(fragment: ProseMirrorFragment): string {
  const lines: string[] = [];
  let pendingCells: string[] = [];

  const flushPendingCells = () => {
    if (pendingCells.length) {
      lines.push(pendingCells.join('\t'));
      pendingCells = [];
    }
  };

  fragment.forEach((node) => {
    if (node.type.name === 'table') {
      flushPendingCells();
      const tableLines: string[] = [];
      node.forEach((row) => {
        if (row.type.name === 'tableRow') {
          tableLines.push(serializeClipboardTableRow(row));
        }
      });
      if (tableLines.length) lines.push(tableLines.join('\n'));
      return;
    }

    if (node.type.name === 'tableRow') {
      flushPendingCells();
      lines.push(serializeClipboardTableRow(node));
      return;
    }

    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      pendingCells.push(getClipboardNodeText(node));
      return;
    }

    flushPendingCells();
    const text = getClipboardNodeText(node);
    if (text) lines.push(text);
  });

  flushPendingCells();

  return lines.join('\n').trim();
}

function serializeClipboardText(
  slice: ProseMirrorSlice,
  serializeMarkdown: ((content: ProseMirrorFragment) => string) | undefined,
): string {
  const markdown = serializeMarkdown?.(slice.content) ?? '';

  if (markdown && !TABLE_PLACEHOLDER_PATTERN.test(markdown)) {
    return markdown;
  }

  const plainText = serializeClipboardTableFragment(slice.content);
  if (plainText) return plainText;

  return markdown || slice.content.textBetween(0, slice.content.size, '\n\n');
}

function findMatches(doc: ProseMirrorNode, query: string, caseSensitive: boolean): { from: number; to: number }[] {
  if (!query) return [];
  const results: { from: number; to: number }[] = [];
  const searchStr = caseSensitive ? query : query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = caseSensitive ? node.text : node.text.toLowerCase();
    let idx = text.indexOf(searchStr);
    while (idx !== -1) {
      results.push({ from: pos + idx, to: pos + idx + query.length });
      idx = text.indexOf(searchStr, idx + 1);
    }
  });
  return results;
}

const SearchHighlight = Extension.create({
  name: 'searchHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: searchPluginKey,
        state: {
          init: () => ({ ...defaultSearchState }),
          apply(tr, prev) {
            const meta = tr.getMeta(searchPluginKey);
            if (meta) return meta as SearchState;
            if (tr.docChanged && prev.query) {
              const results = findMatches(tr.doc, prev.query, prev.caseSensitive);
              const currentIndex = results.length ? Math.min(prev.currentIndex, results.length - 1) : -1;
              return { ...prev, results, currentIndex: Math.max(currentIndex, results.length ? 0 : -1) };
            }
            return prev;
          },
        },
        props: {
          decorations(state) {
            const s = searchPluginKey.getState(state) as SearchState | undefined;
            if (!s || !s.results.length) return DecorationSet.empty;
            const decos = s.results.map((r, i) =>
              Decoration.inline(r.from, r.to, {
                class: i === s.currentIndex ? 'md-search-current' : 'md-search-match',
              }),
            );
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

/* ─── CodeBlock Extension (lowlight 구문 강조) ─── */

/* ─── Mermaid Renderer Component ─── */
const MermaidRenderer = ({ code }: { code: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || !code.trim()) return;
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        // mermaid 12 defaults to ELK layout + 'neo' look; keep the classic rendering.
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose', layout: 'dagre', look: 'classic' });
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { svg } = await mermaid.render(id, code.trim());
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return <div style={{ padding: 8, fontSize: 11, color: '#f87171', background: 'rgba(239,68,68,0.08)', borderRadius: 'var(--brutal-radius)' }}>Mermaid error: {error}</div>;
  }
  return <div ref={containerRef} style={{ padding: 8, display: 'flex', justifyContent: 'center' }} />;
};

/* ─── Mermaid-aware CodeBlock NodeView ─── */
const MermaidCodeBlockComponent = ({ node }: any) => {
  const lang = node.attrs.language || '';
  const code = node.textContent || '';
  const isMermaid = lang === 'mermaid';

  if (isMermaid) {
    return (
      <NodeViewWrapper as="div" style={{ margin: '8px 0' }}>
        <div style={{ fontSize: 9, opacity: 0.4, marginBottom: 4, fontWeight: 600 }}>MERMAID</div>
        <MermaidRenderer code={code} />
        <details style={{ marginTop: 4 }}>
          <summary style={{ fontSize: 10, opacity: 0.4, cursor: 'pointer' }}>source</summary>
          <NodeViewContent as={'pre' as any} style={{ fontSize: 11, padding: 8, background: 'rgba(0,0,0,0.2)', borderRadius: 'var(--brutal-radius)', overflowX: 'auto' }} />
        </details>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="pre" spellCheck={false}>
      <NodeViewContent as={'code' as any} />
    </NodeViewWrapper>
  );
};

const MermaidAwareCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MermaidCodeBlockComponent);
  },
});

/* ─── Resizable Image Extension ─── */

const ResizableImageComponent = ({ node, updateAttributes, selected }: {
  node: ProseMirrorNode;
  updateAttributes: (attrs: Record<string, unknown>) => void;
  selected: boolean;
}) => {
  const imgRef = useRef<HTMLImageElement>(null);
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startX.current = e.clientX;
    startW.current = imgRef.current?.offsetWidth || 200;

    const onMouseMove = (ev: MouseEvent) => {
      const diff = ev.clientX - startX.current;
      const newWidth = Math.max(50, startW.current + diff);
      updateAttributes({ width: newWidth });
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [updateAttributes]);

  return (
    <NodeViewWrapper className="md-resizable-image" data-drag-handle="">
      <div className={`md-image-container${selected ? ' selected' : ''}`} style={{ width: node.attrs.width ? `${node.attrs.width}px` : undefined }}>
        <img
          ref={imgRef}
          src={node.attrs.src}
          alt={node.attrs.alt || ''}
          title={node.attrs.title || ''}
          style={{ width: '100%', display: 'block' }}
        />
        <div className="md-resize-handle" onMouseDown={onMouseDown} />
      </div>
    </NodeViewWrapper>
  );
};

const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null, renderHTML: (attrs) => attrs.width ? { width: attrs.width } : {} },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageComponent);
  },
});

export interface MarkdownEditorProps {
  content: string;
  onChange: (md: string) => void;
  onSave?: () => void;
  style: { bg: string; text: string; accent: string };
  fontFamily?: string;
  fontSize?: number;
  isLightTheme?: boolean;
}

export const MarkdownEditor: React.FC<MarkdownEditorProps> = React.memo(function MarkdownEditor({
  content,
  onChange,
  onSave,
  style,
  fontFamily = "'SF Mono', Menlo, Consolas, monospace",
  fontSize = 14,
  isLightTheme = false,
}) {
  const { t } = useTranslation();

  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const onSaveRef = useRef(onSave);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  // Track whether this is an internal update to avoid feedback loops
  const isInternalUpdate = useRef(false);
  const suppressUpdatesUntil = useRef(0);

  // Ref for editor access in paste/drop handlers (avoids circular dependency with useEditor)
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  const fileToBase64Image = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      editorRef.current?.chain().focus().setImage({ src: base64 }).run();
    };
    reader.readAsDataURL(file);
  }, []);

  // Search & Replace state
  const [showSearch, setShowSearch] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  const extensions = useMemo(() => [
    StarterKit.configure({
      codeBlock: false, // replaced by CodeBlockLowlight
    }),
    Placeholder.configure({
      placeholder: t('editor.markdownPlaceholder' as any) || 'Write markdown here...',
    }),
    Underline,
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true, lastColumnResizable: true, allowTableNodeSelection: false }),
    TableRow,
    TableCell,
    TableHeader,
    ResizableImage.configure({ inline: false, allowBase64: true }),
    MermaidAwareCodeBlock.configure({ lowlight }),
    Markdown.configure({
      html: false,
      tightLists: true,
      bulletListMarker: '-',
      transformPastedText: true,
      transformCopiedText: true,
    }),
    SearchHighlight,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t]);

  // Refs for search open callbacks (to avoid circular dependency with useEditor)
  const openSearchRef = useRef<(withReplace?: boolean) => void>(null);

  const editor = useEditor({
    extensions,
    content,
    editorProps: {
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 's') {
          event.preventDefault();
          onSaveRef.current?.();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            event.preventDefault();
            const file = item.getAsFile();
            if (file) fileToBase64Image(file);
            return true;
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = event.dataTransfer?.files;
        if (!files?.length) return false;
        const file = files[0];
        if (file.type.startsWith('image/')) {
          event.preventDefault();
          fileToBase64Image(file);
          return true;
        }
        return false;
      },
      clipboardTextSerializer: (slice) => {
        const markdownStorage = (editorRef.current?.storage as any).markdown as
          | { serializer?: { serialize: (content: ProseMirrorFragment) => string } }
          | undefined;

        return serializeClipboardText(slice, markdownStorage?.serializer?.serialize.bind(markdownStorage.serializer));
      },
    },
    onUpdate: ({ editor: ed }) => {
      // Right after a programmatic reload (external file change), extensions
      // fire fix-up transactions (table colwidths, task items). Reporting those
      // as edits would mark the tab modified and autosave a re-serialized
      // (escaped/normalized) copy over the file nobody touched.
      if (Date.now() < suppressUpdatesUntil.current) return;
      isInternalUpdate.current = true;
      const md = ((ed.storage as any).markdown as { getMarkdown: () => string }).getMarkdown();
      onChangeRef.current(md);
    },
  });

  // Keep editorRef in sync
  editorRef.current = editor;

  // Search helpers
  const dispatchSearch = useCallback((query: string, cs: boolean, index?: number) => {
    if (!editor) return;
    const results = findMatches(editor.state.doc, query, cs);
    const currentIndex = index !== undefined ? index : (results.length ? 0 : -1);
    editor.view.dispatch(
      editor.state.tr.setMeta(searchPluginKey, { query, caseSensitive: cs, results, currentIndex } as SearchState),
    );
    // Scroll to current match
    if (results.length && currentIndex >= 0 && currentIndex < results.length) {
      const pos = results[currentIndex].from;
      editor.commands.setTextSelection(pos);
      // Scroll into view by briefly focusing
      const dom = editor.view.domAtPos(pos);
      if (dom.node instanceof HTMLElement) {
        dom.node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else if (dom.node.parentElement) {
        dom.node.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }, [editor]);

  const getSearchState = useCallback((): SearchState => {
    if (!editor) return defaultSearchState;
    return (searchPluginKey.getState(editor.state) as SearchState) || defaultSearchState;
  }, [editor]);

  const openSearch = useCallback((withReplace?: boolean) => {
    if (withReplace === undefined) {
      // Escape pressed - close
      setShowSearch(false);
      setShowReplace(false);
      setSearchQuery('');
      setReplaceQuery('');
      if (editor) {
        editor.view.dispatch(editor.state.tr.setMeta(searchPluginKey, { ...defaultSearchState }));
      }
      return;
    }
    setShowSearch(true);
    setShowReplace(!!withReplace);
    setTimeout(() => {
      if (withReplace) {
        replaceInputRef.current?.focus();
      } else {
        searchInputRef.current?.focus();
      }
    }, 50);
  }, [editor]);

  openSearchRef.current = openSearch;

  const handleSearchChange = useCallback((q: string) => {
    setSearchQuery(q);
    dispatchSearch(q, caseSensitive);
  }, [caseSensitive, dispatchSearch]);

  const toggleCaseSensitive = useCallback(() => {
    const next = !caseSensitive;
    setCaseSensitive(next);
    dispatchSearch(searchQuery, next);
  }, [caseSensitive, searchQuery, dispatchSearch]);

  const goToMatch = useCallback((direction: 'next' | 'prev') => {
    const s = getSearchState();
    if (!s.results.length) return;
    let idx = direction === 'next' ? s.currentIndex + 1 : s.currentIndex - 1;
    if (idx >= s.results.length) idx = 0;
    if (idx < 0) idx = s.results.length - 1;
    dispatchSearch(s.query, s.caseSensitive, idx);
  }, [getSearchState, dispatchSearch]);

  const replaceOne = useCallback(() => {
    if (!editor) return;
    const s = getSearchState();
    if (s.currentIndex < 0 || !s.results.length) return;
    const match = s.results[s.currentIndex];
    editor.chain().focus()
      .setTextSelection({ from: match.from, to: match.to })
      .deleteSelection()
      .insertContent(replaceQuery)
      .run();
    // Re-search after replace
    setTimeout(() => {
      const newState = getSearchState();
      const newIdx = Math.min(s.currentIndex, newState.results.length - 1);
      dispatchSearch(searchQuery, caseSensitive, Math.max(newIdx, 0));
    }, 10);
  }, [editor, getSearchState, replaceQuery, searchQuery, caseSensitive, dispatchSearch]);

  const replaceAll = useCallback(() => {
    if (!editor) return;
    const s = getSearchState();
    if (!s.results.length) return;
    // Replace from end to start to preserve positions
    const sorted = [...s.results].sort((a, b) => b.from - a.from);
    let chain = editor.chain();
    for (const match of sorted) {
      chain = chain.setTextSelection({ from: match.from, to: match.to }).deleteSelection().insertContent(replaceQuery);
    }
    chain.run();
    dispatchSearch(searchQuery, caseSensitive);
  }, [editor, getSearchState, replaceQuery, searchQuery, caseSensitive, dispatchSearch]);

  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setShowReplace(false);
    setSearchQuery('');
    setReplaceQuery('');
    if (editor) {
      editor.view.dispatch(editor.state.tr.setMeta(searchPluginKey, { ...defaultSearchState }));
      editor.commands.focus();
    }
  }, [editor]);

  // Global keyboard shortcuts: Cmd/Ctrl+F (search), Cmd/Ctrl+R (replace), Escape (close)
  const wrapperRef = useRef<HTMLDivElement>(null);
  const showSearchRef = useRef(showSearch);
  showSearchRef.current = showSearch;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only handle if our wrapper or its children are focused
      if (!wrapperRef.current?.contains(document.activeElement) && document.activeElement !== wrapperRef.current) return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        e.stopImmediatePropagation();
        openSearch(false);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'r' || e.key === 'h')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openSearch(true);
      } else if (e.key === 'Escape' && showSearchRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeSearch();
      }
    };
    window.addEventListener('keydown', handler, true); // capture phase on window (fires before document)
    return () => window.removeEventListener('keydown', handler, true);
  }, [openSearch, closeSearch]);

  // Sync external content changes
  const prevContentRef = useRef(content);
  useEffect(() => {
    if (!editor) return;
    const wasInternal = isInternalUpdate.current;
    isInternalUpdate.current = false;
    if (content === prevContentRef.current) return;
    prevContentRef.current = content;
    if (wasInternal) {
      // Usually our own onChange echo — but when an external reload raced in
      // between the transaction and this effect, the prop no longer matches
      // what the editor holds. Apply it so the editor never keeps a stale copy
      // that a later save would write back over the external change.
      const current = ((editor.storage as any).markdown as { getMarkdown: () => string }).getMarkdown();
      if (content === current) return;
    }
    suppressUpdatesUntil.current = Date.now() + 200;
    editor.commands.setContent(content);
  }, [content, editor]);

  // CSS custom properties for theming
  const cssVars = useMemo(() => {
    return {
      '--md-bg': style.bg,
      '--md-text': style.text,
      '--md-accent': style.accent,
      '--md-accent-bg': style.accent + '30',
      '--md-border': isLightTheme ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)',
      '--md-hover': isLightTheme ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.08)',
      '--md-toolbar-bg': isLightTheme ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.04)',
      '--md-code-bg': isLightTheme ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)',
      '--md-font': fontFamily,
      '--md-font-size': `${fontSize}px`,
    } as React.CSSProperties;
  }, [style, isLightTheme, fontFamily, fontSize]);

  const searchState = editor ? (searchPluginKey.getState(editor.state) as SearchState | undefined) : undefined;

  if (!editor) return null;

  return (
    <div className="md-editor-wrapper" ref={wrapperRef} style={cssVars}>
      <Toolbar editor={editor} style={style} isLightTheme={isLightTheme} />

      {/* Search & Replace Bar */}
      {showSearch && (
        <div className="md-search-bar">
          <div className="md-search-row">
            <Search size={13} className="md-search-icon" />
            <input
              ref={searchInputRef}
              className="md-search-input"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); goToMatch('next'); }
                if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); goToMatch('prev'); }
                if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
              }}
              placeholder={t('editor.searchPlaceholder')}
              autoFocus
            />
            <button
              className={`md-search-btn${caseSensitive ? ' active' : ''}`}
              onClick={toggleCaseSensitive}
              title={t('editor.caseSensitive')}
            >
              Aa
            </button>
            <span className="md-search-count">
              {searchState && searchState.results.length > 0
                ? `${searchState.currentIndex + 1} / ${searchState.results.length}`
                : searchQuery ? t('editor.noResults') : ''}
            </span>
            <button className="md-search-btn" onClick={() => goToMatch('prev')} title={t('editor.prevMatch')}>
              <ChevronUp size={14} />
            </button>
            <button className="md-search-btn" onClick={() => goToMatch('next')} title={t('editor.nextMatch')}>
              <ChevronDown size={14} />
            </button>
            <button
              className="md-search-btn"
              onClick={() => { setShowReplace(v => !v); }}
              title={showReplace ? t('editor.close') : t('editor.replace')}
            >
              <Replace size={13} />
            </button>
            <button className="md-search-btn" onClick={closeSearch} title={t('editor.close')}>
              <X size={14} />
            </button>
          </div>
          {showReplace && (
            <div className="md-search-row">
              <Replace size={13} className="md-search-icon" />
              <input
                ref={replaceInputRef}
                className="md-search-input"
                value={replaceQuery}
                onChange={(e) => setReplaceQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
                  if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
                }}
                placeholder={t('editor.replacePlaceholder')}
              />
              <button className="md-search-btn" onClick={replaceOne} title={t('editor.replaceOne')}>
                {t('editor.replace')}
              </button>
              <button className="md-search-btn" onClick={replaceAll} title={t('editor.replaceAllMatches')}>
                {t('editor.replaceAll')}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="md-editor-content">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
});

/* ─── Toolbar ─── */

interface ToolbarProps {
  editor: ReturnType<typeof useEditor> & {};
  style: { bg: string; text: string; accent: string };
  isLightTheme: boolean;
}

/** Notion-style text & background color definitions */
const TEXT_COLORS = [
  { label: 'Default text', value: '', css: 'inherit' },
  { label: 'Gray text', value: '#9ca3af', css: '#9ca3af' },
  { label: 'Brown text', value: '#a07553', css: '#a07553' },
  { label: 'Orange text', value: '#f97316', css: '#f97316' },
  { label: 'Yellow text', value: '#eab308', css: '#eab308' },
  { label: 'Green text', value: '#22c55e', css: '#22c55e' },
  { label: 'Blue text', value: '#3b82f6', css: '#3b82f6' },
  { label: 'Purple text', value: '#8b5cf6', css: '#8b5cf6' },
  { label: 'Pink text', value: '#ec4899', css: '#ec4899' },
  { label: 'Red text', value: '#ef4444', css: '#ef4444' },
];

const BG_COLORS = [
  { label: 'Default background', value: '', css: 'transparent' },
  { label: 'Gray background', value: '#374151', css: '#374151' },
  { label: 'Brown background', value: '#5c3d2e', css: '#5c3d2e' },
  { label: 'Orange background', value: '#7c2d12', css: '#7c2d12' },
  { label: 'Yellow background', value: '#713f12', css: '#713f12' },
  { label: 'Green background', value: '#14532d', css: '#14532d' },
  { label: 'Blue background', value: '#1e3a5f', css: '#1e3a5f' },
  { label: 'Purple background', value: '#3b0764', css: '#3b0764' },
  { label: 'Pink background', value: '#831843', css: '#831843' },
  { label: 'Red background', value: '#7f1d1d', css: '#7f1d1d' },
];

function TextColorPicker({ editor, onClose, style, anchorRef }: {
  editor: ReturnType<typeof useEditor> & {};
  onClose: () => void;
  style: { bg: string; text: string; accent: string };
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      const left = Math.min(rect.left, window.innerWidth - 220);
      setPos({ top: rect.bottom + 4, left: Math.max(4, left) });
    }
  }, [anchorRef]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', h), 10);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', h); };
  }, [onClose]);

  const currentColor = editor.getAttributes('textStyle').color || '';

  return createPortal(
    <div
      ref={ref}
      className="md-color-picker"
      style={{ '--tg-bg': style.bg, '--tg-text': style.text, '--tg-accent': style.accent, top: pos.top, left: pos.left } as React.CSSProperties}
    >
      <div className="md-cp-section">Text color</div>
      {TEXT_COLORS.map((c) => (
        <button
          key={`t-${c.label}`}
          className={`md-cp-item${currentColor === c.value ? ' active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            if (c.value) editor.chain().focus().setColor(c.value).run();
            else editor.chain().focus().unsetColor().run();
            onClose();
          }}
        >
          <span className="md-cp-swatch" style={{ color: c.css, background: 'transparent', fontWeight: 700, fontSize: 14 }}>A</span>
          <span>{c.label}</span>
        </button>
      ))}

      <div className="md-cp-section" style={{ marginTop: 4 }}>Background color</div>
      {BG_COLORS.map((c) => (
        <button
          key={`b-${c.label}`}
          className="md-cp-item"
          onMouseDown={(e) => {
            e.preventDefault();
            if (c.value) editor.chain().focus().toggleHighlight({ color: c.value }).run();
            else editor.chain().focus().unsetHighlight().run();
            onClose();
          }}
        >
          <span className="md-cp-swatch" style={{ background: c.css, borderRadius: 'var(--brutal-radius)' }} />
          <span>{c.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

function TableGridPicker({ onSelect, onClose, style, anchorRef }: {
  onSelect: (rows: number, cols: number) => void;
  onClose: () => void;
  style: { bg: string; text: string; accent: string };
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const MAX_R = 8, MAX_C = 8;
  const [hoverR, setHoverR] = useState(0);
  const [hoverC, setHoverC] = useState(0);
  const [tab, setTab] = useState<'grid' | 'custom'>('grid');
  const [customRows, setCustomRows] = useState('5');
  const [customCols, setCustomCols] = useState('3');
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: Math.max(4, rect.left) });
    }
  }, [anchorRef]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', h), 10);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', h); };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="md-table-grid-picker"
      style={{
        '--tg-bg': style.bg, '--tg-text': style.text, '--tg-accent': style.accent,
        top: pos.top, left: pos.left,
      } as React.CSSProperties}
    >
      <div className="md-tg-tabs">
        <button className={`md-tg-tab${tab === 'grid' ? ' active' : ''}`} onClick={() => setTab('grid')}>Grid</button>
        <button className={`md-tg-tab${tab === 'custom' ? ' active' : ''}`} onClick={() => setTab('custom')}>Custom</button>
      </div>

      {tab === 'grid' && (
        <>
          <div className="md-tg-label">{hoverR > 0 ? `${hoverR} × ${hoverC}` : 'Select size'}</div>
          <div className="md-tg-grid">
            {Array.from({ length: MAX_R }, (_, r) =>
              Array.from({ length: MAX_C }, (_, c) => (
                <div
                  key={`${r}-${c}`}
                  className={`md-tg-cell${r < hoverR && c < hoverC ? ' md-tg-active' : ''}`}
                  onMouseEnter={() => { setHoverR(r + 1); setHoverC(c + 1); }}
                  onClick={() => onSelect(r + 1, c + 1)}
                />
              ))
            )}
          </div>
        </>
      )}

      {tab === 'custom' && (
        <div className="md-tg-custom">
          <div className="md-tg-custom-row">
            <label>Rows</label>
            <input type="number" min={1} max={50} value={customRows} onChange={e => setCustomRows(e.target.value)} />
          </div>
          <div className="md-tg-custom-row">
            <label>Cols</label>
            <input type="number" min={1} max={20} value={customCols} onChange={e => setCustomCols(e.target.value)} />
          </div>
          <button
            className="md-tg-custom-btn"
            onClick={() => {
              const r = Math.max(1, Math.min(50, parseInt(customRows) || 3));
              const c = Math.max(1, Math.min(20, parseInt(customCols) || 3));
              onSelect(r, c);
            }}
          >
            Insert {customRows}×{customCols} Table
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

function TableContextMenu({ editor, style }: { editor: ReturnType<typeof useEditor> & {}; style: { bg: string; text: string; accent: string } }) {
  if (!editor.isActive('table')) return null;
  return (
    <div className="md-table-ctx" style={{ '--tg-bg': style.bg, '--tg-text': style.text, '--tg-accent': style.accent } as React.CSSProperties}>
      {/* Row operations */}
      <span className="md-tctx-group-label">Row</span>
      <button title="Add row before" onClick={() => editor.chain().focus().addRowBefore().run()}><ArrowUpFromLine size={13} /></button>
      <button title="Add row after" onClick={() => editor.chain().focus().addRowAfter().run()}><ArrowDownFromLine size={13} /></button>
      <button title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}><Trash2 size={12} /></button>
      <span className="md-tb-sep" />
      {/* Column operations */}
      <span className="md-tctx-group-label">Col</span>
      <button title="Add column before" onClick={() => editor.chain().focus().addColumnBefore().run()}><ArrowLeftFromLine size={13} /></button>
      <button title="Add column after" onClick={() => editor.chain().focus().addColumnAfter().run()}><ArrowRightFromLine size={13} /></button>
      <button title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}><X size={12} /></button>
      <span className="md-tb-sep" />
      {/* Cell operations */}
      <button title="Merge cells" onClick={() => editor.chain().focus().mergeCells().run()}><Copy size={12} /> <span style={{ fontSize: 9 }}>Merge</span></button>
      <button title="Split cell" onClick={() => editor.chain().focus().splitCell().run()}><Plus size={12} /> <span style={{ fontSize: 9 }}>Split</span></button>
      <span className="md-tb-sep" />
      {/* Header toggles */}
      <button title="Toggle header row" onClick={() => editor.chain().focus().toggleHeaderRow().run()} style={{ fontWeight: 700, fontSize: 11 }}>H-Row</button>
      <button title="Toggle header column" onClick={() => editor.chain().focus().toggleHeaderColumn().run()} style={{ fontWeight: 700, fontSize: 11 }}>H-Col</button>
      <span className="md-tb-sep" />
      {/* Delete table */}
      <button title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()} style={{ color: '#ef4444' }}><Trash2 size={13} /></button>
    </div>
  );
}

function Toolbar({ editor, style, isLightTheme }: ToolbarProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tableAnchorRef = useRef<HTMLDivElement>(null);
  const colorAnchorRef = useRef<HTMLDivElement>(null);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showTableGrid, setShowTableGrid] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const addTable = useCallback((rows: number, cols: number) => {
    setShowTableGrid(false);
    requestAnimationFrame(() => {
      editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
    });
  }, [editor]);

  const handleImageFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      editor.chain().focus().setImage({ src: reader.result as string }).run();
    };
    reader.readAsDataURL(file);
  }, [editor]);

  const handleIconSelect = useCallback((_iconName: string, svgMarkup: string) => {
    // Convert SVG markup to a data URL so it renders as an image
    const encoded = btoa(unescape(encodeURIComponent(svgMarkup)));
    const dataUrl = `data:image/svg+xml;base64,${encoded}`;
    editor.chain().focus().setImage({ src: dataUrl }).run();
    setShowIconPicker(false);
  }, [editor]);

  return (
    <div className="md-editor-toolbar">
      {/* Undo / Redo */}
      <TbBtn
        icon={<Undo2 />}
        title={t('editor.undo')}
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
      />
      <TbBtn
        icon={<Redo2 />}
        title={t('editor.redo')}
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
      />
      <span className="md-tb-sep" />

      {/* Headings */}
      <TbBtn
        icon={<Heading1 />}
        title={t('editor.heading1')}
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      />
      <TbBtn
        icon={<Heading2 />}
        title={t('editor.heading2')}
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      />
      <TbBtn
        icon={<Heading3 />}
        title={t('editor.heading3')}
        active={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      />
      <span className="md-tb-sep" />

      {/* Inline formatting */}
      <TbBtn
        icon={<Bold />}
        title={t('editor.bold')}
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <TbBtn
        icon={<Italic />}
        title={t('editor.italic')}
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <TbBtn
        icon={<UnderlineIcon />}
        title={t('editor.underline')}
        active={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <TbBtn
        icon={<Strikethrough />}
        title={t('editor.strikethrough')}
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <div ref={colorAnchorRef} style={{ display: 'inline-flex' }}>
        <TbBtn
          icon={<Baseline size={15} />}
          title="Text & Background Color"
          active={showColorPicker || !!editor.getAttributes('textStyle').color || editor.isActive('highlight')}
          onClick={() => setShowColorPicker(v => !v)}
        />
      </div>
      {showColorPicker && (
        <TextColorPicker
          editor={editor}
          onClose={() => setShowColorPicker(false)}
          style={style}
          anchorRef={colorAnchorRef}
        />
      )}
      <TbBtn
        icon={<Code />}
        title={t('editor.inlineCode')}
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />
      <span className="md-tb-sep" />

      {/* Block formatting */}
      <TbBtn
        icon={<List />}
        title={t('editor.bulletList')}
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <TbBtn
        icon={<ListOrdered />}
        title={t('editor.numberedList')}
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <TbBtn
        icon={<ListChecks />}
        title={t('editor.checklist')}
        active={editor.isActive('taskList')}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      />
      <TbBtn
        icon={<Quote />}
        title={t('editor.blockquote')}
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
      <TbBtn
        icon={<WrapText />}
        title={t('editor.codeBlock')}
        active={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      />
      <span className="md-tb-sep" />

      {/* Insert */}
      <TbBtn
        icon={<Minus />}
        title={t('editor.horizontalRule')}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      />
      <div ref={tableAnchorRef} style={{ display: 'inline-flex' }}>
        <TbBtn
          icon={<TableIcon />}
          title={t('editor.insertTable')}
          onClick={() => setShowTableGrid(v => !v)}
          active={showTableGrid || editor.isActive('table')}
        />
      </div>
      {showTableGrid && (
        <TableGridPicker
          onSelect={addTable}
          onClose={() => setShowTableGrid(false)}
          style={style}
          anchorRef={tableAnchorRef}
        />
      )}
      <TbBtn
        icon={<ImageIcon />}
        title={t('editor.insertImage')}
        onClick={() => fileInputRef.current?.click()}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImageFile(file);
          e.target.value = '';
        }}
      />
      <TbBtn
        icon={<Smile />}
        title={t('editor.insertIcon')}
        onClick={() => setShowIconPicker((v) => !v)}
        active={showIconPicker}
      />
      <span className="md-tb-sep" />

      {/* Clear formatting */}
      <TbBtn
        icon={<RemoveFormatting />}
        title={t('editor.clearFormatting')}
        onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
      />

      {showIconPicker && (
        <IconPicker
          onSelect={handleIconSelect}
          onClose={() => setShowIconPicker(false)}
          style={style}
          isLightTheme={isLightTheme}
        />
      )}

      {/* Table context toolbar (shown when cursor is inside a table) */}
      <TableContextMenu editor={editor} style={style} />
    </div>
  );
}

/* ─── Toolbar Button ─── */

function TbBtn(props: {
  icon: React.ReactNode;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={props.active ? 'active' : ''}
      title={props.title}
      disabled={props.disabled}
      onMouseDown={(e) => {
        e.preventDefault(); // prevent editor blur
        props.onClick();
      }}
    >
      {props.icon}
    </button>
  );
}

export default MarkdownEditor;
