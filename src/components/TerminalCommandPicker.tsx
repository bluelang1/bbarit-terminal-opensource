import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Search, X, Clock, Zap } from 'lucide-react';
import type { Skill } from '../skills/types';
import { GALLERY_SKILLS } from '../skills/gallerySkills';
import { useTranslation } from '../i18n';
import './TerminalCommandPicker.css';

interface TerminalCommandPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (command: string) => void;
  userSkills: Skill[];
  recentCommands?: string[];
  currentStyle?: { bg: string; text: string; accent: string };
}

export function TerminalCommandPicker({
  isOpen,
  onClose,
  onSelect,
  userSkills,
  recentCommands = [],
  currentStyle,
}: TerminalCommandPickerProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Collect shell-type skills only
  const shellSkills = useMemo(() => {
    const userShell = userSkills.filter(s => s.cliType === 'shell');
    const galleryShell = GALLERY_SKILLS.filter(s => s.cliType === 'shell');
    // Deduplicate by command
    const seen = new Set<string>();
    const result: Skill[] = [];
    for (const s of [...userShell, ...galleryShell]) {
      if (!seen.has(s.command)) {
        seen.add(s.command);
        result.push(s);
      }
    }
    return result;
  }, [userSkills]);

  const filtered = useMemo(() => {
    if (!search.trim()) return shellSkills.slice(0, 50); // Show first 50 by default
    const q = search.trim().toLowerCase();
    return shellSkills.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.command.toLowerCase().includes(q) ||
      s.tags?.some(t => t.toLowerCase().includes(q))
    ).slice(0, 50);
  }, [shellSkills, search]);

  const handleSelect = useCallback((command: string) => {
    onSelect(command);
    onClose();
  }, [onSelect, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && filtered.length > 0) {
      handleSelect(filtered[0].command);
    }
  }, [onClose, filtered, handleSelect]);

  if (!isOpen) return null;

  const style = currentStyle || { bg: '#1e1e2e', text: '#cdd6f4', accent: '#89b4fa' };

  return (
    <div className="cmd-picker-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="cmd-picker"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          '--cp-bg': style.bg,
          '--cp-text': style.text,
          '--cp-accent': style.accent,
        } as React.CSSProperties}
      >
        {/* Search */}
        <div className="cmd-picker-search">
          <Search size={14} />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('cmdPicker.searchPlaceholder')}
          />
          <button className="cmd-picker-close" onClick={onClose}><X size={14} /></button>
        </div>

        {/* Recent commands */}
        {recentCommands.length > 0 && !search.trim() && (
          <div className="cmd-picker-section">
            <div className="cmd-picker-section-title"><Clock size={11} /> {t('cmdPicker.recent')}</div>
            {recentCommands.slice(0, 5).map((cmd, i) => (
              <div key={`recent-${i}`} className="cmd-picker-item" onClick={() => handleSelect(cmd)}>
                <span className="cmd-picker-item-emoji">⏱️</span>
                <span className="cmd-picker-item-cmd">{cmd}</span>
              </div>
            ))}
          </div>
        )}

        {/* Filtered skills */}
        <div className="cmd-picker-list">
          {filtered.length === 0 && (
            <div className="cmd-picker-empty">{t('commandPalette.noResults')}</div>
          )}
          {filtered.map(skill => (
            <div key={skill.id} className="cmd-picker-item" onClick={() => handleSelect(skill.command)}>
              <span className="cmd-picker-item-emoji">{skill.emoji}</span>
              <div className="cmd-picker-item-info">
                <span className="cmd-picker-item-name">{skill.name}</span>
                <span className="cmd-picker-item-desc">{skill.description}</span>
              </div>
              <span className="cmd-picker-item-cmd">{skill.command.length > 40 ? skill.command.slice(0, 37) + '...' : skill.command}</span>
              <Zap size={11} className="cmd-picker-item-icon" />
            </div>
          ))}
          {filtered.length >= 50 && (
            <div className="cmd-picker-more">{t('cmdPicker.typeForMore')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
