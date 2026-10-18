/**
 * SimilarNotesPanel.tsx
 *
 * Displays a list of notes that are similar to the currently open .md file,
 * ranked by TF-IDF cosine similarity score.
 *
 * Props:
 *   - currentFilePath: absolute path of the currently open note
 *   - onOpenFile: callback when a similar note item is clicked
 *   - style: theme colors { bg, text, accent }
 *   - noteIndex: array of NoteIndexEntry from the note system
 */

import { useMemo } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import type { NoteIndexEntry } from './noteState.ts';
import { useTranslation } from '../i18n';
import { buildTfIdfIndex, findSimilarNotes } from './tfidf.ts';
import type { SimilarNote } from './tfidf.ts';
import './SimilarNotesPanel.css';

export interface SimilarNotesPanelProps {
  currentFilePath: string | null;
  onOpenFile: (path: string) => void;
  style: { bg: string; text: string; accent: string };
  noteIndex: NoteIndexEntry[];
}

export function SimilarNotesPanel({
  currentFilePath,
  onOpenFile,
  style,
  noteIndex,
}: SimilarNotesPanelProps) {
  const { t } = useTranslation();
  // Build TF-IDF index from all notes (memoized on noteIndex changes)
  const tfIdfIndex = useMemo(() => {
    if (noteIndex.length === 0) return null;
    return buildTfIdfIndex(
      noteIndex.map((entry) => ({
        path: entry.path,
        title: entry.title,
        excerpt: entry.excerpt,
        tags: entry.tags,
      })),
    );
  }, [noteIndex]);

  // Find similar notes for the current file
  const similarNotes: SimilarNote[] = useMemo(() => {
    if (!tfIdfIndex || !currentFilePath) return [];
    return findSimilarNotes(tfIdfIndex, currentFilePath);
  }, [tfIdfIndex, currentFilePath]);

  // Build a lookup map for note metadata (title, excerpt) by path
  const noteMap = useMemo(() => {
    const map = new Map<string, NoteIndexEntry>();
    for (const entry of noteIndex) {
      map.set(entry.path, entry);
    }
    return map;
  }, [noteIndex]);

  const isMarkdown = currentFilePath?.toLowerCase().endsWith('.md');

  return (
    <div
      className="similar-notes-panel"
      style={{
        '--snp-bg': style.bg,
        '--snp-text': style.text,
        '--snp-accent': style.accent,
      } as React.CSSProperties}
    >
      <div className="similar-notes-panel-header">
        <Sparkles size={14} />
        <span className="similar-notes-panel-title">{t('notes.similar.title' as any)}</span>
        {similarNotes.length > 0 && (
          <span className="similar-notes-panel-count">{similarNotes.length}</span>
        )}
      </div>

      <div className="similar-notes-panel-list">
        {!currentFilePath || !isMarkdown ? (
          <div className="similar-notes-panel-empty">{t('notes.similar.noSelection' as any)}</div>
        ) : similarNotes.length === 0 ? (
          <div className="similar-notes-panel-empty">{t('notes.similar.none' as any)}</div>
        ) : (
          similarNotes.map((similar) => {
            const entry = noteMap.get(similar.path);
            const title = entry?.title || similar.path.split('/').pop() || similar.path;
            const excerpt = entry?.excerpt || '';
            const scorePercent = Math.round(similar.score * 100);

            return (
              <div
                key={similar.path}
                className="similar-notes-panel-item"
                onClick={() => onOpenFile(similar.path)}
                title={similar.path}
              >
                <FileText size={13} className="similar-notes-panel-item-icon" />
                <div className="similar-notes-panel-item-info">
                  <div className="similar-notes-panel-item-title">{title}</div>
                  {excerpt && (
                    <div className="similar-notes-panel-item-excerpt">
                      {excerpt.length > 80 ? excerpt.slice(0, 80) + '...' : excerpt}
                    </div>
                  )}
                </div>
                <span className="similar-notes-panel-item-score">
                  {scorePercent}%
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
