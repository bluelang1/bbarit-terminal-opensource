/**
 * TagsPanel.tsx
 *
 * Hierarchical tag tree panel with search, context menu, and expand/collapse.
 * Tags containing `/` are parsed into a tree structure (e.g., dev/rust/async).
 *
 * Props:
 *   - onOpenFile: callback when a note item is clicked
 *   - style: theme colors { bg, text, accent }
 *   - onTagsChanged?: callback after rename/delete operations for reindexing
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Hash, FileText, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useNoteState, useNoteIndex } from './NoteContext.tsx';
import { useTranslation } from '../i18n';
import type { NoteIndexEntry, TagEntry } from './noteState.ts';
import './TagsPanel.css';

// ───────────────────────── Types ─────────────────────────

interface TagTreeNode {
  name: string;
  fullTag: string;
  count: number;
  children: TagTreeNode[];
  notePaths: string[];
}

interface ContextMenuState {
  x: number;
  y: number;
  tag: string;
  isParent: boolean;
}

// ───────────────────────── Tree Builder ─────────────────────────

function buildTagTree(tagIndex: TagEntry[]): TagTreeNode[] {
  const rootMap = new Map<string, TagTreeNode>();

  /** Get or create a node at the given path segments */
  function ensureNode(segments: string[]): TagTreeNode {
    const rootName = segments[0];
    if (!rootMap.has(rootName)) {
      rootMap.set(rootName, {
        name: rootName,
        fullTag: rootName,
        count: 0,
        children: [],
        notePaths: [],
      });
    }

    let current = rootMap.get(rootName)!;
    for (let i = 1; i < segments.length; i++) {
      const childName = segments[i];
      const childFullTag = segments.slice(0, i + 1).join('/');
      let child = current.children.find(c => c.name === childName);
      if (!child) {
        child = {
          name: childName,
          fullTag: childFullTag,
          count: 0,
          children: [],
          notePaths: [],
        };
        current.children.push(child);
      }
      current = child;
    }
    return current;
  }

  for (const entry of tagIndex) {
    const segments = entry.tag.split('/');
    const node = ensureNode(segments);
    node.count = entry.count;
    node.notePaths = entry.notePaths;
  }

  /** Recursively aggregate child counts into parent */
  function aggregateCounts(node: TagTreeNode): number {
    let total = node.count;
    for (const child of node.children) {
      total += aggregateCounts(child);
    }
    node.count = total;
    return total;
  }

  const roots = Array.from(rootMap.values());
  // Sort children alphabetically at each level
  function sortTree(nodes: TagTreeNode[]) {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) {
      sortTree(n.children);
    }
  }

  // Aggregate counts (parent = own direct + all descendants)
  for (const root of roots) {
    aggregateCounts(root);
  }

  sortTree(roots);
  return roots;
}

/** Check if a node or any descendant matches the filter */
function nodeMatchesFilter(node: TagTreeNode, filter: string): boolean {
  const lower = filter.toLowerCase();
  if (node.name.toLowerCase().includes(lower) || node.fullTag.toLowerCase().includes(lower)) {
    return true;
  }
  return node.children.some(child => nodeMatchesFilter(child, filter));
}

// ───────────────────────── Depth Colors ─────────────────────────

const DEPTH_OPACITIES = [1.0, 0.75, 0.55, 0.40];

function getDepthOpacity(depth: number): number {
  return DEPTH_OPACITIES[Math.min(depth, DEPTH_OPACITIES.length - 1)];
}

// ───────────────────────── Component ─────────────────────────

export interface TagsPanelProps {
  onOpenFile: (path: string) => void;
  style: { bg: string; text: string; accent: string };
  onTagsChanged?: () => void;
}

export function TagsPanel({ onOpenFile, style, onTagsChanged }: TagsPanelProps) {
  const { t } = useTranslation();
  const { tagIndex } = useNoteState();
  const { noteIndex } = useNoteIndex();

  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState('');
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  // Build the hierarchical tree
  const tagTree = useMemo(() => buildTagTree(tagIndex), [tagIndex]);

  // Notes for the selected tag (including children if parent tag)
  const tagNotes: NoteIndexEntry[] = useMemo(() => {
    if (!selectedTag) return [];
    // Find all tags that start with selectedTag (exact match or child)
    const matchingNotes = noteIndex.filter(note =>
      note.tags.some(t => t === selectedTag || t.startsWith(selectedTag + '/'))
    );
    return matchingNotes;
  }, [selectedTag, noteIndex]);

  // Auto-expand parents when filter is active
  const effectiveCollapsed = useMemo(() => {
    if (!filterText.trim()) return collapsedSet;
    // When filtering, nothing is collapsed (auto-expand all matching paths)
    return new Set<string>();
  }, [collapsedSet, filterText]);

  // Toggle collapse/expand
  const toggleCollapse = useCallback((fullTag: string) => {
    setCollapsedSet(prev => {
      const next = new Set(prev);
      if (next.has(fullTag)) {
        next.delete(fullTag);
      } else {
        next.add(fullTag);
      }
      return next;
    });
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.querySelector('.tags-panel-ctx-menu')?.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ctxMenu]);

  // Context menu: rename tag
  const handleRenameTag = useCallback(async (oldTag: string) => {
    setCtxMenu(null);
    const newTag = window.prompt(t('notes.tags.renamePrompt').replace('{tag}', oldTag), oldTag);
    if (!newTag || newTag === oldTag) return;

    // Find all notes with this tag (or child tags)
    const affectedNotes = noteIndex.filter(note =>
      note.tags.some(t => t === oldTag || t.startsWith(oldTag + '/'))
    );

    for (const note of affectedNotes) {
      try {
        const content = await invoke<string>('read_file', { path: note.path });

        let updated = content;

        // Replace in frontmatter tags array
        // Match tags in YAML frontmatter (between --- delimiters)
        const fmMatch = updated.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const fmContent = fmMatch[1];
          // Replace tag references in frontmatter
          const updatedFm = fmContent.replace(
            new RegExp(`(^|\\s|\\[|,\\s*)${escapeRegex(oldTag)}(?=\\s|,|\\]|$)`, 'gm'),
            (_match, prefix) => `${prefix}${newTag}`
          );
          updated = updated.replace(fmMatch[1], updatedFm);
        }

        // Replace inline #tags in body
        updated = updated.replace(
          new RegExp(`#${escapeRegex(oldTag)}(?=[\\s,;.!?)\\]|$])`, 'g'),
          `#${newTag}`
        );
        // Also replace child tags: #oldTag/child -> #newTag/child
        updated = updated.replace(
          new RegExp(`#${escapeRegex(oldTag)}/`, 'g'),
          `#${newTag}/`
        );

        if (updated !== content) {
          await invoke('write_file', { path: note.path, content: updated });
        }
      } catch (err) {
        console.error(`[TagsPanel] Failed to rename tag in ${note.path}:`, err);
      }
    }

    onTagsChanged?.();
  }, [noteIndex, onTagsChanged]);

  // Context menu: delete tag
  const handleDeleteTag = useCallback(async (tag: string) => {
    setCtxMenu(null);
    const confirmed = window.confirm(t('notes.tags.deleteConfirm').replace('{tag}', tag));
    if (!confirmed) return;

    const affectedNotes = noteIndex.filter(note =>
      note.tags.some(t => t === tag || t.startsWith(tag + '/'))
    );

    for (const note of affectedNotes) {
      try {
        const content = await invoke<string>('read_file', { path: note.path });

        let updated = content;

        // Remove from frontmatter
        const fmMatch = updated.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const fmContent = fmMatch[1];
          // Remove the tag from YAML arrays and standalone entries
          let updatedFm = fmContent;
          // Remove tag and its children from frontmatter tag list
          updatedFm = updatedFm.replace(
            new RegExp(`^\\s*-\\s*${escapeRegex(tag)}(?:/\\S*)?\\s*$`, 'gm'),
            ''
          );
          // Clean up empty lines in frontmatter
          updatedFm = updatedFm.replace(/\n{2,}/g, '\n');
          updated = updated.replace(fmMatch[1], updatedFm);
        }

        // Remove inline #tags (and children)
        updated = updated.replace(
          new RegExp(`\\s*#${escapeRegex(tag)}(?:/\\S*)?(?=[\\s,;.!?)\\]|$])`, 'g'),
          ''
        );

        if (updated !== content) {
          await invoke('write_file', { path: note.path, content: updated });
        }
      } catch (err) {
        console.error(`[TagsPanel] Failed to delete tag from ${note.path}:`, err);
      }
    }

    onTagsChanged?.();
  }, [noteIndex, onTagsChanged]);

  // Right-click handler
  const handleContextMenu = useCallback((e: React.MouseEvent, tag: string, isParent: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = panelRef.current?.getBoundingClientRect();
    const x = e.clientX - (rect?.left ?? 0);
    const y = e.clientY - (rect?.top ?? 0);
    setCtxMenu({ x, y, tag, isParent });
  }, []);

  // ───────────────────── Tree Node Renderer ─────────────────────

  const renderTreeNode = useCallback((node: TagTreeNode, depth: number): React.ReactNode => {
    const filter = filterText.trim().toLowerCase();
    if (filter && !nodeMatchesFilter(node, filter)) {
      return null;
    }

    const hasChildren = node.children.length > 0;
    const isCollapsed = effectiveCollapsed.has(node.fullTag);
    const isSelected = selectedTag === node.fullTag;
    const opacity = getDepthOpacity(depth);

    return (
      <div key={node.fullTag} className="tags-panel-tree-branch">
        <div
          className={`tags-panel-tree-item ${isSelected ? 'active' : ''}`}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => setSelectedTag(node.fullTag)}
          onContextMenu={(e) => handleContextMenu(e, node.fullTag, hasChildren)}
        >
          <div
            className="tags-panel-tree-dot"
            style={{
              backgroundColor: style.accent,
              opacity: opacity,
            }}
          />

          {hasChildren ? (
            <button
              className={`tags-panel-tree-chevron ${isCollapsed ? '' : 'expanded'}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse(node.fullTag);
              }}
            >
              <ChevronRight size={12} />
            </button>
          ) : (
            <span className="tags-panel-tree-chevron-spacer" />
          )}

          <span
            className="tags-panel-tree-label"
            style={{ color: style.accent, opacity }}
          >
            <span className="tags-panel-tag-hash">#</span>
            {node.name}
          </span>

          <span className="tags-panel-tag-count">{node.count}</span>
        </div>

        {hasChildren && !isCollapsed && (
          <div className="tags-panel-tree-children">
            {node.children.map(child => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }, [filterText, effectiveCollapsed, selectedTag, style.accent, toggleCollapse, handleContextMenu]);

  // ───────────────────── Render ─────────────────────

  return (
    <div
      ref={panelRef}
      className="tags-panel"
      style={{
        '--tp-bg': style.bg,
        '--tp-text': style.text,
        '--tp-accent': style.accent,
      } as React.CSSProperties}
    >
      <div className="tags-panel-header">
        {selectedTag ? (
          <>
            <button
              className="tags-panel-back"
              onClick={() => setSelectedTag(null)}
              title={t('notes.tags.backToAll')}
            >
              <ChevronLeft size={14} />
            </button>
            <Hash size={14} />
            <span className="tags-panel-title">{selectedTag}</span>
            <span className="tags-panel-count">{tagNotes.length}</span>
          </>
        ) : (
          <>
            <Hash size={14} />
            <span className="tags-panel-title">{t('notes.tags.title')}</span>
            {tagIndex.length > 0 && (
              <span className="tags-panel-count">{tagIndex.length}</span>
            )}
          </>
        )}
      </div>

      {/* Search filter (only in tag tree view) */}
      {!selectedTag && (
        <div className="tags-panel-search">
          <Search size={12} className="tags-panel-search-icon" />
          <input
            ref={filterInputRef}
            type="text"
            placeholder={t('notes.tags.filter')}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="tags-panel-search-input"
          />
          {filterText && (
            <button
              className="tags-panel-search-clear"
              onClick={() => { setFilterText(''); filterInputRef.current?.focus(); }}
            >
              <X size={11} />
            </button>
          )}
        </div>
      )}

      <div className="tags-panel-list">
        {selectedTag ? (
          // Show notes for selected tag
          tagNotes.length === 0 ? (
            <div className="tags-panel-empty">{t('notes.tags.noNotes')}</div>
          ) : (
            tagNotes.map((note) => (
              <div
                key={note.path}
                className="tags-panel-note-item"
                onClick={() => onOpenFile(note.path)}
                title={note.path}
              >
                <FileText size={13} className="tags-panel-note-icon" />
                <span className="tags-panel-note-title">{note.title}</span>
              </div>
            ))
          )
        ) : (
          // Show tag tree
          tagTree.length === 0 ? (
            <div className="tags-panel-empty">{t('notes.tags.none')}</div>
          ) : (
            tagTree.map(node => renderTreeNode(node, 0))
          )
        )}
      </div>

      {/* Context Menu */}
      {ctxMenu && (
        <div
          className="tags-panel-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <div
            className="tags-panel-ctx-item"
            onClick={() => handleRenameTag(ctxMenu.tag)}
          >
            {t('notes.tags.rename')}
          </div>
          <div
            className="tags-panel-ctx-item tags-panel-ctx-danger"
            onClick={() => handleDeleteTag(ctxMenu.tag)}
          >
            {t('notes.tags.delete')}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Helpers ─────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
