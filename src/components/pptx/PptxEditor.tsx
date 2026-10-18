/**
 * PptxEditor.tsx — Main PPTX slide editor component
 *
 * Modularized: types, parser, export, history, elements, and properties
 * are separated into their own files under src/components/pptx/.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo, useDeferredValue } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, Trash2, Save, SaveAll, Play, ChevronLeft, ChevronRight,
  Type, Square, Circle, Image as ImageIcon, Triangle, Star,
  ArrowRight, Minus, Grid3X3, Undo2, Redo2, Copy,
  FileText, LayoutGrid, Monitor, Eye, EyeOff, Search,
  Download, Upload, RefreshCw, Clock3, Palette, TimerReset,
  Table2, BarChart3, Sparkles, ClipboardCheck,
  AlignLeft, AlignCenter, AlignRight,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import type { PptxEditorProps, Slide, SlideElement, SlideElementType, SlideSize } from './types';
import {
  CANVAS_MAX_W, DEFAULT_SLIDE_SIZE, getSlidePresets,
  uid, createBlankSlide, snapVal, createTableData, FONT_FAMILIES,
} from './types';
import type { TableData } from './types';
import { useTranslation } from '../../i18n';
import { parsePptxFromBase64 } from './pptxParser';
import { exportSlidesToPptx } from './pptxExport';
import { exportSlidesToSlidevMarkdown, getSlideDisplayTitle, parseSlidevMarkdown } from './slidevMarkdown';
import {
  PPTX_DESIGN_THEMES,
  applyDesignThemeToSlide,
  applyDesignThemeToSlides,
  getPptxDesignTheme,
} from './pptxDesignThemes';
import {
  PPTX_DECK_TEMPLATES,
  PPTX_DESIGN_PRESET_PACKS,
  buildPptxDeckTemplate,
  buildPptxDesignPresetDeck,
  getPptxDeckTemplate,
  getPptxDesignPresetPack,
  recommendPptxDesignPresetPacks,
} from './pptxDeckTemplates';
import {
  formatPresentationDuration,
  getPresenterCueCard,
  getPresenterLiveCoach,
  getPresenterPacingInfo,
  getPresenterSlideInfo,
} from './pptxPresentation';
import { buildEditablePptxBarChartElements, buildEditablePptxTableElements } from './pptxSmartElements';
import { buildAgentLayoutSlide, isAgentLayoutSlide, AGENT_LAYOUT_IDS } from './pptxAgentLayouts';
import type { AgentLayoutId, AgentLayoutMetric, AgentLayoutItem } from './pptxAgentLayouts';
import { insertTableRow, removeTableRow, insertTableCol, removeTableCol } from './pptxTableEdit';
import { normalizeSlideTransition, slideTransitionClass, PPTX_TRANSITION_TYPES } from './pptxTransitions';
import {
  DEFAULT_ANIMATION_MS, animationClass, animationStepCount, buildAnimationSteps,
  elementsAnimatingAtStep, isElementRevealed,
} from './pptxAnimations';
import type { SlideTransition } from './types';
import { auditDeckDesign, polishDeckDesign, polishSlideDesign } from './pptxDesigner';
import {
  analyzePresentationRehearsal,
  applyRehearsalTiming,
  enrichDeckSpeakerNotes,
  formatRehearsalDuration,
  insertPresentationAudienceDrill,
  insertPresentationAgenda,
  insertPresentationBoardPack,
  insertPresentationHandout,
  insertPresentationInvestorPack,
  insertPresentationQAPack,
  insertPresentationRunOfShow,
  insertPresentationScriptPack,
} from './pptxRehearsal';
import { useSlideHistory } from './useSlideHistory';
import {
  computeResizeGeometry, shouldStartUndoGroup, alignBoxes, distributeBoxes,
  computeDragSnap, computeRotation, type ResizeDir, type AlignAxis, type Box,
} from './pptxEditorGeometry';
import { renderSlideElement, renderThumbElement } from './SlideElements';
import { PropertiesPanel } from './PropertiesPanel';
import { focusOutsideEditor } from '../editorKeyScope';
import './PptxEditor.css';

type WorkbenchMode = 'design' | 'markdown' | 'overview';
// 좁은 인앱 화면에서 PowerPoint식 12탭은 과했다 — 핵심 4탭으로 축소.
// Save/보기 전환은 리본 오른쪽 상시 컨트롤, 문서 팩 삽입류는 Insert의 Packs 메뉴로 통합.
type PptxRibbonTab = 'Home' | 'Insert' | 'Design' | 'Present';

const PPTX_RIBBON_TABS: PptxRibbonTab[] = ['Home', 'Insert', 'Design', 'Present'];

// MS365-style fixed Office palette: the editor chrome stays light with the
// PowerPoint orange-red accent regardless of the terminal theme.
const OFFICE_UI = { bg: '#ffffff', text: '#242424', accent: '#C43E1C' };

// Smart-guide snap threshold in slide-percentage units (~0.8%).
const SMART_SNAP_PCT = 0.8;

// ─── Helper: slide background style ──────────────────────────

function slideBgStyle(slide: Slide): React.CSSProperties {
  const s: React.CSSProperties = { background: slide.bgColor };
  if (slide.bgImage) {
    s.backgroundImage = `url(${slide.bgImage})`;
    s.backgroundSize = 'cover';
    s.backgroundPosition = 'center';
  }
  return s;
}

// Windows paths arrive with backslashes — split('/') alone leaves the full path.
function fileBaseName(p: string): string {
  return p.split(/[\\/]/).pop() || '';
}

// When the loaded deck has content this editor can't round-trip (parse failure
// or unsupported charts/SmartArt/animations), saving must go to a sibling copy
// instead of overwriting the original in place.
function editedCopyPath(p: string): string {
  if (/\.pptx$/i.test(p)) return p.replace(/\.pptx$/i, '.edited.pptx');
  return `${p}.edited.pptx`;
}

// Written to the OS clipboard on internal element/slide copy so paste can tell
// "the last thing copied was a BBARIT element" apart from a newer OS image.
const PPTX_CLIPBOARD_MARKER = 'bbarit-pptx:internal-clipboard';

// Memoized thumbnail body: slides update immutably, so untouched slides keep
// their reference and skip re-rendering while another slide is being dragged.
const SlideThumbPreview = React.memo(function SlideThumbPreview({ slide, aspectRatio, className }: {
  slide: Slide; aspectRatio: number; className: string;
}) {
  return (
    <div className={className} style={{ ...slideBgStyle(slide), aspectRatio: `${aspectRatio}` }}>
      <div className="px-thumb-preview-inner">
        {slide.elements.map((el) => renderThumbElement(el))}
      </div>
    </div>
  );
});

// ─── Component ───────────────────────────────────────────────

export function PptxEditor({ filePath, pptxData, style, onSaved, onModifiedChange }: PptxEditorProps) {
  const { t } = useTranslation();
  // UI copy is standardized to English across all three editors.
  const L = useCallback((_ko: string, en: string) => en, []);
  const SLIDE_PRESETS = useMemo(() => getSlidePresets(t), [t]);
  const [slides, setSlides] = useState<Slide[]>([createBlankSlide()]);
  const [slideSize, setSlideSize] = useState<SlideSize>({ ...DEFAULT_SLIDE_SIZE });
  const [currentSlideIdx, setCurrentSlideIdx] = useState(0);
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
  // Single-selection compatibility layer: null whenever 0 or 2+ elements are
  // selected, so the detail panel / resize handles / single-target shortcuts
  // stay single-select while group ops read selectedElementIds.
  const selectedElementId = selectedElementIds.length === 1 ? selectedElementIds[0] : null;
  const setSelectedElementId = useCallback((id: string | null) => {
    setSelectedElementIds(id ? [id] : []);
  }, []);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editingTableCell, setEditingTableCell] = useState<{ elId: string; row: number; col: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [activeGuides, setActiveGuides] = useState<{ vLines: number[]; hLines: number[] }>({ vLines: [], hLines: [] });
  const [presenting, setPresenting] = useState(false);
  const [presenterMode, setPresenterMode] = useState(false);
  const [presentationEditing, setPresentationEditing] = useState(false);
  const [presentationBlackout, setPresentationBlackout] = useState(false);
  // Click-step position inside the current slide's entrance animations.
  const [presentStep, setPresentStep] = useState(0);
  const [animNowIds, setAnimNowIds] = useState<Set<string>>(new Set());
  const animClearTimerRef = useRef<number | null>(null);
  const backToFullRef = useRef(false);
  const [presentationStartedAt, setPresentationStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [saving, setSaving] = useState(false);
  const [modified, setModified] = useState(false);
  // Set when the parser flags content it can't round-trip (parseError or
  // unsupported graphics/animations) so save never overwrites the original.
  const [sourceGuarded, setSourceGuarded] = useState(false);
  const [saveToast, setSaveToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [presetIdx, setPresetIdx] = useState(0);
  const [designThemeId, setDesignThemeId] = useState(PPTX_DESIGN_THEMES[0].id);
  const [deckTemplateId, setDeckTemplateId] = useState(PPTX_DECK_TEMPLATES[0].id);
  const [designPresetPackId, setDesignPresetPackId] = useState(PPTX_DESIGN_PRESET_PACKS[0].id);
  const [workbenchMode, setWorkbenchMode] = useState<WorkbenchMode>('design');
  const [activeRibbonTab, setActiveRibbonTab] = useState<PptxRibbonTab>('Home');
  const [markdownDraft, setMarkdownDraft] = useState(() => exportSlidesToSlidevMarkdown([createBlankSlide()]));
  const [markdownStatus, setMarkdownStatus] = useState('');
  const [designerStatus, setDesignerStatus] = useState('');
  const [rehearsalStatus, setRehearsalStatus] = useState('');
  const [coachOpen, setCoachOpen] = useState(false);
  const [overviewQuery, setOverviewQuery] = useState('');
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(160);
  const [rightPanelWidth, setRightPanelWidth] = useState(420);
  const [dragSlideIdx, setDragSlideIdx] = useState<number | null>(null);
  const [slideDropIdx, setSlideDropIdx] = useState<number | null>(null);
  const [slideDropPos, setSlideDropPos] = useState<'before' | 'after'>('before');
  const copiedElementRef = useRef<SlideElement[] | null>(null);
  const copiedSlideRef = useRef<Slide | null>(null);
  const sidebarResizeRef = useRef<{ side: 'left' | 'right'; startX: number; startWidth: number } | null>(null);

  // Refs
  const dragRef = useRef<{ elId: string; startX: number; startY: number; origX: number; origY: number; recorded: boolean; group: { id: string; origX: number; origY: number }[] } | null>(null);
  const resizeRef = useRef<{ elId: string; dir: ResizeDir; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number; recorded: boolean } | null>(null);
  const rotateRef = useRef<{ elId: string; cx: number; cy: number; recorded: boolean } | null>(null);
  const marqueeRef = useRef<{ startX: number; startY: number; additive: boolean; base: string[] } | null>(null);
  // Tracks the last-committed clean deck so "modified" can be derived without
  // instrumenting every mutation; set on load and on successful save.
  const cleanSlidesRef = useRef<Slide[]>(slides);
  const lastModifiedRef = useRef(false);
  const parsedDataRef = useRef<string | null>(null);
  const undoGuardRef = useRef<{ key: string; time: number } | null>(null);
  const saveToastTimerRef = useRef<number | null>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const presentationRef = useRef<HTMLDivElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const editorRootRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: CANVAS_MAX_W, h: CANVAS_MAX_W / (16 / 9) });

  const readImageDataUrl = useCallback(async (path: string): Promise<string | null> => {
    const cleaned = String(path || '').trim();
    if (!cleaned) return null;
    try {
      const base64 = await invoke<string>('read_file_base64', { path: cleaned });
      const ext = cleaned.split('.').pop()?.toLowerCase() || '';
      const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
        svg: 'image/svg+xml',
      };
      const mime = mimeMap[ext] || 'image/png';
      return `data:${mime};base64,${base64}`;
    } catch (err) {
      console.error('[PptxEditor] Failed to read image:', err);
      return null;
    }
  }, []);

  const pickImageDataUrl = useCallback(async (): Promise<string | null> => {
    try {
      const selected = await dialogOpen({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }],
      });
      if (!selected) return null;
      const path = typeof selected === 'string' ? selected : (selected as any).path ?? String(selected);
      return await readImageDataUrl(path);
    } catch (err) {
      console.error('[PptxEditor] Image picker cancelled or unavailable:', err);
      return null;
    }
  }, [readImageDataUrl]);

  // Undo/Redo
  const slidesRef = useRef(slides);
  slidesRef.current = slides;
  const { canUndo, canRedo, recordForUndo, undo, redo } = useSlideHistory(slidesRef);

  const UNDO_GROUP_MS = 700;
  // Record undo history but coalesce rapid changes to the same key (slider drag,
  // typing) into a single snapshot so a burst is undone in one step.
  const recordForUndoGrouped = useCallback((key: string) => {
    const now = Date.now();
    if (shouldStartUndoGroup(undoGuardRef.current, key, now, UNDO_GROUP_MS)) {
      recordForUndo();
    }
    undoGuardRef.current = { key, time: now };
  }, [recordForUndo]);

  // Derive "modified" from whether the deck reference diverged from the last
  // clean snapshot, and notify the parent only when the flag actually flips.
  useEffect(() => {
    const isModified = slides !== cleanSlidesRef.current;
    if (isModified !== lastModifiedRef.current) {
      lastModifiedRef.current = isModified;
      setModified(isModified);
      onModifiedChange?.(isModified);
    }
  }, [slides, onModifiedChange]);

  // ─── Canvas sizing ──────────────────────────────────────────

  useEffect(() => {
    const el = canvasAreaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      const padding = 32;
      const availW = rect.width - padding * 2;
      const availH = rect.height - padding * 2;
      const ar = slideSize.aspectRatio;
      let w = availW;
      let h = w / ar;
      if (h > availH) { h = availH; w = h * ar; }
      w = Math.min(w, CANVAS_MAX_W);
      h = w / ar;
      setCanvasSize({ w: Math.round(w), h: Math.round(h) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [slideSize.aspectRatio]);

  // ─── Parse PPTX on load ─────────────────────────────────────

  useEffect(() => {
    if (!pptxData) return;
    // Only re-parse when the incoming data actually changes (a new/reopened
    // file), never when internal edits trigger a re-render.
    if (parsedDataRef.current === pptxData) return;
    parsedDataRef.current = pptxData;
    parsePptxFromBase64(pptxData).then((result) => {
      const { slides: parsed, slideSize: sz } = result;
      // Flags are read defensively via cast — the parser sets them at runtime
      // regardless of whether the shared ParsedPptx type lists them yet.
      const meta = result as { parseError?: boolean; hasUnsupportedContent?: boolean };
      setSlides(parsed);
      cleanSlidesRef.current = parsed;
      setSlideSize(sz);
      setCurrentSlideIdx(0);
      setSelectedElementId(null);
      setEditingTextId(null);
      setSourceGuarded(Boolean(meta.parseError || meta.hasUnsupportedContent));
      setMarkdownDraft(exportSlidesToSlidevMarkdown(parsed));
    }).catch((err) => {
      console.error('[PptxEditor] Parse error:', err);
    });
  }, [pptxData]);

  const currentSlide = slides[currentSlideIdx] || slides[0];
  const selectedDesignTheme = useMemo(() => getPptxDesignTheme(designThemeId), [designThemeId]);
  const selectedSlidePreset = useMemo(() => (
    SLIDE_PRESETS[presetIdx] || SLIDE_PRESETS[0]
  ), [SLIDE_PRESETS, presetIdx]);
  const slidePresetPreview = useMemo<Slide>(() => applyDesignThemeToSlide({
    id: 'slide-preset-preview',
    title: selectedSlidePreset.label,
    bgColor: selectedDesignTheme.bgColor,
    bgImage: undefined,
    notes: '',
    hidden: false,
    transition: { type: 'none', durationMs: 450, advanceAfterSec: 0 },
    elements: selectedSlidePreset.build(),
  }, selectedDesignTheme), [selectedDesignTheme, selectedSlidePreset]);
  const selectedDeckTemplate = useMemo(() => getPptxDeckTemplate(deckTemplateId), [deckTemplateId]);
  const selectedDesignPresetPack = useMemo(() => getPptxDesignPresetPack(designPresetPackId), [designPresetPackId]);
  const selectedDesignPresetPreviewSlides = useMemo(() => (
    buildPptxDesignPresetDeck(designPresetPackId).slice(0, 3)
  ), [designPresetPackId]);
  const selectedDeckTemplatePreviewSlides = useMemo(() => (
    buildPptxDeckTemplate(deckTemplateId, selectedDesignTheme).slice(0, 3)
  ), [deckTemplateId, selectedDesignTheme]);
  const selectedThemePreviewSlide = useMemo(() => (
    currentSlide ? applyDesignThemeToSlide(currentSlide, selectedDesignTheme) : slidePresetPreview
  ), [currentSlide, selectedDesignTheme, slidePresetPreview]);
  // Deck-wide analysis (audit / rehearsal / preset recommendation) only feeds
  // status badges and side panels — run it on a deferred snapshot so drag
  // mousemoves and typing don't pay O(deck) analysis per frame.
  const deferredSlides = useDeferredValue(slides);
  const smartPresetRecommendations = useMemo(() => recommendPptxDesignPresetPacks(deferredSlides, 3), [deferredSlides]);
  const smartPreset = smartPresetRecommendations[0]?.preset || selectedDesignPresetPack;
  const visibleSlideIndexes = useMemo(() => {
    const visible = slides.map((slide, idx) => slide.hidden ? -1 : idx).filter((idx) => idx >= 0);
    return visible.length ? visible : slides.map((_, idx) => idx);
  }, [slides]);
  const hiddenSlideCount = slides.length - visibleSlideIndexes.length;
  const slideTitle = useCallback((slide: Slide, idx: number) => getSlideDisplayTitle(slide, idx), []);
  const filteredSlideEntries = useMemo(() => {
    const query = overviewQuery.trim().toLowerCase();
    return slides
      .map((slide, idx) => ({ slide, idx, title: slideTitle(slide, idx) }))
      .filter(({ slide, title }) => {
        if (!query) return true;
        return title.toLowerCase().includes(query) || (slide.notes || '').toLowerCase().includes(query);
      });
  }, [overviewQuery, slideTitle, slides]);
  const deckStats = useMemo(() => ({
    total: slides.length,
    visible: visibleSlideIndexes.length,
    hidden: hiddenSlideCount,
    notes: slides.filter((slide) => slide.notes?.trim()).length,
  }), [hiddenSlideCount, slides, visibleSlideIndexes.length]);
  const deckDesignAudit = useMemo(() => auditDeckDesign(deferredSlides), [deferredSlides]);
  const rehearsalReport = useMemo(
    () => analyzePresentationRehearsal(deferredSlides, slideTitle),
    [slideTitle, deferredSlides],
  );
  const presenterInfo = useMemo(
    () => getPresenterSlideInfo(slides, currentSlideIdx, visibleSlideIndexes, slideTitle),
    [currentSlideIdx, slideTitle, slides, visibleSlideIndexes],
  );
  const presenterPacingInfo = useMemo(
    () => getPresenterPacingInfo(rehearsalReport, currentSlideIdx, presentationStartedAt ? now - presentationStartedAt : 0),
    [currentSlideIdx, now, presentationStartedAt, rehearsalReport],
  );
  const presenterLiveCoach = useMemo(
    () => getPresenterLiveCoach(
      rehearsalReport,
      currentSlideIdx,
      presentationStartedAt ? now - presentationStartedAt : 0,
      visibleSlideIndexes,
    ),
    [currentSlideIdx, now, presentationStartedAt, rehearsalReport, visibleSlideIndexes],
  );
  const presenterCueCard = useMemo(() => {
    const slideReport = rehearsalReport.slideReports.find((report) => report.slideIndex === currentSlideIdx) || null;
    return getPresenterCueCard(slides[currentSlideIdx], slideReport, presenterInfo.nextTitle);
  }, [currentSlideIdx, presenterInfo.nextTitle, rehearsalReport.slideReports, slides]);
  const elapsedPresentationTime = presentationStartedAt ? formatPresentationDuration(now - presentationStartedAt) : '0:00';
  const currentTransition = normalizeSlideTransition(currentSlide?.transition);
  const nextVisibleSlideIdx = useCallback((direction: 1 | -1) => {
    const currentVisiblePos = visibleSlideIndexes.indexOf(currentSlideIdx);
    if (currentVisiblePos < 0) {
      const candidate = visibleSlideIndexes.find((idx) => direction > 0 ? idx > currentSlideIdx : idx < currentSlideIdx);
      return candidate ?? currentSlideIdx;
    }
    const next = visibleSlideIndexes[currentVisiblePos + direction];
    return typeof next === 'number' ? next : currentSlideIdx;
  }, [currentSlideIdx, visibleSlideIndexes]);
  // D-PPT-FS: 발표 모드 전체화면은 element.requestFullscreen이 아니라 Tauri 창
  // 전체화면(setFullscreen)을 쓴다. WebView2에서 요소 fullscreen은 OS 창 크기를
  // 못 바꿔 "전체화면이 안 된다"로 보였고, Esc를 브라우저가 먼저 소비해 발표가
  // 안 닫히는 원인이기도 했다. 비용: Tauri 밖(순수 브라우저)에선 동작하지 않으므로
  // catch에서 기존 DOM fullscreen으로 폴백한다(탈출구). 발표 전 창이 이미
  // 전체화면이었다면 종료 시 그대로 유지한다(prevWindowFullscreenRef).
  const prevWindowFullscreenRef = useRef<boolean | null>(null);

  const requestPresentationFullscreen = useCallback(() => {
    void (async () => {
      try {
        const win = getCurrentWindow();
        const already = await win.isFullscreen();
        if (prevWindowFullscreenRef.current === null) prevWindowFullscreenRef.current = already;
        if (!already) await win.setFullscreen(true);
        return;
      } catch {
        // Tauri 밖 — DOM fullscreen 폴백
      }
      if (typeof document === 'undefined' || document.fullscreenElement) return;
      const target = presentationRef.current || document.documentElement;
      void target.requestFullscreen?.().catch((err) => {
        console.warn('[PptxEditor] Fullscreen request failed:', err);
      });
    })();
  }, []);

  const exitPresentationFullscreen = useCallback(() => {
    void (async () => {
      const restore = prevWindowFullscreenRef.current;
      prevWindowFullscreenRef.current = null;
      try {
        const win = getCurrentWindow();
        if (restore === false && await win.isFullscreen()) await win.setFullscreen(false);
        return;
      } catch {
        // Tauri 밖 — DOM fullscreen 폴백
      }
      if (typeof document === 'undefined' || !document.fullscreenElement) return;
      void document.exitFullscreen?.().catch((err) => {
        console.warn('[PptxEditor] Fullscreen exit failed:', err);
      });
    })();
  }, []);

  const togglePresentationFullscreen = useCallback(() => {
    void (async () => {
      try {
        const win = getCurrentWindow();
        const fs = await win.isFullscreen();
        if (prevWindowFullscreenRef.current === null) prevWindowFullscreenRef.current = fs;
        await win.setFullscreen(!fs);
        return;
      } catch {
        // Tauri 밖 — DOM fullscreen 폴백
      }
      if (typeof document === 'undefined') return;
      if (document.fullscreenElement) {
        void document.exitFullscreen?.().catch(() => {});
      } else {
        const target = presentationRef.current || document.documentElement;
        void target.requestFullscreen?.().catch(() => {});
      }
    })();
  }, []);

  const stopPresentation = useCallback(() => {
    setPresenting(false);
    setPresentationEditing(false);
    setPresentationBlackout(false);
    exitPresentationFullscreen();
  }, [exitPresentationFullscreen]);

  const startPresentation = useCallback((withPresenter = false) => {
    const firstVisible = visibleSlideIndexes.includes(currentSlideIdx) ? currentSlideIdx : visibleSlideIndexes[0] ?? 0;
    setCurrentSlideIdx(firstVisible);
    setPresenterMode(withPresenter);
    setPresentationEditing(false);
    setPresentationBlackout(false);
    setPresentationStartedAt(Date.now());
    setNow(Date.now());
    setPresenting(true);
    requestPresentationFullscreen();
  }, [currentSlideIdx, requestPresentationFullscreen, visibleSlideIndexes]);

  // ─── Slide operations ───────────────────────────────────────

  const addSlideFromPreset = useCallback((presetIndex: number) => {
    recordForUndo();
    const preset = SLIDE_PRESETS[presetIndex] || SLIDE_PRESETS[0];
    const newSlide = applyDesignThemeToSlide({
      id: uid(),
      title: preset.label,
      bgColor: selectedDesignTheme.bgColor,
      bgImage: undefined,
      notes: '',
      hidden: false,
      transition: { type: 'none', durationMs: 450, advanceAfterSec: 0 },
      elements: preset.build(),
    }, selectedDesignTheme);
    setSlides((prev) => {
      const next = [...prev];
      next.splice(currentSlideIdx + 1, 0, newSlide);
      return next;
    });
    setCurrentSlideIdx((prev) => prev + 1);
    setSelectedElementId(null);
    setEditingTextId(null);
    setPresetIdx(presetIndex);
  }, [currentSlideIdx, recordForUndo, selectedDesignTheme, SLIDE_PRESETS]);

  const addSlide = useCallback(() => {
    addSlideFromPreset(presetIdx);
  }, [addSlideFromPreset, presetIdx]);

  const deleteSlideAt = useCallback((targetIdx: number) => {
    if (slides.length <= 1) return;
    if (targetIdx < 0 || targetIdx >= slides.length) return;
    recordForUndo();
    setSlides((prev) => prev.filter((_, i) => i !== targetIdx));
    setCurrentSlideIdx((prev) => {
      if (prev === targetIdx) return Math.max(0, Math.min(targetIdx, slides.length - 2));
      if (prev > targetIdx) return prev - 1;
      return Math.min(prev, slides.length - 2);
    });
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [recordForUndo, slides.length]);

  const deleteSlide = useCallback(() => {
    deleteSlideAt(currentSlideIdx);
  }, [currentSlideIdx, deleteSlideAt]);

  const duplicateSlide = useCallback(() => {
    const current = slides[currentSlideIdx];
    if (!current) return;
    recordForUndo();
    const clone: Slide = {
      ...JSON.parse(JSON.stringify(current)),
      id: uid(),
      elements: current.elements.map((el) => ({ ...JSON.parse(JSON.stringify(el)), id: uid() })),
    };
    setSlides((prev) => {
      const next = [...prev];
      next.splice(currentSlideIdx + 1, 0, clone);
      return next;
    });
    setCurrentSlideIdx((prev) => prev + 1);
    setSelectedElementId(null);
  }, [currentSlideIdx, recordForUndo, slides]);

  const moveSlide = useCallback((fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= slides.length || toIdx >= slides.length) return;
    recordForUndo();
    setSlides((prev) => {
      const next = [...prev];
      const [slide] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, slide);
      return next;
    });
    setCurrentSlideIdx(toIdx);
  }, [recordForUndo, slides.length]);

  const copyCurrentSlide = useCallback(() => {
    const current = slides[currentSlideIdx];
    if (!current) return;
    copiedSlideRef.current = JSON.parse(JSON.stringify(current));
    navigator.clipboard?.writeText(PPTX_CLIPBOARD_MARKER).catch(() => {});
    setDesignerStatus(`Slide ${currentSlideIdx + 1} copied`);
  }, [currentSlideIdx, slides]);

  const pasteCopiedSlide = useCallback(() => {
    const copied = copiedSlideRef.current;
    if (!copied) return;
    recordForUndo();
    const clone: Slide = {
      ...JSON.parse(JSON.stringify(copied)),
      id: uid(),
      elements: copied.elements.map((el) => ({ ...JSON.parse(JSON.stringify(el)), id: uid() })),
    };
    setSlides((prev) => {
      const next = [...prev];
      next.splice(currentSlideIdx + 1, 0, clone);
      return next;
    });
    setCurrentSlideIdx((prev) => prev + 1);
    setSelectedElementId(null);
    setEditingTextId(null);
    setDesignerStatus(`Slide pasted after ${currentSlideIdx + 1}`);
  }, [currentSlideIdx, recordForUndo]);

  const updateSlideMeta = useCallback((idx: number, updates: Partial<Slide>) => {
    recordForUndo();
    setSlides((prev) => prev.map((slide, slideIdx) => slideIdx === idx ? { ...slide, ...updates } : slide));
  }, [recordForUndo]);

  const rebuildMarkdownDraft = useCallback(() => {
    setMarkdownDraft(exportSlidesToSlidevMarkdown(slides));
    setMarkdownStatus('Markdown refreshed from the current deck.');
  }, [slides]);

  const applyMarkdownDraft = useCallback(() => {
    const parsed = parseSlidevMarkdown(markdownDraft);
    if (!parsed.length) {
      setMarkdownStatus('No slides found in markdown.');
      return;
    }
    recordForUndo();
    setSlides(parsed);
    setCurrentSlideIdx(0);
    setSelectedElementId(null);
    setEditingTextId(null);
    setMarkdownStatus(`Imported ${parsed.length} markdown slide${parsed.length === 1 ? '' : 's'}.`);
    setWorkbenchMode('design');
  }, [markdownDraft, recordForUndo]);

  const importMarkdownFile = useCallback(() => {
    void (async () => {
      try {
        const selected = await dialogOpen({
          multiple: false,
          filters: [{ name: 'Markdown', extensions: ['md', 'mdx', 'txt'] }],
        });
        if (!selected) return;
        const path = typeof selected === 'string' ? selected : (selected as any).path ?? String(selected);
        const content = await invoke<string>('read_file', { path });
        setMarkdownDraft(content);
        setMarkdownStatus(`Loaded ${fileBaseName(path) || 'markdown file'}.`);
        setWorkbenchMode('markdown');
      } catch (err) {
        console.error('[PptxEditor] Markdown import failed:', err);
        setMarkdownStatus('Markdown import failed.');
      }
    })();
  }, []);

  const exportMarkdownFile = useCallback(() => {
    void (async () => {
      try {
        const content = markdownDraft.trim() ? markdownDraft : exportSlidesToSlidevMarkdown(slides);
        const defaultName = (fileBaseName(filePath) || 'presentation.pptx').replace(/\.[^.]+$/, '.md');
        const targetPath = await invoke<string | null>('save_file_dialog', {
          defaultName,
          filters: [['Markdown', ['md']]],
        });
        if (!targetPath) return;
        await invoke('write_file', { path: targetPath, content });
        setMarkdownStatus(`Exported ${fileBaseName(targetPath) || 'markdown file'}.`);
      } catch (err) {
        console.error('[PptxEditor] Markdown export failed:', err);
        setMarkdownStatus('Markdown export failed.');
      }
    })();
  }, [filePath, markdownDraft, slides]);

  const goToSlide = useCallback((idx: number) => {
    if (idx >= 0 && idx < slides.length) {
      setCurrentSlideIdx(idx);
      setSelectedElementId(null);
      setEditingTextId(null);
    }
  }, [slides.length]);

  const goToPresentationSlide = useCallback((direction: 1 | -1) => {
    // Entrance animations advance one click-step at a time before the deck
    // moves on (PowerPoint behavior). Going back rewinds steps first too.
    if (presenting && !presentationEditing) {
      const slide = slides[currentSlideIdx];
      const steps = slide ? buildAnimationSteps(slide) : [];
      if (direction === 1 && presentStep < steps.length) {
        const next = presentStep + 1;
        setPresentStep(next);
        setAnimNowIds(elementsAnimatingAtStep(steps, next));
        if (animClearTimerRef.current != null) window.clearTimeout(animClearTimerRef.current);
        const stepIds = new Set(steps[next - 1] ?? []);
        const maxMs = Math.max(DEFAULT_ANIMATION_MS, ...slide.elements
          .filter((e) => e.animation && stepIds.has(e.id))
          .map((e) => e.animation?.durationMs ?? DEFAULT_ANIMATION_MS));
        animClearTimerRef.current = window.setTimeout(() => setAnimNowIds(new Set()), maxMs + 80);
        return;
      }
      if (direction === -1 && presentStep > 0) {
        setPresentStep(presentStep - 1);
        setAnimNowIds(new Set());
        return;
      }
      if (direction === -1) backToFullRef.current = true;
    }
    goToSlide(nextVisibleSlideIdx(direction));
  }, [goToSlide, nextVisibleSlideIdx, presenting, presentationEditing, slides, currentSlideIdx, presentStep]);

  // Entering a slide starts before its animations; stepping BACK into a slide
  // shows it fully revealed (PowerPoint behavior).
  useEffect(() => {
    if (!presenting) { setPresentStep(0); setAnimNowIds(new Set()); return; }
    if (backToFullRef.current) {
      backToFullRef.current = false;
      const slide = slides[currentSlideIdx];
      setPresentStep(slide ? animationStepCount(slide) : 0);
    } else {
      setPresentStep(0);
    }
    setAnimNowIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSlideIdx, presenting]);

  useEffect(() => {
    if (!presenting) return;
    const transition = normalizeSlideTransition(slides[currentSlideIdx]?.transition);
    if (!transition.advanceAfterSec) return;
    const timer = window.setTimeout(() => {
      const next = nextVisibleSlideIdx(1);
      if (next !== currentSlideIdx) goToSlide(next);
    }, transition.advanceAfterSec * 1000);
    return () => window.clearTimeout(timer);
  }, [currentSlideIdx, goToSlide, nextVisibleSlideIdx, presenting, slides]);

  const updateCurrentSlide = useCallback((updater: (s: Slide) => Slide) => {
    setSlides((prev) => prev.map((s, i) => i === currentSlideIdx ? updater(s) : s));
  }, [currentSlideIdx]);

  const applySelectedThemeToCurrentSlide = useCallback(() => {
    recordForUndo();
    updateCurrentSlide((slide) => applyDesignThemeToSlide(slide, selectedDesignTheme));
    setDesignerStatus(`${selectedDesignTheme.label} applied to slide ${currentSlideIdx + 1}`);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [currentSlideIdx, recordForUndo, selectedDesignTheme, updateCurrentSlide]);

  const changeCurrentSlideDesignTheme = useCallback((themeId: string) => {
    const theme = getPptxDesignTheme(themeId);
    setDesignThemeId(theme.id);
    recordForUndo();
    updateCurrentSlide((slide) => applyDesignThemeToSlide(slide, theme));
    setDesignerStatus(`${theme.label} applied to slide ${currentSlideIdx + 1}`);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [currentSlideIdx, recordForUndo, updateCurrentSlide]);

  const applySelectedThemeToDeck = useCallback(() => {
    recordForUndo();
    setSlides((prev) => applyDesignThemeToSlides(prev, selectedDesignTheme));
  }, [recordForUndo, selectedDesignTheme]);

  const polishCurrentSlide = useCallback(() => {
    recordForUndo();
    const nextSlides = slides.map((slide, idx) => (
      idx === currentSlideIdx ? polishSlideDesign(slide, selectedDesignTheme, idx, slides.length) : slide
    ));
    const audit = auditDeckDesign(nextSlides);
    setSlides(nextSlides);
    setDesignerStatus(`Design score ${audit.score}/100 · slide polished`);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [currentSlideIdx, recordForUndo, selectedDesignTheme, slides]);

  const polishDeck = useCallback(() => {
    recordForUndo();
    const nextSlides = polishDeckDesign(slides, selectedDesignTheme);
    const audit = auditDeckDesign(nextSlides);
    setSlides(nextSlides);
    setDesignerStatus(`Design score ${audit.score}/100 · deck polished`);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [recordForUndo, selectedDesignTheme, slides]);

  const generateSpeakerNotes = useCallback(() => {
    recordForUndo();
    const nextSlides = enrichDeckSpeakerNotes(slides, slideTitle);
    const nextReport = analyzePresentationRehearsal(nextSlides, slideTitle);
    setSlides(nextSlides);
    setRehearsalStatus(`Rehearsal ${nextReport.score}/100 · notes generated`);
    setCoachOpen(true);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [recordForUndo, slideTitle, slides]);

  const applyDeckRehearsalTiming = useCallback(() => {
    recordForUndo();
    const nextSlides = applyRehearsalTiming(slides, slideTitle);
    const nextReport = analyzePresentationRehearsal(nextSlides, slideTitle);
    setSlides(nextSlides);
    setRehearsalStatus(`Rehearsal ${nextReport.score}/100 · timing applied`);
    setCoachOpen(true);
  }, [recordForUndo, slideTitle, slides]);

  const insertRunOfShow = useCallback(() => {
    recordForUndo();
    const nextSlides = insertPresentationRunOfShow(slides, selectedDesignTheme, slideTitle);
    const nextReport = analyzePresentationRehearsal(nextSlides, slideTitle);
    setSlides(nextSlides);
    setCurrentSlideIdx(0);
    setRehearsalStatus(`Run of Show ready · ${formatRehearsalDuration(nextReport.totalSeconds)}`);
    setCoachOpen(true);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [recordForUndo, selectedDesignTheme, slideTitle, slides]);

  const insertAgenda = useCallback(() => {
    recordForUndo();
    const nextSlides = insertPresentationAgenda(slides, selectedDesignTheme, slideTitle);
    const agendaIdx = Math.max(0, nextSlides.findIndex((slide) => slide.title === 'Audience Agenda'));
    const nextReport = analyzePresentationRehearsal(nextSlides, slideTitle);
    setSlides(nextSlides);
    setCurrentSlideIdx(agendaIdx);
    setRehearsalStatus(`Agenda ready · ${formatRehearsalDuration(nextReport.totalSeconds)}`);
    setCoachOpen(true);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [recordForUndo, selectedDesignTheme, slideTitle, slides]);

  const insertBoardPack = useCallback(() => {
    recordForUndo();
    const nextSlides = insertPresentationBoardPack(slides, selectedDesignTheme, slideTitle);
    const boardIdx = Math.max(0, nextSlides.findIndex((slide) => slide.title === 'Board Decision Pack'));
    const nextReport = analyzePresentationRehearsal(nextSlides, slideTitle);
    setSlides(nextSlides);
    setCurrentSlideIdx(boardIdx);
    setRehearsalStatus(`Board pack ready · ${formatRehearsalDuration(nextReport.totalSeconds)}`);
    setCoachOpen(true);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [recordForUndo, selectedDesignTheme, slideTitle, slides]);

  const insertQAPack = useCallback(() => {
    recordForUndo();
    const nextSlides = insertPresentationQAPack(slides, selectedDesignTheme, slideTitle);
    const qaIdx = Math.max(0, nextSlides.findIndex((slide) => slide.title === 'Q&A Defense Map'));
    const nextReport = analyzePresentationRehearsal(nextSlides, slideTitle);
    setSlides(nextSlides);
    setCurrentSlideIdx(qaIdx);
    setRehearsalStatus(`Q&A pack ready · ${nextReport.issues.length} likely gaps`);
    setCoachOpen(true);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [recordForUndo, selectedDesignTheme, slideTitle, slides]);

  const insertAudienceDrill = useCallback(() => {
    recordForUndo();
    const nextSlides = insertPresentationAudienceDrill(slides, selectedDesignTheme, slideTitle);
    const drillIdx = Math.max(0, nextSlides.findIndex((slide) => slide.title === 'Audience Drill Room'));
    const nextReport = analyzePresentationRehearsal(nextSlides, slideTitle);
    setSlides(nextSlides);
    setCurrentSlideIdx(drillIdx);
    setRehearsalStatus(`Audience drill ready · ${nextReport.visibleSlides} source slides`);
    setCoachOpen(true);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [recordForUndo, selectedDesignTheme, slideTitle, slides]);

  const insertScriptPack = useCallback(() => {
    recordForUndo();
    const nextSlides = insertPresentationScriptPack(slides, selectedDesignTheme, slideTitle);
    const scriptIdx = Math.max(0, nextSlides.findIndex((slide) => slide.title === 'Presenter Script'));
    const nextReport = analyzePresentationRehearsal(nextSlides, slideTitle);
    setSlides(nextSlides);
    setCurrentSlideIdx(scriptIdx);
    setRehearsalStatus(`Script pack ready · ${formatRehearsalDuration(nextReport.totalSeconds)} talk track`);
    setCoachOpen(true);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [recordForUndo, selectedDesignTheme, slideTitle, slides]);

  const insertHandout = useCallback(() => {
    recordForUndo();
    const nextSlides = insertPresentationHandout(slides, selectedDesignTheme, slideTitle);
    const handoutIdx = Math.max(0, nextSlides.findIndex((slide) => slide.title === 'Executive Handout'));
    const nextReport = analyzePresentationRehearsal(nextSlides, slideTitle);
    setSlides(nextSlides);
    setCurrentSlideIdx(handoutIdx);
    setRehearsalStatus(`Handout ready · ${nextReport.visibleSlides} source slides`);
    setCoachOpen(true);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [recordForUndo, selectedDesignTheme, slideTitle, slides]);

  const insertInvestorPack = useCallback(() => {
    recordForUndo();
    const nextSlides = insertPresentationInvestorPack(slides, selectedDesignTheme, slideTitle);
    const investorIdx = Math.max(0, nextSlides.findIndex((slide) => slide.title === 'Investor Pitch Scorecard'));
    const nextReport = analyzePresentationRehearsal(nextSlides, slideTitle);
    setSlides(nextSlides);
    setCurrentSlideIdx(investorIdx);
    setRehearsalStatus(`Investor pack ready · ${nextReport.visibleSlides} source slides`);
    setCoachOpen(true);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [recordForUndo, selectedDesignTheme, slideTitle, slides]);

  const replaceDeckWithTemplate = useCallback(() => {
    recordForUndo();
    const nextSlides = buildPptxDeckTemplate(deckTemplateId, selectedDesignTheme);
    setSlides(nextSlides);
    setCurrentSlideIdx(0);
    setSelectedElementId(null);
    setEditingTextId(null);
    setMarkdownDraft(exportSlidesToSlidevMarkdown(nextSlides));
  }, [deckTemplateId, recordForUndo, selectedDesignTheme]);

  const appendDeckTemplate = useCallback(() => {
    recordForUndo();
    const templateSlides = buildPptxDeckTemplate(deckTemplateId, selectedDesignTheme);
    setSlides((prev) => {
      const next = [...prev];
      next.splice(currentSlideIdx + 1, 0, ...templateSlides);
      return next;
    });
    setCurrentSlideIdx((prev) => prev + 1);
    setSelectedElementId(null);
    setEditingTextId(null);
  }, [currentSlideIdx, deckTemplateId, recordForUndo, selectedDesignTheme]);

  const replaceDeckWithDesignPresetPack = useCallback(() => {
    recordForUndo();
    const preset = getPptxDesignPresetPack(designPresetPackId);
    const nextSlides = buildPptxDesignPresetDeck(designPresetPackId);
    setDesignThemeId(preset.themeId);
    setDeckTemplateId(preset.templateId);
    setSlides(nextSlides);
    setCurrentSlideIdx(0);
    setSelectedElementId(null);
    setEditingTextId(null);
    setDesignerStatus(`${preset.label} preset applied · ${nextSlides.length} slides`);
    setMarkdownDraft(exportSlidesToSlidevMarkdown(nextSlides));
  }, [designPresetPackId, recordForUndo]);

  const appendDesignPresetPack = useCallback(() => {
    recordForUndo();
    const preset = getPptxDesignPresetPack(designPresetPackId);
    const presetSlides = buildPptxDesignPresetDeck(designPresetPackId);
    setDesignThemeId(preset.themeId);
    setDeckTemplateId(preset.templateId);
    setSlides((prev) => {
      const next = [...prev];
      next.splice(currentSlideIdx + 1, 0, ...presetSlides);
      return next;
    });
    setCurrentSlideIdx((prev) => prev + 1);
    setSelectedElementId(null);
    setEditingTextId(null);
    setDesignerStatus(`${preset.label} preset appended · ${presetSlides.length} slides`);
  }, [currentSlideIdx, designPresetPackId, recordForUndo]);

  const applyDesignPresetStyleToDeck = useCallback(() => {
    recordForUndo();
    const preset = getPptxDesignPresetPack(designPresetPackId);
    const theme = getPptxDesignTheme(preset.themeId);
    const nextSlides = applyDesignThemeToSlides(slides, theme);
    setDesignThemeId(preset.themeId);
    setDeckTemplateId(preset.templateId);
    setSlides(nextSlides);
    setSelectedElementId(null);
    setEditingTextId(null);
    setDesignerStatus(`${preset.label} style applied · content preserved`);
    setMarkdownDraft(exportSlidesToSlidevMarkdown(nextSlides));
  }, [designPresetPackId, recordForUndo, slides]);

  const selectSmartDesignPreset = useCallback(() => {
    const recommendation = smartPresetRecommendations[0];
    if (!recommendation) return;
    setDesignPresetPackId(recommendation.preset.id);
    setDesignThemeId(recommendation.preset.themeId);
    setDeckTemplateId(recommendation.preset.templateId);
    setDesignerStatus(`Smart preset: ${recommendation.preset.label} · ${recommendation.reason}`);
  }, [smartPresetRecommendations]);

  // ─── Element operations ─────────────────────────────────────

  const addElement = useCallback((type: SlideElementType) => {
    recordForUndo();
    const defaults: Record<string, Partial<SlideElement>> = {
      // Real PowerPoint keeps new text boxes EMPTY (ghost placeholder only) and
      // drops the user straight into typing — no "Click to edit" junk text to
      // clear out first or accidentally ship in the deck.
      text: { w: 40, h: 15, text: '', fontSize: 18, fontColor: '#000000' },
      rect: { w: 20, h: 15, fillColor: '#4a90d9', fontSize: 14, fontColor: '#ffffff' },
      circle: { w: 20, h: 20, fillColor: '#4a90d9', fontSize: 14, fontColor: '#ffffff' },
      triangle: { w: 20, h: 18, fillColor: '#4a90d9' },
      star: { w: 20, h: 20, fillColor: '#f5a623' },
      arrow: { w: 25, h: 12, fillColor: '#4a90d9' },
      line: { w: 30, h: 1, borderColor: '#000000', borderWidth: 2 },
      image: { w: 30, h: 30 },
    };
    const el: SlideElement = { id: uid(), type, x: 20, y: 20, ...defaults[type] } as SlideElement;
    updateCurrentSlide((s) => ({ ...s, elements: [...s.elements, el] }));
    setSelectedElementId(el.id);
    if (type === 'text') setEditingTextId(el.id);
  }, [updateCurrentSlide, recordForUndo]);

  const addImageElement = useCallback(() => {
    void (async () => {
      const imageSrc = await pickImageDataUrl();
      if (!imageSrc) return;
      recordForUndo();
      const el: SlideElement = {
        id: uid(), type: 'image', x: 20, y: 20, w: 30, h: 30,
        imageSrc,
      };
      updateCurrentSlide((s) => ({ ...s, elements: [...s.elements, el] }));
      setSelectedElementId(el.id);
    })();
  }, [pickImageDataUrl, recordForUndo, updateCurrentSlide]);

  const addSmartTableElement = useCallback(() => {
    recordForUndo();
    const elements = buildEditablePptxTableElements(selectedDesignTheme);
    updateCurrentSlide((s) => ({ ...s, elements: [...s.elements, ...elements] }));
    setSelectedElementId(elements[0]?.id || null);
  }, [recordForUndo, selectedDesignTheme, updateCurrentSlide]);

  const addSmartBarChartElement = useCallback(() => {
    recordForUndo();
    const elements = buildEditablePptxBarChartElements(selectedDesignTheme);
    updateCurrentSlide((s) => ({ ...s, elements: [...s.elements, ...elements] }));
    setSelectedElementId(elements[0]?.id || null);
  }, [recordForUndo, selectedDesignTheme, updateCurrentSlide]);

  const insertImageElementAt = useCallback((imageSrc: string, x = 20, y = 20) => {
    recordForUndo();
    const el: SlideElement = {
      id: uid(),
      type: 'image',
      x: Math.max(0, Math.min(80, x)),
      y: Math.max(0, Math.min(80, y)),
      w: 30,
      h: 30,
      imageSrc,
    };
    updateCurrentSlide((s) => ({ ...s, elements: [...s.elements, el] }));
    setSelectedElementId(el.id);
  }, [recordForUndo, updateCurrentSlide]);

  const readImageFileAsDataUrl = useCallback((file: File) => new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  }), []);

  const getPointerPct = useCallback((clientX: number, clientY: number) => {
    const rect = slideRef.current?.getBoundingClientRect();
    if (!rect) return { x: 20, y: 20 };
    return {
      x: ((clientX - rect.left) / rect.width) * 100,
      y: ((clientY - rect.top) / rect.height) * 100,
    };
  }, []);

  const deleteElement = useCallback(() => {
    if (selectedElementIds.length === 0) return;
    const doomed = new Set(selectedElementIds);
    recordForUndo();
    updateCurrentSlide((s) => ({
      ...s,
      elements: s.elements.filter((e) => !doomed.has(e.id)),
    }));
    setSelectedElementIds([]);
    setEditingTextId(null);
  }, [selectedElementIds, updateCurrentSlide, recordForUndo]);

  const updateElement = useCallback((elId: string, updates: Partial<SlideElement>) => {
    updateCurrentSlide((s) => ({
      ...s,
      elements: s.elements.map((e) => e.id === elId ? { ...e, ...updates } : e),
    }));
  }, [updateCurrentSlide]);

  // Element edits from the properties panel / inline text editing: records a
  // grouped undo snapshot keyed by element + changed properties so a slider
  // drag or a typing burst collapses into one undo step.
  const updateElementWithHistory = useCallback((elId: string, updates: Partial<SlideElement>) => {
    recordForUndoGrouped(`${elId}:${Object.keys(updates).sort().join(',')}`);
    updateElement(elId, updates);
  }, [recordForUndoGrouped, updateElement]);

  const replaceSelectedImage = useCallback(() => {
    if (!selectedElementId) return;
    void (async () => {
      const imageSrc = await pickImageDataUrl();
      if (!imageSrc) return;
      recordForUndo();
      updateElement(selectedElementId, { imageSrc });
    })();
  }, [pickImageDataUrl, recordForUndo, selectedElementId, updateElement]);

  const clearSelectedImage = useCallback(() => {
    if (!selectedElementId) return;
    recordForUndo();
    updateElement(selectedElementId, { imageSrc: '' });
  }, [recordForUndo, selectedElementId, updateElement]);

  const nudgeSelectedElement = useCallback((dx: number, dy: number) => {
    if (selectedElementIds.length === 0) return;
    const ids = new Set(selectedElementIds);
    recordForUndoGrouped(`${selectedElementIds.join(',')}:nudge`);
    updateCurrentSlide((s) => ({
      ...s,
      // Clamp like the drag path — held arrow keys must not push elements
      // unreachably far offscreen.
      elements: s.elements.map((e) => ids.has(e.id)
        ? {
            ...e,
            x: Math.max(0, Math.min(100, snapVal(e.x + dx, snapEnabled))),
            y: Math.max(0, Math.min(100, snapVal(e.y + dy, snapEnabled))),
          }
        : e),
    }));
  }, [selectedElementIds, recordForUndoGrouped, snapEnabled, updateCurrentSlide]);

  const duplicateElement = useCallback(() => {
    if (selectedElementIds.length === 0) return;
    const ids = new Set(selectedElementIds);
    const originals = currentSlide.elements.filter((e) => ids.has(e.id));
    if (originals.length === 0) return;
    recordForUndo();
    const dups = originals.map((el) => ({
      ...JSON.parse(JSON.stringify(el)), id: uid(), x: el.x + 3, y: el.y + 3,
    })) as SlideElement[];
    updateCurrentSlide((s) => ({ ...s, elements: [...s.elements, ...dups] }));
    setSelectedElementIds(dups.map((d) => d.id));
  }, [selectedElementIds, currentSlide.elements, updateCurrentSlide, recordForUndo]);

  const copySelectedElement = useCallback(() => {
    if (selectedElementIds.length === 0) return;
    const ids = new Set(selectedElementIds);
    const els = currentSlide.elements.filter((e) => ids.has(e.id));
    if (els.length === 0) return;
    copiedElementRef.current = JSON.parse(JSON.stringify(els));
    // Stamp the OS clipboard so the paste handler knows the internal copy is
    // newer than whatever image/text was there before (best effort).
    navigator.clipboard?.writeText(PPTX_CLIPBOARD_MARKER).catch(() => {});
  }, [currentSlide.elements, selectedElementIds]);

  const pasteCopiedElement = useCallback(() => {
    const copied = copiedElementRef.current;
    if (!copied || copied.length === 0) return;
    recordForUndo();
    const dups = copied.map((el) => ({
      ...JSON.parse(JSON.stringify(el)), id: uid(), x: el.x + 3, y: el.y + 3,
    })) as SlideElement[];
    updateCurrentSlide((s) => ({ ...s, elements: [...s.elements, ...dups] }));
    setSelectedElementIds(dups.map((d) => d.id));
  }, [recordForUndo, updateCurrentSlide]);

  // ─── Z-order ────────────────────────────────────────────────

  const handleZOrder = useCallback((action: 'front' | 'back' | 'forward' | 'backward') => {
    if (!selectedElementId) return;
    recordForUndo();
    updateCurrentSlide((s) => {
      const els = [...s.elements];
      const idx = els.findIndex((e) => e.id === selectedElementId);
      if (idx < 0) return s;
      const [item] = els.splice(idx, 1);
      switch (action) {
        case 'front': els.push(item); break;
        case 'back': els.unshift(item); break;
        case 'forward': els.splice(Math.min(idx + 1, els.length), 0, item); break;
        case 'backward': els.splice(Math.max(idx - 1, 0), 0, item); break;
      }
      return { ...s, elements: els };
    });
  }, [selectedElementId, updateCurrentSlide, recordForUndo]);

  // ─── Align ──────────────────────────────────────────────────

  const handleAlign = useCallback((axis: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => {
    if (!selectedElementId) return;
    recordForUndo();
    updateCurrentSlide((s) => ({
      ...s,
      elements: s.elements.map((e) => {
        if (e.id !== selectedElementId) return e;
        switch (axis) {
          case 'left': return { ...e, x: 0 };
          case 'center': return { ...e, x: 50 - e.w / 2 };
          case 'right': return { ...e, x: 100 - e.w };
          case 'top': return { ...e, y: 0 };
          case 'middle': return { ...e, y: 50 - e.h / 2 };
          case 'bottom': return { ...e, y: 100 - e.h };
          default: return e;
        }
      }),
    }));
  }, [selectedElementId, updateCurrentSlide, recordForUndo]);

  // Align the selected group relative to its own bounding box (2+ elements).
  const handleAlignSelection = useCallback((axis: AlignAxis) => {
    if (selectedElementIds.length < 2) return;
    const ids = selectedElementIds;
    recordForUndo();
    updateCurrentSlide((s) => {
      const picked = s.elements.filter((e) => ids.includes(e.id));
      const boxes: Box[] = picked.map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }));
      const aligned = alignBoxes(boxes, axis);
      const posById = new Map(picked.map((e, i) => [e.id, aligned[i]]));
      return {
        ...s,
        elements: s.elements.map((e) => {
          const p = posById.get(e.id);
          return p ? { ...e, x: p.x, y: p.y } : e;
        }),
      };
    });
  }, [selectedElementIds, updateCurrentSlide, recordForUndo]);

  // Distribute the selected group evenly along one axis (3+ elements).
  const handleDistribute = useCallback((dir: 'h' | 'v') => {
    if (selectedElementIds.length < 3) return;
    const ids = selectedElementIds;
    recordForUndo();
    updateCurrentSlide((s) => {
      const picked = s.elements.filter((e) => ids.includes(e.id));
      const boxes: Box[] = picked.map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }));
      const spread = distributeBoxes(boxes, dir);
      const posById = new Map(picked.map((e, i) => [e.id, spread[i]]));
      return {
        ...s,
        elements: s.elements.map((e) => {
          const p = posById.get(e.id);
          return p ? { ...e, x: p.x, y: p.y } : e;
        }),
      };
    });
  }, [selectedElementIds, updateCurrentSlide, recordForUndo]);

  // Group / ungroup the current multi-selection (PowerPoint ⌘G / ⌘⇧G).
  const groupSelection = useCallback(() => {
    if (selectedElementIds.length < 2) return;
    const ids = new Set(selectedElementIds);
    recordForUndo();
    const groupId = uid();
    updateCurrentSlide((s) => ({
      ...s,
      elements: s.elements.map((e) => (ids.has(e.id) ? { ...e, groupId } : e)),
    }));
  }, [selectedElementIds, recordForUndo, updateCurrentSlide]);

  const ungroupSelection = useCallback(() => {
    if (selectedElementIds.length === 0) return;
    const ids = new Set(selectedElementIds);
    recordForUndo();
    updateCurrentSlide((s) => ({
      ...s,
      elements: s.elements.map((e) => {
        if (!ids.has(e.id) || !e.groupId) return e;
        const rest = { ...e };
        delete rest.groupId;
        return rest;
      }),
    }));
  }, [selectedElementIds, recordForUndo, updateCurrentSlide]);

  const selectionHasGroup = selectedElementIds.some(
    (id) => currentSlide.elements.find((e) => e.id === id)?.groupId,
  );

  // ─── Table element ops ──────────────────────────────────────

  const addTableElement = useCallback(() => {
    recordForUndo();
    const el: SlideElement = {
      id: uid(), type: 'table', x: 12, y: 22, w: 76, h: 40,
      fontSize: 14, table: createTableData(3, 3),
    };
    updateCurrentSlide((s) => ({ ...s, elements: [...s.elements, el] }));
    setSelectedElementIds([el.id]);
  }, [recordForUndo, updateCurrentSlide]);

  const mutateTable = useCallback((elId: string, mutate: (t: TableData) => TableData, undoKey?: string) => {
    if (undoKey) recordForUndoGrouped(undoKey); else recordForUndo();
    updateCurrentSlide((s) => ({
      ...s,
      elements: s.elements.map((e) => {
        if (e.id !== elId || e.type !== 'table' || !e.table) return e;
        return { ...e, table: mutate(e.table) };
      }),
    }));
  }, [recordForUndo, recordForUndoGrouped, updateCurrentSlide]);

  const setTableCell = useCallback((elId: string, row: number, col: number, value: string) => {
    mutateTable(elId, (t) => {
      const cells = t.cells.map((r) => r.slice());
      if (cells[row]) cells[row][col] = value;
      return { ...t, cells };
    }, `${elId}:cell:${row}:${col}`);
  }, [mutateTable]);

  const tableAddRow = useCallback((elId: string) => {
    mutateTable(elId, (t) => insertTableRow(t, t.rows));
  }, [mutateTable]);

  const tableRemoveRow = useCallback((elId: string) => {
    mutateTable(elId, (t) => removeTableRow(t, t.rows - 1));
  }, [mutateTable]);

  const tableAddCol = useCallback((elId: string) => {
    mutateTable(elId, (t) => insertTableCol(t, t.cols));
  }, [mutateTable]);

  const tableRemoveCol = useCallback((elId: string) => {
    mutateTable(elId, (t) => removeTableCol(t, t.cols - 1));
  }, [mutateTable]);

  const toggleTableHeader = useCallback((elId: string) => {
    mutateTable(elId, (t) => ({ ...t, headerRow: !t.headerRow }));
  }, [mutateTable]);

  // ─── Undo / Redo handlers ──────────────────────────────────

  const handleUndo = useCallback(() => {
    const prev = undo();
    // Clamp the active index — undoing a slide-add shrinks the deck and would
    // otherwise strand currentSlideIdx past the end, silently no-op'ing edits.
    if (prev) { setSlides(prev); setCurrentSlideIdx((i) => Math.min(i, prev.length - 1)); setSelectedElementId(null); }
  }, [undo]);

  const handleRedo = useCallback(() => {
    const next = redo();
    if (next) { setSlides(next); setCurrentSlideIdx((i) => Math.min(i, next.length - 1)); setSelectedElementId(null); }
  }, [redo]);

  // ─── Mouse drag for moving elements ────────────────────────

  const handleElementMouseDown = useCallback((e: React.MouseEvent, elId: string) => {
    e.stopPropagation();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    // Clicking any member of a group selects the whole group (PowerPoint).
    const clicked = currentSlide.elements.find((x) => x.id === elId);
    const clickUnit = clicked?.groupId
      ? currentSlide.elements.filter((x) => x.groupId === clicked.groupId).map((x) => x.id)
      : [elId];
    // Compute the resulting selection so group drag can capture every member.
    let nextIds: string[];
    if (additive) {
      nextIds = selectedElementIds.includes(elId)
        ? selectedElementIds.filter((id) => !clickUnit.includes(id))
        : [...selectedElementIds, ...clickUnit.filter((id) => !selectedElementIds.includes(id))];
    } else if (selectedElementIds.includes(elId)) {
      nextIds = selectedElementIds; // keep the group when dragging one of it
    } else {
      nextIds = clickUnit;
    }
    setSelectedElementIds(nextIds);
    if (editingTextId === elId) return;
    if (additive && !nextIds.includes(elId)) return; // just deselected

    // Defer the undo snapshot until an actual move begins (see mousemove), so a
    // plain click that only selects does not consume a history step.
    const group = currentSlide.elements
      .filter((x) => nextIds.includes(x.id))
      .map((x) => ({ id: x.id, origX: x.x, origY: x.y }));
    const el = currentSlide.elements.find((x) => x.id === elId);
    if (!el) return;
    dragRef.current = { elId, startX: e.clientX, startY: e.clientY, origX: el.x, origY: el.y, recorded: false, group };
  }, [currentSlide.elements, editingTextId, selectedElementIds]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent, elId: string, dir: ResizeDir) => {
    e.stopPropagation();
    e.preventDefault();
    const el = currentSlide.elements.find((x) => x.id === elId);
    if (!el) return;
    // Snapshot is deferred to the first real drag movement (see mousemove).
    resizeRef.current = { elId, dir, startX: e.clientX, startY: e.clientY, origX: el.x, origY: el.y, origW: el.w, origH: el.h, recorded: false };
  }, [currentSlide.elements]);

  const handleRotateMouseDown = useCallback((e: React.MouseEvent, elId: string) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = slideRef.current?.getBoundingClientRect();
    const el = currentSlide.elements.find((x) => x.id === elId);
    if (!rect || !el) return;
    const cx = rect.left + ((el.x + el.w / 2) / 100) * rect.width;
    const cy = rect.top + ((el.y + el.h / 2) / 100) * rect.height;
    rotateRef.current = { elId, cx, cy, recorded: false };
  }, [currentSlide.elements]);

  // Marquee (rubber-band) selection starting on empty canvas.
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (editingTextId || editingTableCell) return;
    const rect = slideRef.current?.getBoundingClientRect();
    if (!rect) return;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    marqueeRef.current = {
      startX: e.clientX, startY: e.clientY, additive,
      base: additive ? selectedElementIds : [],
    };
    if (!additive) setSelectedElementIds([]);
  }, [editingTextId, editingTableCell, selectedElementIds]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const slideEl = slideRef.current;
      const rect = slideEl?.getBoundingClientRect();

      if (dragRef.current && rect) {
        const drag = dragRef.current;
        if (!drag.recorded) {
          // Ignore sub-threshold jitter so a click doesn't start a drag/undo.
          if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) <= 3) return;
          recordForUndo();
          drag.recorded = true;
        }
        const dx = ((e.clientX - drag.startX) / rect.width) * 100;
        const dy = ((e.clientY - drag.startY) / rect.height) * 100;
        // Move the primary element, then re-align guides / snap against the rest.
        const primary = drag.group.find((g) => g.id === drag.elId) || { origX: drag.origX, origY: drag.origY };
        let primaryX = Math.max(0, Math.min(100, primary.origX + dx));
        let primaryY = Math.max(0, Math.min(100, primary.origY + dy));
        primaryX = snapVal(primaryX, snapEnabled);
        primaryY = snapVal(primaryY, snapEnabled);

        const groupIds = new Set(drag.group.map((g) => g.id));
        const el = currentSlide.elements.find((x) => x.id === drag.elId);
        let snapAdjX = 0;
        let snapAdjY = 0;
        if (el) {
          const others = currentSlide.elements
            .filter((x) => !groupIds.has(x.id))
            .map((x): Box => ({ x: x.x, y: x.y, w: x.w, h: x.h }));
          const snap = computeDragSnap({ x: primaryX, y: primaryY, w: el.w, h: el.h }, others, SMART_SNAP_PCT);
          snapAdjX = snap.x - primaryX;
          snapAdjY = snap.y - primaryY;
          setActiveGuides({ vLines: snap.vLines, hLines: snap.hLines });
        }
        const moveDx = primaryX + snapAdjX - primary.origX;
        const moveDy = primaryY + snapAdjY - primary.origY;
        updateCurrentSlide((s) => ({
          ...s,
          elements: s.elements.map((item) => {
            const g = drag.group.find((gg) => gg.id === item.id);
            if (!g) return item;
            return {
              ...item,
              x: Math.max(0, Math.min(100, g.origX + moveDx)),
              y: Math.max(0, Math.min(100, g.origY + moveDy)),
            };
          }),
        }));
      }

      if (rotateRef.current && rect) {
        const rot = rotateRef.current;
        if (!rot.recorded) {
          if (Math.abs(e.clientX - rot.cx) + Math.abs(e.clientY - rot.cy) <= 3) return;
          recordForUndo();
          rot.recorded = true;
        }
        const deg = computeRotation(rot.cx, rot.cy, e.clientX, e.clientY, e.shiftKey);
        updateElement(rot.elId, { rotation: Math.round(deg) });
      }

      if (marqueeRef.current && rect) {
        const mq = marqueeRef.current;
        const x = Math.min(mq.startX, e.clientX);
        const y = Math.min(mq.startY, e.clientY);
        const w = Math.abs(e.clientX - mq.startX);
        const h = Math.abs(e.clientY - mq.startY);
        setMarquee({ x, y, w, h });
        // Convert marquee to slide % and select intersecting elements.
        const mx = ((x - rect.left) / rect.width) * 100;
        const my = ((y - rect.top) / rect.height) * 100;
        const mw = (w / rect.width) * 100;
        const mh = (h / rect.height) * 100;
        const hit = currentSlide.elements.filter((el) =>
          el.x < mx + mw && el.x + el.w > mx && el.y < my + mh && el.y + el.h > my,
        ).map((el) => el.id);
        const merged = mq.additive ? Array.from(new Set([...mq.base, ...hit])) : hit;
        setSelectedElementIds(merged);
      }

      if (resizeRef.current && rect) {
        const rz = resizeRef.current;
        if (!rz.recorded) {
          if (Math.abs(e.clientX - rz.startX) + Math.abs(e.clientY - rz.startY) <= 3) return;
          recordForUndo();
          rz.recorded = true;
        }
        const dxPct = ((e.clientX - rz.startX) / rect.width) * 100;
        const dyPct = ((e.clientY - rz.startY) / rect.height) * 100;
        const box = computeResizeGeometry(
          rz.dir,
          { x: rz.origX, y: rz.origY, w: rz.origW, h: rz.origH },
          dxPct,
          dyPct,
          e.shiftKey,
        );
        updateElement(rz.elId, {
          x: snapVal(box.x, snapEnabled),
          y: snapVal(box.y, snapEnabled),
          w: snapVal(box.w, snapEnabled),
          h: snapVal(box.h, snapEnabled),
        });
      }
      if (sidebarResizeRef.current) {
        const nextWidth = sidebarResizeRef.current.side === 'left'
          ? sidebarResizeRef.current.startWidth + (e.clientX - sidebarResizeRef.current.startX)
          : sidebarResizeRef.current.startWidth - (e.clientX - sidebarResizeRef.current.startX);
        if (sidebarResizeRef.current.side === 'left') {
          setLeftSidebarWidth(Math.max(120, Math.min(320, nextWidth)));
        } else {
          setRightPanelWidth(Math.max(320, Math.min(720, nextWidth)));
        }
      }
    };

    const handleMouseUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
      rotateRef.current = null;
      marqueeRef.current = null;
      sidebarResizeRef.current = null;
      setMarquee(null);
      setActiveGuides({ vLines: [], hLines: [] });
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [updateElement, updateCurrentSlide, currentSlide.elements, snapEnabled, recordForUndo]);

  const handleCanvasDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const file = Array.from(e.dataTransfer.files || []).find((item) => item.type.startsWith('image/'));
    if (!file) return;
    const imageSrc = await readImageFileAsDataUrl(file);
    if (!imageSrc) return;
    const pos = getPointerPct(e.clientX, e.clientY);
    insertImageElementAt(imageSrc, pos.x, pos.y);
  }, [getPointerPct, insertImageElementAt, readImageFileAsDataUrl]);

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (editingTextId || editingTableCell) return;
      if (focusOutsideEditor(editorRootRef.current, e)) return;
      const items = Array.from(e.clipboardData?.items || []);
      const imageItem = items.find((item) => item.type.startsWith('image/'));
      // Arbitrate internal element/slide copy vs OS clipboard image: an internal
      // copy stamps PPTX_CLIPBOARD_MARKER into the OS clipboard, so if the
      // marker is still there nothing newer was copied outside the app.
      const text = e.clipboardData?.getData('text/plain') || '';
      if (text === PPTX_CLIPBOARD_MARKER || !imageItem) {
        if (copiedElementRef.current && copiedElementRef.current.length > 0) {
          e.preventDefault();
          pasteCopiedElement();
          return;
        }
        if (copiedSlideRef.current) {
          e.preventDefault();
          pasteCopiedSlide();
          return;
        }
      }
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      const imageSrc = await readImageFileAsDataUrl(file);
      if (!imageSrc) return;
      e.preventDefault();
      insertImageElementAt(imageSrc, 20, 20);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [editingTextId, editingTableCell, insertImageElementAt, readImageFileAsDataUrl, pasteCopiedElement, pasteCopiedSlide]);

  const beginSidebarResize = useCallback((side: 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    sidebarResizeRef.current = {
      side,
      startX: e.clientX,
      startWidth: side === 'left' ? leftSidebarWidth : rightPanelWidth,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [leftSidebarWidth, rightPanelWidth]);

  useEffect(() => {
    if (!presenting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [presenting]);

  // Hide the cursor (and let the nav bar fade) after ~2.5s of mouse idle while
  // presenting. The old CSS-only `cursor: none` was dead code — the `:hover`
  // override always won because the pointer is always over the overlay.
  const [presentationCursorHidden, setPresentationCursorHidden] = useState(false);
  useEffect(() => {
    if (!presenting || presenterMode || presentationEditing) {
      setPresentationCursorHidden(false);
      return;
    }
    let timer = window.setTimeout(() => setPresentationCursorHidden(true), 2500);
    const onMove = () => {
      setPresentationCursorHidden(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPresentationCursorHidden(true), 2500);
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', onMove);
      setPresentationCursorHidden(false);
    };
  }, [presenting, presenterMode, presentationEditing]);

  // 발표 도중 에디터 자체가 언마운트되면(파일/탭 닫기) 창 전체화면을 원복한다.
  // stopPresentation 경로와 중복 호출돼도 prevWindowFullscreenRef가 비워져 no-op.
  useEffect(() => {
    if (!presenting) return;
    return () => { exitPresentationFullscreen(); };
  }, [presenting, exitPresentationFullscreen]);

  // ─── Keyboard shortcuts ─────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 발표 중에는 에디터 루트가 언마운트되어 editorRootRef가 null이다 — 그대로
      // 가드에 넣으면 발표 화면의 버튼/입력에 포커스가 잡히는 순간 Esc까지 전부
      // 죽어 "발표가 안 닫히는" 버그가 된다. 발표 중 스코프는 발표 오버레이 자신.
      const scopeRoot = presenting ? presentationRef.current : editorRootRef.current;
      if (focusOutsideEditor(scopeRoot, e)) return;
      if (presenting) {
        if (e.key === 'Escape') {
          e.preventDefault();
          // 발표 중 인라인 편집이 열려 있으면 Esc 1번은 편집만 닫는다.
          if (editingTextId || editingTableCell) {
            setEditingTextId(null);
            setEditingTableCell(null);
            return;
          }
          stopPresentation();
          return;
        }
        const keyTarget = e.target as HTMLElement | null;
        const typing = !!keyTarget && (keyTarget.tagName === 'INPUT' || keyTarget.tagName === 'TEXTAREA' || keyTarget.isContentEditable);
        if (typing) return;
        // preventDefault: after clicking a nav button it keeps focus, and an
        // un-prevented Space would re-activate that button (e.g. re-trigger
        // ESC and exit the presentation) instead of advancing the slide.
        if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); goToPresentationSlide(1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); goToPresentationSlide(-1); }
        if (e.key.toLowerCase() === 'b') {
          e.preventDefault();
          setPresentationBlackout((prev) => !prev);
        }
        if (e.key.toLowerCase() === 'e') {
          e.preventDefault();
          setPresentationEditing((prev) => !prev);
        }
        if (e.key.toLowerCase() === 'f') {
          e.preventDefault();
          togglePresentationFullscreen();
        }
        return;
      }

      if (e.key === 'F5') {
        e.preventDefault();
        startPresentation(e.shiftKey);
        return;
      }

      const meta = e.metaKey || e.ctrlKey;

      // Cmd+S / Cmd+Shift+S — works during text editing too (edits are already
      // committed to state on every keystroke, so mid-edit saves are safe).
      if (meta && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave(e.shiftKey);
        return;
      }

      if (editingTextId) {
        // PowerPoint semantics: Esc exits text editing (and finishTextEdit
        // removes the box if it was left empty); other keys belong to the editor.
        if (e.key === 'Escape') { e.preventDefault(); const ta = document.activeElement as HTMLTextAreaElement | null; finishTextEdit(editingTextId!, ta?.value ?? ''); }
        return;
      }

      // Cmd+Z / Cmd+Shift+Z / Cmd+Y — compare lowercased: with Shift held the
      // key arrives as 'Z' and a === 'z' check silently kills redo.
      if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); return; }
      if (meta && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); handleRedo(); return; }
      // Cmd+D
      if (meta && e.key === 'd') { e.preventDefault(); if (selectedElementId) duplicateElement(); else duplicateSlide(); return; }
      // Cmd+G / Cmd+Shift+G — group / ungroup (PowerPoint)
      if (meta && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey) ungroupSelection(); else groupSelection();
        return;
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        copyCurrentSlide();
        return;
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        pasteCopiedSlide();
        return;
      }
      // Cmd+A — select every element on the current slide
      if (meta && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelectedElementIds(currentSlide.elements.map((el) => el.id));
        return;
      }
      if (meta && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        if (selectedElementIds.length > 0) copySelectedElement();
        else copyCurrentSlide();
        return;
      }
      // Plain Cmd+V is intentionally NOT handled here: preventDefault on the
      // keydown would suppress the native paste event, making OS-clipboard
      // image paste unreachable forever after the first internal element copy.
      // The window 'paste' listener arbitrates image vs internal element paste.

      if (selectedElementIds.length > 0) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeSelectedElement(e.shiftKey ? -5 : -1, 0); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSelectedElement(e.shiftKey ? 5 : 1, 0); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); nudgeSelectedElement(0, e.shiftKey ? -5 : -1); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); nudgeSelectedElement(0, e.shiftKey ? 5 : 1); return; }
      }

      // Enter / F2 opens inline text editing on the selected element (PowerPoint)
      if ((e.key === 'Enter' || e.key === 'F2') && selectedElementId) {
        const target = e.target as HTMLElement | null;
        const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if (!typing) {
          const el = currentSlide.elements.find((it) => it.id === selectedElementId);
          if (el && el.type !== 'image' && el.type !== 'table') {
            e.preventDefault();
            setEditingTextId(selectedElementId);
            return;
          }
        }
      }

      // Ctrl+] / Ctrl+[ — bring forward / send backward; +Shift = to front/back
      if (meta && (e.key === ']' || e.key === '}' || e.key === '[' || e.key === '{')) {
        e.preventDefault();
        if (selectedElementId) {
          const forward = e.key === ']' || e.key === '}';
          handleZOrder(forward ? (e.shiftKey ? 'front' : 'forward') : (e.shiftKey ? 'back' : 'backward'));
        }
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const target = e.target as HTMLElement;
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && !target.isContentEditable) {
          deleteElement();
        }
      }
      if (e.key === 'Escape') {
        setSelectedElementIds([]);
        setEditingTextId(null);
        setEditingTableCell(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // handleSave/finishTextEdit are declared below this effect; the closure only
    // runs post-render so the references are always initialized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenting, editingTextId, editingTableCell, currentSlide.elements, currentSlideIdx, goToPresentationSlide, deleteElement, handleUndo, handleRedo, duplicateElement, duplicateSlide, nudgeSelectedElement, selectedElementId, selectedElementIds, copySelectedElement, copyCurrentSlide, pasteCopiedSlide, startPresentation, stopPresentation, togglePresentationFullscreen, groupSelection, ungroupSelection, handleZOrder, slides]);

  // ─── Save / Export ──────────────────────────────────────────

  const showSaveToast = useCallback((type: 'success' | 'error', message: string) => {
    if (saveToastTimerRef.current != null) window.clearTimeout(saveToastTimerRef.current);
    setSaveToast({ type, message });
    saveToastTimerRef.current = window.setTimeout(() => setSaveToast(null), 3200);
  }, []);

  const markSaved = useCallback(() => {
    cleanSlidesRef.current = slidesRef.current;
    lastModifiedRef.current = false;
    setModified(false);
    onModifiedChange?.(false);
  }, [onModifiedChange]);

  // Returns the saved path on success, or false on cancel/failure so callers
  // (keyboard, buttons, the pptx.save bridge) can tell whether the disk write
  // actually happened instead of assuming it always did.
  const handleSave = useCallback(async (saveAs?: boolean): Promise<string | false> => {
    setSaving(true);
    try {
      const base64 = await exportSlidesToPptx(slides, slideSize);
      let targetPath = filePath;
      let savedCopy = false;
      if (saveAs) {
        const name = fileBaseName(filePath) || 'presentation.pptx';
        const result = await invoke<string | null>('save_file_dialog', {
          defaultName: name,
          filters: [['PowerPoint', ['pptx']]],
        });
        if (!result) { setSaving(false); return false; }
        targetPath = result;
      } else if (sourceGuarded && filePath) {
        // Never overwrite an original we can't fully round-trip — save a copy.
        targetPath = editedCopyPath(filePath);
        savedCopy = true;
      }
      await invoke('write_file_base64', { path: targetPath, base64Data: base64 });
      markSaved();
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      showSaveToast('success', savedCopy ? `Saved a copy ${hhmm} (original preserved)` : `Saved ${hhmm}`);
      onSaved?.(targetPath);
      return targetPath;
    } catch (err) {
      console.error('[PptxEditor] Save failed:', err);
      showSaveToast('error', 'Save failed');
      return false;
    } finally {
      setSaving(false);
    }
  }, [slides, slideSize, filePath, onSaved, markSaved, showSaveToast, sourceGuarded]);

  useEffect(() => () => {
    if (saveToastTimerRef.current != null) window.clearTimeout(saveToastTimerRef.current);
  }, []);

  // ─── Editor control bridge (terminal agent → slide-level control) ──
  // App.tsx delegates `pptx.*` commands here via a window CustomEvent, matched
  // by normalized filePath (Windows separators/case vary by resolver). Kept in
  // a ref so fresh state is used without re-registering the listener.
  const pptxBridgeHandlerRef = useRef<(cmd: string, request: any) => Promise<any>>(async () => ({ ok: false, error: 'pptx bridge not ready' }));
  pptxBridgeHandlerRef.current = async (cmd: string, request: any) => {
    const elId = () => `el-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const clampPct = (v: any, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
    };
    const slideIndex = (fallbackToCurrent = true): number => {
      const raw = request?.slide;
      if (raw == null || raw === '') return fallbackToCurrent ? currentSlideIdx : -1;
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 && n < slides.length ? n : -1;
    };

    switch (cmd) {
      case 'pptx.listSlides':
        return {
          ok: true,
          count: slides.length,
          current: currentSlideIdx,
          slides: slides.map((s, i) => ({ index: i, title: s.title || '', elements: s.elements.length, bgColor: s.bgColor })),
        };

      case 'pptx.addSlide': {
        const title = String(request?.title ?? '').trim();
        const body = String(request?.body ?? '').trim();
        // Designed layout path: layout id → themed, composed slide (cover,
        // metrics, timeline…) instead of the plain title+bullets fallback.
        const layoutRaw = String(request?.layout ?? '').trim();
        if (layoutRaw) {
          if (!(AGENT_LAYOUT_IDS as readonly string[]).includes(layoutRaw)) {
            return { ok: false, error: `unknown layout: ${layoutRaw}. Available: ${AGENT_LAYOUT_IDS.join(', ')}` };
          }
          const toStrList = (v: any): string[] | undefined => {
            if (Array.isArray(v)) return v.map((s) => String(s)).filter(Boolean);
            if (typeof v === 'string' && v.trim()) return v.split('\n').map((s) => s.trim()).filter(Boolean);
            return undefined;
          };
          const metrics: AgentLayoutMetric[] | undefined = Array.isArray(request?.metrics)
            ? request.metrics
                .map((m: any) => ({ label: String(m?.label ?? ''), value: String(m?.value ?? ''), note: m?.note != null ? String(m.note) : undefined }))
                .filter((m: AgentLayoutMetric) => m.label || m.value)
            : undefined;
          const items: AgentLayoutItem[] | undefined = Array.isArray(request?.items)
            ? request.items
                .map((it: any) => ({ title: String(it?.title ?? ''), body: it?.body != null ? String(it.body) : undefined }))
                .filter((it: AgentLayoutItem) => it.title || it.body)
            : undefined;
          const data: [string, number][] | undefined = Array.isArray(request?.data)
            ? request.data
                .filter((row: any) => Array.isArray(row) && row.length >= 2)
                .map((row: any) => [String(row[0]), Number(row[1]) || 0] as [string, number])
            : undefined;
          const theme = request?.theme ? getPptxDesignTheme(String(request.theme)) : selectedDesignTheme;
          const layoutSlide = buildAgentLayoutSlide(layoutRaw as AgentLayoutId, {
            title,
            subtitle: request?.subtitle != null ? String(request.subtitle) : undefined,
            body: body || undefined,
            bullets: toStrList(request?.bullets),
            metrics,
            items,
            kicker: request?.kicker != null ? String(request.kicker) : undefined,
            footer: request?.footer != null ? String(request.footer) : undefined,
            data,
          }, theme);
          const layoutIndex = slides.length;
          recordForUndo();
          setSlides((prev) => [...prev, layoutSlide]);
          setCurrentSlideIdx(layoutIndex);
          return { ok: true, index: layoutIndex, layout: layoutRaw };
        }
        const slide = createBlankSlide();
        if (request?.bgColor) slide.bgColor = String(request.bgColor);
        slide.title = title;
        if (title) {
          slide.elements.push({
            id: elId(), type: 'text', x: 6, y: 8, w: 88, h: 14,
            text: title, fontSize: 30, bold: true,
            fontColor: String(request?.titleColor || '#111827'),
            textAlign: (['left', 'center', 'right'] as const).includes(request?.titleAlign) ? request.titleAlign : 'left',
          });
        }
        if (body) {
          slide.elements.push({
            id: elId(), type: 'text', x: 6, y: 26, w: 88, h: 62,
            text: body, fontSize: 18, fontColor: String(request?.bodyColor || '#334155'),
            textAlign: (['left', 'center', 'right'] as const).includes(request?.bodyAlign) ? request.bodyAlign : 'left',
            listStyle: body.includes('\n') ? 'bullet' : 'none',
          });
        }
        // Agent-created slides get the same design treatment as UI-created ones;
        // explicit color overrides mean the caller wants raw control, so skip theming.
        if (!request?.bgColor && !request?.titleColor && !request?.bodyColor) {
          const themed = applyDesignThemeToSlide(slide, selectedDesignTheme);
          slide.bgColor = themed.bgColor;
          slide.elements = themed.elements;
        }
        const newIndex = slides.length;
        recordForUndo();
        setSlides((prev) => [...prev, slide]);
        setCurrentSlideIdx(newIndex);
        return { ok: true, index: newIndex };
      }

      case 'pptx.addText': {
        const idx = slideIndex();
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        const text = String(request?.text ?? '');
        if (!text.trim()) return { ok: false, error: 'text required' };
        const element: SlideElement = {
          id: elId(), type: 'text',
          x: clampPct(request?.x, 8), y: clampPct(request?.y, 40),
          w: clampPct(request?.w, 60), h: clampPct(request?.h, 12),
          text, fontSize: Number(request?.fontSize) || 18,
          bold: !!request?.bold, fontColor: String(request?.color || '#111827'),
          fontFamily: typeof request?.fontFamily === 'string' ? request.fontFamily : undefined,
          textAlign: (['left', 'center', 'right'] as const).includes(request?.align) ? request.align : 'left',
          listStyle: request?.listStyle === 'bullet' || request?.listStyle === 'number' ? request.listStyle : 'none',
        };
        recordForUndo();
        setSlides((prev) => prev.map((s, i) => (i === idx ? { ...s, elements: [...s.elements, element] } : s)));
        setCurrentSlideIdx(idx);
        return { ok: true, slide: idx, id: element.id };
      }

      case 'pptx.addShape': {
        const idx = slideIndex();
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        const kind = String(request?.shape || 'rect');
        if (!['rect', 'circle', 'triangle', 'star', 'arrow', 'line'].includes(kind)) {
          return { ok: false, error: `unsupported shape: ${kind} (rect/circle/triangle/star/arrow/line)` };
        }
        const element: SlideElement = {
          id: elId(), type: kind as SlideElement['type'],
          x: clampPct(request?.x, 10), y: clampPct(request?.y, 55),
          w: clampPct(request?.w, 24), h: clampPct(request?.h, 18),
          fillColor: String(request?.fillColor || '#2563eb'),
          text: request?.text ? String(request.text) : undefined,
          fontSize: Number(request?.fontSize) || 14,
          fontColor: String(request?.color || '#ffffff'),
          bold: !!request?.bold,
          textAlign: (['left', 'center', 'right'] as const).includes(request?.align) ? request.align : 'center',
        };
        recordForUndo();
        setSlides((prev) => prev.map((s, i) => (i === idx ? { ...s, elements: [...s.elements, element] } : s)));
        setCurrentSlideIdx(idx);
        return { ok: true, slide: idx, id: element.id };
      }

      case 'pptx.goToSlide': {
        const idx = slideIndex(false);
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        setCurrentSlideIdx(idx);
        return { ok: true, index: idx };
      }

      case 'pptx.save': {
        // The guard auto-saves a copy when the source can't round-trip, so the
        // bridge stays non-blocking and returns whatever path was actually
        // written (copy path included) — or an error if the write failed.
        const savedPath = await handleSave();
        if (!savedPath) return { ok: false, error: 'save failed' };
        return { ok: true, path: savedPath };
      }

      case 'pptx.addImage': {
        const idx = slideIndex();
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        let src = typeof request?.imageSrc === 'string' ? request.imageSrc.trim() : '';
        if (!src && typeof request?.imagePath === 'string' && request.imagePath.trim()) {
          const dataUrl = await readImageDataUrl(request.imagePath.trim());
          if (!dataUrl) return { ok: false, error: `could not read image: ${request.imagePath}` };
          src = dataUrl;
        }
        if (!src) return { ok: false, error: 'imagePath or imageSrc (data URL) required' };
        const element: SlideElement = {
          id: elId(), type: 'image',
          x: clampPct(request?.x, 20), y: clampPct(request?.y, 20),
          w: clampPct(request?.w, 40), h: clampPct(request?.h, 40),
          imageSrc: src,
        };
        recordForUndo();
        setSlides((prev) => prev.map((s, i) => (i === idx ? { ...s, elements: [...s.elements, element] } : s)));
        setCurrentSlideIdx(idx);
        return { ok: true, slide: idx, id: element.id };
      }

      case 'pptx.addTable': {
        const idx = slideIndex();
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        const cells: string[][] | undefined = Array.isArray(request?.cells)
          ? request.cells.map((row: any) => (Array.isArray(row) ? row.map((c: any) => String(c ?? '')) : []))
          : undefined;
        const rows = cells ? cells.length : Math.max(1, Math.min(20, Number(request?.rows) || 3));
        const cols = cells ? Math.max(...cells.map((r) => r.length), 1) : Math.max(1, Math.min(12, Number(request?.cols) || 3));
        const table = createTableData(rows, cols);
        if (cells) {
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              table.cells[r][c] = cells[r]?.[c] ?? '';
            }
          }
        }
        if (typeof request?.headerRow === 'boolean') table.headerRow = request.headerRow;
        if (typeof request?.headerFill === 'string') table.headerFill = request.headerFill;
        if (typeof request?.borderColor === 'string') table.borderColor = request.borderColor;
        const element: SlideElement = {
          id: elId(), type: 'table',
          x: clampPct(request?.x, 8), y: clampPct(request?.y, 25),
          w: clampPct(request?.w, 84), h: clampPct(request?.h, 45),
          table,
        };
        recordForUndo();
        setSlides((prev) => prev.map((s, i) => (i === idx ? { ...s, elements: [...s.elements, element] } : s)));
        setCurrentSlideIdx(idx);
        return { ok: true, slide: idx, id: element.id, rows, cols };
      }

      case 'pptx.setNotes': {
        const idx = slideIndex();
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        const notes = String(request?.notes ?? request?.text ?? '');
        recordForUndo();
        setSlides((prev) => prev.map((s, i) => (i === idx ? { ...s, notes } : s)));
        setCurrentSlideIdx(idx);
        return { ok: true, slide: idx };
      }

      case 'pptx.setBackground': {
        const idx = slideIndex();
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        const applyToAll = !!request?.applyToAll;
        let bgImage: string | undefined;
        if (typeof request?.imagePath === 'string' && request.imagePath.trim()) {
          const dataUrl = await readImageDataUrl(request.imagePath.trim());
          if (!dataUrl) return { ok: false, error: `could not read image: ${request.imagePath}` };
          bgImage = dataUrl;
        } else if (typeof request?.bgImage === 'string' && request.bgImage.trim()) {
          bgImage = request.bgImage.trim();
        }
        const bgColor = typeof request?.bgColor === 'string' ? request.bgColor : undefined;
        if (!bgImage && !bgColor) return { ok: false, error: 'bgColor, imagePath, or bgImage required' };
        recordForUndo();
        setSlides((prev) => prev.map((s, i) => {
          if (!applyToAll && i !== idx) return s;
          const next = { ...s };
          if (bgColor) next.bgColor = bgColor;
          if (bgImage !== undefined) next.bgImage = bgImage;
          return next;
        }));
        return { ok: true, slide: applyToAll ? 'all' : idx };
      }

      case 'pptx.applyTheme': {
        const themeId = String(request?.theme || '').trim();
        const theme = getPptxDesignTheme(themeId);
        if (!theme) return { ok: false, error: `unknown theme: ${themeId}. Available: ${PPTX_DESIGN_THEMES.map((t) => t.id).join(', ')}` };
        const applyToAll = request?.applyToAll !== false;
        recordForUndo();
        if (applyToAll) {
          setSlides((prev) => applyDesignThemeToSlides(prev, theme));
        } else {
          const idx = slideIndex();
          if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
          setSlides((prev) => prev.map((s, i) => (i === idx ? applyDesignThemeToSlide(s, theme) : s)));
        }
        return { ok: true, theme: theme.id, applied: applyToAll ? 'all' : slideIndex() };
      }

      case 'pptx.polishDesign': {
        const themeId = String(request?.theme || '').trim();
        const theme = themeId ? getPptxDesignTheme(themeId) : selectedDesignTheme;
        if (!theme) return { ok: false, error: `unknown theme: ${themeId}. Available: ${PPTX_DESIGN_THEMES.map((t) => t.id).join(', ')}` };
        const applyToAll = request?.applyToAll !== false;
        recordForUndo();
        let nextSlides: Slide[];
        if (applyToAll) {
          nextSlides = polishDeckDesign(slides, theme);
        } else {
          const idx = slideIndex();
          if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
          nextSlides = slides.map((s, i) => (i === idx ? polishSlideDesign(s, theme, i, slides.length) : s));
        }
        const audit = auditDeckDesign(nextSlides);
        setSlides(nextSlides);
        setDesignerStatus(`Design score ${audit.score}/100 · polished via agent`);
        return { ok: true, theme: theme.id, applied: applyToAll ? 'all' : slideIndex(), designScore: audit.score };
      }

      case 'pptx.setTransition': {
        const idx = slideIndex();
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        const type = String(request?.transition || 'none');
        if (!PPTX_TRANSITION_TYPES.some((t) => t.id === type)) {
          return { ok: false, error: `unknown transition: ${type} (${PPTX_TRANSITION_TYPES.map((t) => t.id).join('/')})` };
        }
        const applyToAll = !!request?.applyToAll;
        const transition = normalizeSlideTransition({
          type: type as SlideTransition['type'],
          durationMs: Number(request?.durationMs) || undefined,
          advanceAfterSec: Number(request?.advanceAfterSec) || undefined,
        });
        recordForUndo();
        setSlides((prev) => prev.map((s, i) => (applyToAll || i === idx ? { ...s, transition } : s)));
        return { ok: true, slide: applyToAll ? 'all' : idx, transition: type };
      }

      case 'pptx.duplicateSlide': {
        const idx = slideIndex();
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        recordForUndo();
        const clone: Slide = {
          ...slides[idx],
          id: uid(),
          elements: slides[idx].elements.map((el) => ({ ...el, id: elId() })),
        };
        setSlides((prev) => [...prev.slice(0, idx + 1), clone, ...prev.slice(idx + 1)]);
        setCurrentSlideIdx(idx + 1);
        return { ok: true, index: idx + 1 };
      }

      case 'pptx.deleteSlide': {
        const idx = slideIndex();
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        if (slides.length <= 1) return { ok: false, error: 'cannot delete the only slide' };
        recordForUndo();
        setSlides((prev) => prev.filter((_, i) => i !== idx));
        setCurrentSlideIdx((cur) => Math.max(0, Math.min(cur, slides.length - 2)));
        return { ok: true, deleted: idx, count: slides.length - 1 };
      }

      case 'pptx.moveSlide': {
        const from = slideIndex();
        if (from < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        const rawTo = Number(request?.to);
        if (!Number.isInteger(rawTo) || rawTo < 0 || rawTo >= slides.length) {
          return { ok: false, error: `target index out of range: ${request?.to}` };
        }
        if (from === rawTo) return { ok: true, from, to: rawTo };
        recordForUndo();
        setSlides((prev) => {
          const next = [...prev];
          const [moved] = next.splice(from, 1);
          next.splice(rawTo, 0, moved);
          return next;
        });
        setCurrentSlideIdx(rawTo);
        return { ok: true, from, to: rawTo };
      }

      case 'pptx.listElements': {
        const idx = slideIndex();
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        return {
          ok: true,
          slide: idx,
          elements: slides[idx].elements.map((el) => ({
            id: el.id, type: el.type,
            x: el.x, y: el.y, w: el.w, h: el.h,
            text: el.text ?? undefined,
          })),
        };
      }

      case 'pptx.updateElement': {
        const idx = slideIndex();
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        const elementId = String(request?.elementId || '');
        if (!elementId) return { ok: false, error: 'elementId required' };
        const target = slides[idx].elements.find((el) => el.id === elementId);
        if (!target) return { ok: false, error: `element not found: ${elementId}` };
        recordForUndo();
        setSlides((prev) => prev.map((s, i) => {
          if (i !== idx) return s;
          return {
            ...s,
            elements: s.elements.map((el) => {
              if (el.id !== elementId) return el;
              const next = { ...el };
              if (request?.text != null) next.text = String(request.text);
              if (request?.x != null) next.x = clampPct(request.x, el.x);
              if (request?.y != null) next.y = clampPct(request.y, el.y);
              if (request?.w != null) next.w = clampPct(request.w, el.w);
              if (request?.h != null) next.h = clampPct(request.h, el.h);
              if (request?.fontSize != null) next.fontSize = Number(request.fontSize) || el.fontSize;
              if (request?.color != null) next.fontColor = String(request.color);
              if (request?.fillColor != null) next.fillColor = String(request.fillColor);
              if (request?.bold != null) next.bold = !!request.bold;
              if (request?.italic != null) next.italic = !!request.italic;
              if ((['left', 'center', 'right'] as const).includes(request?.align)) next.textAlign = request.align;
              if (typeof request?.fontFamily === 'string') next.fontFamily = request.fontFamily;
              return next;
            }),
          };
        }));
        setCurrentSlideIdx(idx);
        return { ok: true, slide: idx, id: elementId };
      }

      case 'pptx.deleteElement': {
        const idx = slideIndex();
        if (idx < 0) return { ok: false, error: `slide index out of range: ${request?.slide}` };
        const elementId = String(request?.elementId || '');
        if (!elementId) return { ok: false, error: 'elementId required' };
        const exists = slides[idx].elements.some((el) => el.id === elementId);
        if (!exists) return { ok: false, error: `element not found: ${elementId}` };
        recordForUndo();
        setSlides((prev) => prev.map((s, i) => (i === idx ? { ...s, elements: s.elements.filter((el) => el.id !== elementId) } : s)));
        setCurrentSlideIdx(idx);
        return { ok: true, slide: idx, deleted: elementId };
      }


      default:
        return { ok: false, error: `unknown pptx cmd: ${cmd}` };
    }
  };

  useEffect(() => {
    const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const handler = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { reqId?: string; path?: string; cmd?: string; request?: any } | undefined;
      if (!d || normPath(String(d.path || '')) !== normPath(filePath)) return;
      const reqId = d.reqId;
      Promise.resolve(pptxBridgeHandlerRef.current(String(d.cmd || ''), d.request || {}))
        .then((result) => {
          window.dispatchEvent(new CustomEvent('octo-pptx-result', { detail: { reqId, result } }));
        })
        .catch((e: any) => {
          window.dispatchEvent(new CustomEvent('octo-pptx-result', { detail: { reqId, result: { ok: false, error: String(e?.message || e) } } }));
        });
    };
    window.addEventListener('octo-pptx-command', handler);
    return () => window.removeEventListener('octo-pptx-command', handler);
  }, [filePath]);

  // ─── Selected element ───────────────────────────────────────

  const selectedEl = selectedElementId
    ? currentSlide.elements.find((e) => e.id === selectedElementId) || null
    : null;

  // Guides to draw: live snap lines while dragging, otherwise the static centre
  // indicator when a single element sits on a slide midline.
  // 리본 Home의 글꼴 그룹 대상: 텍스트를 담는 요소가 단일 선택된 경우.
  // 테이블도 포함 — 셀 글자가 요소 fontSize를 따르므로 크기/글꼴을 리본에서 조절한다.
  const selectedTextEl =
    selectedEl
    && (selectedEl.type === 'text' || selectedEl.type === 'rect' || selectedEl.type === 'circle' || selectedEl.type === 'table')
      ? selectedEl
      : null;

  const guideLines = (() => {
    if (activeGuides.vLines.length || activeGuides.hLines.length) {
      return { vLines: activeGuides.vLines, hLines: activeGuides.hLines };
    }
    const vLines: number[] = [];
    const hLines: number[] = [];
    if (selectedEl) {
      const centerX = selectedEl.x + selectedEl.w / 2;
      const centerY = selectedEl.y + selectedEl.h / 2;
      if (Math.abs(centerX - 50) <= 1.5) vLines.push(50);
      if (Math.abs(centerY - 50) <= 1.5) hLines.push(50);
    }
    return { vLines, hLines };
  })();

  const startTableCellEdit = (elId: string, row: number, col: number) => {
    setSelectedElementIds([elId]);
    setEditingTableCell({ elId, row, col });
  };

  // ─── Render options for SlideElements ───────────────────────

  // PowerPoint semantics: a text box left EMPTY when editing ends is removed —
  // otherwise invisible boxes pile up on the slide and in the exported file.
  const finishTextEdit = (elId: string, text: string) => {
    setEditingTextId(null);
    if (!elId) return;
    if (!text.trim()) {
      const el = slides[currentSlideIdx]?.elements.find((item) => item.id === elId);
      if (el && el.type === 'text') {
        updateCurrentSlide((s) => ({ ...s, elements: s.elements.filter((item) => item.id !== elId) }));
        setSelectedElementId(null);
        setSelectedElementIds([]);
      }
    }
  };

  const renderOpts = {
    isPresentation: false,
    // 편집기 페인이 짧아 캔버스가 줄면 글자도 함께 줄어야 겹치지 않는다.
    fontScale: canvasSize.w / CANVAS_MAX_W,
    // 실제 슬라이드 기하 기준 px/pt — 파싱된 파일이 PowerPoint와 같은 지점에서
    // 줄바꿈되도록 한다 (13.33in 슬라이드 = 960pt).
    pxPerPt: canvasSize.w / (slideSize.widthInch * 72),
    selectedElementId,
    selectedIds: selectedElementIds,
    editingTextId,
    onMouseDown: handleElementMouseDown,
    onResizeMouseDown: handleResizeMouseDown,
    onRotateMouseDown: handleRotateMouseDown,
    onDoubleClick: (elId: string) => setEditingTextId(elId),
    onTextChange: (elId: string, text: string) => updateElementWithHistory(elId, { text }),
    onTextBlur: finishTextEdit,
    editingTableCell,
    onTableCellDoubleClick: startTableCellEdit,
    onTableCellChange: setTableCell,
    onTableCellBlur: () => setEditingTableCell(null),
  };

  const presentOpts = {
    ...renderOpts,
    isPresentation: true,
    // 프레젠 캔버스는 CSS 유동 크기라 편집 캔버스의 px/pt를 그대로 쓰면 틀린다
    pxPerPt: undefined,
    presentationEditable: presentationEditing,
    selectedElementId: presentationEditing ? selectedElementId : null,
    selectedIds: presentationEditing ? selectedElementIds : [],
    editingTextId: presentationEditing ? editingTextId : null,
    onMouseDown: presentationEditing ? handleElementMouseDown : () => {},
    onResizeMouseDown: presentationEditing ? handleResizeMouseDown : () => {},
    onRotateMouseDown: presentationEditing ? handleRotateMouseDown : undefined,
    onDoubleClick: presentationEditing ? ((elId: string) => setEditingTextId(elId)) : () => {},
    onTextChange: presentationEditing ? ((elId: string, text: string) => updateElementWithHistory(elId, { text })) : () => {},
    onTextBlur: presentationEditing ? finishTextEdit : () => {},
    editingTableCell: presentationEditing ? editingTableCell : null,
    onTableCellDoubleClick: presentationEditing ? startTableCellEdit : undefined,
    onTableCellChange: presentationEditing ? setTableCell : undefined,
    onTableCellBlur: presentationEditing ? (() => setEditingTableCell(null)) : undefined,
  };
  const currentRehearsalSlide = rehearsalReport.slideReports.find((report) => report.slideIndex === currentSlideIdx) || null;
  const rehearsalIssueSlides = rehearsalReport.slideReports.filter((report) => report.issues.length > 0);

  // ─── Presentation mode ──────────────────────────────────────

  if (presenting) {
    const slide = slides[currentSlideIdx];
    const nextSlide = slides[presenterInfo.nextIdx];
    const presentSteps = buildAnimationSteps(slide);
    const previousDisabled = presenterInfo.previousIdx === currentSlideIdx && presentStep === 0;
    const nextDisabled = presenterInfo.nextIdx === currentSlideIdx && presentStep >= presentSteps.length;
    const renderPresentElements = () => slide.elements.map((el) => {
      if (!presentationEditing && !isElementRevealed(el, presentStep, presentSteps)) return null;
      const node = renderSlideElement(el, presentOpts);
      if (el.animation && animNowIds.has(el.id)) {
        return (
          <div
            key={`px-anim-${el.id}`}
            className={animationClass(el.animation.effect)}
            style={{ position: 'absolute', inset: 0, animationDuration: `${el.animation.durationMs ?? DEFAULT_ANIMATION_MS}ms` }}
          >
            {node}
          </div>
        );
      }
      return node;
    });
    // 발표 화면은 document.body 포털로 띄운다 — 에디터 패널의 transform/overflow
    // 조상에 갇히지 않는 진짜 "별도 모드" 최상위 레이어.
    return createPortal(
      <div
        ref={presentationRef}
        className={`px-presentation ${presenterMode ? 'presenter' : ''} ${presentationBlackout ? 'blackout' : ''} ${presentationCursorHidden ? 'cursor-hidden' : ''}`}
        onClick={(e) => {
          if (presentationEditing || presenterMode || presentationBlackout) return;
          const rect = (e.target as HTMLElement).closest('.px-presentation')?.getBoundingClientRect();
          if (!rect) return;
          if (e.clientX < rect.width / 2) goToPresentationSlide(-1);
          else goToPresentationSlide(1);
        }}
      >
        {presentationBlackout ? (
          <div className="px-presentation-blackout">{L('블랙아웃', 'Blackout')}</div>
        ) : presenterMode ? (
          <div className="px-presenter-console">
            <div className="px-presenter-main">
              <div
                className={`px-presentation-slide ${slideTransitionClass(slide.transition)}`}
                style={{
                  aspectRatio: `${slideSize.aspectRatio}`,
                  animationDuration: `${currentTransition.durationMs}ms`,
                  ...slideBgStyle(slide),
                  cursor: presentationEditing ? 'default' : 'inherit',
                }}
                key={`${slide.id}:${slideTransitionClass(slide.transition)}:presenter`}
                ref={slideRef}
                onDragOver={presentationEditing ? (e) => e.preventDefault() : undefined}
                onDrop={presentationEditing ? handleCanvasDrop : undefined}
              >
                {renderPresentElements()}
              </div>
            </div>
            <aside className="px-presenter-panel">
              <div className="px-presenter-topline">
                <span>{L('발표자', 'Presenter')}</span>
                <strong>{elapsedPresentationTime}</strong>
              </div>
              <div className="px-presenter-title">{presenterInfo.currentTitle}</div>
              <div className="px-presenter-progress">
                <div style={{ width: `${presenterInfo.progressPct}%` }} />
              </div>
              <div className="px-presenter-meta">
                {L('슬라이드', 'Slide')} {presenterInfo.currentPosition + 1} / {presenterInfo.totalVisible}
                {hiddenSlideCount > 0 ? L(` · ${hiddenSlideCount} 숨김`, ` · ${hiddenSlideCount} hidden`) : ''}
                {L(` · 리허설 ${rehearsalReport.score}/100`, ` · Rehearsal ${rehearsalReport.score}/100`)}
              </div>
              <div className="px-presenter-section">
                <div className="px-presenter-section-title">{L('다음', 'Next')}</div>
                <div className="px-presenter-next-title">{presenterInfo.nextTitle}</div>
                {nextSlide && presenterInfo.nextIdx !== currentSlideIdx && (
                  <div className="px-presenter-next-preview" style={{ ...slideBgStyle(nextSlide), aspectRatio: `${slideSize.aspectRatio}` }}>
                    <div className="px-thumb-preview-inner">
                      {nextSlide.elements.map((el) => renderThumbElement(el))}
                    </div>
                  </div>
                )}
              </div>
              <div className="px-presenter-section notes">
                <div className="px-presenter-section-title">{L('발표자 노트', 'Speaker Notes')}</div>
                <div className="px-presenter-notes">
                  {presenterInfo.notes || L('이 슬라이드에 발표자 노트가 없습니다.', 'No speaker notes for this slide.')}
                </div>
              </div>
              <div className="px-presenter-section">
                <div className="px-presenter-section-title">{L('발표 큐', 'Speaker Cues')}</div>
                <div className="px-presenter-cues">
                  <div><strong>{L('오프닝', 'Open')}</strong><span>{presenterCueCard.opening}</span></div>
                  <div><strong>{L('포커스', 'Focus')}</strong><span>{presenterCueCard.focus}</span></div>
                  <div><strong>{L('브릿지', 'Bridge')}</strong><span>{presenterCueCard.bridge}</span></div>
                  <div><strong>{L('컷', 'Cut')}</strong><span>{presenterCueCard.cutLine}</span></div>
                </div>
              </div>
              <div className="px-presenter-section">
                <div className="px-presenter-section-title">{L('라이브 코치', 'Live Coach')}</div>
                <div className={`px-presenter-live-coach ${presenterLiveCoach.confidence}`}>
                  <div className="px-presenter-live-headline">
                    <strong>{presenterLiveCoach.headline}</strong>
                    <span>{currentRehearsalSlide ? formatRehearsalDuration(currentRehearsalSlide.estimatedSeconds) : '0:00'}</span>
                  </div>
                  <div className="px-presenter-live-detail">{presenterLiveCoach.detail}</div>
                  <div className="px-presenter-live-action">
                    <strong>{L('다음 행동', 'Next move')}</strong>
                    <span>{presenterLiveCoach.nextAction}</span>
                  </div>
                </div>
              </div>
              <div className="px-presenter-section">
                <div className="px-presenter-section-title">{L('진행 흐름', 'Show Flow')}</div>
                <div className="px-presenter-flow">
                  {presenterLiveCoach.flow.map((item) => (
                    <div className={`px-presenter-flow-row ${item.status}`} key={item.slideIndex}>
                      <div className="px-presenter-flow-main">
                        <span>{item.status === 'current' ? L('현재', 'Now') : item.status === 'next' ? L('다음', 'Next') : item.status === 'done' ? L('완료', 'Done') : `S${item.slideIndex + 1}`}</span>
                        <strong>{item.title}</strong>
                      </div>
                      <div className="px-presenter-flow-meta">
                        <span>{formatPresentationDuration(item.plannedStartSeconds * 1000)}-{formatPresentationDuration(item.plannedEndSeconds * 1000)}</span>
                        {item.issueCount > 0 && <em>{L(`${item.issueCount} 위험`, `${item.issueCount} risk`)}</em>}
                        {!item.hasNotes && <em>{L('노트 없음', 'No notes')}</em>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="px-presenter-section">
                <div className="px-presenter-section-title">{L('페이싱', 'Pacing')}</div>
                <div className={`px-presenter-pacing ${presenterPacingInfo.status}`}>
                  <strong>{presenterPacingInfo.label}</strong>
                  <span>{presenterPacingInfo.detail}</span>
                  <small>{L('남은 시간', 'Remaining')} {formatPresentationDuration(presenterPacingInfo.remainingSeconds * 1000)}</small>
                </div>
              </div>
              <div className="px-presenter-actions">
                <button onClick={(e) => { e.stopPropagation(); goToSlide(presenterInfo.previousIdx); }} disabled={previousDisabled}>{L('이전', 'Prev')}</button>
                <button onClick={(e) => { e.stopPropagation(); goToSlide(presenterInfo.nextIdx); }} disabled={nextDisabled}>{L('다음', 'Next')}</button>
                <button onClick={(e) => { e.stopPropagation(); setPresentationBlackout(true); }}>{L('블랙', 'Black')}</button>
                <button onClick={(e) => { e.stopPropagation(); setPresentationStartedAt(Date.now()); setNow(Date.now()); }}>
                  <TimerReset size={13} /> {L('리셋', 'Reset')}
                </button>
              </div>
            </aside>
          </div>
        ) : (
          <div
            className={`px-presentation-slide ${slideTransitionClass(slide.transition)}`}
            style={{
              width: '100vw',
              height: `${100 / slideSize.aspectRatio}vw`,
              maxHeight: '100vh',
              maxWidth: `${100 * slideSize.aspectRatio}vh`,
              animationDuration: `${currentTransition.durationMs}ms`,
              ...slideBgStyle(slide),
              cursor: presentationEditing ? 'default' : 'inherit',
            }}
            key={`${slide.id}:${slideTransitionClass(slide.transition)}:audience`}
            ref={slideRef}
            onDragOver={presentationEditing ? (e) => e.preventDefault() : undefined}
            onDrop={presentationEditing ? handleCanvasDrop : undefined}
          >
            {renderPresentElements()}
          </div>
        )}
        <div className="px-presentation-nav">
          <button onClick={(e) => { e.stopPropagation(); setPresentationEditing((prev) => !prev); }}>
            {presentationEditing ? L('편집 완료', 'Done Edit') : L('편집', 'Edit')}
          </button>
          {presentationEditing && (
            <>
              <button onClick={(e) => { e.stopPropagation(); addElement('text'); }}>+{L('텍스트', 'Text')}</button>
              <button onClick={(e) => { e.stopPropagation(); addImageElement(); }}>+{L('이미지', 'Image')}</button>
            </>
          )}
          <button onClick={(e) => { e.stopPropagation(); moveSlide(currentSlideIdx, currentSlideIdx - 1); }} disabled={currentSlideIdx === 0}>{L('위로', 'Up')}</button>
          <button onClick={(e) => { e.stopPropagation(); moveSlide(currentSlideIdx, currentSlideIdx + 1); }} disabled={currentSlideIdx >= slides.length - 1}>{L('아래로', 'Down')}</button>
          <button onClick={(e) => { e.stopPropagation(); setPresenterMode((prev) => !prev); }}>
            {presenterMode ? L('청중', 'Audience') : L('발표자', 'Presenter')}
          </button>
          <button onClick={(e) => { e.stopPropagation(); setPresentationBlackout((prev) => !prev); }}>{L('블랙', 'Black')}</button>
          <button onClick={(e) => { e.stopPropagation(); togglePresentationFullscreen(); }}>{L('전체화면', 'Full')}</button>
          <button onClick={(e) => { e.stopPropagation(); goToPresentationSlide(-1); }} disabled={previousDisabled}>{L('이전', 'Prev')}</button>
          <span style={{ color: '#fff', fontSize: 13, lineHeight: '32px' }}>{currentSlideIdx + 1} / {slides.length}</span>
          <button onClick={(e) => { e.stopPropagation(); goToPresentationSlide(1); }} disabled={nextDisabled}>{L('다음', 'Next')}</button>
          <button onClick={(e) => { e.stopPropagation(); stopPresentation(); }}>ESC</button>
        </div>
      </div>,
      document.body,
    );
  }

  // ─── Main editor render ─────────────────────────────────────

  return (
    <div className="px-editor" ref={editorRootRef} style={{ color: OFFICE_UI.text, background: OFFICE_UI.bg, ['--px-accent' as string]: OFFICE_UI.accent, ['--px-bg' as string]: OFFICE_UI.bg, ['--px-text' as string]: OFFICE_UI.text } as React.CSSProperties}>
      <div className="px-ribbon">
        <div className="px-ribbon-tabs">
          {PPTX_RIBBON_TABS.map((tab) => (
            <button
              key={tab}
              className={`px-ribbon-tab ${activeRibbonTab === tab ? 'active' : ''}`}
              onClick={() => setActiveRibbonTab(tab)}
            >
              {tab}
            </button>
          ))}
          {/* 상시 컨트롤: 보기 전환 · 저장 — 탭을 뒤지지 않아도 항상 보인다. */}
          <span className="px-ribbon-right">
            <button className={`px-btn ${workbenchMode === 'design' ? 'active' : ''}`} onClick={() => setWorkbenchMode('design')} title={L('디자인 보기', 'Design view')}><LayoutGrid size={13} /></button>
            <button className={`px-btn ${workbenchMode === 'markdown' ? 'active' : ''}`} onClick={() => setWorkbenchMode('markdown')} title={L('마크다운 보기', 'Markdown view')}><FileText size={13} /></button>
            <button className={`px-btn ${workbenchMode === 'overview' ? 'active' : ''}`} onClick={() => setWorkbenchMode('overview')} title={L('슬라이드 개요', 'Slide overview')}><Search size={13} /></button>
            <button className="px-btn" onClick={() => handleSave(true)} disabled={saving} title={L('다른 이름으로 저장', 'Save as')}><SaveAll size={13} /></button>
            <button className="px-btn px-btn-primary" onClick={() => handleSave()} disabled={saving} title={L('저장 (Cmd+S)', 'Save (Cmd+S)')}>
              <Save size={13} /> {saving ? L('저장 중...', 'Saving...') : L('저장', 'Save')}
            </button>
            <span className={`px-modified-indicator ${modified ? 'dirty' : 'clean'}`} title={modified ? 'You have unsaved changes' : 'All changes saved'}>
              {modified ? '●' : '✓'}
            </span>
          </span>
        </div>

        <div
          className="px-toolbar"
          // 인라인 텍스트 편집 중 리본 버튼을 실제 마우스로 누르면 mousedown이 편집
          // textarea를 blur시켜 커밋 리렌더로 click이 유실된다 — 버튼류는 포커스를
          // 뺏지 않게 해서 선택/편집 상태를 유지한 채 click이 도달하게 한다.
          onMouseDown={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest('button, label')) e.preventDefault();
          }}
        >
          {activeRibbonTab === 'Home' && (
            <>
              <div className="px-toolbar-group" data-group={L('실행 취소', 'Undo')}>
                <button className="px-btn" onClick={handleUndo} disabled={!canUndo} title={L('실행 취소 (Cmd+Z)', 'Undo (Cmd+Z)')}><Undo2 size={13} /></button>
                <button className="px-btn" onClick={handleRedo} disabled={!canRedo} title={L('다시 실행 (Cmd+Shift+Z)', 'Redo (Cmd+Shift+Z)')}><Redo2 size={13} /></button>
              </div>
              <div className="px-toolbar-sep" />
              <div className="px-toolbar-group" data-group={L('슬라이드', 'Slides')}>
                <div className="px-slide-preset-control">
                  <button className="px-btn" onClick={() => addSlideFromPreset(presetIdx)} title={L(`${selectedSlidePreset?.label || '선택한'} 레이아웃으로 새 슬라이드`, `New slide with the ${selectedSlidePreset?.label || 'selected'} layout`)}><Plus size={13} /> {L('슬라이드', 'Slide')}</button>
                  <select
                    className="px-preset-select px-slide-preset-select"
                    value={presetIdx}
                    onChange={(e) => setPresetIdx(Number(e.target.value))}
                    title={L('새 슬라이드 레이아웃', 'New slide layout')}
                  >
                    {SLIDE_PRESETS.map((preset, idx) => (
                      <option key={preset.label} value={idx}>{preset.label}</option>
                    ))}
                  </select>
                  <div className="px-slide-preset-popover" aria-hidden="true">
                    <div className="px-slide-preset-popover-canvas" style={{ ...slideBgStyle(slidePresetPreview), aspectRatio: `${slideSize.aspectRatio}` }}>
                      <div className="px-thumb-preview-inner">
                        {slidePresetPreview.elements.map((el) => renderThumbElement(el))}
                      </div>
                    </div>
                    <div className="px-slide-preset-popover-label">{selectedSlidePreset.label}</div>
                  </div>
                </div>
                <button className="px-btn" onClick={duplicateSlide} title={L('현재 슬라이드 복제', 'Duplicate current slide')}><Copy size={13} /></button>
                <button className="px-btn px-btn-danger" onClick={deleteSlide} disabled={slides.length <= 1} title={L('현재 슬라이드 삭제', 'Delete current slide')}><Trash2 size={13} /></button>
              </div>
              <div className="px-toolbar-sep" />
              {/* 텍스트 서식 — 요소를 선택하면 바로 여기서 (핵심 흐름이 우측 패널 스크롤 밑에 묻혀 있었다) */}
              <div className="px-toolbar-group" data-group={L('글꼴', 'Font')}>
                <select
                  className="px-preset-select"
                  disabled={!selectedTextEl}
                  value={selectedTextEl?.fontFamily || 'Sans-serif'}
                  onChange={(e) => selectedTextEl && updateElementWithHistory(selectedTextEl.id, { fontFamily: e.target.value })}
                  title={L('글꼴', 'Font family')}
                >
                  {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <input
                  className="px-font-size-input"
                  type="number" min={6} max={120}
                  disabled={!selectedTextEl}
                  value={selectedTextEl?.fontSize || 18}
                  onChange={(e) => {
                    // A cleared field parses to NaN/0 → invisible 0px text. Ignore
                    // until a real number is typed, then clamp to the input range.
                    const n = Number(e.target.value);
                    if (!selectedTextEl || !Number.isFinite(n) || n <= 0) return;
                    updateElementWithHistory(selectedTextEl.id, { fontSize: Math.max(6, Math.min(120, n)) });
                  }}
                  title={L('글자 크기', 'Font size')}
                />
                <button className={`px-btn ${selectedTextEl?.bold ? 'active' : ''}`} disabled={!selectedTextEl} onClick={() => selectedTextEl && updateElementWithHistory(selectedTextEl.id, { bold: !selectedTextEl.bold })} title={L('굵게', 'Bold')}><strong>B</strong></button>
                <button className={`px-btn ${selectedTextEl?.italic ? 'active' : ''}`} disabled={!selectedTextEl} onClick={() => selectedTextEl && updateElementWithHistory(selectedTextEl.id, { italic: !selectedTextEl.italic })} title={L('기울임', 'Italic')}><em>I</em></button>
                <input
                  type="color"
                  className="px-font-color-input"
                  disabled={!selectedTextEl}
                  value={selectedTextEl?.fontColor || '#111111'}
                  onChange={(e) => selectedTextEl && updateElementWithHistory(selectedTextEl.id, { fontColor: e.target.value })}
                  title={L('글자 색', 'Text color')}
                />
                <button className={`px-btn ${(selectedTextEl?.textAlign || 'left') === 'left' ? 'active' : ''}`} disabled={!selectedTextEl} onClick={() => selectedTextEl && updateElementWithHistory(selectedTextEl.id, { textAlign: 'left' })} title={L('왼쪽 정렬', 'Align left')}><AlignLeft size={13} /></button>
                <button className={`px-btn ${selectedTextEl?.textAlign === 'center' ? 'active' : ''}`} disabled={!selectedTextEl} onClick={() => selectedTextEl && updateElementWithHistory(selectedTextEl.id, { textAlign: 'center' })} title={L('가운데 정렬', 'Align center')}><AlignCenter size={13} /></button>
                <button className={`px-btn ${selectedTextEl?.textAlign === 'right' ? 'active' : ''}`} disabled={!selectedTextEl} onClick={() => selectedTextEl && updateElementWithHistory(selectedTextEl.id, { textAlign: 'right' })} title={L('오른쪽 정렬', 'Align right')}><AlignRight size={13} /></button>
              </div>
              <div className="px-toolbar-sep" />
              <div className="px-toolbar-group" data-group={L('이동', 'Navigate')}>
                <button className="px-btn" onClick={() => goToSlide(currentSlideIdx - 1)} disabled={currentSlideIdx === 0} title={L('이전 슬라이드', 'Previous slide')}><ChevronLeft size={13} /></button>
                <span className="px-ribbon-stat">{currentSlideIdx + 1} / {slides.length}</span>
                <button className="px-btn" onClick={() => goToSlide(currentSlideIdx + 1)} disabled={currentSlideIdx >= slides.length - 1} title={L('다음 슬라이드', 'Next slide')}><ChevronRight size={13} /></button>
                <button className={`px-btn ${snapEnabled ? 'active' : ''}`} onClick={() => setSnapEnabled((v) => !v)} title={L('격자 맞춤', 'Grid snap')}><Grid3X3 size={13} /></button>
              </div>
            </>
          )}

          {activeRibbonTab === 'Insert' && (
            <>
              <div className="px-toolbar-group" data-group={L('요소', 'Elements')}>
                <button className="px-btn" onClick={() => addElement('text')} title={L('텍스트 상자', 'Text box')}><Type size={13} /> {L('텍스트', 'Text')}</button>
                <button className="px-btn" onClick={addImageElement} title={L('이미지 삽입', 'Insert image')}><ImageIcon size={13} /> {L('이미지', 'Image')}</button>
                <button className="px-btn" onClick={addTableElement} title={L('표 삽입', 'Insert table')}><Table2 size={13} /> {L('표', 'Table')}</button>
                <button className="px-btn" onClick={addSmartBarChartElement} title={L('편집 가능한 막대 차트 삽입', 'Insert editable bar chart')}><BarChart3 size={13} /> {L('차트', 'Chart')}</button>
              </div>
              <div className="px-toolbar-sep" />
              <div className="px-toolbar-group" data-group={L('도형', 'Shapes')}>
                <button className="px-btn" onClick={() => addElement('rect')} title={L('사각형', 'Rectangle')}><Square size={13} /></button>
                <button className="px-btn" onClick={() => addElement('circle')} title={L('원', 'Circle')}><Circle size={13} /></button>
                <button className="px-btn" onClick={() => addElement('triangle')} title={L('삼각형', 'Triangle')}><Triangle size={13} /></button>
                <button className="px-btn" onClick={() => addElement('star')} title={L('별', 'Star')}><Star size={13} /></button>
                <button className="px-btn" onClick={() => addElement('arrow')} title={L('화살표', 'Arrow')}><ArrowRight size={13} /></button>
                <button className="px-btn" onClick={() => addElement('line')} title={L('선', 'Line')}><Minus size={13} /></button>
              </div>
              <div className="px-toolbar-sep" />
              {/* 발표 보조 문서(아젠다/Q&A/핸드아웃 등) 생성 — 개별 버튼 8개 대신 메뉴 하나로 */}
              <div className="px-toolbar-group" data-group={L('문서 팩', 'Packs')}>
                <select
                  className="px-preset-select"
                  value=""
                  onChange={(e) => {
                    const run = {
                      agenda: insertAgenda, board: insertBoardPack, qa: insertQAPack,
                      drill: insertAudienceDrill, handout: insertHandout, investor: insertInvestorPack,
                      runofshow: insertRunOfShow, script: insertScriptPack, notes: generateSpeakerNotes,
                    }[e.target.value];
                    run?.();
                  }}
                  title={L('현재 덱에서 발표 보조 슬라이드 생성', 'Generate presenter-support slides from the current deck')}
                >
                  <option value="" disabled>{L('+ 문서 팩...', '+ Insert pack...')}</option>
                  <option value="agenda">{L('아젠다', 'Agenda')}</option>
                  <option value="qa">{L('Q&A 방어 맵', 'Q&A defense map')}</option>
                  <option value="handout">{L('핸드아웃', 'Handout')}</option>
                  <option value="investor">{L('투자자 팩', 'Investor pack')}</option>
                  <option value="board">{L('이사회 팩', 'Board pack')}</option>
                  <option value="drill">{L('질문 드릴', 'Question drill')}</option>
                  <option value="runofshow">{L('진행표', 'Run of show')}</option>
                  <option value="script">{L('발표 대본', 'Script')}</option>
                  <option value="notes">{L('발표자 노트 생성', 'Generate speaker notes')}</option>
                </select>
              </div>
            </>
          )}

          {activeRibbonTab === 'Design' && (
            <>
              {/* ── 1. 디자인 선택 (한 번에 전체 덱 스타일 바꾸기) ── */}
              <div className="px-toolbar-group" data-group={L('1. 디자인 선택', '1. Pick a Design')}>
                <LayoutGrid size={13} />
                <select
                  className="px-preset-select px-deck-select"
                  value={designPresetPackId}
                  onChange={(e) => setDesignPresetPackId(e.target.value)}
                  title={selectedDesignPresetPack.description}
                >
                  {PPTX_DESIGN_PRESET_PACKS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                </select>
                <div className="px-design-preview-popover-wrap">
                  <button className="px-btn" type="button" title={L('미리보기', 'Preview')}><Eye size={13} /></button>
                  <div className="px-design-preview-popover">
                    <div className="px-design-preview-title">{selectedDesignPresetPack.label}</div>
                    <div className="px-design-preview-grid">
                      {selectedDesignPresetPreviewSlides.map((slide, idx) => (
                        <div className="px-design-preview-slide" key={`${slide.id}-${idx}`} style={{ ...slideBgStyle(slide), aspectRatio: `${slideSize.aspectRatio}` }}>
                          <div className="px-thumb-preview-inner">
                            {slide.elements.map((el) => renderThumbElement(el))}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="px-design-preview-desc">{selectedDesignPresetPack.description}</div>
                  </div>
                </div>
                <button className="px-btn px-btn-primary" onClick={replaceDeckWithDesignPresetPack} title={L(`'${selectedDesignPresetPack.label}' 스타일로 전체 덱 바꾸기`, `Replace entire deck with ${selectedDesignPresetPack.label} style`)}>
                  ✨ {L('전체 적용', 'Apply All')}
                </button>
                <button className="px-btn" onClick={appendDesignPresetPack} title={L(`'${selectedDesignPresetPack.label}' 슬라이드를 현재 덱 뒤에 추가`, `Append ${selectedDesignPresetPack.label} slides`)}>
                  {L('+슬라이드 추가', '+Add Slides')}
                </button>
                <button className="px-btn" onClick={selectSmartDesignPreset} title={L(`AI 추천: ${smartPreset.label}`, `AI recommends: ${smartPreset.label}`)}>
                  <Sparkles size={13} /> {L('AI 추천', 'Smart')}
                </button>
              </div>
              <div className="px-toolbar-sep" />
              {/* ── 2. 색상 & 테마 (디자인 적용 후 세부 조정) ── */}
              <div className="px-toolbar-group" data-group={L('2. 색상 테마', '2. Color Theme')}>
                <Palette size={13} />
                <select
                  className="px-preset-select px-theme-select px-slide-theme-select"
                  value={designThemeId}
                  onChange={(e) => changeCurrentSlideDesignTheme(e.target.value)}
                  title={L(`현재 슬라이드 색상 변경 · ${selectedDesignTheme.description}`, `Change slide colors · ${selectedDesignTheme.description}`)}
                >
                  {PPTX_DESIGN_THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.label}</option>)}
                </select>
                <span className="px-theme-swatches" aria-hidden="true">
                  <span style={{ background: selectedDesignTheme.primaryColor }} />
                  <span style={{ background: selectedDesignTheme.accentColor }} />
                  <span style={{ background: selectedDesignTheme.surfaceColor }} />
                </span>
                <button className="px-btn" onClick={applySelectedThemeToCurrentSlide} title={L('선택한 색상을 현재 슬라이드에만 적용', 'Apply colors to this slide only')}>
                  {L('이 슬라이드', 'This Slide')}
                </button>
                <button className="px-btn" onClick={applySelectedThemeToDeck} title={L('선택한 색상을 전체 덱에 적용', 'Apply colors to all slides')}>
                  {L('전체 적용', 'All Slides')}
                </button>
              </div>
              <div className="px-toolbar-sep" />
              {/* ── 3. AI 다듬기 (디자인 점수 기반 자동 정리) ── */}
              <div className="px-toolbar-group" data-group={L('3. AI 다듬기', '3. AI Polish')}>
                <span style={{ fontSize: 11, opacity: 0.6, marginRight: 4 }}>{deckDesignAudit.score}/100</span>
                <button className="px-btn" onClick={polishCurrentSlide} title={L(`현재 슬라이드 AI 다듬기 · 디자인 점수 ${deckDesignAudit.score}/100`, `Polish this slide · score ${deckDesignAudit.score}/100`)}>
                  <Sparkles size={13} /> {L('이 슬라이드 다듬기', 'Polish Slide')}
                </button>
                <button className="px-btn" onClick={polishDeck} title={L(`전체 덱 AI 다듬기 · 디자인 점수 ${deckDesignAudit.score}/100`, `Polish entire deck · score ${deckDesignAudit.score}/100`)}>
                  <Sparkles size={13} /> {L('전체 다듬기', 'Polish All')}
                </button>
              </div>
            </>
          )}

          {activeRibbonTab === 'Present' && (
            <>
              <div className="px-toolbar-group" data-group={L('발표', 'Present')}>
                <button className="px-btn px-btn-primary" onClick={() => startPresentation(false)} title={L('프레젠테이션 모드 (F5)', 'Presentation mode (F5)')}><Play size={13} /> {L('발표', 'Present')}</button>
                <button className="px-btn" onClick={() => startPresentation(true)} title={L('발표자 콘솔 (Shift+F5)', 'Presenter console (Shift+F5)')}><Monitor size={13} /> {L('발표자', 'Presenter')}</button>
                <button className={`px-btn ${coachOpen ? 'active' : ''}`} onClick={() => setCoachOpen((prev) => !prev)} title={L('리허설 코치 열기', 'Open rehearsal coach')}><ClipboardCheck size={13} /> {L('코치', 'Coach')}</button>
              </div>
              <div className="px-toolbar-sep" />
              {/* 슬라이드 전환 설정 — 우측 패널에서 이동 (현재 슬라이드에 적용) */}
              <div className="px-toolbar-group" data-group={L('전환', 'Transition')}>
                <select
                  className="px-preset-select"
                  value={currentTransition.type}
                  onChange={(e) => {
                    recordForUndo();
                    const type = e.target.value as SlideTransition['type'];
                    updateCurrentSlide((s) => ({ ...s, transition: { ...currentTransition, type } }));
                  }}
                  title={L('현재 슬라이드 전환 효과', 'Transition for this slide')}
                >
                  {PPTX_TRANSITION_TYPES.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
                <input
                  className="px-font-size-input"
                  type="number" min={100} max={3000} step={50}
                  value={currentTransition.durationMs}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n) || n <= 0) return;
                    recordForUndo();
                    const durationMs = Math.max(100, Math.min(3000, n));
                    updateCurrentSlide((s) => ({ ...s, transition: { ...currentTransition, durationMs } }));
                  }}
                  title={L('전환 시간 (ms)', 'Transition duration (ms)')}
                />
                <span className="px-ribbon-stat">ms</span>
                <input
                  className="px-font-size-input"
                  type="number" min={0} max={600}
                  value={currentTransition.advanceAfterSec}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n) || n < 0) return;
                    recordForUndo();
                    const advanceAfterSec = Math.min(600, n);
                    updateCurrentSlide((s) => ({ ...s, transition: { ...currentTransition, advanceAfterSec } }));
                  }}
                  title={L('자동 전환(초) — 0은 사용 안 함', 'Auto-advance seconds — 0 disables')}
                />
                <span className="px-ribbon-stat">{L('초', 'sec')}</span>
                <button className="px-btn" onClick={applyDeckRehearsalTiming} title={L('리허설 타이밍을 슬라이드 전환에 적용', 'Apply rehearsal timing to slide transitions')}><Clock3 size={13} /> {L('타이밍', 'Timing')}</button>
              </div>
              <div className="px-toolbar-sep" />
              <div className="px-toolbar-group" data-group={L('내보내기', 'Export')}>
                <button className="px-btn" onClick={exportMarkdownFile} title={L('Slidev 마크다운 내보내기', 'Export Slidev markdown')}><Download size={13} /> {L('마크다운', 'Markdown')}</button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="px-body">
        {workbenchMode === 'markdown' && (
          <div className="px-markdown-view">
            <div className="px-markdown-toolbar">
              <button className="px-btn px-btn-primary" onClick={applyMarkdownDraft} title={L('이 마크다운으로 덱 재구성', 'Rebuild the deck from this markdown')}>{L('적용', 'Apply')}</button>
              <button className="px-btn" onClick={rebuildMarkdownDraft} title={L('현재 덱에서 마크다운 새로 고침', 'Refresh markdown from the current deck')}>{L('새로 고침', 'Refresh')}</button>
              <button className="px-btn" onClick={importMarkdownFile} title={L('마크다운 파일 가져오기', 'Import a markdown file')}><Upload size={13} /> {L('가져오기', 'Import')}</button>
              <button className="px-btn" onClick={exportMarkdownFile} title={L('Slidev 마크다운 내보내기', 'Export Slidev markdown')}><Download size={13} /> {L('내보내기', 'Export')}</button>
              {markdownStatus && <span className="px-markdown-status">{markdownStatus}</span>}
            </div>
            <textarea
              className="px-markdown-editor"
              value={markdownDraft}
              onChange={(e) => setMarkdownDraft(e.target.value)}
              spellCheck={false}
              placeholder="# Slide title&#10;&#10;- Bullet&#10;&#10;---&#10;&#10;# Next slide"
            />
          </div>
        )}

        {workbenchMode === 'overview' && (
          <div className="px-overview-view">
            <div className="px-overview-toolbar">
              <Search size={14} />
              <input
                className="px-overview-search"
                value={overviewQuery}
                onChange={(e) => setOverviewQuery(e.target.value)}
                placeholder={L('제목이나 노트로 슬라이드 검색', 'Search slides by title or notes')}
              />
              <span className="px-ribbon-stat">{filteredSlideEntries.length} / {slides.length}</span>
            </div>
            <div className="px-overview-grid">
              {filteredSlideEntries.map(({ slide, idx, title }) => (
                <button
                  key={slide.id}
                  className={`px-overview-card ${idx === currentSlideIdx ? 'active' : ''}`}
                  onClick={() => { goToSlide(idx); setWorkbenchMode('design'); }}
                  title={title}
                >
                  <span className="px-overview-card-num">{idx + 1}{slide.hidden ? L(' · 숨김', ' · hidden') : ''}</span>
                  <SlideThumbPreview slide={slide} aspectRatio={slideSize.aspectRatio} className="px-overview-card-preview" />
                  <span className="px-overview-card-title">{title}</span>
                </button>
              ))}
              {filteredSlideEntries.length === 0 && (
                <div className="px-overview-empty">{L(`“${overviewQuery}”과(와) 일치하는 슬라이드가 없습니다.`, `No slides match “${overviewQuery}”.`)}</div>
              )}
            </div>
          </div>
        )}

        {workbenchMode === 'design' && (
          <>
        {/* Left slide thumbnails */}
        <div
          className="px-sidebar"
          style={{ width: leftSidebarWidth }}
          onDragOver={(e) => {
            // Dropping in the gaps / below the list used to silently cancel.
            if (dragSlideIdx != null) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragSlideIdx == null) return;
            moveSlide(dragSlideIdx, slides.length - 1);
            setDragSlideIdx(null);
            setSlideDropIdx(null);
          }}
        >
          {slides.map((slide, idx) => (
            <div
              key={slide.id}
              className={`px-thumb ${idx === currentSlideIdx ? 'active' : ''} ${slideDropIdx === idx ? `drop-${slideDropPos}` : ''} ${dragSlideIdx === idx ? 'dragging' : ''}`}
              onClick={() => goToSlide(idx)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                setDragSlideIdx(idx);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dragSlideIdx == null || dragSlideIdx === idx) return;
                const rect = e.currentTarget.getBoundingClientRect();
                setSlideDropIdx(idx);
                // Above/below the thumb's midpoint decides where the insertion
                // line renders — highlighting the whole card was ambiguous.
                setSlideDropPos(e.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dragSlideIdx == null || dragSlideIdx === idx) {
                  setDragSlideIdx(null);
                  setSlideDropIdx(null);
                  return;
                }
                let to = slideDropPos === 'before' ? idx : idx + 1;
                if (dragSlideIdx < to) to -= 1; // removing the source shifts the target left
                moveSlide(dragSlideIdx, to);
                setDragSlideIdx(null);
                setSlideDropIdx(null);
              }}
              onDragEnd={() => {
                setDragSlideIdx(null);
                setSlideDropIdx(null);
              }}
            >
              <span className="px-thumb-number">{idx + 1}</span>
              <button
                className="px-thumb-delete"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  deleteSlideAt(idx);
                }}
                disabled={slides.length <= 1}
                title={L(`슬라이드 ${idx + 1} 삭제`, `Delete slide ${idx + 1}`)}
                aria-label={L(`슬라이드 ${idx + 1} 삭제`, `Delete slide ${idx + 1}`)}
              >
                <Trash2 size={11} />
              </button>
              <SlideThumbPreview slide={slide} aspectRatio={slideSize.aspectRatio} className="px-thumb-preview" />
            </div>
          ))}
        {/* 컴팩트 새 슬라이드 버튼 — 큰 미리보기 카드는 좁은 화면만 잡아먹었다. */}
        <button
          className="px-add-slide-compact"
          onClick={addSlide}
          title={L(`${selectedSlidePreset?.label || '선택한'} 레이아웃으로 새 슬라이드`, `New slide with the ${selectedSlidePreset?.label || 'selected'} layout`)}
        >
          <Plus size={12} /> {L('새 슬라이드', 'New slide')}
        </button>
        </div>
        <div className="px-panel-resizer left" onMouseDown={(e) => beginSidebarResize('left', e)} />

        {/* Slide canvas */}
        <div className="px-canvas-col">
        <div ref={canvasAreaRef} className="px-canvas-area" onClick={() => { setSelectedElementIds([]); setEditingTextId(null); setEditingTableCell(null); }}>
          <div
            ref={slideRef}
            className="px-slide"
            style={{ width: canvasSize.w, height: canvasSize.h, ...slideBgStyle(currentSlide) }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={handleCanvasMouseDown}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleCanvasDrop}
          >
            {guideLines.vLines.map((v) => (
              <div key={`gv${v}`} className="px-smart-guide vertical" style={{ left: `${v}%` }} />
            ))}
            {guideLines.hLines.map((h) => (
              <div key={`gh${h}`} className="px-smart-guide horizontal" style={{ top: `${h}%` }} />
            ))}
            {currentSlide.elements.map((el) => renderSlideElement(el, renderOpts))}
            {/* PowerPoint-style entrance-animation order badges (editor only). */}
            {currentSlide.elements.filter((el) => el.animation).map((el) => (
              <span
                key={`px-anim-badge-${el.id}`}
                className="px-anim-badge"
                style={{ left: `${el.x}%`, top: `${el.y}%` }}
                title={`Animation step ${el.animation!.order}`}
              >
                {el.animation!.order}
              </span>
            ))}
          </div>
          {marquee && (
            <div
              className="px-marquee"
              style={{
                position: 'fixed',
                left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h,
              }}
            />
          )}
          {coachOpen && (
            <aside className="px-rehearsal-coach" onClick={(e) => e.stopPropagation()}>
              <div className="px-rehearsal-coach-head">
                <div>
                  <span>{L('리허설 코치', 'Rehearsal Coach')}</span>
                  <strong>{rehearsalReport.score}/100</strong>
                </div>
                <button className="px-btn" onClick={() => setCoachOpen(false)} title={L('리허설 코치 닫기', 'Close rehearsal coach')}>{L('닫기', 'Close')}</button>
              </div>
              <div className="px-rehearsal-metrics">
                <span>{rehearsalReport.visibleSlides} {L('슬라이드', 'slides')}</span>
                <span>{formatRehearsalDuration(rehearsalReport.totalSeconds)}</span>
                <span>{rehearsalReport.slidesWithNotes}/{rehearsalReport.visibleSlides} {L('노트', 'notes')}</span>
              </div>
              <div className="px-rehearsal-current">
                <div className="px-rehearsal-kicker">{L('현재 슬라이드', 'Current Slide')}</div>
                <strong>{currentRehearsalSlide?.title || slideTitle(currentSlide, currentSlideIdx)}</strong>
                <span>
                  {currentRehearsalSlide
                    ? `${formatRehearsalDuration(currentRehearsalSlide.estimatedSeconds)} · ${currentRehearsalSlide.issues[0] || L('발표자 모드 준비 완료', 'Ready for presenter mode')}`
                    : L('준비 완료', 'Ready')}
                </span>
              </div>
              <div className="px-rehearsal-list">
                {(rehearsalIssueSlides.length ? rehearsalIssueSlides : rehearsalReport.slideReports).slice(0, 5).map((report) => (
                  <button key={report.slideId} onClick={() => goToSlide(report.slideIndex)} title={report.title}>
                    <span>{report.slideIndex + 1}</span>
                    <div>
                      <strong>{report.title}</strong>
                      <small>{report.issues[0] || L('리허설 이슈 없음', 'No rehearsal issue')}</small>
                    </div>
                  </button>
                ))}
              </div>
            </aside>
          )}
        </div>
        {/* 발표자 노트 — PowerPoint처럼 캔버스 바로 아래 (우측 패널에서 이동) */}
        <div className="px-notes-bar">
          <label>{L('발표자 노트', 'Notes')}</label>
          <textarea
            value={currentSlide.notes || ''}
            onChange={(e) => {
              recordForUndoGrouped(`notes:${currentSlide.id}`);
              const notes = e.target.value;
              updateCurrentSlide((s) => ({ ...s, notes }));
            }}
            placeholder={L('이 슬라이드의 발표자 노트를 입력하세요', 'Add presenter notes for this slide')}
            spellCheck={false}
          />
        </div>
        </div>

        <div className="px-panel-resizer right" onMouseDown={(e) => beginSidebarResize('right', e)} />
        {/* Right properties panel */}
        <PropertiesPanel
          currentSlide={currentSlide}
          selectedEl={selectedEl}
          width={rightPanelWidth}
          onReplaceSelectedImage={replaceSelectedImage}
          onClearSelectedImage={clearSelectedImage}
          onSlideBgChange={(color) => {
            recordForUndo();
            updateCurrentSlide((s) => ({ ...s, bgColor: color }));
          }}
          onSlideBgImageChange={async (imageSrc) => {
            let nextImage = imageSrc;
            if (typeof nextImage === 'undefined') {
              nextImage = await pickImageDataUrl() || undefined;
            }
            if (typeof nextImage === 'undefined') return;
            recordForUndo();
            updateCurrentSlide((s) => ({ ...s, bgImage: nextImage }));
          }}
          onUpdateElement={updateElementWithHistory}
          onDeleteElement={deleteElement}
          onDuplicateElement={duplicateElement}
          onZOrder={handleZOrder}
          onAlign={handleAlign}
          selectedCount={selectedElementIds.length}
          onAlignSelection={handleAlignSelection}
          onDistribute={handleDistribute}
          onGroup={groupSelection}
          onUngroup={ungroupSelection}
          selectionHasGroup={selectionHasGroup}
          onTableAddRow={tableAddRow}
          onTableRemoveRow={tableRemoveRow}
          onTableAddCol={tableAddCol}
          onTableRemoveCol={tableRemoveCol}
          onTableToggleHeader={toggleTableHeader}
          key={`${currentSlide.id}:${selectedElementIds.length === 1 ? selectedEl?.id : `multi-${selectedElementIds.length}`}`}
        />
          </>
        )}
      </div>

      {saveToast && (
        <div className={`px-save-toast ${saveToast.type}`} role="status">{saveToast.message}</div>
      )}

      {/* Bottom status bar */}
      <div className="px-bottom-bar">
        <span className="px-bottom-tag">PPTX</span>
        <span className="px-bottom-slide">{L(`슬라이드 ${currentSlideIdx + 1} / ${slides.length}`, `Slide ${currentSlideIdx + 1} of ${slides.length}`)}</span>
        {selectedEl && <span className="px-bottom-sel">{selectedEl.type}{selectedEl.rotation ? ` · ${Math.round(selectedEl.rotation)}°` : ''}</span>}
        <span className="px-bottom-badge design" title={L('디자인 점수', 'Design score')}>Design {deckDesignAudit.score}</span>
        <span className="px-bottom-badge rehearsal" title={L('리허설 점수', 'Rehearsal score')}>Rehearsal {rehearsalReport.score}</span>
        {designerStatus && <span className="px-designer-status">{designerStatus}</span>}
        {rehearsalStatus && <span className="px-rehearsal-status">{rehearsalStatus}</span>}
        <span className="px-status">{fileBaseName(filePath)}</span>
      </div>
    </div>
  );
}

export default PptxEditor;
