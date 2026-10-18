export type ClipboardWriter = (text: string) => Promise<void>;

export async function copyFileTreePathToClipboard(
  text: string,
  writers: ClipboardWriter[],
): Promise<boolean> {
  if (!text) return false;
  for (const write of writers) {
    try {
      await write(text);
      return true;
    } catch {
      // Try the next clipboard backend.
    }
  }
  return false;
}

export function shouldHandoffFileTreeDragToNative(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
  edgeThreshold = 4,
): boolean {
  if (viewportWidth <= 0 || viewportHeight <= 0) return false;
  return clientX <= edgeThreshold
    || clientY <= edgeThreshold
    || clientX >= viewportWidth - edgeThreshold
    || clientY >= viewportHeight - edgeThreshold;
}
