// Chrome/Chromium 데이터 가져오기 — 브릿지 호출 + 순수 병합 로직.
//
// 백엔드(src-tauri/src/chrome_import.rs)가 프로필을 훑고 선택 항목을 복호화해서
// 넘겨주면, 이 모듈이 그 결과를 브라우저의 기존 저장소 모양으로 접어 넣는다:
// - passwords  → SiteLogin[]        (Fill / 에이전트 로그인이 이미 소비)
// - history    → HistoryEntry[]      (히스토리 패널 + 옴니박스 추천)
// - bookmarks  → HistoryEntry[](bookmarked=true)
// - cookies    → 네이티브 set_cookie로 주입(로그인 세션 이어받기)
// - autofill / search_engines → 각각 KV에 원형 보관(후속 소비)
//
// 병합 함수는 전부 순수하다(시간 주입, I/O 없음) — chromeImport.test.ts로 검증.

import { invoke } from '@tauri-apps/api/core';
import { categorize, evict, type HistoryEntry } from '../browserHistoryStore';
import type { SiteLogin } from './AsideLoginsPane';

export type ImportItem = 'passwords' | 'bookmarks' | 'history' | 'autofill' | 'search_engines' | 'cookies';

export interface ChromeProfile {
  browser_key: string;
  browser_name: string;
  profile_id: string;
  profile_dir: string;
  display_name: string;
  passwords: number;
  bookmarks: number;
  history: number;
  autofill: number;
  search_engines: number;
  cookies: number;
}

export interface ImportedPassword { url: string; username: string; password: string; times_used: number; last_used: number; }
export interface ImportedBookmark { url: string; title: string; folder: string; added: number; }
export interface ImportedHistory { url: string; title: string; visits: number; last_visit: number; }
export interface ImportedAutofill { name: string; value: string; count: number; }
export interface ImportedSearchEngine { name: string; keyword: string; url: string; }
export interface ImportedCookie {
  host: string; name: string; value: string; path: string;
  expires: number; secure: boolean; http_only: boolean; same_site: number;
}

export interface ImportPayload {
  passwords: ImportedPassword[];
  bookmarks: ImportedBookmark[];
  history: ImportedHistory[];
  autofill: ImportedAutofill[];
  search_engines: ImportedSearchEngine[];
  cookies: ImportedCookie[];
  warnings: string[];
  undecryptable: number;
}

// ---------------------------------------------------------------- 브릿지 호출

export function listChromeProfiles(): Promise<ChromeProfile[]> {
  return invoke<ChromeProfile[]>('chrome_list_profiles');
}

export function importChromeData(
  profile: ChromeProfile,
  items: ImportItem[],
  historyLimit = 2000,
): Promise<ImportPayload> {
  return invoke<ImportPayload>('chrome_import_data', {
    request: {
      browser_key: profile.browser_key,
      profile_dir: profile.profile_dir,
      items,
      history_limit: historyLimit,
    },
  });
}

// 쿠키를 열린 탭의 네이티브 쿠키 스토어에 넣는다. [성공, 실패] 반환.
export async function injectCookies(webviewId: number, cookies: ImportedCookie[]): Promise<[number, number]> {
  if (!cookies.length) return [0, 0];
  const res = await invoke<[number, number]>('cef_set_cookies', { id: webviewId, cookies });
  return res;
}

// ---------------------------------------------------------------- 순수 병합

function normalizeKey(url: string): string {
  try { const u = new URL(url); u.hash = ''; return u.href; } catch { return String(url || '').trim(); }
}

// 로그인 URL/도메인에서 사이트 표기를 뽑는다 (SiteLogin.site는 호스트 문자열).
export function siteFromUrl(url: string): string {
  const raw = String(url || '').trim();
  try {
    // signon_realm은 "https://host/"거나 "android://..." 형태일 수 있다.
    return new URL(raw).hostname || raw.replace(/^https?:\/\//, '').split('/')[0];
  } catch {
    return raw.replace(/^https?:\/\//, '').split('/')[0];
  }
}

// 방문기록 병합: 이미 있으면 방문수 max·최신 방문시각을 취하고, 없으면 새 항목.
export function mergeHistory(existing: HistoryEntry[], imported: ImportedHistory[], now: number): HistoryEntry[] {
  const next = existing.slice();
  const byKey = new Map<string, number>();
  next.forEach((e, i) => byKey.set(normalizeKey(e.url), i));
  for (const h of imported) {
    const key = normalizeKey(h.url);
    if (!key || !/^https?:|^file:/i.test(key)) continue;
    const idx = byKey.get(key);
    const last = h.last_visit > 0 ? h.last_visit : now;
    if (idx != null) {
      const e = next[idx];
      next[idx] = {
        ...e,
        title: e.title && e.title !== e.url ? e.title : (h.title || e.title),
        visits: Math.max(e.visits, h.visits || 1),
        lastVisit: Math.max(e.lastVisit, last),
      };
    } else {
      byKey.set(key, next.length);
      next.push({
        url: key,
        title: (h.title || '').trim() || key,
        visits: Math.max(1, h.visits || 1),
        firstVisit: last,
        lastVisit: last,
        bookmarked: false,
        category: categorize(key, h.title),
      });
    }
  }
  return evict(next, now);
}

// 북마크 병합: 존재하면 bookmarked 플래그만 켜고, 없으면 bookmarked 항목으로 추가.
// (북마크는 evict가 절대 지우지 않는다 — browserHistoryStore.frecency 참조.)
export function mergeBookmarks(existing: HistoryEntry[], imported: ImportedBookmark[], now: number): HistoryEntry[] {
  const next = existing.slice();
  const byKey = new Map<string, number>();
  next.forEach((e, i) => byKey.set(normalizeKey(e.url), i));
  for (const b of imported) {
    const key = normalizeKey(b.url);
    if (!key || !/^https?:|^file:/i.test(key)) continue;
    const added = b.added > 0 ? b.added : now;
    const idx = byKey.get(key);
    if (idx != null) {
      next[idx] = { ...next[idx], bookmarked: true, title: next[idx].title || b.title || key };
    } else {
      byKey.set(key, next.length);
      next.push({
        url: key,
        title: (b.title || '').trim() || key,
        visits: 1,
        firstVisit: added,
        lastVisit: added,
        bookmarked: true,
        category: categorize(key, b.title),
      });
    }
  }
  return evict(next, now);
}

// 비밀번호 → SiteLogin. site+username이 같으면 기존 항목을 덮어쓴다(최신 우선).
export function passwordsToLogins(existing: SiteLogin[], imported: ImportedPassword[], now: number): SiteLogin[] {
  const next = existing.slice();
  const indexOf = (site: string, user: string) =>
    next.findIndex((l) => l.site.toLowerCase() === site.toLowerCase() && l.username.toLowerCase() === user.toLowerCase());
  let seq = 0;
  for (const p of imported) {
    const site = siteFromUrl(p.url);
    const username = (p.username || '').trim();
    if (!site || !username || !p.password) continue;
    const idx = indexOf(site, username);
    if (idx >= 0) {
      next[idx] = { ...next[idx], password: p.password, updatedAt: now };
    } else {
      next.push({
        id: `${now.toString(36)}-${seq++}`,
        site,
        username,
        password: p.password,
        note: 'Imported from Chrome',
        updatedAt: now,
      });
    }
  }
  return next;
}

// 만료됐거나 세션 쿠키가 아닌, 주입할 가치가 있는 쿠키만 남긴다.
export function importableCookies(cookies: ImportedCookie[], now: number): ImportedCookie[] {
  return cookies.filter((c) => c.expires === 0 || c.expires > now);
}

// 사람이 읽을 요약 문장(가져오기 결과 토스트/로그용).
export function summarizeImport(payload: ImportPayload, items: ImportItem[]): string {
  const parts: string[] = [];
  if (items.includes('passwords')) parts.push(`비밀번호 ${payload.passwords.length}개`);
  if (items.includes('bookmarks')) parts.push(`북마크 ${payload.bookmarks.length}개`);
  if (items.includes('history')) parts.push(`방문기록 ${payload.history.length}개`);
  if (items.includes('autofill')) parts.push(`자동완성 ${payload.autofill.length}개`);
  if (items.includes('search_engines')) parts.push(`검색엔진 ${payload.search_engines.length}개`);
  if (items.includes('cookies')) parts.push(`쿠키 ${payload.cookies.length}개`);
  return parts.length ? `${parts.join(', ')}를 가져왔습니다.` : '가져올 항목이 없습니다.';
}
