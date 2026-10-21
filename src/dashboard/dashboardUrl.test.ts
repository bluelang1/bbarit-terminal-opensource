import { describe, expect, it } from 'vitest';
import { DEFAULT_DASHBOARD_URL, loadDashboardUrl, normalizeDashboardUrl, saveDashboardUrl } from './dashboardUrl';

describe('dashboard url', () => {
  it('accepts http(s) URLs and fills in a missing scheme', () => {
    expect(normalizeDashboardUrl('http://localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeDashboardUrl('localhost:8080/agents')).toBe('http://localhost:8080/agents');
    expect(normalizeDashboardUrl(' https://127.0.0.1:3443/x?y=1 ')).toBe('https://127.0.0.1:3443/x?y=1');
  });

  it('rejects empty and non-web schemes', () => {
    expect(normalizeDashboardUrl('')).toBeNull();
    expect(normalizeDashboardUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeDashboardUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeDashboardUrl('http://')).toBeNull();
  });

  it('round-trips through storage and falls back to the default', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
    expect(loadDashboardUrl(storage)).toBe(DEFAULT_DASHBOARD_URL);
    saveDashboardUrl('http://localhost:4000/', storage);
    expect(loadDashboardUrl(storage)).toBe('http://localhost:4000/');
    map.set('octo-dashboard-url', 'javascript:evil');
    expect(loadDashboardUrl(storage)).toBe(DEFAULT_DASHBOARD_URL);
  });
});
