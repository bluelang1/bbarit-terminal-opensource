import { describe, expect, it } from 'vitest';
import {
  importableCookies,
  mergeBookmarks,
  mergeHistory,
  passwordsToLogins,
  siteFromUrl,
  summarizeImport,
  type ImportedBookmark,
  type ImportedCookie,
  type ImportedHistory,
  type ImportedPassword,
  type ImportPayload,
} from './chromeImport';
import type { HistoryEntry } from '../browserHistoryStore';
import type { SiteLogin } from './AsideLoginsPane';

const NOW = 1_700_000_000_000;

function hist(url: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return { url, title: url, visits: 1, firstVisit: NOW, lastVisit: NOW, bookmarked: false, category: 'other', ...over };
}

describe('siteFromUrl', () => {
  it('extracts the hostname from a full url', () => {
    expect(siteFromUrl('https://www.naver.com/login?x=1')).toBe('www.naver.com');
  });
  it('handles a bare host', () => {
    expect(siteFromUrl('example.com')).toBe('example.com');
  });
});

describe('mergeHistory', () => {
  it('adds new entries and keeps the higher visit count for existing ones', () => {
    const existing = [hist('https://a.com/', { visits: 2 })];
    const imported: ImportedHistory[] = [
      { url: 'https://a.com/', title: 'A', visits: 10, last_visit: NOW + 1000 },
      { url: 'https://b.com/', title: 'B', visits: 3, last_visit: NOW },
    ];
    const merged = mergeHistory(existing, imported, NOW);
    const a = merged.find((e) => e.url === 'https://a.com/')!;
    expect(a.visits).toBe(10);
    expect(a.lastVisit).toBe(NOW + 1000);
    expect(merged.some((e) => e.url === 'https://b.com/')).toBe(true);
  });

  it('ignores non-web schemes', () => {
    const merged = mergeHistory([], [{ url: 'chrome://settings', title: 'x', visits: 5, last_visit: NOW }], NOW);
    expect(merged).toHaveLength(0);
  });

  it('categorizes imported entries', () => {
    const merged = mergeHistory([], [{ url: 'https://github.com/x', title: 'repo', visits: 1, last_visit: NOW }], NOW);
    expect(merged[0].category).toBe('dev');
  });
});

describe('mergeBookmarks', () => {
  it('flags an existing entry as bookmarked instead of duplicating it', () => {
    const existing = [hist('https://a.com/', { visits: 4 })];
    const merged = mergeBookmarks(existing, [{ url: 'https://a.com/', title: 'A', folder: 'bar', added: NOW }], NOW);
    expect(merged).toHaveLength(1);
    expect(merged[0].bookmarked).toBe(true);
    expect(merged[0].visits).toBe(4);
  });

  it('adds a brand-new bookmarked entry', () => {
    const merged = mergeBookmarks([], [{ url: 'https://new.com/', title: 'New', folder: 'bar', added: NOW }], NOW);
    expect(merged[0].bookmarked).toBe(true);
    expect(merged[0].url).toBe('https://new.com/');
  });
});

describe('passwordsToLogins', () => {
  const imported: ImportedPassword[] = [
    { url: 'https://naver.com/login', username: 'me@naver.com', password: 'pw1', times_used: 3, last_used: NOW },
    { url: 'https://google.com/', username: 'me@gmail.com', password: 'pw2', times_used: 1, last_used: NOW },
  ];

  it('creates one SiteLogin per credential using the hostname as site', () => {
    const out = passwordsToLogins([], imported, NOW);
    expect(out).toHaveLength(2);
    expect(out[0].site).toBe('naver.com');
    expect(out[0].username).toBe('me@naver.com');
    expect(out.every((l) => l.id)).toBe(true);
  });

  it('overwrites an existing login with the same site+username', () => {
    const existing: SiteLogin[] = [{ id: 'x', site: 'naver.com', username: 'me@naver.com', password: 'old', updatedAt: 1 }];
    const out = passwordsToLogins(existing, imported, NOW);
    expect(out).toHaveLength(2);
    const naver = out.find((l) => l.site === 'naver.com')!;
    expect(naver.id).toBe('x');
    expect(naver.password).toBe('pw1');
    expect(naver.updatedAt).toBe(NOW);
  });

  it('skips credentials with no username or password', () => {
    const out = passwordsToLogins([], [{ url: 'https://x.com', username: '', password: 'p', times_used: 0, last_used: 0 }], NOW);
    expect(out).toHaveLength(0);
  });
});

describe('importableCookies', () => {
  const mk = (name: string, expires: number): ImportedCookie => ({
    host: '.x.com', name, value: 'v', path: '/', expires, secure: true, http_only: true, same_site: 0,
  });
  it('keeps session cookies (expires 0) and unexpired cookies', () => {
    const kept = importableCookies([mk('a', 0), mk('b', NOW + 1000), mk('c', NOW - 1000)], NOW);
    expect(kept.map((c) => c.name)).toEqual(['a', 'b']);
  });
});

describe('summarizeImport', () => {
  it('lists only the requested item counts', () => {
    const payload: ImportPayload = {
      passwords: [{}, {}] as any, bookmarks: [{}] as any, history: [], autofill: [],
      search_engines: [], cookies: [], warnings: [], undecryptable: 0,
    };
    const msg = summarizeImport(payload, ['passwords', 'bookmarks']);
    expect(msg).toContain('비밀번호 2개');
    expect(msg).toContain('북마크 1개');
    expect(msg).not.toContain('방문기록');
  });
});
