import { describe, expect, it } from 'vitest';
import { classifyPaginateButton, madeProgress, planPagination, type PaginateSignals } from './browserPaginate';

describe('classifyPaginateButton', () => {
  // 정상 + 매핑: EN/KO/symbol texts classify.
  it('classifies load-more / next / prev', () => {
    expect(classifyPaginateButton('Load more')).toBe('load-more');
    expect(classifyPaginateButton('더보기')).toBe('load-more');
    expect(classifyPaginateButton('Next page')).toBe('next');
    expect(classifyPaginateButton('다음')).toBe('next');
    expect(classifyPaginateButton('›')).toBe('next');
    expect(classifyPaginateButton('Previous')).toBe('prev');
    expect(classifyPaginateButton('이전')).toBe('prev');
  });
  // None/변조: empty / unrelated.
  it('returns other for empty or unrelated text', () => {
    expect(classifyPaginateButton('')).toBe('other');
    expect(classifyPaginateButton('Home')).toBe('other');
  });
});

describe('planPagination', () => {
  // 정상: load-more preferred over next.
  it('prefers load-more over next-page', () => {
    const p = planPagination({ buttons: [{ ref: '@e1', text: 'Next' }, { ref: '@e2', text: 'Show more' }] });
    expect(p.strategy).toBe('load-more');
    expect(p.target?.ref).toBe('@e2');
  });

  // 매핑: next-page when no load-more.
  it('uses next-page when no load-more exists', () => {
    const p = planPagination({ buttons: [{ ref: '@e1', text: 'Next page' }, { ref: '@e2', text: 'Previous' }] });
    expect(p.strategy).toBe('next-page');
    expect(p.target?.ref).toBe('@e1');
  });

  // 매핑: infinite scroll fallback.
  it('falls back to scroll when only scrollable content remains', () => {
    const p = planPagination({ buttons: [{ ref: '@e1', text: 'Home' }], scrollableToBottom: true });
    expect(p.strategy).toBe('scroll');
    expect(p.target).toBeNull();
  });

  // None: nothing to paginate.
  it('reports none when there is no control or scroll', () => {
    expect(planPagination({ buttons: [{ ref: '@e1', text: 'Home' }] }).strategy).toBe('none');
    expect(planPagination({}).strategy).toBe('none');
  });

  // 변조: a lone "previous" must not be treated as pagination-forward.
  it('does not treat a lone previous as next', () => {
    expect(planPagination({ buttons: [{ ref: '@e1', text: '이전' }] }).strategy).toBe('none');
  });

  it('tolerates malformed input', () => {
    expect(planPagination(undefined as unknown as PaginateSignals).strategy).toBe('none');
    expect(planPagination({ buttons: [{ ref: '@e1', text: '' }] }).strategy).toBe('none');
  });
});

describe('madeProgress', () => {
  it('detects list growth', () => {
    expect(madeProgress(10, 30)).toBe(true);
    expect(madeProgress(30, 30)).toBe(false);
    expect(madeProgress(30, 20)).toBe(false);
  });
});
