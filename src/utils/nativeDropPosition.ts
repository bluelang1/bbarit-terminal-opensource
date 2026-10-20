export type NativeDropPosition = { x: number; y: number };

export type NativeDropPositionContext = {
  /** `navigator.platform` (or userAgent) of the webview; decides the unit of the raw position. */
  platform?: string | null;
  /** `window.innerWidth/innerHeight`; used only when the platform is unknown. */
  viewport?: { width: number; height: number } | null;
};

const isMacPlatform = (platform: string | null | undefined): boolean => /mac|iphone|ipad/i.test(String(platform || ''));
const isWindowsPlatform = (platform: string | null | undefined): boolean => /win/i.test(String(platform || ''));

/**
 * Tauri types the native drag-drop position as a PhysicalPosition, but what
 * wry hands over differs per platform: on macOS it is the NSView point and on
 * Linux the GTK widget coordinate, both already CSS pixels (verified on a 2x
 * macOS display where the raw drop landed inside window.innerWidth/innerHeight);
 * only WebView2 on Windows reports physical pixels (POINTL via ScreenToClient).
 * DOM hit-testing needs CSS pixels, so convert once at the boundary.
 */
export function nativeDropPositionToCss(
  position: NativeDropPosition | null | undefined,
  devicePixelRatio: number | null | undefined,
  context: NativeDropPositionContext = {},
): NativeDropPosition {
  const x = Number(position?.x || 0);
  const y = Number(position?.y || 0);
  const scale = Number.isFinite(devicePixelRatio) && Number(devicePixelRatio) > 0
    ? Number(devicePixelRatio)
    : 1;
  let physical: boolean;
  if (isWindowsPlatform(context.platform)) physical = true;
  else if (isMacPlatform(context.platform) || /linux|x11|cros/i.test(String(context.platform || ''))) physical = false;
  else {
    // Unknown platform: a point outside the CSS viewport can only be physical.
    const viewport = context.viewport;
    physical = !!viewport && (x > viewport.width || y > viewport.height);
  }
  return physical ? { x: x / scale, y: y / scale } : { x, y };
}
