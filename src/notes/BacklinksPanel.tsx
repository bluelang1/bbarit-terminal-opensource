/**
 * BacklinksPanel.tsx
 *
 * Displays notes that link to the currently open .md file (linked mentions)
 * plus Obsidian-style unlinked mentions (name/title/alias appearing in text
 * without a [[wikilink]]).
 *
 * Props:
 *   - currentFilePath: absolute path of the currently open note
 *   - onOpenFile: callback when a backlink item is clicked
 *   - style: theme colors { bg, text, accent }
 */

import { useEffect, useMemo, useState } from 'react';
import { FileText, Link2, SquareKanban, Unlink } from 'lucide-react';
import { useNoteIndex } from './NoteContext.tsx';
import type { NoteIndexEntry } from './noteState.ts';
import { findUnlinkedMentions, mentionTerms } from './unlinkedMentions.ts';
import type { UnlinkedMention } from './unlinkedMentions.ts';
import './BacklinksPanel.css';

export interface LinkedTaskInfo {
  id: string;
  title: string;
  column: string;
  priority: string;
}

export interface BacklinksPanelProps {
  currentFilePath: string | null;
  onOpenFile: (path: string) => void;
  style: { bg: string; text: string; accent: string };
  /** Kanban tasks linked to the current note */
  linkedTasks?: LinkedTaskInfo[];
  /** Open the kanban board with this task's detail */
  onOpenTask?: (taskId: string) => void;
}

export function BacklinksPanel({ currentFilePath, onOpenFile, style, linkedTasks, onOpenTask }: BacklinksPanelProps) {
  const { getBacklinks, getNoteByPath, notesDir } = useNoteIndex();
  const [unlinked, setUnlinked] = useState<UnlinkedMention[]>([]);

  const backlinks: NoteIndexEntry[] = useMemo(() => {
    if (!currentFilePath) return [];
    return getBacklinks(currentFilePath);
  }, [currentFilePath, getBacklinks]);

  const isMarkdown = currentFilePath?.toLowerCase().endsWith('.md');

  useEffect(() => {
    let cancelled = false;
    setUnlinked([]);
    if (!currentFilePath || !isMarkdown || !notesDir) return;
    const entry = getNoteByPath(currentFilePath);
    if (!entry) return;
    const terms = mentionTerms(entry.name, entry.title, entry.aliases);
    if (terms.length === 0) return;
    const linkedPaths = new Set(backlinks.map(b => b.path));
    void findUnlinkedMentions({ notesDir, currentPath: currentFilePath, terms, linkedPaths })
      .then(res => { if (!cancelled) setUnlinked(res); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentFilePath, isMarkdown, notesDir, getNoteByPath, backlinks]);

  return (
    <div
      className="backlinks-panel"
      style={{
        '--bp-bg': style.bg,
        '--bp-text': style.text,
        '--bp-accent': style.accent,
      } as React.CSSProperties}
    >
      <div className="backlinks-panel-header">
        <Link2 size={14} />
        <span className="backlinks-panel-title">Linked mentions</span>
        {backlinks.length > 0 && (
          <span className="backlinks-panel-count">{backlinks.length}</span>
        )}
      </div>

      <div className="backlinks-panel-list">
        {!currentFilePath || !isMarkdown ? (
          <div className="backlinks-panel-empty">Open a note to see backlinks</div>
        ) : backlinks.length === 0 ? (
          <div className="backlinks-panel-empty">No linked mentions</div>
        ) : (
          backlinks.map((entry) => (
            <div
              key={entry.path}
              className="backlinks-panel-item"
              onClick={() => onOpenFile(entry.path)}
              title={entry.path}
            >
              <FileText size={13} className="backlinks-panel-item-icon" />
              <div className="backlinks-panel-item-info">
                <div className="backlinks-panel-item-title">{entry.title}</div>
                {entry.excerpt && (
                  <div className="backlinks-panel-item-excerpt">
                    {entry.excerpt.length > 80
                      ? entry.excerpt.slice(0, 80) + '...'
                      : entry.excerpt}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {currentFilePath && isMarkdown && linkedTasks && linkedTasks.length > 0 && (
        <>
          <div className="backlinks-panel-header">
            <SquareKanban size={14} />
            <span className="backlinks-panel-title">Kanban tasks</span>
            <span className="backlinks-panel-count">{linkedTasks.length}</span>
          </div>
          <div className="backlinks-panel-list">
            {linkedTasks.map((task) => (
              <div
                key={task.id}
                className="backlinks-panel-item"
                onClick={() => onOpenTask?.(task.id)}
                title={onOpenTask ? 'Open in kanban board' : task.title}
              >
                <SquareKanban size={13} className="backlinks-panel-item-icon" />
                <div className="backlinks-panel-item-info">
                  <div className="backlinks-panel-item-title">{task.title}</div>
                  <div className="backlinks-panel-item-excerpt">{task.column} · {task.priority}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {currentFilePath && isMarkdown && (
        <>
          <div className="backlinks-panel-header">
            <Unlink size={14} />
            <span className="backlinks-panel-title">Unlinked mentions</span>
            {unlinked.length > 0 && (
              <span className="backlinks-panel-count">{unlinked.length}</span>
            )}
          </div>
          <div className="backlinks-panel-list">
            {unlinked.length === 0 ? (
              <div className="backlinks-panel-empty">No unlinked mentions</div>
            ) : (
              unlinked.map((mention) => (
                <div
                  key={mention.path}
                  className="backlinks-panel-item"
                  onClick={() => onOpenFile(mention.path)}
                  title={mention.path}
                >
                  <FileText size={13} className="backlinks-panel-item-icon" />
                  <div className="backlinks-panel-item-info">
                    <div className="backlinks-panel-item-title">{mention.name}</div>
                    <div className="backlinks-panel-item-excerpt">
                      {mention.lineText.length > 80
                        ? mention.lineText.slice(0, 80) + '...'
                        : mention.lineText}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
