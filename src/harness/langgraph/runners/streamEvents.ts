/**
 * Shared event types for streaming LangGraph runs to the UI.
 *
 * Each event is a small, serializable snapshot of one of:
 *   - start  : run has begun
 *   - node   : a graph node just produced a partial state update
 *   - error  : an intermediate error occurred (does not always stop the run)
 *   - end    : final state (run finished)
 */
export type StreamEvent<TState = unknown> =
  | { kind: 'start'; ts: number }
  | { kind: 'node'; ts: number; node: string; update: Partial<TState> }
  | { kind: 'error'; ts: number; message: string }
  | { kind: 'end'; ts: number; state: TState; durationMs: number };

/** Simple helper to create a start event. */
export const startEvent = <T>(): StreamEvent<T> => ({ kind: 'start', ts: Date.now() });
/** node update helper. */
export const nodeEvent = <T>(node: string, update: Partial<T>): StreamEvent<T> => ({
  kind: 'node',
  ts: Date.now(),
  node,
  update,
});
export const errorEvent = <T>(message: string): StreamEvent<T> => ({
  kind: 'error',
  ts: Date.now(),
  message,
});
export const endEvent = <T>(state: T, startTs: number): StreamEvent<T> => ({
  kind: 'end',
  ts: Date.now(),
  state,
  durationMs: Date.now() - startTs,
});
