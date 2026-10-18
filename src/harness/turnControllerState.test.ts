import { describe, expect, it, vi } from 'vitest';
import {
  beginHarnessStreamingState,
  clearHarnessTurnTransientState,
  finishHarnessStreamingState,
} from './turnControllerState';

describe('turnControllerState', () => {
  it('clears transient review and error state together', () => {
    const setError = vi.fn();
    const setFollowups = vi.fn();
    const setPendingWorkflowStart = vi.fn();
    const setPendingSpecReview = vi.fn();
    const setPendingPlanReview = vi.fn();

    clearHarnessTurnTransientState({
      setError,
      setFollowups,
      setPendingWorkflowStart,
      setPendingSpecReview,
      setPendingPlanReview,
    });

    expect(setError).toHaveBeenCalledWith(null);
    expect(setFollowups).toHaveBeenCalledWith([]);
    expect(setPendingWorkflowStart).toHaveBeenCalledWith(null);
    expect(setPendingSpecReview).toHaveBeenCalledWith(null);
    expect(setPendingPlanReview).toHaveBeenCalledWith(null);
  });

  it('enters streaming mode with cleared output and reset abort flag', () => {
    const streamingThreadIdRef = { current: null as string | null };
    const abortRef = { current: true };
    const setIsStreaming = vi.fn();
    const setStreamingContent = vi.fn();
    const setStreamingThinking = vi.fn();
    const setSubTasks = vi.fn();

    beginHarnessStreamingState({
      threadId: 'thread-1',
      streamingThreadIdRef,
      abortRef,
      setIsStreaming,
      setStreamingContent,
      setStreamingThinking,
      setSubTasks,
    });

    expect(setIsStreaming).toHaveBeenCalledWith(true);
    expect(streamingThreadIdRef.current).toBe('thread-1');
    expect(setStreamingContent).toHaveBeenCalledWith('');
    expect(setStreamingThinking).toHaveBeenCalledWith('');
    expect(setSubTasks).toHaveBeenCalledWith([]);
    expect(abortRef.current).toBe(false);
  });

  it('finishes streaming mode by clearing transient stream output', () => {
    const setIsStreaming = vi.fn();
    const setStreamingContent = vi.fn();
    const setStreamingThinking = vi.fn();

    finishHarnessStreamingState({
      setIsStreaming,
      setStreamingContent,
      setStreamingThinking,
    });

    expect(setIsStreaming).toHaveBeenCalledWith(false);
    expect(setStreamingContent).toHaveBeenCalledWith('');
    expect(setStreamingThinking).toHaveBeenCalledWith('');
  });
});
