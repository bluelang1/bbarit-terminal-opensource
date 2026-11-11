// Width of the left project panel (resizable by dragging its right edge).
// Pure helpers so the clamp rules are unit-tested; App.tsx owns the state.

export const PROJECT_PANEL_DEFAULT_WIDTH = 260;
export const PROJECT_PANEL_MIN_WIDTH = 180;
export const PROJECT_PANEL_MAX_WIDTH = 520;
export const KV_KEY_PROJECT_PANEL_WIDTH = 'octo-project-panel-width';

/**
 * Clamp a panel width to [180, 520] px and to half the window width.
 * The minimum wins when half the window is smaller than it. A non-finite
 * width falls back to the default; a missing/broken window width is ignored.
 */
export function clampProjectPanelWidth(width: number, viewportWidth?: number): number {
  const base = Number.isFinite(width) ? width : PROJECT_PANEL_DEFAULT_WIDTH;
  let max = PROJECT_PANEL_MAX_WIDTH;
  if (typeof viewportWidth === 'number' && Number.isFinite(viewportWidth) && viewportWidth > 0) {
    max = Math.min(max, Math.floor(viewportWidth / 2));
  }
  return Math.max(PROJECT_PANEL_MIN_WIDTH, Math.min(max, Math.round(base)));
}

/**
 * Restore a saved width string to the absolute limits (180-520 px); nothing
 * saved or garbage -> default. The half-window cap is deliberately not applied
 * here: it is display-only (CSS max-width: 50vw) and used while dragging, so
 * opening the app once in a small window never overwrites the saved width.
 */
export function parseProjectPanelWidth(raw: string | null | undefined): number {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const n = text ? Number(text) : Number.NaN;
  return clampProjectPanelWidth(Number.isFinite(n) ? n : PROJECT_PANEL_DEFAULT_WIDTH);
}
