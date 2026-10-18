import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import BrowserNetworkPanel from './BrowserNetworkPanel';

describe('BrowserNetworkPanel filters', () => {
  it('renders advanced packet filter controls', () => {
    const html = renderToStaticMarkup(<BrowserNetworkPanel locale="ko" />);
    expect(html).toContain('domain:naver.com');
    expect(html).toContain('aria-label="메서드 필터"');
    expect(html).toContain('aria-label="도메인 필터"');
    expect(html).toContain('aria-label="상태 필터"');
    expect(html).toContain('aria-label="캐시 필터"');
    expect(html).toContain('aria-label="최소 응답 시간"');
    expect(html).toContain('aria-label="최소 크기"');
    expect(html).toContain('필터 초기화');
  });
});
