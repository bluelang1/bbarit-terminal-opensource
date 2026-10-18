/**
 * BBARIT 내부 업무 도구 (Assistant Agent용).
 *
 * 비서 에이전트가 사용자의 Kanban, Notes, Calendar, Browser 등 내부 시스템에
 * 접근할 수 있도록 LangGraph StructuredTool로 래핑.
 *
 * 구현 방식: Tauri invoke 직접 호출 — MCP 서버 경유 없이 in-process 실행.
 * (테스트/노드 환경에서는 invoke가 없으므로 `setTauriInvoker`로 주입 가능)
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

// ── Invoker injection (테스트/비-Tauri 환경 호환) ──
type Invoker = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
let invokerImpl: Invoker | null = null;

/** Tauri invoke 주입 (앱 초기화 시 1회). 주입 안 되면 각 도구가 에러 반환. */
export function setTauriInvoker(invoker: Invoker): void {
  invokerImpl = invoker;
}

async function callTauri<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!invokerImpl) throw new Error('Tauri invoker not configured — call setTauriInvoker() first');
  return (await invokerImpl(command, args)) as T;
}

// ── KV Store 기반 리소스 읽기/쓰기 ──
const KANBAN_KEY_GLOBAL = 'octo-kanban-board-v1:__global__';
const CALENDAR_KEY = 'octo-calendar-events';

async function kvGet(key: string): Promise<string | null> {
  return (await callTauri<string | null>('kv_get', { key })) ?? null;
}
async function kvSet(key: string, value: string): Promise<void> {
  await callTauri('kv_set', { key, value });
}

// ── Kanban Tools ──

interface KanbanTaskLite {
  id: string;
  title: string;
  description?: string;
  column: 'backlog' | 'todo' | 'inprogress' | 'review' | 'done' | 'cancelled';
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  dueDate?: string;
}

async function loadKanban(): Promise<KanbanTaskLite[]> {
  const raw = await kvGet(KANBAN_KEY_GLOBAL);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch { return []; }
}

async function saveKanban(tasks: KanbanTaskLite[]): Promise<void> {
  await kvSet(KANBAN_KEY_GLOBAL, JSON.stringify({
    tasks,
    lastUpdated: new Date().toISOString(),
  }));
}

export const kanbanListTool = tool(
  async ({ column }) => {
    const tasks = await loadKanban();
    const filtered = column ? tasks.filter((t) => t.column === column) : tasks;
    return JSON.stringify(filtered.map((t) => ({
      id: t.id, title: t.title, column: t.column,
      priority: t.priority, dueDate: t.dueDate, tags: t.tags,
    })), null, 2);
  },
  {
    name: 'kanban_list',
    description: '현재 칸반 보드의 작업 목록을 조회. column으로 필터링 가능.',
    schema: z.object({
      column: z.enum(['backlog', 'todo', 'inprogress', 'review', 'done', 'cancelled'])
        .optional().describe('특정 컬럼만 조회. 생략하면 전체.'),
    }),
  },
);

export const kanbanAddTool = tool(
  async ({ title, description, column, priority, tags, dueDate }) => {
    const tasks = await loadKanban();
    const now = new Date().toISOString();
    const newTask: KanbanTaskLite = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      title: title.trim(),
      description: description?.trim(),
      column: column || 'todo',
      priority: priority || 'medium',
      tags: tags || [],
      dueDate,
      createdAt: now,
      updatedAt: now,
    };
    await saveKanban([...tasks, newTask]);
    return JSON.stringify({ ok: true, id: newTask.id, title: newTask.title });
  },
  {
    name: 'kanban_add',
    description: '새 작업을 칸반 보드에 추가.',
    schema: z.object({
      title: z.string().describe('작업 제목'),
      description: z.string().optional().describe('작업 설명'),
      column: z.enum(['backlog', 'todo', 'inprogress', 'review', 'done', 'cancelled'])
        .optional().describe('초기 컬럼 (기본 todo)'),
      priority: z.enum(['none', 'low', 'medium', 'high', 'urgent'])
        .optional().describe('우선순위 (기본 medium)'),
      tags: z.array(z.string()).optional().describe('라벨'),
      dueDate: z.string().optional().describe('마감일 (ISO yyyy-MM-dd)'),
    }),
  },
);

export const kanbanMoveTool = tool(
  async ({ id, column }) => {
    const tasks = await loadKanban();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) return JSON.stringify({ ok: false, error: `task ${id} not found` });
    tasks[idx] = { ...tasks[idx], column, updatedAt: new Date().toISOString() };
    await saveKanban(tasks);
    return JSON.stringify({ ok: true, id, column });
  },
  {
    name: 'kanban_move',
    description: '칸반 작업을 다른 컬럼으로 이동.',
    schema: z.object({
      id: z.string().describe('작업 ID'),
      column: z.enum(['backlog', 'todo', 'inprogress', 'review', 'done', 'cancelled']),
    }),
  },
);

// ── Calendar/Planner Tools ──

interface CalendarEventLite {
  id: string;
  title: string;
  date: string;
  endDate?: string;
  color: string;
  status?: string;
  description?: string;
}

async function loadCalendar(): Promise<CalendarEventLite[]> {
  const raw = await kvGet(CALENDAR_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as CalendarEventLite[]; } catch { return []; }
}

async function saveCalendar(events: CalendarEventLite[]): Promise<void> {
  await kvSet(CALENDAR_KEY, JSON.stringify(events));
}

export const calendarListTool = tool(
  async ({ fromDate, toDate }) => {
    const events = await loadCalendar();
    const filtered = events.filter((e) => {
      if (fromDate && e.date < fromDate) return false;
      if (toDate && e.date > toDate) return false;
      return true;
    });
    return JSON.stringify(filtered, null, 2);
  },
  {
    name: 'calendar_list',
    description: '캘린더/간트 이벤트 조회. 날짜 범위 필터링 가능.',
    schema: z.object({
      fromDate: z.string().optional().describe('시작 날짜 (yyyy-MM-dd)'),
      toDate: z.string().optional().describe('종료 날짜 (yyyy-MM-dd)'),
    }),
  },
);

export const calendarAddTool = tool(
  async ({ title, date, endDate, description, color }) => {
    const events = await loadCalendar();
    const newEvent: CalendarEventLite = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      title,
      date,
      endDate,
      color: color || '#3b82f6',
      description,
      status: 'todo',
    };
    await saveCalendar([...events, newEvent]);
    return JSON.stringify({ ok: true, id: newEvent.id });
  },
  {
    name: 'calendar_add',
    description: '캘린더에 새 일정/이벤트 추가.',
    schema: z.object({
      title: z.string().describe('일정 제목'),
      date: z.string().describe('시작 날짜 (yyyy-MM-dd)'),
      endDate: z.string().optional().describe('종료 날짜'),
      description: z.string().optional(),
      color: z.string().optional().describe('Hex 색상 (기본 #3b82f6)'),
    }),
  },
);

// ── Notes Tools ──

export const noteReadTool = tool(
  async ({ path }) => {
    const content = await callTauri<string>('read_file', { path });
    return content;
  },
  {
    name: 'note_read',
    description: '노트 파일 읽기 (절대 경로).',
    schema: z.object({ path: z.string().describe('파일 절대 경로') }),
  },
);

export const noteWriteTool = tool(
  async ({ path, content }) => {
    await callTauri('write_file', { path, content });
    return JSON.stringify({ ok: true, path });
  },
  {
    name: 'note_write',
    description: '노트 파일 쓰기 (덮어쓰기). 상위 디렉토리는 미리 존재해야 함.',
    schema: z.object({
      path: z.string().describe('파일 절대 경로'),
      content: z.string().describe('쓸 내용'),
    }),
  },
);

export const dirListTool = tool(
  async ({ path }) => {
    const result = await callTauri<unknown[]>('read_directory', { path });
    return JSON.stringify(result, null, 2);
  },
  {
    name: 'dir_list',
    description: '디렉토리 내용 나열.',
    schema: z.object({ path: z.string().describe('디렉토리 절대 경로') }),
  },
);

// ── Registry ──

export const BBARIT_TOOLS = [
  kanbanListTool,
  kanbanAddTool,
  kanbanMoveTool,
  calendarListTool,
  calendarAddTool,
  noteReadTool,
  noteWriteTool,
  dirListTool,
];

export function findBbaritTool(name: string) {
  return BBARIT_TOOLS.find((t) => t.name === name);
}
