import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  ZoomIn, ZoomOut, Maximize2, Minimize2, FileDown, X, Pencil, Loader2,
  RotateCcw, RotateCw, FlipHorizontal, FlipVertical, Undo2, Save, SlidersHorizontal,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from '../i18n';
import './ImageEditor.css';

interface ImageViewerProps {
  src: string;
  fileName: string;
  filePath?: string;
  style?: { bg: string; text: string; accent: string };
  onSaved?: (path: string) => void;
  onModifiedChange?: (modified: boolean) => void;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 20;
const ZOOM_STEP = 1.15;
const MAX_UNDO = 10;

const TIFF_EXTS = ['tif', 'tiff'];

export function fileExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() || '';
}

export function isTiff(name: string): boolean {
  return TIFF_EXTS.includes(fileExt(name));
}

export function mimeForName(name: string): string {
  const ext = fileExt(name);
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

export function editedFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}_edited`;
  return `${name.slice(0, dot)}_edited${name.slice(dot)}`;
}

type ViewerEdit =
  | { kind: 'rotate'; deg: 90 | -90 }
  | { kind: 'flip'; axis: 'h' | 'v' };

function renderToDataUrl(
  src: string,
  edit: ViewerEdit | null,
  mime: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('canvas context unavailable')); return; }
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (edit?.kind === 'rotate') {
        canvas.width = h;
        canvas.height = w;
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((edit.deg * Math.PI) / 180);
        ctx.drawImage(img, -w / 2, -h / 2);
      } else if (edit?.kind === 'flip') {
        canvas.width = w;
        canvas.height = h;
        if (edit.axis === 'h') { ctx.translate(w, 0); ctx.scale(-1, 1); }
        else { ctx.translate(0, h); ctx.scale(1, -1); }
        ctx.drawImage(img, 0, 0);
      } else {
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(img, 0, 0);
      }
      resolve(canvas.toDataURL(mime, 0.95));
    };
    img.onerror = () => reject(new Error('failed to load image for editing'));
    img.src = src;
  });
}

function base64FromSrc(src: string): string {
  return src.replace(/^data:[^;]+;base64,/, '');
}

function ensureReactGlobal() {
  const target = globalThis as typeof globalThis & { React?: typeof React };
  target.React ||= React;
}

ensureReactGlobal();

const FilerobotImageEditor = React.lazy(() => {
  ensureReactGlobal();
  return import('react-filerobot-image-editor');
});
const PhotoEditor = React.lazy(() => import('./photo/PhotoEditor'));
const IMAGE_EDITOR_TABS = ['Adjust', 'Finetune', 'Filters', 'Annotate', 'Resize'];

type OutputFormat = 'jpeg' | 'webp' | 'png';
type ImageEditorSaveData = {
  imageBase64?: string;
  imageCanvas?: HTMLCanvasElement;
  mimeType?: string;
  quality?: number;
};

interface CompressState {
  open: boolean;
  quality: number;
  scale: number;
  format: OutputFormat;
  previewUrl: string | null;
  previewSize: number;
  originalSize: number;
  processing: boolean;
  done: boolean;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function base64ByteLength(b64: string): number {
  const raw = b64.replace(/^data:[^;]+;base64,/, '');
  const padding = (raw.match(/=+$/) || [''])[0].length;
  return Math.floor((raw.length * 3) / 4) - padding;
}

export default function ImageViewer({ src, fileName, filePath, style, onSaved, onModifiedChange }: ImageViewerProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentSrc, setCurrentSrc] = useState(src);
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
  const [checkerboard, setCheckerboard] = useState(true);
  const [imageEditorOpen, setImageEditorOpen] = useState(false);
  const [imageEditorSaving, setImageEditorSaving] = useState(false);
  const [photoEditorOpen, setPhotoEditorOpen] = useState(false);
  const [photoEditorDirty, setPhotoEditorDirty] = useState(false);
  const [viewerDirty, setViewerDirty] = useState(false);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveToast, setSaveToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const [comp, setComp] = useState<CompressState>({
    open: false, quality: 80, scale: 100, format: 'jpeg',
    previewUrl: null, previewSize: 0, originalSize: 0, processing: false, done: false,
  });

  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  const tiff = isTiff(fileName);

  useEffect(() => {
    setCurrentSrc(src);
    setViewerDirty(false);
    setUndoStack([]);
  }, [src]);

  const modified = viewerDirty || imageEditorOpen || (photoEditorOpen && photoEditorDirty);
  useEffect(() => {
    onModifiedChange?.(modified);
  }, [modified, onModifiedChange]);

  const toastTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  const showToast = useCallback((kind: 'success' | 'error') => {
    const text = kind === 'success'
      ? `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Save failed';
    setSaveToast({ kind, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setSaveToast(null), 2500);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    setZoom((prev) => clampZoom(prev * factor));
    setFitMode(false);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }, [dragging, dragStart]);

  const handleMouseUp = useCallback(() => setDragging(false), []);

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  useEffect(() => {
    if (!fitMode || !containerRef.current || !naturalSize.w) return;
    const rect = containerRef.current.getBoundingClientRect();
    const padding = 40;
    const scaleX = (rect.width - padding) / naturalSize.w;
    const scaleY = (rect.height - padding) / naturalSize.h;
    setZoom(Math.min(1, scaleX, scaleY));
    setPan({ x: 0, y: 0 });
  }, [fitMode, naturalSize]);

  const toggleFit = () => {
    if (fitMode) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setFitMode(false);
    } else {
      setFitMode(true);
    }
  };

  const zoomIn = () => { setZoom((z) => clampZoom(z * ZOOM_STEP)); setFitMode(false); };
  const zoomOut = () => { setZoom((z) => clampZoom(z / ZOOM_STEP)); setFitMode(false); };

  // --- Rotate / flip logic ---
  const applyEdit = useCallback(async (edit: ViewerEdit) => {
    if (tiff) return;
    setBusy(true);
    try {
      const next = await renderToDataUrl(currentSrc, edit, mimeForName(fileName));
      setUndoStack((s) => [...s.slice(-(MAX_UNDO - 1)), currentSrc]);
      setCurrentSrc(next);
      setViewerDirty(true);
    } catch (err) {
      console.error('[ImageViewer] edit failed:', err);
      showToast('error');
    } finally {
      setBusy(false);
    }
  }, [currentSrc, fileName, tiff, showToast]);

  const undo = useCallback(() => {
    setUndoStack((s) => {
      if (s.length === 0) return s;
      const prev = s[s.length - 1];
      setCurrentSrc(prev);
      if (s.length === 1) setViewerDirty(false);
      return s.slice(0, -1);
    });
  }, []);

  const ensureDataUrl = useCallback(async (): Promise<string> => {
    if (currentSrc.startsWith('data:')) return currentSrc;
    return renderToDataUrl(currentSrc, null, mimeForName(fileName));
  }, [currentSrc, fileName]);

  const saveViewer = useCallback(async () => {
    setBusy(true);
    try {
      const base64 = base64FromSrc(await ensureDataUrl());
      let targetPath = filePath;
      if (!targetPath) {
        const ext = fileExt(fileName) || 'png';
        const picked = await invoke<string | null>('save_file_dialog', {
          defaultName: editedFileName(fileName || 'image.png'),
          filters: [[`${ext.toUpperCase()} Image`, [ext]]],
        });
        if (!picked) { setBusy(false); return; }
        targetPath = picked;
      }
      await invoke('write_file_base64', { path: targetPath, base64Data: base64 });
      setViewerDirty(false);
      setUndoStack([]);
      onSaved?.(targetPath);
      showToast('success');
    } catch (err) {
      console.error('[ImageViewer] viewer save failed:', err);
      showToast('error');
    } finally {
      setBusy(false);
    }
  }, [ensureDataUrl, filePath, fileName, onSaved, showToast]);

  const saveViewerAs = useCallback(async () => {
    setBusy(true);
    try {
      const base64 = base64FromSrc(await ensureDataUrl());
      const ext = fileExt(fileName) || 'png';
      const picked = await invoke<string | null>('save_file_dialog', {
        defaultName: editedFileName(fileName || 'image.png'),
        filters: [[`${ext.toUpperCase()} Image`, [ext]]],
      });
      if (!picked) { setBusy(false); return; }
      await invoke('write_file_base64', { path: picked, base64Data: base64 });
      setViewerDirty(false);
      setUndoStack([]);
      onSaved?.(picked);
      showToast('success');
    } catch (err) {
      console.error('[ImageViewer] viewer save as failed:', err);
      showToast('error');
    } finally {
      setBusy(false);
    }
  }, [ensureDataUrl, fileName, onSaved, showToast]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    switch (e.key) {
      case '+': case '=': e.preventDefault(); zoomIn(); break;
      case '-': case '_': e.preventDefault(); zoomOut(); break;
      case '0': e.preventDefault(); toggleFit(); break;
      case 'e': case 'E':
        if (!tiff && !imageEditorOpen && !photoEditorOpen) { e.preventDefault(); setPhotoEditorOpen(true); }
        break;
      case 'Escape':
        if (photoEditorOpen) break; // PhotoEditor handles its own keyboard
        if (imageEditorOpen) { if (!imageEditorSaving) setImageEditorOpen(false); }
        else if (comp.open) setComp(c => ({ ...c, open: false }));
        break;
    }
  }, [tiff, imageEditorOpen, imageEditorSaving, photoEditorOpen, comp.open]);

  // --- Compress logic ---
  const openCompress = useCallback(() => {
    const origSize = base64ByteLength(src);
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const defaultFormat: OutputFormat = (ext === 'png') ? 'webp' : (ext === 'webp') ? 'webp' : 'jpeg';
    setComp({
      open: true, quality: 80, scale: 100, format: defaultFormat,
      previewUrl: null, previewSize: 0, originalSize: origSize, processing: false, done: false,
    });
  }, [src, fileName]);

  const generatePreview = useCallback(async (quality: number, scale: number, format: OutputFormat) => {
    if (!naturalSize.w) return;
    setComp(c => ({ ...c, processing: true }));

    const img = new Image();
    img.onload = () => {
      const w = Math.round(img.naturalWidth * (scale / 100));
      const h = Math.round(img.naturalHeight * (scale / 100));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
      const q = format === 'png' ? undefined : quality / 100;
      const dataUrl = canvas.toDataURL(mimeType, q);
      const newSize = base64ByteLength(dataUrl);
      setComp(c => ({ ...c, previewUrl: dataUrl, previewSize: newSize, processing: false }));
    };
    img.src = currentSrc;
  }, [currentSrc, naturalSize]);

  // Auto-preview when params change
  useEffect(() => {
    if (!comp.open || !naturalSize.w) return;
    const timer = setTimeout(() => {
      void generatePreview(comp.quality, comp.scale, comp.format);
    }, 200);
    return () => clearTimeout(timer);
  }, [comp.open, comp.quality, comp.scale, comp.format, naturalSize, generatePreview]);

  const handleCompressSave = useCallback(async () => {
    if (!comp.previewUrl) return;
    setComp(c => ({ ...c, processing: true }));
    try {
      const ext = comp.format === 'png' ? 'png' : comp.format === 'webp' ? 'webp' : 'jpg';
      const base64 = comp.previewUrl.replace(/^data:image\/\w+;base64,/, '');
      let targetPath: string;
      if (filePath) {
        targetPath = `${filePath.replace(/\.[^.]+$/, '')}_compressed.${ext}`;
      } else {
        const baseName = (fileName || 'image').replace(/\.[^.]+$/, '');
        const picked = await invoke<string | null>('save_file_dialog', {
          defaultName: `${baseName}_compressed.${ext}`,
          filters: [[`${ext.toUpperCase()} Image`, [ext]]],
        });
        if (!picked) { setComp(c => ({ ...c, processing: false })); return; }
        targetPath = picked;
      }
      await invoke('write_file_base64', { path: targetPath, base64Data: base64 });
      setComp(c => ({ ...c, processing: false, done: true }));
      onSaved?.(targetPath);
      showToast('success');
    } catch (err) {
      console.error('[ImageViewer] compress save failed:', err);
      setComp(c => ({ ...c, processing: false }));
      showToast('error');
    }
  }, [comp.previewUrl, comp.format, filePath, fileName, onSaved, showToast]);

  const handleCompressOverwrite = useCallback(async () => {
    if (!comp.previewUrl || !filePath) return;
    setComp(c => ({ ...c, processing: true }));
    try {
      const base64 = comp.previewUrl.replace(/^data:image\/\w+;base64,/, '');
      await invoke('write_file_base64', { path: filePath, base64Data: base64 });
      setComp(c => ({ ...c, processing: false, done: true }));
      onSaved?.(filePath);
      showToast('success');
    } catch (err) {
      console.error('[ImageViewer] compress overwrite failed:', err);
      setComp(c => ({ ...c, processing: false }));
      showToast('error');
    }
  }, [comp.previewUrl, filePath, onSaved, showToast]);

  const getDefaultSaveType = useCallback((): 'png' | 'jpeg' | 'jpg' | 'webp' => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'png') return ext;
    return 'png';
  }, [fileName]);

  const handleImageEditorSave = useCallback(async (editedImage: ImageEditorSaveData) => {
    setImageEditorSaving(true);
    try {
      const saveType = getDefaultSaveType();
      const mimeType = editedImage.mimeType || `image/${saveType === 'jpg' ? 'jpeg' : saveType}`;
      const dataUrl = editedImage.imageBase64
        || editedImage.imageCanvas?.toDataURL(mimeType, editedImage.quality ?? 0.92);

      if (!dataUrl) throw new Error('Image editor did not return image data');

      const base64 = dataUrl.replace(/^data:image\/[\w.+-]+;base64,/, '');
      let targetPath = filePath;
      if (!targetPath) {
        const ext = saveType === 'jpeg' ? 'jpg' : saveType;
        const baseName = (fileName || 'image').replace(/\.[^.]+$/, '');
        const picked = await invoke<string | null>('save_file_dialog', {
          defaultName: `${baseName}_edited.${ext}`,
          filters: [[`${ext.toUpperCase()} Image`, [ext]]],
        });
        if (!picked) { setImageEditorSaving(false); return; }
        targetPath = picked;
      }
      await invoke('write_file_base64', { path: targetPath, base64Data: base64 });
      const nextSrc = dataUrl.startsWith('data:')
        ? dataUrl
        : `data:${mimeType};base64,${dataUrl}`;
      setCurrentSrc(nextSrc);
      setUndoStack([]);
      setViewerDirty(false);
      setImageEditorOpen(false);
      onSaved?.(targetPath);
      showToast('success');
    } catch (err) {
      console.error('[ImageViewer] image editor save failed:', err);
      showToast('error');
    } finally {
      setImageEditorSaving(false);
    }
  }, [filePath, fileName, getDefaultSaveType, onSaved, showToast]);

  const pct = Math.round(zoom * 100);
  const bg = style?.bg || '#1e1e1e';
  const fg = style?.text || '#cccccc';
  const accent = style?.accent || '#007acc';

  // Filerobot ships a fixed light palette that clashes with the app. Derive its
  // palette from the ACTIVE PROJECT's style (bg/fg/accent) — surfaces shift
  // toward fg (not a hardcoded white) so light and dark project themes both work.
  const imageEditorTheme = React.useMemo(() => {
    const mix = (base: string, pct: number, into = 'transparent') =>
      `color-mix(in srgb, ${base} ${pct}%, ${into})`;
    return {
      palette: {
        'bg-primary': bg,
        'bg-primary-light': mix(bg, 94, fg),
        'bg-primary-hover': mix(bg, 90, fg),
        'bg-primary-active': mix(accent, 30, bg),
        'bg-primary-stateless': bg,
        'bg-primary-0-5-opacity': mix(bg, 50),
        'bg-secondary': mix(bg, 96, fg),
        'bg-stateless': bg,
        'bg-hover': mix(bg, 92, fg),
        'bg-active': mix(accent, 18, bg),
        'bg-grey': mix(bg, 85, fg),
        'bg-tooltip': mix(fg, 90, bg),
        'txt-primary': fg,
        'txt-secondary': mix(fg, 70),
        'txt-secondary-invert': bg,
        'txt-placeholder': mix(fg, 45),
        'accent-primary': accent,
        'accent-primary-hover': mix(accent, 85, '#ffffff'),
        'accent-primary-active': mix(accent, 80, '#000000'),
        'accent-primary-disabled': mix(accent, 25, bg),
        'accent-stateless': accent,
        'icon-primary': mix(fg, 78),
        'icons-secondary': mix(fg, 55),
        'icons-invert': bg,
        'icons-muted': mix(fg, 40),
        'icons-primary-hover': fg,
        'icons-secondary-hover': mix(fg, 75),
        'btn-primary-text': '#ffffff',
        'btn-disabled-text': mix(fg, 35),
        'btn-secondary-text': fg,
        'link-primary': mix(fg, 70),
        'link-stateless': mix(fg, 70),
        'link-hover': fg,
        'link-active': fg,
        'link-muted': mix(fg, 40),
        'borders-primary': mix(fg, 18),
        'borders-primary-hover': mix(fg, 40),
        'borders-secondary': mix(fg, 10),
        'borders-strong': mix(fg, 28),
        'borders-item': mix(fg, 14),
        'border-primary-stateless': mix(fg, 18),
        'borders-button': mix(fg, 30),
        'borders-invert': mix(fg, 45),
        'active-secondary': mix(accent, 16, bg),
        'active-secondary-hover': mix(accent, 10, bg),
        'tag': mix(fg, 55),
        'light-shadow': 'rgba(0,0,0,0.35)',
        'medium-shadow': 'rgba(0,0,0,0.4)',
        'large-shadow': 'rgba(0,0,0,0.5)',
        'xlarge-shadow': 'rgba(0,0,0,0.6)',
      },
      typography: {
        fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
      },
    };
  }, [bg, fg, accent]);

  const checkerBg = checkerboard
    ? `linear-gradient(45deg, rgba(128,128,128,0.15) 25%, transparent 25%, transparent 75%, rgba(128,128,128,0.15) 75%), linear-gradient(45deg, rgba(128,128,128,0.15) 25%, transparent 25%, transparent 75%, rgba(128,128,128,0.15) 75%)`
    : 'none';

  const reductionPct = comp.originalSize > 0 && comp.previewSize > 0
    ? Math.round((1 - comp.previewSize / comp.originalSize) * 100)
    : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: bg }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
        borderBottom: `1px solid rgba(128,128,128,0.2)`, fontSize: 12, color: fg, flexShrink: 0,
      }}>
        <button onClick={zoomOut} title={t('editor.zoomOut')} style={btnStyle(fg)}><ZoomOut size={14} /></button>
        <span style={{ minWidth: 44, textAlign: 'center', opacity: 0.7, fontSize: 11 }}>{pct}%</span>
        <button onClick={zoomIn} title={t('editor.zoomIn')} style={btnStyle(fg)}><ZoomIn size={14} /></button>
        <button onClick={toggleFit} title={fitMode ? t('editor.originalSize') : t('editor.fitToScreen')} style={btnStyle(fg)}>
          {fitMode ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
        </button>
        <span style={{ opacity: 0.4, margin: '0 4px' }}>|</span>
        <button onClick={() => void applyEdit({ kind: 'rotate', deg: -90 })} disabled={tiff || busy} title="Rotate left" style={btnStyle(fg, tiff || busy)}><RotateCcw size={14} /></button>
        <button onClick={() => void applyEdit({ kind: 'rotate', deg: 90 })} disabled={tiff || busy} title="Rotate right" style={btnStyle(fg, tiff || busy)}><RotateCw size={14} /></button>
        <button onClick={() => void applyEdit({ kind: 'flip', axis: 'h' })} disabled={tiff || busy} title="Flip horizontal" style={btnStyle(fg, tiff || busy)}><FlipHorizontal size={14} /></button>
        <button onClick={() => void applyEdit({ kind: 'flip', axis: 'v' })} disabled={tiff || busy} title="Flip vertical" style={btnStyle(fg, tiff || busy)}><FlipVertical size={14} /></button>
        <button onClick={undo} disabled={undoStack.length === 0 || busy} title="Undo" style={btnStyle(fg, undoStack.length === 0 || busy)}><Undo2 size={14} /></button>
        <button onClick={() => void saveViewer()} disabled={!viewerDirty || busy} title="Save" style={btnStyle(fg, !viewerDirty || busy)}><Save size={14} /></button>
        <button onClick={() => void saveViewerAs()} disabled={busy} title="Save As" style={{ ...btnStyle(fg, busy), fontSize: 11, opacity: busy ? 0.35 : 0.7 }}>Save As</button>
        <span style={{ opacity: 0.4, margin: '0 4px' }}>|</span>
        <button onClick={openCompress} title={t('editor.compressImage')} style={btnStyle(fg)}>
          <FileDown size={14} />
        </button>
        {/* 이미지 편집 진입점 — 아이콘만으로는 못 찾는다는 피드백에 따라 라벨 있는 프라이머리 버튼으로 승격 */}
        <button
          onClick={() => setPhotoEditorOpen(true)}
          disabled={tiff}
          title="Open the photo editor — layers, selections, brushes, adjustments (E)"
          style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '4px 12px',
            border: 'none', borderRadius: 'var(--brutal-radius)',
            background: tiff ? `color-mix(in srgb, ${accent} 30%, transparent)` : accent,
            color: '#ffffff', fontSize: 11, fontWeight: 600,
            cursor: tiff ? 'default' : 'pointer', opacity: tiff ? 0.5 : 1,
          }}
        >
          <Pencil size={13} />
          Edit
        </button>
        <button
          onClick={() => setImageEditorOpen(true)}
          disabled={tiff}
          title="Quick edit — one-tap filters, annotate, resize"
          style={btnStyle(fg, tiff)}
        >
          <SlidersHorizontal size={14} />
        </button>
        <span style={{ opacity: 0.4, margin: '0 4px' }}>|</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', opacity: 0.7, fontSize: 11 }}>
          <input
            type="checkbox" checked={checkerboard} onChange={() => setCheckerboard(!checkerboard)}
            style={{ width: 12, height: 12, accentColor: accent }}
          />
          {t('editor.checkerboard')}
        </label>
        <div style={{ flex: 1 }} />
        {naturalSize.w > 0 && (
          <span style={{ opacity: 0.5, fontSize: 11 }}>{naturalSize.w} x {naturalSize.h}px</span>
        )}
      </div>

      {/* Image area */}
      <div
        ref={containerRef}
        tabIndex={0}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onKeyDown={handleKeyDown}
        style={{
          flex: 1, overflow: 'hidden', position: 'relative', outline: 'none',
          cursor: tiff ? 'default' : dragging ? 'grabbing' : 'grab',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundImage: tiff ? 'none' : checkerBg,
          backgroundSize: '20px 20px',
          backgroundPosition: '0 0, 10px 10px',
        }}
      >
        {tiff ? (
          <div style={{ textAlign: 'center', opacity: 0.6, fontSize: 13, padding: 24, lineHeight: 1.6 }}>
            <div>Preview not supported for TIFF</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>{fileName}</div>
          </div>
        ) : (
          <img
            src={currentSrc}
            alt={fileName}
            onLoad={handleImageLoad}
            draggable={false}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
              maxWidth: 'none', maxHeight: 'none',
              imageRendering: zoom > 3 ? 'pixelated' : 'auto',
              userSelect: 'none',
              transition: dragging ? 'none' : 'transform 0.1s ease-out',
            }}
          />
        )}
        {saveToast && (
          <div className={`iv-save-toast ${saveToast.kind}`}>{saveToast.text}</div>
        )}
      </div>

      {/* Compress panel */}
      {comp.open && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 200,
          background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={(e) => { if (e.target === e.currentTarget) setComp(c => ({ ...c, open: false })); }}>
          <div style={{
            background: bg, border: `1px solid rgba(128,128,128,0.3)`, borderRadius: 'var(--brutal-radius)',
            padding: 20, minWidth: 380, maxWidth: 520, color: fg, position: 'relative',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}>
            <button className="modal-close-btn" title="Close" aria-label="Close" onClick={() => setComp(c => ({ ...c, open: false }))} style={{
              position: 'absolute', top: 10, right: 10, color: fg,
            }}><X size={16} /></button>

            <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 600 }}>
              {t('editor.compressImage')}
            </h3>

            {comp.done ? (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div style={{ fontSize: 13, marginBottom: 8, color: '#4caf50' }}>{t('editor.compressDone')}</div>
                <button onClick={() => setComp(c => ({ ...c, open: false }))} style={{
                  ...compBtnStyle(accent), marginTop: 8,
                }}>{t('editor.closeBtn')}</button>
              </div>
            ) : (
              <>
                {/* Original size */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.7, marginBottom: 12 }}>
                  <span>{t('editor.compressOriginal')}: {formatFileSize(comp.originalSize)}</span>
                  <span>{naturalSize.w} x {naturalSize.h}px</span>
                </div>

                {/* Format */}
                <div style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 11, opacity: 0.7, marginBottom: 4, display: 'block' }}>{t('editor.compressFormat')}</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['jpeg', 'webp', 'png'] as OutputFormat[]).map(f => (
                      <button key={f} onClick={() => setComp(c => ({ ...c, format: f }))} style={{
                        padding: '4px 12px', borderRadius: 'var(--brutal-radius)', fontSize: 11, cursor: 'pointer',
                        border: `1px solid ${comp.format === f ? accent : 'rgba(128,128,128,0.3)'}`,
                        background: comp.format === f ? accent : 'transparent',
                        color: comp.format === f ? '#fff' : fg,
                      }}>{f.toUpperCase()}</button>
                    ))}
                  </div>
                </div>

                {/* Quality slider (not for PNG) */}
                {comp.format !== 'png' && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                      <label style={{ opacity: 0.7 }}>{t('editor.compressQuality')}</label>
                      <span>{comp.quality}%</span>
                    </div>
                    <input type="range" min={5} max={100} value={comp.quality}
                      onChange={e => setComp(c => ({ ...c, quality: +e.target.value }))}
                      style={{ width: '100%', accentColor: accent }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, opacity: 0.4 }}>
                      <span>{t('editor.compressSmaller')}</span>
                      <span>{t('editor.compressBetter')}</span>
                    </div>
                  </div>
                )}

                {/* Scale slider */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                    <label style={{ opacity: 0.7 }}>{t('editor.compressScale')}</label>
                    <span>{comp.scale}% ({Math.round(naturalSize.w * comp.scale / 100)} x {Math.round(naturalSize.h * comp.scale / 100)})</span>
                  </div>
                  <input type="range" min={10} max={100} value={comp.scale}
                    onChange={e => setComp(c => ({ ...c, scale: +e.target.value }))}
                    style={{ width: '100%', accentColor: accent }} />
                </div>

                {/* Preview result */}
                {comp.previewSize > 0 && (
                  <div style={{
                    padding: '10px 14px', borderRadius: 'var(--brutal-radius)',
                    background: reductionPct > 0 ? 'rgba(76,175,80,0.1)' : 'rgba(255,152,0,0.1)',
                    border: `1px solid ${reductionPct > 0 ? 'rgba(76,175,80,0.3)' : 'rgba(255,152,0,0.3)'}`,
                    marginBottom: 16, fontSize: 12,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>{t('editor.compressResult')}: <strong>{formatFileSize(comp.previewSize)}</strong></span>
                      <span style={{
                        fontWeight: 600,
                        color: reductionPct > 0 ? '#4caf50' : '#ff9800',
                      }}>
                        {reductionPct > 0 ? `-${reductionPct}%` : `+${Math.abs(reductionPct)}%`}
                      </span>
                    </div>
                  </div>
                )}

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={() => setComp(c => ({ ...c, open: false }))} style={{
                    ...compBtnStyle('transparent'), border: '1px solid rgba(128,128,128,0.3)', color: fg,
                  }}>{t('editor.cancel')}</button>
                  <button onClick={handleCompressSave} disabled={comp.processing || !comp.previewUrl} style={{
                    ...compBtnStyle(accent), opacity: comp.processing ? 0.5 : 1,
                  }}>{t('editor.compressSaveAs')}</button>
                  <button onClick={handleCompressOverwrite} disabled={comp.processing || !comp.previewUrl} style={{
                    ...compBtnStyle('#e65100'), opacity: comp.processing ? 0.5 : 1,
                  }}>{t('editor.compressOverwrite')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {photoEditorOpen && (
        <React.Suspense fallback={<div className="image-editor-overlay image-editor-loading" style={{ background: bg, color: fg }}>{t('editor.loadingEditor')}</div>}>
          <PhotoEditor
            src={currentSrc}
            fileName={fileName}
            filePath={filePath}
            style={style}
            onSaved={onSaved}
            onSavedData={(dataUrl, path) => {
              if (!filePath || path === filePath) {
                setCurrentSrc(dataUrl);
                setUndoStack([]);
                setViewerDirty(false);
              }
            }}
            onClose={() => { setPhotoEditorOpen(false); setPhotoEditorDirty(false); }}
            onDirtyChange={setPhotoEditorDirty}
          />
        </React.Suspense>
      )}

      {imageEditorOpen && (
        <div className="image-editor-overlay" style={{ background: bg, color: fg }}>
          {imageEditorSaving && (
            <div className="image-editor-saving">
              <Loader2 size={16} className="image-editor-spinner" />
              <span>{t('editor.save')}</span>
            </div>
          )}
          <React.Suspense fallback={<div className="image-editor-loading">{t('editor.loadingEditor')}</div>}>
            <FilerobotImageEditor
              source={currentSrc}
              onSave={(editedImage) => void handleImageEditorSave(editedImage)}
              onClose={() => {
                if (!imageEditorSaving) setImageEditorOpen(false);
              }}
              defaultSavedImageName={fileName.replace(/\.[^.]+$/, '') || 'image'}
              defaultSavedImageType={getDefaultSaveType()}
              defaultSavedImageQuality={0.92}
              tabsIds={IMAGE_EDITOR_TABS as any}
              defaultTabId="Adjust"
              defaultToolId="Crop"
              savingPixelRatio={1}
              previewPixelRatio={window.devicePixelRatio || 1}
              closeAfterSave={false}
              resetOnSourceChange
              showBackButton
              avoidChangesNotSavedAlertOnLeave
              previewBgColor={checkerboard ? 'transparent' : bg}
              theme={imageEditorTheme as any}
              annotationsCommon={{
                fill: 'rgba(255,255,255,0)',
                stroke: accent,
                strokeWidth: 3,
              }}
              Text={{
                fill: accent,
                fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
                fontSize: 36,
              }}
              Crop={{ ratio: 'original', autoResize: true }}
            />
          </React.Suspense>
        </div>
      )}
    </div>
  );
}

function btnStyle(fg: string, disabled = false): React.CSSProperties {
  return {
    background: 'none', border: 'none', color: fg,
    cursor: disabled ? 'default' : 'pointer',
    padding: 4, borderRadius: 'var(--brutal-radius)', display: 'flex', alignItems: 'center',
    opacity: disabled ? 0.3 : 0.7,
  };
}

function compBtnStyle(bg: string): React.CSSProperties {
  return {
    padding: '6px 16px', borderRadius: 'var(--brutal-radius)', fontSize: 12, cursor: 'pointer',
    border: 'none', background: bg, color: '#fff', fontWeight: 500,
  };
}
