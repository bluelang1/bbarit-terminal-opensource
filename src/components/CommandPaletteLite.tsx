import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../i18n';

export type PaletteCommand = {
  id: string;
  label: string;
  category: 'terminal' | 'project' | 'view' | 'file' | 'settings' | 'tools' | 'skills';
  shortcut?: string;
  run: () => void;
};

const CATEGORY_LABELS: Record<PaletteCommand['category'], string> = {
  terminal: 'Terminal',
  project: 'Project',
  view: 'View',
  file: 'File',
  settings: 'Settings',
  tools: 'Tools',
  skills: '스킬',
};

const fuzzyMatch = (query: string, candidate: string): { matches: boolean; score: number } => {
  const q = query.toLowerCase().trim();
  const c = candidate.toLowerCase();
  if (!q) return { matches: true, score: 0 };
  if (c.includes(q)) return { matches: true, score: 100 + (q.length / Math.max(1, c.length)) * 50 };

  // Simple ordered-subsequence match.
  let qi = 0;
  let score = 0;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) {
      qi++;
      score += 10;
    } else {
      score -= 1;
    }
  }
  return { matches: qi === q.length, score };
};

export function CommandPaletteLite({
  isOpen,
  onClose,
  commands,
}: {
  isOpen: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((cmd) => ({ cmd, ...fuzzyMatch(query, cmd.label) }))
      .filter((r) => r.matches)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.cmd);
  }, [commands, query]);

  const closePalette = useCallback(() => {
    setQuery('');
    setSelectedIndex(0);
    onClose();
  }, [onClose]);

  const execute = useCallback((cmd: PaletteCommand | undefined) => {
    if (!cmd) return;
    closePalette();
    requestAnimationFrame(() => {
      try {
        cmd.run();
      } catch {
        // ignore
      }
    });
  }, [closePalette]);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setSelectedIndex(0);
    // Focus after open so the animation doesn't steal it back.
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [isOpen]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll<HTMLElement>('.command-palette-item');
    const item = items[selectedIndex];
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, Math.max(0, filtered.length - 1)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      execute(filtered[selectedIndex]);
      return;
    }
  }, [closePalette, execute, filtered, selectedIndex]);

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onMouseDown={closePalette}>
      <div className="command-palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="command-palette-input-wrapper">
          <input
            ref={inputRef}
            className="command-palette-input"
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            placeholder={t('commandPalette.placeholder')}
            autoComplete="off"
            autoFocus
            spellCheck={false}
            title={t('commandPalette.inputTitle')}
          />
        </div>
        <div className="command-palette-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="command-palette-empty">{t('commandPalette.noResults')}</div>
          )}
          {filtered.map((cmd, index) => {
            const prev = filtered[index - 1];
            const showCategory = index === 0 || cmd.category !== prev?.category;
            return (
              <React.Fragment key={cmd.id}>
                {showCategory && (
                  <div className="command-palette-category">{CATEGORY_LABELS[cmd.category] || cmd.category}</div>
                )}
                <div
                  className={`command-palette-item ${index === selectedIndex ? 'selected' : ''}`}
                  onMouseMove={() => setSelectedIndex(index)}
                  onClick={() => execute(cmd)}
                >
                  <span className="command-palette-item-label">{cmd.label}</span>
                  {cmd.shortcut && (
                    <span className="command-palette-item-shortcut">{cmd.shortcut}</span>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

