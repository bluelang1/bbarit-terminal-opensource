import { listen, TauriEvent, type EventTarget as TauriEventTarget, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

export type NativeDragDropPayload =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' };

/**
 * Native OS drag-drop for this webview, independent of which target the
 * runtime emits to. With the `unstable` Cargo feature (src-tauri/Cargo.toml)
 * tauri-runtime-wry sends the content webview's events as WebviewEvent, which
 * only a listener with target {kind:'Webview'} receives; without it the event
 * is a synthesized window event that reaches a {kind:'Window'} listener.
 * Measured in the app (tauri 2.10.3): `getCurrentWindow().onDragDropEvent`
 * never fired, and a plain label-string target ("AnyLabel") did not match
 * either — only the explicit Webview target and an untargeted listener did.
 * Both explicit targets are registered; if a runtime ever delivers one event
 * to both, `dedupe` drops the second copy.
 */
export async function listenNativeDragDrop(handler: (payload: NativeDragDropPayload) => void): Promise<UnlistenFn> {
  const label = getCurrentWebview().label;
  const deliver = dedupe(handler);
  const targets: TauriEventTarget[] = [{ kind: 'Webview', label }, { kind: 'Window', label }];
  const unlisteners = await Promise.all(targets.flatMap((target) => [
    listen<{ paths: string[]; position: { x: number; y: number } }>(TauriEvent.DRAG_ENTER, (e) => deliver({ type: 'enter', ...e.payload }), { target }),
    listen<{ position: { x: number; y: number } }>(TauriEvent.DRAG_OVER, (e) => deliver({ type: 'over', ...e.payload }), { target }),
    listen<{ paths: string[]; position: { x: number; y: number } }>(TauriEvent.DRAG_DROP, (e) => deliver({ type: 'drop', ...e.payload }), { target }),
    listen<null>(TauriEvent.DRAG_LEAVE, () => deliver({ type: 'leave' }), { target }),
  ]));
  return () => { for (const unlisten of unlisteners) unlisten(); };
}

/** Collapse an identical payload delivered twice within a few milliseconds. */
export function dedupe(handler: (payload: NativeDragDropPayload) => void, windowMs = 30, now: () => number = () => Date.now()) {
  let lastKey = '';
  let lastAt = 0;
  return (payload: NativeDragDropPayload) => {
    const key = JSON.stringify(payload);
    const at = now();
    if (key === lastKey && at - lastAt <= windowMs) return;
    lastKey = key;
    lastAt = at;
    handler(payload);
  };
}
