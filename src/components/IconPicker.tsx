/**
 * IconPicker.tsx
 *
 * A searchable, categorized icon picker with 500+ icons from lucide-react.
 * Supports search/filter, category grouping, recently used (localStorage),
 * icon size toggle, hover tooltip, pagination, and outside click / Escape close.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import ReactDOMServer from 'react-dom/server';
import { Search, X, ChevronLeft, ChevronRight, Check, Pipette } from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { kvGet, kvSet } from '../hooks/useKV';
import { useTranslation } from '../i18n';
import './IconPicker.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IconPickerProps {
  onSelect: (iconName: string, svgMarkup: string) => void;
  onClose: () => void;
  style: { bg: string; text: string; accent: string };
  isLightTheme: boolean;
}

interface IconEntry {
  name: string;
  kebab: string; // kebab-case name for display
  Component: React.ComponentType<{ size?: number; color?: string }>;
}

type IconSize = 'sm' | 'md' | 'lg';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ICONS_PER_PAGE = 200;
const RECENT_KEY = 'octo-icon-picker-recent';
const MAX_RECENT = 24;

/** Preset color palette */
const COLOR_PRESETS = [
  { label: 'Default', value: '' },
  { label: 'White', value: '#ffffff' },
  { label: 'Gray', value: '#9ca3af' },
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Amber', value: '#f59e0b' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Lime', value: '#84cc16' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Emerald', value: '#10b981' },
  { label: 'Teal', value: '#14b8a6' },
  { label: 'Cyan', value: '#06b6d4' },
  { label: 'Sky', value: '#0ea5e9' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Indigo', value: '#6366f1' },
  { label: 'Violet', value: '#8b5cf6' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'Fuchsia', value: '#d946ef' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Rose', value: '#f43f5e' },
];

/** Convert PascalCase to kebab-case */
function toKebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** Icon size in px */
function sizeValue(sz: IconSize): number {
  return sz === 'sm' ? 16 : sz === 'md' ? 22 : 30;
}

// ---------------------------------------------------------------------------
// Category definitions — keywords mapped to icon name substrings
// ---------------------------------------------------------------------------

const CATEGORY_MAP: Record<string, string[]> = {
  'All': [],
  'Arrows': ['arrow', 'chevron', 'corner', 'move', 'expand', 'shrink', 'maximize', 'minimize'],
  'Charts': ['chart', 'bar-chart', 'line-chart', 'pie-chart', 'area-chart', 'trending', 'activity', 'gantt', 'kanban', 'scatter'],
  'Communication': ['mail', 'message', 'phone', 'send', 'inbox', 'bell', 'megaphone', 'satellite', 'radio', 'rss', 'voicemail', 'at-sign', 'contact'],
  'Design': ['palette', 'paintbrush', 'paint', 'brush', 'dropper', 'pen', 'pencil', 'eraser', 'ruler', 'scissors', 'swatch', 'pipette', 'figma', 'frame', 'blend', 'crop', 'slice', 'stamp'],
  'Development': ['code', 'terminal', 'bug', 'git', 'braces', 'brackets', 'regex', 'binary', 'database', 'server', 'cpu', 'hash', 'variable', 'function', 'webhook', 'api', 'container', 'workflow'],
  'Devices': ['monitor', 'laptop', 'tablet', 'smartphone', 'watch', 'tv', 'printer', 'camera', 'mic', 'speaker', 'headphone', 'bluetooth', 'usb', 'keyboard', 'mouse', 'gamepad', 'joystick'],
  'Editing': ['bold', 'italic', 'underline', 'strikethrough', 'align', 'list', 'indent', 'outdent', 'type', 'font', 'heading', 'quote', 'subscript', 'superscript', 'wrap', 'pilcrow', 'case', 'baseline', 'spell'],
  'Emoji': ['smile', 'frown', 'laugh', 'angry', 'annoyed', 'meh', 'baby', 'skull', 'ghost', 'cat', 'dog', 'bird', 'fish', 'rabbit', 'turtle', 'squirrel', 'rat', 'snail', 'worm', 'paw'],
  'Files': ['file', 'folder', 'archive', 'clipboard', 'document', 'paperclip', 'attachment', 'save', 'download', 'upload', 'import', 'export'],
  'Finance': ['wallet', 'credit-card', 'banknote', 'coins', 'dollar', 'euro', 'bitcoin', 'currency', 'receipt', 'piggy', 'landmark', 'building-2', 'badge-dollar', 'hand-coins', 'circle-dollar'],
  'Food': ['apple', 'cherry', 'grape', 'banana', 'citrus', 'egg', 'pizza', 'sandwich', 'salad', 'soup', 'cake', 'cookie', 'candy', 'ice-cream', 'popcorn', 'beef', 'ham', 'nut', 'wheat', 'milk', 'wine', 'beer', 'coffee', 'cup', 'glass', 'martini', 'utensils'],
  'Health': ['heart-pulse', 'stethoscope', 'syringe', 'pill', 'capsule', 'thermometer', 'ambulance', 'hospital', 'cross', 'bandage', 'blood', 'dna', 'brain', 'bone', 'accessibility', 'ear', 'hand-heart'],
  'Layout': ['layout', 'grid', 'columns', 'rows', 'panel', 'sidebar', 'split', 'table', 'dock', 'separator', 'ratio', 'app-window', 'gallery'],
  'Math': ['plus', 'minus', 'percent', 'divide', 'equal', 'calculator', 'sigma', 'infinity', 'pi', 'radical', 'omega', 'epsilon'],
  'Media': ['play', 'pause', 'stop', 'forward', 'rewind', 'skip', 'volume', 'music', 'video', 'film', 'image', 'picture', 'photo', 'gallery', 'clapperboard', 'disc', 'podcast', 'airplay', 'cast', 'projector', 'aperture'],
  'Nature': ['leaf', 'tree', 'flower', 'sprout', 'clover', 'mountain', 'sunrise', 'sunset', 'flame', 'zap', 'snowflake', 'tornado', 'volcano', 'waves', 'tent', 'campfire', 'forest'],
  'Navigation': ['home', 'menu', 'search', 'compass', 'map', 'navigation', 'route', 'signpost', 'milestone', 'waypoint', 'locate', 'pin', 'flag', 'bookmark'],
  'Science': ['atom', 'flask', 'microscope', 'telescope', 'beaker', 'test-tube', 'dna', 'magnet', 'orbit', 'radiation', 'biohazard', 'satellite-dish'],
  'Security': ['lock', 'unlock', 'key', 'shield', 'eye', 'fingerprint', 'scan', 'badge', 'verified', 'sword', 'siren', 'alarm-check'],
  'Shapes': ['circle', 'square', 'triangle', 'diamond', 'hexagon', 'octagon', 'pentagon', 'star', 'heart', 'rectangle', 'oval', 'shape', 'spline', 'torus'],
  'Shopping': ['shopping-cart', 'shopping-bag', 'store', 'tag', 'tags', 'barcode', 'scan-barcode', 'package', 'truck', 'gift', 'percent', 'ticket', 'label'],
  'Social': ['user', 'users', 'group', 'share', 'thumb', 'hand', 'globe', 'earth', 'link', 'external', 'qr', 'crown', 'trophy', 'medal', 'award'],
  'Time': ['clock', 'timer', 'calendar', 'hourglass', 'alarm', 'watch', 'history', 'undo', 'redo', 'refresh', 'rotate', 'stopwatch', 'calendar-check', 'calendar-clock'],
  'Tools': ['wrench', 'hammer', 'screwdriver', 'drill', 'saw', 'axe', 'shovel', 'settings', 'cog', 'gear', 'nut', 'bolt', 'plug', 'cable', 'magnet', 'flashlight', 'lantern'],
  'Transport': ['car', 'bus', 'train', 'plane', 'rocket', 'ship', 'bike', 'bicycle', 'truck', 'tractor', 'ambulance', 'fuel', 'parking', 'traffic', 'anchor', 'sailboat', 'ferry'],
  'Weather': ['sun', 'moon', 'cloud', 'rain', 'snow', 'wind', 'lightning', 'thunder', 'storm', 'fog', 'haze', 'umbrella', 'thermometer', 'droplet', 'wave', 'rainbow', 'cloudy'],
};

const CATEGORIES = Object.keys(CATEGORY_MAP);

// ---------------------------------------------------------------------------
// Build icon list once (module-level cache)
// ---------------------------------------------------------------------------

let _cachedIcons: IconEntry[] | null = null;

function getAllIcons(): IconEntry[] {
  if (_cachedIcons) return _cachedIcons;

  const entries: IconEntry[] = [];
  const seen = new Set<string>();
  const allExports = LucideIcons as unknown as Record<string, unknown>;

  for (const key of Object.keys(allExports)) {
    // Skip non-PascalCase, duplicates with "Icon" suffix, and utility exports
    if (!/^[A-Z]/.test(key)) continue;
    if (key.endsWith('Icon')) continue;
    if (key === 'default' || key === 'Icon' || key === 'createLucideIcon' || key === 'icons') continue;

    const val = allExports[key];
    // Lucide icon components are ForwardRef objects with $$typeof or are functions
    if (!val || (typeof val !== 'function' && typeof val !== 'object')) continue;

    // Deduplicate
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({
      name: key,
      kebab: toKebab(key),
      Component: val as React.ComponentType<{ size?: number; color?: string }>,
    });
  }

  // Sort alphabetically
  entries.sort((a, b) => a.name.localeCompare(b.name));
  _cachedIcons = entries;
  return entries;
}

// ---------------------------------------------------------------------------
// localStorage helpers for recently used icons
// ---------------------------------------------------------------------------

async function loadRecent(): Promise<string[]> {
  try {
    const raw = await kvGet(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecent(names: string[]): void {
  void kvSet(RECENT_KEY, JSON.stringify(names.slice(0, MAX_RECENT)));
}

async function pushRecent(name: string): Promise<string[]> {
  const list = (await loadRecent()).filter((n) => n !== name);
  list.unshift(name);
  const capped = list.slice(0, MAX_RECENT);
  saveRecent(capped);
  return capped;
}

// ---------------------------------------------------------------------------
// Render a single icon into SVG markup string
// ---------------------------------------------------------------------------

function renderSvgMarkup(entry: IconEntry, size: number, color?: string): string {
  try {
    const Comp = entry.Component;
    return ReactDOMServer.renderToStaticMarkup(
      React.createElement(Comp, { size, color: color || 'currentColor' })
    );
  } catch {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><!-- ${entry.kebab} --></svg>`;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const IconPicker = React.memo(function IconPicker({
  onSelect,
  onClose,
  style,
  isLightTheme,
}: IconPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [size, setSize] = useState<IconSize>('md');
  const [page, setPage] = useState(0);
  const [recentNames, setRecentNames] = useState<string[]>([]);
  const [hoveredIcon, setHoveredIcon] = useState<string | null>(null);
  const [copiedIcon, setCopiedIcon] = useState<string | null>(null);
  const [iconColor, setIconColor] = useState(''); // '' = default (theme text color)
  const [customColorInput, setCustomColorInput] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const allIcons = useMemo(() => getAllIcons(), []);

  // Load recent icons from KV on mount
  useEffect(() => {
    loadRecent().then(setRecentNames).catch(() => {});
  }, []);

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Close on outside click
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  // Reset page when query or category changes
  useEffect(() => {
    setPage(0);
    bodyRef.current?.scrollTo(0, 0);
  }, [query, category]);

  // ---- Filtering ----
  const filteredIcons = useMemo(() => {
    let list = allIcons;

    // Category filter
    if (category !== 'All') {
      const keywords = CATEGORY_MAP[category];
      if (keywords && keywords.length > 0) {
        list = list.filter((icon) => {
          const lk = icon.kebab;
          return keywords.some((kw) => lk.includes(kw));
        });
      }
    }

    // Search filter
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((icon) =>
        icon.kebab.includes(q) || icon.name.toLowerCase().includes(q)
      );
    }

    return list;
  }, [allIcons, category, query]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredIcons.length / ICONS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const pageIcons = filteredIcons.slice(safePage * ICONS_PER_PAGE, (safePage + 1) * ICONS_PER_PAGE);

  // Recent icons resolved
  const recentIcons = useMemo(() => {
    const iconMap = new Map(allIcons.map((ic) => [ic.name, ic]));
    return recentNames.map((n) => iconMap.get(n)).filter(Boolean) as IconEntry[];
  }, [allIcons, recentNames]);

  // ---- Handlers ----

  const handleIconClick = useCallback((entry: IconEntry) => {
    const svg = renderSvgMarkup(entry, sizeValue(size), iconColor || undefined);
    pushRecent(entry.name).then(setRecentNames).catch(() => {});
    onSelect(entry.name, svg);
  }, [onSelect, size, iconColor]);

  const handleCopyName = useCallback((entry: IconEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(entry.kebab).catch(() => {/* ignore */});
    setCopiedIcon(entry.name);
    setTimeout(() => setCopiedIcon((prev) => (prev === entry.name ? null : prev)), 1200);
  }, []);

  // ---- Render helpers ----

  const renderIconCell = useCallback((entry: IconEntry) => {
    const Comp = entry.Component;
    const px = sizeValue(size);
    const isHovered = hoveredIcon === entry.name;
    const isCopied = copiedIcon === entry.name;

    return (
      <div
        key={entry.name}
        className="ip-icon-cell"
        onClick={() => handleIconClick(entry)}
        onContextMenu={(e) => { e.preventDefault(); handleCopyName(entry, e); }}
        onMouseEnter={() => setHoveredIcon(entry.name)}
        onMouseLeave={() => setHoveredIcon(null)}
        title="" // prevent native tooltip, we use custom
      >
        <Comp size={px} color={iconColor || style.text} />
        {isHovered && !isCopied && (
          <div className="ip-tooltip">{entry.kebab}</div>
        )}
        {isCopied && (
          <div className="ip-copied-toast">
            <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <Check size={10} /> {t('iconPicker.copied')}
            </span>
          </div>
        )}
      </div>
    );
  }, [size, style.text, iconColor, hoveredIcon, copiedIcon, handleIconClick, handleCopyName]);

  const gridClass = `ip-grid ip-grid-${size}`;

  // CSS custom properties for theming
  const cssVars = {
    '--ip-bg': style.bg,
    '--ip-text': style.text,
    '--ip-accent': style.accent,
  } as React.CSSProperties;

  return createPortal(
    <div className="ip-overlay" onClick={handleOverlayClick}>
      <div
        ref={containerRef}
        className={`ip-container${isLightTheme ? ' ip-light' : ''}`}
        style={cssVars}
      >
        {/* Header: search */}
        <div className="ip-header">
          <Search size={16} />
          <input
            ref={searchRef}
            className="ip-search-input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('iconPicker.searchPlaceholder')}
            spellCheck={false}
          />
          <button className="ip-close-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Toolbar: categories + size */}
        <div className="ip-toolbar">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`ip-category-btn${category === cat ? ' ip-active' : ''}`}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
          <div className="ip-toolbar-sep" />
          <div className="ip-size-toggle">
            {(['sm', 'md', 'lg'] as IconSize[]).map((sz) => (
              <button
                key={sz}
                className={`ip-size-btn${size === sz ? ' ip-active' : ''}`}
                onClick={() => setSize(sz)}
              >
                {sz.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Color palette */}
        <div className="ip-color-bar">
          <Pipette size={12} style={{ opacity: 0.5, flexShrink: 0 }} />
          {COLOR_PRESETS.map((c) => (
            <button
              key={c.label}
              className={`ip-color-swatch${iconColor === c.value ? ' ip-active' : ''}`}
              style={{
                background: c.value || style.text,
                ...(c.value === '' && iconColor === '' ? { boxShadow: `0 0 0 1.5px ${style.accent}` } : {}),
              }}
              onClick={() => { setIconColor(c.value); setCustomColorInput(c.value); }}
              title={c.label}
            />
          ))}
          <div className="ip-toolbar-sep" />
          <input
            className="ip-color-hex-input"
            type="text"
            value={customColorInput}
            onChange={(e) => {
              const v = e.target.value;
              setCustomColorInput(v);
              if (/^#([0-9a-fA-F]{3}){1,2}$/.test(v)) setIconColor(v);
            }}
            placeholder="#hex"
            spellCheck={false}
            maxLength={7}
          />
          <input
            className="ip-color-native-input"
            type="color"
            value={iconColor || style.text}
            onChange={(e) => { setIconColor(e.target.value); setCustomColorInput(e.target.value); }}
            title={t('iconPicker.pickCustomColor')}
          />
        </div>

        {/* Body: icons grid */}
        <div className="ip-body" ref={bodyRef}>
          {/* Recently used */}
          {recentIcons.length > 0 && !query && category === 'All' && (
            <>
              <div className="ip-section-label">{t('iconPicker.recentlyUsed')}</div>
              <div className={gridClass}>
                {recentIcons.map(renderIconCell)}
              </div>
            </>
          )}

          {/* Main icon grid */}
          {pageIcons.length > 0 ? (
            <>
              {(recentIcons.length > 0 && !query && category === 'All') && (
                <div className="ip-section-label">
                  {category === 'All' ? t('iconPicker.allIcons') : category}
                </div>
              )}
              <div className={gridClass}>
                {pageIcons.map(renderIconCell)}
              </div>
            </>
          ) : (
            <div className="ip-empty">{t('iconPicker.noIconsFound').replace('{query}', query)}</div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="ip-pagination">
              <button
                className="ip-page-btn"
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft size={12} />
              </button>
              {Array.from({ length: totalPages }, (_, i) => i).map((i) => {
                // Show limited page buttons
                if (totalPages <= 7 || i === 0 || i === totalPages - 1 || Math.abs(i - safePage) <= 1) {
                  return (
                    <button
                      key={i}
                      className={`ip-page-btn${i === safePage ? ' ip-active' : ''}`}
                      onClick={() => setPage(i)}
                    >
                      {i + 1}
                    </button>
                  );
                }
                if (i === 1 && safePage > 3) {
                  return <span key="dots-start" style={{ opacity: 0.3, fontSize: 10 }}>...</span>;
                }
                if (i === totalPages - 2 && safePage < totalPages - 4) {
                  return <span key="dots-end" style={{ opacity: 0.3, fontSize: 10 }}>...</span>;
                }
                return null;
              })}
              <button
                className="ip-page-btn"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                <ChevronRight size={12} />
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="ip-footer">
          <span>{t('iconPicker.iconsCount').replace('{count}', String(filteredIcons.length))}</span>
          <div className="ip-footer-actions">
            <span style={{ opacity: 0.5 }}>{t('iconPicker.clickToInsert')}</span>
            <span style={{ opacity: 0.3 }}>|</span>
            <span style={{ opacity: 0.5 }}>{t('iconPicker.rightClickToCopy')}</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
});

export default IconPicker;
