// Opens (or re-targets) the guide window. Only the main window calls this, so
// there is one place that decides when the guide appears.
import { emitTo } from '@tauri-apps/api/event';
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { currentMonitor } from '@tauri-apps/api/window';
import { GUIDE_WINDOW_LABEL, type GuideStepId } from './steps';

export interface GuideOpenOptions {
  mode: 'start' | 'whatsnew';
  step?: GuideStepId;
  /** What's new: last seen version (sections after it are shown). */
  from?: string | null;
  /** Window title (localised by the caller). */
  title?: string;
}

export interface Box { x: number; y: number; w: number; h: number }

export const GUIDE_SIZE = { w: 900, h: 620 };
const GAP = 12;

export function guideUrl(opts: Pick<GuideOpenOptions, 'mode' | 'step' | 'from'>): string {
  const q = new URLSearchParams({ mode: opts.mode });
  if (opts.step) q.set('step', opts.step);
  if (opts.from) q.set('from', opts.from);
  return `/guide?${q.toString()}`;
}

/** Logical position for the guide: right of the main window when the monitor
 *  has room, else left, else centred over the main window's right half (so a
 *  modal in the middle of the main window stays visible). */
export function placeGuideWindow(main: Box, monitor: Box, size: { w: number; h: number }): { x: number; y: number } {
  const clampX = (x: number) => Math.max(monitor.x, Math.min(x, monitor.x + monitor.w - size.w));
  const clampY = (y: number) => Math.max(monitor.y, Math.min(y, monitor.y + monitor.h - size.h));
  const y = clampY(main.y + (main.h - size.h) / 2);
  const right = main.x + main.w + GAP;
  if (right + size.w <= monitor.x + monitor.w) return { x: right, y };
  const left = main.x - GAP - size.w;
  if (left >= monitor.x) return { x: left, y };
  return { x: clampX(main.x + (main.w * 3) / 4 - size.w / 2), y };
}

async function computePosition(): Promise<{ x: number; y: number } | null> {
  try {
    const main = getCurrentWebviewWindow();
    const [pos, size, scale, mon] = await Promise.all([main.outerPosition(), main.outerSize(), main.scaleFactor(), currentMonitor()]);
    if (!mon) return null;
    const area = mon.workArea ?? { position: mon.position, size: mon.size };
    const ms = mon.scaleFactor || scale || 1;
    return placeGuideWindow(
      { x: pos.x / scale, y: pos.y / scale, w: size.width / scale, h: size.height / scale },
      { x: area.position.x / ms, y: area.position.y / ms, w: area.size.width / ms, h: area.size.height / ms },
      GUIDE_SIZE,
    );
  } catch {
    return null;
  }
}

export async function openGuideWindow(opts: GuideOpenOptions): Promise<void> {
  const nav = { mode: opts.mode, step: opts.step, from: opts.from ?? null };
  // Reuse a live window: focus it and tell it where to go. A closed window can
  // leave a stale handle (see openToolWindow in App.tsx), so probe it first.
  try {
    const existing = await WebviewWindow.getByLabel(GUIDE_WINDOW_LABEL);
    if (existing) {
      try {
        await existing.isVisible();
        await existing.show();
        await existing.unminimize().catch(() => {});
        await existing.setFocus();
        await emitTo(GUIDE_WINDOW_LABEL, 'guide-navigate', nav);
        return;
      } catch {
        try { await existing.close(); } catch { /* already gone */ }
      }
    }
  } catch { /* not found */ }

  const pos = await computePosition();
  const w = new WebviewWindow(GUIDE_WINDOW_LABEL, {
    url: `${window.location.origin}${guideUrl(opts)}`,
    title: opts.title ?? 'BBARIT',
    width: GUIDE_SIZE.w,
    height: GUIDE_SIZE.h,
    minWidth: 640,
    minHeight: 480,
    ...(pos ? { x: Math.round(pos.x), y: Math.round(pos.y) } : { center: true }),
    resizable: true,
    decorations: true,
    maximized: false,
    focus: true,
  });
  w.once('tauri://error', (e) => { console.error('[guide] window error:', e); });
}
