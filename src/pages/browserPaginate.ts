// Pagination / "load more" strategy detection.
//
// Lists that matter (search results, product grids, feeds) rarely show everything at
// once: they page via a "Next" link, a "Load more" button, or infinite scroll. To let
// browser_extract see the WHOLE list, the agent needs to load more first. This module
// classifies the candidate controls and decides the strategy; the load loop is thin.
//
// D1: Prefer an explicit "load more" button, then a "next page" link, then infinite
//     scroll. Reason: a button/link adds to or advances the current list deterministically;
//     scroll is a fallback that can loop forever, so it is bounded by maxRounds.

export interface PaginateButton { ref: string; text: string; role?: string }
export interface PaginateSignals {
  buttons?: PaginateButton[];
  scrollableToBottom?: boolean;   // page has more content below the fold
  itemCount?: number;             // current number of list items (to detect growth)
}

export type PaginateStrategy = 'load-more' | 'next-page' | 'scroll' | 'none';

export interface PaginatePlan {
  strategy: PaginateStrategy;
  target: PaginateButton | null;   // button/link to click, if any
  reason: string;
}

const LOAD_MORE_RE = /(load more|show more|view more|see more|더\s*보기|더보기|더\s*불러오기|もっと見る)/i;
// Arrow symbols via \u escapes so the pattern is byte/encoding-independent.
// next: » › → ＞ ▶ ; prev: « ‹ ← ＜ ◀
const NEXT_RE = /(next page|next\b|다음\s*페이지|다음|[»›→＞▶]|下一页|次へ)/i;
const PREV_RE = /(prev|previous|이전|[«‹←＜◀]|上一页|前へ)/i;

export function classifyPaginateButton(text: string): 'load-more' | 'next' | 'prev' | 'other' {
  const t = String(text || '').trim();
  if (!t) return 'other';
  if (LOAD_MORE_RE.test(t)) return 'load-more';
  if (PREV_RE.test(t) && !NEXT_RE.test(t)) return 'prev';   // don't treat a lone "prev" as next
  if (NEXT_RE.test(t)) return 'next';
  return 'other';
}

export function planPagination(signals: PaginateSignals): PaginatePlan {
  const buttons = (signals?.buttons || []).filter((b) => b && String(b.text || '').trim());
  let loadMore: PaginateButton | null = null;
  let next: PaginateButton | null = null;
  for (const b of buttons) {
    const kind = classifyPaginateButton(b.text);
    if (kind === 'load-more' && !loadMore) loadMore = b;
    else if (kind === 'next' && !next) next = b;
  }
  if (loadMore) return { strategy: 'load-more', target: loadMore, reason: 'click "load more" to append items' };
  if (next) return { strategy: 'next-page', target: next, reason: 'follow the next-page link' };
  if (signals?.scrollableToBottom) return { strategy: 'scroll', target: null, reason: 'infinite scroll — scroll to load more' };
  return { strategy: 'none', target: null, reason: 'no pagination control or scrollable content found' };
}

// Did a load round actually add items? Guards the scroll/click loop against spinning
// forever on a page that will not grow.
export function madeProgress(before: number, after: number): boolean {
  return Number(after) > Number(before);
}

export const MAX_PAGINATE_ROUNDS = 10;
