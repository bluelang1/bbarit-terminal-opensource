/**
 * Simplified Kanban Board
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Plus, Trash2, FolderOpen, Send, Unlink, FileText, FilePlus, Check, Download, Calendar, X, Clock, Layers, FolderKanban, ArrowUpDown } from 'lucide-react';
import type { KanbanTask, KanbanColumnId } from './types';
import { KANBAN_COLUMNS, PRIORITY_COLORS, PRIORITY_LABELS } from './types';
import { createTask, moveTask } from './storage';
import { buildEventFromTask } from './ganttSync';
import { useTranslation, type TranslationKey } from '../i18n';
import { kvGet, kvGetJSON, kvSetJSON } from '../hooks/useKV';
import { fetchGithubIssues, fetchLinearIssues } from '../pm2/pm2Commands';

const COLUMN_LABEL_KEYS: Record<KanbanColumnId, TranslationKey> = {
  backlog: 'kanban.backlog',
  todo: 'kanban.todo',
  inprogress: 'kanban.inProgress',
  review: 'kanban.inReview',
  done: 'kanban.done',
  cancelled: 'kanban.cancelled',
};


export interface KanbanProjectInfo {
  id: string;
  displayName: string;
  workDir: string;
  icon: string;
}

export interface KanbanNoteInfo {
  path: string;
  title: string;
}

interface KanbanPanelProps {
  projectId: string;
  tasks: KanbanTask[];
  onTasksChange: (tasks: KanbanTask[]) => void;
  theme: {
    bg: string;
    text: string;
    border: string;
    accent: string;
  };
  projects?: KanbanProjectInfo[];
  onSendToConsole?: (prompt: string) => void;
  activeWorkDir?: string;
  /** All available notes from note index */
  notes?: KanbanNoteInfo[];
  /** Open a note in the editor */
  onOpenNote?: (path: string) => void;
  /** Create a note for a task in the vault; returns the new note path */
  onCreateTaskNote?: (task: KanbanTask) => Promise<string | null>;
  /** Open this task's detail modal once (external navigation, e.g. from a note) */
  focusTaskId?: string | null;
  onFocusTaskConsumed?: () => void;
}

export function KanbanPanel({ tasks, onTasksChange, theme, projects, onSendToConsole, activeWorkDir, notes, onOpenNote, onCreateTaskNote, focusTaskId, onFocusTaskConsumed }: KanbanPanelProps) {
  const { t } = useTranslation();
  const [draggingTask, setDraggingTask] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<KanbanColumnId | null>(null);
  const [addingColumn, setAddingColumn] = useState<KanbanColumnId | null>(null);
  const [addText, setAddText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [linkingTaskId, setLinkingTaskId] = useState<string | null>(null);
  const [notePickerTaskId, setNotePickerTaskId] = useState<string | null>(null);
  const [noteSearchText, setNoteSearchText] = useState('');
  const [detailTask, setDetailTask] = useState<KanbanTask | null>(null);
  const [detailDesc, setDetailDesc] = useState('');
  const [detailTitle, setDetailTitle] = useState('');
  const [showIssuePicker, setShowIssuePicker] = useState(false);
  const [issueList, setIssueList] = useState<{ id: string; title: string; source: string; url?: string; body?: string }[]>([]);
  const [issueLoading, setIssueLoading] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const noteSearchRef = useRef<HTMLInputElement>(null);
  // Pointer-based drag (HTML5 native DnD is blocked by Tauri dragDropEnabled:true,
  // which we keep on for OS file → terminal drop). See App.tsx onDragDropEvent.
  const dragStateRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; title: string } | null>(null);

  /* ── View mode: all vs per-project ── */
  const [kanbanViewMode, setKanbanViewMode] = useState<'all' | 'project'>('all');
  const [selectedProjectWorkDir, setSelectedProjectWorkDir] = useState<string | undefined>(activeWorkDir);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);

  /* ── Sort ── */
  type SortKey = 'newest' | 'oldest' | 'priority-high' | 'priority-low' | 'title-az' | 'title-za';
  const [sortKey, setSortKey] = useState<SortKey>('newest');
  const [showSortDropdown, setShowSortDropdown] = useState(false);

  const SORT_OPTIONS: { key: SortKey; label: string }[] = [
    { key: 'newest', label: 'Newest first' },
    { key: 'oldest', label: 'Oldest first' },
    { key: 'priority-high', label: 'Priority (high → low)' },
    { key: 'priority-low', label: 'Priority (low → high)' },
    { key: 'title-az', label: 'Title (A → Z)' },
    { key: 'title-za', label: 'Title (Z → A)' },
  ];

  const PRIORITY_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };

  const sortTasks = useCallback((arr: KanbanTask[]): KanbanTask[] => {
    return [...arr].sort((a, b) => {
      switch (sortKey) {
        case 'newest': return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        case 'oldest': return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        case 'priority-high': return (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0);
        case 'priority-low': return (PRIORITY_ORDER[a.priority] || 0) - (PRIORITY_ORDER[b.priority] || 0);
        case 'title-az': return a.title.localeCompare(b.title);
        case 'title-za': return b.title.localeCompare(a.title);
        default: return 0;
      }
    });
  }, [sortKey]);

  // Filtered tasks based on view mode
  const visibleTasks = useMemo(() => {
    if (kanbanViewMode === 'all') return tasks;
    const filterDir = selectedProjectWorkDir;
    if (!filterDir) return tasks.filter(t => !t.linkedProject);
    return tasks.filter(t => t.linkedProject === filterDir);
  }, [tasks, kanbanViewMode, selectedProjectWorkDir]);

  const selectedProject = useMemo(() => {
    if (!selectedProjectWorkDir || !projects) return undefined;
    return projects.find(p => p.workDir === selectedProjectWorkDir);
  }, [selectedProjectWorkDir, projects]);

  const tasksByColumn = useMemo(() => {
    const grouped: Record<KanbanColumnId, KanbanTask[]> = {
      backlog: [], todo: [], inprogress: [], review: [], done: [], cancelled: [],
    };
    for (const task of visibleTasks) {
      const col = (grouped[task.column] ? task.column : 'todo') as KanbanColumnId;
      grouped[col].push(task);
    }
    for (const col of Object.keys(grouped) as KanbanColumnId[]) {
      grouped[col] = sortTasks(grouped[col]);
    }
    return grouped;
  }, [visibleTasks, sortTasks]);

  /* ── Filtered notes for picker ── */
  const filteredNotes = useMemo(() => {
    if (!notes) return [];
    if (!noteSearchText.trim()) return notes.slice(0, 30);
    const q = noteSearchText.toLowerCase();
    return notes.filter(n => n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)).slice(0, 30);
  }, [notes, noteSearchText]);

  /* ── Open note picker (click outside to close) ── */
  const openNotePicker = useCallback((taskId: string) => {
    if (notePickerTaskId === taskId) {
      setNotePickerTaskId(null);
      return;
    }
    setNotePickerTaskId(taskId);
    setNoteSearchText('');
    setTimeout(() => noteSearchRef.current?.focus(), 50);
    // Close on outside click
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.kanban-note-picker')) {
        setNotePickerTaskId(null);
        document.removeEventListener('mousedown', handler);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', handler), 10);
  }, [notePickerTaskId]);

  /* ── Toggle note link ── */
  const toggleNoteLink = useCallback((taskId: string, notePath: string) => {
    onTasksChange(tasks.map(t => {
      if (t.id !== taskId) return t;
      const current = t.linkedNotes || [];
      const updated = current.includes(notePath)
        ? current.filter(n => n !== notePath)
        : [...current, notePath];
      return { ...t, linkedNotes: updated.length > 0 ? updated : undefined, updatedAt: new Date().toISOString() };
    }));
  }, [tasks, onTasksChange]);

  /* ── Fetch issues from GitHub / Linear ── */
  const loadIssues = useCallback(async () => {
    setIssueLoading(true);
    const results: { id: string; title: string; source: string; url?: string; body?: string }[] = [];
    try {
      const ghToken = (await kvGet('octo-github-token') || '').trim();
      const ghRepo = (await kvGet('octo-github-repo') || '').trim();
      if (ghToken && ghRepo) {
        const ghIssues = await fetchGithubIssues(ghToken, ghRepo, 30);
        for (const i of ghIssues) {
          if (i.pull_request) continue; // skip PRs
          results.push({ id: `gh-${i.number}`, title: `#${i.number} ${i.title}`, source: 'GitHub', url: i.html_url, body: i.body });
        }
      }
    } catch { /* ignore */ }
    try {
      const linearToken = (await kvGet('octo-linear-api-token') || '').trim();
      if (linearToken) {
        const linearIssues = await fetchLinearIssues(linearToken, 30);
        for (const i of linearIssues) {
          results.push({ id: `linear-${i.id}`, title: `${i.identifier} ${i.title}`, source: 'Linear', url: i.url, body: i.description });
        }
      }
    } catch { /* ignore */ }
    setIssueList(results);
    setIssueLoading(false);
  }, []);

  const importIssue = useCallback((issue: { title: string; url?: string; body?: string }) => {
    const task = createTask(issue.title, 'todo', 'medium');
    if (activeWorkDir) task.linkedProject = activeWorkDir;
    const descParts: string[] = [];
    if (issue.url) descParts.push(issue.url);
    if (issue.body) descParts.push(issue.body.slice(0, 500));
    if (descParts.length) task.description = descParts.join('\n\n');
    onTasksChange([...tasks, task]);
  }, [tasks, onTasksChange, activeWorkDir]);

  /* ── Inline Add (auto-link current project) ── */
  const startAdd = useCallback((col: KanbanColumnId) => {
    setAddingColumn(col);
    setAddText('');
    setTimeout(() => addRef.current?.focus(), 30);
  }, []);

  const commitAdd = useCallback(() => {
    if (!addingColumn || !addText.trim()) { setAddingColumn(null); return; }
    const task = createTask(addText.trim(), addingColumn, 'medium');
    if (activeWorkDir) task.linkedProject = activeWorkDir;
    onTasksChange([...tasks, task]);
    setAddText('');
    setAddingColumn(null);
  }, [addingColumn, addText, tasks, onTasksChange, activeWorkDir]);

  /* ── Inline Edit ── */
  const startEdit = useCallback((task: KanbanTask) => {
    setEditingId(task.id);
    setEditText(task.title);
    setTimeout(() => editRef.current?.focus(), 30);
  }, []);

  const commitEdit = useCallback(() => {
    if (!editingId) return;
    if (editText.trim()) {
      onTasksChange(tasks.map(t =>
        t.id === editingId ? { ...t, title: editText.trim(), updatedAt: new Date().toISOString() } : t
      ));
    }
    setEditingId(null);
  }, [editingId, editText, tasks, onTasksChange]);

  /* ── Move / Delete ── */
  const handleMove = useCallback((taskId: string, newCol: KanbanColumnId) => {
    const task = tasks.find(t => t.id === taskId);
    if (task && task.column !== newCol) onTasksChange(tasks.map(t => t.id === taskId ? moveTask(task, newCol) : t));
  }, [tasks, onTasksChange]);

  const handleDelete = useCallback((taskId: string) => {
    onTasksChange(tasks.filter(t => t.id !== taskId));
  }, [tasks, onTasksChange]);

  /* ── Priority cycle ── */
  const cyclePriority = useCallback((taskId: string) => {
    const order: KanbanTask['priority'][] = ['low', 'medium', 'high'];
    onTasksChange(tasks.map(t => {
      if (t.id !== taskId) return t;
      const idx = order.indexOf(t.priority);
      return { ...t, priority: order[(idx + 1) % 3], updatedAt: new Date().toISOString() };
    }));
  }, [tasks, onTasksChange]);

  /* ── Link project ── */
  const handleLinkProject = useCallback((taskId: string, projectPath: string | undefined) => {
    onTasksChange(tasks.map(t =>
      t.id === taskId ? { ...t, linkedProject: projectPath, updatedAt: new Date().toISOString() } : t
    ));
    setLinkingTaskId(null);
  }, [tasks, onTasksChange]);

  /* ── Link task to Gantt calendar event ── */
  const linkToGantt = useCallback(async (task: KanbanTask) => {
    const KV_CAL = 'octo-calendar-events';
    const events = await kvGetJSON<{ id: string; taskId?: string }[]>(KV_CAL, []);

    // If already linked, unlink
    if (task.calendarEventId) {
      const updated = events.filter(e => e.id !== task.calendarEventId);
      void kvSetJSON(KV_CAL, updated);
      onTasksChange(tasks.map(t => t.id === task.id ? { ...t, calendarEventId: undefined, updatedAt: new Date().toISOString() } : t));
      return;
    }

    // Create new calendar event from kanban task (due date becomes the bar range)
    const newEvent = buildEventFromTask(task);
    void kvSetJSON(KV_CAL, [...events, newEvent]);
    onTasksChange(tasks.map(t => t.id === task.id ? { ...t, calendarEventId: newEvent.id, updatedAt: new Date().toISOString() } : t));
  }, [tasks, onTasksChange]);

  /* ── Create a vault note for a task and link it ── */
  const [creatingNoteTaskId, setCreatingNoteTaskId] = useState<string | null>(null);
  const handleCreateTaskNote = useCallback(async (task: KanbanTask) => {
    if (!onCreateTaskNote || creatingNoteTaskId) return;
    setCreatingNoteTaskId(task.id);
    try {
      const path = await onCreateTaskNote(task);
      if (path) {
        onTasksChange(tasks.map(t => t.id === task.id
          ? { ...t, linkedNotes: [...(t.linkedNotes || []), path], updatedAt: new Date().toISOString() }
          : t));
        setNotePickerTaskId(null);
        onOpenNote?.(path);
      }
    } finally {
      setCreatingNoteTaskId(null);
    }
  }, [onCreateTaskNote, creatingNoteTaskId, tasks, onTasksChange, onOpenNote]);

  /* ── Due date ── */
  const detailChangeDueDate = useCallback((dueDate: string) => {
    if (!detailTask) return;
    const updated = { ...detailTask, dueDate: dueDate || undefined, updatedAt: new Date().toISOString() };
    onTasksChange(tasks.map(t => t.id === detailTask.id ? updated : t));
    setDetailTask(updated);
  }, [detailTask, tasks, onTasksChange]);

  /* ── Send single task to console ── */
  const handleSendTaskToConsole = useCallback((task: KanbanTask) => {
    if (!onSendToConsole) return;
    const lines: string[] = [];
    lines.push(`# Task: ${task.title}`);
    lines.push(`- Status: ${t(COLUMN_LABEL_KEYS[task.column])}`);
    lines.push(`- Priority: ${PRIORITY_LABELS[task.priority]}`);
    if (task.description) lines.push(`- Notes:\n${task.description}`);
    if (task.linkedProject) {
      const proj = projects?.find(p => p.workDir === task.linkedProject);
      lines.push(`- Project: ${proj ? `${proj.icon} ${proj.displayName}` : task.linkedProject}`);
      lines.push(`- Path: ${task.linkedProject}`);
    }
    if (task.linkedNotes && task.linkedNotes.length > 0) {
      lines.push('\n## Related Notes');
      for (const np of task.linkedNotes) {
        const note = notes?.find(n => n.path === np);
        lines.push(`- ${note?.title || np.split('/').pop()} (${np})`);
      }
      lines.push('\nPlease read the notes listed above before starting. They contain important context for this task.');
    }
    lines.push('\n---');
    lines.push('Based on the task above, help me work on this. Analyze the situation, suggest an approach, and create an action plan.');
    onSendToConsole(lines.join('\n'));
  }, [onSendToConsole, t, projects, notes]);

  /* ── Detail view ── */
  const openDetail = useCallback((task: KanbanTask) => {
    setDetailTask(task);
    setDetailTitle(task.title);
    setDetailDesc(task.description || '');
  }, []);

  // External navigation (e.g. from a note's linked-tasks list): open the task detail once
  useEffect(() => {
    if (!focusTaskId) return;
    const task = tasks.find(t => t.id === focusTaskId);
    if (task) openDetail(task);
    onFocusTaskConsumed?.();
  }, [focusTaskId, tasks, openDetail, onFocusTaskConsumed]);

  const closeDetail = useCallback(() => {
    if (detailTask) {
      const titleChanged = detailTitle.trim() && detailTitle.trim() !== detailTask.title;
      const descChanged = detailDesc !== (detailTask.description || '');
      if (titleChanged || descChanged) {
        onTasksChange(tasks.map(t =>
          t.id === detailTask.id ? {
            ...t,
            title: detailTitle.trim() || t.title,
            description: detailDesc.trim() || undefined,
            updatedAt: new Date().toISOString(),
          } : t
        ));
      }
    }
    setDetailTask(null);
  }, [detailTask, detailTitle, detailDesc, tasks, onTasksChange]);

  const detailChangeColumn = useCallback((col: KanbanColumnId) => {
    if (!detailTask) return;
    const moved = moveTask(detailTask, col);
    onTasksChange(tasks.map(t => t.id === detailTask.id ? moved : t));
    setDetailTask(moved);
  }, [detailTask, tasks, onTasksChange]);

  const detailChangePriority = useCallback((p: KanbanTask['priority']) => {
    if (!detailTask) return;
    const updated = { ...detailTask, priority: p, updatedAt: new Date().toISOString() };
    onTasksChange(tasks.map(t => t.id === detailTask.id ? updated : t));
    setDetailTask(updated);
  }, [detailTask, tasks, onTasksChange]);

  /* ── Build board prompt ── */
  const handleSendToConsole2 = useCallback(() => {
    if (!onSendToConsole) return;
    const lines: string[] = [];
    lines.push('# Kanban Board Status\n');
    for (const col of KANBAN_COLUMNS) {
      const colTasks = tasksByColumn[col.id];
      lines.push(`## ${t(COLUMN_LABEL_KEYS[col.id])} (${colTasks.length})`);
      if (colTasks.length === 0) { lines.push('  (empty)\n'); continue; }
      for (const task of colTasks) {
        const prio = PRIORITY_LABELS[task.priority];
        const proj = task.linkedProject ? projects?.find(p => p.workDir === task.linkedProject) : undefined;
        const projLabel = proj ? ` [${proj.icon} ${proj.displayName}]` : '';
        lines.push(`- [${prio}] ${task.title}${projLabel}`);
        if (task.description) lines.push(`  ${task.description}`);
        if (task.linkedNotes?.length) {
          for (const np of task.linkedNotes) {
            const note = notes?.find(n => n.path === np);
            lines.push(`  Note: ${note?.title || np.split('/').pop()} (${np})`);
          }
        }
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('Based on the kanban board above, help me prioritize tasks.');
    lines.push('Read any linked notes before suggesting an action plan.');
    onSendToConsole(lines.join('\n'));
  }, [onSendToConsole, tasksByColumn, t, projects, notes]);

  /* ── Drag & Drop (pointer-based) ── */
  const columnFromPoint = useCallback((x: number, y: number): KanbanColumnId | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const colEl = el?.closest('[data-kanban-col]') as HTMLElement | null;
    return (colEl?.getAttribute('data-kanban-col') as KanbanColumnId | null) ?? null;
  }, []);

  const handleCardPointerDown = useCallback((e: React.PointerEvent, taskId: string, title: string) => {
    if (e.button !== 0) return;            // left button only
    if (editingId === taskId) return;      // don't drag while inline-editing
    dragStateRef.current = { id: taskId, startX: e.clientX, startY: e.clientY, active: false };

    const onMove = (ev: PointerEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      if (!st.active) {
        // 5px threshold so a normal click/double-click still works
        if (Math.hypot(ev.clientX - st.startX, ev.clientY - st.startY) < 5) return;
        st.active = true;
        setDraggingTask(st.id);
      }
      setDragGhost({ x: ev.clientX, y: ev.clientY, title });
      setDragOverColumn(columnFromPoint(ev.clientX, ev.clientY));
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const st = dragStateRef.current;
      dragStateRef.current = null;
      setDragGhost(null);
      if (st?.active) {
        suppressClickRef.current = true;   // swallow the click that follows a drag
        const col = columnFromPoint(ev.clientX, ev.clientY);
        if (col) handleMove(st.id, col);
      }
      setDraggingTask(null);
      setDragOverColumn(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [editingId, handleMove, columnFromPoint]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: theme.bg, color: theme.text, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 20px', borderBottom: `1px solid ${theme.border}`,
      }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Kanban</span>
        <span style={{ fontSize: 11, padding: '2px 8px', background: `${theme.accent}18`, color: theme.accent, borderRadius: 'var(--brutal-radius)', fontWeight: 600 }}>
          {visibleTasks.length}{kanbanViewMode === 'project' ? ` / ${tasks.length}` : ''}
        </span>

        {/* View mode toggle */}
        <div style={{ display: 'flex', borderRadius: 'var(--brutal-radius)', overflow: 'hidden', border: `1px solid ${theme.border}40` }}>
          <button
            onClick={() => setKanbanViewMode('all')}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '3px 10px', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600,
              background: kanbanViewMode === 'all' ? `${theme.accent}20` : 'transparent',
              color: kanbanViewMode === 'all' ? theme.accent : `${theme.text}60`,
              transition: 'all 0.05s',
            }}
          >
            <Layers size={11} /> All
          </button>
          <button
            onClick={() => { setKanbanViewMode('project'); if (!selectedProjectWorkDir) setSelectedProjectWorkDir(activeWorkDir); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '3px 10px', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600,
              borderLeft: `1px solid ${theme.border}40`,
              background: kanbanViewMode === 'project' ? `${theme.accent}20` : 'transparent',
              color: kanbanViewMode === 'project' ? theme.accent : `${theme.text}60`,
              transition: 'all 0.05s',
            }}
          >
            <FolderKanban size={11} /> Project
          </button>
        </div>

        {/* Project selector (only in project mode) */}
        {kanbanViewMode === 'project' && projects && projects.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setShowProjectDropdown(!showProjectDropdown)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '3px 10px', borderRadius: 'var(--brutal-radius)',
                background: `${theme.text}08`, border: `1px solid ${theme.border}40`,
                color: `${theme.text}90`, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              <FolderOpen size={11} />
              {selectedProject ? `${selectedProject.icon} ${selectedProject.displayName}` : 'Select project'}
            </button>
            {showProjectDropdown && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setShowProjectDropdown(false)} />
                <div style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 4,
                  width: 220, maxHeight: 240, overflowY: 'auto',
                  background: theme.bg, border: `1px solid ${theme.border}`,
                  borderRadius: 'var(--brutal-radius)', boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                  zIndex: 100, padding: 4,
                }}>
                  {projects.map(p => (
                    <div
                      key={p.id}
                      onClick={() => { setSelectedProjectWorkDir(p.workDir); setShowProjectDropdown(false); }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '6px 8px', borderRadius: 'var(--brutal-radius)', cursor: 'pointer', fontSize: 11,
                        background: selectedProjectWorkDir === p.workDir ? `${theme.accent}20` : 'transparent',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = `${theme.accent}15`; }}
                      onMouseLeave={e => { e.currentTarget.style.background = selectedProjectWorkDir === p.workDir ? `${theme.accent}20` : 'transparent'; }}
                    >
                      <span>{p.icon}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.displayName}</span>
                      {selectedProjectWorkDir === p.workDir && <Check size={12} style={{ color: theme.accent }} />}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, position: 'relative' }}>
          {/* Sort button */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setShowSortDropdown(!showSortDropdown)}
              title="Sort"
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '4px 10px', borderRadius: 'var(--brutal-radius)',
                background: sortKey !== 'newest' ? `${theme.accent}18` : `${theme.text}08`,
                border: `1px solid ${sortKey !== 'newest' ? theme.accent : theme.border}40`,
                color: sortKey !== 'newest' ? theme.accent : `${theme.text}90`,
                fontSize: 11, fontWeight: 600, cursor: 'pointer',
              }}
            >
              <ArrowUpDown size={12} /> {SORT_OPTIONS.find(o => o.key === sortKey)?.label || 'Sort'}
            </button>
            {showSortDropdown && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setShowSortDropdown(false)} />
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4,
                  width: 180, background: theme.bg, border: `1px solid ${theme.border}`,
                  borderRadius: 'var(--brutal-radius)', boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                  zIndex: 100, padding: 4,
                }}>
                  {SORT_OPTIONS.map(opt => (
                    <div
                      key={opt.key}
                      onClick={() => { setSortKey(opt.key); setShowSortDropdown(false); }}
                      style={{
                        padding: '6px 8px', borderRadius: 'var(--brutal-radius)', cursor: 'pointer', fontSize: 11,
                        background: sortKey === opt.key ? `${theme.accent}20` : 'transparent',
                        color: sortKey === opt.key ? theme.accent : theme.text,
                        fontWeight: sortKey === opt.key ? 600 : 400,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = `${theme.accent}15`; }}
                      onMouseLeave={e => { e.currentTarget.style.background = sortKey === opt.key ? `${theme.accent}20` : 'transparent'; }}
                    >
                      {opt.label}
                      {sortKey === opt.key && <Check size={11} style={{ float: 'right', marginTop: 1 }} />}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => { setShowIssuePicker(!showIssuePicker); if (!showIssuePicker) loadIssues(); }}
            title="Import issues"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 'var(--brutal-radius)',
              background: `${theme.text}08`, border: `1px solid ${theme.border}40`,
              color: `${theme.text}90`, fontSize: 11, fontWeight: 600, cursor: 'pointer',
            }}
          >
            <Download size={12} /> Issues
          </button>
          {onSendToConsole && tasks.length > 0 && (
            <button
              onClick={handleSendToConsole2}
              title="Send board to console"
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '4px 10px', borderRadius: 'var(--brutal-radius)',
                background: `${theme.accent}18`, border: `1px solid ${theme.accent}30`,
                color: theme.accent, fontSize: 11, fontWeight: 600, cursor: 'pointer',
              }}
            >
              <Send size={12} /> Console
            </button>
          )}
          {/* Issue picker dropdown */}
          {showIssuePicker && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, marginTop: 4,
              width: 360, maxHeight: 300, overflowY: 'auto',
              background: theme.bg, border: `1px solid ${theme.border}`,
              borderRadius: 'var(--brutal-radius)', boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
              zIndex: 100, padding: 6,
            }}>
              <div style={{ padding: '4px 8px', fontSize: 10, opacity: 0.5, fontWeight: 600, borderBottom: `1px solid ${theme.border}30`, marginBottom: 4 }}>
                Select issues to import as cards
              </div>
              {issueLoading && <div style={{ padding: 12, fontSize: 11, opacity: 0.5, textAlign: 'center' }}>Loading...</div>}
              {!issueLoading && issueList.length === 0 && <div style={{ padding: 12, fontSize: 11, opacity: 0.5, textAlign: 'center' }}>No issues found. Configure GitHub/Linear tokens in Settings.</div>}
              {!issueLoading && issueList.map(issue => {
                const alreadyAdded = tasks.some(t => t.title === issue.title);
                return (
                  <div
                    key={issue.id}
                    onClick={() => { if (!alreadyAdded) importIssue(issue); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '5px 8px', borderRadius: 'var(--brutal-radius)', cursor: alreadyAdded ? 'default' : 'pointer',
                      fontSize: 11, opacity: alreadyAdded ? 0.4 : 1,
                    }}
                    onMouseEnter={(e) => { if (!alreadyAdded) (e.currentTarget as HTMLElement).style.background = `${theme.accent}15`; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 'var(--brutal-radius)', background: issue.source === 'GitHub' ? '#24292e20' : '#5E6AD220', flexShrink: 0 }}>
                      {issue.source}
                    </span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.title}</span>
                    {alreadyAdded && <Check size={12} style={{ color: theme.accent, flexShrink: 0 }} />}
                  </div>
                );
              })}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4, borderTop: `1px solid ${theme.border}20`, paddingTop: 4 }}>
                <button onClick={() => setShowIssuePicker(false)}
                  style={{ padding: '2px 8px', fontSize: 10, background: `${theme.accent}20`, border: `1px solid ${theme.accent}40`, borderRadius: 'var(--brutal-radius)', color: theme.accent, cursor: 'pointer', fontWeight: 600 }}
                >Close</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Board */}
      <div style={{ flex: 1, display: 'flex', gap: 12, padding: '16px 16px', overflowX: 'auto', overflowY: 'hidden' }}>
        {KANBAN_COLUMNS.map((column) => {
          const isOver = dragOverColumn === column.id;
          const colTasks = tasksByColumn[column.id];

          return (
            <div
              key={column.id}
              data-kanban-col={column.id}
              style={{
                flex: 1, minWidth: 200, maxWidth: 340,
                display: 'flex', flexDirection: 'column',
                background: isOver ? `${theme.accent}12` : 'transparent',
                border: `1px solid ${isOver ? theme.accent : theme.border}40`,
                borderRadius: 'var(--brutal-radius)', transition: 'all 0.05s',
              }}
            >
              {/* Column Header */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px 8px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: column.color, boxShadow: `0 0 6px ${column.color}60` }} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t(COLUMN_LABEL_KEYS[column.id])}</span>
                  <span style={{ fontSize: 11, opacity: 0.4 }}>{colTasks.length}</span>
                </div>
                <button
                  onClick={() => startAdd(column.id)}
                  style={{ padding: 2, background: 'transparent', border: 'none', cursor: 'pointer', color: `${theme.text}50`, display: 'flex' }}
                  title={t('kanban.addCard')}
                >
                  <Plus size={15} />
                </button>
              </div>

              {/* Tasks */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1, padding: '0 8px 8px' }}>
                {colTasks.map((task) => {
                  const isDragging = draggingTask === task.id;
                  const isEditing = editingId === task.id;

                  return (
                    <div
                      key={task.id}
                      onPointerDown={(e) => handleCardPointerDown(e, task.id, task.title)}
                      onClick={() => {
                        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                        openDetail(task);
                      }}
                      onDoubleClick={(e) => { e.stopPropagation(); startEdit(task); }}
                      className="kanban-card"
                      style={{
                        background: `${theme.text}06`,
                        border: `1px solid ${theme.border}30`,
                        borderRadius: 'var(--brutal-radius)', padding: '12px 14px',
                        cursor: isEditing ? 'text' : 'grab',
                        opacity: isDragging ? 0.4 : 1,
                        transition: 'opacity 0.04s',
                        userSelect: isEditing ? 'auto' : 'none',
                      }}
                    >
                      {isEditing ? (
                        <input
                          ref={editRef}
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEdit();
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          style={{
                            width: '100%', background: 'transparent', border: 'none',
                            color: theme.text, fontSize: 12, outline: 'none', padding: 0,
                          }}
                        />
                      ) : (
                        <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {/* Priority dot */}
                          <div
                            onClick={(e) => { e.stopPropagation(); cyclePriority(task.id); }}
                            title={`Priority: ${task.priority}`}
                            style={{
                              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                              background: PRIORITY_COLORS[task.priority], cursor: 'pointer',
                            }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 13, lineHeight: 1.5, wordBreak: 'break-word' }}>
                              {task.title}
                            </span>
                            {/* Linked notes badges */}
                            {task.linkedNotes && task.linkedNotes.length > 0 && (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 }}>
                                {task.linkedNotes.map(np => {
                                  const note = notes?.find(n => n.path === np);
                                  return (
                                    <span
                                      key={np}
                                      onClick={(e) => { if (onOpenNote) { e.stopPropagation(); onOpenNote(np); } }}
                                      style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 3,
                                        fontSize: 9, padding: '1px 5px', borderRadius: 'var(--brutal-radius)',
                                        background: `${theme.accent}15`, color: `${theme.accent}cc`,
                                        maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                        cursor: onOpenNote ? 'pointer' : 'default',
                                      }}
                                      title={onOpenNote ? `Open note: ${np}` : np}
                                    >
                                      <FileText size={8} />{note?.title || np.split('/').pop()}
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                            {/* Due date badge (red when overdue) */}
                            {task.dueDate && (() => {
                              const overdue = task.dueDate < new Date().toISOString().slice(0, 10)
                                && task.column !== 'done' && task.column !== 'cancelled';
                              return (
                                <div style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 3,
                                  marginTop: 4, marginRight: 4, fontSize: 9, padding: '1px 5px', borderRadius: 'var(--brutal-radius)',
                                  background: overdue ? '#EF444420' : `${theme.text}10`,
                                  color: overdue ? '#EF4444' : `${theme.text}90`,
                                }}>
                                  <Clock size={8} />{task.dueDate}
                                </div>
                              );
                            })()}
                            {/* Linked gantt badge */}
                            {task.calendarEventId && (
                              <div style={{
                                display: 'inline-flex', alignItems: 'center', gap: 3,
                                marginTop: 4, fontSize: 9, padding: '1px 5px', borderRadius: 'var(--brutal-radius)',
                                background: `${theme.accent}15`, color: `${theme.accent}cc`,
                              }}>
                                <Calendar size={8} />Gantt linked
                              </div>
                            )}
                            {/* Linked project badge */}
                            {task.linkedProject && (() => {
                              const lp = projects?.find(p => p.workDir === task.linkedProject);
                              return (
                                <div style={{
                                  display: 'flex', alignItems: 'center', gap: 4,
                                  marginTop: 4, fontSize: 10, opacity: 0.6,
                                  background: `${theme.accent}10`, borderRadius: 'var(--brutal-radius)', padding: '2px 6px',
                                  maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }} title={task.linkedProject}>
                                  <FolderOpen size={10} />
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {lp ? `${lp.icon} ${lp.displayName}` : task.linkedProject.split('/').pop()}
                                  </span>
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                        {/* Action bar — always visible, below content */}
                        <div className="kanban-card-actions" style={{ display: 'flex', gap: 4, flexShrink: 0, paddingTop: 6, borderTop: `1px solid ${theme.border}20`, marginTop: 4, flexWrap: 'wrap' }}>
                          {onSendToConsole && (
                            <button onClick={(e) => { e.stopPropagation(); handleSendTaskToConsole(task); }}
                              title="Send to console"
                              style={{ padding: '4px 6px', background: `${theme.accent}15`, border: `1px solid ${theme.accent}30`, borderRadius: 'var(--brutal-radius)', cursor: 'pointer', color: theme.accent, display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 500 }}
                            ><Send size={14} /><span>Terminal</span></button>
                          )}
                          {notes && notes.length > 0 && (
                            <button onClick={(e) => { e.stopPropagation(); openNotePicker(task.id); }}
                              title="Link notes"
                              style={{ padding: '4px 6px', background: (task.linkedNotes?.length) ? `${theme.accent}15` : `${theme.text}08`, border: `1px solid ${(task.linkedNotes?.length) ? theme.accent : theme.text}25`, borderRadius: 'var(--brutal-radius)', cursor: 'pointer', color: (task.linkedNotes?.length) ? theme.accent : `${theme.text}60`, display: 'flex', alignItems: 'center', gap: 3, fontSize: 10 }}
                            ><FileText size={14} /></button>
                          )}
                          {projects && projects.length > 0 && (
                            <button onClick={(e) => { e.stopPropagation(); setLinkingTaskId(linkingTaskId === task.id ? null : task.id); }}
                              title={task.linkedProject ? 'Change project' : 'Link project'}
                              style={{ padding: '4px 6px', background: task.linkedProject ? `${theme.accent}15` : `${theme.text}08`, border: `1px solid ${task.linkedProject ? theme.accent : theme.text}25`, borderRadius: 'var(--brutal-radius)', cursor: 'pointer', color: task.linkedProject ? theme.accent : `${theme.text}60`, display: 'flex', alignItems: 'center', gap: 3, fontSize: 10 }}
                            ><FolderOpen size={14} /></button>
                          )}
                          {task.linkedProject && (
                            <button onClick={(e) => { e.stopPropagation(); handleLinkProject(task.id, undefined); }}
                              title="Unlink project"
                              style={{ padding: '4px 6px', background: '#EF444410', border: '1px solid #EF444425', borderRadius: 'var(--brutal-radius)', cursor: 'pointer', color: '#EF4444', display: 'flex', alignItems: 'center', fontSize: 10, opacity: 0.7 }}
                            ><Unlink size={14} /></button>
                          )}
                          <button onClick={(e) => { e.stopPropagation(); void linkToGantt(task); }}
                            title={task.calendarEventId ? 'Unlink from Gantt' : 'Add to Gantt'}
                            style={{ padding: '4px 6px', background: task.calendarEventId ? `${theme.accent}15` : `${theme.text}08`, border: `1px solid ${task.calendarEventId ? theme.accent : theme.text}25`, borderRadius: 'var(--brutal-radius)', cursor: 'pointer', color: task.calendarEventId ? theme.accent : `${theme.text}60`, display: 'flex', alignItems: 'center', gap: 3, fontSize: 10 }}
                          ><Calendar size={14} /></button>
                          <div style={{ flex: 1 }} />
                          <button onClick={(e) => { e.stopPropagation(); handleDelete(task.id); }}
                            style={{ padding: '3px 4px', background: '#EF444410', border: '1px solid #EF444420', borderRadius: 'var(--brutal-radius)', cursor: 'pointer', color: '#EF4444', display: 'flex', opacity: 0.7 }}
                          ><Trash2 size={16} /></button>
                        </div>
                        </>
                      )}
                      {/* Note picker dropdown */}
                      {notePickerTaskId === task.id && (
                        <div className="kanban-note-picker" onClick={(e) => e.stopPropagation()} style={{
                          marginTop: 6, background: `color-mix(in srgb, ${theme.bg} 95%, ${theme.text} 5%)`,
                          border: `1px solid ${theme.border}40`, borderRadius: 'var(--brutal-radius)',
                          padding: 4, maxHeight: 200, display: 'flex', flexDirection: 'column',
                        }}>
                          <input
                            ref={noteSearchRef}
                            value={noteSearchText}
                            onChange={(e) => setNoteSearchText(e.target.value)}
                            placeholder="Search notes..."
                            style={{
                              width: '100%', background: `${theme.text}08`, border: `1px solid ${theme.border}30`,
                              borderRadius: 'var(--brutal-radius)', padding: '4px 8px', marginBottom: 4,
                              color: theme.text, fontSize: 11, outline: 'none',
                            }}
                          />
                          <div style={{ flex: 1, overflowY: 'auto' }}>
                            {filteredNotes.length === 0 && (
                              <div style={{ padding: 8, fontSize: 11, opacity: 0.5, textAlign: 'center' }}>No notes found</div>
                            )}
                            {filteredNotes.map(note => {
                              const isLinked = task.linkedNotes?.includes(note.path);
                              return (
                                <div
                                  key={note.path}
                                  onClick={() => toggleNoteLink(task.id, note.path)}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: 6,
                                    padding: '4px 8px', borderRadius: 'var(--brutal-radius)', cursor: 'pointer', fontSize: 11,
                                    background: isLinked ? `${theme.accent}20` : 'transparent',
                                  }}
                                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${theme.accent}15`; }}
                                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = isLinked ? `${theme.accent}20` : 'transparent'; }}
                                >
                                  {isLinked ? <Check size={12} style={{ color: theme.accent, flexShrink: 0 }} /> : <FileText size={12} style={{ opacity: 0.4, flexShrink: 0 }} />}
                                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note.title}</span>
                                </div>
                              );
                            })}
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginTop: 4 }}>
                            {onCreateTaskNote && (
                              <button
                                onClick={() => { void handleCreateTaskNote(task); }}
                                disabled={creatingNoteTaskId === task.id}
                                title="Create a new note for this task and link it"
                                style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 8px', fontSize: 10, background: `${theme.text}08`, border: `1px solid ${theme.text}25`, borderRadius: 'var(--brutal-radius)', color: theme.text, cursor: 'pointer', fontWeight: 600, opacity: creatingNoteTaskId === task.id ? 0.5 : 1, marginRight: 'auto' }}
                              ><FilePlus size={11} />{creatingNoteTaskId === task.id ? 'Creating…' : 'New note'}</button>
                            )}
                            <button
                              onClick={() => setNotePickerTaskId(null)}
                              style={{ padding: '2px 8px', fontSize: 10, background: `${theme.accent}20`, border: `1px solid ${theme.accent}40`, borderRadius: 'var(--brutal-radius)', color: theme.accent, cursor: 'pointer', fontWeight: 600 }}
                            >Done</button>
                          </div>
                        </div>
                      )}
                      {/* Project link dropdown */}
                      {linkingTaskId === task.id && projects && (
                        <div onClick={(e) => e.stopPropagation()} style={{
                          marginTop: 6, background: `color-mix(in srgb, ${theme.bg} 95%, ${theme.text} 5%)`,
                          border: `1px solid ${theme.border}40`, borderRadius: 'var(--brutal-radius)',
                          padding: 4, maxHeight: 150, overflowY: 'auto',
                        }}>
                          {projects.map(p => (
                            <div
                              key={p.id}
                              onClick={() => handleLinkProject(task.id, p.workDir)}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 6,
                                padding: '5px 8px', borderRadius: 'var(--brutal-radius)', cursor: 'pointer', fontSize: 11,
                                background: task.linkedProject === p.workDir ? `${theme.accent}20` : 'transparent',
                              }}
                              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${theme.accent}15`; }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = task.linkedProject === p.workDir ? `${theme.accent}20` : 'transparent'; }}
                            >
                              <span>{p.icon}</span>
                              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.displayName}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Inline add input */}
                {addingColumn === column.id && (
                  <div style={{
                    background: `${theme.text}06`,
                    border: `1px dashed ${theme.accent}50`,
                    borderRadius: 'var(--brutal-radius)', padding: '6px 10px',
                  }}>
                    <input
                      ref={addRef}
                      value={addText}
                      onChange={(e) => setAddText(e.target.value)}
                      onBlur={commitAdd}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitAdd();
                        if (e.key === 'Escape') setAddingColumn(null);
                      }}
                      placeholder="Type and press Enter..."
                      style={{
                        width: '100%', background: 'transparent', border: 'none',
                        color: theme.text, fontSize: 12, outline: 'none', padding: 0,
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <style>{`.kanban-card-actions button:hover { opacity: 1 !important; transform: scale(1.15); }`}</style>

      {/* ── Drag ghost (follows pointer) ── */}
      {dragGhost && (
        <div style={{
          position: 'fixed', left: dragGhost.x + 14, top: dragGhost.y + 14, zIndex: 10000,
          pointerEvents: 'none', maxWidth: 240, padding: '8px 12px',
          background: theme.bg, color: theme.text, border: `1px solid ${theme.accent}`,
          borderRadius: 'var(--brutal-radius)', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{dragGhost.title}</div>
      )}

      {/* ── Task Detail Modal ── */}
      {detailTask && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={closeDetail}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: theme.bg, color: theme.text,
              border: `1px solid ${theme.border}`,
              borderRadius: 'var(--brutal-radius)', width: 520, maxWidth: '92vw', maxHeight: '80vh',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            {/* Detail Header */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '16px 20px 12px', borderBottom: `1px solid ${theme.border}30`,
            }}>
              <div
                style={{
                  width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                  background: PRIORITY_COLORS[detailTask.priority],
                }}
              />
              <span style={{ flex: 1, fontSize: 11, fontWeight: 600, opacity: 0.5 }}>
                {t(COLUMN_LABEL_KEYS[detailTask.column])} · {PRIORITY_LABELS[detailTask.priority]}
              </span>
              <button onClick={closeDetail} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: theme.text, opacity: 0.5, display: 'flex' }}>
                <X size={16} />
              </button>
            </div>

            {/* Detail Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Title */}
              <input
                value={detailTitle}
                onChange={e => setDetailTitle(e.target.value)}
                style={{
                  width: '100%', background: 'transparent',
                  border: `1px solid ${theme.border}30`, borderRadius: 'var(--brutal-radius)',
                  padding: '8px 12px', color: theme.text, fontSize: 16, fontWeight: 700,
                  outline: 'none',
                }}
                placeholder="Task title..."
              />

              {/* Description */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, opacity: 0.5, marginBottom: 6, display: 'block' }}>Description</label>
                <textarea
                  value={detailDesc}
                  onChange={e => setDetailDesc(e.target.value)}
                  rows={5}
                  style={{
                    width: '100%', background: `${theme.text}05`,
                    border: `1px solid ${theme.border}30`, borderRadius: 'var(--brutal-radius)',
                    padding: '8px 12px', color: theme.text, fontSize: 13, lineHeight: 1.6,
                    outline: 'none', resize: 'vertical', fontFamily: 'inherit',
                  }}
                  placeholder="Add description..."
                />
              </div>

              {/* Status & Priority row */}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {/* Status — full-width row; 6 columns wrap instead of overflowing */}
                <div style={{ flex: '1 1 100%', minWidth: 140 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, opacity: 0.5, marginBottom: 6, display: 'block' }}>Status</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {KANBAN_COLUMNS.map(col => (
                      <button
                        key={col.id}
                        onClick={() => detailChangeColumn(col.id)}
                        style={{
                          flex: '1 1 56px', minWidth: 0, whiteSpace: 'nowrap',
                          padding: '5px 6px', borderRadius: 'var(--brutal-radius)', fontSize: 10, fontWeight: 600,
                          cursor: 'pointer', border: 'none', transition: 'all 0.05s',
                          background: detailTask.column === col.id ? `${col.color}25` : `${theme.text}08`,
                          color: detailTask.column === col.id ? col.color : `${theme.text}60`,
                          boxShadow: detailTask.column === col.id ? `inset 0 0 0 2px ${col.color}50` : 'none',
                        }}
                      >{t(COLUMN_LABEL_KEYS[col.id])}</button>
                    ))}
                  </div>
                </div>

                {/* Priority */}
                <div style={{ flex: 1, minWidth: 120 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, opacity: 0.5, marginBottom: 6, display: 'block' }}>Priority</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['low', 'medium', 'high'] as const).map(p => (
                      <button
                        key={p}
                        onClick={() => detailChangePriority(p)}
                        style={{
                          flex: '1 1 0', minWidth: 0, whiteSpace: 'nowrap',
                          padding: '5px 6px', borderRadius: 'var(--brutal-radius)', fontSize: 10, fontWeight: 600,
                          cursor: 'pointer', border: 'none', transition: 'all 0.05s',
                          background: detailTask.priority === p ? `${PRIORITY_COLORS[p]}25` : `${theme.text}08`,
                          color: detailTask.priority === p ? PRIORITY_COLORS[p] : `${theme.text}60`,
                          boxShadow: detailTask.priority === p ? `inset 0 0 0 2px ${PRIORITY_COLORS[p]}50` : 'none',
                        }}
                      >{PRIORITY_LABELS[p]}</button>
                    ))}
                  </div>
                </div>
                <div style={{ minWidth: 130 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, opacity: 0.5, marginBottom: 6, display: 'block' }}>Due date</label>
                  <input
                    type="date"
                    value={detailTask.dueDate || ''}
                    onChange={(e) => detailChangeDueDate(e.target.value)}
                    style={{
                      width: '100%', padding: '4px 8px', borderRadius: 'var(--brutal-radius)', fontSize: 11,
                      background: `${theme.text}08`, border: `1px solid ${theme.border}30`,
                      color: theme.text, outline: 'none', colorScheme: 'dark',
                    }}
                  />
                </div>
              </div>

              {/* Linked project */}
              {detailTask.linkedProject && (
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, opacity: 0.5, marginBottom: 6, display: 'block' }}>Linked Project</label>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '6px 10px', background: `${theme.accent}10`, borderRadius: 'var(--brutal-radius)', fontSize: 12,
                  }}>
                    <FolderOpen size={13} style={{ opacity: 0.6 }} />
                    {(() => {
                      const lp = projects?.find(p => p.workDir === detailTask.linkedProject);
                      return <span>{lp ? `${lp.icon} ${lp.displayName}` : detailTask.linkedProject}</span>;
                    })()}
                  </div>
                </div>
              )}

              {/* Linked notes */}
              {detailTask.linkedNotes && detailTask.linkedNotes.length > 0 && (
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, opacity: 0.5, marginBottom: 6, display: 'block' }}>Linked Notes</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {detailTask.linkedNotes.map(np => {
                      const note = notes?.find(n => n.path === np);
                      return (
                        <div
                          key={np}
                          onClick={() => { if (onOpenNote) { onOpenNote(np); setDetailTask(null); } }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '5px 10px', background: `${theme.accent}08`, borderRadius: 'var(--brutal-radius)', fontSize: 12,
                            cursor: onOpenNote ? 'pointer' : 'default',
                          }}
                          title={onOpenNote ? `Open note: ${np}` : np}
                        >
                          <FileText size={12} style={{ opacity: 0.5 }} />
                          <span>{note?.title || np.split('/').pop()}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Gantt link */}
              {detailTask.calendarEventId && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 10px', background: `${theme.accent}08`, borderRadius: 'var(--brutal-radius)', fontSize: 12,
                }}>
                  <Calendar size={13} style={{ color: theme.accent }} />
                  <span>Gantt chart linked</span>
                </div>
              )}

              {/* Timestamps */}
              <div style={{ display: 'flex', gap: 16, fontSize: 10, opacity: 0.4, marginTop: 4 }}>
                <span><Clock size={10} style={{ marginRight: 3 }} />Created: {new Date(detailTask.createdAt).toLocaleString()}</span>
                <span><Clock size={10} style={{ marginRight: 3 }} />Updated: {new Date(detailTask.updatedAt).toLocaleString()}</span>
              </div>
            </div>

            {/* Detail Footer */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '12px 20px', borderTop: `1px solid ${theme.border}30`,
            }}>
              {onSendToConsole && (
                <button
                  onClick={() => { handleSendTaskToConsole(detailTask); closeDetail(); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '6px 12px', borderRadius: 'var(--brutal-radius)',
                    background: `${theme.accent}15`, border: `1px solid ${theme.accent}30`,
                    color: theme.accent, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  }}
                ><Send size={13} />Terminal</button>
              )}
              <button
                onClick={() => { void linkToGantt(detailTask); closeDetail(); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '6px 12px', borderRadius: 'var(--brutal-radius)',
                  background: detailTask.calendarEventId ? `${theme.accent}15` : `${theme.text}08`,
                  border: `1px solid ${detailTask.calendarEventId ? theme.accent : theme.text}25`,
                  color: detailTask.calendarEventId ? theme.accent : `${theme.text}60`,
                  fontSize: 11, fontWeight: 600, cursor: 'pointer',
                }}
              ><Calendar size={13} />{detailTask.calendarEventId ? 'Unlink Gantt' : 'Link Gantt'}</button>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => { handleDelete(detailTask.id); setDetailTask(null); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '6px 12px', borderRadius: 'var(--brutal-radius)',
                  background: '#EF444410', border: '1px solid #EF444425',
                  color: '#EF4444', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                }}
              ><Trash2 size={13} />Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
