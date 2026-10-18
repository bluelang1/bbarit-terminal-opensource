/**
 * NoteEditor.tsx
 *
 * CodeMirror 6 based markdown editor component.
 * Used for .md files in the BBARIT Terminal editor panel.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { keymap, rectangularSelection, EditorView } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';

import { createCMTheme } from './codeMirrorTheme';
import { wikilinkExtension } from './wikilinkExtension';
import { createWikilinkCompletion } from './wikilinkCompletion';
import type { NoteCompletionItem } from './wikilinkCompletion';
import { createWikilinkClickHandler } from './wikilinkHandlers';
import { wikilinkSuggestionExtension } from './wikilinkSuggestionExtension';
import { embedExtension } from './embedExtension';
import type { EmbedResolver } from './embedExtension';
import type { NoteIndexEntry } from './noteState';
import './NoteEditor.css';

export interface NoteEditorProps {
  /** Current markdown content */
  content: string;
  /** Called when the content changes */
  onChange: (content: string) => void;
  /** Called on Cmd/Ctrl+S */
  onSave?: () => void;
  /** Called when a wikilink or markdown document link is clicked */
  onWikiLinkClick?: (target: string) => void;
  /** Theme style colors */
  style: { bg: string; text: string; accent: string };
  /** Font family string */
  fontFamily: string;
  /** Font size in px */
  fontSize: number;
  /** Whether the theme is light */
  isLightTheme: boolean;
  /** Note list provider for wikilink autocompletion */
  getNoteList?: () => NoteCompletionItem[];
  /** Note index for wikilink suggestions */
  noteIndex?: NoteIndexEntry[];
  /** Current file path for excluding self from suggestions */
  currentFilePath?: string;
  /** Ref to expose the underlying EditorView instance */
  editorViewRef?: React.MutableRefObject<import('@codemirror/view').EditorView | null>;
  /** Resolver for ![[embed]] transclusion previews */
  resolveEmbed?: EmbedResolver;
  /** UltraEdit-style column selection mode */
  columnMode?: boolean;
  /** Cursor/status callback */
  onCursorChange?: (cursor: { line: number; column: number }) => void;
}

export const NoteEditor: React.FC<NoteEditorProps> = React.memo(function NoteEditor({
  content,
  onChange,
  onSave,
  onWikiLinkClick,
  style,
  fontFamily,
  fontSize,
  isLightTheme: _isLightTheme,
  getNoteList,
  noteIndex,
  currentFilePath,
  editorViewRef,
  resolveEmbed,
  columnMode = false,
  onCursorChange,
}) {
  const isMac = (() => {
    try {
      return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '');
    } catch {
      return false;
    }
  })();

  const handleChange = useCallback(
    (value: string) => {
      onChange(value);
    },
    [onChange],
  );

  // Use refs for callbacks to keep extensions stable across renders
  const onSaveRef = useRef(onSave);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  const onWikiLinkClickRef = useRef(onWikiLinkClick);
  useEffect(() => { onWikiLinkClickRef.current = onWikiLinkClick; }, [onWikiLinkClick]);

  const noteIndexRef = useRef(noteIndex);
  useEffect(() => { noteIndexRef.current = noteIndex; }, [noteIndex]);

  const currentFilePathRef = useRef(currentFilePath);
  useEffect(() => { currentFilePathRef.current = currentFilePath; }, [currentFilePath]);

  const resolveEmbedRef = useRef(resolveEmbed);
  useEffect(() => { resolveEmbedRef.current = resolveEmbed; }, [resolveEmbed]);

  const onCursorChangeRef = useRef(onCursorChange);
  useEffect(() => { onCursorChangeRef.current = onCursorChange; }, [onCursorChange]);

  // ── [[note#heading]] navigation: scroll to a heading when requested ──
  const viewRef = useRef<EditorView | null>(null);

  const scrollToHeading = useCallback((heading: string) => {
    const view = viewRef.current;
    if (!view) return false;
    const lower = heading.toLowerCase();
    let inFence = false;
    for (let i = 1; i <= view.state.doc.lines; i++) {
      const line = view.state.doc.line(i);
      if (/^\s*(```|~~~)/.test(line.text)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = line.text.match(/^#{1,6}\s+(.+)/);
      if (m && m[1].trim().toLowerCase() === lower) {
        view.dispatch({
          selection: { anchor: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: 'start' }),
        });
        view.focus();
        return true;
      }
    }
    return false;
  }, []);

  useEffect(() => {
    const tryPending = () => {
      const pending = (window as any).__octoGotoHeading as { path?: string; heading?: string } | undefined;
      if (!pending?.heading) return;
      if (pending.path && currentFilePathRef.current && pending.path !== currentFilePathRef.current) return;
      if (scrollToHeading(pending.heading)) {
        (window as any).__octoGotoHeading = undefined;
      }
    };
    const handler = () => tryPending();
    window.addEventListener('octo-note-goto-heading', handler);
    // Editor may mount after the event fired (link opened a new file)
    const t = setTimeout(tryPending, 50);
    return () => {
      window.removeEventListener('octo-note-goto-heading', handler);
      clearTimeout(t);
    };
  }, [scrollToHeading]);

  const extensions = useMemo<Extension[]>(() => {
    const selectedText = (view: any) => {
      const ranges = view.state.selection?.ranges || [];
      if (!ranges.length) return '';
      return ranges.map((r: any) => view.state.sliceDoc(r.from, r.to)).join('\n');
    };
    const deleteSelectedText = (view: any) => {
      const ranges = [...(view.state.selection?.ranges || [])]
        .filter((r: any) => r.from !== r.to)
        .sort((a: any, b: any) => b.from - a.from);
      if (!ranges.length) return;
      view.dispatch({
        changes: ranges.map((r: any) => ({ from: r.from, to: r.to, insert: '' })),
      });
    };

    const exts: Extension[] = [
      // Markdown language support
      markdown(),

      EditorView.updateListener.of((update) => {
        if (!update.selectionSet && !update.docChanged) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        onCursorChangeRef.current?.({
          line: line.number,
          column: head - line.from + 1,
        });
      }),

      // Wikilink decoration (highlighting)
      wikilinkExtension(),

      // Wikilink autocompletion
      autocompletion({
        override: [createWikilinkCompletion(getNoteList)],
      }),

      // Cmd/Ctrl+S save keybinding
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            onSaveRef.current?.();
            return true;
          },
          preventDefault: true,
        },
        // macOS: explicitly support Ctrl-based clipboard shortcuts in markdown editor.
        {
          key: 'Ctrl-c',
          run: (view) => {
            if (!isMac) return false;
            const text = selectedText(view);
            if (!text) return true;
            void navigator.clipboard.writeText(text).catch(() => {});
            return true;
          },
          preventDefault: true,
        },
        {
          key: 'Ctrl-x',
          run: (view) => {
            if (!isMac) return false;
            const text = selectedText(view);
            if (!text) return true;
            void navigator.clipboard.writeText(text).catch(() => {});
            deleteSelectedText(view);
            return true;
          },
          preventDefault: true,
        },
        {
          key: 'Ctrl-v',
          run: (view) => {
            if (!isMac) return false;
            void (async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (!text) return;
                const sel = view.state.selection.main;
                view.dispatch({
                  changes: { from: sel.from, to: sel.to, insert: text },
                  selection: { anchor: sel.from + text.length },
                });
              } catch {
                // ignore
              }
            })();
            return true;
          },
          preventDefault: true,
        },
        {
          key: 'Ctrl-a',
          run: (view) => {
            if (!isMac) return false;
            view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
            return true;
          },
          preventDefault: true,
        },
      ]),

      // Wikilink click handler
      createWikilinkClickHandler((target: string) => {
        onWikiLinkClickRef.current?.(target);
      }),

      // Wikilink suggestion decorations (dotted underline on note title matches)
      wikilinkSuggestionExtension(
        () => noteIndexRef.current ?? [],
        () => currentFilePathRef.current ?? '',
      ),

      // ![[embed]] transclusion previews
      embedExtension(
        () => resolveEmbedRef.current,
        () => onWikiLinkClickRef.current,
      ),
    ];

    if (columnMode) {
      exts.push(rectangularSelection());
    }

    return exts;
  }, [columnMode, isMac]); // stable callbacks via refs; mac flag is static per session

  const theme = useMemo(
    () => createCMTheme(style, fontFamily, fontSize),
    [style, fontFamily, fontSize],
  );

  return (
    <div className="note-editor-wrapper">
      <div className="note-editor-container">
        <CodeMirror
          value={content}
          onChange={handleChange}
          extensions={extensions}
          theme={theme}
          onCreateEditor={(view) => {
            viewRef.current = view;
            if (editorViewRef) editorViewRef.current = view;
            const head = view.state.selection.main.head;
            const line = view.state.doc.lineAt(head);
            onCursorChangeRef.current?.({
              line: line.number,
              column: head - line.from + 1,
            });
          }}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            highlightActiveLine: true,
            foldGutter: true,
            dropCursor: true,
            allowMultipleSelections: true,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: false, // We provide our own
            rectangularSelection: false,
            crosshairCursor: false,
            highlightSelectionMatches: true,
            searchKeymap: true,
            tabSize: 2,
          }}
        />
      </div>
    </div>
  );
});
