/**
 * 칸반 보드 타입 정의 (Plane 스타일 확장)
 */

export type KanbanColumnId = 'backlog' | 'todo' | 'inprogress' | 'review' | 'done' | 'cancelled';
export type KanbanPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface KanbanAssignee {
  id: string;       // peer id or user id
  name: string;
  color?: string;   // avatar color
}

export interface KanbanTask {
  id: string;
  title: string;
  description?: string;
  column: KanbanColumnId;
  priority: KanbanPriority;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  /** Plane-style labels with color */
  labels?: Array<{ name: string; color: string }>;
  /** Assignees */
  assignees?: KanbanAssignee[];
  /** ISO date string (e.g. "2026-05-01") */
  dueDate?: string;
  /** Linked local project path (e.g., /Users/.../my-project) */
  linkedProject?: string;
  /** Linked note paths (absolute paths from note index) */
  linkedNotes?: string[];
  /** Linked calendar/gantt event ID */
  calendarEventId?: string;
}

export interface KanbanBoard {
  tasks: KanbanTask[];
  lastUpdated: string;
}

export interface KanbanColumn {
  id: KanbanColumnId;
  title: string;
  color: string;
}

export const KANBAN_COLUMNS: KanbanColumn[] = [
  { id: 'backlog', title: '백로그', color: '#9CA3AF' },
  { id: 'todo', title: '할 일', color: '#6B7280' },
  { id: 'inprogress', title: '진행 중', color: '#3B82F6' },
  { id: 'review', title: '검토 중', color: '#F59E0B' },
  { id: 'done', title: '완료', color: '#10B981' },
  { id: 'cancelled', title: '취소', color: '#DC2626' },
];

export const PRIORITY_COLORS: Record<KanbanPriority, string> = {
  none: '#9CA3AF',
  low: '#6B7280',
  medium: '#F59E0B',
  high: '#EF4444',
  urgent: '#991B1B',
};

export const PRIORITY_LABELS: Record<KanbanPriority, string> = {
  none: '없음',
  low: '낮음',
  medium: '중간',
  high: '높음',
  urgent: '긴급',
};
