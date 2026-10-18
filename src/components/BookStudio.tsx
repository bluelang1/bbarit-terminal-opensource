/**
 * BookStudio.tsx
 *
 * A single-screen e-book authoring workspace: write chapters, design a cover,
 * edit metadata, preview the typeset page, and publish to EPUB or PDF.
 *
 * A book is a `.bbook` JSON manifest. Chapter markdown lives in a `chapters/`
 * folder next to the manifest. The pure manifest/path helpers at the top of
 * this file are unit-tested (see bookStudio.test.ts).
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import type { Extension } from '@codemirror/state';
import {
  BookOpen, Plus, Trash2, ChevronDown, Save, Upload,
  FileText, Image as ImageIcon, Settings2, X, GripVertical,
} from 'lucide-react';
import { createCMTheme } from '../notes/codeMirrorTheme';
import type { CoverTheme } from '../utils/mdToEpub';
import './BookStudio.css';

// ─── Manifest model ───────────────────────────────────────────

export const COVER_THEME_NAMES: CoverTheme[] = ['ink', 'midnight', 'sage', 'burgundy', 'slate', 'sand'];

export type BookFontFamily = 'serif' | 'sans-serif' | 'monospace';
export type ChapterSplit = 'file' | 'h1' | 'h2';

export interface BookChapter {
  id: string;
  title: string;
  file: string; // relative to the manifest folder, e.g. "chapters/chapter-1.md"
}

export interface BookCover {
  mode: 'theme' | 'image' | 'none';
  theme: CoverTheme;
  imagePath?: string; // relative to the manifest folder, e.g. "cover.png"
}

export interface BookStyle {
  fontFamily: BookFontFamily;
  lineHeight: number;
  chapterSplit: ChapterSplit;
}

export interface BookFrontMatter {
  titlePage: boolean;
  colophon: boolean;
  tocPage: boolean;
}

export interface BookManifest {
  title: string;
  author: string;
  language: string;
  publisher: string;
  publishedDate: string;
  identifier: string;
  cover: BookCover;
  style: BookStyle;
  frontMatter: BookFrontMatter;
  chapters: BookChapter[];
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Parse and validate a `.bbook` manifest. Throws with a clear message when the
 *  shape is unusable, so the caller can protect the original file. */
export function parseBookManifest(json: string): BookManifest {
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid book file: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid book file: the manifest must be a JSON object.');
  }
  if (!Array.isArray(raw.chapters)) {
    throw new Error('Invalid book file: "chapters" must be an array.');
  }
  const chapters: BookChapter[] = raw.chapters.map((c: any, i: number) => {
    if (!c || typeof c !== 'object') {
      throw new Error(`Invalid book file: chapter ${i + 1} is not an object.`);
    }
    const file = asString(c.file);
    if (!file) throw new Error(`Invalid book file: chapter ${i + 1} is missing a "file" path.`);
    return {
      id: asString(c.id) || makeChapterId(),
      title: asString(c.title, `Chapter ${i + 1}`),
      file,
    };
  });

  const coverRaw = (raw.cover && typeof raw.cover === 'object') ? raw.cover : {};
  const coverTheme = COVER_THEME_NAMES.includes(coverRaw.theme) ? coverRaw.theme as CoverTheme : 'ink';
  const coverMode: BookCover['mode'] =
    coverRaw.mode === 'image' || coverRaw.mode === 'none' ? coverRaw.mode : 'theme';

  const styleRaw = (raw.style && typeof raw.style === 'object') ? raw.style : {};
  const fontFamily: BookFontFamily =
    styleRaw.fontFamily === 'sans-serif' || styleRaw.fontFamily === 'monospace' ? styleRaw.fontFamily : 'serif';
  const split: ChapterSplit =
    styleRaw.chapterSplit === 'h1' || styleRaw.chapterSplit === 'h2' ? styleRaw.chapterSplit : 'file';
  const lineHeight = typeof styleRaw.lineHeight === 'number' && styleRaw.lineHeight > 0 ? styleRaw.lineHeight : 1.7;

  const fmRaw = (raw.frontMatter && typeof raw.frontMatter === 'object') ? raw.frontMatter : {};

  return {
    title: asString(raw.title, 'Untitled Book'),
    author: asString(raw.author),
    language: asString(raw.language, 'en'),
    publisher: asString(raw.publisher),
    publishedDate: asString(raw.publishedDate),
    identifier: asString(raw.identifier),
    cover: { mode: coverMode, theme: coverTheme, imagePath: asString(coverRaw.imagePath) || undefined },
    style: { fontFamily, lineHeight, chapterSplit: split },
    frontMatter: {
      titlePage: asBool(fmRaw.titlePage, true),
      colophon: asBool(fmRaw.colophon, true),
      tocPage: asBool(fmRaw.tocPage, true),
    },
    chapters,
  };
}

/** Serialize a manifest for writing back to the `.bbook` file. */
export function serializeBookManifest(m: BookManifest): string {
  const cover: BookCover = { mode: m.cover.mode, theme: m.cover.theme };
  if (m.cover.imagePath) cover.imagePath = m.cover.imagePath;
  const ordered = {
    title: m.title,
    author: m.author,
    language: m.language,
    publisher: m.publisher,
    publishedDate: m.publishedDate,
    identifier: m.identifier,
    cover,
    style: m.style,
    frontMatter: m.frontMatter,
    chapters: m.chapters,
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

/** A fresh single-chapter book. */
export function createStarterManifest(title: string, author: string): BookManifest {
  return {
    title: title || 'Untitled Book',
    author: author || '',
    language: 'en',
    publisher: '',
    publishedDate: '',
    identifier: '',
    cover: { mode: 'theme', theme: 'ink' },
    style: { fontFamily: 'serif', lineHeight: 1.7, chapterSplit: 'file' },
    frontMatter: { titlePage: true, colophon: true, tocPage: true },
    chapters: [{ id: makeChapterId(), title: 'Chapter 1', file: 'chapters/chapter-1.md' }],
  };
}

export const STARTER_CHAPTER_MD = `# Chapter 1\n\nStart writing your first chapter here.\n`;

/** Directory portion of a path, handling both `/` and `\\` separators. */
export function bookDir(manifestPath: string): string {
  const idx = Math.max(manifestPath.lastIndexOf('/'), manifestPath.lastIndexOf('\\'));
  return idx >= 0 ? manifestPath.slice(0, idx) : '';
}

/** Join a manifest-relative path onto its folder, using the folder's separator. */
export function joinBookPath(dir: string, rel: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const cleanRel = rel.replace(/^[/\\]+/, '').replace(/\\/g, sep).replace(/\//g, sep);
  if (!dir) return cleanRel;
  return `${dir.replace(/[/\\]+$/, '')}${sep}${cleanRel}`;
}

/** Absolute path of a chapter file given the manifest path. */
export function resolveChapterPath(manifestPath: string, file: string): string {
  return joinBookPath(bookDir(manifestPath), file);
}

/** Pick a `chapters/chapter-N.md` name that does not collide with existing files. */
export function nextChapterFile(existing: string[]): string {
  const used = new Set(existing.map(f => f.toLowerCase()));
  for (let n = 1; n < 100000; n++) {
    const candidate = `chapters/chapter-${n}.md`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `chapters/chapter-${Date.now()}.md`;
}

export function makeChapterId(): string {
  return 'ch-' + Math.random().toString(36).slice(2, 10);
}

/** Count words in prose. Empty/whitespace input counts as zero. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** File extension (lowercase, no dot) or "png" when the name has none. */
export function imageExt(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]+$/.test(ext) ? ext : 'png';
}

// ─── Component ────────────────────────────────────────────────

interface BookStudioProps {
  filePath: string;
  style: { bg: string; text: string; accent: string };
  isLightTheme: boolean;
  fontFamily: string;
  onModifiedChange?: (modified: boolean) => void;
  onSaved?: (path: string) => void;
  /** Open a produced file (e.g. the exported EPUB) in the parent editor. */
  onOpenFileByPath?: (path: string, focus: boolean) => void;
}

type RightTab = 'preview' | 'cover' | 'book';

async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

export default function BookStudio(props: BookStudioProps) {
  const { filePath, style } = props;
  const [manifest, setManifest] = useState<BookManifest | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [chapterContents, setChapterContents] = useState<Record<string, string>>({});
  const [dirtyChapters, setDirtyChapters] = useState<Record<string, boolean>>({});
  const [manifestDirty, setManifestDirty] = useState(false);

  const [rightTab, setRightTab] = useState<RightTab>('preview');
  const [coverDataUrl, setCoverDataUrl] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const [toast, setToast] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'epub' | 'pdf'>(null);

  const manifestRef = useRef<BookManifest | null>(null);
  const manifestDirtyRef = useRef(false);
  const chapterContentsRef = useRef<Record<string, string>>({});
  const dirtyRef = useRef<Record<string, boolean>>({});
  const autosaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pdfHostRef = useRef<HTMLDivElement>(null);

  manifestRef.current = manifest;
  manifestDirtyRef.current = manifestDirty;
  chapterContentsRef.current = chapterContents;
  dirtyRef.current = dirtyChapters;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const anyDirty = manifestDirty || Object.values(dirtyChapters).some(Boolean);
  useEffect(() => { props.onModifiedChange?.(anyDirty); }, [anyDirty]);

  // ── Load manifest ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setParseError(null);
    (async () => {
      try {
        const json = await invoke<string>('read_file', { path: filePath });
        if (cancelled) return;
        const parsed = parseBookManifest(json);
        setManifest(parsed);
        setActiveChapterId(parsed.chapters[0]?.id ?? null);
      } catch (err) {
        if (!cancelled) setParseError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  // ── Load the active chapter's markdown on demand ───────────
  const loadChapter = useCallback(async (chapter: BookChapter) => {
    if (chapterContentsRef.current[chapter.id] !== undefined) return;
    try {
      const text = await invoke<string>('read_file', { path: resolveChapterPath(filePath, chapter.file) });
      setChapterContents(prev => (prev[chapter.id] !== undefined ? prev : { ...prev, [chapter.id]: text }));
    } catch {
      // A missing chapter file starts empty; saving recreates it.
      setChapterContents(prev => (prev[chapter.id] !== undefined ? prev : { ...prev, [chapter.id]: '' }));
    }
  }, [filePath]);

  useEffect(() => {
    if (!manifest || !activeChapterId) return;
    const ch = manifest.chapters.find(c => c.id === activeChapterId);
    if (ch) void loadChapter(ch);
  }, [manifest, activeChapterId, loadChapter]);

  // ── Load cover image preview when the manifest points at one ─
  useEffect(() => {
    if (!manifest) return;
    if (manifest.cover.mode !== 'image' || !manifest.cover.imagePath) { setCoverDataUrl(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const path = joinBookPath(bookDir(filePath), manifest.cover.imagePath!);
        const base64 = await invoke<string>('read_file_base64', { path });
        const ext = imageExt(manifest.cover.imagePath!);
        if (!cancelled) setCoverDataUrl(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${base64}`);
      } catch {
        if (!cancelled) setCoverDataUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, [manifest?.cover.mode, manifest?.cover.imagePath, filePath]);

  // ── Mutations ──────────────────────────────────────────────
  const patchManifest = useCallback((patch: Partial<BookManifest>) => {
    setManifest(prev => (prev ? { ...prev, ...patch } : prev));
    setManifestDirty(true);
  }, []);

  const writeChapterFile = useCallback(async (chapter: BookChapter, content: string) => {
    await invoke('write_file', { path: resolveChapterPath(filePath, chapter.file), content });
  }, [filePath]);

  const scheduleAutosave = useCallback((chapterId: string) => {
    if (autosaveTimers.current[chapterId]) clearTimeout(autosaveTimers.current[chapterId]);
    autosaveTimers.current[chapterId] = setTimeout(() => {
      const m = manifestRef.current;
      const ch = m?.chapters.find(c => c.id === chapterId);
      if (!ch) return;
      const content = chapterContentsRef.current[chapterId] ?? '';
      writeChapterFile(ch, content)
        .then(() => setDirtyChapters(prev => ({ ...prev, [chapterId]: false })))
        .catch(err => showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`));
    }, 3000);
  }, [writeChapterFile, showToast]);

  const handleChapterEdit = useCallback((value: string) => {
    if (!activeChapterId) return;
    setChapterContents(prev => ({ ...prev, [activeChapterId]: value }));
    setDirtyChapters(prev => ({ ...prev, [activeChapterId]: true }));
    scheduleAutosave(activeChapterId);
  }, [activeChapterId, scheduleAutosave]);

  const saveManifest = useCallback(async () => {
    const m = manifestRef.current;
    if (!m) return;
    try {
      await invoke('write_file', { path: filePath, content: serializeBookManifest(m) });
      setManifestDirty(false);
      props.onSaved?.(filePath);
    } catch (err) {
      showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [filePath, props.onSaved, showToast]);

  const flushAll = useCallback(async () => {
    const m = manifestRef.current;
    if (!m) return;
    for (const ch of m.chapters) {
      if (dirtyRef.current[ch.id]) {
        try {
          await writeChapterFile(ch, chapterContentsRef.current[ch.id] ?? '');
          setDirtyChapters(prev => ({ ...prev, [ch.id]: false }));
        } catch (err) {
          showToast(`Save failed (${ch.title}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    await saveManifest();
  }, [writeChapterFile, saveManifest, showToast]);

  // Cmd/Ctrl+S saves everything.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void flushAll();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [flushAll]);

  // Best-effort flush of pending edits on unmount.
  useEffect(() => () => {
    Object.values(autosaveTimers.current).forEach(clearTimeout);
    const m = manifestRef.current;
    if (!m) return;
    for (const ch of m.chapters) {
      if (dirtyRef.current[ch.id]) {
        void invoke('write_file', { path: resolveChapterPath(filePath, ch.file), content: chapterContentsRef.current[ch.id] ?? '' }).catch(() => {});
      }
    }
    if (manifestDirtyRef.current) {
      void invoke('write_file', { path: filePath, content: serializeBookManifest(m) }).catch(() => {});
    }
  }, [filePath]);

  const addChapter = useCallback(async () => {
    const m = manifestRef.current;
    if (!m) return;
    const file = nextChapterFile(m.chapters.map(c => c.file));
    const id = makeChapterId();
    const title = `Chapter ${m.chapters.length + 1}`;
    const content = `# ${title}\n\n`;
    try {
      await invoke('write_file', { path: resolveChapterPath(filePath, file), content });
    } catch (err) {
      showToast(`Could not create chapter: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setChapterContents(prev => ({ ...prev, [id]: content }));
    patchManifest({ chapters: [...m.chapters, { id, title, file }] });
    setActiveChapterId(id);
  }, [filePath, patchManifest, showToast]);

  const deleteChapter = useCallback(async (id: string) => {
    const m = manifestRef.current;
    if (!m) return;
    const ch = m.chapters.find(c => c.id === id);
    if (!ch) return;
    const remaining = m.chapters.filter(c => c.id !== id);
    patchManifest({ chapters: remaining });
    if (activeChapterId === id) setActiveChapterId(remaining[0]?.id ?? null);
    try {
      await invoke('delete_path', { path: resolveChapterPath(filePath, ch.file) });
    } catch {
      // Removing the manifest entry is what matters; a stray file is harmless.
    }
  }, [filePath, activeChapterId, patchManifest]);

  const renameChapter = useCallback((id: string, title: string) => {
    const m = manifestRef.current;
    if (!m) return;
    patchManifest({ chapters: m.chapters.map(c => (c.id === id ? { ...c, title } : c)) });
  }, [patchManifest]);

  const reorderChapters = useCallback((fromId: string, toId: string) => {
    const m = manifestRef.current;
    if (!m || fromId === toId) return;
    const list = [...m.chapters];
    const from = list.findIndex(c => c.id === fromId);
    const to = list.findIndex(c => c.id === toId);
    if (from < 0 || to < 0) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    patchManifest({ chapters: list });
  }, [patchManifest]);

  const pickCoverImage = useCallback(async (file: File | undefined) => {
    const m = manifestRef.current;
    if (!file || !m) return;
    try {
      const base64 = await fileToBase64(file);
      const ext = imageExt(file.name);
      const rel = `cover.${ext}`;
      await invoke('write_file_base64', { path: joinBookPath(bookDir(filePath), rel), base64Data: base64 });
      setCoverDataUrl(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${base64}`);
      patchManifest({ cover: { ...m.cover, mode: 'image', imagePath: rel } });
    } catch (err) {
      showToast(`Cover image failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [filePath, patchManifest, showToast]);

  // ── Gather chapter content for export (uses live edits, reads the rest) ──
  const gatherChapters = useCallback(async (m: BookManifest): Promise<{ name: string; data: string }[]> => {
    const out: { name: string; data: string }[] = [];
    for (const ch of m.chapters) {
      let content = chapterContentsRef.current[ch.id];
      if (content === undefined) {
        try { content = await invoke<string>('read_file', { path: resolveChapterPath(filePath, ch.file) }); }
        catch { content = ''; }
      }
      out.push({ name: `${(ch.title || 'Chapter').replace(/[/\\]/g, '-')}.md`, data: content });
    }
    return out;
  }, [filePath]);

  const resolveExportCover = useCallback(async (m: BookManifest): Promise<import('../utils/mdToEpub').CoverOption> => {
    if (m.cover.mode === 'none') return { kind: 'none' };
    if (m.cover.mode === 'image' && m.cover.imagePath) {
      try {
        const path = joinBookPath(bookDir(filePath), m.cover.imagePath);
        const base64 = await invoke<string>('read_file_base64', { path });
        const ext = imageExt(m.cover.imagePath);
        return { kind: 'image', dataUrl: `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${base64}` };
      } catch {
        return { kind: 'theme', theme: m.cover.theme };
      }
    }
    return { kind: 'theme', theme: m.cover.theme };
  }, [filePath]);

  const buildStyleOptions = useCallback((m: BookManifest, cover: import('../utils/mdToEpub').CoverOption): import('../utils/mdToEpub').EpubStyleOptions => ({
    author: m.author.trim(),
    language: m.language,
    fontFamily: m.style.fontFamily,
    lineHeight: m.style.lineHeight,
    chapterSplit: m.style.chapterSplit,
    publisher: m.publisher.trim(),
    publishedDate: m.publishedDate,
    identifier: m.identifier.trim(),
    cover,
    titlePage: m.frontMatter.titlePage,
    colophon: m.frontMatter.colophon,
    tocPage: m.frontMatter.tocPage,
  }), []);

  const exportEpub = useCallback(async () => {
    const m = manifestRef.current;
    if (!m || busy) return;
    setPublishOpen(false);
    setBusy('epub');
    try {
      await flushAll();
      const { multiFilesToEpub } = await import('../utils/mdToEpub');
      const chapters = await gatherChapters(m);
      const cover = await resolveExportCover(m);
      const style = buildStyleOptions(m, cover);
      const files = chapters.map(c => ({ name: c.name, type: 'md' as const, data: c.data }));
      const safe = (m.title || 'Book').replace(/[/\\:*?"<>|]/g, '_');
      const savePath = await invoke<string | null>('save_file_dialog', {
        defaultName: `${safe}.epub`,
        filters: [['EPUB', ['epub']]],
      });
      if (!savePath) return;
      const result = await multiFilesToEpub({ files, title: m.title || 'Book', style });
      await invoke('write_file_base64', { path: savePath, base64Data: result.base64 });
      const outName = savePath.split(/[/\\]/).pop() || `${safe}.epub`;
      if (result.warnings.length > 0) showToast(`EPUB exported with ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}: ${outName}`);
      else showToast(`EPUB exported: ${outName}`);
      props.onOpenFileByPath?.(savePath, true);
    } catch (err) {
      showToast(`EPUB export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [busy, flushAll, gatherChapters, resolveExportCover, buildStyleOptions, props.onOpenFileByPath, showToast]);

  const exportPdf = useCallback(async () => {
    const m = manifestRef.current;
    if (!m || busy) return;
    setPublishOpen(false);
    setBusy('pdf');
    const host = pdfHostRef.current;
    try {
      await flushAll();
      const [{ buildBookCss, EPUB_STYLE_DEFAULTS, buildCoverSvg }, MarkdownItMod] = await Promise.all([
        import('../utils/mdToEpub'),
        import('markdown-it'),
      ]);
      const MarkdownIt = MarkdownItMod.default;
      const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
      const chapters = await gatherChapters(m);
      const resolved = { ...EPUB_STYLE_DEFAULTS, fontFamily: m.style.fontFamily, lineHeight: m.style.lineHeight, chapterSplit: m.style.chapterSplit };
      const css = buildBookCss(resolved);

      let coverBlock = '';
      if (m.cover.mode === 'image' && coverDataUrl) {
        coverBlock = `<div class="bs-pdf-cover"><img src="${coverDataUrl}"/></div>`;
      } else if (m.cover.mode === 'theme') {
        const svg = buildCoverSvg(m.title, m.author, m.cover.theme);
        coverBlock = `<div class="bs-pdf-cover">${svg}</div>`;
      }
      const titleBlock = m.frontMatter.titlePage
        ? `<div class="bs-pdf-title"><h1>${escapeHtml(m.title)}</h1>${m.author ? `<p>${escapeHtml(m.author)}</p>` : ''}</div>`
        : '';
      const body = chapters.map(c => `<section class="bs-pdf-chapter">${md.render(c.data)}</section>`).join('');

      if (!host) throw new Error('PDF host not ready');
      host.innerHTML = `<style>${css}
        .bs-pdf-cover { text-align: center; page-break-after: always; }
        .bs-pdf-cover img, .bs-pdf-cover svg { max-width: 100%; max-height: 190mm; }
        .bs-pdf-title { text-align: center; padding: 40mm 0; page-break-after: always; }
        .bs-pdf-title h1 { border: none; font-size: 2em; }
        .bs-pdf-chapter { page-break-before: always; }
      </style><div class="bs-pdf-root" style="font-family:${m.style.fontFamily};line-height:${m.style.lineHeight};color:#111;background:#fff;padding:4mm;">${coverBlock}${titleBlock}${body}</div>`;
      const root = host.querySelector('.bs-pdf-root') as HTMLElement;

      const html2pdf = (await import('html2pdf.js')).default;
      const worker = html2pdf().set({
        margin: [8, 8, 8, 8],
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, logging: false },
        jsPDF: { unit: 'mm', format: 'a5', orientation: 'portrait' },
        enableLinks: true,
      }).from(root);
      const blob: Blob = await worker.toPdf().output('blob');
      const base64 = await blobToBase64(blob);

      const safe = (m.title || 'Book').replace(/[/\\:*?"<>|]/g, '_');
      const savePath = await invoke<string | null>('save_file_dialog', {
        defaultName: `${safe}.pdf`,
        filters: [['PDF', ['pdf']]],
      });
      if (!savePath) return;
      await invoke('write_file_base64', { path: savePath, base64Data: base64 });
      const outName = savePath.split(/[/\\]/).pop() || `${safe}.pdf`;
      showToast(`PDF exported: ${outName}`);
    } catch (err) {
      showToast(`PDF export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (host) host.innerHTML = '';
      setBusy(null);
    }
  }, [busy, flushAll, gatherChapters, coverDataUrl, showToast]);

  // ── Preview iframe (reuses the exact book stylesheet) ──────
  const [previewCss, setPreviewCss] = useState('');
  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    (async () => {
      const { buildBookCss, EPUB_STYLE_DEFAULTS } = await import('../utils/mdToEpub');
      const resolved = { ...EPUB_STYLE_DEFAULTS, fontFamily: manifest.style.fontFamily, lineHeight: manifest.style.lineHeight, chapterSplit: manifest.style.chapterSplit };
      if (!cancelled) setPreviewCss(buildBookCss(resolved));
    })();
    return () => { cancelled = true; };
  }, [manifest?.style.fontFamily, manifest?.style.lineHeight, manifest?.style.chapterSplit]);

  const [previewHtml, setPreviewHtml] = useState('');
  const activeContent = activeChapterId ? chapterContents[activeChapterId] : undefined;
  useEffect(() => {
    if (rightTab !== 'preview' || !manifest || !previewCss) return;
    let cancelled = false;
    (async () => {
      const MarkdownIt = (await import('markdown-it')).default;
      const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
      const rendered = md.render(activeContent || '');
      const bg = props.isLightTheme ? '#ffffff' : '#14141c';
      const fg = props.isLightTheme ? '#1a1a1a' : '#e8e8ec';
      const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>${previewCss}</style>
        <style>body{font-family:${manifest.style.fontFamily};line-height:${manifest.style.lineHeight};padding:24px;background:${bg};color:${fg};max-width:none;}</style></head>
        <body>${rendered}</body></html>`;
      if (!cancelled) setPreviewHtml(doc);
    })();
    return () => { cancelled = true; };
  }, [rightTab, activeContent, previewCss, manifest?.style.fontFamily, manifest?.style.lineHeight, props.isLightTheme]);

  // ── CodeMirror theme + extensions ──────────────────────────
  const cmTheme = useMemo(
    () => createCMTheme({ bg: style.bg, text: style.text, accent: style.accent }, props.fontFamily, 14),
    [style.bg, style.text, style.accent, props.fontFamily],
  );
  const cmExtensions = useMemo<Extension[]>(() => [markdown()], []);

  const activeChapter = manifest?.chapters.find(c => c.id === activeChapterId) || null;
  const wordCount = countWords(activeContent || '');

  // ── Render ─────────────────────────────────────────────────
  if (loading) {
    return <div className="book-studio-empty" style={{ background: style.bg, color: style.text }}>Loading book…</div>;
  }
  if (parseError || !manifest) {
    return (
      <div className="book-studio-error" style={{ background: style.bg, color: style.text }}>
        <BookOpen size={28} style={{ opacity: 0.4 }} />
        <h3>This book file could not be opened</h3>
        <p>{parseError || 'Unknown error'}</p>
        <p className="book-studio-error-hint">Saving is disabled to protect the original file. Fix the JSON and reopen.</p>
      </div>
    );
  }

  return (
    <div className="book-studio" style={{ ['--bs-accent' as any]: style.accent, background: style.bg, color: style.text }}>
      {/* Toolbar */}
      <div className="book-studio-toolbar">
        <div className="book-studio-brand"><BookOpen size={15} style={{ color: style.accent }} /><span>{manifest.title || 'Untitled Book'}</span>{anyDirty && <span className="book-studio-dot" title="Unsaved changes" />}</div>
        <div className="book-studio-toolbar-actions">
          <button className="book-studio-btn" onClick={() => void flushAll()} title="Save (⌘S)"><Save size={13} /> Save</button>
          <div className="book-studio-publish">
            <button className="book-studio-btn primary" onClick={() => setPublishOpen(v => !v)} disabled={!!busy}>
              {busy ? <><span className="book-studio-spinner" /> {busy === 'epub' ? 'Exporting EPUB…' : 'Exporting PDF…'}</> : <><Upload size={13} /> Publish <ChevronDown size={12} /></>}
            </button>
            {publishOpen && !busy && (
              <div className="book-studio-menu" onMouseLeave={() => setPublishOpen(false)}>
                <button onClick={() => void exportEpub()}><BookOpen size={13} /> Export EPUB</button>
                <button onClick={() => void exportPdf()}><FileText size={13} /> Export PDF</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="book-studio-body">
        {/* Left: chapters */}
        <div className="book-studio-chapters">
          <div className="book-studio-col-head"><span>Chapters</span><button className="book-studio-icon-btn" onClick={() => void addChapter()} title="Add chapter"><Plus size={14} /></button></div>
          <div className="book-studio-chapter-list">
            {manifest.chapters.length === 0 && <div className="book-studio-hint">No chapters yet. Add one to start writing.</div>}
            {manifest.chapters.map((ch, i) => (
              <div
                key={ch.id}
                className={`book-studio-chapter-item ${ch.id === activeChapterId ? 'active' : ''} ${dragId === ch.id ? 'dragging' : ''}`}
                draggable={renamingId !== ch.id}
                onDragStart={() => setDragId(ch.id)}
                onDragEnd={() => setDragId(null)}
                onDragOver={e => e.preventDefault()}
                onDrop={() => { if (dragId) reorderChapters(dragId, ch.id); setDragId(null); }}
                onClick={() => setActiveChapterId(ch.id)}
              >
                <GripVertical size={13} className="book-studio-grip" />
                <span className="book-studio-chapter-num">{i + 1}</span>
                {renamingId === ch.id ? (
                  <input
                    autoFocus
                    className="book-studio-rename"
                    defaultValue={ch.title}
                    onBlur={e => { renameChapter(ch.id, e.target.value.trim() || ch.title); setRenamingId(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenamingId(null); }}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <span className="book-studio-chapter-title" onDoubleClick={() => setRenamingId(ch.id)}>
                    {ch.title}{dirtyChapters[ch.id] && <span className="book-studio-dot small" />}
                  </span>
                )}
                <button className="book-studio-chapter-del" title="Delete chapter" onClick={e => { e.stopPropagation(); void deleteChapter(ch.id); }}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </div>

        {/* Middle: editor */}
        <div className="book-studio-editor">
          {activeChapter ? (
            <>
              <div className="book-studio-editor-head">
                <span className="book-studio-editor-title">{activeChapter.title}</span>
                <span className="book-studio-wordcount">{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
              </div>
              <div className="book-studio-cm">
                <CodeMirror
                  value={activeContent ?? ''}
                  extensions={cmExtensions}
                  theme={cmTheme}
                  onChange={handleChapterEdit}
                  basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
                  height="100%"
                  style={{ height: '100%' }}
                />
              </div>
            </>
          ) : (
            <div className="book-studio-empty-mid">Select or add a chapter to start writing.</div>
          )}
        </div>

        {/* Right: preview / cover / book */}
        <div className="book-studio-panel">
          <div className="book-studio-tabs">
            <button className={rightTab === 'preview' ? 'active' : ''} onClick={() => setRightTab('preview')}><FileText size={12} /> Preview</button>
            <button className={rightTab === 'cover' ? 'active' : ''} onClick={() => setRightTab('cover')}><ImageIcon size={12} /> Cover</button>
            <button className={rightTab === 'book' ? 'active' : ''} onClick={() => setRightTab('book')}><Settings2 size={12} /> Book</button>
          </div>

          <div className="book-studio-panel-body">
            {rightTab === 'preview' && (
              activeChapter
                ? <iframe className="book-studio-preview" title="Chapter preview" srcDoc={previewHtml} />
                : <div className="book-studio-hint pad">Nothing to preview yet.</div>
            )}

            {rightTab === 'cover' && (
              <div className="book-studio-cover-tab">
                <div className="book-studio-field-row">
                  <label>Cover source</label>
                  <div className="book-studio-seg">
                    {(['theme', 'image', 'none'] as const).map(mode => (
                      <button key={mode} className={manifest.cover.mode === mode ? 'active' : ''} onClick={() => patchManifest({ cover: { ...manifest.cover, mode } })}>
                        {mode === 'theme' ? 'Theme' : mode === 'image' ? 'Image' : 'None'}
                      </button>
                    ))}
                  </div>
                </div>

                {manifest.cover.mode === 'theme' && (
                  <div className="book-studio-cover-grid">
                    {COVER_THEME_NAMES.map(theme => (
                      <button
                        key={theme}
                        className={`book-studio-cover-thumb ${manifest.cover.theme === theme ? 'active' : ''}`}
                        title={theme}
                        onClick={() => patchManifest({ cover: { ...manifest.cover, mode: 'theme', theme } })}
                      >
                        <CoverThumb title={manifest.title} author={manifest.author} theme={theme} />
                        <span>{theme}</span>
                      </button>
                    ))}
                  </div>
                )}

                {manifest.cover.mode === 'image' && (
                  <div className="book-studio-cover-image">
                    {coverDataUrl ? <img src={coverDataUrl} alt="Cover" /> : <div className="book-studio-cover-empty">No image selected</div>}
                    <label className="book-studio-btn file">
                      <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => void pickCoverImage(e.target.files?.[0])} />
                      Choose image…
                    </label>
                  </div>
                )}

                {manifest.cover.mode === 'none' && <div className="book-studio-hint pad">This book will have no cover page.</div>}
              </div>
            )}

            {rightTab === 'book' && (
              <div className="book-studio-book-tab">
                <Field label="Title"><input value={manifest.title} onChange={e => patchManifest({ title: e.target.value })} /></Field>
                <Field label="Author"><input value={manifest.author} onChange={e => patchManifest({ author: e.target.value })} placeholder="Optional" /></Field>
                <Field label="Language">
                  <select value={manifest.language} onChange={e => patchManifest({ language: e.target.value })}>
                    <option value="en">English</option><option value="ko">Korean</option><option value="ja">Japanese</option>
                    <option value="zh">Chinese</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option>
                  </select>
                </Field>
                <Field label="Publisher"><input value={manifest.publisher} onChange={e => patchManifest({ publisher: e.target.value })} placeholder="Optional" /></Field>
                <Field label="Published"><input type="date" value={manifest.publishedDate} onChange={e => patchManifest({ publishedDate: e.target.value })} /></Field>
                <Field label="Identifier"><input value={manifest.identifier} onChange={e => patchManifest({ identifier: e.target.value })} placeholder="ISBN / UUID (auto)" /></Field>

                <div className="book-studio-divider" />
                <Field label="Font">
                  <select value={manifest.style.fontFamily} onChange={e => patchManifest({ style: { ...manifest.style, fontFamily: e.target.value as BookFontFamily } })}>
                    <option value="serif">Serif</option><option value="sans-serif">Sans-serif</option><option value="monospace">Monospace</option>
                  </select>
                </Field>
                <Field label="Line height">
                  <input type="number" step="0.05" min="1" max="2.5" value={manifest.style.lineHeight} onChange={e => patchManifest({ style: { ...manifest.style, lineHeight: Number(e.target.value) || 1.7 } })} />
                </Field>
                <Field label="Chapters from">
                  <select value={manifest.style.chapterSplit} onChange={e => patchManifest({ style: { ...manifest.style, chapterSplit: e.target.value as ChapterSplit } })}>
                    <option value="file">One file per chapter</option><option value="h1"># headings</option><option value="h2">## headings</option>
                  </select>
                </Field>

                <div className="book-studio-divider" />
                <div className="book-studio-toggles">
                  <label><input type="checkbox" checked={manifest.frontMatter.titlePage} onChange={e => patchManifest({ frontMatter: { ...manifest.frontMatter, titlePage: e.target.checked } })} /> Title page</label>
                  <label><input type="checkbox" checked={manifest.frontMatter.colophon} onChange={e => patchManifest({ frontMatter: { ...manifest.frontMatter, colophon: e.target.checked } })} /> Colophon</label>
                  <label><input type="checkbox" checked={manifest.frontMatter.tocPage} onChange={e => patchManifest({ frontMatter: { ...manifest.frontMatter, tocPage: e.target.checked } })} /> Table of contents</label>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Off-screen host for PDF rendering */}
      <div ref={pdfHostRef} style={{ position: 'fixed', left: '-99999px', top: 0, width: '148mm', zIndex: -1 }} />

      {toast && (
        <div className="book-studio-toast">
          <span>{toast}</span>
          <button onClick={() => setToast(null)}><X size={12} /></button>
        </div>
      )}
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="book-studio-field">
      <label>{props.label}</label>
      {props.children}
    </div>
  );
}

function CoverThumb(props: { title: string; author: string; theme: CoverTheme }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let cancelled = false;
    import('../utils/mdToEpub').then(({ buildCoverSvg }) => {
      if (!cancelled) setSvg(buildCoverSvg(props.title, props.author, props.theme));
    });
    return () => { cancelled = true; };
  }, [props.title, props.author, props.theme]);
  return <span className="book-studio-cover-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
