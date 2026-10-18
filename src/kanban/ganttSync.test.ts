import { describe, expect, it } from 'vitest';
import {
  applyTaskToEvent,
  buildEventFromTask,
  columnForStatus,
  diffKanbanForGantt,
  isKanbanLinkedEvent,
  statusForColumn,
  taskUpdatesFromEvent,
} from './ganttSync';
import type { GanttEventLite } from './ganttSync';
import type { KanbanTask } from './types';

function makeTask(partial: Partial<KanbanTask> & { id: string }): KanbanTask {
  return {
    title: partial.id,
    column: 'todo',
    priority: 'medium',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...partial,
  };
}

function makeEvent(partial: Partial<GanttEventLite> & { id: string }): GanttEventLite {
  return {
    taskId: 'task_1',
    title: 't',
    date: '2026-07-10',
    endDate: '2026-07-10',
    color: '#f59e0b',
    status: 'todo',
    priority: 'medium',
    description: '',
    ...partial,
  };
}

describe('status/column mapping', () => {
  it('maps kanban columns onto gantt statuses', () => {
    expect(statusForColumn('backlog')).toBe('todo');
    expect(statusForColumn('todo')).toBe('todo');
    expect(statusForColumn('inprogress')).toBe('in_progress');
    expect(statusForColumn('review')).toBe('in_progress');
    expect(statusForColumn('done')).toBe('done');
    expect(statusForColumn('cancelled')).toBe('done');
  });

  it('maps gantt statuses back to kanban columns', () => {
    expect(columnForStatus('todo')).toBe('todo');
    expect(columnForStatus('in_progress')).toBe('inprogress');
    expect(columnForStatus('done')).toBe('done');
  });
});

describe('buildEventFromTask', () => {
  it('spans today to the due date', () => {
    const ev = buildEventFromTask(
      makeTask({ id: 'task_1', dueDate: '2026-07-20' }),
      '2026-07-10',
    );
    expect(ev.date).toBe('2026-07-10');
    expect(ev.endDate).toBe('2026-07-20');
    expect(ev.taskId).toBe('task_1');
  });

  it('sits on the due date when it is already past', () => {
    const ev = buildEventFromTask(makeTask({ id: 'task_1', dueDate: '2026-07-01' }), '2026-07-10');
    expect(ev.date).toBe('2026-07-01');
    expect(ev.endDate).toBe('2026-07-01');
  });

  it('sits on today without a due date', () => {
    const ev = buildEventFromTask(makeTask({ id: 'task_1' }), '2026-07-10');
    expect(ev.date).toBe('2026-07-10');
    expect(ev.endDate).toBe('2026-07-10');
  });
});

describe('applyTaskToEvent', () => {
  it('applies column moves as status changes', () => {
    const task = makeTask({ id: 'task_1', title: 't', column: 'inprogress' });
    const updated = applyTaskToEvent(task, makeEvent({ id: 'e1' }));
    expect(updated?.status).toBe('in_progress');
  });

  it('extends the bar to a new due date', () => {
    const task = makeTask({ id: 'task_1', title: 't', dueDate: '2026-07-30' });
    const updated = applyTaskToEvent(task, makeEvent({ id: 'e1' }));
    expect(updated?.endDate).toBe('2026-07-30');
    expect(updated?.date).toBe('2026-07-10');
  });

  it('returns null when nothing changed', () => {
    const task = makeTask({ id: 'task_1', title: 't' });
    expect(applyTaskToEvent(task, makeEvent({ id: 'e1' }))).toBeNull();
  });
});

describe('taskUpdatesFromEvent', () => {
  it('translates status and end date', () => {
    expect(taskUpdatesFromEvent({ status: 'done', endDate: '2026-08-01' })).toEqual({
      column: 'done',
      dueDate: '2026-08-01',
    });
  });

  it('returns null for irrelevant updates', () => {
    expect(taskUpdatesFromEvent({ color: '#fff' })).toBeNull();
  });
});

describe('isKanbanLinkedEvent', () => {
  it('detects kanban-linked vs gantt-native events', () => {
    expect(isKanbanLinkedEvent({ taskId: 'task_123_abc' })).toBe(true);
    expect(isKanbanLinkedEvent({ taskId: 'PM-3' })).toBe(false);
    expect(isKanbanLinkedEvent({})).toBe(false);
  });
});

describe('diffKanbanForGantt', () => {
  const linked = makeTask({ id: 'task_1', calendarEventId: 'e1' });

  it('reports column/dueDate changes on linked tasks', () => {
    const moved = { ...linked, column: 'done' as const };
    const { changed } = diffKanbanForGantt([linked], [moved]);
    expect(changed.map(t => t.id)).toEqual(['task_1']);
  });

  it('ignores unlinked tasks and unchanged tasks', () => {
    const unlinked = makeTask({ id: 'task_2' });
    const { changed, removedEventIds } = diffKanbanForGantt(
      [linked, unlinked],
      [linked, { ...unlinked, column: 'done' }],
    );
    expect(changed).toEqual([]);
    expect(removedEventIds).toEqual([]);
  });

  it('reports removed linked tasks as event removals', () => {
    const { removedEventIds } = diffKanbanForGantt([linked], []);
    expect(removedEventIds).toEqual(['e1']);
  });
});
