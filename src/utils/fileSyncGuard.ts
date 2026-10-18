// Fingerprint of a file's on-disk content, kept on each open editor tab so
// save paths can tell "the disk still holds what we loaded" from "someone else
// (an agent, another program) wrote the file since". A stale editor buffer must
// never overwrite an external change — reload instead.

// FNV-1a 32-bit over UTF-16 code units. A collision only skips one reload —
// it can never destroy data — so 32 bits is plenty.
export function contentFingerprint(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// True when the current disk content no longer matches the fingerprint taken
// at load/save time. An unknown baseline (legacy tabs) reports no conflict so
// existing behavior is preserved.
export function diskChangedSinceLoad(diskContent: string, loadedFingerprint: number | undefined): boolean {
  if (loadedFingerprint === undefined) return false;
  return contentFingerprint(diskContent) !== loadedFingerprint;
}
