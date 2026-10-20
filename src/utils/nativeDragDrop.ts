import { listen, TauriEvent, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

export type NativeDragDropPayload =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' };

/**
 * Native OS drag-drop for this webview, independent of which target the
 * runtime emits to. tauri-runtime-wry sends the window's content webview
 * events as WebviewEvent (webview target) when the `unstable` feature is on
 * (src-tauri/Cargo.toml) and as a synthesized window event otherwise, which
 * lands on the Window target when child webviews exist. A plain label target
 * ("AnyLabel") matches all of these, so Finder/Explorer drops keep arriving
 * if the feature set or child webviews change. Measured in the app: the
 * Window-target listener (`getCurrentWindow().onDragDropEvent`) never fired.
 */
export async function listenNativeDragDrop(handler: (payload: NativeDragDropPayload) => void): Promise<UnlistenFn> {
  const target = getCurrentWebview().label;
  const options = { target };
  const unlisteners = await Promise.all([
    listen<{ paths: string[]; position: { x: number; y: number } }>(TauriEvent.DRAG_ENTER, (e) => handler({ type: 'enter', ...e.payload }), options),
    listen<{ position: { x: number; y: number } }>(TauriEvent.DRAG_OVER, (e) => handler({ type: 'over', ...e.payload }), options),
    listen<{ paths: string[]; position: { x: number; y: number } }>(TauriEvent.DRAG_DROP, (e) => handler({ type: 'drop', ...e.payload }), options),
    listen<null>(TauriEvent.DRAG_LEAVE, () => handler({ type: 'leave' }), options),
  ]);
  return () => { for (const unlisten of unlisteners) unlisten(); };
}
