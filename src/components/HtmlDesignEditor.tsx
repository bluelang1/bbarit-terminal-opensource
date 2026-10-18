/**
 * HtmlDesignEditor.tsx
 *
 * WYSIWYG HTML editor: iframe designMode + source editing.
 * Uses document.execCommand() for formatting — no external libraries.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import Editor from '@monaco-editor/react';
import {
  PaintBucket, Code2, Monitor, Tablet, Smartphone, Columns2,
  RotateCcw, Download, Copy, Bold, Italic, Underline, Strikethrough,
  Heading1, Heading2, Heading3, List, ListOrdered, Quote, Minus,
  Link, Image, Undo2, Redo2, RemoveFormatting, Type,
  Sparkles, Send, Wand2, History, X, Check, Blocks,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
} from 'lucide-react';
import { HtmlBuilder } from './HtmlBuilder';
import { focusOutsideEditor } from './editorKeyScope';
import './HtmlDesignEditor.css';

/**
 * Pull the leading `<!DOCTYPE ...>` declaration from an HTML string.
 * Returns '' when the document has no doctype. Exported for testing.
 */
export function extractDoctype(html: string): string {
  const match = html.match(/^\s*<!doctype[^>]*>/i);
  return match ? match[0].trim() : '';
}

/**
 * Reattach a doctype to serialized `documentElement.outerHTML`, which never
 * includes it. Exported for testing.
 */
export function serializeHtmlWithDoctype(doctype: string, outerHTML: string): string {
  return doctype ? `${doctype}\n${outerHTML}` : outerHTML;
}

/* ─────────────────── Types ─────────────────── */

export interface HtmlDesignEditorProps {
  content: string;
  onChange: (html: string) => void;
  onSave?: () => void;
  style: { bg: string; text: string; accent: string };
  fontFamily: string;
  fontSize: number;
  isLightTheme: boolean;
  currentFilePath?: string;
  onTerminalPrompt?: (prompt: string) => void;
}

type ViewMode = 'build' | 'design' | 'source' | 'split';
type DeviceMode = 'desktop' | 'tablet' | 'mobile';
type ImageMode = 'generate' | 'edit';

interface CodexImageHistoryItem {
  id: string;
  prompt: string;
  mode: ImageMode;
  dataUrl?: string;
  savedPath: string | null;
  createdAt: number;
}

const DEVICE_WIDTHS: Record<DeviceMode, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '375px',
};

const CODEX_IMAGE_HISTORY_KEY = 'octo-html-design-codex-image-history';
const MAX_CODEX_IMAGE_HISTORY = 8;

const loadCodexImageHistory = (): CodexImageHistoryItem[] => {
  try {
    const raw = localStorage.getItem(CODEX_IMAGE_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CodexImageHistoryItem => (
      typeof item?.id === 'string' &&
      typeof item?.prompt === 'string' &&
      typeof item?.createdAt === 'number'
    )).slice(0, MAX_CODEX_IMAGE_HISTORY);
  } catch {
    return [];
  }
};

/* ─────────────────── Formatting Commands ─────────────────── */

interface FmtButton {
  cmd: string;
  icon: React.ReactNode;
  title: string;
  arg?: string;
  promptArg?: boolean;
}

const FMT_GROUPS: FmtButton[][] = [
  [
    { cmd: 'undo', icon: <Undo2 size={13} />, title: 'Undo' },
    { cmd: 'redo', icon: <Redo2 size={13} />, title: 'Redo' },
  ],
  [
    { cmd: 'bold', icon: <Bold size={13} />, title: 'Bold' },
    { cmd: 'italic', icon: <Italic size={13} />, title: 'Italic' },
    { cmd: 'underline', icon: <Underline size={13} />, title: 'Underline' },
    { cmd: 'strikeThrough', icon: <Strikethrough size={13} />, title: 'Strikethrough' },
  ],
  [
    { cmd: 'formatBlock', icon: <Heading1 size={13} />, title: 'Heading 1', arg: 'h1' },
    { cmd: 'formatBlock', icon: <Heading2 size={13} />, title: 'Heading 2', arg: 'h2' },
    { cmd: 'formatBlock', icon: <Heading3 size={13} />, title: 'Heading 3', arg: 'h3' },
    { cmd: 'formatBlock', icon: <Type size={13} />, title: 'Paragraph', arg: 'p' },
  ],
  [
    { cmd: 'justifyLeft', icon: <AlignLeft size={13} />, title: 'Align left' },
    { cmd: 'justifyCenter', icon: <AlignCenter size={13} />, title: 'Align center' },
    { cmd: 'justifyRight', icon: <AlignRight size={13} />, title: 'Align right' },
    { cmd: 'justifyFull', icon: <AlignJustify size={13} />, title: 'Justify' },
  ],
  [
    { cmd: 'insertUnorderedList', icon: <List size={13} />, title: 'Bullet list' },
    { cmd: 'insertOrderedList', icon: <ListOrdered size={13} />, title: 'Numbered list' },
    { cmd: 'formatBlock', icon: <Quote size={13} />, title: 'Blockquote', arg: 'blockquote' },
    { cmd: 'insertHorizontalRule', icon: <Minus size={13} />, title: 'Horizontal rule' },
  ],
  [
    { cmd: 'createLink', icon: <Link size={13} />, title: 'Insert link', promptArg: true },
    { cmd: 'insertImage', icon: <Image size={13} />, title: 'Insert image', promptArg: true },
  ],
  [
    { cmd: 'removeFormat', icon: <RemoveFormatting size={13} />, title: 'Remove formatting' },
  ],
];

const TOGGLE_CMDS = new Set(['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull']);

/* ─────────────────── Main Component ─────────────────── */

export function HtmlDesignEditor({
  content,
  onChange,
  onSave,
  style,
  fontFamily,
  fontSize,
  isLightTheme,
  currentFilePath,
  onTerminalPrompt,
}: HtmlDesignEditorProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('build');
  const [device, setDevice] = useState<DeviceMode>('desktop');
  const [sourceText, setSourceText] = useState(content);
  const [activeFormats, setActiveFormats] = useState<Record<string, boolean>>({});
  const [linkInput, setLinkInput] = useState<{ cmd: string; visible: boolean; value: string }>({ cmd: '', visible: false, value: '' });
  const [showCodexImagePanel, setShowCodexImagePanel] = useState(false);
  const [imageMode, setImageMode] = useState<ImageMode>('generate');
  const [imagePrompt, setImagePrompt] = useState('');
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageHistory, setImageHistory] = useState<CodexImageHistoryItem[]>(() => loadCodexImageHistory());
  const [selectedImageId, setSelectedImageId] = useState<string | null>(() => loadCodexImageHistory()[0]?.id ?? null);
  const [lastInsertedId, setLastInsertedId] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const editorRootRef = useRef<HTMLDivElement>(null);
  const isExternalUpdate = useRef(false);
  const isSyncingFromDesign = useRef(false);
  const sourceDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const designModeSetup = useRef(false);
  // Cleanup for the currently attached designMode listeners; must run before reattaching.
  const designListenersCleanup = useRef<(() => void) | null>(null);
  // Doctype captured from the last HTML written to the iframe; outerHTML drops it.
  const doctypeRef = useRef('');
  // Pending Codex-image poll timers, cleared on unmount.
  const codexPollTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const selectedImage = imageHistory.find(item => item.id === selectedImageId) || imageHistory[0] || null;

  useEffect(() => {
    try {
      localStorage.setItem(CODEX_IMAGE_HISTORY_KEY, JSON.stringify(imageHistory.slice(0, MAX_CODEX_IMAGE_HISTORY)));
    } catch {
      // Data URLs can exceed browser storage limits; keep the in-memory history if persistence fails.
    }
  }, [imageHistory]);

  /* ── Sync sourceText when content prop changes (file reload) ── */
  useEffect(() => {
    if (isExternalUpdate.current) {
      isExternalUpdate.current = false;
      return;
    }
    setSourceText(content);
  }, [content]);

  /* ── Get iframe document safely ── */
  const getIframeDoc = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return null;
    try {
      return iframe.contentDocument;
    } catch {
      return null;
    }
  }, []);

  /* ── Serialize the iframe document, preserving the original doctype ── */
  const serializeDoc = useCallback((doc: Document): string => {
    return serializeHtmlWithDoctype(doctypeRef.current, doc.documentElement.outerHTML);
  }, []);

  /* ── Write HTML to iframe and optionally enable designMode ── */
  const writeToIframe = useCallback((html: string, enableDesignMode: boolean) => {
    const doc = getIframeDoc();
    if (!doc) return;
    doctypeRef.current = extractDoctype(html);
    doc.open();
    doc.write(html);
    doc.close();
    if (enableDesignMode) {
      doc.designMode = 'on';
    }
  }, [getIframeDoc]);

  /* ── Setup designMode event listeners ── */
  const setupDesignListeners = useCallback(() => {
    const doc = getIframeDoc();
    if (!doc) return;

    // Sync design → source on input
    const handleInput = () => {
      isSyncingFromDesign.current = true;
      const html = serializeDoc(doc);
      setSourceText(html);
      isExternalUpdate.current = true;
      onChange(html);
      // small delay to reset flag
      setTimeout(() => { isSyncingFromDesign.current = false; }, 50);
    };

    // Track active formatting state on selection change
    const handleSelectionChange = () => {
      const newState: Record<string, boolean> = {};
      for (const cmd of TOGGLE_CMDS) {
        try {
          newState[cmd] = doc.queryCommandState(cmd);
        } catch {
          newState[cmd] = false;
        }
      }
      // Check formatBlock state
      try {
        const block = doc.queryCommandValue('formatBlock');
        newState['formatBlock:h1'] = block === 'h1';
        newState['formatBlock:h2'] = block === 'h2';
        newState['formatBlock:h3'] = block === 'h3';
        newState['formatBlock:blockquote'] = block === 'blockquote';
      } catch { /* ignore */ }
      setActiveFormats(newState);
    };

    // Cmd+S inside iframe
    const handleKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        onSave?.();
      }
    };

    doc.addEventListener('input', handleInput);
    doc.addEventListener('selectionchange', handleSelectionChange);
    doc.addEventListener('keydown', handleKeydown);

    return () => {
      doc.removeEventListener('input', handleInput);
      doc.removeEventListener('selectionchange', handleSelectionChange);
      doc.removeEventListener('keydown', handleKeydown);
    };
  }, [getIframeDoc, onChange, onSave, serializeDoc]);

  /* ── Detach previous listeners, attach fresh ones, remember the cleanup ── */
  const reattachDesignListeners = useCallback(() => {
    designListenersCleanup.current?.();
    designListenersCleanup.current = setupDesignListeners() ?? null;
  }, [setupDesignListeners]);

  /* ── Initialize iframe content and designMode ── */
  useEffect(() => {
    const isDesign = viewMode === 'design' || viewMode === 'split';
    writeToIframe(sourceText, isDesign);

    if (isDesign) {
      // Small delay to ensure doc is ready before attaching listeners
      const timer = setTimeout(() => {
        designModeSetup.current = true;
        reattachDesignListeners();
      }, 50);
      return () => {
        clearTimeout(timer);
        designListenersCleanup.current?.();
        designListenersCleanup.current = null;
      };
    } else {
      designModeSetup.current = false;
      designListenersCleanup.current?.();
      designListenersCleanup.current = null;
    }
  // We only want to re-run when viewMode changes, not on every sourceText change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  /* ── Source → Design sync (debounced) ── */
  useEffect(() => {
    if (isSyncingFromDesign.current) return;
    const isDesign = viewMode === 'design' || viewMode === 'split';
    if (!isDesign) {
      // If only source mode, no iframe to update
      return;
    }

    if (sourceDebounceRef.current) clearTimeout(sourceDebounceRef.current);
    sourceDebounceRef.current = setTimeout(() => {
      writeToIframe(sourceText, true);
      // Re-attach listeners after rewriting (previous set is detached first)
      setTimeout(() => reattachDesignListeners(), 50);
    }, 500);

    return () => {
      if (sourceDebounceRef.current) clearTimeout(sourceDebounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceText]);

  /* ── Handle source text change from textarea ── */
  const handleSourceChange = useCallback((value: string) => {
    setSourceText(value);
    isExternalUpdate.current = true;
    onChange(value);
  }, [onChange]);

  /* ── Execute formatting command ── */
  const execCmd = useCallback((cmd: string, arg?: string) => {
    const doc = getIframeDoc();
    if (!doc) return;
    // Focus iframe first
    iframeRef.current?.contentWindow?.focus();
    if (cmd === 'formatBlock' && arg) {
      doc.execCommand('formatBlock', false, `<${arg}>`);
    } else {
      doc.execCommand(cmd, false, arg || undefined);
    }
    // Sync immediately after command
    setTimeout(() => {
      const html = serializeDoc(doc);
      isSyncingFromDesign.current = true;
      setSourceText(html);
      isExternalUpdate.current = true;
      onChange(html);
      setTimeout(() => { isSyncingFromDesign.current = false; }, 50);
    }, 10);
  }, [getIframeDoc, onChange, serializeDoc]);

  const syncDesignHtml = useCallback(() => {
    const doc = getIframeDoc();
    if (!doc) return;
    const html = serializeDoc(doc);
    isSyncingFromDesign.current = true;
    setSourceText(html);
    isExternalUpdate.current = true;
    onChange(html);
    setTimeout(() => { isSyncingFromDesign.current = false; }, 50);
  }, [getIframeDoc, onChange, serializeDoc]);

  /* ── Codex image placeholder styling (broken img shows its alt text) ── */
  const applyPendingStyle = useCallback((img: HTMLImageElement) => {
    img.dataset.codexPending = 'true';
    img.alt = 'Generating image…';
    img.style.minWidth = '200px';
    img.style.minHeight = '120px';
    img.style.padding = '8px';
    img.style.border = '2px dashed #8aa0c8';
    img.style.borderRadius = '6px';
    img.style.background = 'rgba(120,150,200,0.08)';
    img.style.color = '#8aa0c8';
    img.style.fontSize = '12px';
  }, []);

  const clearPendingStyle = useCallback((img: HTMLImageElement, prompt: string) => {
    delete img.dataset.codexPending;
    img.alt = prompt;
    img.style.minWidth = '';
    img.style.minHeight = '';
    img.style.padding = '';
    img.style.border = '';
    img.style.borderRadius = '';
    img.style.background = '';
    img.style.color = '';
    img.style.fontSize = '';
  }, []);

  /* ── Poll for a generated image file; swap src in once it exists ── */
  const pollCodexImage = useCallback((item: CodexImageHistoryItem) => {
    if (!item.savedPath) return;
    const savedPath = item.savedPath;
    const deadline = Date.now() + 5 * 60 * 1000; // 5 minute timeout

    const finish = (timer: ReturnType<typeof setTimeout>) => {
      codexPollTimers.current.delete(timer);
    };

    const tick = async () => {
      const doc = getIframeDoc();
      const img = doc?.querySelector<HTMLImageElement>(`img[data-codex-image-id="${item.id}"]`) || null;

      let ready = false;
      try {
        const meta = await invoke<{ size_bytes?: number | null }>('get_file_metadata', { path: savedPath });
        ready = typeof meta?.size_bytes === 'number' && meta.size_bytes > 0;
      } catch {
        ready = false;
      }

      if (ready) {
        if (img) {
          clearPendingStyle(img, item.prompt);
          img.dataset.savedPath = savedPath;
          img.src = `${convertFileSrc(savedPath)}?t=${Date.now()}`;
          syncDesignHtml();
        }
        return;
      }

      if (Date.now() > deadline) {
        if (img) {
          img.dataset.codexPending = 'timeout';
          img.alt = 'Image generation timed out';
          img.style.borderColor = '#d67c7c';
          img.style.color = '#d67c7c';
        }
        return;
      }

      const next = setTimeout(() => { finish(next); void tick(); }, 3500);
      codexPollTimers.current.add(next);
    };

    const first = setTimeout(() => { finish(first); void tick(); }, 3500);
    codexPollTimers.current.add(first);
  }, [getIframeDoc, clearPendingStyle, syncDesignHtml]);

  const insertImageIntoDesign = useCallback((item: CodexImageHistoryItem) => {
    const doc = getIframeDoc();
    if (!doc) return;
    iframeRef.current?.contentWindow?.focus();

    // A saved-but-not-yet-generated image (no data URL) starts as a placeholder.
    const pending = !item.dataUrl && !!item.savedPath;

    const img = doc.createElement('img');
    img.src = item.dataUrl || (item.savedPath ? convertFileSrc(item.savedPath) : '');
    img.alt = item.prompt;
    img.dataset.codexImageId = item.id;
    if (item.savedPath) img.dataset.savedPath = item.savedPath;
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.display = 'block';
    img.style.margin = '12px 0';
    if (pending) applyPendingStyle(img);

    const selection = doc.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (range) {
      range.deleteContents();
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      doc.body?.appendChild(img);
    }

    syncDesignHtml();
    if (pending) pollCodexImage(item);
    setLastInsertedId(item.id);
    setTimeout(() => setLastInsertedId(current => current === item.id ? null : current), 1400);
  }, [getIframeDoc, syncDesignHtml, applyPendingStyle, pollCodexImage]);

  const handleCodexImageRun = useCallback(async () => {
    const prompt = imagePrompt.trim();
    if (!prompt || imageLoading) return;
    if (imageMode === 'edit' && !selectedImage) {
      setImageError('수정할 이미지를 히스토리에서 먼저 선택하세요.');
      return;
    }

    setImageLoading(true);
    setImageError(null);
    try {
      const id = `codex-img-${Date.now()}`;
      const fileDir = currentFilePath?.split('/').slice(0, -1).join('/') || '';
      const imageDir = `${fileDir || '.'}/img`;
      const savedPath = `${imageDir}/${id}.png`;
      const promptPath = `${imageDir}/${id}.prompt.md`;
      await invoke('create_directory', { path: imageDir });
      await invoke('write_file', {
        path: promptPath,
        content: `# HTML Design Image Codex Prompt

## Job
- Mode: ${imageMode}
- Source HTML: ${currentFilePath || '(unsaved html editor)'}
- Target image path: ${savedPath}
- Prompt file: ${promptPath}
${imageMode === 'edit' && selectedImage?.savedPath ? `- Edit source image: ${selectedImage.savedPath}\n` : ''}

## Hard Rules
- Use Codex for this image generation/editing task.
- Do not use Gemini, Gemini API keys, or NanoBanana.
- If an external image API is needed, use only an API explicitly configured by the user/project.
- Save the final image exactly to the target image path above.
- After finishing, report the saved image path.

## User Prompt
${prompt}
`,
      });
      const nextItem: CodexImageHistoryItem = {
        id,
        prompt,
        mode: imageMode,
        savedPath,
        createdAt: Date.now(),
      };

      setImageHistory(prev => [nextItem, ...prev].slice(0, MAX_CODEX_IMAGE_HISTORY));
      setSelectedImageId(nextItem.id);
      setImageMode('edit');
      setImagePrompt('');
      insertImageIntoDesign(nextItem);
      onTerminalPrompt?.(`HTML 디자인 이미지 작업을 Codex로 실행해줘.

프롬프트 파일: ${promptPath}
결과 이미지 저장 경로: ${savedPath}
${imageMode === 'edit' && selectedImage?.savedPath ? `수정 대상 이미지: ${selectedImage.savedPath}\n` : ''}
규칙:
1. 프롬프트 파일을 읽고 이미지 생성/수정 작업을 수행해.
2. Gemini, Gemini API 키, NanoBanana는 절대 사용하지 마.
3. Codex의 이미지 기능을 우선 사용하고, 필요하면 사용자가 설정한 이미지 API만 사용해.
4. 결과 이미지를 정확히 위 저장 경로에 저장해.
5. 완료 후 저장 경로만 짧게 알려줘.`);
    } catch (err) {
      console.error('[HtmlDesignEditor] Codex image failed:', err);
      setImageError(err instanceof Error ? err.message : String(err));
    } finally {
      setImageLoading(false);
    }
  }, [currentFilePath, imageLoading, imageMode, imagePrompt, insertImageIntoDesign, onTerminalPrompt, selectedImage]);

  const handleClearCodexImageHistory = useCallback(() => {
    setImageHistory([]);
    setSelectedImageId(null);
    setImageMode('generate');
    try {
      localStorage.removeItem(CODEX_IMAGE_HISTORY_KEY);
    } catch {
      // ignore
    }
  }, []);

  /* ── Handle toolbar button click ── */
  const handleFmtClick = useCallback((btn: FmtButton, e: React.MouseEvent) => {
    e.preventDefault(); // Keep iframe focus
    if (btn.promptArg) {
      const placeholder = btn.cmd === 'createLink' ? 'https://example.com' : 'https://example.com/image.png';
      setLinkInput({ cmd: btn.cmd, visible: true, value: placeholder });
      return;
    }
    execCmd(btn.cmd, btn.arg);
  }, [execCmd]);

  /* ── Submit link/image URL ── */
  const handleLinkSubmit = useCallback(() => {
    if (linkInput.value.trim()) {
      execCmd(linkInput.cmd, linkInput.value.trim());
    }
    setLinkInput({ cmd: '', visible: false, value: '' });
  }, [linkInput, execCmd]);

  /* ── Check if format button is active ── */
  const isFormatActive = useCallback((btn: FmtButton): boolean => {
    if (btn.arg) {
      return !!activeFormats[`${btn.cmd}:${btn.arg}`];
    }
    return !!activeFormats[btn.cmd];
  }, [activeFormats]);

  /* ── Keyboard shortcut: Cmd+S (main window) ── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (focusOutsideEditor(editorRootRef.current, e)) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        onSave?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onSave]);

  /* ── Copy HTML to clipboard ── */
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(sourceText).catch(() => {});
  }, [sourceText]);

  /* ── Download as HTML file ── */
  const handleDownload = useCallback(() => {
    const blob = new Blob([sourceText], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'page.html';
    a.click();
    URL.revokeObjectURL(url);
  }, [sourceText]);

  /* ── Refresh preview ── */
  const handleRefresh = useCallback(() => {
    const isDesign = viewMode === 'design' || viewMode === 'split';
    writeToIframe(sourceText, isDesign);
    if (isDesign) {
      setTimeout(() => reattachDesignListeners(), 50);
    }
  }, [sourceText, viewMode, writeToIframe, reattachDesignListeners]);

  /* ── Clean up listeners and poll timers on unmount ── */
  useEffect(() => {
    const timers = codexPollTimers.current;
    return () => {
      designListenersCleanup.current?.();
      designListenersCleanup.current = null;
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  const showDesign = viewMode === 'design' || viewMode === 'split';
  const showSource = viewMode === 'source' || viewMode === 'split';

  return (
    <div ref={editorRootRef} className={`he-root ${isLightTheme ? 'he-light' : ''}`} style={{ color: style.text }}>
      {/* Main Toolbar */}
      <div className="he-toolbar">
        {/* View Mode */}
        <div className="he-toolbar-group">
          <button
            className={`he-btn ${viewMode === 'build' ? 'active' : ''}`}
            onClick={() => setViewMode('build')}
            title="Visual builder (blocks, layers, inspector)"
          >
            <Blocks size={13} /> Build
          </button>
          <button
            className={`he-btn ${viewMode === 'design' ? 'active' : ''}`}
            onClick={() => setViewMode('design')}
            title="Design mode (WYSIWYG)"
          >
            <PaintBucket size={13} /> Design
          </button>
          <button
            className={`he-btn ${viewMode === 'split' ? 'active' : ''}`}
            onClick={() => setViewMode('split')}
            title="Split view"
          >
            <Columns2 size={13} /> Split
          </button>
          <button
            className={`he-btn ${viewMode === 'source' ? 'active' : ''}`}
            onClick={() => setViewMode('source')}
            title="Source only"
          >
            <Code2 size={13} /> Source
          </button>
        </div>
        <div className="he-toolbar-sep" />

        {viewMode !== 'build' && (
          <>
            {/* Device Preview */}
            <div className="he-toolbar-group">
              <button className={`he-btn ${device === 'desktop' ? 'active' : ''}`} onClick={() => setDevice('desktop')} title="Desktop">
                <Monitor size={13} />
              </button>
              <button className={`he-btn ${device === 'tablet' ? 'active' : ''}`} onClick={() => setDevice('tablet')} title="Tablet">
                <Tablet size={13} />
              </button>
              <button className={`he-btn ${device === 'mobile' ? 'active' : ''}`} onClick={() => setDevice('mobile')} title="Mobile">
                <Smartphone size={13} />
              </button>
            </div>
            <div className="he-toolbar-sep" />

            {/* Codex Image */}
            <div className="he-toolbar-group">
              <button
                className={`he-btn ${showCodexImagePanel ? 'active' : ''}`}
                onClick={() => {
                  if (!showDesign) setViewMode('split');
                  setShowCodexImagePanel(prev => !prev);
                }}
                title="Codex image"
              >
                <Sparkles size={13} /> Codex Image
              </button>
            </div>
            <div className="he-toolbar-sep" />
          </>
        )}

        {/* Actions */}
        <div className="he-toolbar-group" style={{ marginLeft: 'auto' }}>
          {viewMode !== 'build' && (
            <button className="he-btn" onClick={handleRefresh} title="Refresh preview">
              <RotateCcw size={13} />
            </button>
          )}
          <button className="he-btn" onClick={handleCopy} title="Copy HTML">
            <Copy size={13} />
          </button>
          <button className="he-btn" onClick={handleDownload} title="Download HTML">
            <Download size={13} />
          </button>
        </div>
      </div>

      {/* Formatting Toolbar — design/split only */}
      {showDesign && (
        <div className="he-toolbar he-format-toolbar">
          {FMT_GROUPS.map((group, gi) => (
            <div key={gi} className="he-toolbar-group">
              {gi > 0 && <div className="he-toolbar-sep" style={{ margin: '0 2px' }} />}
              {group.map((btn, bi) => (
                <button
                  key={bi}
                  className={`he-btn he-fmt-btn ${isFormatActive(btn) ? 'active' : ''}`}
                  onMouseDown={(e) => handleFmtClick(btn, e)}
                  title={btn.title}
                >
                  {btn.icon}
                </button>
              ))}
            </div>
          ))}

          {/* Inline link/image URL input */}
          {linkInput.visible && (
            <div className="he-link-input-wrap">
              <input
                className="he-link-input"
                type="text"
                value={linkInput.value}
                onChange={(e) => setLinkInput(prev => ({ ...prev, value: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleLinkSubmit();
                  if (e.key === 'Escape') setLinkInput({ cmd: '', visible: false, value: '' });
                }}
                placeholder={linkInput.cmd === 'createLink' ? 'Enter URL...' : 'Enter image URL...'}
                autoFocus
              />
              <button className="he-btn" onMouseDown={(e) => { e.preventDefault(); handleLinkSubmit(); }}>OK</button>
              <button className="he-btn" onMouseDown={(e) => { e.preventDefault(); setLinkInput({ cmd: '', visible: false, value: '' }); }}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {showCodexImagePanel && showDesign && (
        <div className="he-codex-image-panel">
          <div className="he-codex-image-controls">
            <div className="he-segmented" role="tablist" aria-label="Codex image mode">
              <button
                className={`he-segment ${imageMode === 'generate' ? 'active' : ''}`}
                onClick={() => setImageMode('generate')}
                title="Create image"
              >
                <Sparkles size={12} /> Create
              </button>
              <button
                className={`he-segment ${imageMode === 'edit' ? 'active' : ''}`}
                onClick={() => setImageMode('edit')}
                disabled={!selectedImage}
                title="Edit selected image"
              >
                <Wand2 size={12} /> Edit
              </button>
            </div>
            <input
              className="he-codex-image-input"
              value={imagePrompt}
              onChange={(e) => setImagePrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleCodexImageRun();
                if (e.key === 'Escape') setShowCodexImagePanel(false);
              }}
              placeholder={imageMode === 'edit' ? 'Edit selected image...' : 'Describe an image...'}
              disabled={imageLoading}
            />
            <button
              className="he-btn he-codex-image-send"
              onClick={() => void handleCodexImageRun()}
              disabled={!imagePrompt.trim() || imageLoading}
              title={imageMode === 'edit' ? 'Edit image' : 'Create image'}
            >
              {imageLoading ? <span className="he-codex-image-spinner" /> : <Send size={13} />}
            </button>
            <button className="he-btn" onClick={() => setShowCodexImagePanel(false)} title="Close">
              <X size={13} />
            </button>
          </div>

          {imageError && (
            <div className="he-codex-image-error">
              <span>{imageError}</span>
              <button className="he-btn" onClick={() => setImageError(null)} title="Dismiss">
                <X size={12} />
              </button>
            </div>
          )}

          <div className="he-codex-image-history">
            <div className="he-codex-image-history-head">
              <span><History size={12} /> History</span>
              {imageHistory.length > 0 && (
                <button className="he-btn" onClick={handleClearCodexImageHistory} title="Clear history">
                  <X size={12} />
                </button>
              )}
            </div>
            {imageHistory.length === 0 ? (
              <div className="he-codex-image-empty">No images yet</div>
            ) : (
              <div className="he-codex-image-strip">
                {imageHistory.map(item => (
                  <button
                    key={item.id}
                    className={`he-codex-image-thumb ${item.id === selectedImageId ? 'active' : ''}`}
                    onClick={() => { setSelectedImageId(item.id); setImageMode('edit'); }}
                    onDoubleClick={() => insertImageIntoDesign(item)}
                    title={item.prompt}
                  >
                    <img src={item.dataUrl || (item.savedPath ? convertFileSrc(item.savedPath) : '')} alt="" />
                    <span className="he-codex-image-thumb-meta">
                      {item.mode === 'edit' ? <Wand2 size={10} /> : <Sparkles size={10} />}
                      {lastInsertedId === item.id ? <Check size={10} /> : null}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {selectedImage && (
              <button className="he-btn he-codex-image-insert" onClick={() => insertImageIntoDesign(selectedImage)} title="Insert selected image">
                <Image size={12} /> Insert
              </button>
            )}
          </div>
        </div>
      )}

      {/* Editor Body */}
      {viewMode === 'build' ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <HtmlBuilder
            html={sourceText}
            onChange={handleSourceChange}
            onSave={onSave}
            accent={style.accent}
            isLightTheme={isLightTheme}
            currentFilePath={currentFilePath}
            onTerminalPrompt={onTerminalPrompt}
          />
        </div>
      ) : (
      <div className="he-split-body">
        {/* Design Pane (editable iframe) */}
        {showDesign && (
          <div className="he-preview-pane">
            <div
              className="he-preview-frame-wrapper"
              style={{
                maxWidth: DEVICE_WIDTHS[device],
                margin: device !== 'desktop' ? '0 auto' : undefined,
              }}
            >
              <iframe
                ref={iframeRef}
                className="he-preview-iframe"
                /* allow-scripts is required: without it WebKit suppresses every
                   event listener inside the document, so design→source sync
                   (input/selectionchange) never fires. */
                sandbox="allow-same-origin allow-scripts"
                title="HTML Design Editor"
              />
            </div>
          </div>
        )}

        {/* Source Pane */}
        {showSource && (
          <div className="he-source-pane">
            <Editor
              language="html"
              value={sourceText}
              theme={isLightTheme ? 'light' : 'vs-dark'}
              onChange={(value) => handleSourceChange(value ?? '')}
              loading={<div className="he-source-loading">Loading editor…</div>}
              options={{
                minimap: { enabled: false },
                fontFamily: `'${fontFamily}', 'JetBrains Mono', 'Fira Code', monospace`,
                fontSize,
                lineNumbers: 'on',
                wordWrap: 'on',
                automaticLayout: true,
                scrollBeyondLastLine: false,
                tabSize: 2,
                padding: { top: 8, bottom: 8 },
              }}
            />
          </div>
        )}
      </div>
      )}

      {/* Status Bar */}
      <div className="he-bottom-bar">
        <span>{sourceText.length.toLocaleString()} chars</span>
        <span className="he-bottom-bar-spacer" />
        <span>{viewMode === 'build' ? 'Build' : showDesign ? 'Design' : 'Source'} Mode</span>
      </div>
    </div>
  );
}

export default HtmlDesignEditor;
