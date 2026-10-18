import { describe, expect, it } from 'vitest';
import {
  MAX_ENTRIES,
  categorize,
  frecency,
  recencyWeight,
  recordVisit,
  searchHistory,
  setBookmark,
  type HistoryEntry,
} from './browserHistoryStore';

const T0 = 1_700_000_000_000; // fixed "now" injected everywhere
const DAY = 86_400_000;

function entry(over: Partial<HistoryEntry>): HistoryEntry {
  return { url: 'https://x.test', title: 'X', visits: 1, firstVisit: T0, lastVisit: T0, bookmarked: false, category: 'other', ...over };
}

describe('recencyWeight', () => {
  // 정상 + 매핑: buckets decay with age; clock skew clamps to "now".
  it('decays by age bucket', () => {
    expect(recencyWeight(-5)).toBe(4);
    expect(recencyWeight(0)).toBe(4);
    expect(recencyWeight(2 * DAY)).toBe(3);
    expect(recencyWeight(10 * DAY)).toBe(2);
    expect(recencyWeight(30 * DAY)).toBe(1.5);
    expect(recencyWeight(90 * DAY)).toBe(1);
  });
});

describe('frecency', () => {
  it('rewards visits and recency, floats bookmarks to the top', () => {
    const fresh = entry({ visits: 3, lastVisit: T0 });          // 3*4 = 12
    const old = entry({ visits: 3, lastVisit: T0 - 90 * DAY }); // 3*1 = 3
    expect(frecency(fresh, T0)).toBeGreaterThan(frecency(old, T0));
    const marked = entry({ visits: 1, lastVisit: T0 - 90 * DAY, bookmarked: true });
    expect(frecency(marked, T0)).toBeGreaterThan(frecency(fresh, T0));
  });
});

describe('categorize', () => {
  // 매핑: domain keywords → categories.
  it('classifies by domain keyword', () => {
    expect(categorize('https://github.com/x/y')).toBe('dev');
    expect(categorize('https://api.anthropic.com')).toBe('ai');
    expect(categorize('https://www.reddit.com/r/x')).toBe('social');
    expect(categorize('https://www.amazon.com/dp/1')).toBe('shopping');
    expect(categorize('https://www.bbc.com/news')).toBe('news');
    expect(categorize('https://example.org/random')).toBe('other');
  });
});

describe('recordVisit', () => {
  // 정상: first visit inserts, second bumps visits + lastVisit.
  it('inserts then bumps on repeat visits', () => {
    let h: HistoryEntry[] = [];
    h = recordVisit(h, { url: 'https://github.com/a', title: 'Repo A' }, T0);
    expect(h).toHaveLength(1);
    expect(h[0].category).toBe('dev');
    h = recordVisit(h, { url: 'https://github.com/a#readme', title: 'Repo A' }, T0 + DAY);
    expect(h).toHaveLength(1); // hash-normalized dedupe
    expect(h[0].visits).toBe(2);
    expect(h[0].lastVisit).toBe(T0 + DAY);
  });

  // 변조: non-http junk is ignored, no crash.
  it('ignores non-navigable URLs', () => {
    expect(recordVisit([], { url: 'javascript:alert(1)' }, T0)).toEqual([]);
    expect(recordVisit([], { url: '' }, T0)).toEqual([]);
  });

  it('evicts lowest-frecency entries but keeps bookmarks over the cap', () => {
    let h: HistoryEntry[] = [];
    // A bookmarked, ancient, single-visit page that would otherwise be evicted.
    h = recordVisit(h, { url: 'https://keep.me/bookmarked', title: 'Keep' }, T0 - 200 * DAY);
    h = setBookmark(h, 'https://keep.me/bookmarked', true);
    for (let i = 0; i < MAX_ENTRIES + 20; i++) {
      h = recordVisit(h, { url: `https://site${i}.test/`, title: `S${i}` }, T0);
    }
    expect(h.length).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(h.some((e) => e.url === 'https://keep.me/bookmarked')).toBe(true);
  });
});

describe('setBookmark', () => {
  it('toggles the bookmark flag by normalized url', () => {
    const h = [entry({ url: 'https://a.test/p' })];
    expect(setBookmark(h, 'https://a.test/p#x', true)[0].bookmarked).toBe(true);
    expect(setBookmark(h, 'https://a.test/p', false)[0].bookmarked).toBe(false);
  });
});

describe('searchHistory', () => {
  const h: HistoryEntry[] = [
    entry({ url: 'https://stripe.com/pricing', title: 'Stripe Pricing', visits: 5, lastVisit: T0, category: 'shopping' }),
    entry({ url: 'https://github.com/anthropic', title: 'Anthropic GitHub', visits: 2, lastVisit: T0 - 10 * DAY, category: 'dev' }),
    entry({ url: 'https://news.ycombinator.com', title: 'Hacker News', visits: 20, lastVisit: T0 - 30 * DAY, category: 'news', bookmarked: true }),
  ];

  // 정상: token match ranks relevant entries first.
  it('ranks by token match then frecency', () => {
    const r = searchHistory(h, 'stripe pricing', T0);
    expect(r[0].url).toBe('https://stripe.com/pricing');
  });

  // 매핑: empty query → top sites by frecency (bookmark first).
  it('returns top sites by frecency for an empty query', () => {
    const r = searchHistory(h, '', T0);
    expect(r[0].url).toBe('https://news.ycombinator.com'); // bookmarked → floats up
  });

  it('filters by bookmarkedOnly and category', () => {
    expect(searchHistory(h, '', T0, { bookmarkedOnly: true })).toHaveLength(1);
    expect(searchHistory(h, '', T0, { category: 'dev' })[0].url).toBe('https://github.com/anthropic');
  });

  // None: no match → empty; limit is honored.
  it('returns nothing for a non-matching query and respects limit', () => {
    expect(searchHistory(h, 'zzzznomatch', T0)).toEqual([]);
    expect(searchHistory(h, '', T0, { limit: 1 })).toHaveLength(1);
  });
});
