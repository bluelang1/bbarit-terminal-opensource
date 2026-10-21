// URL of the user's own local dashboard shown by the "Dashboard" toolbar
// button. Stored per machine; only http(s) URLs are accepted so a typo cannot
// turn the embedded frame into a file:// or javascript: loader.

export const DASHBOARD_URL_KEY = 'octo-dashboard-url';
export const DEFAULT_DASHBOARD_URL = 'http://localhost:3000';

export function normalizeDashboardUrl(raw: string): string | null {
  let value = String(raw || '').trim();
  if (!value) return null;
  // "localhost:5173" / "127.0.0.1:8080/path" → assume http.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function loadDashboardUrl(storage: Pick<Storage, 'getItem'> | null = safeStorage()): string {
  try {
    const saved = storage?.getItem(DASHBOARD_URL_KEY);
    return (saved && normalizeDashboardUrl(saved)) || DEFAULT_DASHBOARD_URL;
  } catch {
    return DEFAULT_DASHBOARD_URL;
  }
}

export function saveDashboardUrl(url: string, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(DASHBOARD_URL_KEY, url); } catch { /* storage unavailable */ }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
