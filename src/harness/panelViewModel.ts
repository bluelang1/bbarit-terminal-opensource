import type { Artifact, SelectionOption, TodoItem } from '../components/harness-utils';
import { getSelectedOptionChips, getVisibleTodos, hasPendingSelectionReview, shouldShowFollowups } from './panelState';

export interface ThreadLike<TMessage = { artifacts?: Artifact[] }, TTodo = TodoItem> {
  id: string;
  messages: TMessage[];
  todos: TTodo[];
}

export function collectThreadArtifacts<TMessage extends { artifacts?: Artifact[] }>(messages: TMessage[]): Artifact[] {
  return (messages || []).flatMap((message) => message.artifacts || []);
}

export function findActiveThread<TThread extends { id: string }>(
  threads: TThread[],
  activeThreadId: string | null,
): TThread | null {
  return threads.find((thread) => thread.id === activeThreadId) || null;
}

export function buildHarnessPanelViewModel<
  TMessage extends { artifacts?: Artifact[] },
  TTodo extends TodoItem,
  TThread extends ThreadLike<TMessage, TTodo>
>(params: {
  threads: TThread[];
  activeThreadId: string | null;
  pendingSpecReview: unknown;
  pendingPlanReview: { options: SelectionOption[]; selectedIds: string[] } | null;
  followups: string[];
  isStreaming: boolean;
}) {
  const activeThread = findActiveThread(params.threads, params.activeThreadId);
  const selectionPending = hasPendingSelectionReview(params.pendingSpecReview, params.pendingPlanReview);
  return {
    activeThread,
    allArtifacts: collectThreadArtifacts(activeThread?.messages || []),
    hasPendingSelectionReview: selectionPending,
    selectedPlanOptionChips: params.pendingPlanReview
      ? getSelectedOptionChips(params.pendingPlanReview.options, params.pendingPlanReview.selectedIds)
      : [],
    visibleTodos: getVisibleTodos(activeThread?.todos || [], selectionPending, params.isStreaming),
    showFollowupChips: shouldShowFollowups(params.followups, selectionPending, params.isStreaming),
  };
}
