/**
 * AiAutoTagSuggestion.tsx
 *
 * Floating panel that shows AI-suggested tags after a note is saved.
 * Users can select/deselect individual tags before accepting.
 * Opt-in preference is stored in localStorage.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Sparkles } from 'lucide-react';
import { suggestTagsForNote } from './ollamaTagging';
import type { NoteIndexEntry } from './noteState';
import { kvGet, kvSet } from '../hooks/useKV';
import { useTranslation } from '../i18n';
import './AiAutoTagSuggestion.css';

// ───────────────────────── Constants ─────────────────────────

const STORAGE_KEY = 'octo-ai-auto-tag-enabled';

export async function isAutoTagEnabled(): Promise<boolean> {
  return (await kvGet(STORAGE_KEY)) === 'true';
}

export function setAutoTagEnabled(enabled: boolean): void {
  void kvSet(STORAGE_KEY, enabled ? 'true' : 'false');
}

// ───────────────────────── Props ─────────────────────────

export interface AiAutoTagSuggestionProps {
  notePath: string;
  noteContent: string;
  existingTags: string[];
  noteIndex: NoteIndexEntry[];
  onAcceptTags: (tags: string[]) => void;
  onDismiss: () => void;
  style: { bg: string; text: string; accent: string };
}

// ───────────────────────── Component ─────────────────────────

export function AiAutoTagSuggestion(props: AiAutoTagSuggestionProps) {
  const { notePath, noteContent, existingTags, noteIndex, onAcceptTags, onDismiss, style } = props;
  const { t } = useTranslation();

  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  // Fetch tag suggestions on mount
  useEffect(() => {
    let cancelled = false;

    async function fetchSuggestions() {
      setLoading(true);
      setError(null);

      try {
        const allTags = noteIndex.flatMap(n => n.tags).filter(Boolean);
        const uniqueTags = [...new Set([...existingTags, ...allTags])];
        const noteNames = noteIndex.map(n => n.name);

        const tags = await suggestTagsForNote(noteContent, uniqueTags, noteNames);

        if (cancelled) return;

        // Filter out tags that already exist on this note
        const existingSet = new Set(existingTags.map(t => t.toLowerCase()));
        const newTags = tags.filter(t => !existingSet.has(t.toLowerCase()));

        if (newTags.length === 0) {
          // No new tags to suggest, auto-dismiss
          handleDismiss();
          return;
        }

        setSuggestedTags(newTags);
        setSelectedTags(new Set(newTags));
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchSuggestions();

    return () => { cancelled = true; };
  }, [notePath]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }, []);

  const handleDismiss = useCallback(() => {
    setClosing(true);
    setTimeout(() => onDismiss(), 180);
  }, [onDismiss]);

  const handleAccept = useCallback(() => {
    const tags = suggestedTags.filter(t => selectedTags.has(t));
    if (tags.length > 0) {
      onAcceptTags(tags);
    }
    handleDismiss();
  }, [suggestedTags, selectedTags, onAcceptTags, handleDismiss]);

  return (
    <div
      className={`ai-autotag-panel ${closing ? 'closing' : ''}`}
      style={{
        '--bg-color': style.bg,
        '--text-color': style.text,
        '--accent-color': style.accent,
      } as React.CSSProperties}
    >
      {/* Header */}
      <div className="ai-autotag-header">
        <Sparkles size={14} className="ai-autotag-header-icon" />
        <span className="ai-autotag-header-title">{t('notes.autoTag.title')}</span>
        <button
          className="ai-autotag-header-close"
          onClick={handleDismiss}
          title={t('notes.autoTag.dismiss')}
        >
          &times;
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="ai-autotag-loading">
          <span className="ai-autotag-spinner" />
          <span>{t('notes.autoTag.analyzing')}</span>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="ai-autotag-error">{error}</div>
      )}

      {/* Tag Chips */}
      {!loading && !error && suggestedTags.length > 0 && (
        <>
          <div className="ai-autotag-chips">
            {suggestedTags.map((tag, i) => (
              <span
                key={tag}
                className={`ai-autotag-chip ${selectedTags.has(tag) ? 'selected' : 'deselected'}`}
                onClick={() => toggleTag(tag)}
                style={{ animationDelay: `${i * 0.06}s` }}
              >
                <span className="ai-autotag-chip-hash">#</span>
                {tag}
              </span>
            ))}
          </div>

          {/* Footer */}
          <div className="ai-autotag-footer">
            <button
              className="ai-autotag-btn"
              onClick={handleDismiss}
            >
              {t('notes.autoTag.dismiss')}
            </button>
            <button
              className="ai-autotag-btn primary"
              onClick={handleAccept}
              disabled={selectedTags.size === 0}
            >
              {t('notes.autoTag.accept').replace('{count}', String(selectedTags.size))}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
