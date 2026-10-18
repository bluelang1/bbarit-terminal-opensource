import { describe, expect, it } from 'vitest';
import { classifyOmniboxInput } from './browserOmnibox';

describe('classifyOmniboxInput', () => {
  // 정상: URLs and domains navigate.
  it('classifies URLs and domains as url', () => {
    expect(classifyOmniboxInput('https://example.com/a?b=1')).toEqual({ kind: 'url', url: 'https://example.com/a?b=1' });
    expect(classifyOmniboxInput('example.com')).toEqual({ kind: 'url', url: 'https://example.com' });
    expect(classifyOmniboxInput('localhost:5175/app')).toEqual({ kind: 'url', url: 'http://localhost:5175/app' });
    expect(classifyOmniboxInput('about:blank')).toEqual({ kind: 'url', url: 'about:blank' });
  });

  // 매핑: keyword queries stay classic web search (the safe default).
  it('classifies keyword queries as search', () => {
    const r = classifyOmniboxInput('무선 이어폰 추천');
    expect(r.kind).toBe('search');
    if (r.kind === 'search') {
      expect(r.url).toContain('google.com/search');
      expect(r.query).toBe('무선 이어폰 추천');
    }
    expect(classifyOmniboxInput('best mechanical keyboard 2026').kind).toBe('search');
    // Single word without a question mark is never an ask.
    expect(classifyOmniboxInput('날씨').kind).toBe('search');
  });

  it('routes Korean agent-style requests to ask', () => {
    expect(classifyOmniboxInput('이 페이지 요약해줘')).toEqual({ kind: 'ask', question: '이 페이지 요약해줘' });
    expect(classifyOmniboxInput('이 사이트 SEO 분석해 줘').kind).toBe('ask');
    expect(classifyOmniboxInput('이 페이지 왜 느려?').kind).toBe('ask');
    expect(classifyOmniboxInput('메타 태그 어떻게 고쳐?').kind).toBe('ask');
  });

  it('routes English questions and agent verbs to ask', () => {
    expect(classifyOmniboxInput('summarize this page')).toEqual({ kind: 'ask', question: 'summarize this page' });
    expect(classifyOmniboxInput('why is this page slow?').kind).toBe('ask');
    expect(classifyOmniboxInput('how do I fix the meta tags').kind).toBe('ask');
    expect(classifyOmniboxInput('audit this page for seo').kind).toBe('ask');
  });

  it('honors the explicit agent prefix regardless of content', () => {
    expect(classifyOmniboxInput('@ 날씨')).toEqual({ kind: 'ask', question: '날씨' });
    expect(classifyOmniboxInput('ai: example.com 크롤링')).toEqual({ kind: 'ask', question: 'example.com 크롤링' });
  });

  // None: empty input falls back to the default page.
  it('maps empty input to the default url', () => {
    const r = classifyOmniboxInput('');
    expect(r.kind).toBe('url');
    expect(classifyOmniboxInput('   ').kind).toBe('url');
  });

  // 변조: odd values never crash and never produce an empty ask.
  it('tolerates malformed input', () => {
    expect(classifyOmniboxInput(undefined as unknown as string).kind).toBe('url');
    expect(classifyOmniboxInput('?').kind).toBe('search'); // lone "?" is not a question
    expect(classifyOmniboxInput('@   ').kind).toBe('search'); // empty prefixed ask falls through
  });
});
