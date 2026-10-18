/**
 * MermaidFileEditor.tsx
 *
 * Split-view editor for .mmd / .mermaid files.
 * Left: CodeMirror source editor, Right: live Mermaid diagram preview
 * with zoom/pan, SVG/PNG export, error-line highlighting and snippets.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import mermaid from 'mermaid';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, Decoration, keymap } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import { Download, Maximize2, LayoutTemplate, ChevronDown } from 'lucide-react';
import { createCMTheme } from '../notes/codeMirrorTheme';
import './MermaidFileEditor.css';

interface MermaidFileEditorProps {
  content: string;
  onChange: (value: string) => void;
  onSave: () => void;
  style: { bg: string; text: string; accent: string };
  fontFamily: string;
  fontSize: number;
  isLightTheme: boolean;
}

/**
 * Extract a 1-based line number from a Mermaid parser error message.
 * Returns null when no line can be determined. Exported for testing.
 */
export function parseMermaidErrorLine(message: string): number | null {
  if (!message) return null;
  const match = message.match(/on line (\d+)/i) || message.match(/line[:\s#]+(\d+)/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* ─── Diagram templates ─── */
const TEMPLATES: { label: string; code: string }[] = [
  {
    label: 'Flowchart',
    code: `flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Do this]
    B -->|No| D[Do that]
    C --> E[End]
    D --> E`,
  },
  {
    label: 'Sequence',
    code: `sequenceDiagram
    participant A as Alice
    participant B as Bob
    A->>B: Hello Bob
    B-->>A: Hi Alice
    A->>B: How are you?`,
  },
  {
    label: 'Class',
    code: `classDiagram
    class Animal {
      +String name
      +move()
    }
    class Dog {
      +bark()
    }
    Animal <|-- Dog`,
  },
  {
    label: 'State',
    code: `stateDiagram-v2
    [*] --> Idle
    Idle --> Running : start
    Running --> Idle : stop
    Running --> [*]`,
  },
  {
    label: 'Gantt',
    code: `gantt
    title Project Schedule
    dateFormat YYYY-MM-DD
    section Phase 1
    Task A :a1, 2024-01-01, 7d
    Task B :after a1, 5d`,
  },
  {
    label: 'Pie',
    code: `pie title Distribution
    "A" : 40
    "B" : 35
    "C" : 25`,
  },
];

/* ─── CodeMirror error-line decoration ─── */
const errorLineDeco = Decoration.line({ class: 'cm-mermaid-error-line' });
const setErrorLineEffect = StateEffect.define<number | null>();
const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setErrorLineEffect)) {
        const line = effect.value;
        if (line == null || line < 1 || line > tr.state.doc.lines) {
          deco = Decoration.none;
        } else {
          const docLine = tr.state.doc.line(line);
          deco = Decoration.set([errorLineDeco.range(docLine.from)]);
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.8;

export default function MermaidFileEditor({ content, onChange, onSave, style, fontFamily, fontSize, isLightTheme }: MermaidFileEditorProps) {
  const [showPreview, setShowPreview] = useState(true);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [error, setError] = useState<string | null>(null);
  const [errorLine, setErrorLine] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [templateOpen, setTemplateOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const previewViewportRef = useRef<HTMLDivElement>(null);
  const splitBodyRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const panState = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  /* ── Initialize mermaid only when the theme changes ── */
  useEffect(() => {
    mermaid.initialize({ startOnLoad: false, theme: isLightTheme ? 'default' : 'dark', securityLevel: 'loose' });
  }, [isLightTheme]);

  /* ── Render diagram (debounced) ── */
  useEffect(() => {
    if (!containerRef.current || !content.trim()) {
      if (containerRef.current) containerRef.current.innerHTML = '';
      setError(null);
      setErrorLine(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const id = `mermaid-file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { svg } = await mermaid.render(id, content.trim());
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setError(null);
          setErrorLine(null);
        }
      } catch (e: any) {
        if (!cancelled) {
          const message = String(e?.message || e);
          setError(message);
          setErrorLine(parseMermaidErrorLine(message));
          if (containerRef.current) containerRef.current.innerHTML = '';
        }
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [content, isLightTheme]);

  /* ── Push the error line into the CodeMirror decoration field ── */
  useEffect(() => {
    editorViewRef.current?.dispatch({ effects: setErrorLineEffect.of(errorLine) });
  }, [errorLine]);

  /* ── CodeMirror theme + extensions ── */
  const cmTheme = useMemo(() => createCMTheme(style, fontFamily, fontSize), [style, fontFamily, fontSize]);
  const extensions = useMemo(() => [
    errorLineField,
    keymap.of([
      { key: 'Mod-s', run: () => { onSave(); return true; }, preventDefault: true },
    ]),
  ], [onSave]);

  /* ── Insert a snippet at the cursor (or append to an empty doc) ── */
  const insertSnippet = useCallback((code: string) => {
    setTemplateOpen(false);
    const view = editorViewRef.current;
    if (!view) {
      onChange(content.trim() ? `${content}\n\n${code}` : code);
      return;
    }
    const sel = view.state.selection.main;
    const prefix = sel.from > 0 && content[sel.from - 1] !== '\n' ? '\n' : '';
    const text = `${prefix}${code}`;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    view.focus();
  }, [content, onChange]);

  /* ── Zoom / pan ── */
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom((z) => Math.min(5, Math.max(0.2, z - e.deltaY * 0.002)));
  }, []);

  const handlePanStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    panState.current = { x: e.clientX, y: e.clientY, ox: pan.x, oy: pan.y };
    const onMove = (ev: MouseEvent) => {
      const s = panState.current;
      if (!s) return;
      setPan({ x: s.ox + (ev.clientX - s.x), y: s.oy + (ev.clientY - s.y) });
    };
    const onUp = () => {
      panState.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [pan]);

  const fitDiagram = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  /* ── Split resize ── */
  const handleSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const body = splitBodyRef.current;
      if (!body) return;
      const rect = body.getBoundingClientRect();
      const ratio = (ev.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  /* ── Export ── */
  const getSvgElement = useCallback((): SVGSVGElement | null => {
    return containerRef.current?.querySelector('svg') ?? null;
  }, []);

  const exportSvg = useCallback(async () => {
    const svg = getSvgElement();
    if (!svg) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const data = new XMLSerializer().serializeToString(svg);
    const withHeader = data.startsWith('<?xml') ? data : `<?xml version="1.0" encoding="UTF-8"?>\n${data}`;
    const path = await invoke<string | null>('save_file_dialog', {
      defaultName: 'diagram.svg',
      filters: [['SVG Image', ['svg']]],
    });
    if (!path) return;
    await invoke('write_file', { path, content: withHeader });
  }, [getSvgElement]);

  const exportPng = useCallback(async () => {
    const svg = getSvgElement();
    if (!svg) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const data = new XMLSerializer().serializeToString(svg);
    const rect = svg.getBoundingClientRect();
    const width = svg.viewBox?.baseVal?.width || rect.width || 800;
    const height = svg.viewBox?.baseVal?.height || rect.height || 600;
    const svgUrl = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to rasterize SVG'));
        img.src = svgUrl;
      });
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = isLightTheme ? '#ffffff' : style.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL('image/png').split(',')[1];
      const path = await invoke<string | null>('save_file_dialog', {
        defaultName: 'diagram.png',
        filters: [['PNG Image', ['png']]],
      });
      if (!path) return;
      await invoke('write_file_base64', { path, base64Data: base64 });
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  }, [getSvgElement, isLightTheme, style.bg]);

  const dividerColor = `color-mix(in srgb, ${style.text} 10%, transparent)`;
  const mutedText = `color-mix(in srgb, ${style.text} 60%, transparent)`;
  const btnStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: 'transparent',
    border: `1px solid ${dividerColor}`,
    color: mutedText,
    borderRadius: 'var(--brutal-radius)', padding: '2px 8px', fontSize: 11, cursor: 'pointer',
  };

  return (
    <div className="mm-root" style={{ background: style.bg, color: style.text }}>
      {/* Toolbar */}
      <div className="mm-toolbar" style={{ borderBottom: `1px solid ${dividerColor}`, background: `color-mix(in srgb, ${style.bg} 92%, black 8%)` }}>
        <span style={{ opacity: 0.5, fontWeight: 600 }}>MERMAID</span>

        <div className="mm-template-wrap">
          <button style={btnStyle} onClick={() => setTemplateOpen((v) => !v)} title="Insert template">
            <LayoutTemplate size={13} /> Template <ChevronDown size={12} />
          </button>
          {templateOpen && (
            <>
              <div className="mm-template-backdrop" onClick={() => setTemplateOpen(false)} />
              <div className="mm-template-menu" style={{ background: style.bg, border: `1px solid ${dividerColor}` }}>
                {TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.label}
                    className="mm-template-item"
                    style={{ color: style.text }}
                    onClick={() => insertSnippet(tpl.code)}
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button style={btnStyle} onClick={() => void exportSvg()} title="Export as SVG">
          <Download size={13} /> SVG
        </button>
        <button style={btnStyle} onClick={() => void exportPng()} title="Export as PNG">
          <Download size={13} /> PNG
        </button>

        <div style={{ flex: 1 }} />

        <button
          onClick={() => setShowPreview((v) => !v)}
          style={{
            ...btnStyle,
            background: showPreview ? `color-mix(in srgb, ${style.accent} 20%, transparent)` : 'transparent',
            borderColor: showPreview ? `color-mix(in srgb, ${style.accent} 40%, transparent)` : dividerColor,
            color: showPreview ? style.accent : mutedText,
          }}
        >
          {showPreview ? 'Preview ON' : 'Preview OFF'}
        </button>
      </div>

      {/* Split pane */}
      <div ref={splitBodyRef} className="mm-split-body">
        {/* Source editor */}
        <div className="mm-source" style={{ flexBasis: showPreview ? `${splitRatio * 100}%` : '100%' }}>
          <CodeMirror
            value={content}
            onChange={onChange}
            extensions={extensions}
            theme={cmTheme}
            height="100%"
            onCreateEditor={(view) => { editorViewRef.current = view; }}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
              bracketMatching: true,
              closeBrackets: true,
              foldGutter: true,
              indentOnInput: true,
              tabSize: 2,
              autocompletion: false,
            }}
          />
        </div>

        {showPreview && (
          <>
            <div
              className="mm-divider"
              onMouseDown={handleSplitDrag}
              style={{ background: dividerColor }}
            />
            {/* Preview */}
            <div className="mm-preview">
              {error && (
                <div className="mm-error">
                  {errorLine != null && <strong>Line {errorLine}: </strong>}
                  {error}
                </div>
              )}
              <div className="mm-preview-controls">
                <button style={btnStyle} onClick={() => setZoom((z) => Math.min(5, z + 0.2))} title="Zoom in">+</button>
                <span className="mm-zoom-label" style={{ color: mutedText }}>{Math.round(zoom * 100)}%</span>
                <button style={btnStyle} onClick={() => setZoom((z) => Math.max(0.2, z - 0.2))} title="Zoom out">−</button>
                <button style={btnStyle} onClick={fitDiagram} title="Fit"><Maximize2 size={13} /> Fit</button>
              </div>
              <div
                ref={previewViewportRef}
                className="mm-preview-viewport"
                style={{ background: style.bg }}
                onWheel={handleWheel}
                onMouseDown={handlePanStart}
              >
                <div
                  ref={containerRef}
                  className="mm-preview-canvas"
                  style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
