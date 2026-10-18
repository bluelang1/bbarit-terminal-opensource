import { describe, expect, it } from 'vitest';
import { findMarkdownLinkAtPosition, findWikiLinkAtPosition, parseWikiLinks, splitWikiLinkTarget } from './wikilinkParser';

describe('wikilink parser', () => {
  it('finds a wikilink target at a clicked position', () => {
    const text = 'See [[overview]] for the summary.';
    const pos = text.indexOf('overview') + 2;
    expect(findWikiLinkAtPosition(text, pos)?.target).toBe('overview');
  });

  it('finds a markdown document link target at a clicked position', () => {
    const text = 'Open [sample](./link-check.md) for the test page.';
    const pos = text.indexOf('sample') + 1;
    expect(findMarkdownLinkAtPosition(text, pos)?.target).toBe('./link-check.md');
  });

  it('parses heading links into target + heading', () => {
    const links = parseWikiLinks('go to [[Project Plan#Milestones]] now');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('Project Plan');
    expect(links[0].heading).toBe('Milestones');
  });

  it('parses alias together with heading', () => {
    const links = parseWikiLinks('[[note#section|보기 좋은 이름]]');
    expect(links[0].target).toBe('note');
    expect(links[0].heading).toBe('section');
    expect(links[0].alias).toBe('보기 좋은 이름');
  });

  it('marks ![[...]] as embed and includes the bang in the range', () => {
    const text = 'before ![[diagram]] after';
    const links = parseWikiLinks(text);
    expect(links[0].embed).toBe(true);
    expect(links[0].target).toBe('diagram');
    expect(text.slice(links[0].from, links[0].to)).toBe('![[diagram]]');
  });

  it('keeps plain links non-embed', () => {
    const links = parseWikiLinks('[[plain]]');
    expect(links[0].embed).toBeUndefined();
  });

  it('splits same-note heading links with empty target', () => {
    expect(splitWikiLinkTarget('#Section')).toEqual({ target: '', heading: 'Section' });
    expect(splitWikiLinkTarget('note')).toEqual({ target: 'note' });
  });
});
