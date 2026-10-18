// Cross-component prompt hand-off for the makeke workspace panels (image /
// design / cowork). The gateway UI command bus opens a panel and wants the
// prompt to actually start work, but the panels are lazy-loaded and only
// mounted when their tab is active — so an event dispatched right after opening
// can miss a listener that has not attached yet.
//
// To cover both timings with one mechanism: the opener queues the prompt here
// and fires a nudge event. A panel that is already mounted drains the queue via
// the event; a panel that mounts afterwards drains it in its mount effect. The
// take is one-shot, so only one of the two paths ever consumes a given prompt.

export type PanelInjectKind = 'image' | 'design' | 'cowork' | 'marketing' | 'motion';

const INJECT_EVENT = 'bbarit-panel-inject';
const pending: Partial<Record<PanelInjectKind, string>> = {};

export function queuePanelInject(kind: PanelInjectKind, prompt: string): void {
  pending[kind] = prompt;
  try {
    window.dispatchEvent(new CustomEvent(INJECT_EVENT, { detail: { kind } }));
  } catch {
    /* window unavailable (non-DOM env) */
  }
}

export function takePanelInject(kind: PanelInjectKind): string | undefined {
  const value = pending[kind];
  delete pending[kind];
  return value;
}

// A panel subscribes with its kind and a drain callback; the callback runs once
// immediately (cold mount, prompt already queued) and again on every nudge
// (warm panel, re-injected while mounted).
export function subscribePanelInject(kind: PanelInjectKind, drain: () => void): () => void {
  drain();
  const onInject = (e: Event) => {
    if ((e as CustomEvent).detail?.kind === kind) drain();
  };
  window.addEventListener(INJECT_EVENT, onInject);
  return () => window.removeEventListener(INJECT_EVENT, onInject);
}
