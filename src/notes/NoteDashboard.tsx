/**
 * NoteDashboard — Full editor-tab dashboard.
 * Shows today's tasks, upcoming calendar events, recent notes in a card grid layout.
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import {
  CheckCircle2, Circle, Clock, CalendarDays, FileText,
  Flame, ArrowRight, Plus, FolderOpen,
  FileCode, FileImage, FileVideo, FileAudio, FileSpreadsheet, Presentation,
  LayoutGrid, BarChart3, AlertCircle, ExternalLink,
  Activity, XCircle, Loader, Timer, X, Trash2, Pencil,
} from 'lucide-react';
import { kvGetJSON, kvSetJSON, kvGet } from '../hooks/useKV';
import { useTranslation } from '../i18n';
import { loadKanbanBoard } from '../kanban/storage';
import type { KanbanTask } from '../kanban/types';
import { KANBAN_COLUMNS } from '../kanban/types';
import { fetchGithubIssues, fetchGithubWorkflowRuns } from '../pm2/pm2Commands';
import './NoteDashboard.css';

/* ── Types (mirrored from CalendarPanel) ── */
type TaskStatus = 'todo' | 'in_progress' | 'done';
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
  priority?: 'low' | 'medium' | 'high';
  assignee?: string;
}

interface GithubIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  labels: { name: string; color: string }[];
  created_at: string;
  pull_request?: unknown;
}

interface GithubWorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  head_branch: string;
}

interface NoteDashboardProps {
  accent: string;
  textColor?: string;
  noteIndex: { path: string; title: string; modifiedAt: string; tags: string[]; excerpt: string }[];
  onOpenFile: (path: string) => void;
  projectName?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  openFiles?: { path: string; name: string; kind?: string }[];
  projectId?: string;
}

const KV_KEY = 'octo-calendar-events';

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default function NoteDashboard({
  accent, noteIndex, onOpenFile, projectName, openFiles, projectId,
}: NoteDashboardProps) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [quickAddTitle, setQuickAddTitle] = useState('');
  const [kanbanTasks, setKanbanTasks] = useState<KanbanTask[]>([]);
  const [ghIssues, setGhIssues] = useState<GithubIssue[]>([]);
  const [ghRuns, setGhRuns] = useState<GithubWorkflowRun[]>([]);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghError, setGhError] = useState('');
  const [ghConfigured, setGhConfigured] = useState(true);
  const [showTimeBox, setShowTimeBox] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTaskTitle, setEditingTaskTitle] = useState('');

  useEffect(() => {
    kvGetJSON<CalendarEvent[]>(KV_KEY, []).then(setEvents);
    // Load kanban
    const pid = projectId || '__global__';
    loadKanbanBoard(pid).then(b => setKanbanTasks(b.tasks));
    // Load GitHub issues + actions
    (async () => {
      const ghToken = (await kvGet('octo-github-token') || '').trim();
      const ghRepo = (await kvGet('octo-github-repo') || '').trim();
      if (!ghToken || !ghRepo) {
        setGhConfigured(false);
        return;
      }
      setGhConfigured(true);
      setGhLoading(true);
      setGhError('');
      try {
        const [issues, runs] = await Promise.all([
          fetchGithubIssues(ghToken, ghRepo, 10),
          fetchGithubWorkflowRuns(ghToken, ghRepo, 5),
        ]);
        setGhIssues((issues || []).filter((i: GithubIssue) => !i.pull_request));
        setGhRuns(runs || []);
      } catch (e: any) {
        setGhError(e?.message || t('dashboard.ghFetchFailed'));
      } finally {
        setGhLoading(false);
      }
    })();
  }, [projectId]);

  const today = fmtDate(new Date());
  const tomorrow = fmtDate(new Date(Date.now() + 86400000));

  const todayTasks = useMemo(() =>
    events.filter(e => e.date === today).sort((a, b) => {
      const sa = a.status === 'done' ? 2 : a.status === 'in_progress' ? 0 : 1;
      const sb = b.status === 'done' ? 2 : b.status === 'in_progress' ? 0 : 1;
      return sa - sb;
    }), [events, today]);

  const upcomingEvents = useMemo(() =>
    events
      .filter(e => e.date > today && e.date <= fmtDate(new Date(Date.now() + 14 * 86400000)))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 8),
    [events, today]);

  const overdueEvents = useMemo(() =>
    events
      .filter(e => e.date < today && !e.done && e.status !== 'done')
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5),
    [events, today]);

  const recentNotes = useMemo(() =>
    [...noteIndex]
      .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
      .slice(0, 10),
    [noteIndex]);

  /* ── Kanban summary ── */
  const kanbanSummary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const col of KANBAN_COLUMNS) counts[col.id] = 0;
    for (const t of kanbanTasks) counts[t.column] = (counts[t.column] || 0) + 1;
    return { counts, total: kanbanTasks.length };
  }, [kanbanTasks]);

  /* ── Gantt mini timeline (next 7 days) ── */
  const ganttWeek = useMemo(() => {
    const days: { date: string; label: string; tasks: CalendarEvent[] }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() + i * 86400000);
      const ds = fmtDate(d);
      const weekDays = [t('dashboard.sun'), t('dashboard.mon'), t('dashboard.tue'), t('dashboard.wed'), t('dashboard.thu'), t('dashboard.fri'), t('dashboard.sat')];
      days.push({
        date: ds,
        label: i === 0 ? t('dashboard.today') : i === 1 ? t('dashboard.tmr') : weekDays[d.getDay()],
        tasks: events.filter(e => {
          if (e.date === ds) return true;
          if (e.endDate && e.date <= ds && e.endDate >= ds) return true;
          return false;
        }),
      });
    }
    return days;
  }, [events]);

  const doneCount = todayTasks.filter(e => e.status === 'done' || e.done).length;
  const totalCount = todayTasks.length;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const cycleStatus = async (ev: CalendarEvent) => {
    const order: TaskStatus[] = ['todo', 'in_progress', 'done'];
    const cur = ev.status || 'todo';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    const updated = events.map(e =>
      e.id === ev.id ? { ...e, status: next, done: next === 'done' } : e
    );
    setEvents(updated);
    await kvSetJSON(KV_KEY, updated);
  };

  const statusIcon = (ev: CalendarEvent, size = 14) => {
    const s = ev.status || (ev.done ? 'done' : 'todo');
    if (s === 'done') return <CheckCircle2 size={size} style={{ color: '#22c55e' }} />;
    if (s === 'in_progress') return <Flame size={size} style={{ color: '#3b82f6' }} />;
    return <Circle size={size} style={{ opacity: 0.4 }} />;
  };

  const dayLabel = (date: string) => {
    if (date === today) return t('dashboard.today');
    if (date === tomorrow) return t('dashboard.tomorrow');
    const d = new Date(date + 'T00:00:00');
    const days = [
      t('dashboard.sun'), t('dashboard.mon'),
      t('dashboard.tue'), t('dashboard.wed'),
      t('dashboard.thu'), t('dashboard.fri'),
      t('dashboard.sat')
    ];
    return `${d.getMonth() + 1}/${d.getDate()} ${days[d.getDay()]}`;
  };

  const deleteTask = async (evId: string) => {
    const updated = events.filter(e => e.id !== evId);
    setEvents(updated);
    await kvSetJSON(KV_KEY, updated);
  };

  const startEditTask = (ev: CalendarEvent) => {
    setEditingTaskId(ev.id);
    setEditingTaskTitle(ev.title);
  };

  const saveEditTask = async () => {
    if (!editingTaskId || !editingTaskTitle.trim()) {
      setEditingTaskId(null);
      return;
    }
    const updated = events.map(e =>
      e.id === editingTaskId ? { ...e, title: editingTaskTitle.trim() } : e
    );
    setEvents(updated);
    await kvSetJSON(KV_KEY, updated);
    setEditingTaskId(null);
  };

  const quickAdd = () => {
    if (!quickAddTitle.trim()) return;
    const maxNum = events.reduce((max, e) => {
      if (e.taskId) {
        const n = parseInt(e.taskId.replace(/\D/g, ''), 10);
        return n > max ? n : max;
      }
      return max;
    }, 0);
    const ev: CalendarEvent = {
      id: uid(),
      taskId: `PM-${maxNum + 1}`,
      title: quickAddTitle.trim(),
      date: today,
      color: '#3b82f6',
      done: false,
      status: 'todo',
    };
    const next = [...events, ev];
    setEvents(next);
    kvSetJSON(KV_KEY, next);
    setQuickAddTitle('');
  };

  const fileKindIcon = (kind?: string) => {
    const s = 12;
    const o = { opacity: 0.45 };
    switch (kind) {
      case 'image': return <FileImage size={s} style={o} />;
      case 'video': return <FileVideo size={s} style={o} />;
      case 'audio': return <FileAudio size={s} style={o} />;
      case 'xlsx': return <FileSpreadsheet size={s} style={o} />;
      case 'pptx': return <Presentation size={s} style={o} />;
      case 'markdown': return <FileText size={s} style={o} />;
      default: return <FileCode size={s} style={o} />;
    }
  };

  /* ── Work Overview stats ── */
  const workOverview = useMemo(() => {
    const plannerTotal = events.filter(e => e.status !== 'done' && !e.done).length;
    const plannerDone = events.filter(e => e.status === 'done' || e.done).length;
    const plannerInProgress = events.filter(e => e.status === 'in_progress').length;
    const kbTodo = kanbanTasks.filter(t => t.column === 'todo').length;
    const kbInProgress = kanbanTasks.filter(t => t.column === 'inprogress').length;
    const kbReview = kanbanTasks.filter(t => t.column === 'review').length;
    const kbDone = kanbanTasks.filter(t => t.column === 'done').length;
    const totalActive = plannerTotal + plannerInProgress + kbTodo + kbInProgress + kbReview + ghIssues.length;
    const totalDone = plannerDone + kbDone;
    const allTotal = totalActive + totalDone;
    const pct = allTotal > 0 ? Math.round((totalDone / allTotal) * 100) : 0;
    return { plannerTotal, plannerDone, plannerInProgress, kbTodo, kbInProgress, kbReview, kbDone, totalActive, totalDone, allTotal, pct, issues: ghIssues.length };
  }, [events, kanbanTasks, ghIssues]);

  const nowHour = new Date().getHours();
  const greeting = nowHour < 12 ? t('dashboard.goodMorning') : nowHour < 18 ? t('dashboard.goodAfternoon') : t('dashboard.goodEvening');

  return (
    <div className="nd-editor-dashboard">
      {/* ── Header ── */}
      <div className="nd-editor-header">
        <div className="nd-editor-greeting">
          <span className="nd-greeting-text">{greeting}</span>
          {projectName && <span className="nd-project-label">{projectName}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="nd-timebox-btn"
            onClick={() => setShowTimeBox(true)}
            style={{ color: accent }}
            title={t('dashboard.timeBoxing')}
          >
            <Timer size={14} />
          </button>
          <div className="nd-date-display">
            <CalendarDays size={14} style={{ color: accent, opacity: 0.7 }} />
            <span>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span>
          </div>
        </div>
      </div>

      {/* ── Quick Add ── */}
      <div className="nd-quick-add">
        <Plus size={13} style={{ opacity: 0.4, flexShrink: 0 }} />
        <input
          className="nd-quick-add-input"
          placeholder={t('dashboard.noTasks') + '... +'}
          value={quickAddTitle}
          onChange={e => setQuickAddTitle(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') quickAdd();
            if (e.key === 'Escape') setQuickAddTitle('');
          }}
        />
        {quickAddTitle.trim() && (
          <button className="nd-quick-add-btn" onClick={quickAdd} style={{ color: accent }}>
            {t('dashboard.add')}
          </button>
        )}
      </div>

      {/* ── Work Overview Bar ── */}
      {workOverview.allTotal > 0 && (
        <div className="nd-overview">
          <div className="nd-overview-progress">
            <div className="nd-overview-bar">
              <div className="nd-overview-bar-done" style={{ width: `${workOverview.pct}%`, background: '#22c55e' }} />
              <div className="nd-overview-bar-active" style={{ width: `${workOverview.allTotal > 0 ? ((workOverview.kbInProgress + workOverview.plannerInProgress) / workOverview.allTotal) * 100 : 0}%`, background: '#3b82f6' }} />
            </div>
            <span className="nd-overview-pct">{workOverview.pct}%</span>
          </div>
          <div className="nd-overview-stats">
            <span className="nd-overview-stat">
              <span className="nd-overview-dot" style={{ background: '#22c55e' }} />
              {t('dashboard.countDone').replace('{count}', String(workOverview.totalDone))}
            </span>
            <span className="nd-overview-stat">
              <span className="nd-overview-dot" style={{ background: '#3b82f6' }} />
              {t('dashboard.countActive').replace('{count}', String(workOverview.kbInProgress + workOverview.plannerInProgress))}
            </span>
            <span className="nd-overview-stat">
              <span className="nd-overview-dot" style={{ background: '#6B7280' }} />
              {t('dashboard.countTodo').replace('{count}', String(workOverview.kbTodo + workOverview.plannerTotal))}
            </span>
            {workOverview.kbReview > 0 && (
              <span className="nd-overview-stat">
                <span className="nd-overview-dot" style={{ background: '#F59E0B' }} />
                {t('dashboard.countReview').replace('{count}', String(workOverview.kbReview))}
              </span>
            )}
            {workOverview.issues > 0 && (
              <span className="nd-overview-stat">
                <span className="nd-overview-dot" style={{ background: '#f97316' }} />
                {t('dashboard.countIssues').replace('{count}', String(workOverview.issues))}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Cards Grid ── */}
      <div className="nd-cards-grid">
        {/* ── Today's Tasks Card ── */}
        <div className="nd-card nd-card-tasks">
          <div className="nd-card-head">
            <CalendarDays size={13} style={{ color: accent }} />
            <span>{t('dashboard.todayTasks')}</span>
            {totalCount > 0 && (
              <span className="nd-badge" style={{ background: accent }}>{doneCount}/{totalCount}</span>
            )}
          </div>
          {totalCount > 0 && (
            <div className="nd-progress-bar">
              <div className="nd-progress-fill" style={{ width: `${progress}%`, background: accent }} />
            </div>
          )}
          {todayTasks.length === 0 ? (
            <div className="nd-card-empty">{t('dashboard.noTasks')}</div>
          ) : (
            <div className="nd-card-list">
              {todayTasks.map(ev => (
                <div
                  key={ev.id}
                  className={`nd-task-row ${ev.status === 'done' || ev.done ? 'done' : ''}`}
                  style={{ position: 'relative' }}
                >
                  <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }} onClick={() => cycleStatus(ev)}>
                    {statusIcon(ev)}
                    {editingTaskId === ev.id ? (
                      <input
                        value={editingTaskTitle}
                        onChange={e => setEditingTaskTitle(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void saveEditTask(); if (e.key === 'Escape') setEditingTaskId(null); }}
                        onBlur={() => void saveEditTask()}
                        onClick={e => e.stopPropagation()}
                        autoFocus
                        style={{
                          flex: 1, background: 'transparent', border: `1px solid ${accent}40`,
                          borderRadius: 'var(--brutal-radius)', padding: '1px 4px', color: 'inherit', fontSize: 'inherit',
                          outline: 'none', minWidth: 0,
                        }}
                      />
                    ) : (
                      <span className="nd-task-title">{ev.title}</span>
                    )}
                    {ev.startTime && ev.startTime !== 'All day' && (
                      <span className="nd-task-time">{ev.startTime}</span>
                    )}
                    {ev.taskId && <span className="nd-task-id">{ev.taskId}</span>}
                  </div>
                  {editingTaskId !== ev.id && (
                    <div className="nd-task-actions" style={{ display: 'flex', gap: 2, marginLeft: 4, opacity: 0, flexShrink: 0 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); startEditTask(ev); }}
                        style={{ padding: 2, background: 'transparent', border: 'none', cursor: 'pointer', color: accent, display: 'flex', opacity: 0.6 }}
                        title={t('dashboard.edit')}
                      ><Pencil size={12} /></button>
                      <button
                        onClick={(e) => { e.stopPropagation(); void deleteTask(ev.id); }}
                        style={{ padding: 2, background: 'transparent', border: 'none', cursor: 'pointer', color: '#ef4444', display: 'flex', opacity: 0.6 }}
                        title={t('common.delete')}
                      ><Trash2 size={12} /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Kanban Summary Card ── */}
        {kanbanSummary.total > 0 && (
          <div className="nd-card nd-card-kanban">
            <div className="nd-card-head">
              <LayoutGrid size={13} style={{ color: accent }} />
              <span>Kanban</span>
              <span className="nd-badge" style={{ background: accent }}>{kanbanSummary.total}</span>
            </div>
            <div className="nd-kanban-cols">
              {KANBAN_COLUMNS.map(col => (
                <div key={col.id} className="nd-kanban-col">
                  <div className="nd-kanban-col-count" style={{ color: col.color }}>{kanbanSummary.counts[col.id] || 0}</div>
                  <div className="nd-kanban-col-label">{col.title}</div>
                  <div className="nd-kanban-col-bar">
                    <div
                      className="nd-kanban-col-bar-fill"
                      style={{
                        height: `${kanbanSummary.total > 0 ? ((kanbanSummary.counts[col.id] || 0) / kanbanSummary.total) * 100 : 0}%`,
                        background: col.color,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            {kanbanTasks.filter(t => t.column !== 'done').length > 0 && (
              <div className="nd-card-list" style={{ marginTop: 4 }}>
                {kanbanTasks
                  .filter(t => t.column !== 'done')
                  .sort((a, b) => {
                    const order = { inprogress: 0, review: 1, todo: 2 } as Record<string, number>;
                    return (order[a.column] ?? 3) - (order[b.column] ?? 3);
                  })
                  .slice(0, 6)
                  .map(t => {
                    const colMeta = KANBAN_COLUMNS.find(c => c.id === t.column);
                    return (
                      <div key={t.id} className="nd-task-row">
                        {t.column === 'inprogress' ? <Flame size={12} style={{ color: '#3B82F6', flexShrink: 0 }} />
                          : t.column === 'review' ? <Clock size={12} style={{ color: '#F59E0B', flexShrink: 0 }} />
                          : <Circle size={12} style={{ opacity: 0.3, flexShrink: 0 }} />}
                        <span className="nd-task-title">{t.title}</span>
                        <span className="nd-task-id" style={{ color: colMeta?.color }}>{colMeta?.title}</span>
                        <span className="nd-task-id" style={{ color: t.priority === 'high' ? '#ef4444' : undefined }}>
                          {t.priority}
                        </span>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        )}

        {/* ── Gantt Week Overview Card ── */}
        {events.length > 0 && (
          <div className="nd-card nd-card-gantt">
            <div className="nd-card-head">
              <BarChart3 size={13} style={{ color: accent }} />
              <span>Gantt</span>
            </div>
            <div className="nd-gantt-week">
              {ganttWeek.map(day => {
                return (
                  <div key={day.date} className={`nd-gantt-day ${day.date === today ? 'today' : ''}`}>
                    <div className="nd-gantt-day-bars">
                      {day.tasks.slice(0, 5).map((t, i) => (
                        <div
                          key={i}
                          className="nd-gantt-day-bar"
                          style={{ background: t.color || accent }}
                          title={t.title}
                        />
                      ))}
                      {day.tasks.length === 0 && <div className="nd-gantt-day-empty" />}
                    </div>
                    <div className="nd-gantt-day-count" style={day.tasks.length > 0 ? { opacity: 0.8 } : undefined}>
                      {day.tasks.length || ''}
                    </div>
                    <div className={`nd-gantt-day-label ${day.date === today ? 'today' : ''}`}>
                      {day.label}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── GitHub Card (Issues + Actions) ── */}
        <div className="nd-card nd-card-issues">
          <div className="nd-card-head">
            <AlertCircle size={13} style={{ color: '#f97316' }} />
            <span>GitHub</span>
            {ghLoading && <Loader size={11} style={{ opacity: 0.4, animation: 'spin 1s linear infinite' }} />}
            {ghIssues.length > 0 && (
              <span className="nd-badge" style={{ background: '#f97316' }}>{ghIssues.length}</span>
            )}
          </div>

          {!ghConfigured && (
            <div className="nd-card-empty" style={{ opacity: 0.4, fontSize: 11 }}>
              {t('dashboard.ghConnectHint')}
            </div>
          )}

          {ghError && (
            <div className="nd-task-row" style={{ color: '#ef4444', fontSize: 11 }}>
              <XCircle size={12} style={{ flexShrink: 0 }} />
              <span className="nd-task-title">{ghError}</span>
            </div>
          )}

          {/* Actions Runs */}
          {ghRuns.length > 0 && (
            <>
              <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 }}>
                Actions
              </div>
              <div className="nd-card-list">
                {ghRuns.slice(0, 4).map(run => {
                  const isRunning = run.status === 'in_progress' || run.status === 'queued';
                  const isSuccess = run.conclusion === 'success';
                  const isFail = run.conclusion === 'failure';
                  const runColor = isRunning ? '#3b82f6' : isSuccess ? '#22c55e' : isFail ? '#ef4444' : '#94a3b8';
                  return (
                    <div
                      key={run.id}
                      className="nd-note-row"
                      onClick={() => window.open(run.html_url, '_blank')}
                    >
                      {isRunning ? (
                        <Loader size={12} style={{ color: runColor, flexShrink: 0, animation: 'spin 1s linear infinite' }} />
                      ) : isSuccess ? (
                        <CheckCircle2 size={12} style={{ color: runColor, flexShrink: 0 }} />
                      ) : isFail ? (
                        <XCircle size={12} style={{ color: runColor, flexShrink: 0 }} />
                      ) : (
                        <Activity size={12} style={{ color: runColor, flexShrink: 0 }} />
                      )}
                      <span className="nd-note-name">{run.name}</span>
                      <span className="nd-task-id">{run.head_branch}</span>
                      <span className="nd-task-time">{relTime(run.created_at)}</span>
                      <ExternalLink size={10} className="nd-note-arrow" />
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Issues */}
          {ghIssues.length > 0 && (
            <>
              <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: ghRuns.length > 0 ? 6 : 2 }}>
                {t('dashboard.openIssues')}
              </div>
              <div className="nd-card-list">
                {ghIssues.slice(0, 6).map(issue => (
                  <div
                    key={issue.number}
                    className="nd-note-row"
                    onClick={() => window.open(issue.html_url, '_blank')}
                  >
                    <AlertCircle size={12} style={{ color: '#f97316', opacity: 0.6, flexShrink: 0 }} />
                    <span className="nd-note-name">
                      <span style={{ opacity: 0.4, marginRight: 4 }}>#{issue.number}</span>
                      {issue.title}
                    </span>
                    {issue.labels?.slice(0, 2).map(lb => (
                      <span
                        key={lb.name}
                        className="nd-note-tag"
                        style={{ background: `#${lb.color}33`, color: `#${lb.color}` }}
                      >
                        {lb.name}
                      </span>
                    ))}
                    <ExternalLink size={10} className="nd-note-arrow" />
                  </div>
                ))}
              </div>
            </>
          )}

          {ghConfigured && !ghLoading && ghIssues.length === 0 && ghRuns.length === 0 && !ghError && (
            <div className="nd-card-empty">{t('dashboard.noIssuesOrActions')}</div>
          )}
        </div>

        {/* ── Open Files Card ── */}
        {openFiles && openFiles.length > 0 && (
          <div className="nd-card nd-card-openfiles">
            <div className="nd-card-head">
              <FolderOpen size={13} style={{ color: accent }} />
              <span>{t('dashboard.openFiles')}</span>
              <span className="nd-badge" style={{ background: accent }}>{openFiles.length}</span>
            </div>
            <div className="nd-card-list">
              {openFiles.map(f => (
                <div
                  key={f.path}
                  className="nd-note-row"
                  onClick={() => onOpenFile(f.path)}
                >
                  {fileKindIcon(f.kind)}
                  <span className="nd-note-name">{f.name}</span>
                  <span className="nd-task-time">{f.path.replace(/^.*[/\\]/, '').length < f.path.length ? f.path.split(/[/\\]/).slice(-2, -1)[0] : ''}</span>
                  <ArrowRight size={10} className="nd-note-arrow" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Overdue Card ── */}
        {overdueEvents.length > 0 && (
          <div className="nd-card nd-card-overdue">
            <div className="nd-card-head">
              <Clock size={13} style={{ color: '#ef4444' }} />
              <span style={{ color: '#ef4444' }}>{t('dashboard.overdue')}</span>
              <span className="nd-badge" style={{ background: '#ef4444' }}>{overdueEvents.length}</span>
            </div>
            <div className="nd-card-list">
              {overdueEvents.map(ev => (
                <div key={ev.id} className="nd-task-row" onClick={() => cycleStatus(ev)}>
                  {statusIcon(ev)}
                  <span className="nd-task-title">{ev.title}</span>
                  <span className="nd-task-time" style={{ color: '#ef4444' }}>{dayLabel(ev.date)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Upcoming Card ── */}
        {upcomingEvents.length > 0 && (
          <div className="nd-card nd-card-upcoming">
            <div className="nd-card-head">
              <Clock size={13} style={{ color: accent }} />
              <span>{t('dashboard.upcoming')}</span>
            </div>
            <div className="nd-card-list">
              {upcomingEvents.map(ev => (
                <div key={ev.id} className="nd-upcoming-row">
                  <span className="nd-upcoming-date">{dayLabel(ev.date)}</span>
                  <span className="nd-upcoming-dot" style={{ background: ev.color || accent }} />
                  <span className="nd-upcoming-title">{ev.title}</span>
                  {ev.startTime && ev.startTime !== 'All day' && (
                    <span className="nd-task-time">{ev.startTime}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Recent Notes Card ── */}
        {recentNotes.length > 0 && (
          <div className="nd-card nd-card-notes">
            <div className="nd-card-head">
              <FileText size={13} style={{ color: accent }} />
              <span>{t('dashboard.recentNotes')}</span>
            </div>
            <div className="nd-card-list">
              {recentNotes.map(note => (
                <div
                  key={note.path}
                  className="nd-note-row"
                  onClick={() => onOpenFile(note.path)}
                >
                  <span className="nd-note-name">{note.title || note.path.split('/').pop()?.replace(/\.md$/, '')}</span>
                  {note.tags.length > 0 && (
                    <span className="nd-note-tags">
                      {note.tags.slice(0, 2).map(tag => (
                        <span key={tag} className="nd-note-tag">#{tag}</span>
                      ))}
                    </span>
                  )}
                  <span className="nd-note-time">{relTime(note.modifiedAt)}</span>
                  <ArrowRight size={10} className="nd-note-arrow" />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {showTimeBox && (
        <TimeBoxModal accent={accent} onClose={() => setShowTimeBox(false)} />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   TimeBoxModal — Elon Musk style time boxing
   5-min block scheduling for the day
   ═══════════════════════════════════════════ */

const TB_KV_KEY = 'octo-timebox-blocks';
const TB_CAT_KV_KEY = 'octo-timebox-categories';
const BLOCK_MINUTES = 5;
const DAY_START_HOUR = 5;
const DAY_END_HOUR = 24;

interface TimeBoxCategory {
  id: string;
  label: string;
  color: string;
}

const DEFAULT_CATEGORIES: TimeBoxCategory[] = [
  { id: 'deep', label: 'Deep Work', color: '#3b82f6' },
  { id: 'design', label: 'Design Review', color: '#06b6d4' },
  { id: 'meeting', label: 'Meeting', color: '#f97316' },
  { id: 'email', label: 'Email / Comms', color: '#8b5cf6' },
  { id: 'meal', label: 'Meal', color: '#22c55e' },
  { id: 'exercise', label: 'Exercise', color: '#ef4444' },
  { id: 'travel', label: 'Travel', color: '#64748b' },
  { id: 'learning', label: 'Learning', color: '#eab308' },
  { id: 'media', label: 'Media / Press', color: '#a855f7' },
  { id: 'family', label: 'Family', color: '#ec4899' },
  { id: 'sleep', label: 'Sleep / Rest', color: '#334155' },
];

interface TimeBlock {
  start: number; // block index
  end: number;   // block index (exclusive)
  category: string;
  label?: string;
}

interface TimeBoxData {
  date: string;
  blocks: TimeBlock[];
}

function TimeBoxModal({ accent, onClose }: { accent: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [data, setData] = useState<TimeBoxData>({ date: '', blocks: [] });
  const [categories, setCategories] = useState<TimeBoxCategory[]>(DEFAULT_CATEGORIES);
  const [activeCat, setActiveCat] = useState(DEFAULT_CATEGORIES[0].id);
  const [painting, setPainting] = useState(false);
  const [editBlock, setEditBlock] = useState<TimeBlock | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [showAddCat, setShowAddCat] = useState(false);
  const [newCatLabel, setNewCatLabel] = useState('');
  const [newCatColor, setNewCatColor] = useState('#3b82f6');
  const [editingCat, setEditingCat] = useState<string | null>(null);
  const [editCatLabel, setEditCatLabel] = useState('');
  const [editCatColor, setEditCatColor] = useState('#3b82f6');
  const gridRef = useRef<HTMLDivElement>(null);
  const today = fmtDate(new Date());

  useEffect(() => {
    kvGetJSON<Record<string, TimeBoxData>>(TB_KV_KEY, {}).then(all => {
      setData(all[today] || { date: today, blocks: [] });
    });
    kvGetJSON<TimeBoxCategory[]>(TB_CAT_KV_KEY, []).then(saved => {
      if (saved && saved.length > 0) setCategories(saved);
    });
  }, []);

  const persist = (next: TimeBoxData) => {
    setData(next);
    kvGetJSON<Record<string, TimeBoxData>>(TB_KV_KEY, {}).then(all => {
      all[today] = next;
      kvSetJSON(TB_KV_KEY, all);
    });
  };

  const blockToTime = (idx: number) => {
    const totalMin = DAY_START_HOUR * 60 + idx * BLOCK_MINUTES;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  const getBlockAt = (idx: number) => data.blocks.find(b => idx >= b.start && idx < b.end);
  const getCatColor = (catId: string) => categories.find(c => c.id === catId)?.color || '#64748b';

  const handleMouseDown = (idx: number) => {
    const existing = getBlockAt(idx);
    if (existing) {
      setEditBlock(existing);
      setEditLabel(existing.label || '');
      return;
    }
    setPainting(true);
    const block: TimeBlock = { start: idx, end: idx + 1, category: activeCat };
    persist({ ...data, blocks: [...data.blocks, block] });
  };

  const handleMouseEnter = (idx: number) => {
    if (!painting) return;
    const last = data.blocks[data.blocks.length - 1];
    if (!last || last.category !== activeCat) return;
    if (getBlockAt(idx) && !(idx >= last.start && idx < last.end)) return;
    const newEnd = Math.max(last.end, idx + 1);
    const newStart = Math.min(last.start, idx);
    const updated = [...data.blocks];
    updated[updated.length - 1] = { ...last, start: newStart, end: newEnd };
    persist({ ...data, blocks: updated });
  };

  const handleMouseUp = () => setPainting(false);

  const deleteBlock = (block: TimeBlock) => {
    persist({ ...data, blocks: data.blocks.filter(b => b !== block) });
    setEditBlock(null);
  };

  const saveBlockLabel = () => {
    if (!editBlock) return;
    const updated = data.blocks.map(b =>
      b === editBlock ? { ...b, label: editLabel.trim() || undefined } : b
    );
    persist({ ...data, blocks: updated });
    setEditBlock(null);
  };

  const clearAll = () => persist({ date: today, blocks: [] });

  const addCategory = () => {
    if (!newCatLabel.trim()) return;
    const id = newCatLabel.trim().toLowerCase().replace(/\s+/g, '_') + '_' + Date.now().toString(36);
    const next = [...categories, { id, label: newCatLabel.trim(), color: newCatColor }];
    setCategories(next);
    kvSetJSON(TB_CAT_KV_KEY, next);
    setActiveCat(id);
    setNewCatLabel('');
    setShowAddCat(false);
  };

  const removeCategory = (catId: string) => {
    const next = categories.filter(c => c.id !== catId);
    if (next.length === 0) return;
    setCategories(next);
    kvSetJSON(TB_CAT_KV_KEY, next);
    if (activeCat === catId) setActiveCat(next[0].id);
    // Also remove blocks using this category
    const updatedBlocks = data.blocks.filter(b => b.category !== catId);
    if (updatedBlocks.length !== data.blocks.length) {
      persist({ ...data, blocks: updatedBlocks });
    }
  };

  const startEditCategory = (cat: TimeBoxCategory) => {
    setEditingCat(cat.id);
    setEditCatLabel(cat.label);
    setEditCatColor(cat.color);
  };

  const saveEditCategory = () => {
    if (!editingCat || !editCatLabel.trim()) return;
    const next = categories.map(c =>
      c.id === editingCat ? { ...c, label: editCatLabel.trim(), color: editCatColor } : c
    );
    setCategories(next);
    kvSetJSON(TB_CAT_KV_KEY, next);
    setEditingCat(null);
  };

  // Build hour markers
  const hours: number[] = [];
  for (let h = DAY_START_HOUR; h < DAY_END_HOUR; h++) hours.push(h);

  // Stats
  const catMinutes: Record<string, number> = {};
  for (const b of data.blocks) {
    const mins = (b.end - b.start) * BLOCK_MINUTES;
    catMinutes[b.category] = (catMinutes[b.category] || 0) + mins;
  }
  const totalScheduled = Object.values(catMinutes).reduce((a, b) => a + b, 0);

  // Current time indicator
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowBlock = (nowMin - DAY_START_HOUR * 60) / BLOCK_MINUTES;

  return (
    <div className="tb-modal-overlay" onMouseUp={handleMouseUp} onClick={onClose}>
      <div className="tb-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="tb-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Timer size={16} style={{ color: accent }} />
            <span className="tb-title">{t('dashboard.timeBoxing')}</span>
            <span className="tb-date">{new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button className="tb-clear-btn" onClick={clearAll}>{t('dashboard.clear')}</button>
            <button className="tb-close-btn" onClick={onClose}><X size={14} /></button>
          </div>
        </div>

        {/* Category palette */}
        <div className="tb-palette">
          {categories.map(cat => (
            <div key={cat.id} style={{ display: 'flex', alignItems: 'center', gap: 0, position: 'relative' }}>
              {editingCat === cat.id ? (
                <div className="tb-add-cat-form" style={{ gap: 4 }}>
                  <input
                    className="tb-add-cat-input"
                    value={editCatLabel}
                    onChange={e => setEditCatLabel(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveEditCategory(); if (e.key === 'Escape') setEditingCat(null); }}
                    autoFocus
                    style={{ width: 80 }}
                  />
                  <input
                    type="color"
                    value={editCatColor}
                    onChange={e => setEditCatColor(e.target.value)}
                    className="tb-add-cat-color"
                  />
                  <button className="tb-add-cat-ok" onClick={saveEditCategory} style={{ color: accent, fontSize: 10 }}>{t('dashboard.ok')}</button>
                  <button className="tb-add-cat-ok" onClick={() => setEditingCat(null)} style={{ color: '#94a3b8', fontSize: 10 }}>✕</button>
                </div>
              ) : (
                <button
                  className={`tb-cat-btn ${activeCat === cat.id ? 'active' : ''}`}
                  style={{
                    '--cat-color': cat.color,
                    borderColor: activeCat === cat.id ? cat.color : 'transparent',
                  } as React.CSSProperties}
                  onClick={() => setActiveCat(cat.id)}
                  onDoubleClick={() => startEditCategory(cat)}
                  title={t('dashboard.catBtnHint')}
                >
                  <span className="tb-cat-dot" style={{ background: cat.color }} />
                  <span>{cat.label}</span>
                  {activeCat === cat.id && categories.length > 1 && (
                    <span
                      onClick={(e) => { e.stopPropagation(); removeCategory(cat.id); }}
                      style={{ marginLeft: 2, fontSize: 9, opacity: 0.5, cursor: 'pointer', lineHeight: 1 }}
                      title={t('dashboard.deleteCategory')}
                    >✕</span>
                  )}
                </button>
              )}
            </div>
          ))}
          {showAddCat ? (
            <div className="tb-add-cat-form">
              <input
                className="tb-add-cat-input"
                placeholder={t('dashboard.categoryName')}
                value={newCatLabel}
                onChange={e => setNewCatLabel(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addCategory(); if (e.key === 'Escape') setShowAddCat(false); }}
                autoFocus
              />
              <input
                type="color"
                value={newCatColor}
                onChange={e => setNewCatColor(e.target.value)}
                className="tb-add-cat-color"
              />
              <button className="tb-add-cat-ok" onClick={addCategory} style={{ color: accent }}>+</button>
            </div>
          ) : (
            <button className="tb-cat-btn" onClick={() => setShowAddCat(true)} style={{ opacity: 0.3 }}>
              <Plus size={10} />
              <span>{t('dashboard.add')}</span>
            </button>
          )}
        </div>

        {/* Time grid */}
        <div className="tb-grid-wrap" ref={gridRef}>
          <div className="tb-grid">
            {hours.map(h => {
              const blocksInHour = 60 / BLOCK_MINUTES;
              const startIdx = (h - DAY_START_HOUR) * blocksInHour;
              return (
                <div key={h} className="tb-hour-row">
                  <div className="tb-hour-label">{String(h).padStart(2, '0')}</div>
                  <div className="tb-hour-cells">
                    {Array.from({ length: blocksInHour }, (_, i) => {
                      const idx = startIdx + i;
                      const block = getBlockAt(idx);
                      const isNow = Math.floor(nowBlock) === idx;
                      const isStart = block && block.start === idx;
                      const isEnd = block && block.end === idx + 1;
                      return (
                        <div
                          key={idx}
                          className={`tb-cell ${block ? 'filled' : ''} ${isNow ? 'now' : ''} ${isStart ? 'block-start' : ''} ${isEnd ? 'block-end' : ''}`}
                          style={block ? {
                            background: getCatColor(block.category),
                            opacity: 0.8,
                          } : undefined}
                          onMouseDown={() => handleMouseDown(idx)}
                          onMouseEnter={() => handleMouseEnter(idx)}
                          title={block ? `${blockToTime(block.start)}–${blockToTime(block.end)} ${block.label || categories.find(c => c.id === block.category)?.label || ''}` : blockToTime(idx)}
                        >
                          {isStart && block?.label && (
                            <span className="tb-cell-label">{block.label}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Stats bar */}
        <div className="tb-stats">
          <span className="tb-stats-total">{t('dashboard.scheduledTotal').replace('{h}', String(Math.floor(totalScheduled / 60))).replace('{m}', String(totalScheduled % 60))}</span>
          <div className="tb-stats-cats">
            {categories.filter(c => catMinutes[c.id]).map(c => (
              <span key={c.id} className="tb-stats-cat">
                <span className="tb-cat-dot" style={{ background: c.color }} />
                {Math.floor((catMinutes[c.id] || 0) / 60)}h{(catMinutes[c.id] || 0) % 60 > 0 ? ` ${(catMinutes[c.id] || 0) % 60}m` : ''}
              </span>
            ))}
          </div>
        </div>

        {/* Edit block popover */}
        {editBlock && (
          <div className="tb-edit-overlay" onClick={() => setEditBlock(null)}>
            <div className="tb-edit-pop" onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>
                {blockToTime(editBlock.start)} – {blockToTime(editBlock.end)}
              </div>
              <input
                className="tb-edit-input"
                placeholder={t('dashboard.labelBlock')}
                value={editLabel}
                onChange={e => setEditLabel(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveBlockLabel(); if (e.key === 'Escape') setEditBlock(null); }}
                autoFocus
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button className="tb-edit-save" onClick={saveBlockLabel} style={{ background: accent }}>{t('common.save')}</button>
                <button className="tb-edit-del" onClick={() => deleteBlock(editBlock)}><Trash2 size={12} /> {t('common.delete')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
