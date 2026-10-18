export type NativeDropPosition = { x: number; y: number };

/**
 * Tauri's native drag-drop API reports a PhysicalPosition on every desktop
 * platform. DOM hit-testing, however, uses CSS pixels. Convert once at the
 * window boundary so Finder, Explorer, the file tree, and terminal agree on
 * the same target on Retina and scaled displays.
 */
export function nativeDropPositionToCss(
  position: NativeDropPosition | null | undefined,
  devicePixelRatio: number | null | undefined,
): NativeDropPosition {
  const scale = Number.isFinite(devicePixelRatio) && Number(devicePixelRatio) > 0
    ? Number(devicePixelRatio)
    : 1;
  return {
    x: Number(position?.x || 0) / scale,
    y: Number(position?.y || 0) / scale,
  };
}
