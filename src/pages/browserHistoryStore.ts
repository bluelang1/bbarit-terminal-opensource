// Smart browsing history + bookmark intelligence for BBARIT Browser.
//
// The browser only had in-session back/forward (CDP). A world-class AI browser
// remembers across sessions and ranks by "frecency" (frequency + recency, the same
// idea Chrome/Firefox use), supports fuzzy recall ("that stripe pricing page"), and
// auto-categorizes entries so the agent can reason over the user's browsing.
//
// This module is PURE: record/search/rank/categorize over a plain array. Persistence
// (KV) and the live URL feed are wired at the component; keeping the logic pure makes
// the ranking testable and deterministic (time is injected, never read here).
//
// D1: frecency = visits * recencyWeight(age). Recency uses fixed decay buckets, not
//     a continuous exp, so ranking is stable and explainable. Cost: coarse buckets.
// D2: The store is bounded (MAX_ENTRIES); the lowest-frecency entries are evicted.
//     Bookmarked entries are NEVER evicted (an explicit save outranks decay).

export interface HistoryEntry {
  url: string;
  title: string;
  visits: number;
  firstVisit: number;   // epoch ms
  lastVisit: number;    // epoch ms
  bookmarked: boolean;
  category: string;
}

export const MAX_ENTRIES = 500;

const DAY = 86_400_000;

// Recency multiplier by age bucket (today counts far more than last month).
export function recencyWeight(ageMs: number): number {
  if (ageMs < 0) return 4;            // clock skew: treat as "now"
  if (ageMs < DAY) return 4;          // < 1 day
  if (ageMs < 4 * DAY) return 3;      // < 4 days
  if (ageMs < 14 * DAY) return 2;     // < 2 weeks
  if (ageMs < 60 * DAY) return 1.5;   // < 2 months
  return 1;
}

export function frecency(entry: HistoryEntry, now: number): number {
  const base = Math.max(1, entry.visits) * recencyWeight(now - entry.lastVisit);
  return entry.bookmarked ? base + 1000 : base; // bookmarks always float to the top
}

// Domain-keyword → category. First match wins; falls back to 'other'.
const CATEGORY_RULES: Array<{ category: string; re: RegExp }> = [
  { category: 'dev', re: /(github|gitlab|stackoverflow|npmjs|developer\.|docs\.|readthedocs|mdn|localhost|127\.0\.0\.1)/i },
  { category: 'ai', re: /(openai|anthropic|claude|deepseek|huggingface|perplexity|gemini|chatgpt)/i },
  { category: 'social', re: /(twitter|x\.com|facebook|instagram|linkedin|reddit|threads|tiktok|youtube)/i },
  { category: 'shopping', re: /(amazon|ebay|aliexpress|coupang|gmarket|shopify|etsy|stripe|paypal)/i },
  { category: 'news', re: /(news|bbc|cnn|nytimes|reuters|bloomberg|guardian|naver|daum)/i },
  { category: 'docs', re: /(notion|google\.com\/(docs|sheets|slides)|confluence|figma)/i },
  { category: 'search', re: /(google\.[a-z.]+\/search|bing\.com|duckduckgo)/i },
];

export function categorize(url: string, title = ''): string {
  const hay = `${url} ${title}`;
  for (const rule of CATEGORY_RULES) if (rule.re.test(hay)) return rule.category;
  return 'other';
}

function normalizeKey(url: string): string {
  try { const u = new URL(url); u.hash = ''; return u.href; } catch { return String(url || '').trim(); }
}

// Record a visit: bump an existing entry or insert a new one. Returns a NEW array.
export function recordVisit(
  entries: HistoryEntry[],
  visit: { url: string; title?: string },
  now: number,
): HistoryEntry[] {
  const key = normalizeKey(visit.url);
  if (!/^https?:|^file:|^localhost|^127\./i.test(key) || !key) return entries.slice();
  const next = entries.slice();
  const idx = next.findIndex((e) => normalizeKey(e.url) === key);
  if (idx >= 0) {
    const e = next[idx];
    next[idx] = {
      ...e,
      title: visit.title?.trim() || e.title,
      visits: e.visits + 1,
      lastVisit: now,
      category: e.category && e.category !== 'other' ? e.category : categorize(key, visit.title),
    };
  } else {
    next.push({
      url: key,
      title: (visit.title || '').trim() || key,
      visits: 1,
      firstVisit: now,
      lastVisit: now,
      bookmarked: false,
      category: categorize(key, visit.title),
    });
  }
  return evict(next, now);
}

// Evict lowest-frecency non-bookmarked entries when over the cap.
export function evict(entries: HistoryEntry[], now: number): HistoryEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries;
  const sorted = entries.slice().sort((a, b) => frecency(b, now) - frecency(a, now));
  return sorted.slice(0, MAX_ENTRIES);
}

export function setBookmark(entries: HistoryEntry[], url: string, bookmarked: boolean): HistoryEntry[] {
  const key = normalizeKey(url);
  return entries.map((e) => (normalizeKey(e.url) === key ? { ...e, bookmarked } : e));
}

// Fuzzy-ish scoring: token overlap against url+title, weighted by frecency.
export function searchHistory(
  entries: HistoryEntry[],
  query: string,
  now: number,
  opts: { limit?: number; bookmarkedOnly?: boolean; category?: string } = {},
): HistoryEntry[] {
  const limit = Math.max(1, opts.limit ?? 20);
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  let pool = entries.slice();
  if (opts.bookmarkedOnly) pool = pool.filter((e) => e.bookmarked);
  if (opts.category) pool = pool.filter((e) => e.category === opts.category);

  const scored = pool.map((e) => {
    const hay = `${e.url} ${e.title}`.toLowerCase();
    let match = 0;
    for (const t of tokens) {
      if (hay.includes(t)) match += hay.split(' ').some((w) => w === t) ? 2 : 1;
    }
    // No query → pure frecency ranking (the "top sites" view).
    const score = tokens.length ? match * 100 + frecency(e, now) : frecency(e, now);
    return { e, match, score };
  });
  return scored
    .filter((s) => (tokens.length ? s.match > 0 : true))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.e);
}
