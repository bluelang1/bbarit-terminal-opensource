/**
 * DocxEditor.tsx
 *
 * DOCX viewer/editor using mammoth (DOCX -> HTML) for viewing
 * and docx library for exporting back to DOCX format.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Bold, Italic, Underline, Strikethrough,
  List, ListOrdered, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Save, SaveAll, Undo2, Redo2, Table, Link2, Highlighter, Image as ImageIcon,
  Palette, FileStack, ClipboardCheck, Sparkles, ListTree, CheckSquare, FileText, ShieldCheck, ListChecks, BookOpenCheck, FilePenLine, Handshake,
  Rows3, Columns3, Trash2, AlertTriangle,
  Search, Replace as ReplaceIcon, ChevronUp, ChevronDown, X, Quote, Code2, FileText as PageIcon, ScrollText,
  Scissors, Copy as CopyIcon, ClipboardPaste, Paintbrush, Superscript, Subscript, RemoveFormatting,
  IndentIncrease, IndentDecrease, AlignVerticalSpaceAround,
} from 'lucide-react';
import {
  WORD_THEME_COLORS, WORD_STANDARD_COLORS, WORD_HIGHLIGHT_COLORS,
  buildThemeColorGrid, LINE_SPACING_OPTIONS,
  DOCX_PAGE_SIZES, DOCX_PAGE_MARGINS, DEFAULT_PAGE_SETUP, pageDimensions, pxToTwip,
  type DocxPageSetup,
} from './docxWordChrome';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from '../i18n';
import {
  DOCX_DESIGN_THEMES,
  DOCX_DESIGN_PRESET_PACKS,
  DOCX_TEMPLATES,
  analyzeDocxHtml,
  applyDocxThemeToHtml,
  buildDocxActionPlanHtml,
  buildDocxApprovalPackHtml,
  buildDocxBriefPanelHtml,
  buildDocxCitationPackHtml,
  buildDocxDesignPresetHtml,
  buildDocxNegotiationPackHtml,
  buildDocxQualityPanelHtml,
  buildDocxRedlinePackHtml,
  buildDocxReviewPackHtml,
  buildDocxStrategyPackHtml,
  buildDocxTableOfContentsHtml,
  buildDocxTemplateHtml,
  cleanDocxHtml,
  cssColorToDocxHex,
  cssFontFamilyToDocx,
  cssLengthToHalfPoints,
  docxImageTypeFromMime,
  docxQuickStyleBlock,
  fontSizeAttrToHalfPoints,
  isDocxSupportedImageMime,
  DOCX_FONT_FAMILIES,
  DOCX_FONT_SIZE_PT_PRESETS,
  DOCX_QUICK_STYLES,
  getDocxDesignPresetPack,
  getDocxDesignTheme,
  parseDataUrl,
  polishDocxHtml,
  recommendDocxDesignPresetPacks,
  type DocxQualityReport,
} from './docxDesign';
import { focusOutsideEditor } from './editorKeyScope';
import './DocxEditor.css';

interface DocxEditorProps {
  filePath: string;
  /** base64 data URL (data:application/...) */
  docData: string;
  style: { bg: string; text: string; accent: string };
  onSaved?: (path: string) => void;
  onModifiedChange?: (modified: boolean) => void;
}

interface DocxToast {
  type: 'success' | 'error' | 'info';
  message: string;
}

interface DocxLinkDraft {
  url: string;
  text: string;
}

type DocxRibbonTab = 'File' | 'Home' | 'Insert' | 'Design' | 'Layout' | 'References' | 'Review' | 'View';

const DOCX_RIBBON_TABS: DocxRibbonTab[] = [
  'File',
  'Home',
  'Insert',
  'Design',
  'Layout',
  'References',
  'Review',
  'View',
];

// MS365-style fixed Office palette: the editor chrome stays light with the
// Word blue accent regardless of the terminal theme, like Word for web.
const OFFICE_UI = { bg: '#ffffff', text: '#242424', accent: '#185ABD' };


interface DocxFindState {
  current: number;
  total: number;
}

export function DocxEditor({ filePath, docData, style, onSaved, onModifiedChange }: DocxEditorProps) {
  const { t } = useTranslation();
  const [htmlContent, setHtmlContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [modified, setModified] = useState(false);
  const [fontSizePt, setFontSizePt] = useState('11');
  const [fontFamily, setFontFamily] = useState('');
  const [pageView, setPageView] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findState, setFindState] = useState<DocxFindState>({ current: 0, total: 0 });
  const [textColor, setTextColor] = useState('#111111');
  const [highlightColor, setHighlightColor] = useState('#fff59d');
  const [designThemeId, setDesignThemeId] = useState(DOCX_DESIGN_THEMES[0].id);
  const [templateId, setTemplateId] = useState(DOCX_TEMPLATES[0].id);
  const [designPresetPackId, setDesignPresetPackId] = useState(DOCX_DESIGN_PRESET_PACKS[0].id);
  const [qualityReport, setQualityReport] = useState<DocxQualityReport | null>(null);
  const [docAssistantStatus, setDocAssistantStatus] = useState('');
  const [activeRibbonTab, setActiveRibbonTab] = useState<DocxRibbonTab>('Home');
  const [toast, setToast] = useState<DocxToast | null>(null);
  const [linkDraft, setLinkDraft] = useState<DocxLinkDraft | null>(null);
  const [tablePicker, setTablePicker] = useState(false);
  const [tableHover, setTableHover] = useState({ rows: 0, cols: 0 });
  const [inTable, setInTable] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const editorRootRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const activeFindRef = useRef(0);
  const savedRangeRef = useRef<Range | null>(null);
  const undoStackRef = useRef<string[]>([]);
  const redoStackRef = useRef<string[]>([]);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // UI copy is standardized to English across all three editors.
  const L = useCallback((_ko: string, en: string) => en, []);

  // "Quality NN/100 · <status>" assistant line.
  const setQualityStatus = useCallback((score: number, _ko: string, en: string) => {
    setDocAssistantStatus(`Quality ${score}/100 · ${en}`);
  }, []);

  const showToast = useCallback((next: DocxToast) => {
    setToast(next);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2800);
  }, []);

  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  // Notify the parent whenever the dirty state flips.
  useEffect(() => {
    onModifiedChange?.(modified);
  }, [modified, onModifiedChange]);

  // Load and convert DOCX to HTML on mount or when docData changes
  const blobUrlsRef = useRef<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const loadDoc = async () => {
      setLoading(true);
      if (!cancelled) setLoadError(false);
      try {
        // docData: data URL(레거시/신규 파일) 또는 asset URL(파일에서 열기 —
        // base64 IPC의 30MB 상한과 대용량 직렬화 병목을 피해 fetch로 읽는다)
        // 새 문서는 빈 문자열로 온다 — fetch('')는 현재 페이지를 받아오므로 먼저 걸러낸다.
        if (!docData.trim()) {
          if (!cancelled) setHtmlContent('<p></p>');
          return;
        }
        let buffer: ArrayBuffer;
        if (docData.startsWith('data:')) {
          const base64 = docData.replace(/^data:[^;]+;base64,/, '');
          // Empty or new file — start with blank editor
          if (!base64.trim()) {
            if (!cancelled) setHtmlContent('<p></p>');
            return;
          }
          const binaryStr = atob(base64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          buffer = bytes.buffer;
        } else {
          const resp = await fetch(docData);
          if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
          buffer = await resp.arrayBuffer();
        }
        // 새 문서(0바이트 파일): mammoth가 던지므로 빈 본문으로 시작한다.
        if (!buffer.byteLength) {
          if (!cancelled) setHtmlContent('<p></p>');
          return;
        }
        const mammoth = await import('mammoth');
        const result = await mammoth.convertToHtml(
          { arrayBuffer: buffer },
          {
            // 이미지를 base64 데이터 URL로 인라인하면 이미지가 많은 문서에서
            // HTML이 수십~수백 MB로 폭발해 innerHTML 주입이 앱을 얼린다 —
            // blob URL로 넣고 원본 바이트는 docxImageStore에 보관해 export 때 쓴다.
            convertImage: mammoth.images.imgElement(function(image: any) {
              return image.read('base64').then(function(imageBuffer: string) {
                const mime = image.contentType || 'image/png';
                const binary = atob(imageBuffer);
                const imgBytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) imgBytes[i] = binary.charCodeAt(i);
                const url = URL.createObjectURL(new Blob([imgBytes], { type: mime }));
                // The effect may have already cleaned up (tab closed / doc swapped)
                // while this conversion was in flight — its cleanup won't run again,
                // so revoke here instead of leaking the blob URL and stored bytes.
                if (cancelled) {
                  URL.revokeObjectURL(url);
                  return { src: url };
                }
                docxImageStore.set(url, { mime, bytes: imgBytes });
                blobUrlsRef.current.push(url);
                return { src: url };
              });
            }),
          }
        );
        if (!cancelled) {
          setHtmlContent(result.value);
        }
      } catch (err) {
        console.error('[DocxEditor] Failed to convert DOCX:', err);
        if (!cancelled) {
          setHtmlContent('<p></p>');
          setLoadError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadDoc();
    return () => {
      cancelled = true;
      for (const url of blobUrlsRef.current) {
        URL.revokeObjectURL(url);
        docxImageStore.delete(url);
      }
      blobUrlsRef.current = [];
    };
  }, [docData]);

  // Set HTML content into the contentEditable div when htmlContent changes
  useEffect(() => {
    if (contentRef.current && htmlContent && !loading) {
      contentRef.current.innerHTML = htmlContent;
    }
  }, [htmlContent, loading]);

  // Word/char counts: reading innerText forces a layout flush, so never do it
  // per render — refresh on a debounce after typing (also keeps the status bar
  // live instead of frozen until the next unrelated re-render).
  const [statsTick, setStatsTick] = useState(0);
  const statsTimerRef = useRef<number | null>(null);
  const scheduleStatsRefresh = useCallback(() => {
    if (statsTimerRef.current != null) window.clearTimeout(statsTimerRef.current);
    statsTimerRef.current = window.setTimeout(() => setStatsTick((n) => n + 1), 500);
  }, []);
  useEffect(() => () => {
    if (statsTimerRef.current != null) window.clearTimeout(statsTimerRef.current);
  }, []);

  const handleInput = useCallback(() => {
    if (!modified) setModified(true);
    scheduleStatsRefresh();
  }, [modified, scheduleStatsRefresh]);

  // Toolbar: exec command
  const exec = useCallback((command: string, value?: string) => {
    document.execCommand(command, false, value);
    contentRef.current?.focus();
    if (!modified) setModified(true);
  }, [modified]);

  const insertTableSize = useCallback((rows: number, cols: number) => {
    if (rows < 1 || cols < 1) return;
    const cellStyle = 'border:1px solid gray;padding:6px 10px;min-width:60px';
    const thStyle = cellStyle + ';font-weight:600;background:rgba(128,128,128,0.12)';
    let html = '<table style="border-collapse:collapse;margin:1em 0;min-width:200px;border:1px solid gray"><tbody>';
    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) {
        html += r === 0
          ? `<th style="${thStyle}">&nbsp;</th>`
          : `<td style="${cellStyle}">&nbsp;</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table><p></p>';
    exec('insertHTML', html);
  }, [exec]);

  const openImagePicker = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  const handleImageFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) return;
      contentRef.current?.focus();
      exec('insertHTML', `<img src="${dataUrl}" alt="${file.name.replace(/"/g, '')}" /><p></p>`);
    };
    reader.readAsDataURL(file);
  }, [exec]);

  // Apply a point size to the selection. execCommand('fontSize') only accepts
  // 1–7, so we tag the range with size 7 and rewrite those <font> nodes into
  // spans carrying the real pt value (which the exporter reads back).
  const applyFontSizePt = useCallback((pt: string) => {
    setFontSizePt(pt);
    const el = contentRef.current;
    if (!el) return;
    el.focus();
    document.execCommand('fontSize', false, '7');
    el.querySelectorAll('font[size="7"]').forEach((font) => {
      const span = document.createElement('span');
      span.style.fontSize = `${pt}pt`;
      while (font.firstChild) span.appendChild(font.firstChild);
      font.replaceWith(span);
    });
    if (!modified) setModified(true);
  }, [modified]);

  const applyFontFamily = useCallback((family: string) => {
    setFontFamily(family);
    const el = contentRef.current;
    if (!el) return;
    el.focus();
    // An empty value clears the override back to the theme font.
    document.execCommand('fontName', false, family || 'inherit');
    if (!modified) setModified(true);
  }, [modified]);

  const applyQuickStyle = useCallback((styleId: string) => {
    exec('formatBlock', docxQuickStyleBlock(styleId));
  }, [exec]);

  const applyTextColor = useCallback((value: string) => {
    setTextColor(value);
    exec('foreColor', value);
  }, [exec]);

  const applyHighlightColor = useCallback((value: string) => {
    setHighlightColor(value);
    exec('hiliteColor', value);
  }, [exec]);

  // ── Word 크롬: 색상 팔레트 팝오버 · 서식 복사 · 줄 간격 · 페이지 설정 ──
  const [colorMenu, setColorMenu] = useState<null | 'text' | 'highlight'>(null);
  const [lineSpacingMenu, setLineSpacingMenu] = useState(false);
  const [pageSetup, setPageSetup] = useState<DocxPageSetup>(DEFAULT_PAGE_SETUP);
  interface PainterSnapshot {
    bold: boolean; italic: boolean; underline: boolean; strike: boolean;
    color: string; highlight: string; fontFamily: string;
  }
  const [painterFmt, setPainterFmt] = useState<PainterSnapshot | null>(null);

  const pickTextColor = useCallback((value: string) => {
    setColorMenu(null);
    applyTextColor(value);
  }, [applyTextColor]);

  const pickHighlightColor = useCallback((value: string) => {
    setColorMenu(null);
    setHighlightColor(value === 'transparent' ? '#FFFF00' : value);
    exec('hiliteColor', value);
  }, [exec]);

  // Word의 붙여넣기 버튼 — 비동기 클립보드가 거부되면 단축키 안내로 폴백
  const handlePasteButton = useCallback(async () => {
    contentRef.current?.focus();
    try {
      const text = await navigator.clipboard.readText();
      if (text) { exec('insertText', text); return; }
    } catch { /* WKWebView가 권한을 거부할 수 있다 */ }
    showToast({ type: 'info', message: 'Use ⌘V to paste' });
  }, [exec, showToast]);

  // Format Painter — 현재 선택의 서식을 캡처해 다음 선택에 1회 적용 (Word 동작).
  // queryCommand*는 포커스가 버튼으로 넘어간 순간 빈 값을 주므로
  // 선택 DOM의 computed style에서 직접 읽는다.
  const toggleFormatPainter = useCallback(() => {
    if (painterFmt) { setPainterFmt(null); return; }
    const sel = window.getSelection();
    const anchor = sel?.anchorNode;
    const host = anchor?.nodeType === Node.ELEMENT_NODE ? anchor as HTMLElement : anchor?.parentElement;
    if (!host || !contentRef.current?.contains(host)) return;
    const cs = window.getComputedStyle(host);
    setPainterFmt({
      bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
      italic: cs.fontStyle === 'italic',
      underline: cs.textDecorationLine.includes('underline'),
      strike: cs.textDecorationLine.includes('line-through'),
      color: cs.color,
      highlight: cs.backgroundColor,
      fontFamily: cs.fontFamily,
    });
  }, [painterFmt]);

  const applyFormatPainter = useCallback(() => {
    if (!painterFmt) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !contentRef.current?.contains(sel.anchorNode)) return;
    const snap = painterFmt;
    setPainterFmt(null);
    if (document.queryCommandState('bold') !== snap.bold) exec('bold');
    if (document.queryCommandState('italic') !== snap.italic) exec('italic');
    if (document.queryCommandState('underline') !== snap.underline) exec('underline');
    if (document.queryCommandState('strikeThrough') !== snap.strike) exec('strikeThrough');
    if (snap.color) exec('foreColor', snap.color);
    const transparent = snap.highlight === 'transparent' || snap.highlight === 'rgba(0, 0, 0, 0)';
    if (snap.highlight && !transparent) exec('hiliteColor', snap.highlight);
    if (snap.fontFamily) exec('fontName', snap.fontFamily);
  }, [exec, painterFmt]);

  // 줄 간격 — 선택 범위와 교차하는 블록 요소들에 line-height 적용
  const applyLineSpacing = useCallback((value: string) => {
    setLineSpacingMenu(false);
    const el = contentRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    const blocks: HTMLElement[] = [];
    el.querySelectorAll<HTMLElement>('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre').forEach((block) => {
      if (range.intersectsNode(block)) blocks.push(block);
    });
    if (blocks.length === 0) {
      const anchor = sel.anchorNode;
      const host = (anchor?.nodeType === Node.ELEMENT_NODE ? anchor as HTMLElement : anchor?.parentElement)
        ?.closest<HTMLElement>('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre');
      if (host && el.contains(host)) blocks.push(host);
    }
    blocks.forEach((block) => { block.style.lineHeight = value; });
    if (blocks.length > 0 && !modified) setModified(true);
  }, [modified]);

  // 팔레트/줄 간격 팝오버 — 바깥 클릭·Esc로 닫기
  useEffect(() => {
    if (!colorMenu && !lineSpacingMenu) return;
    const close = () => { setColorMenu(null); setLineSpacingMenu(false); };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.de-pop-wrap')) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [colorMenu, lineSpacingMenu]);

  const openLinkDialog = useCallback(() => {
    const sel = window.getSelection();
    let text = '';
    if (sel && sel.rangeCount > 0 && contentRef.current?.contains(sel.anchorNode)) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
      text = sel.toString();
    } else {
      savedRangeRef.current = null;
    }
    setLinkDraft({ url: '', text });
  }, []);

  const confirmLink = useCallback(() => {
    setLinkDraft((draft) => {
      const url = draft?.url.trim() || '';
      if (!url) return null;
      const el = contentRef.current;
      el?.focus();
      const sel = window.getSelection();
      if (savedRangeRef.current && sel) {
        sel.removeAllRanges();
        sel.addRange(savedRangeRef.current);
      }
      const href = url.replace(/"/g, '%22');
      const label = (draft?.text.trim() || url)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      exec('insertHTML', `<a href="${href}">${label}</a>`);
      savedRangeRef.current = null;
      return null;
    });
  }, [exec]);

  const markModified = useCallback(() => {
    if (!modified) setModified(true);
  }, [modified]);

  // Snapshot the current innerHTML before an action that replaces it wholesale,
  // so Cmd+Z can restore it (native execCommand undo cannot reach innerHTML swaps).
  const pushSnapshot = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    undoStackRef.current.push(el.innerHTML);
    if (undoStackRef.current.length > 40) undoStackRef.current.shift();
    // Cap total retained bytes too: a single snapshot of a doc with inline
    // base64 images is multi-MB, so a fixed count alone can still grow the
    // webview to hundreds of MB. Always keep at least the latest snapshot.
    let total = undoStackRef.current.reduce((n, s) => n + s.length, 0);
    while (undoStackRef.current.length > 1 && total > 8_000_000) {
      total -= (undoStackRef.current.shift() as string).length;
    }
    redoStackRef.current = [];
  }, []);

  const undoSnapshot = useCallback((): boolean => {
    const el = contentRef.current;
    if (!el) return false;
    const previous = undoStackRef.current.pop();
    if (previous === undefined) return false;
    redoStackRef.current.push(el.innerHTML);
    el.innerHTML = previous;
    markModified();
    return true;
  }, [markModified]);

  const redoSnapshot = useCallback((): boolean => {
    const el = contentRef.current;
    if (!el) return false;
    const next = redoStackRef.current.pop();
    if (next === undefined) return false;
    undoStackRef.current.push(el.innerHTML);
    el.innerHTML = next;
    markModified();
    return true;
  }, [markModified]);

  const handleUndo = useCallback(() => {
    if (!undoSnapshot()) exec('undo');
  }, [undoSnapshot, exec]);

  const handleRedo = useCallback(() => {
    if (!redoSnapshot()) exec('redo');
  }, [redoSnapshot, exec]);

  // --- Find & replace (non-destructive: temporary <mark> highlights only) ---

  // Unwrap every temporary highlight, restoring the original text nodes so the
  // document HTML is never left polluted.
  const clearFindHighlights = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    el.querySelectorAll('mark.dx-find-hit').forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    });
    el.normalize();
  }, []);

  const focusFindMatch = useCallback((index: number) => {
    const el = contentRef.current;
    if (!el) return;
    const marks = Array.from(el.querySelectorAll('mark.dx-find-hit'));
    if (marks.length === 0) {
      activeFindRef.current = 0;
      setFindState({ current: 0, total: 0 });
      return;
    }
    const clamped = ((index % marks.length) + marks.length) % marks.length;
    activeFindRef.current = clamped;
    marks.forEach((mark, i) => mark.classList.toggle('dx-find-hit-active', i === clamped));
    marks[clamped].scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFindState({ current: clamped + 1, total: marks.length });
  }, []);

  const runFind = useCallback((query: string, caseSensitive: boolean) => {
    clearFindHighlights();
    const el = contentRef.current;
    if (!el || !query) {
      setFindState({ current: 0, total: 0 });
      return;
    }
    const needle = caseSensitive ? query : query.toLowerCase();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.textContent && node.textContent.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) textNodes.push(node as Text);

    let total = 0;
    textNodes.forEach((textNode) => {
      const text = textNode.textContent || '';
      const hay = caseSensitive ? text : text.toLowerCase();
      let idx = hay.indexOf(needle);
      if (idx < 0) return;
      const frag = document.createDocumentFragment();
      let last = 0;
      while (idx >= 0) {
        if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
        const mark = document.createElement('mark');
        mark.className = 'dx-find-hit';
        mark.textContent = text.slice(idx, idx + query.length);
        frag.appendChild(mark);
        total += 1;
        last = idx + query.length;
        idx = hay.indexOf(needle, last);
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode?.replaceChild(frag, textNode);
    });

    if (total === 0) {
      setFindState({ current: 0, total: 0 });
      return;
    }
    focusFindMatch(0);
  }, [clearFindHighlights, focusFindMatch]);

  const gotoFindMatch = useCallback((delta: number) => {
    focusFindMatch(activeFindRef.current + delta);
  }, [focusFindMatch]);

  const replaceCurrentMatch = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const marks = Array.from(el.querySelectorAll('mark.dx-find-hit'));
    const active = marks[activeFindRef.current];
    if (!active) return;
    pushSnapshot();
    active.replaceWith(document.createTextNode(replaceQuery));
    el.normalize();
    markModified();
    runFind(findQuery, findCaseSensitive);
  }, [findCaseSensitive, findQuery, markModified, pushSnapshot, replaceQuery, runFind]);

  const replaceAllMatches = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const marks = Array.from(el.querySelectorAll('mark.dx-find-hit'));
    if (marks.length === 0) return;
    pushSnapshot();
    marks.forEach((mark) => mark.replaceWith(document.createTextNode(replaceQuery)));
    el.normalize();
    markModified();
    setFindState({ current: 0, total: 0 });
  }, [markModified, pushSnapshot, replaceQuery]);

  const openFind = useCallback(() => {
    setFindOpen(true);
    setTimeout(() => findInputRef.current?.focus(), 0);
  }, []);

  const closeFind = useCallback(() => {
    clearFindHighlights();
    setFindOpen(false);
    setFindState({ current: 0, total: 0 });
    contentRef.current?.focus();
  }, [clearFindHighlights]);

  // Re-run the search whenever the query or case sensitivity changes.
  // Debounced: runFind walks and rewraps the whole document DOM, which is far
  // too heavy to run on every keystroke of the find field.
  useEffect(() => {
    if (!findOpen) return;
    const timer = window.setTimeout(() => runFind(findQuery, findCaseSensitive), 200);
    return () => window.clearTimeout(timer);
  }, [findOpen, findQuery, findCaseSensitive, runFind]);

  const getCurrentCell = useCallback((): HTMLTableCellElement | null => {
    const sel = window.getSelection();
    let node = sel?.anchorNode as Node | null;
    const root = contentRef.current;
    while (node && node !== root) {
      if (node.nodeType === Node.ELEMENT_NODE && /^(td|th)$/i.test((node as Element).tagName)) {
        return node as HTMLTableCellElement;
      }
      node = node.parentNode;
    }
    return null;
  }, []);

  // Track whether the caret is inside a table so row/column controls can enable.
  useEffect(() => {
    const onSelectionChange = () => {
      const root = contentRef.current;
      const sel = window.getSelection();
      if (!root || !sel || sel.rangeCount === 0) { setInTable(false); return; }
      if (!root.contains(sel.anchorNode)) return;
      setInTable(Boolean(getCurrentCell()));
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [getCurrentCell]);

  const insertTableRow = useCallback(() => {
    const cell = getCurrentCell();
    const row = cell?.parentElement as HTMLTableRowElement | null;
    if (!cell || !row) return;
    pushSnapshot();
    const newRow = document.createElement('tr');
    for (let i = 0; i < row.cells.length; i++) {
      const td = document.createElement('td');
      td.setAttribute('style', 'border:1px solid gray;padding:6px 10px;min-width:60px');
      td.innerHTML = '&nbsp;';
      newRow.appendChild(td);
    }
    row.parentNode?.insertBefore(newRow, row.nextSibling);
    markModified();
  }, [getCurrentCell, pushSnapshot, markModified]);

  const insertTableColumn = useCallback(() => {
    const cell = getCurrentCell();
    const table = cell?.closest('table');
    if (!cell || !table) return;
    pushSnapshot();
    const colIndex = (cell as HTMLTableCellElement).cellIndex;
    table.querySelectorAll('tr').forEach((tr) => {
      const reference = (tr as HTMLTableRowElement).cells[colIndex];
      const isHeader = reference?.tagName.toLowerCase() === 'th';
      const newCell = document.createElement(isHeader ? 'th' : 'td');
      newCell.setAttribute('style', isHeader
        ? 'border:1px solid gray;padding:6px 10px;min-width:60px;font-weight:600;background:rgba(128,128,128,0.12)'
        : 'border:1px solid gray;padding:6px 10px;min-width:60px');
      newCell.innerHTML = '&nbsp;';
      if (reference) reference.insertAdjacentElement('afterend', newCell);
      else tr.appendChild(newCell);
    });
    markModified();
  }, [getCurrentCell, pushSnapshot, markModified]);

  const deleteTableRow = useCallback(() => {
    const cell = getCurrentCell();
    const row = cell?.parentElement as HTMLTableRowElement | null;
    const table = cell?.closest('table');
    if (!cell || !row || !table) return;
    if (table.querySelectorAll('tr').length <= 1) return;
    pushSnapshot();
    row.remove();
    markModified();
  }, [getCurrentCell, pushSnapshot, markModified]);

  const deleteTableColumn = useCallback(() => {
    const cell = getCurrentCell();
    const table = cell?.closest('table');
    if (!cell || !table) return;
    const colIndex = (cell as HTMLTableCellElement).cellIndex;
    const firstRow = table.querySelector('tr');
    if (!firstRow || (firstRow as HTMLTableRowElement).cells.length <= 1) return;
    pushSnapshot();
    table.querySelectorAll('tr').forEach((tr) => {
      (tr as HTMLTableRowElement).cells[colIndex]?.remove();
    });
    markModified();
  }, [getCurrentCell, pushSnapshot, markModified]);

  const selectedTheme = getDocxDesignTheme(designThemeId);
  const selectedDesignPreset = getDocxDesignPresetPack(designPresetPackId);

  const applyDesignTheme = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    el.innerHTML = applyDocxThemeToHtml(el.innerHTML, selectedTheme);
    markModified();
  }, [markModified, pushSnapshot, selectedTheme]);

  const applyTemplate = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    el.innerHTML = buildDocxTemplateHtml(templateId, designThemeId);
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, '템플릿 적용됨', 'template applied');
    markModified();
  }, [designThemeId, markModified, templateId]);

  const applyDesignPreset = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    const preset = getDocxDesignPresetPack(designPresetPackId);
    el.innerHTML = buildDocxDesignPresetHtml(preset.id);
    setDesignThemeId(preset.themeId);
    setTemplateId(preset.templateId);
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, `${preset.label} 프리셋 적용됨`, `${preset.label} preset applied`);
    markModified();
  }, [designPresetPackId, markModified]);

  const selectSmartDesignPreset = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const recommendation = recommendDocxDesignPresetPacks(el.innerHTML, 1)[0];
    if (!recommendation) return;
    setDesignPresetPackId(recommendation.preset.id);
    setDesignThemeId(recommendation.preset.themeId);
    setTemplateId(recommendation.preset.templateId);
    setDocAssistantStatus(`${L('스마트 프리셋', 'Smart preset')}: ${recommendation.preset.label} · ${recommendation.reason}`);
  }, []);

  const analyzeDocument = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, `신호 ${report.issues.length}개`, `${report.issues.length} signal${report.issues.length === 1 ? '' : 's'}`);
  }, []);

  const insertQualityReview = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    const report = analyzeDocxHtml(el.innerHTML);
    const withoutPreviousPanel = el.innerHTML.replace(/<section\b[^>]*data-docx-quality=["']true["'][\s\S]*?<\/section>/gi, '');
    el.innerHTML = `${withoutPreviousPanel}${applyDocxThemeToHtml(buildDocxQualityPanelHtml(report), selectedTheme)}`;
    setQualityReport(report);
    setQualityStatus(report.score, '품질 검토 삽입됨', 'review inserted');
    markModified();
  }, [markModified, selectedTheme]);

  const insertDocumentMap = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    const withoutPrevious = el.innerHTML.replace(/<section\b[^>]*data-docx-toc=["']true["'][\s\S]*?<\/section>/gi, '');
    el.innerHTML = `${applyDocxThemeToHtml(buildDocxTableOfContentsHtml(withoutPrevious), selectedTheme)}${withoutPrevious}`;
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, '문서 맵 삽입됨', 'map inserted');
    markModified();
  }, [markModified, selectedTheme]);

  const insertActionPlan = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    const withoutPrevious = el.innerHTML.replace(/<section\b[^>]*data-docx-actions=["']true["'][\s\S]*?<\/section>/gi, '');
    el.innerHTML = `${withoutPrevious}${applyDocxThemeToHtml(buildDocxActionPlanHtml(withoutPrevious), selectedTheme)}`;
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, '액션 플랜 삽입됨', 'action plan inserted');
    markModified();
  }, [markModified, selectedTheme]);

  const insertDocumentBrief = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    const withoutPrevious = el.innerHTML.replace(/<section\b[^>]*data-docx-brief=["']true["'][\s\S]*?<\/section>/gi, '');
    el.innerHTML = `${applyDocxThemeToHtml(buildDocxBriefPanelHtml(withoutPrevious), selectedTheme)}${withoutPrevious}`;
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, '브리프 삽입됨', 'brief inserted');
    markModified();
  }, [markModified, selectedTheme]);

  const insertReviewPack = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    const withoutPrevious = el.innerHTML.replace(/<section\b[^>]*data-docx-review-pack=["']true["'][\s\S]*?<\/section>/gi, '');
    el.innerHTML = `${applyDocxThemeToHtml(buildDocxReviewPackHtml(withoutPrevious), selectedTheme)}${withoutPrevious}`;
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, '리뷰 팩 삽입됨', 'review pack inserted');
    markModified();
  }, [markModified, selectedTheme]);

  const insertApprovalPack = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    const withoutPrevious = el.innerHTML.replace(/<section\b[^>]*data-docx-approval-pack=["']true["'][\s\S]*?<\/section>/gi, '');
    el.innerHTML = `${applyDocxThemeToHtml(buildDocxApprovalPackHtml(withoutPrevious), selectedTheme)}${withoutPrevious}`;
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, '승인 팩 삽입됨', 'approval pack inserted');
    markModified();
  }, [markModified, selectedTheme]);

  const insertCitationPack = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    const withoutPrevious = el.innerHTML.replace(/<section\b[^>]*data-docx-citation-pack=["']true["'][\s\S]*?<\/section>/gi, '');
    el.innerHTML = `${applyDocxThemeToHtml(buildDocxCitationPackHtml(withoutPrevious), selectedTheme)}${withoutPrevious}`;
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, '근거 팩 삽입됨', 'evidence pack inserted');
    markModified();
  }, [markModified, selectedTheme]);

  const insertRedlinePack = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    const withoutPrevious = el.innerHTML.replace(/<section\b[^>]*data-docx-redline-pack=["']true["'][\s\S]*?<\/section>/gi, '');
    el.innerHTML = `${applyDocxThemeToHtml(buildDocxRedlinePackHtml(withoutPrevious), selectedTheme)}${withoutPrevious}`;
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, '레드라인 팩 삽입됨', 'redline pack inserted');
    markModified();
  }, [markModified, selectedTheme]);

  const insertStrategyPack = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    const withoutPrevious = el.innerHTML.replace(/<section\b[^>]*data-docx-strategy-pack=["']true["'][\s\S]*?<\/section>/gi, '');
    el.innerHTML = `${applyDocxThemeToHtml(buildDocxStrategyPackHtml(withoutPrevious), selectedTheme)}${withoutPrevious}`;
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, '전략 팩 삽입됨', 'strategy pack inserted');
    markModified();
  }, [markModified, selectedTheme]);

  const insertNegotiationPack = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    const withoutPrevious = el.innerHTML.replace(/<section\b[^>]*data-docx-negotiation-pack=["']true["'][\s\S]*?<\/section>/gi, '');
    el.innerHTML = `${applyDocxThemeToHtml(buildDocxNegotiationPackHtml(withoutPrevious), selectedTheme)}${withoutPrevious}`;
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, '협상 팩 삽입됨', 'negotiation pack inserted');
    markModified();
  }, [markModified, selectedTheme]);

  const cleanDocument = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    el.innerHTML = cleanDocxHtml(el.innerHTML, selectedTheme);
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, '클린룸 적용됨', 'clean room applied');
    markModified();
  }, [markModified, selectedTheme]);

  const polishDocument = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    pushSnapshot();
    el.innerHTML = polishDocxHtml(el.innerHTML, selectedTheme);
    const report = analyzeDocxHtml(el.innerHTML);
    setQualityReport(report);
    setQualityStatus(report.score, '문서 다듬기 완료', 'document polished');
    markModified();
  }, [markModified, selectedTheme]);

  // Export current HTML content back to DOCX
  const fidelityWarnedRef = useRef(false);
  const exportToDocx = useCallback(async (
    saveAs?: boolean,
    opts?: { fromBridge?: boolean },
  ): Promise<{ ok: boolean; path?: string; cancelled?: boolean; warning?: string; error?: string }> => {
    const el = contentRef.current;
    if (!el) return { ok: false, error: 'document not mounted' };

    // Block saving over the original when the source failed to load, to avoid
    // overwriting it with a blank document.
    if (loadError) {
      showToast({ type: 'error', message: L('불러오기 실패 — 원본 보호를 위해 저장이 차단되었습니다.', 'Load failed — saving is blocked to protect the original file.') });
      return { ok: false, error: 'load failed; saving is blocked' };
    }

    // The save path rebuilds the file from converted HTML: headers/footers,
    // footnotes, comments and original styles are NOT preserved.
    let bridgeCopyPath: string | null = null;
    if (!saveAs && (docData || '').length > 0) {
      if (opts?.fromBridge) {
        // Agent path: a synchronous window.confirm would block until a human
        // clicks, tripping the 30s bridge timeout — save a sibling copy instead
        // of overwriting the original, and return that path.
        bridgeCopyPath = filePath.replace(/\.docx$/i, '.edited.docx');
        if (bridgeCopyPath === filePath) bridgeCopyPath = `${filePath}.edited.docx`;
      } else if (!fidelityWarnedRef.current) {
        // Human path: warn once before the first overwrite of a non-empty original.
        const ok = window.confirm(L(
          '저장하면 이 에디터의 단순화된 구조로 파일을 다시 씁니다 — 머리글/바닥글, 각주, 원본 스타일 일부는 유지되지 않습니다. 계속할까요? (원본을 남기려면 "다른 이름으로 저장"을 사용하세요.)',
          'Saving rewrites this file with the editor\'s simplified structure — headers/footers, footnotes, and some original styles are not preserved. Continue? (Use Save As to keep the original.)',
        ));
        if (!ok) return { ok: false, cancelled: true };
        fidelityWarnedRef.current = true;
      }
    }

    // Strip temporary find highlights so they never leak into the saved file.
    clearFindHighlights();

    try {
      const docxLib = await import('docx');
      const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
              Table: DocxTable, TableRow, TableCell, WidthType, BorderStyle,
              ExternalHyperlink, ImageRun } = docxLib;

      const runClasses: DocxRunClasses = { TextRun, ExternalHyperlink, ImageRun };
      const children: any[] = [];

      // Each top-level ordered list needs its own numbering instance, otherwise
      // every ol shares one counter and later lists continue 4,5,6 instead of 1,2,3.
      let numberingInstance = 0;
      const parseList = (listEl: Element, ordered: boolean, level: number, instance: number) => {
        const items = listEl.querySelectorAll(':scope > li');
        items.forEach((li) => {
          children.push(new Paragraph({
            children: parseInlineRuns(li, runClasses),
            bullet: ordered ? undefined : { level },
            numbering: ordered ? { reference: 'default-numbering', level, instance } : undefined,
          }));
          li.querySelectorAll(':scope > ul, :scope > ol').forEach((sub) => {
            const subOrdered = sub.tagName.toLowerCase() === 'ol';
            // Nested ol continues the parent's numbering only when the parent is
            // also ordered; an ol nested in a bullet list starts a fresh instance.
            const subInstance = subOrdered ? (ordered ? instance : numberingInstance++) : instance;
            parseList(sub, subOrdered, level + 1, subInstance);
          });
        });
      };

      const parseNodes = (parentEl: Element) => {
        for (let i = 0; i < parentEl.children.length; i++) {
          const node = parentEl.children[i];
          const tag = node.tagName.toLowerCase();

          // 편집기에서 지정한 줄 간격(line-height 배수)을 docx spacing으로 보존
          const lineSpacing = (() => {
            const lh = parseFloat((node as HTMLElement).style?.lineHeight || '');
            return Number.isFinite(lh) && lh > 0 ? { line: Math.round(lh * 240), lineRule: docxLib.LineRuleType.AUTO } : undefined;
          })();

          if (/^h[1-6]$/.test(tag)) {
            // Map every heading level — h4–h6 used to be silently demoted to
            // plain paragraphs on save.
            const level = tag === 'h1' ? HeadingLevel.HEADING_1
              : tag === 'h2' ? HeadingLevel.HEADING_2
              : tag === 'h3' ? HeadingLevel.HEADING_3
              : tag === 'h4' ? HeadingLevel.HEADING_4
              : tag === 'h5' ? HeadingLevel.HEADING_5
              : HeadingLevel.HEADING_6;
            children.push(new Paragraph({
              heading: level,
              children: parseInlineRuns(node, runClasses),
              spacing: lineSpacing,
            }));
          } else if (tag === 'section' || tag === 'article' || tag === 'main') {
            parseNodes(node);
          } else if (tag === 'img') {
            const image = buildImageRun(node as HTMLImageElement, ImageRun);
            if (image) children.push(new Paragraph({ children: [image] }));
          } else if (tag === 'p') {
            children.push(new Paragraph({
              children: parseInlineRuns(node, runClasses),
              alignment: getAlignment(node, AlignmentType),
              spacing: lineSpacing,
            }));
          } else if (tag === 'div') {
            // A <div> can wrap block children (pasted / agent HTML). Flattening it
            // into one Paragraph merges those blocks into a single line, so recurse
            // when it holds blocks and only make a Paragraph for inline-only divs.
            const hasBlockChild = Array.from(node.children).some((child) =>
              /^(p|div|ul|ol|table|h[1-6]|blockquote|pre|section|article|main)$/i.test(child.tagName));
            if (hasBlockChild) {
              parseNodes(node);
            } else {
              children.push(new Paragraph({
                children: parseInlineRuns(node, runClasses),
                alignment: getAlignment(node, AlignmentType),
                spacing: lineSpacing,
              }));
            }
          } else if (tag === 'ul' || tag === 'ol') {
            const instance = tag === 'ol' ? numberingInstance++ : 0;
            parseList(node, tag === 'ol', 0, instance);
          } else if (tag === 'table') {
            const rows: any[] = [];
            const trs = node.querySelectorAll('tr');
            trs.forEach((tr) => {
              const cells: any[] = [];
              const tds = tr.querySelectorAll('td, th');
              tds.forEach((td) => {
                cells.push(new TableCell({
                  children: [new Paragraph({ children: parseInlineRuns(td, runClasses) })],
                  width: { size: 2400, type: WidthType.DXA },
                  borders: {
                    top: { style: BorderStyle.SINGLE, size: 1 },
                    bottom: { style: BorderStyle.SINGLE, size: 1 },
                    left: { style: BorderStyle.SINGLE, size: 1 },
                    right: { style: BorderStyle.SINGLE, size: 1 },
                  },
                }));
              });
              if (cells.length > 0) {
                rows.push(new TableRow({ children: cells }));
              }
            });
            if (rows.length > 0) {
              children.push(new DocxTable({ rows }));
            }
          } else if (tag === 'blockquote') {
            children.push(new Paragraph({
              children: parseInlineRuns(node, runClasses, { italic: true }),
              indent: { left: 720 },
            }));
          } else if (tag === 'pre') {
            // Preserve code line breaks as separate monospace paragraphs.
            const lines = (node.textContent || '').replace(/\n$/, '').split('\n');
            lines.forEach((line) => {
              children.push(new Paragraph({
                children: [new TextRun({ text: line, font: 'Courier New' })],
              }));
            });
          } else if (node.textContent?.trim()) {
            children.push(new Paragraph({ children: parseInlineRuns(node, runClasses) }));
          }
        }
      };

      parseNodes(el);

      // If no structured content found, create from text
      if (children.length === 0) {
        const text = el.innerText || '';
        text.split('\n').forEach((line: string) => {
          children.push(new Paragraph({
            children: [new TextRun({ text: line })],
          }));
        });
      }

      const doc = new Document({
        numbering: {
          config: [{
            reference: 'default-numbering',
            levels: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((level) => ({
              level,
              format: docxLib.LevelFormat.DECIMAL,
              text: `%${level + 1}.`,
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
            })),
          }],
        },
        sections: [{
          // Layout 탭의 여백·방향·용지 설정을 실제 docx 섹션 속성으로 내보낸다
          properties: {
            page: {
              // docx 라이브러리는 LANDSCAPE일 때 폭/높이를 스스로 바꿔 쓴다 — 세로 기준 치수를 넘긴다
              size: {
                width: pxToTwip(DOCX_PAGE_SIZES[pageSetup.size].w),
                height: pxToTwip(DOCX_PAGE_SIZES[pageSetup.size].h),
                orientation: pageSetup.orientation === 'landscape'
                  ? docxLib.PageOrientation.LANDSCAPE
                  : docxLib.PageOrientation.PORTRAIT,
              },
              margin: {
                top: pxToTwip(DOCX_PAGE_MARGINS[pageSetup.margin].top),
                bottom: pxToTwip(DOCX_PAGE_MARGINS[pageSetup.margin].bottom),
                left: pxToTwip(DOCX_PAGE_MARGINS[pageSetup.margin].side),
                right: pxToTwip(DOCX_PAGE_MARGINS[pageSetup.margin].side),
              },
            },
          },
          children,
        }],
      });

      const blob = await Packer.toBlob(doc);
      const arrayBuf = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuf);
      let binary = '';
      for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]);
      }
      const base64 = btoa(binary);

      // Images in a format ImageRun cannot embed (webp/svg/emf/…) or with a
      // non-base64 src are dropped by buildImageRun — surface that instead of
      // silently losing them from the saved file.
      const droppedImages = Array.from(el.querySelectorAll('img')).filter((img) => {
        const src = img.getAttribute('src') || '';
        if (!src) return false;
        const stored = docxImageStore.get(src);
        if (stored) return !isDocxSupportedImageMime(stored.mime);
        const parsed = parseDataUrl(src);
        if (!parsed) return true; // non-base64 data URL (e.g. svg) or remote src
        return !isDocxSupportedImageMime(parsed.mime);
      }).length;

      let targetPath = filePath;
      if (saveAs) {
        const name = filePath.split(/[\\/]/).pop() || 'document.docx';
        const result = await invoke<string | null>('save_file_dialog', {
          defaultName: name,
          filters: [['Word Document', ['docx']]],
        });
        if (!result) return { ok: false, cancelled: true };
        targetPath = result;
      } else if (bridgeCopyPath) {
        targetPath = bridgeCopyPath;
      }

      await invoke('write_file_base64', { path: targetPath, base64Data: base64 });
      setModified(false);
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (droppedImages > 0) {
        showToast({ type: 'info', message: `Saved ${hhmm} — ${droppedImages} image${droppedImages === 1 ? '' : 's'} skipped (unsupported format)` });
      } else {
        showToast({ type: 'success', message: `Saved ${hhmm}` });
      }
      onSaved?.(targetPath);
      const warning = [
        bridgeCopyPath ? 'saved a copy to preserve the original (headers/footers, footnotes, and some original styles are not preserved)' : '',
        droppedImages > 0 ? `${droppedImages} image(s) skipped (unsupported format)` : '',
      ].filter(Boolean).join('; ');
      return { ok: true, path: targetPath, warning: warning || undefined };
    } catch (err) {
      console.error('[DocxEditor] Failed to export DOCX:', err);
      showToast({ type: 'error', message: 'Save failed' });
      // Return the failure so the bridge (and any awaiting caller) sees it
      // instead of a false success.
      return { ok: false, error: String((err as any)?.message || err) };
    }
  }, [filePath, onSaved, loadError, showToast, clearFindHighlights, pageSetup, docData, L]);

  // ─── Editor control bridge (terminal agent → document control) ──
  // App.tsx delegates `docx.*` commands here via a window CustomEvent, matched
  // by normalized filePath. Ref keeps fresh state without re-registering.
  const docxBridgeHandlerRef = useRef<(cmd: string, request: any) => Promise<any>>(async () => ({ ok: false, error: 'docx bridge not ready' }));
  docxBridgeHandlerRef.current = async (cmd: string, request: any) => {
    const el = contentRef.current;
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    switch (cmd) {
      case 'docx.getText':
        return { ok: true, text: (el?.innerText || '').slice(0, 30000) };
      case 'docx.getHtml':
        return { ok: true, html: (el?.innerHTML || '').slice(0, 80000) };
      case 'docx.append': {
        if (!el) return { ok: false, error: 'document not mounted yet' };
        const parts: string[] = [];
        if (request?.heading) parts.push(`<h2>${esc(String(request.heading))}</h2>`);
        if (request?.paragraph) {
          for (const p of String(request.paragraph).split(/\n{2,}/)) {
            if (p.trim()) parts.push(`<p>${esc(p.trim()).replace(/\n/g, '<br/>')}</p>`);
          }
        }
        if (request?.bullets && Array.isArray(request.bullets) && request.bullets.length) {
          parts.push(`<ul>${request.bullets.map((b: any) => `<li>${esc(String(b))}</li>`).join('')}</ul>`);
        }
        // Local trusted agent: raw HTML allowed for tables/styling.
        if (request?.html) parts.push(String(request.html));
        if (!parts.length) return { ok: false, error: 'heading/paragraph/bullets/html required' };
        el.insertAdjacentHTML('beforeend', parts.join(''));
        if (!modified) setModified(true);
        el.scrollTop = el.scrollHeight;
        return { ok: true, appended: parts.length };
      }
      case 'docx.replace': {
        if (!el) return { ok: false, error: 'document not mounted yet' };
        const find = String(request?.find ?? '');
        if (!find) return { ok: false, error: 'find (text to search for) required' };
        const replacement = String(request?.replace ?? '');
        const all = request?.all !== false;
        // Walk text nodes so replacement keeps existing inline formatting intact
        // instead of blowing away the HTML with an innerHTML string replace.
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let count = 0;
        const targets: Text[] = [];
        while (walker.nextNode()) targets.push(walker.currentNode as Text);
        for (const node of targets) {
          const text = node.nodeValue || '';
          if (!text.includes(find)) continue;
          if (all) {
            const occurrences = text.split(find).length - 1;
            node.nodeValue = text.split(find).join(replacement);
            count += occurrences;
          } else {
            node.nodeValue = text.replace(find, replacement);
            count += 1;
            break;
          }
        }
        if (count > 0 && !modified) setModified(true);
        return { ok: true, replaced: count };
      }
      case 'docx.setHtml': {
        if (!el) return { ok: false, error: 'document not mounted yet' };
        const html = request?.html;
        if (typeof html !== 'string') return { ok: false, error: 'html (full document body) required' };
        el.innerHTML = html;
        if (!modified) setModified(true);
        el.scrollTop = 0;
        return { ok: true, replaced: true };
      }
      case 'docx.save': {
        if (loadError) return { ok: false, error: 'source failed to load; saving is blocked' };
        const res = await exportToDocx(false, { fromBridge: true });
        if (!res.ok) return { ok: false, error: res.error || 'save failed' };
        return { ok: true, path: res.path || filePath, ...(res.warning ? { warning: res.warning } : {}) };
      }
      default:
        return { ok: false, error: `unknown docx cmd: ${cmd}` };
    }
  };

  useEffect(() => {
    const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const handler = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { reqId?: string; path?: string; cmd?: string; request?: any } | undefined;
      if (!d || normPath(String(d.path || '')) !== normPath(filePath)) return;
      const reqId = d.reqId;
      Promise.resolve(docxBridgeHandlerRef.current(String(d.cmd || ''), d.request || {}))
        .then((result) => {
          window.dispatchEvent(new CustomEvent('octo-docx-result', { detail: { reqId, result } }));
        })
        .catch((e: any) => {
          window.dispatchEvent(new CustomEvent('octo-docx-result', { detail: { reqId, result: { ok: false, error: String(e?.message || e) } } }));
        });
    };
    window.addEventListener('octo-docx-command', handler);
    return () => window.removeEventListener('octo-docx-command', handler);
  }, [filePath]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (focusOutsideEditor(editorRootRef.current, e)) return;
      const meta = e.metaKey || e.ctrlKey;
      // Lowercase compare — with Shift (or CapsLock) e.key arrives uppercase,
      // which used to kill Save-As (and Save under CapsLock) silently.
      if (meta && e.key.toLowerCase() === 's' && !e.shiftKey) {
        e.preventDefault();
        exportToDocx();
      }
      if (meta && e.key.toLowerCase() === 's' && e.shiftKey) {
        e.preventDefault();
        exportToDocx(true);
      }
      // Document-editing shortcuts must not fire while typing in the find /
      // replace fields — Ctrl+Z there used to undo the document itself.
      const target = e.target as HTMLElement | null;
      const inTextField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if (!inTextField) {
        // Tab inserts indent (Word behaviour); Shift+Tab outdents
        if (e.key === 'Tab' && !meta) {
          e.preventDefault();
          if (e.shiftKey) { exec('outdent'); } else { exec('indent'); }
          return;
        }
        if (meta && e.key.toLowerCase() === 'b') { e.preventDefault(); exec('bold'); }
        if (meta && e.key.toLowerCase() === 'i') { e.preventDefault(); exec('italic'); }
        if (meta && e.key.toLowerCase() === 'u') { e.preventDefault(); exec('underline'); }
        if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); }
        if (meta && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); handleRedo(); }
      }
      if (meta && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'h')) { e.preventDefault(); openFind(); }
      if (e.key === 'Escape' && findOpen) { e.preventDefault(); closeFind(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [exec, exportToDocx, handleUndo, handleRedo, openFind, closeFind, findOpen]);

  const docStats = useMemo(() => {
    const text = contentRef.current?.innerText || '';
    const trimmed = text.trim();
    return {
      words: trimmed ? trimmed.split(/\s+/).length : 0,
      chars: text.length,
    };
    // statsTick: debounced typing signal; loading/htmlContent: initial document load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsTick, loading, htmlContent]);

  if (loading) {
    return (
      <div className="docx-editor" style={{ color: OFFICE_UI.text, background: OFFICE_UI.bg }}>
        <div className="de-loading">{t('editor.loadingDocx')}</div>
      </div>
    );
  }

  return (
    <div
      className="docx-editor"
      ref={editorRootRef}
      style={{
        color: OFFICE_UI.text,
        background: OFFICE_UI.bg,
        ['--de-bg' as any]: OFFICE_UI.bg,
        ['--de-text' as any]: OFFICE_UI.text,
        ['--de-accent' as any]: OFFICE_UI.accent,
      }}
    >
      <div className="de-ribbon">
        <div className="de-ribbon-tabs">
          {DOCX_RIBBON_TABS.map((tab) => (
            <button
              key={tab}
              className={`de-ribbon-tab ${activeRibbonTab === tab ? 'active' : ''}`}
              onClick={() => setActiveRibbonTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="de-toolbar">
          {activeRibbonTab === 'File' && (
            <div className="de-toolbar-group" data-group={L('저장', 'Save')}>
              <button className="de-btn de-btn-primary" onClick={() => exportToDocx()} title={L('저장', 'Save (Cmd+S)')}>
                <Save size={13} /> {L('저장', 'Save')}
              </button>
              <button className="de-btn" onClick={() => exportToDocx(true)} title={L('다른 이름으로 저장', 'Save As (Cmd+Shift+S)')}>
                <SaveAll size={13} /> {L('다른 이름으로 저장', 'Save As')}
              </button>
            </div>
          )}

          {activeRibbonTab === 'Home' && (
            <>
              <div className="de-toolbar-group" data-group={L('클립보드', 'Clipboard')}>
                <button className="de-btn" onClick={() => exec('cut')} title={`${L('잘라내기', 'Cut')} (⌘X)`}><Scissors size={13} /></button>
                <button className="de-btn" onClick={() => exec('copy')} title={`${L('복사', 'Copy')} (⌘C)`}><CopyIcon size={13} /></button>
                <button className="de-btn" onClick={() => { void handlePasteButton(); }} title={`${L('붙여넣기', 'Paste')} (⌘V)`}><ClipboardPaste size={13} /></button>
                <button
                  className={`de-btn ${painterFmt ? 'active' : ''}`}
                  onClick={toggleFormatPainter}
                  title={L('서식 복사 — 선택의 서식을 복사해 다음 선택에 적용', 'Format Painter — copy formatting, then select text to apply it')}
                ><Paintbrush size={13} /></button>
              </div>
              <div className="de-toolbar-sep" />
              <div className="de-toolbar-group" data-group={L('글꼴', 'Font')}>
                <select className="de-heading-select de-font-family-select" value={fontFamily} onChange={(e) => applyFontFamily(e.target.value)} title={L('글꼴', 'Font family')}>
                  {DOCX_FONT_FAMILIES.map((font) => (
                    <option key={font.label} value={font.value}>{font.label}</option>
                  ))}
                </select>
                <select className="de-heading-select de-font-size-select" value={fontSizePt} onChange={(e) => applyFontSizePt(e.target.value)} title={t('editor.fontSize')}>
                  {DOCX_FONT_SIZE_PT_PRESETS.map((pt) => (
                    <option key={pt} value={String(pt)}>{pt}</option>
                  ))}
                </select>
                <button className="de-btn" onClick={() => exec('bold')} title={t('editor.bold')}><Bold size={13} /></button>
                <button className="de-btn" onClick={() => exec('italic')} title={t('editor.italic')}><Italic size={13} /></button>
                <button className="de-btn" onClick={() => exec('underline')} title={t('editor.underline')}><Underline size={13} /></button>
                <button className="de-btn" onClick={() => exec('strikeThrough')} title={t('editor.strikethrough')}><Strikethrough size={13} /></button>
                <button className="de-btn" onClick={() => exec('superscript')} title={L('위 첨자', 'Superscript')}><Superscript size={13} /></button>
                <button className="de-btn" onClick={() => exec('subscript')} title={L('아래 첨자', 'Subscript')}><Subscript size={13} /></button>
                <button className="de-btn" onClick={() => exec('removeFormat')} title={L('서식 지우기', 'Clear all formatting')}><RemoveFormatting size={13} /></button>
                <div className="de-pop-wrap">
                  <button
                    className={`de-btn de-color-btn2 ${colorMenu === 'text' ? 'active' : ''}`}
                    onClick={() => setColorMenu((m) => (m === 'text' ? null : 'text'))}
                    title={t('editor.textColor')}
                  >
                    <span className="de-color-glyph">A</span>
                    <span className="de-color-bar" style={{ background: textColor }} />
                  </button>
                  {colorMenu === 'text' && (
                    <div className="de-color-pop">
                      <div className="de-color-pop-title">{L('테마 색', 'Theme Colors')}</div>
                      <div className="de-color-row">
                        {WORD_THEME_COLORS.map((c) => (
                          <button key={c} className="de-swatch" style={{ background: c }} title={c} onMouseDown={(e) => e.preventDefault()} onClick={() => pickTextColor(c)} />
                        ))}
                      </div>
                      {buildThemeColorGrid().map((row, i) => (
                        <div key={i} className="de-color-row">
                          {row.map((c, j) => (
                            <button key={j} className="de-swatch" style={{ background: c }} title={c} onMouseDown={(e) => e.preventDefault()} onClick={() => pickTextColor(c)} />
                          ))}
                        </div>
                      ))}
                      <div className="de-color-pop-title">{L('표준 색', 'Standard Colors')}</div>
                      <div className="de-color-row">
                        {WORD_STANDARD_COLORS.map((c) => (
                          <button key={c} className="de-swatch" style={{ background: c }} title={c} onMouseDown={(e) => e.preventDefault()} onClick={() => pickTextColor(c)} />
                        ))}
                      </div>
                      <label className="de-color-more">
                        {L('다른 색…', 'More Colors…')}
                        <input type="color" value={textColor} onChange={(e) => pickTextColor(e.target.value)} />
                      </label>
                    </div>
                  )}
                </div>
                <div className="de-pop-wrap">
                  <button
                    className={`de-btn de-color-btn2 ${colorMenu === 'highlight' ? 'active' : ''}`}
                    onClick={() => setColorMenu((m) => (m === 'highlight' ? null : 'highlight'))}
                    title={t('editor.highlight')}
                  >
                    <Highlighter size={13} />
                    <span className="de-color-bar" style={{ background: highlightColor }} />
                  </button>
                  {colorMenu === 'highlight' && (
                    <div className="de-color-pop">
                      <div className="de-color-pop-title">{L('형광펜 색', 'Highlight Colors')}</div>
                      {[0, 1, 2].map((r) => (
                        <div key={r} className="de-color-row">
                          {WORD_HIGHLIGHT_COLORS.slice(r * 5, r * 5 + 5).map((c) => (
                            <button key={c} className="de-swatch" style={{ background: c }} title={c} onMouseDown={(e) => e.preventDefault()} onClick={() => pickHighlightColor(c)} />
                          ))}
                        </div>
                      ))}
                      <button className="de-color-none" onMouseDown={(e) => e.preventDefault()} onClick={() => pickHighlightColor('transparent')}>
                        {L('색 없음', 'No Color')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="de-toolbar-sep" />
              <div className="de-toolbar-group" data-group={L('스타일', 'Styles')}>
                {DOCX_QUICK_STYLES.map((qs) => (
                  <button
                    key={qs.id}
                    className={`de-btn de-style-chip de-style-chip-${qs.id}`}
                    onClick={() => applyQuickStyle(qs.id)}
                    title={qs.label}
                  >
                    {qs.id === 'quote' ? <Quote size={12} /> : qs.id === 'code' ? <Code2 size={12} /> : null}
                    {qs.label}
                  </button>
                ))}
              </div>
              <div className="de-toolbar-sep" />
              <div className="de-toolbar-group" data-group={L('문단', 'Paragraph')}>
                <button className="de-btn" onClick={() => exec('insertUnorderedList')} title={t('editor.bulletList')}><List size={13} /></button>
                <button className="de-btn" onClick={() => exec('insertOrderedList')} title={t('editor.numberedList')}><ListOrdered size={13} /></button>
                <button className="de-btn" onClick={() => exec('outdent')} title={L('들여쓰기 줄임', 'Decrease indent')}><IndentDecrease size={13} /></button>
                <button className="de-btn" onClick={() => exec('indent')} title={L('들여쓰기 늘림', 'Increase indent')}><IndentIncrease size={13} /></button>
                <button className="de-btn" onClick={() => exec('justifyLeft')} title={t('editor.alignLeft')}><AlignLeft size={13} /></button>
                <button className="de-btn" onClick={() => exec('justifyCenter')} title={t('editor.alignCenter')}><AlignCenter size={13} /></button>
                <button className="de-btn" onClick={() => exec('justifyRight')} title={t('editor.alignRight')}><AlignRight size={13} /></button>
                <button className="de-btn" onClick={() => exec('justifyFull')} title={t('editor.alignJustify')}><AlignJustify size={13} /></button>
                <div className="de-pop-wrap">
                  <button
                    className={`de-btn ${lineSpacingMenu ? 'active' : ''}`}
                    onClick={() => setLineSpacingMenu((v) => !v)}
                    title={L('줄 간격', 'Line spacing')}
                  ><AlignVerticalSpaceAround size={13} /></button>
                  {lineSpacingMenu && (
                    <div className="de-color-pop de-ls-pop">
                      {LINE_SPACING_OPTIONS.map((option) => (
                        <button key={option} className="de-ls-option" onMouseDown={(e) => e.preventDefault()} onClick={() => applyLineSpacing(option)}>
                          {option}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="de-toolbar-sep" />
              <div className="de-toolbar-group" data-group={L('편집', 'Editing')}>
                <button className="de-btn" onClick={handleUndo} title={t('editor.undo')}><Undo2 size={13} /></button>
                <button className="de-btn" onClick={handleRedo} title={t('editor.redo')}><Redo2 size={13} /></button>
                <button className={`de-btn ${findOpen ? 'active' : ''}`} onClick={openFind} title={t('editor.search')}><Search size={13} /> {L('찾기', 'Find')}</button>
              </div>
            </>
          )}

          {activeRibbonTab === 'Insert' && (
            <>
              <div className="de-toolbar-group" data-group={L('표, 미디어', 'Tables & Media')}>
                <div className="de-table-picker-wrap">
                  <button
                    className={`de-btn ${tablePicker ? 'active' : ''}`}
                    onClick={() => { setTableHover({ rows: 0, cols: 0 }); setTablePicker((open) => !open); }}
                    title={t('editor.insertTable')}
                  >
                    <Table size={13} /> Table
                  </button>
                  {tablePicker && (
                    <div className="de-table-picker" onMouseLeave={() => setTableHover({ rows: 0, cols: 0 })}>
                      <div className="de-table-grid">
                        {Array.from({ length: 8 }).map((_, r) => (
                          Array.from({ length: 10 }).map((__, c) => (
                            <span
                              key={`${r}-${c}`}
                              className={`de-table-cell ${r < tableHover.rows && c < tableHover.cols ? 'on' : ''}`}
                              onMouseEnter={() => setTableHover({ rows: r + 1, cols: c + 1 })}
                              onClick={() => { insertTableSize(r + 1, c + 1); setTablePicker(false); }}
                            />
                          ))
                        ))}
                      </div>
                      <div className="de-table-picker-label">
                        {tableHover.rows > 0 ? `${tableHover.rows} × ${tableHover.cols}` : L('표 크기 선택', 'Select table size')}
                      </div>
                    </div>
                  )}
                </div>
                <button className="de-btn" onClick={openLinkDialog} title={L('링크 삽입', 'Insert link')}><Link2 size={13} /> {L('링크', 'Link')}</button>
                <button className="de-btn" onClick={openImagePicker} title={L('이미지 삽입', 'Insert image')}><ImageIcon size={13} /> {L('이미지', 'Image')}</button>
                <button className="de-btn" onClick={insertDocumentBrief} title={L('문서 인텔리전스 브리프 삽입', 'Insert a document intelligence brief')}><FileText size={13} /> {L('브리프', 'Brief')}</button>
              </div>
              <div className="de-toolbar-sep" />
              <div className="de-toolbar-group" data-group={L('표 도구', 'Table Tools')}>
                <button className="de-btn" onClick={insertTableRow} disabled={!inTable} title={L('행 추가', 'Add row')}><Rows3 size={13} /> {L('행+', 'Row+')}</button>
                <button className="de-btn" onClick={insertTableColumn} disabled={!inTable} title={L('열 추가', 'Add column')}><Columns3 size={13} /> {L('열+', 'Col+')}</button>
                <button className="de-btn" onClick={deleteTableRow} disabled={!inTable} title={L('행 삭제', 'Delete row')}><Trash2 size={13} /> {L('행', 'Row')}</button>
                <button className="de-btn" onClick={deleteTableColumn} disabled={!inTable} title={L('열 삭제', 'Delete column')}><Trash2 size={13} /> {L('열', 'Col')}</button>
              </div>
            </>
          )}

          {activeRibbonTab === 'Design' && (
            <>
              <div className="de-toolbar-group" data-group={L('문서 서식', 'Document Formatting')}>
                <Palette size={13} />
                <select className="de-heading-select de-design-select" value={designThemeId} onChange={(e) => setDesignThemeId(e.target.value)} title={selectedTheme.description}>
                  {DOCX_DESIGN_THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.label}</option>)}
                </select>
                <button className="de-btn" onClick={applyDesignTheme} title={L('문서 디자인 테마 적용', 'Apply document design theme')}>{L('적용', 'Apply')}</button>
              </div>
              <div className="de-toolbar-sep" />
              <div className="de-toolbar-group" data-group={L('테마', 'Themes')}>
                <FileStack size={13} />
                <select className="de-heading-select de-template-select" value={templateId} onChange={(e) => setTemplateId(e.target.value)} title={L('문서 템플릿', 'Document template')}>
                  {DOCX_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}
                </select>
                <button className="de-btn" onClick={applyTemplate} title={L('선택한 템플릿으로 문서 교체', 'Replace document with selected template')}>{L('템플릿', 'Template')}</button>
                <select className="de-heading-select de-template-select" value={designPresetPackId} onChange={(e) => setDesignPresetPackId(e.target.value)} title={selectedDesignPreset.description}>
                  {DOCX_DESIGN_PRESET_PACKS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                </select>
                <button className="de-btn" onClick={selectSmartDesignPreset} title={`${L('추천', 'Recommend')}: ${selectedDesignPreset.label}`}><Sparkles size={13} /> {L('스마트', 'Smart')}</button>
                <button className="de-btn de-btn-primary" onClick={applyDesignPreset} title={`${L('프리셋으로 교체', 'Replace document with')} ${selectedDesignPreset.label}`}>{L('프리셋', 'Preset')}</button>
                <button className="de-btn" onClick={polishDocument} title={L('구조·테마·경영 요약 다듬기', 'Polish document structure, theme, and executive snapshot')}><Sparkles size={13} /> {L('다듬기', 'Polish')}</button>
              </div>
            </>
          )}

          {activeRibbonTab === 'Layout' && (
            <>
              <div className="de-toolbar-group" data-group={L('페이지 설정', 'Page Setup')}>
                <select
                  className="de-heading-select"
                  value={pageSetup.margin}
                  onChange={(e) => { setPageSetup((s) => ({ ...s, margin: e.target.value as DocxPageSetup['margin'] })); if (!modified) setModified(true); }}
                  title={L('여백', 'Margins')}
                >
                  {Object.entries(DOCX_PAGE_MARGINS).map(([id, m]) => (
                    <option key={id} value={id}>{L('여백', 'Margins')}: {m.label}</option>
                  ))}
                </select>
                <select
                  className="de-heading-select"
                  value={pageSetup.orientation}
                  onChange={(e) => { setPageSetup((s) => ({ ...s, orientation: e.target.value as DocxPageSetup['orientation'] })); if (!modified) setModified(true); }}
                  title={L('용지 방향', 'Orientation')}
                >
                  <option value="portrait">{L('세로', 'Portrait')}</option>
                  <option value="landscape">{L('가로', 'Landscape')}</option>
                </select>
                <select
                  className="de-heading-select"
                  value={pageSetup.size}
                  onChange={(e) => { setPageSetup((s) => ({ ...s, size: e.target.value as DocxPageSetup['size'] })); if (!modified) setModified(true); }}
                  title={L('용지 크기', 'Paper size')}
                >
                  {Object.entries(DOCX_PAGE_SIZES).map(([id, size]) => (
                    <option key={id} value={id}>{size.label}</option>
                  ))}
                </select>
              </div>
              <div className="de-toolbar-sep" />
              <div className="de-toolbar-group" data-group={L('문단', 'Paragraph')}>
                <button className="de-btn" onClick={() => exec('outdent')} title={L('들여쓰기 줄임', 'Decrease indent')}><IndentDecrease size={13} /> {L('내어쓰기', 'Outdent')}</button>
                <button className="de-btn" onClick={() => exec('indent')} title={L('들여쓰기 늘림', 'Increase indent')}><IndentIncrease size={13} /> {L('들여쓰기', 'Indent')}</button>
              </div>
            </>
          )}

          {activeRibbonTab === 'References' && (
            <div className="de-toolbar-group" data-group={L('목차', 'Table of Contents')}>
              <button className="de-btn" onClick={insertDocumentMap} title={L('제목 기반 문서 맵 삽입', 'Insert a document map from headings')}><ListTree size={13} /> {L('문서 맵', 'Map')}</button>
              <button className="de-btn" onClick={insertCitationPack} title={L('근거 매트릭스·출처 등록부·부록 체크리스트 삽입', 'Insert an evidence matrix, source register, and appendix checklist')}><BookOpenCheck size={13} /> Evidence+</button>
            </div>
          )}

          {activeRibbonTab === 'Review' && (
            <>
              <div className="de-toolbar-group" data-group={L('언어 교정', 'Proofing')}>
                <button className="de-btn" onClick={analyzeDocument} title={L('문서 품질·구조 분석', 'Analyze document quality and structure')}><ClipboardCheck size={13} /> {L('분석', 'Analyze')}</button>
                <button className={`de-btn ${findOpen ? 'active' : ''}`} onClick={openFind} title={t('editor.search')}><Search size={13} /> {L('찾기/바꾸기', 'Find & Replace')}</button>
                <button className="de-btn" onClick={insertQualityReview} title={L('문서 품질 검토 섹션 삽입', 'Insert a document quality review section')}>{L('품질 검토', 'Review')}</button>
                <button className="de-btn" onClick={cleanDocument} title={L('구조·긴 문단·결정 컨트롤 정리', 'Clean document structure, long paragraphs, and decision controls')}><ListChecks size={13} /> Clean+</button>
                <button className="de-btn" onClick={insertActionPlan} title={L('액션 아이템을 계획으로 추출', 'Extract action items into a plan')}><CheckSquare size={13} /> {L('액션', 'Actions')}</button>
              </div>
              <div className="de-toolbar-sep" />
              <div className="de-toolbar-group" data-group={L('AI 문서 팩', 'AI Packs')}>
                <button className="de-btn" onClick={insertReviewPack} title={L('리스크 등록부·편집 검토 팩 삽입', 'Insert a risk register and editorial review pack')}><ShieldCheck size={13} /> Review+</button>
                <button className="de-btn" onClick={insertApprovalPack} title={L('승인 게이트·결정 큐·사인오프 매트릭스 삽입', 'Insert approval gates, decision queue, and sign-off matrix')}><CheckSquare size={13} /> Approval+</button>
                <button className="de-btn" onClick={insertRedlinePack} title={L('편집 레드라인 제안·가드레일 삽입', 'Insert editorial redline suggestions and rewrite guardrails')}><FilePenLine size={13} /> Redline+</button>
                <button className="de-btn" onClick={insertNegotiationPack} title={L('협상 포지션·이슈 매트릭스·폴백 사다리·스크립트 삽입', 'Insert negotiation posture, issue matrix, fallback ladder, and stakeholder script')}><Handshake size={13} /> Negotiation+</button>
                <button className="de-btn" onClick={insertStrategyPack} title={L('내러티브·반론·리라이트·게시 게이트 전략 팩 삽입', 'Insert a document strategy pack with narrative spine, objections, rewrite sprint, and publish gates')}><Sparkles size={13} /> Strategy+</button>
              </div>
            </>
          )}

          {activeRibbonTab === 'View' && (
            <div className="de-toolbar-group" data-group={L('보기', 'Views')}>
              <button
                className={`de-btn ${pageView ? 'active' : ''}`}
                onClick={() => setPageView(true)}
                title={L('페이지 뷰 (A4 종이)', 'Page view (A4 paper)')}
              >
                <PageIcon size={13} /> {L('페이지 뷰', 'Page')}
              </button>
              <button
                className={`de-btn ${!pageView ? 'active' : ''}`}
                onClick={() => setPageView(false)}
                title={L('웹 뷰 (연속 스크롤)', 'Web view (continuous)')}
              >
                <ScrollText size={13} /> {L('웹 뷰', 'Web')}
              </button>
              <div className="de-toolbar-sep" />
              <button className="de-btn" onClick={analyzeDocument} title={L('문서 품질·구조 분석', 'Analyze document quality and structure')}><ClipboardCheck size={13} /> {L('분석', 'Analyze')}</button>
              <span className="de-ribbon-stat">{docStats.words} {L('단어', 'words')}</span>
              <span className="de-ribbon-stat">{docStats.chars} {L('자', 'chars')}</span>
            </div>
          )}
        </div>
      </div>

      {loadError && (
        <div className="de-error-banner">
          <AlertTriangle size={14} />
          <span>{L('이 문서를 읽을 수 없습니다. 편집은 가능하지만 원본 보호를 위해 저장이 차단됩니다.', 'Could not read this document. Editing is allowed, but saving is blocked to protect the original file.')}</span>
        </div>
      )}

      {findOpen && (
        <div className="de-find-bar" role="search">
          <Search size={13} className="de-find-icon" />
          <input
            ref={findInputRef}
            className="de-find-input"
            placeholder={t('editor.searchPlaceholder')}
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              // isComposing: committing a Hangul composition with Enter must not
              // also jump to the next match.
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); gotoFindMatch(e.shiftKey ? -1 : 1); }
              if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
            }}
          />
          <span className="de-find-count">{findState.total > 0 ? `${findState.current}/${findState.total}` : '0/0'}</span>
          <button className="de-btn de-find-nav" onClick={() => gotoFindMatch(-1)} title={t('editor.prevMatch')}><ChevronUp size={13} /></button>
          <button className="de-btn de-find-nav" onClick={() => gotoFindMatch(1)} title={t('editor.nextMatch')}><ChevronDown size={13} /></button>
          <button
            className={`de-btn de-find-case ${findCaseSensitive ? 'active' : ''}`}
            onClick={() => setFindCaseSensitive((v) => !v)}
            title={t('editor.caseSensitive')}
          >Aa</button>
          <div className="de-find-sep" />
          <ReplaceIcon size={13} className="de-find-icon" />
          <input
            className="de-find-input"
            placeholder={t('editor.replacePlaceholder')}
            value={replaceQuery}
            onChange={(e) => setReplaceQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); replaceCurrentMatch(); }
              if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
            }}
          />
          <button className="de-btn de-find-replace" onClick={replaceCurrentMatch} disabled={findState.total === 0} title={t('editor.replaceOne')}>{t('editor.replace')}</button>
          <button className="de-btn de-find-replace" onClick={replaceAllMatches} disabled={findState.total === 0} title={t('editor.replaceAllMatches')}>{L('모두', 'All')}</button>
          <button className="de-btn de-find-close" onClick={closeFind} title={t('editor.close')}><X size={13} /></button>
        </div>
      )}

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleImageFile}
      />

      {/* Editable content */}
      <div className={`de-content ${pageView ? 'de-page-mode' : ''}`} style={{ background: pageView ? undefined : OFFICE_UI.bg }}>
        {linkDraft && (
          <div className="dx-link-dialog" role="dialog">
            <div className="dx-link-title">{L('링크 삽입', 'Insert link')}</div>
            <input
              className="dx-link-input"
              placeholder="https://example.com"
              value={linkDraft.url}
              autoFocus
              onChange={(e) => setLinkDraft((d) => (d ? { ...d, url: e.target.value } : d))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmLink(); } if (e.key === 'Escape') setLinkDraft(null); }}
            />
            <input
              className="dx-link-input"
              placeholder={L('표시 텍스트 (선택)', 'Display text (optional)')}
              value={linkDraft.text}
              onChange={(e) => setLinkDraft((d) => (d ? { ...d, text: e.target.value } : d))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmLink(); } if (e.key === 'Escape') setLinkDraft(null); }}
            />
            <div className="dx-link-actions">
              <button className="de-btn" onClick={() => setLinkDraft(null)}>{t('editor.cancel')}</button>
              <button className="de-btn de-btn-primary" onClick={confirmLink}>{L('삽입', 'Insert')}</button>
            </div>
          </div>
        )}
        {toast && (
          <div className={`dx-save-toast dx-save-toast-${toast.type}`}>{toast.message}</div>
        )}
        <div
          ref={contentRef}
          className={`de-content-editable ${pageView ? 'de-page' : ''} ${painterFmt ? 'de-painter-armed' : ''}`}
          style={{
            ['--de-doc-font' as any]: selectedTheme.fontFamily,
            ['--de-doc-text' as any]: selectedTheme.textColor,
            ['--de-doc-heading' as any]: selectedTheme.headingColor,
            ['--de-doc-accent' as any]: selectedTheme.accentColor,
            ['--de-doc-surface' as any]: selectedTheme.surfaceColor,
            ['--de-doc-page' as any]: selectedTheme.pageColor,
            ...(pageView ? {
              transform: `scale(${zoom})`,
              transformOrigin: 'top center',
              ['--de-page-w' as any]: `${pageDimensions(pageSetup).w}px`,
              ['--de-page-h' as any]: `${pageDimensions(pageSetup).h}px`,
              padding: `${DOCX_PAGE_MARGINS[pageSetup.margin].top}px ${DOCX_PAGE_MARGINS[pageSetup.margin].side}px ${DOCX_PAGE_MARGINS[pageSetup.margin].bottom + 24}px`,
            } : null),
          }}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          onMouseUp={applyFormatPainter}
          spellCheck
        />
      </div>

      {/* Bottom bar */}
      <div className="de-bottom-bar">
        <div className="de-status-left">
          <span className="de-status-pill">DOCX</span>
          <span className={`de-save-state ${modified ? 'is-modified' : ''}`}>
            {modified ? '● Modified' : 'Saved'}
          </span>
          <span className="de-status-name">{filePath.split(/[\\/]/).pop()}</span>
        </div>
        <div className="de-status-center">
          <span>{docStats.words} words</span>
          <span className="de-status-dot" />
          <span>{docStats.chars} chars</span>
          {qualityReport && <span className="de-quality-score">Quality {qualityReport.score}/100</span>}
          {docAssistantStatus && <span className="de-assistant-status">{docAssistantStatus}</span>}
        </div>
        <div className="de-status-right">
          <button
            className="de-zoom-btn"
            onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}
            disabled={!pageView || zoom <= 0.5}
            title={L('축소', 'Zoom out')}
          >−</button>
          <button
            className="de-zoom-level"
            onClick={() => setZoom(1)}
            disabled={!pageView}
            title={L('줌 초기화', 'Reset zoom')}
          >{Math.round(zoom * 100)}%</button>
          <button
            className="de-zoom-btn"
            onClick={() => setZoom((z) => Math.min(2, Math.round((z + 0.1) * 10) / 10))}
            disabled={!pageView || zoom >= 2}
            title={L('확대', 'Zoom in')}
          >＋</button>
        </div>
      </div>
    </div>
  );
}

// docx run classes threaded through the inline parser
interface DocxRunClasses {
  TextRun: any;
  ExternalHyperlink: any;
  ImageRun: any;
}

interface DocxInlineFmt {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  highlight?: string;
  size?: number;
  font?: string;
}

// Merge the inline formatting an element contributes (tag, inline style, font attrs).
function mergeElementFmt(el: Element, inherited: DocxInlineFmt): DocxInlineFmt {
  const tag = el.tagName.toLowerCase();
  const next: DocxInlineFmt = { ...inherited };
  if (tag === 'b' || tag === 'strong') next.bold = true;
  if (tag === 'i' || tag === 'em') next.italic = true;
  if (tag === 'u' || tag === 'ins') next.underline = true;
  if (tag === 's' || tag === 'del' || tag === 'strike') next.strike = true;
  if (tag === 'mark') next.highlight = next.highlight || 'FFFF00';

  const style = (el as HTMLElement).style;
  if (style) {
    const weight = style.fontWeight;
    if (weight === 'bold' || weight === 'bolder' || parseInt(weight, 10) >= 600) next.bold = true;
    if (style.fontStyle === 'italic') next.italic = true;
    const deco = `${style.textDecorationLine || ''} ${style.textDecoration || ''}`;
    if (deco.includes('underline')) next.underline = true;
    if (deco.includes('line-through')) next.strike = true;
    const color = cssColorToDocxHex(style.color);
    if (color) next.color = color;
    const bg = cssColorToDocxHex(style.backgroundColor);
    if (bg) next.highlight = bg;
    const size = cssLengthToHalfPoints(style.fontSize);
    if (size) next.size = size;
    const family = cssFontFamilyToDocx(style.fontFamily);
    if (family) next.font = family;
  }

  if (tag === 'font') {
    const colorAttr = el.getAttribute('color');
    const color = colorAttr ? cssColorToDocxHex(colorAttr) : undefined;
    if (color) next.color = color;
    const sizeAttr = el.getAttribute('size');
    const size = sizeAttr ? fontSizeAttrToHalfPoints(sizeAttr) : undefined;
    if (size) next.size = size;
    const faceAttr = el.getAttribute('face');
    const face = faceAttr ? cssFontFamilyToDocx(faceAttr) : undefined;
    if (face) next.font = face;
  }

  return next;
}

function textRunOptions(text: string, fmt: DocxInlineFmt): any {
  return {
    text,
    bold: fmt.bold,
    italics: fmt.italic,
    underline: fmt.underline ? {} : undefined,
    strike: fmt.strike,
    color: fmt.color,
    size: fmt.size,
    font: fmt.font,
    shading: fmt.highlight ? { fill: fmt.highlight } : undefined,
  };
}

function imageDimensions(img: HTMLImageElement): { width: number; height: number } {
  const attrW = parseInt(img.getAttribute('width') || '', 10);
  const attrH = parseInt(img.getAttribute('height') || '', 10);
  let w = attrW > 0 ? attrW : (img.naturalWidth || 0);
  let h = attrH > 0 ? attrH : (img.naturalHeight || 0);
  if (!w || !h) { w = w || 480; h = h || 320; }
  const maxWidth = 600;
  if (w > maxWidth) {
    h = Math.round(h * (maxWidth / w));
    w = maxWidth;
  }
  return { width: w, height: h };
}

// blob URL → 원본 이미지 바이트. 변환(mammoth) 시 채워지고 export 시 조회된다.
const docxImageStore = new Map<string, { mime: string; bytes: Uint8Array }>();

function buildImageRun(img: HTMLImageElement, ImageRun: any): any | null {
  const src = img.getAttribute('src') || '';
  const { width, height } = imageDimensions(img);

  // 문서에서 로드된 이미지(blob URL) — 스토어의 원본 바이트 사용
  const stored = docxImageStore.get(src);
  if (stored) {
    // Drop formats ImageRun cannot embed rather than writing bytes under a
    // mismatched type (which corrupts the picture in Word).
    if (!isDocxSupportedImageMime(stored.mime)) return null;
    return new ImageRun({
      data: stored.bytes,
      type: docxImageTypeFromMime(stored.mime),
      transformation: { width, height },
    });
  }

  // 사용자가 삽입한 data: URL 이미지
  const parsed = parseDataUrl(src);
  if (!parsed) return null;
  if (!isDocxSupportedImageMime(parsed.mime)) return null;
  let bytes: Uint8Array;
  try {
    const binary = atob(parsed.data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return null;
  }
  return new ImageRun({
    data: bytes,
    type: docxImageTypeFromMime(parsed.mime),
    transformation: { width, height },
  });
}

// Parse the inline children of a block element into docx runs, preserving
// text formatting, colors, highlights, font size, images, and hyperlinks.
function parseInlineRuns(el: Element, classes: DocxRunClasses, baseFmt: DocxInlineFmt = {}): any[] {
  const { TextRun, ExternalHyperlink, ImageRun } = classes;
  const runs: any[] = [];

  const walk = (node: Node, fmt: DocxInlineFmt, target: any[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (text) target.push(new TextRun(textRunOptions(text, fmt)));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();

    if (tag === 'br') { target.push(new TextRun({ break: 1 })); return; }
    if (tag === 'ul' || tag === 'ol') return; // nested lists are handled as separate paragraphs
    if (tag === 'img') {
      const image = buildImageRun(element as HTMLImageElement, ImageRun);
      if (image) target.push(image);
      return;
    }
    if (tag === 'a') {
      const href = (element.getAttribute('href') || '').trim();
      const linkFmt = mergeElementFmt(element, { ...fmt, underline: true, color: '0563C1' });
      const inner: any[] = [];
      for (let i = 0; i < element.childNodes.length; i++) walk(element.childNodes[i], linkFmt, inner);
      if (href && inner.length) {
        target.push(new ExternalHyperlink({ link: href, children: inner }));
      } else {
        inner.forEach((run) => target.push(run));
      }
      return;
    }

    const nextFmt = mergeElementFmt(element, fmt);
    for (let i = 0; i < element.childNodes.length; i++) walk(element.childNodes[i], nextFmt, target);
  };

  for (let i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i], baseFmt, runs);
  if (runs.length === 0) runs.push(new TextRun(textRunOptions(el.textContent || '', baseFmt)));
  return runs;
}

// Helper: get alignment from element style
function getAlignment(el: Element, AlignmentType: any): any {
  const style = (el as HTMLElement).style?.textAlign;
  if (style === 'center') return AlignmentType.CENTER;
  if (style === 'right') return AlignmentType.RIGHT;
  if (style === 'justify') return AlignmentType.BOTH;
  return AlignmentType.LEFT;
}

export default DocxEditor;
