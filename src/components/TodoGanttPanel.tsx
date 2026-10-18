import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft, ChevronRight, X, Plus, Trash2,
  Clock, CheckCircle2, Circle, AlertCircle, Search,
  ArrowRight, Link2, Unlink, GripVertical, ChevronDown, FileText
} from 'lucide-react';
import { kvGetJSON, kvSetJSON } from '../hooks/useKV';
import {
  KANBAN_TASK_SYNC_EVENT, PLANNER_REFRESH_EVENT, isKanbanLinkedEvent, taskUpdatesFromEvent,
} from '../kanban/ganttSync';
import { getCollabHandle } from '../collab/CollabPanel';
import './TodoGanttPanel.css';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type TaskStatus = 'todo' | 'in_progress' | 'done';
type Priority = 'low' | 'medium' | 'high' | 'critical';
type ZoomLevel = 'day' | 'week' | 'month';
type GroupBy = 'none' | 'status' | 'priority' | 'assignee';

interface CalendarEvent {
  id: string;
  taskId?: string;
  title: string;
  date: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  description?: string;
  color: string;
  done?: boolean;
  status?: TaskStatus;
  priority?: Priority;
  assignee?: string;
  dependencies?: string[];
  collapsed?: boolean;
  parentId?: string;
  progress?: number;
  labels?: string[];
  projectId?: string;
}

interface ProjectInfo {
  id: string;
  name: string;
  displayName: string;
  icon: string;
}

interface TodoGanttPanelProps {
  onClose: () => void;
  style: { bg: string; text: string; accent: string };
  initialView?: 'todo' | 'gantt' | 'month' | 'week';
  projects?: ProjectInfo[];
  /** Open a note in the editor (kanban-linked events surface their task's notes) */
  onOpenNote?: (path: string) => void;
  /** Linked notes of a kanban task, for kanban-linked events */
  kanbanTaskNotes?: (taskId: string) => { path: string; title: string }[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const KV_KEY = 'octo-calendar-events';
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COLOR_PRESETS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#3b82f6', '#8b5cf6', '#ec4899', '#64748b',
];

const STATUS_META: Record<TaskStatus, { label: string; color: string; bg: string }> = {
  todo:        { label: 'TODO',        color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
  in_progress: { label: 'IN PROGRESS', color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
  done:        { label: 'DONE',        color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
};

const PRIORITY_META: Record<Priority, { label: string; color: string; weight: number }> = {
  critical: { label: 'Critical', color: '#dc2626', weight: 0 },
  high:     { label: 'High',     color: '#ef4444', weight: 1 },
  medium:   { label: 'Medium',   color: '#f59e0b', weight: 2 },
  low:      { label: 'Low',      color: '#22c55e', weight: 3 },
};

const ZOOM_META: Record<ZoomLevel, { dayWidth: number; label: string }> = {
  day:   { dayWidth: 44, label: 'Day' },
  week:  { dayWidth: 22, label: 'Week' },
  month: { dayWidth: 10, label: 'Month' },
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000);
}
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function getEffectiveStatus(ev: CalendarEvent): TaskStatus {
  return ev.status || (ev.done ? 'done' : 'todo');
}
function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const TodoGanttPanel: React.FC<TodoGanttPanelProps> = ({ onClose, style, projects = [], onOpenNote, kanbanTaskNotes }) => {
  const today = useMemo(() => new Date(), []);
  const todayStr = useMemo(() => fmtDate(today), [today]);

  /* ---------- state ---------- */
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [cursor, setCursor] = useState(() => new Date(today));
  const [selectedDate, setSelectedDate] = useState(todayStr);

  // editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // gantt add
  const [ganttAddTitle, setGanttAddTitle] = useState('');
  const ganttAddRef = useRef<HTMLInputElement>(null);

  // quick add (schedule)
  const [scheduleAddTitle, setScheduleAddTitle] = useState('');
  const [scheduleAddTime, setScheduleAddTime] = useState('');
  const [showScheduleAdd, setShowScheduleAdd] = useState(false);
  const scheduleAddRef = useRef<HTMLInputElement>(null);

  // gantt features
  const [zoom, setZoom] = useState<ZoomLevel>('week');
  const [searchQuery, setSearchQuery] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null);
  const [taskListWidth, setTaskListWidth] = useState(280);
  const [ganttHoverIdx, setGanttHoverIdx] = useState(-1);
  const [linkingFrom, setLinkingFrom] = useState<string | null>(null);

  // refs
  const overlayRef = useRef<HTMLDivElement>(null);
  const leftBodyRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const timelineRightRef = useRef<HTMLDivElement>(null);
  const hasAutoScrolled = useRef(false);

  // drag state
  const dragRef = useRef<{
    type: 'move' | 'resize-l' | 'resize-r';
    eventId: string; startX: number;
    origDate: string; origEndDate: string; dayWidth: number;
    didDrag?: boolean;
  } | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  /* ---------- persistence ---------- */

  useEffect(() => { kvGetJSON<CalendarEvent[]>(KV_KEY, []).then(setEvents); }, []);

  // Reload when the kanban side (or the command bus) rewrites the event store
  useEffect(() => {
    const handler = () => {
      if (dragRef.current) return; // don't clobber an in-progress drag
      void kvGetJSON<CalendarEvent[]>(KV_KEY, []).then(setEvents);
    };
    window.addEventListener(PLANNER_REFRESH_EVENT, handler);
    return () => window.removeEventListener(PLANNER_REFRESH_EVENT, handler);
  }, []);

  const applyingRemoteRef = useRef(false);
  const persist = useCallback((next: CalendarEvent[]) => {
    setEvents(next);
    kvSetJSON(KV_KEY, next);
    if (applyingRemoteRef.current) return;
    const h = getCollabHandle();
    if (h?.isConnected()) h.sendChange('planner', next);
  }, []);

  // Reverse sync: mirror planner edits onto the linked kanban task
  const syncEventToKanban = useCallback((ev: CalendarEvent | undefined, updates: Partial<CalendarEvent>) => {
    if (!ev || !isKanbanLinkedEvent(ev)) return;
    const taskUpdates = taskUpdatesFromEvent(updates);
    if (!taskUpdates) return;
    window.dispatchEvent(new CustomEvent(KANBAN_TASK_SYNC_EVENT, { detail: { taskId: ev.taskId, ...taskUpdates } }));
  }, []);

  // Subscribe to remote planner changes
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let poll: number | null = null;
    const attach = () => {
      const h = getCollabHandle();
      if (!h) return false;
      unsub = h.subscribe((change) => {
        if (change.kind !== 'planner' || !Array.isArray(change.payload)) return;
        applyingRemoteRef.current = true;
        setEvents(change.payload as CalendarEvent[]);
        kvSetJSON(KV_KEY, change.payload);
        setTimeout(() => { applyingRemoteRef.current = false; }, 50);
      });
      return true;
    };
    if (!attach()) {
      poll = window.setInterval(() => {
        if (attach() && poll !== null) { window.clearInterval(poll); poll = null; }
      }, 800);
    }
    return () => {
      if (unsub) unsub();
      if (poll !== null) window.clearInterval(poll);
    };
  }, []);

  /* ---------- keyboard ---------- */

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (detailEvent) setDetailEvent(null);
        else if (editingId) setEditingId(null);
        else if (linkingFrom) setLinkingFrom(null);
        else onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, editingId, detailEvent, linkingFrom]);

  useEffect(() => { if (editingId && editInputRef.current) editInputRef.current.focus(); }, [editingId]);
  useEffect(() => { if (showScheduleAdd && scheduleAddRef.current) scheduleAddRef.current.focus(); }, [showScheduleAdd]);

  /* ---------- scroll sync ---------- */

  useEffect(() => {
    const left = leftBodyRef.current;
    const right = timelineBodyRef.current;
    if (!left || !right) return;
    let syncing = false;
    const syncL = () => { if (!syncing) { syncing = true; right.scrollTop = left.scrollTop; syncing = false; } };
    const syncR = () => { if (!syncing) { syncing = true; left.scrollTop = right.scrollTop; syncing = false; } };
    left.addEventListener('scroll', syncL);
    right.addEventListener('scroll', syncR);
    return () => { left.removeEventListener('scroll', syncL); right.removeEventListener('scroll', syncR); };
  });

  /* ---------- timeline wheel scroll to shift date range ---------- */

  useEffect(() => {
    const el = timelineRightRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // horizontal scroll (trackpad or shift+wheel)
      const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
      if (Math.abs(dx) < 2 && !e.shiftKey) return; // let vertical scroll pass through

      e.preventDefault();
      const newLeft = el.scrollLeft + dx;

      // If scrolled near the right edge, shift cursor forward
      if (newLeft >= el.scrollWidth - el.clientWidth - 20) {
        const step = zoom === 'day' ? 7 : zoom === 'week' ? 14 : 30;
        setCursor(prev => { const d = new Date(prev); d.setDate(d.getDate() + step); return d; });
      }
      // If scrolled near the left edge, shift cursor backward
      else if (newLeft <= 20) {
        const step = zoom === 'day' ? 7 : zoom === 'week' ? 14 : 30;
        setCursor(prev => { const d = new Date(prev); d.setDate(d.getDate() - step); return d; });
      }
      else {
        el.scrollLeft = newLeft;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom]);

  /* ---------- auto-scroll to today ---------- */

  useEffect(() => {
    if (hasAutoScrolled.current) return;
    const timer = setTimeout(() => {
      const el = timelineRightRef.current;
      if (!el) return;
      const DAY_W = ZOOM_META[zoom].dayWidth;
      const off = daysBetween(fmtDate(ganttRange.start), todayStr);
      el.scrollLeft = Math.max(0, off * DAY_W - el.clientWidth / 3);
      hasAutoScrolled.current = true;
    }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- bar drag ---------- */

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      if (Math.abs(e.clientX - drag.startX) > 3) drag.didDrag = true;
      if (!drag.didDrag) return;
      const daysDelta = Math.round((e.clientX - drag.startX) / drag.dayWidth);
      const origStart = parseDate(drag.origDate);
      const origEnd = parseDate(drag.origEndDate);
      if (drag.type === 'move') {
        setEvents(prev => prev.map(ev => ev.id === drag.eventId
          ? { ...ev, date: fmtDate(addDays(origStart, daysDelta)), endDate: fmtDate(addDays(origEnd, daysDelta)) } : ev));
      } else if (drag.type === 'resize-l') {
        const ns = fmtDate(addDays(origStart, daysDelta));
        if (ns <= drag.origEndDate) setEvents(prev => prev.map(ev => ev.id === drag.eventId ? { ...ev, date: ns } : ev));
      } else {
        const ne = fmtDate(addDays(origEnd, daysDelta));
        if (ne >= drag.origDate) setEvents(prev => prev.map(ev => ev.id === drag.eventId ? { ...ev, endDate: ne } : ev));
      }
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (drag) {
        if (!drag.didDrag) {
          // Pure click (no drag) — open detail panel
          const ev = events.find(x => x.id === drag.eventId);
          if (ev) setDetailEvent(ev);
        } else {
          kvSetJSON(KV_KEY, events);
          // Drag committed new dates — mirror onto the linked kanban task
          const ev = events.find(x => x.id === drag.eventId);
          if (ev) syncEventToKanban(ev, { date: ev.date, endDate: ev.endDate });
        }
        dragRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [events]);

  /* ---------- task list resize ---------- */

  useEffect(() => {
    const onMove = (e: MouseEvent) => { const r = resizeRef.current; if (!r) return; e.preventDefault(); setTaskListWidth(clamp(r.startWidth + (e.clientX - r.startX), 200, 500)); };
    const onUp = () => { if (resizeRef.current) { resizeRef.current = null; document.body.style.cursor = ''; document.body.style.userSelect = ''; } };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  /* ---------- navigation ---------- */

  const goPrev = () => setCursor(prev => {
    const d = new Date(prev);
    if (zoom === 'day') d.setDate(d.getDate() - 7);
    else if (zoom === 'week') d.setDate(d.getDate() - 14);
    else d.setMonth(d.getMonth() - 1);
    return d;
  });
  const goNext = () => setCursor(prev => {
    const d = new Date(prev);
    if (zoom === 'day') d.setDate(d.getDate() + 7);
    else if (zoom === 'week') d.setDate(d.getDate() + 14);
    else d.setMonth(d.getMonth() + 1);
    return d;
  });
  /* ---------- mini calendar month ---------- */

  const monthDays = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const startDay = first.getDay();
    const start = new Date(first);
    start.setDate(start.getDate() - startDay);
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(d.getDate() + i); days.push(d); }
    return days;
  }, [cursor]);

  /* ---------- gantt range ---------- */

  const ganttRange = useMemo(() => {
    const rangeMonths = zoom === 'month' ? 6 : zoom === 'week' ? 4 : 3;
    const half = Math.floor(rangeMonths / 2);
    const startMonth = new Date(cursor.getFullYear(), cursor.getMonth() - half, 1);
    const endMonth = new Date(cursor.getFullYear(), cursor.getMonth() + (rangeMonths - half), 0);
    const days: Date[] = [];
    const d = new Date(startMonth);
    while (d <= endMonth) { days.push(new Date(d)); d.setDate(d.getDate() + 1); }
    const months: { label: string; year: number; days: Date[] }[] = [];
    for (const day of days) {
      const key = `${day.getFullYear()}-${day.getMonth()}`;
      const last = months[months.length - 1];
      if (last && `${last.days[0].getFullYear()}-${last.days[0].getMonth()}` === key) { last.days.push(day); }
      else months.push({ label: day.toLocaleString('en-US', { month: 'short' }).toUpperCase(), year: day.getFullYear(), days: [day] });
    }
    return { days, months, start: startMonth, end: endMonth };
  }, [cursor, zoom]);

  /* ---------- filtering ---------- */

  const filteredEvents = useMemo(() => {
    if (!searchQuery.trim()) return events;
    const q = searchQuery.toLowerCase();
    return events.filter(ev =>
      ev.title.toLowerCase().includes(q) || (ev.taskId?.toLowerCase().includes(q)) ||
      (ev.description?.toLowerCase().includes(q)) || (ev.assignee?.toLowerCase().includes(q)));
  }, [events, searchQuery]);

  /* ---------- events by date ---------- */

  const eventsByDate = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    for (const ev of events) { (map[ev.date] ??= []).push(ev); }
    for (const arr of Object.values(map)) arr.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    return map;
  }, [events]);

  /* ---------- stats ---------- */

  const stats = useMemo(() => {
    let todo = 0, inProgress = 0, done = 0, overdue = 0;
    for (const ev of events) {
      const s = getEffectiveStatus(ev);
      if (s === 'done') done++;
      else if (s === 'in_progress') inProgress++;
      else { todo++; if ((ev.endDate || ev.date) < todayStr) overdue++; }
    }
    return { total: events.length, todo, inProgress, done, overdue };
  }, [events, todayStr]);

  /* ---------- gantt grouping ---------- */

  const groupedGanttEvents = useMemo(() => {
    const gEnd = fmtDate(ganttRange.end), gStart = fmtDate(ganttRange.start);
    let evts = filteredEvents.filter(ev => { const end = ev.endDate || ev.date; return ev.date <= gEnd && end >= gStart; });
    evts.sort((a, b) => {
      const order: Record<string, number> = { in_progress: 0, todo: 1, done: 2 };
      const c = (order[getEffectiveStatus(a)] ?? 1) - (order[getEffectiveStatus(b)] ?? 1);
      return c || a.date.localeCompare(b.date) || a.title.localeCompare(b.title);
    });
    if (groupBy === 'none') return [{ label: '', events: evts }];
    const groups = new Map<string, CalendarEvent[]>();
    for (const ev of evts) {
      let key: string;
      if (groupBy === 'status') key = getEffectiveStatus(ev);
      else if (groupBy === 'priority') key = ev.priority || 'none';
      else key = ev.assignee || 'Unassigned';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(ev);
    }
    const sorted: { label: string; events: CalendarEvent[] }[] = [];
    if (groupBy === 'status') {
      for (const s of ['in_progress', 'todo', 'done'] as TaskStatus[]) { if (groups.has(s)) sorted.push({ label: STATUS_META[s].label, events: groups.get(s)! }); }
    } else if (groupBy === 'priority') {
      for (const p of ['critical', 'high', 'medium', 'low', 'none']) {
        if (groups.has(p)) sorted.push({ label: p === 'none' ? 'No Priority' : PRIORITY_META[p as Priority].label, events: groups.get(p)! });
      }
    } else {
      for (const [k, v] of groups) sorted.push({ label: k, events: v });
    }
    return sorted;
  }, [filteredEvents, ganttRange, groupBy]);

  const flatGanttEvents = useMemo(() => {
    const flat: { ev: CalendarEvent; groupLabel?: string; isGroupHeader?: boolean }[] = [];
    for (const g of groupedGanttEvents) {
      if (groupBy !== 'none') flat.push({ ev: {} as CalendarEvent, groupLabel: g.label, isGroupHeader: true });
      for (const ev of g.events) flat.push({ ev });
    }
    return flat;
  }, [groupedGanttEvents, groupBy]);

  /* ---------- event CRUD ---------- */

  const nextTaskNum = useCallback(() => {
    let max = 0;
    for (const ev of events) { if (ev.taskId) { const n = parseInt(ev.taskId.replace(/\D/g, ''), 10); if (n > max) max = n; } }
    return max + 1;
  }, [events]);

  const addEvent = (date: string, title: string, opts?: {
    startTime?: string; endTime?: string; color?: string; endDate?: string;
    status?: TaskStatus; priority?: Priority;
  }) => {
    if (!title.trim()) return undefined;
    const created: CalendarEvent = {
      id: uid(), taskId: `PM-${nextTaskNum()}`, title: title.trim(), date,
      endDate: opts?.endDate, startTime: opts?.startTime, endTime: opts?.endTime,
      color: opts?.color || COLOR_PRESETS[4], done: false, status: opts?.status || 'todo',
      priority: opts?.priority, dependencies: [], progress: 0,
    };
    persist([...events, created]);
    return created;
  };

  const updateEvent = (id: string, updates: Partial<CalendarEvent>) => {
    persist(events.map(e => e.id === id ? { ...e, ...updates } : e));
    if (detailEvent?.id === id) setDetailEvent({ ...detailEvent, ...updates });
    syncEventToKanban(events.find(e => e.id === id), updates);
  };

  const deleteEvent = (id: string) => {
    const target = events.find(e => e.id === id);
    persist(events.filter(e => e.id !== id).map(e => e.dependencies?.includes(id) ? { ...e, dependencies: e.dependencies.filter(d => d !== id) } : e));
    if (detailEvent?.id === id) setDetailEvent(null);
    if (target && isKanbanLinkedEvent(target)) {
      window.dispatchEvent(new CustomEvent(KANBAN_TASK_SYNC_EVENT, { detail: { taskId: target.taskId, unlink: true } }));
    }
  };

  const addDependency = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    persist(events.map(e => e.id === toId ? { ...e, dependencies: [...new Set([...(e.dependencies || []), fromId])] } : e));
  };

  const removeDependency = (fromId: string, toId: string) => {
    persist(events.map(e => e.id === toId ? { ...e, dependencies: (e.dependencies || []).filter(d => d !== fromId) } : e));
  };

  const submitEdit = () => {
    if (!editingId || !editTitle.trim()) return;
    updateEvent(editingId, { title: editTitle.trim() });
    setEditingId(null); setEditTitle('');
  };

  const startBarDrag = (e: React.MouseEvent, id: string, type: 'move' | 'resize-l' | 'resize-r') => {
    e.stopPropagation(); e.preventDefault();
    const ev = events.find(x => x.id === id);
    if (!ev) return;
    dragRef.current = { type, eventId: id, startX: e.clientX, origDate: ev.date, origEndDate: ev.endDate || ev.date, dayWidth: ZOOM_META[zoom].dayWidth, didDrag: false };
    document.body.style.cursor = type === 'move' ? 'grabbing' : 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const startTaskListResize = (e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startWidth: taskListWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  /* ---------- derived ---------- */

  const headerLabel = useMemo(() => {
    if (zoom === 'day') {
      const s = ganttRange.start;
      const e = ganttRange.end;
      const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
      return `${fmt(s)} – ${fmt(e)}, ${e.getFullYear()}`;
    }
    if (zoom === 'week') {
      const s = ganttRange.start;
      const e = ganttRange.end;
      const fmtM = (d: Date) => d.toLocaleString('en-US', { month: 'short' });
      return `${fmtM(s)} – ${fmtM(e)} ${e.getFullYear()}`;
    }
    return cursor.toLocaleString('en-US', { year: 'numeric', month: '2-digit' }).replace(/(\d+)\/(\d+)/, '$2. $1');
  }, [cursor, zoom, ganttRange]);
  const cssVars = {
    '--tgd-bg': style.bg, '--tgd-text': style.text, '--tgd-accent': style.accent,
  } as React.CSSProperties;

  /* ================================================================ */
  /*  RENDER: Mini Calendar                                           */
  /* ================================================================ */

  const renderMiniCalendar = () => (
    <div className="tgd-mini-cal">
      <div className="tgd-mini-cal-nav">
        <button onClick={goPrev}><ChevronLeft size={13} /></button>
        <span className="tgd-mini-cal-label">
          {cursor.getFullYear()}. {String(cursor.getMonth() + 1).padStart(2, '0')}
        </span>
        <button onClick={goNext}><ChevronRight size={13} /></button>
      </div>
      <div className="tgd-mini-cal-weekdays">
        {WEEKDAYS_SHORT.map((w, i) => (
          <span key={w} className={i === 0 ? 'sun' : i === 6 ? 'sat' : ''}>{w}</span>
        ))}
      </div>
      <div className="tgd-mini-cal-days">
        {monthDays.map(d => {
          const key = fmtDate(d);
          const isOther = d.getMonth() !== cursor.getMonth();
          const isToday = isSameDay(d, today);
          const isSel = key === selectedDate;
          const dow = d.getDay();
          const hasEvt = (eventsByDate[key] ?? []).length > 0;
          return (
            <button
              key={key}
              className={`tgd-mcal-day${isOther ? ' other' : ''}${isToday ? ' today' : ''}${isSel ? ' sel' : ''}${dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''}`}
              onClick={() => setSelectedDate(key)}
            >
              {d.getDate()}
              {hasEvt && !isToday && <span className="tgd-mcal-dot" />}
            </button>
          );
        })}
      </div>
    </div>
  );

  /* ================================================================ */
  /*  RENDER: Schedule                                                */
  /* ================================================================ */

  /* --- all events that span across selectedDate (including multi-day) --- */
  const tasksForSelectedDate = useMemo(() => {
    return events.filter(ev => {
      const end = ev.endDate || ev.date;
      return ev.date <= selectedDate && end >= selectedDate;
    }).sort((a, b) => {
      const sa = getEffectiveStatus(a), sb = getEffectiveStatus(b);
      const order: Record<string, number> = { in_progress: 0, todo: 1, done: 2 };
      return (order[sa] ?? 1) - (order[sb] ?? 1) || a.title.localeCompare(b.title);
    });
  }, [events, selectedDate]);

  const renderSchedule = () => {
    const selDate = parseDate(selectedDate);
    const dayName = selDate.toLocaleDateString('en-US', { weekday: 'long' });

    return (
      <div className="tgd-schedule">
        <div className="tgd-schedule-header">
          <span className="tgd-schedule-title">SCHEDULE</span>
          <button className="tgd-schedule-add-btn" onClick={() => { setShowScheduleAdd(true); setScheduleAddTitle(''); setScheduleAddTime(''); }}>
            <Plus size={12} />
          </button>
        </div>
        <div className="tgd-schedule-date-info">
          <span className="tgd-schedule-date-num">{selDate.getMonth() + 1}/{selDate.getDate()}</span>
          <span className="tgd-schedule-day-name">{dayName}</span>
        </div>
        {showScheduleAdd && (
          <div className="tgd-schedule-quick-add">
            <input
              ref={scheduleAddRef}
              placeholder="New task..."
              value={scheduleAddTitle}
              onChange={e => setScheduleAddTitle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && scheduleAddTitle.trim()) {
                  addEvent(selectedDate, scheduleAddTitle, {
                    color: COLOR_PRESETS[4],
                    endDate: fmtDate(addDays(parseDate(selectedDate), 3)),
                    startTime: scheduleAddTime || undefined,
                  });
                  setScheduleAddTitle(''); setScheduleAddTime(''); setShowScheduleAdd(false);
                }
                if (e.key === 'Escape') { setShowScheduleAdd(false); setScheduleAddTitle(''); setScheduleAddTime(''); }
              }}
            />
            <select
              className="tgd-schedule-time-select"
              value={scheduleAddTime}
              onChange={e => setScheduleAddTime(e.target.value)}
            >
              <option value="">All day</option>
              {Array.from({ length: 48 }, (_, i) => {
                const h = String(Math.floor(i / 2)).padStart(2, '0');
                const m = i % 2 === 0 ? '00' : '30';
                return <option key={i} value={`${h}:${m}`}>{`${h}:${m}`}</option>;
              })}
            </select>
          </div>
        )}
        <div className="tgd-schedule-body">
          {tasksForSelectedDate.length === 0 && !showScheduleAdd && (
            <div className="tgd-schedule-empty">No tasks</div>
          )}
          {tasksForSelectedDate.map(ev => {
            const st = getEffectiveStatus(ev);
            const stMeta = STATUS_META[st];
            const progress = ev.progress ?? (st === 'done' ? 100 : st === 'in_progress' ? 50 : 0);
            return (
              <div
                key={ev.id}
                className={`tgd-schedule-card${st === 'done' ? ' done' : ''}`}
                style={{ borderLeftColor: ev.color }}
                onClick={() => setDetailEvent(ev)}
              >
                <div className="tgd-scard-top">
                  <span className="tgd-scard-dot" style={{ background: ev.color }} />
                  <span className="tgd-scard-title">{ev.title}</span>
                </div>
                <div className="tgd-scard-meta">
                  {ev.startTime && <span className="tgd-scard-time">{ev.startTime}{ev.endTime ? ` - ${ev.endTime}` : ''}</span>}
                  {!ev.startTime && <span className="tgd-scard-time">All day</span>}
                  <span className="tgd-scard-status" style={{ color: stMeta.color }}>{stMeta.label}</span>
                </div>
                {progress > 0 && progress < 100 && (
                  <div className="tgd-scard-progress">
                    <div className="tgd-scard-progress-fill" style={{ width: `${progress}%`, background: ev.color }} />
                  </div>
                )}
                {ev.assignee && <span className="tgd-scard-assignee">{ev.assignee}</span>}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  /* ================================================================ */
  /*  RENDER: Task List (Gantt left panel)                            */
  /* ================================================================ */

  const renderTaskList = () => {
    let displayIdx = 0;
    return (
      <div className="tgd-task-list" style={{ width: taskListWidth }}>
        <div className="tgd-task-list-header">
          <div className="tgd-task-list-controls">
            <div className="tgd-search-mini">
              <Search size={11} />
              <input placeholder="Search..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            </div>
            <select className="tgd-group-select" value={groupBy} onChange={e => setGroupBy(e.target.value as GroupBy)}>
              <option value="none">No Group</option>
              <option value="status">Status</option>
              <option value="priority">Priority</option>
              <option value="assignee">Assignee</option>
            </select>
          </div>
        </div>
        <div className="tgd-task-table-head">
          <span className="tgd-th-name">Task</span>
          <span className="tgd-th-dates">Period</span>
        </div>
        <div className="tgd-task-list-body" ref={leftBodyRef}>
          {flatGanttEvents.map((item, flatIdx) => {
            if (item.isGroupHeader) {
              const cnt = groupedGanttEvents.find(g => g.label === item.groupLabel)?.events.length || 0;
              return (
                <div key={`gh-${item.groupLabel}`} className="tgd-group-row" style={{ height: 32 }}>
                  <ChevronDown size={11} />
                  <span className="tgd-group-label">{item.groupLabel}</span>
                  <span className="tgd-group-count">{cnt}</span>
                </div>
              );
            }
            const ev = item.ev;
            const idx = displayIdx++;
            return (
              <div
                key={ev.id}
                className={`tgd-task-row${ganttHoverIdx === flatIdx ? ' hover' : ''}${idx % 2 === 1 ? ' striped' : ''}`}
                style={{ height: 40 }}
                onMouseEnter={() => setGanttHoverIdx(flatIdx)}
                onMouseLeave={() => setGanttHoverIdx(-1)}
                onClick={() => { if (linkingFrom && linkingFrom !== ev.id) { addDependency(linkingFrom, ev.id); setLinkingFrom(null); } }}
              >
                {ev.projectId && projects.length > 0 && (() => {
                  const proj = projects.find(p => p.id === ev.projectId);
                  return proj ? <span className="tgd-task-project-icon" title={proj.displayName || proj.name}>{proj.icon}</span> : null;
                })()}
                <span className="tgd-task-dot" style={{ background: ev.color }} />
                {editingId === ev.id ? (
                  <input ref={editInputRef} className="tgd-task-edit" value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') submitEdit(); if (e.key === 'Escape') setEditingId(null); }}
                    onBlur={submitEdit} />
                ) : (
                  <span className="tgd-task-name" onClick={() => setDetailEvent(ev)} title={ev.title}>
                    {ev.title}
                  </span>
                )}
                <span className="tgd-task-dates-cell">
                  {ev.date.slice(5)}{ev.endDate ? ` ~ ${ev.endDate.slice(5)}` : ''}
                </span>
              </div>
            );
          })}
          {/* Add row */}
          <div className="tgd-task-row tgd-add-row" style={{ height: 40 }}>
            <Plus size={11} style={{ opacity: 0.3, flexShrink: 0 }} />
            <input
              ref={ganttAddRef}
              className="tgd-add-input"
              placeholder="Add new task..."
              value={ganttAddTitle}
              onChange={e => setGanttAddTitle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && ganttAddTitle.trim()) {
                  addEvent(todayStr, ganttAddTitle, { endDate: fmtDate(addDays(today, 7)), color: COLOR_PRESETS[4] });
                  setGanttAddTitle('');
                }
              }}
            />
          </div>
        </div>
      </div>
    );
  };

  /* ================================================================ */
  /*  RENDER: Gantt Timeline                                          */
  /* ================================================================ */

  const renderTimeline = () => {
    const { days: allDays, months } = ganttRange;
    const totalDays = allDays.length;
    const ganttStartStr = fmtDate(ganttRange.start);
    const DAY_W = ZOOM_META[zoom].dayWidth;
    const ROW_H = 40;
    const BAR_H = 24;
    const BAR_Y = (ROW_H - BAR_H) / 2;
    const GROUP_H = 32;
    const timelineW = totalDays * DAY_W;
    const todayOffset = daysBetween(ganttStartStr, todayStr);
    const todayPx = todayOffset * DAY_W + DAY_W / 2;

    // Dependency arrows
    const evMap = new Map<string, CalendarEvent>();
    for (const ev of events) evMap.set(ev.id, ev);
    const depArrows: { fromX: number; fromY: number; toX: number; toY: number; color: string }[] = [];
    let ri = 0;
    const rowPos = new Map<string, number>();
    for (const item of flatGanttEvents) { if (item.isGroupHeader) { ri++; continue; } rowPos.set(item.ev.id, ri); ri++; }
    for (const item of flatGanttEvents) {
      if (item.isGroupHeader || !item.ev.dependencies?.length) continue;
      const toEv = item.ev;
      const toRow = rowPos.get(toEv.id);
      if (toRow === undefined) continue;
      for (const depId of toEv.dependencies || []) {
        const fromEv = evMap.get(depId);
        const fromRow = rowPos.get(depId);
        if (!fromEv || fromRow === undefined) continue;
        const fromX = (Math.min(totalDays - 1, daysBetween(ganttStartStr, fromEv.endDate || fromEv.date)) + 1) * DAY_W;
        const fromY = fromRow * ROW_H + ROW_H / 2;
        const toX = Math.max(0, daysBetween(ganttStartStr, toEv.date)) * DAY_W;
        const toY = toRow * ROW_H + ROW_H / 2;
        depArrows.push({ fromX, fromY, toX, toY, color: STATUS_META[getEffectiveStatus(toEv)].color });
      }
    }

    return (
      <div className="tgd-timeline" ref={timelineRightRef}>
        {/* Header: months + days */}
        <div className="tgd-tl-header" style={{ minWidth: timelineW }}>
          <div className="tgd-tl-months">
            {months.map((m, i) => (
              <div key={i} className="tgd-tl-month" style={{ width: m.days.length * DAY_W }}>
                {m.label} {m.year}
              </div>
            ))}
          </div>
          <div className="tgd-tl-days">
            {allDays.map((d, i) => {
              const dow = d.getDay();
              const isTo = fmtDate(d) === todayStr;
              const isFirst = d.getDate() === 1;
              const DOW_LABELS = ['Su','Mo','Tu','We','Th','Fr','Sa'];
              return (
                <div key={i}
                  className={`tgd-tl-day${dow === 0 || dow === 6 ? ' we' : ''}${isTo ? ' today' : ''}${isFirst ? ' month-start' : ''}`}
                  style={{ width: DAY_W }}
                >
                  {zoom === 'day' && (
                    <>
                      <span className="tgd-tl-day-dow">{DOW_LABELS[dow]}</span>
                      <span className="tgd-tl-day-num">{d.getDate()}</span>
                    </>
                  )}
                  {zoom === 'week' && <span className="tgd-tl-day-num">{d.getDate()}</span>}
                  {zoom === 'month' && d.getDate() % 5 === 1 && <span className="tgd-tl-day-num" style={{ fontSize: 8 }}>{d.getDate()}</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Body: grid + bars */}
        <div className="tgd-tl-body" ref={timelineBodyRef} style={{ minWidth: timelineW }}>
          {/* Grid lines */}
          {allDays.map((d, i) => {
            const dow = d.getDay();
            const isFirst = d.getDate() === 1;
            return <div key={`g${i}`} className={`tgd-tl-gridline${dow === 0 || dow === 6 ? ' we' : ''}${isFirst ? ' month-start' : ''}`} style={{ left: i * DAY_W, width: DAY_W }} />;
          })}

          {/* Today marker */}
          {todayOffset >= 0 && todayOffset < totalDays && (
            <div className="tgd-tl-today" style={{ left: todayPx }}>
              <div className="tgd-tl-today-head" />
            </div>
          )}

          {/* Dependency arrows */}
          {depArrows.length > 0 && (
            <svg className="tgd-tl-dep-svg" style={{ width: timelineW, height: flatGanttEvents.length * ROW_H, position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 1 }}>
              <defs>
                <marker id="tgd-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L8,3 L0,6 Z" fill="currentColor" opacity="0.5" />
                </marker>
              </defs>
              {depArrows.map((a, i) => {
                const midX = (a.fromX + a.toX) / 2;
                const path = a.fromY === a.toY
                  ? `M${a.fromX},${a.fromY} L${a.toX},${a.toY}`
                  : `M${a.fromX},${a.fromY} C${midX},${a.fromY} ${midX},${a.toY} ${a.toX},${a.toY}`;
                return <path key={i} d={path} fill="none" stroke={a.color} strokeWidth={1.5} opacity={0.35} markerEnd="url(#tgd-arrow)" style={{ color: a.color }} />;
              })}
            </svg>
          )}

          {/* Bars */}
          {(() => {
            let rowNum = 0;
            return flatGanttEvents.map((item, flatIdx) => {
              if (item.isGroupHeader) {
                rowNum++;
                return <div key={`ghb-${item.groupLabel}`} className="tgd-tl-group-stripe" style={{ height: GROUP_H, width: timelineW }} />;
              }
              const ev = item.ev;
              const curRow = rowNum++;
              const evEnd = ev.endDate || ev.date;
              const startOff = Math.max(0, daysBetween(ganttStartStr, ev.date));
              const endOff = Math.min(totalDays - 1, daysBetween(ganttStartStr, evEnd));
              const leftPx = startOff * DAY_W + 2;
              const widthPx = Math.max((endOff - startOff + 1) * DAY_W - 4, 24);
              const st = getEffectiveStatus(ev);
              const isDone = st === 'done';
              const progress = ev.progress ?? (isDone ? 100 : st === 'in_progress' ? 50 : 0);

              return (
                <div
                  key={ev.id}
                  className={`tgd-tl-bar-row${ganttHoverIdx === flatIdx ? ' hover' : ''}${curRow % 2 === 1 ? ' striped' : ''}`}
                  style={{ height: ROW_H }}
                  onMouseEnter={() => setGanttHoverIdx(flatIdx)}
                  onMouseLeave={() => setGanttHoverIdx(-1)}
                >
                  <div
                    className={`tgd-tl-bar${isDone ? ' done' : ''}${linkingFrom === ev.id ? ' linking' : ''}`}
                    style={{
                      left: leftPx, top: BAR_Y, width: widthPx, height: BAR_H,
                      '--bar-color': ev.color, '--bar-progress': `${progress}%`,
                    } as React.CSSProperties}
                    onClick={() => { if (linkingFrom) { if (linkingFrom !== ev.id) addDependency(linkingFrom, ev.id); setLinkingFrom(null); } else setDetailEvent(ev); }}
                    title={`${ev.title} (${progress}%)`}
                  >
                    <div className="tgd-tl-bar-fill" style={{ width: `${progress}%` }} />
                    <div className="tgd-tl-bar-remaining" style={{ left: `${progress}%`, width: `${100 - progress}%` }} />
                    <span className="tgd-tl-bar-text">{ev.title} {progress}%</span>
                    {/* Resize handles */}
                    <div className="tgd-tl-bar-handle l" onMouseDown={e => startBarDrag(e, ev.id, 'resize-l')} />
                    <div className="tgd-tl-bar-handle r" onMouseDown={e => startBarDrag(e, ev.id, 'resize-r')} />
                    <div className="tgd-tl-bar-move" onMouseDown={e => startBarDrag(e, ev.id, 'move')} />
                  </div>
                </div>
              );
            });
          })()}
          <div style={{ height: 40 }} />
        </div>
      </div>
    );
  };

  /* ================================================================ */
  /*  RENDER: Detail Panel                                            */
  /* ================================================================ */

  const renderDetailPanel = () => {
    if (!detailEvent) return null;
    const ev = events.find(e => e.id === detailEvent.id) || detailEvent;
    const st = getEffectiveStatus(ev);
    const durationDays = ev.endDate ? daysBetween(ev.date, ev.endDate) + 1 : 1;
    const deps = (ev.dependencies || []).map(id => events.find(e => e.id === id)).filter(Boolean) as CalendarEvent[];
    const dependents = events.filter(e => (e.dependencies || []).includes(ev.id));

    return (
      <div className="tgd-detail">
        <div className="tgd-detail-top">
          <span className="tgd-detail-id">{ev.taskId || 'No ID'}</span>
          <button className="tgd-detail-close" onClick={() => setDetailEvent(null)}><X size={14} /></button>
        </div>
        <input className="tgd-detail-title" value={ev.title} onChange={e => updateEvent(ev.id, { title: e.target.value })} />
        <div className="tgd-detail-body">
          {/* Status */}
          <div className="tgd-df">
            <label>Status</label>
            <div className="tgd-df-row">
              {(['todo', 'in_progress', 'done'] as TaskStatus[]).map(s => (
                <button key={s} className={`tgd-status-btn${st === s ? ' active' : ''}`}
                  style={{ '--sc': STATUS_META[s].color } as React.CSSProperties}
                  onClick={() => updateEvent(ev.id, { status: s, done: s === 'done', progress: s === 'done' ? 100 : s === 'in_progress' ? (ev.progress || 50) : 0 })}>
                  {s === 'done' ? <CheckCircle2 size={11} /> : s === 'in_progress' ? <Clock size={11} /> : <Circle size={11} />}
                  {STATUS_META[s].label}
                </button>
              ))}
            </div>
          </div>
          {/* Priority */}
          <div className="tgd-df">
            <label>Priority</label>
            <div className="tgd-df-row">
              {([undefined, 'low', 'medium', 'high', 'critical'] as (Priority | undefined)[]).map((p, i) => (
                <button key={i} className={`tgd-pri-btn${ev.priority === p ? ' active' : ''}`}
                  style={p ? { '--pc': PRIORITY_META[p].color } as React.CSSProperties : undefined}
                  onClick={() => updateEvent(ev.id, { priority: p })}>
                  {p ? <><span className="tgd-pri-dot" style={{ background: PRIORITY_META[p].color }} />{PRIORITY_META[p].label}</> : 'None'}
                </button>
              ))}
            </div>
          </div>
          {/* Dates */}
          <div className="tgd-df">
            <label>Period</label>
            <div className="tgd-df-dates">
              <input type="date" value={ev.date} onChange={e => { if (e.target.value) updateEvent(ev.id, { date: e.target.value }); }} />
              <ArrowRight size={12} style={{ opacity: 0.3 }} />
              <input type="date" value={ev.endDate || ev.date} onChange={e => { if (e.target.value) updateEvent(ev.id, { endDate: e.target.value }); }} />
              <span className="tgd-df-dur">{durationDays}d</span>
            </div>
          </div>
          {/* Progress */}
          <div className="tgd-df">
            <label>Progress</label>
            <div className="tgd-df-progress">
              <input type="range" min="0" max="100" step="5" value={ev.progress ?? (st === 'done' ? 100 : 0)}
                onChange={e => { const v = parseInt(e.target.value); updateEvent(ev.id, { progress: v, status: v === 100 ? 'done' : v > 0 ? 'in_progress' : 'todo', done: v === 100 }); }} />
              <span>{ev.progress ?? (st === 'done' ? 100 : 0)}%</span>
            </div>
          </div>
          {/* Project */}
          {projects.length > 0 && (
            <div className="tgd-df">
              <label>Project</label>
              <select className="tgd-df-select" value={ev.projectId || ''} onChange={e => updateEvent(ev.id, { projectId: e.target.value || undefined })}>
                <option value="">No project</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.icon} {p.displayName || p.name}</option>
                ))}
              </select>
            </div>
          )}
          {/* Assignee */}
          <div className="tgd-df">
            <label>Assignee</label>
            <input className="tgd-df-input" placeholder="Name..." value={ev.assignee || ''} onChange={e => updateEvent(ev.id, { assignee: e.target.value || undefined })} />
          </div>
          {/* Description */}
          <div className="tgd-df">
            <label>Description</label>
            <textarea className="tgd-df-textarea" placeholder="Description..." value={ev.description || ''} onChange={e => updateEvent(ev.id, { description: e.target.value || undefined })} rows={3} />
          </div>
          {/* Linked kanban task notes */}
          {isKanbanLinkedEvent(ev) && kanbanTaskNotes && (() => {
            const notes = kanbanTaskNotes(ev.taskId!);
            if (notes.length === 0) return null;
            return (
              <div className="tgd-df">
                <label>Linked Notes ({notes.length})</label>
                {notes.map(n => (
                  <div
                    key={n.path}
                    className="tgd-dep-item"
                    style={{ cursor: onOpenNote ? 'pointer' : 'default' }}
                    title={onOpenNote ? `Open note: ${n.path}` : n.path}
                    onClick={() => onOpenNote?.(n.path)}
                  >
                    <FileText size={10} /><span className="tgd-dep-title">{n.title}</span>
                  </div>
                ))}
              </div>
            );
          })()}
          {/* Dependencies */}
          <div className="tgd-df">
            <label>Dependencies ({deps.length})</label>
            {deps.map(dep => (
              <div key={dep.id} className="tgd-dep-item">
                <Link2 size={10} /><span>{dep.taskId}</span><span className="tgd-dep-title">{dep.title}</span>
                <button onClick={() => removeDependency(dep.id, ev.id)}><Unlink size={10} /></button>
              </div>
            ))}
            {dependents.length > 0 && <label style={{ marginTop: 6 }}>Blocks ({dependents.length})</label>}
            {dependents.map(dep => (
              <div key={dep.id} className="tgd-dep-item"><ArrowRight size={10} /><span>{dep.taskId}</span><span className="tgd-dep-title">{dep.title}</span></div>
            ))}
          </div>
          {/* Color */}
          <div className="tgd-df">
            <label>Color</label>
            <div className="tgd-df-colors">
              {COLOR_PRESETS.map(c => (
                <button key={c} className={`tgd-color-btn${ev.color === c ? ' active' : ''}`} style={{ background: c }} onClick={() => updateEvent(ev.id, { color: c })} />
              ))}
            </div>
          </div>
          {/* Delete */}
          <button className="tgd-detail-delete" onClick={() => deleteEvent(ev.id)}>
            <Trash2 size={12} />Delete Task
          </button>
        </div>
      </div>
    );
  };

  /* ================================================================ */
  /*  MAIN RENDER                                                     */
  /* ================================================================ */

  return createPortal(
    <div className="tgd-overlay" ref={overlayRef} style={cssVars}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}>
      <div className={`tgd-container${detailEvent ? ' has-detail' : ''}`}>
        {/* Header */}
        <div className="tgd-header">
          <span className="tgd-header-logo">Gantt Chart</span>
          <div className="tgd-header-nav">
            <button onClick={goPrev}><ChevronLeft size={14} /></button>
            <span className="tgd-header-label">{headerLabel}</span>
            <button onClick={goNext}><ChevronRight size={14} /></button>
          </div>

          {/* Stats */}
          <div className="tgd-header-stats">
            <span className="tgd-hstat"><Circle size={9} style={{ color: STATUS_META.todo.color }} /> {stats.todo}</span>
            <span className="tgd-hstat"><Clock size={9} style={{ color: STATUS_META.in_progress.color }} /> {stats.inProgress}</span>
            <span className="tgd-hstat"><CheckCircle2 size={9} style={{ color: STATUS_META.done.color }} /> {stats.done}</span>
            {stats.overdue > 0 && <span className="tgd-hstat overdue"><AlertCircle size={9} /> {stats.overdue}</span>}
          </div>

          <div style={{ flex: 1 }} />

          <div className="tgd-header-actions">
            <button className={`tgd-ha-btn${zoom === 'week' ? ' active' : ''}`} onClick={() => setZoom('week')}>Week</button>
            <button className={`tgd-ha-btn${zoom === 'month' ? ' active' : ''}`} onClick={() => setZoom('month')}>Month</button>
            <button className="tgd-ha-btn add" onClick={() => {
              const created = addEvent(todayStr, 'New task', { endDate: fmtDate(addDays(today, 7)), color: COLOR_PRESETS[4] });
              if (created) setDetailEvent(created);
            }}>
              + Task
            </button>
          </div>

          <button className="modal-close-btn" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </div>

        {/* Main content */}
        <div className="tgd-main">
          {/* Left sidebar */}
          <div className="tgd-sidebar">
            {renderMiniCalendar()}
            {renderSchedule()}
          </div>

          {/* Gantt area */}
          <div className="tgd-gantt-area">
            {renderTaskList()}
            <div className="tgd-divider" onMouseDown={startTaskListResize}>
              <GripVertical size={10} />
            </div>
            {renderTimeline()}
          </div>

          {/* Detail panel */}
          {renderDetailPanel()}
        </div>

        {/* Linking indicator */}
        {linkingFrom && (
          <div className="tgd-linking-banner">
            <Link2 size={12} /> Click target task to link dependency
            <button onClick={() => setLinkingFrom(null)}><X size={10} /></button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

export default TodoGanttPanel;
