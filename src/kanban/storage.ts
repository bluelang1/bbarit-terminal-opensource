/**
 * 칸반 보드 데이터 저장/로드
 * 프로젝트별로 KV store에 저장
 */

import type { KanbanBoard, KanbanTask } from './types';
import { kvSet, kvGet } from '../hooks/useKV';
import { getCollabHandle } from '../collab/CollabPanel';

const STORAGE_KEY_PREFIX = 'octo-kanban-board-v1';

function getStorageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}:${projectId}`;
}

export async function loadKanbanBoard(projectId: string): Promise<KanbanBoard> {
  try {
    const key = getStorageKey(projectId);
    const raw = await kvGet(key);
    if (!raw) return { tasks: [], lastUpdated: new Date().toISOString() };
    const parsed = JSON.parse(raw) as KanbanBoard;
    return {
      tasks: parsed.tasks || [],
      lastUpdated: parsed.lastUpdated || new Date().toISOString(),
    };
  } catch {
    return { tasks: [], lastUpdated: new Date().toISOString() };
  }
}

// 내부 플래그: 원격 change를 적용 중일 때는 다시 브로드캐스트하지 않음 (echo 방지)
let suppressBroadcast = false;

export function saveKanbanBoard(projectId: string, board: KanbanBoard): void {
  try {
    const key = getStorageKey(projectId);
    const snapshot = {
      ...board,
      lastUpdated: new Date().toISOString(),
    };
    void kvSet(key, JSON.stringify(snapshot));
    // collab broadcast (except when we're applying a remote change)
    if (!suppressBroadcast) {
      const handle = getCollabHandle();
      if (handle?.isConnected()) {
        handle.sendChange('kanban', { projectId, board: snapshot });
      }
    }
  } catch {
    // ignore storage errors
  }
}

export function applyRemoteKanbanBoard(projectId: string, board: KanbanBoard): void {
  suppressBroadcast = true;
  try {
    saveKanbanBoard(projectId, board);
  } finally {
    suppressBroadcast = false;
  }
}

export function createTask(title: string, column: KanbanTask['column'], priority: KanbanTask['priority'] = 'medium', description?: string, tags?: string[]): KanbanTask {
  const now = new Date().toISOString();
  return {
    id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    title: title.trim(),
    description: description?.trim(),
    column,
    priority,
    createdAt: now,
    updatedAt: now,
    tags: tags || [],
  };
}

export function moveTask(task: KanbanTask, newColumn: KanbanTask['column']): KanbanTask {
  return {
    ...task,
    column: newColumn,
    updatedAt: new Date().toISOString(),
  };
}

export function updateTask(task: KanbanTask, updates: Partial<Omit<KanbanTask, 'id' | 'createdAt'>>): KanbanTask {
  return {
    ...task,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
}
