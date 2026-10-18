/**
 * EpubReader.tsx
 *
 * EPUB book viewer — parses .epub (ZIP) files using JSZip,
 * extracts chapters from the spine, and renders HTML content.
 *
 * Supports EPUB2 (NCX) and EPUB3 (nav.xhtml) tables of contents with nested
 * hierarchy, original stylesheets, cover pages, persisted reading position,
 * reading themes, and full-text search.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import JSZip from 'jszip';
import { invoke } from '@tauri-apps/api/core';
import { ChevronLeft, ChevronRight, List, Plus, Minus, BookOpen, Search, X, Palette, BookText, ScrollText, Pencil, Check } from 'lucide-react';
import './EpubReader.css';

export interface TocEntry {
  title: string;
  href: string;
  spineIndex: number;
  /** Nesting depth in the TOC tree (0 = top level). */
  level: number;
}

interface SpineItem {
  id: string;
  href: string;
  /** full path inside zip */
  fullPath: string;
}

interface SearchHit {
  spineIndex: number;
  title: string;
  snippet: string;
}

type ReadingTheme = 'auto' | 'light' | 'sepia' | 'dark';
type ReadingFont = 'serif' | 'sans';

interface EpubReaderProps {
  filePath: string;
  epubData: string; // data:application/epub+zip;base64,...
  style: { bg: string; text: string; accent?: string; border?: string };
  /** Called after the book's metadata is saved back to disk. */
  onSaved?: (path: string) => void;
  /** Mirrors the other editors so tabs can show a dirty indicator. */
  onModifiedChange?: (modified: boolean) => void;
}

const READING_THEMES: Record<Exclude<ReadingTheme, 'auto'>, { bg: string; text: string }> = {
  light: { bg: '#ffffff', text: '#1a1a1a' },
  sepia: { bg: '#f4ecd8', text: '#5b4636' },
  dark: { bg: '#1a1a1a', text: '#d8d8d8' },
};

const PREFS_KEY = 'epub-reader-prefs';
const SCOPE_CLASS = 'epub-chapter';

interface ReaderPrefs {
  theme: ReadingTheme;
  font: ReadingFont;
  fontSize: number;
  pageMode: boolean;
}

function loadPrefs(): ReaderPrefs {
  const fallback: ReaderPrefs = { theme: 'auto', font: 'serif', fontSize: 16, pageMode: false };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

function positionKey(filePath: string): string {
  return `epub-pos:${filePath}`;
}

export default function EpubReader({ filePath, epubData, style, onSaved, onModifiedChange }: EpubReaderProps) {
  const [spine, setSpine] = useState<SpineItem[]>([]);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [bookTitle, setBookTitle] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [chapterHtml, setChapterHtml] = useState('');
  const [showToc, setShowToc] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'cover' | 'reading'>('reading');

  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs);
  const [showThemeMenu, setShowThemeMenu] = useState(false);

  const [showSearch, setShowSearch] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [highlightQuery, setHighlightQuery] = useState('');

  // Page view (CSS multi-column pagination)
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pageWidth, setPageWidth] = useState(0);
  const [pageHeight, setPageHeight] = useState(0);

  // Metadata editing
  const [bookMeta, setBookMeta] = useState({ creator: '', publisher: '', language: '' });
  const [showMetaPanel, setShowMetaPanel] = useState(false);
  const [metaDraft, setMetaDraft] = useState({ title: '', creator: '', publisher: '', language: '' });
  const [metaSaving, setMetaSaving] = useState(false);
  const [metaSaveMsg, setMetaSaveMsg] = useState('');

  const zipRef = useRef<JSZip | null>(null);
  const contentDirRef = useRef('');
  const opfPathRef = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageViewportRef = useRef<HTMLDivElement>(null);
  const pageInnerRef = useRef<HTMLDivElement>(null);
  const chapterBlobsRef = useRef<string[]>([]);
  const coverBlobRef = useRef<string | null>(null);
  const textIndexRef = useRef<Map<number, string>>(new Map());
  const pendingScrollRef = useRef<number | null>(null);
  const pendingPageRef = useRef<number | null>(null);
  const pendingLastPageRef = useRef(false);
  const restoredRef = useRef(false);

  const PAGE_GAP = 48;

  // Persist preferences whenever they change.
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch { /* ignore quota errors */ }
  }, [prefs]);

  // Parse EPUB on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError('');

        const base64 = epubData.replace(/^data:[^;]+;base64,/, '');
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const zip = await JSZip.loadAsync(bytes);
        if (cancelled) return;
        zipRef.current = zip;

        // 1. container.xml -> rootfile (content.opf)
        const containerXml = await zip.file('META-INF/container.xml')?.async('text');
        if (!containerXml) { setError('META-INF/container.xml not found'); setLoading(false); return; }

        const parser = new DOMParser();
        const containerDoc = parser.parseFromString(containerXml, 'application/xml');
        const rootfilePath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
        if (!rootfilePath) { setError('rootfile not found in container.xml'); setLoading(false); return; }

        const contentDir = rootfilePath.includes('/') ? rootfilePath.substring(0, rootfilePath.lastIndexOf('/') + 1) : '';
        contentDirRef.current = contentDir;

        // 2. content.opf
        const opfXml = await zip.file(rootfilePath)?.async('text');
        if (!opfXml) { setError(`${rootfilePath} not found`); setLoading(false); return; }

        const opfDoc = parser.parseFromString(opfXml, 'application/xml');
        opfPathRef.current = rootfilePath;

        const DC_NS = 'http://purl.org/dc/elements/1.1/';
        const dcText = (tag: string) =>
          opfDoc.getElementsByTagNameNS(DC_NS, tag)[0]?.textContent
          || opfDoc.querySelector(`metadata ${tag}`)?.textContent
          || '';
        const titleEl = opfDoc.querySelector('metadata title') || opfDoc.getElementsByTagNameNS(DC_NS, 'title')[0];
        setBookTitle(titleEl?.textContent || 'Untitled');
        setBookMeta({ creator: dcText('creator'), publisher: dcText('publisher'), language: dcText('language') });

        // Manifest: id -> { href, properties }
        const manifest = new Map<string, { href: string; properties: string }>();
        opfDoc.querySelectorAll('manifest item').forEach(item => {
          const id = item.getAttribute('id') || '';
          const href = item.getAttribute('href') || '';
          const properties = item.getAttribute('properties') || '';
          if (id && href) manifest.set(id, { href, properties });
        });

        // 3. Spine
        const spineItems: SpineItem[] = [];
        opfDoc.querySelectorAll('spine itemref').forEach(ref => {
          const idref = ref.getAttribute('idref') || '';
          const entry = manifest.get(idref);
          if (entry) {
            spineItems.push({ id: idref, href: entry.href, fullPath: contentDir + entry.href });
          }
        });
        const spineHrefs = spineItems.map(s => s.href);

        // 4. TOC — NCX (EPUB2) first, then nav.xhtml (EPUB3), then spine fallback
        let tocEntries: TocEntry[] = [];

        const tocId = opfDoc.querySelector('spine')?.getAttribute('toc');
        const ncxHref = tocId ? manifest.get(tocId)?.href : undefined;
        if (ncxHref) {
          const ncxXml = await zip.file(contentDir + ncxHref)?.async('text');
          if (ncxXml) tocEntries = parseNcxToc(ncxXml, spineHrefs);
        }

        if (tocEntries.length === 0) {
          const navEntry = Array.from(manifest.values()).find(m => m.properties.split(/\s+/).includes('nav'));
          if (navEntry) {
            const navHtml = await zip.file(contentDir + navEntry.href)?.async('text');
            if (navHtml) tocEntries = parseNavToc(navHtml, spineHrefs);
          }
        }

        if (tocEntries.length === 0) {
          tocEntries = spineItems.map((item, i) => ({
            title: item.href.split('/').pop()?.replace(/\.\w+$/, '') || `Chapter ${i + 1}`,
            href: item.href,
            spineIndex: i,
            level: 0,
          }));
        }

        // 5. Cover image
        let coverHref: string | undefined;
        const coverImageItem = Array.from(manifest.values()).find(m => m.properties.split(/\s+/).includes('cover-image'));
        if (coverImageItem) {
          coverHref = coverImageItem.href;
        } else {
          const metaCover = opfDoc.querySelector('metadata meta[name="cover"]');
          const coverId = metaCover?.getAttribute('content');
          if (coverId) coverHref = manifest.get(coverId)?.href;
        }
        let coverBlobUrl: string | null = null;
        if (coverHref) {
          const coverFile = zip.file(resolvePath(contentDir, coverHref));
          if (coverFile) {
            try {
              const blob = await coverFile.async('blob');
              coverBlobUrl = URL.createObjectURL(blob);
              coverBlobRef.current = coverBlobUrl;
            } catch { /* ignore broken cover */ }
          }
        }

        if (cancelled) return;

        // 6. Restore saved reading position
        let startIndex = 0;
        let savedScroll: number | null = null;
        try {
          const raw = localStorage.getItem(positionKey(filePath));
          if (raw) {
            const pos = JSON.parse(raw);
            if (typeof pos.spineIndex === 'number' && pos.spineIndex < spineItems.length) {
              startIndex = pos.spineIndex;
              savedScroll = typeof pos.scrollTop === 'number' ? pos.scrollTop : null;
              pendingPageRef.current = typeof pos.page === 'number' ? pos.page : null;
            }
          }
        } catch { /* ignore */ }

        setSpine(spineItems);
        setToc(tocEntries);
        setCoverUrl(coverBlobUrl);
        setCurrentIndex(startIndex);
        pendingScrollRef.current = savedScroll;
        // Show the cover only when opening fresh (no saved position).
        setViewMode(coverBlobUrl && !restoredRef.current && startIndex === 0 && savedScroll == null ? 'cover' : 'reading');
        restoredRef.current = true;
        setLoading(false);
      } catch (err) {
        if (!cancelled) { setError(String(err)); setLoading(false); }
      }
    })();

    return () => {
      cancelled = true;
      revokeChapterBlobs();
      if (coverBlobRef.current) { URL.revokeObjectURL(coverBlobRef.current); coverBlobRef.current = null; }
    };
  }, [epubData, filePath]);

  const revokeChapterBlobs = useCallback(() => {
    for (const url of chapterBlobsRef.current) URL.revokeObjectURL(url);
    chapterBlobsRef.current = [];
  }, []);

  // Load chapter content when currentIndex changes
  useEffect(() => {
    if (!zipRef.current || spine.length === 0) return;
    let cancelled = false;
    (async () => {
      const item = spine[currentIndex];
      if (!item) return;
      try {
        const rawHtml = await zipRef.current!.file(item.fullPath)?.async('text');
        if (cancelled) return;
        if (!rawHtml) { setChapterHtml('<p>Chapter content not found</p>'); return; }

        const { html, blobUrls } = await processChapterHtml(rawHtml, zipRef.current!, contentDirRef.current, item.fullPath);
        if (cancelled) {
          for (const url of blobUrls) URL.revokeObjectURL(url);
          return;
        }
        // Revoke the previous chapter's blobs now that the next set is ready.
        revokeChapterBlobs();
        chapterBlobsRef.current = blobUrls;
        setChapterHtml(html);
      } catch (err) {
        if (!cancelled) setChapterHtml(`<p>Error loading chapter: ${escapeHtml(String(err))}</p>`);
      }
    })();
    return () => { cancelled = true; };
  }, [currentIndex, spine, revokeChapterBlobs]);

  // Apply pending/scroll restore and highlight after the chapter renders.
  useEffect(() => {
    if (prefs.pageMode) {
      if (highlightQuery && pageInnerRef.current && pageWidth > 0) {
        const first = highlightMatches(pageInnerRef.current, highlightQuery);
        if (first) setPageIndex(Math.max(0, Math.floor((first as HTMLElement).offsetLeft / pageWidth)));
      }
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    if (highlightQuery) {
      const first = highlightMatches(el, highlightQuery);
      if (first) { first.scrollIntoView({ block: 'center' }); return; }
    }
    if (pendingScrollRef.current != null) {
      el.scrollTop = pendingScrollRef.current;
      pendingScrollRef.current = null;
    } else {
      el.scrollTop = 0;
    }
  }, [chapterHtml, highlightQuery, prefs.pageMode, pageWidth]);

  // Persist reading position on scroll (throttled) and chapter change.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || viewMode !== 'reading') return;
    let timer: number | undefined;
    const save = () => {
      try {
        localStorage.setItem(positionKey(filePath), JSON.stringify({ spineIndex: currentIndex, scrollTop: el.scrollTop }));
      } catch { /* ignore */ }
    };
    const onScroll = () => {
      if (timer) return;
      timer = window.setTimeout(() => { timer = undefined; save(); }, 400);
    };
    el.addEventListener('scroll', onScroll);
    save();
    return () => { el.removeEventListener('scroll', onScroll); if (timer) window.clearTimeout(timer); };
  }, [currentIndex, filePath, viewMode, chapterHtml]);

  const goNext = useCallback(() => {
    setHighlightQuery('');
    setCurrentIndex(i => Math.min(i + 1, spine.length - 1));
  }, [spine.length]);
  const goPrev = useCallback(() => {
    setHighlightQuery('');
    setCurrentIndex(i => Math.max(i - 1, 0));
  }, []);

  // Page turn — crosses chapter boundaries when at an edge.
  const goNextPage = useCallback(() => {
    if (pageIndex < pageCount - 1) { setPageIndex(pageIndex + 1); return; }
    if (currentIndex < spine.length - 1) { setHighlightQuery(''); pendingPageRef.current = 0; setCurrentIndex(currentIndex + 1); }
  }, [pageIndex, pageCount, currentIndex, spine.length]);
  const goPrevPage = useCallback(() => {
    if (pageIndex > 0) { setPageIndex(pageIndex - 1); return; }
    if (currentIndex > 0) { setHighlightQuery(''); pendingLastPageRef.current = true; setCurrentIndex(currentIndex - 1); }
  }, [pageIndex, currentIndex]);

  // Reset to the first page on a plain chapter change (unless a jump is pending).
  useEffect(() => {
    if (pendingPageRef.current == null && !pendingLastPageRef.current) setPageIndex(0);
  }, [currentIndex]);

  // Keep the page geometry in sync with the viewport.
  useEffect(() => {
    if (!prefs.pageMode || viewMode !== 'reading') return;
    const vp = pageViewportRef.current;
    if (!vp) return;
    const sync = () => { setPageWidth(vp.clientWidth); setPageHeight(vp.clientHeight); };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(vp);
    return () => ro.disconnect();
  }, [prefs.pageMode, viewMode]);

  // Recount pages once the columns are laid out, then apply any pending jump.
  useEffect(() => {
    if (!prefs.pageMode || viewMode !== 'reading' || pageWidth <= 0) return;
    const inner = pageInnerRef.current;
    if (!inner) return;
    const total = Math.max(1, Math.round(inner.scrollWidth / pageWidth));
    setPageCount(total);
    if (pendingLastPageRef.current) { pendingLastPageRef.current = false; setPageIndex(total - 1); }
    else if (pendingPageRef.current != null) { setPageIndex(Math.min(Math.max(0, pendingPageRef.current), total - 1)); pendingPageRef.current = null; }
    else setPageIndex(i => Math.min(i, total - 1));
  }, [prefs.pageMode, viewMode, pageWidth, pageHeight, chapterHtml, prefs.fontSize, prefs.font]);

  // Persist the reading position in page mode.
  useEffect(() => {
    if (viewMode !== 'reading' || !prefs.pageMode) return;
    try {
      localStorage.setItem(positionKey(filePath), JSON.stringify({ spineIndex: currentIndex, page: pageIndex, mode: 'page' }));
    } catch { /* ignore */ }
  }, [prefs.pageMode, pageIndex, currentIndex, filePath, viewMode]);

  // Chapter navigation via keyboard arrows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (viewMode !== 'reading') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); prefs.pageMode ? goPrevPage() : goPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); prefs.pageMode ? goNextPage() : goNext(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext, goPrevPage, goNextPage, prefs.pageMode, viewMode]);

  const runSearch = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q || !zipRef.current) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const hits: SearchHit[] = [];
      const lowered = q.toLowerCase();
      for (let i = 0; i < spine.length; i++) {
        let text = textIndexRef.current.get(i);
        if (text == null) {
          const raw = await zipRef.current.file(spine[i].fullPath)?.async('text');
          text = raw ? extractPlainText(raw) : '';
          textIndexRef.current.set(i, text);
        }
        const pos = text.toLowerCase().indexOf(lowered);
        if (pos >= 0) {
          const from = Math.max(0, pos - 40);
          const snippet = (from > 0 ? '…' : '') + text.slice(from, pos + q.length + 40).trim() + '…';
          const title = toc.find(t => t.spineIndex === i)?.title || `Chapter ${i + 1}`;
          hits.push({ spineIndex: i, title, snippet });
        }
      }
      setSearchResults(hits);
    } finally {
      setSearching(false);
    }
  }, [spine, toc]);

  const goToResult = useCallback((hit: SearchHit) => {
    setHighlightQuery(searchInput.trim());
    pendingScrollRef.current = null;
    setViewMode('reading');
    setCurrentIndex(hit.spineIndex);
  }, [searchInput]);

  const openMetaPanel = useCallback(() => {
    setMetaDraft({ title: bookTitle, creator: bookMeta.creator, publisher: bookMeta.publisher, language: bookMeta.language });
    setMetaSaveMsg('');
    setShowMetaPanel(true);
  }, [bookTitle, bookMeta]);

  // Rewrite the OPF metadata inside the loaded zip and save the book back to disk.
  const saveMetadata = useCallback(async () => {
    const zip = zipRef.current;
    const opfPath = opfPathRef.current;
    if (!zip || !opfPath || metaSaving) return;
    setMetaSaving(true);
    setMetaSaveMsg('');
    try {
      const opfFile = zip.file(opfPath);
      if (!opfFile) throw new Error('OPF not found');
      let opf = await opfFile.async('text');
      opf = upsertOpfField(opf, 'dc:title', metaDraft.title.trim() || 'Untitled');
      opf = upsertOpfField(opf, 'dc:language', metaDraft.language.trim() || 'en');
      opf = upsertOpfField(opf, 'dc:creator', metaDraft.creator.trim());
      opf = upsertOpfField(opf, 'dc:publisher', metaDraft.publisher.trim());
      zip.file(opfPath, opf);
      // Keep the archive spec-compliant: mimetype must stay first and stored.
      zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
      const base64Data = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
      await invoke('write_file_base64', { path: filePath, base64Data });
      setBookTitle(metaDraft.title.trim() || 'Untitled');
      setBookMeta({ creator: metaDraft.creator.trim(), publisher: metaDraft.publisher.trim(), language: metaDraft.language.trim() });
      setMetaSaveMsg(`Saved ${new Date().toTimeString().slice(0, 5)}`);
      onModifiedChange?.(false);
      onSaved?.(filePath);
      setShowMetaPanel(false);
    } catch {
      setMetaSaveMsg('Save failed');
    } finally {
      setMetaSaving(false);
    }
  }, [metaDraft, metaSaving, filePath, onSaved, onModifiedChange]);

  const theme = prefs.theme === 'auto'
    ? { bg: style.bg, text: style.text }
    : READING_THEMES[prefs.theme];
  const contentFont = prefs.font === 'sans'
    ? 'system-ui, -apple-system, sans-serif'
    : 'Georgia, "Times New Roman", serif';

  const overallProgress = Math.round(
    ((currentIndex + (pageCount > 0 ? (pageIndex + 1) / pageCount : 0)) / Math.max(1, spine.length)) * 100,
  );

  if (loading) {
    return (
      <div className="epub-reader" style={{ background: style.bg, color: style.text }}>
        <div className="epub-loading"><BookOpen size={32} style={{ opacity: 0.4 }} /><p>Loading EPUB…</p></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="epub-reader" style={{ background: style.bg, color: style.text }}>
        <div className="epub-loading"><p style={{ color: '#f44' }}>EPUB parse error: {error}</p></div>
      </div>
    );
  }

  if (viewMode === 'cover' && coverUrl) {
    return (
      <div className="epub-reader" style={{ background: style.bg, color: style.text }}>
        <div className="epub-cover">
          <img className="epub-cover-img" src={coverUrl} alt={bookTitle} />
          <div className="epub-cover-title">{bookTitle}</div>
          <button
            className="epub-cover-start"
            style={{ borderColor: style.accent || '#4fc3f7', color: style.accent || '#4fc3f7' }}
            onClick={() => setViewMode('reading')}
          >
            Start reading
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="epub-reader" style={{ background: style.bg, color: style.text }}>
      {/* Toolbar */}
      <div className="epub-toolbar" style={{ borderColor: style.border || '#333' }}>
        <button className="epub-btn" onClick={() => setShowToc(v => !v)} title="Table of contents">
          <List size={15} />
        </button>
        <button className="epub-btn" onClick={() => { setShowSearch(v => !v); }} title="Search">
          <Search size={14} />
        </button>
        <button className="epub-btn" onClick={openMetaPanel} title="Edit metadata">
          <Pencil size={13} />
        </button>
        <button className="epub-btn" onClick={() => setPrefs(p => ({ ...p, pageMode: !p.pageMode }))} title={prefs.pageMode ? 'Scroll view' : 'Page view'}>
          {prefs.pageMode ? <ScrollText size={14} /> : <BookText size={14} />}
        </button>
        <span className="epub-title">{bookTitle}</span>
        <span className="epub-chapter-info">
          {prefs.pageMode
            ? `p. ${pageIndex + 1} / ${pageCount} · ${overallProgress}%`
            : `${currentIndex + 1} / ${spine.length}`}
        </span>

        <div className="epub-theme-controls">
          <button className="epub-btn" onClick={() => setShowThemeMenu(v => !v)} title="Reading theme"><Palette size={14} /></button>
          {showThemeMenu && (
            <div className="epub-theme-menu" style={{ background: style.bg, borderColor: style.border || '#333' }}>
              <div className="epub-theme-row">
                {(['auto', 'light', 'sepia', 'dark'] as ReadingTheme[]).map(t => (
                  <button
                    key={t}
                    className={`epub-theme-swatch ${prefs.theme === t ? 'active' : ''}`}
                    onClick={() => setPrefs(p => ({ ...p, theme: t }))}
                    title={t}
                  >{t === 'auto' ? 'A' : t[0].toUpperCase()}</button>
                ))}
              </div>
              <div className="epub-theme-row">
                {(['serif', 'sans'] as ReadingFont[]).map(f => (
                  <button
                    key={f}
                    className={`epub-theme-font ${prefs.font === f ? 'active' : ''}`}
                    onClick={() => setPrefs(p => ({ ...p, font: f }))}
                  >{f}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="epub-font-controls">
          <button className="epub-btn" onClick={() => setPrefs(p => ({ ...p, fontSize: Math.max(10, p.fontSize - 2) }))} title="Decrease font size"><Minus size={13} /></button>
          <span className="epub-font-size">{prefs.fontSize}px</span>
          <button className="epub-btn" onClick={() => setPrefs(p => ({ ...p, fontSize: Math.min(32, p.fontSize + 2) }))} title="Increase font size"><Plus size={13} /></button>
        </div>
        <div className="epub-nav-buttons">
          <button className="epub-btn" onClick={goPrev} disabled={currentIndex === 0} title="Previous chapter"><ChevronLeft size={16} /></button>
          <button className="epub-btn" onClick={goNext} disabled={currentIndex === spine.length - 1} title="Next chapter"><ChevronRight size={16} /></button>
        </div>
      </div>

      {showSearch && (
        <div className="epub-search-bar" style={{ borderColor: style.border || '#333' }}>
          <Search size={13} style={{ opacity: 0.5 }} />
          <input
            className="epub-search-input"
            value={searchInput}
            placeholder="Search in book…"
            autoFocus
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') runSearch(searchInput); }}
          />
          <button className="epub-btn" onClick={() => runSearch(searchInput)} title="Search">
            {searching ? '…' : <Search size={13} />}
          </button>
          <button className="epub-btn" onClick={() => { setShowSearch(false); setSearchResults([]); setHighlightQuery(''); }} title="Close search"><X size={13} /></button>
        </div>
      )}

      {showMetaPanel && (
        <div className="epub-meta-panel" style={{ borderColor: style.border || '#333', background: style.bg }}>
          <div className="epub-meta-row"><label>Title</label><input value={metaDraft.title} onChange={e => setMetaDraft(d => ({ ...d, title: e.target.value }))} /></div>
          <div className="epub-meta-row"><label>Creator</label><input value={metaDraft.creator} onChange={e => setMetaDraft(d => ({ ...d, creator: e.target.value }))} placeholder="Optional" /></div>
          <div className="epub-meta-row"><label>Publisher</label><input value={metaDraft.publisher} onChange={e => setMetaDraft(d => ({ ...d, publisher: e.target.value }))} placeholder="Optional" /></div>
          <div className="epub-meta-row"><label>Language</label><input value={metaDraft.language} onChange={e => setMetaDraft(d => ({ ...d, language: e.target.value }))} placeholder="en" /></div>
          <div className="epub-meta-actions">
            {metaSaveMsg && <span className="epub-meta-msg">{metaSaveMsg}</span>}
            <button className="epub-btn epub-meta-cancel" onClick={() => setShowMetaPanel(false)}>Cancel</button>
            <button
              className="epub-meta-save"
              style={{ borderColor: style.accent || '#4fc3f7', color: style.accent || '#4fc3f7' }}
              onClick={() => void saveMetadata()}
              disabled={metaSaving}
            >
              {metaSaving ? '…' : <><Check size={13} /> Save</>}
            </button>
          </div>
        </div>
      )}

      <div className="epub-body">
        {/* TOC Sidebar */}
        {showToc && (
          <div className="epub-toc" style={{ borderColor: style.border || '#333' }}>
            <div className="epub-toc-header">Contents</div>
            <div className="epub-toc-list">
              {toc.map((entry, i) => (
                <div
                  key={i}
                  className={`epub-toc-item ${entry.spineIndex === currentIndex ? 'active' : ''}`}
                  onClick={() => { setHighlightQuery(''); setCurrentIndex(entry.spineIndex); setViewMode('reading'); setShowToc(false); }}
                  style={{
                    paddingLeft: 10 + entry.level * 14,
                    ...(entry.spineIndex === currentIndex ? { color: style.accent || '#4fc3f7' } : {}),
                  }}
                >
                  {entry.title}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Search results */}
        {showSearch && searchResults.length > 0 && (
          <div className="epub-search-results" style={{ borderColor: style.border || '#333' }}>
            <div className="epub-toc-header">{searchResults.length} result{searchResults.length === 1 ? '' : 's'}</div>
            <div className="epub-toc-list">
              {searchResults.map((hit, i) => (
                <div key={i} className="epub-search-result" onClick={() => goToResult(hit)}>
                  <div className="epub-search-result-title">{hit.title}</div>
                  <div className="epub-search-result-snippet">{hit.snippet}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Chapter Content */}
        {prefs.pageMode ? (
          <div className="epub-content epub-content-paged" style={{ background: theme.bg }}>
            <div className="epub-page-viewport" ref={pageViewportRef}>
              <div
                className={`${SCOPE_CLASS} epub-page-inner`}
                ref={pageInnerRef}
                style={{
                  columnWidth: `${Math.max(120, pageWidth - PAGE_GAP)}px`,
                  columnGap: `${PAGE_GAP}px`,
                  columnFill: 'auto',
                  height: pageHeight ? `${pageHeight}px` : '100%',
                  transform: `translateX(-${pageIndex * pageWidth}px)`,
                  fontSize: prefs.fontSize,
                  lineHeight: 1.8,
                  color: theme.text,
                  fontFamily: contentFont,
                }}
                dangerouslySetInnerHTML={{ __html: chapterHtml }}
              />
            </div>
            <button className="epub-page-zone left" onClick={goPrevPage} aria-label="Previous page" />
            <button className="epub-page-zone right" onClick={goNextPage} aria-label="Next page" />
            <div className="epub-page-progress">
              <div className="epub-page-progress-bar" style={{ width: `${overallProgress}%`, background: style.accent || '#4fc3f7' }} />
            </div>
          </div>
        ) : (
          <div className="epub-content" ref={scrollRef} style={{ background: theme.bg }}>
            <div
              className={SCOPE_CLASS}
              style={{ fontSize: prefs.fontSize, lineHeight: 1.8, color: theme.text, fontFamily: contentFont }}
              dangerouslySetInnerHTML={{ __html: chapterHtml }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Pure helpers (exported for tests) ────────────────────────

/** Match a TOC href (may include a fragment) against the spine, return index or 0. */
function matchSpineIndex(src: string, spineHrefs: string[]): number {
  const base = src.split('#')[0];
  if (!base) return 0;
  let idx = spineHrefs.findIndex(h => h === base);
  if (idx >= 0) return idx;
  const baseName = base.split('/').pop();
  idx = spineHrefs.findIndex(h => h.split('/').pop() === baseName);
  return idx >= 0 ? idx : 0;
}

/** Parse an EPUB2 NCX document into a flat, depth-annotated TOC. Pure. */
export function parseNcxToc(ncxXml: string, spineHrefs: string[]): TocEntry[] {
  const doc = new DOMParser().parseFromString(ncxXml, 'application/xml');
  const navMap = doc.querySelector('navMap');
  if (!navMap) return [];
  const entries: TocEntry[] = [];

  const walk = (parent: Element, level: number) => {
    // Only immediate navPoint children, so nesting depth is tracked correctly.
    for (const np of Array.from(parent.children)) {
      if (np.tagName.toLowerCase() !== 'navpoint') continue;
      const label = np.querySelector('navLabel > text')?.textContent?.trim()
        || np.querySelector('navLabel text')?.textContent?.trim() || '';
      const src = np.querySelector(':scope > content')?.getAttribute('src')
        || np.querySelector('content')?.getAttribute('src') || '';
      if (label) {
        entries.push({ title: label, href: src, spineIndex: matchSpineIndex(src, spineHrefs), level });
      }
      walk(np, level + 1);
    }
  };
  walk(navMap, 0);
  return entries;
}

/** Parse an EPUB3 nav.xhtml document (nav[epub:type=toc]) into a depth-annotated TOC. Pure. */
export function parseNavToc(navHtml: string, spineHrefs: string[]): TocEntry[] {
  const doc = new DOMParser().parseFromString(navHtml, 'text/html');
  const navs = Array.from(doc.querySelectorAll('nav'));
  const tocNav = navs.find(n => (n.getAttribute('epub:type') || '').split(/\s+/).includes('toc'))
    || navs.find(n => n.querySelector('ol'))
    || navs[0];
  if (!tocNav) return [];
  const rootList = tocNav.querySelector('ol');
  if (!rootList) return [];

  const entries: TocEntry[] = [];
  const walk = (ol: Element, level: number) => {
    for (const li of Array.from(ol.children)) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      const anchor = Array.from(li.children).find(c => c.tagName.toLowerCase() === 'a' || c.tagName.toLowerCase() === 'span');
      if (anchor) {
        const title = anchor.textContent?.trim() || '';
        const href = anchor.getAttribute('href') || '';
        if (title) entries.push({ title, href, spineIndex: matchSpineIndex(href, spineHrefs), level });
      }
      const childList = Array.from(li.children).find(c => c.tagName.toLowerCase() === 'ol');
      if (childList) walk(childList, level + 1);
    }
  };
  walk(rootList, 0);
  return entries;
}

/**
 * Scope a stylesheet so its rules only apply inside the given selector.
 * Prefixes every selector, rewrites html/body/:root to the scope, recurses
 * into @media/@supports, leaves @font-face/@keyframes untouched, and drops
 * @import/@charset. Pure.
 */
export function scopeCss(css: string, scope: string): string {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return scopeRules(stripped, scope);
}

function scopeRules(css: string, scope: string): string {
  let out = '';
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css[i])) i++;
    if (i >= n) break;

    if (css[i] === '@') {
      let j = i;
      while (j < n && css[j] !== '{' && css[j] !== ';') j++;
      const prelude = css.slice(i, j).trim();
      if (css[j] === ';' || j >= n) { i = j + 1; continue; } // @import / @charset
      const { block, end } = readBlock(css, j);
      const atName = prelude.slice(1).split(/[\s(]/)[0].toLowerCase();
      if (atName === 'media' || atName === 'supports' || atName === 'document') {
        out += `${prelude}{${scopeRules(block, scope)}}`;
      } else {
        out += `${prelude}{${block}}`;
      }
      i = end;
    } else {
      let j = i;
      while (j < n && css[j] !== '{') j++;
      if (j >= n) break;
      const selector = css.slice(i, j).trim();
      const { block, end } = readBlock(css, j);
      if (selector) out += `${scopeSelector(selector, scope)}{${block}}`;
      i = end;
    }
  }
  return out;
}

function readBlock(css: string, openIdx: number): { block: string; end: number } {
  let depth = 0;
  let i = openIdx;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return { block: css.slice(openIdx + 1, i - 1), end: i };
}

function scopeSelector(selectorList: string, scope: string): string {
  return selectorList.split(',').map(sel => {
    const s = sel.trim();
    if (!s) return s;
    if (/^(html|body)\b/i.test(s)) {
      const rest = s.replace(/^(html|body)\b\s*/i, '');
      return rest ? `${scope} ${rest}` : scope;
    }
    if (s.startsWith(':root')) return scope + s.slice(5);
    return `${scope} ${s}`;
  }).join(', ');
}

// ─── DOM helpers (impure, used at render time) ────────────────

/**
 * Process chapter HTML:
 * - Strip scripts
 * - Inline & scope the chapter's own stylesheets (link/style) to the reader
 * - Convert relative image src to blob URLs from the ZIP
 * Returns the sanitized HTML and the blob URLs it created (for later revoke).
 */
async function processChapterHtml(
  html: string,
  zip: JSZip,
  contentDir: string,
  chapterPath: string,
): Promise<{ html: string; blobUrls: string[] }> {
  const blobUrls: string[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const chapterDir = chapterPath.includes('/') ? chapterPath.substring(0, chapterPath.lastIndexOf('/') + 1) : '';

  doc.querySelectorAll('script').forEach(s => s.remove());

  // Collect and scope the chapter's stylesheets.
  let scopedCss = '';
  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'))) {
    const href = link.getAttribute('href');
    link.remove();
    if (!href || href.startsWith('http') || href.startsWith('data:')) continue;
    const cssPath = resolvePath(chapterDir, href);
    const cssText = await zip.file(cssPath)?.async('text');
    if (cssText) {
      try { scopedCss += scopeCss(cssText, `.${SCOPE_CLASS}`) + '\n'; } catch { /* fall back to defaults */ }
    }
  }
  for (const styleEl of Array.from(doc.querySelectorAll('style'))) {
    const cssText = styleEl.textContent || '';
    styleEl.remove();
    if (cssText.trim()) {
      try { scopedCss += scopeCss(cssText, `.${SCOPE_CLASS}`) + '\n'; } catch { /* fall back to defaults */ }
    }
  }

  // Convert images to blob URLs.
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:') || src.startsWith('http')) continue;
    const fullPath = resolvePath(chapterDir || contentDir, src);
    const file = zip.file(fullPath) || zip.file(resolvePath(contentDir, src));
    if (file) {
      try {
        const blob = await file.async('blob');
        const url = URL.createObjectURL(blob);
        blobUrls.push(url);
        img.setAttribute('src', url);
      } catch { /* skip broken images */ }
    }
  }
  // SVG <image xlink:href> references.
  for (const image of Array.from(doc.querySelectorAll('image'))) {
    const href = image.getAttribute('xlink:href') || image.getAttribute('href');
    if (!href || href.startsWith('data:') || href.startsWith('http')) continue;
    const fullPath = resolvePath(chapterDir || contentDir, href);
    const file = zip.file(fullPath) || zip.file(resolvePath(contentDir, href));
    if (file) {
      try {
        const blob = await file.async('blob');
        const url = URL.createObjectURL(blob);
        blobUrls.push(url);
        image.setAttribute('xlink:href', url);
        image.setAttribute('href', url);
      } catch { /* skip */ }
    }
  }

  const body = doc.querySelector('body');
  const bodyHtml = body ? body.innerHTML : doc.documentElement.innerHTML;
  const styleTag = scopedCss.trim() ? `<style>${scopedCss}</style>` : '';
  return { html: styleTag + bodyHtml, blobUrls };
}

/** Extract readable plain text from a chapter's raw HTML. */
function extractPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach(el => el.remove());
  return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
}

/** Wrap case-insensitive matches of `query` inside `root` in <mark>. Returns the first mark. */
function highlightMatches(root: HTMLElement, query: string): HTMLElement | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  // Clear previous highlights first.
  root.querySelectorAll('mark.epub-mark').forEach(m => {
    const parent = m.parentNode;
    if (parent) { parent.replaceChild(document.createTextNode(m.textContent || ''), m); parent.normalize(); }
  });

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node = walker.nextNode();
  while (node) { targets.push(node as Text); node = walker.nextNode(); }

  let first: HTMLElement | null = null;
  for (const textNode of targets) {
    const text = textNode.nodeValue || '';
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    if (idx < 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (idx >= 0) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement('mark');
      mark.className = 'epub-mark';
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      if (!first) first = mark;
      last = idx + q.length;
      idx = lower.indexOf(q, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
  return first;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Insert or replace a Dublin Core field's text inside an OPF metadata block.
 * Empty optional fields (creator/publisher) are removed; title/language are
 * kept. Preserves any existing attributes (e.g. id) on the element. Pure.
 */
export function upsertOpfField(opf: string, tag: string, value: string): string {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'i');
  const text = escapeHtml(value);
  const optional = tag === 'dc:creator' || tag === 'dc:publisher';
  if (!value) {
    return optional ? opf.replace(re, '').replace(/[ \t]*\n[ \t]*\n/g, '\n') : opf;
  }
  if (re.test(opf)) {
    return opf.replace(re, (m) => {
      const attrs = (m.match(new RegExp(`^<${tag}(\\s[^>]*)?>`, 'i')) || [])[1] || '';
      return `<${tag}${attrs}>${text}</${tag}>`;
    });
  }
  return opf.replace(/<\/metadata>/i, `  <${tag}>${text}</${tag}>\n  </metadata>`);
}

/** Resolve a relative path against a base directory */
function resolvePath(base: string, relative: string): string {
  if (relative.startsWith('/')) return relative.substring(1);
  const parts = (base + relative).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part !== '.' && part !== '') resolved.push(part);
  }
  return resolved.join('/');
}
