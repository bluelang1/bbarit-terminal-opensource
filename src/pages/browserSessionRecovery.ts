// Session recovery for BBARIT Browser.
//
// If the app closes (crash, update, quit) the user lost their place. A world-class
// browser restores the last session: where you were and how to get back. This module
// owns the pure serialize/validate/restore logic; the component captures the live URL
// and calls restore on mount.
//
// D1: We persist a bounded, VALIDATED snapshot, and restore only if it is fresh and
//     well-formed. Reason: never navigate to a stale/garbage URL from disk on boot —
//     that is a footgun (auto-opening something unexpected). Cost: sessions older
//     than MAX_AGE_MS are ignored. Escape hatch: restore() returns null → caller
//     falls back to the default page.

export interface SessionSnapshot {
  url: string;
  title: string;
  scrollY: number;
  savedAt: number;   // epoch ms
  recent: string[];  // last few URLs, newest last
}

export const SESSION_KV_KEY = 'bbarit-browser-session';
export const MAX_RECENT = 10;
export const MAX_AGE_MS = 7 * 86_400_000; // ignore snapshots older than a week

function isRestorableUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

// Fold a new visit into the prior snapshot, keeping a bounded recent-URL trail.
export function captureSession(
  prev: SessionSnapshot | null,
  visit: { url: string; title?: string; scrollY?: number },
  now: number,
): SessionSnapshot | null {
  if (!isRestorableUrl(visit.url)) return prev;
  const url = visit.url.trim();
  const recent = [...(prev?.recent || [])].filter((u) => u !== url);
  recent.push(url);
  while (recent.length > MAX_RECENT) recent.shift();
  return {
    url,
    title: (visit.title || prev?.title || url).slice(0, 300),
    scrollY: Math.max(0, Math.floor(visit.scrollY ?? 0)),
    savedAt: now,
    recent,
  };
}

export function serializeSession(snapshot: SessionSnapshot | null): string {
  return JSON.stringify(snapshot || null);
}

// Parse + validate a persisted snapshot. Returns a restorable snapshot or null.
export function restoreSession(raw: unknown, now: number, maxAgeMs = MAX_AGE_MS): SessionSnapshot | null {
  let parsed: any;
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { return null; } }
  else parsed = raw;
  if (!parsed || typeof parsed !== 'object') return null;
  if (!isRestorableUrl(parsed.url)) return null;
  const savedAt = Number(parsed.savedAt);
  if (!Number.isFinite(savedAt) || savedAt <= 0) return null;
  if (now - savedAt > maxAgeMs) return null;               // too stale to auto-restore
  const recent = Array.isArray(parsed.recent) ? parsed.recent.filter(isRestorableUrl).slice(-MAX_RECENT) : [];
  return {
    url: parsed.url.trim(),
    title: typeof parsed.title === 'string' ? parsed.title.slice(0, 300) : parsed.url,
    scrollY: Math.max(0, Math.floor(Number(parsed.scrollY) || 0)),
    savedAt,
    recent,
  };
}

// Human-friendly "restore" hint for the UI ("2 hours ago").
export function sessionAgeLabel(snapshot: SessionSnapshot, now: number): string {
  const ms = Math.max(0, now - snapshot.savedAt);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
