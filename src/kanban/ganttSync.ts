/**
 * ganttSync.ts
 *
 * Bidirectional sync between kanban tasks and gantt/planner calendar events.
 * Kanban tasks linked to the gantt carry `calendarEventId`; the matching
 * calendar event stores the kanban task id in its `taskId` field
 * (gantt-native events use their own `PM-n` ids instead).
 *
 * Forward (kanban → gantt): App diffs kanban task changes and applies them
 * to the events in the KV store, then fires `octo-planner-refresh` so an
 * open planner panel reloads.
 * Reverse (gantt → kanban): the planner dispatches `octo-kanban-task-sync`
 * with field updates; App applies them to kanban state.
 */

import { kvGetJSON, kvSetJSON } from '../hooks/useKV';
import type { KanbanColumnId, KanbanPriority, KanbanTask } from './types';

export const KV_CALENDAR_KEY = 'octo-calendar-events';
export const PLANNER_REFRESH_EVENT = 'octo-planner-refresh';
export const KANBAN_TASK_SYNC_EVENT = 'octo-kanban-task-sync';

export type GanttStatus = 'todo' | 'in_progress' | 'done';

/** Minimal calendar-event shape shared with TodoGanttPanel. */
export interface GanttEventLite {
  id: string;
  taskId?: string;
  title: string;
  date: string;
  endDate?: string;
  color: string;
  status?: GanttStatus;
  priority?: string;
  description?: string;
  [key: string]: unknown;
}

/** Payload of the reverse-sync event dispatched by the planner. */
export interface KanbanTaskSyncDetail {
  taskId: string;
  /** Clear the task's calendarEventId (event was deleted in the planner) */
  unlink?: boolean;
  column?: KanbanColumnId;
  dueDate?: string;
  title?: string;
}

export function statusForColumn(column: KanbanColumnId): GanttStatus {
  switch (column) {
    case 'inprogress':
    case 'review':
      return 'in_progress';
    case 'done':
    case 'cancelled':
      return 'done';
    default:
      return 'todo';
  }
}

export function columnForStatus(status: GanttStatus): KanbanColumnId {
  switch (status) {
    case 'in_progress': return 'inprogress';
    case 'done': return 'done';
    default: return 'todo';
  }
}

export function colorForPriority(priority: KanbanPriority): string {
  switch (priority) {
    case 'low': return '#3b82f6';
    case 'medium': return '#f59e0b';
    case 'high': return '#ef4444';
    case 'urgent': return '#991b1b';
    default: return '#9ca3af';
  }
}

/** Gantt priority vocabulary differs from kanban's (urgent → critical). */
export function ganttPriorityForKanban(priority: KanbanPriority): string | undefined {
  switch (priority) {
    case 'urgent': return 'critical';
    case 'none': return undefined;
    default: return priority;
  }
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Build a fresh calendar event for a kanban task.
 * With a due date the bar spans today → dueDate (or sits on the due date
 * when it is already past); without one it sits on today.
 */
export function buildEventFromTask(task: KanbanTask, todayStr: string = localToday()): GanttEventLite {
  const due = (task.dueDate || '').slice(0, 10);
  const start = due && due < todayStr ? due : todayStr;
  const end = due && due > start ? due : start;
  return {
    id: `k-${Date.now().toString(36)}`,
    taskId: task.id,
    title: task.title,
    date: start,
    endDate: end,
    color: colorForPriority(task.priority),
    status: statusForColumn(task.column),
    priority: ganttPriorityForKanban(task.priority),
    description: task.description || '',
  };
}

/**
 * Apply a kanban task's current fields onto its linked event.
 * Returns the updated event, or null when nothing would change.
 */
export function applyTaskToEvent(task: KanbanTask, event: GanttEventLite): GanttEventLite | null {
  const next: GanttEventLite = { ...event };
  next.title = task.title;
  next.status = statusForColumn(task.column);
  next.color = colorForPriority(task.priority);
  next.priority = ganttPriorityForKanban(task.priority);
  next.description = task.description || '';
  const due = (task.dueDate || '').slice(0, 10);
  if (due) {
    if (due >= next.date) {
      next.endDate = due;
    } else {
      next.date = due;
      next.endDate = due;
    }
  }
  const changed =
    next.title !== event.title ||
    next.status !== event.status ||
    next.color !== event.color ||
    next.priority !== event.priority ||
    next.description !== (event.description || '') ||
    next.date !== event.date ||
    (next.endDate || '') !== (event.endDate || '');
  return changed ? next : null;
}

/**
 * Translate a planner event update into kanban task field updates.
 * Returns null when the event carries nothing the task needs.
 */
export function taskUpdatesFromEvent(
  updates: Partial<GanttEventLite>,
): Pick<KanbanTaskSyncDetail, 'column' | 'dueDate' | 'title'> | null {
  const out: Pick<KanbanTaskSyncDetail, 'column' | 'dueDate' | 'title'> = {};
  if (updates.status) out.column = columnForStatus(updates.status as GanttStatus);
  const due = updates.endDate ?? updates.date;
  if (due) out.dueDate = String(due).slice(0, 10);
  if (typeof updates.title === 'string' && updates.title.trim()) out.title = updates.title.trim();
  return Object.keys(out).length > 0 ? out : null;
}

/** True when an event's taskId refers to a kanban task (vs gantt-native PM-n ids). */
export function isKanbanLinkedEvent(event: Pick<GanttEventLite, 'taskId'>): boolean {
  return !!event.taskId && event.taskId.startsWith('task_');
}

/**
 * Diff two kanban snapshots for gantt-relevant changes.
 * Only tasks linked to an event (calendarEventId) matter.
 */
export function diffKanbanForGantt(
  prev: KanbanTask[],
  next: KanbanTask[],
): { changed: KanbanTask[]; removedEventIds: string[] } {
  const prevById = new Map(prev.map(t => [t.id, t]));
  const nextIds = new Set(next.map(t => t.id));

  const changed: KanbanTask[] = [];
  for (const task of next) {
    if (!task.calendarEventId) continue;
    const before = prevById.get(task.id);
    if (!before) { changed.push(task); continue; }
    if (
      before.title !== task.title ||
      before.column !== task.column ||
      before.priority !== task.priority ||
      (before.description || '') !== (task.description || '') ||
      (before.dueDate || '') !== (task.dueDate || '') ||
      before.calendarEventId !== task.calendarEventId
    ) {
      changed.push(task);
    }
  }

  const removedEventIds: string[] = [];
  for (const task of prev) {
    if (task.calendarEventId && !nextIds.has(task.id)) {
      removedEventIds.push(task.calendarEventId);
    }
  }

  return { changed, removedEventIds };
}

export function notifyPlannerRefresh(): void {
  try {
    window.dispatchEvent(new CustomEvent(PLANNER_REFRESH_EVENT));
  } catch { /* non-browser context */ }
}

/**
 * Apply kanban-side changes to the calendar-event KV store.
 * Returns true when the store was modified (a planner refresh was fired).
 */
export async function syncTasksToGantt(
  changed: KanbanTask[],
  removedEventIds: string[],
): Promise<boolean> {
  if (changed.length === 0 && removedEventIds.length === 0) return false;
  const events = await kvGetJSON<GanttEventLite[]>(KV_CALENDAR_KEY, []);
  let mutated = false;

  let next = events;
  if (removedEventIds.length > 0) {
    const removeSet = new Set(removedEventIds);
    next = next.filter(e => !removeSet.has(e.id));
    if (next.length !== events.length) mutated = true;
  }

  if (changed.length > 0) {
    const byEventId = new Map(changed.map(t => [t.calendarEventId as string, t]));
    next = next.map(e => {
      const task = byEventId.get(e.id);
      if (!task) return e;
      const updated = applyTaskToEvent(task, e);
      if (updated) { mutated = true; return updated; }
      return e;
    });
  }

  if (mutated) {
    await kvSetJSON(KV_CALENDAR_KEY, next);
    notifyPlannerRefresh();
  }
  return mutated;
}
