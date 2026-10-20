import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  TauriEvent: { DRAG_ENTER: 'tauri://drag-enter', DRAG_OVER: 'tauri://drag-over', DRAG_DROP: 'tauri://drag-drop', DRAG_LEAVE: 'tauri://drag-leave' },
}));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ label: 'main' }) }));

import { listen } from '@tauri-apps/api/event';
import { dedupe, listenNativeDragDrop } from './nativeDragDrop';

describe('listenNativeDragDrop', () => {
  it('registers the four drag events on the explicit Webview and Window targets', async () => {
    const unlisten = await listenNativeDragDrop(() => {});
    const calls = (listen as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(8);
    const targets = calls.map((c) => JSON.stringify(c[2]?.target));
    expect(new Set(targets)).toEqual(new Set([
      JSON.stringify({ kind: 'Webview', label: 'main' }),
      JSON.stringify({ kind: 'Window', label: 'main' }),
    ]));
    // No plain-string (AnyLabel) target: measured not to match in tauri 2.10.
    expect(calls.some((c) => typeof c[2]?.target === 'string')).toBe(false);
    expect(typeof unlisten).toBe('function');
  });
});

describe('dedupe', () => {
  it('drops an identical payload delivered twice in quick succession', () => {
    let t = 1000;
    const seen: unknown[] = [];
    const deliver = dedupe((p) => seen.push(p), 30, () => t);
    const drop = { type: 'drop' as const, paths: ['/a.png'], position: { x: 1, y: 2 } };
    deliver(drop);
    t += 5;
    deliver({ ...drop });
    t += 100;
    deliver({ ...drop });
    deliver({ type: 'leave' });
    expect(seen).toHaveLength(3);
  });
});
