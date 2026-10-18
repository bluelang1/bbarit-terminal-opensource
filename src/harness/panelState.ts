import type { SelectionOption, TodoItem } from '../components/harness-utils';

export function hasPendingSelectionReview(
  pendingSpecReview: unknown,
  pendingPlanReview: unknown,
): boolean {
  return !!pendingSpecReview || !!pendingPlanReview;
}

export function getSelectedOptionChips(
  options: SelectionOption[],
  selectedIds: string[],
): SelectionOption[] {
  if (!options?.length || !selectedIds?.length) return [];
  return options.filter((option) => selectedIds.includes(option.id));
}

export function getVisibleTodos(
  todos: TodoItem[],
  pendingSelectionReview: boolean,
  isStreaming: boolean,
): TodoItem[] {
  if (pendingSelectionReview || isStreaming) return [];
  return (todos || []).filter((todo) => todo.status !== 'completed');
}

export function toggleSelectionId(
  selectedIds: string[],
  targetId: string,
): string[] {
  if (!selectedIds?.length) return [targetId];
  return selectedIds.includes(targetId)
    ? selectedIds.filter((id) => id !== targetId)
    : [...selectedIds, targetId];
}

export function shouldShowFollowups(
  followups: string[],
  pendingSelectionReview: boolean,
  isStreaming: boolean,
): boolean {
  return !pendingSelectionReview && !isStreaming && followups.length > 0;
}

export function getRunnableSelectedTodos(
  todos: TodoItem[],
  selectedTodoIds: Set<string>,
): TodoItem[] {
  if (!todos?.length || !selectedTodoIds?.size) return [];
  return todos.filter((todo) => selectedTodoIds.has(todo.id) && todo.status === 'pending');
}
