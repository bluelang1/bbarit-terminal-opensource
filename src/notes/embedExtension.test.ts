import { describe, expect, it } from 'vitest';
import { sliceHeadingSection, stripFrontmatter } from './embedExtension';

describe('stripFrontmatter', () => {
  it('removes a yaml frontmatter block', () => {
    expect(stripFrontmatter('---\ntags: [a]\n---\nbody text')).toBe('body text');
  });

  it('keeps content without frontmatter untouched', () => {
    expect(stripFrontmatter('# Title\nbody')).toBe('# Title\nbody');
  });

  it('keeps content when the frontmatter block is unclosed', () => {
    expect(stripFrontmatter('---\ntags: [a]\nbody')).toBe('---\ntags: [a]\nbody');
  });
});

describe('sliceHeadingSection', () => {
  const md = '# Top\nintro\n## First\none\ntwo\n## Second\nthree\n### Nested\nfour\n## Third\nfive';

  it('slices from the heading to the next same-level heading', () => {
    expect(sliceHeadingSection(md, 'First')).toBe('## First\none\ntwo');
  });

  it('includes deeper-nested headings inside the section', () => {
    expect(sliceHeadingSection(md, 'Second')).toBe('## Second\nthree\n### Nested\nfour');
  });

  it('slices to the end for the last section', () => {
    expect(sliceHeadingSection(md, 'Third')).toBe('## Third\nfive');
  });

  it('returns full content when the heading is missing', () => {
    expect(sliceHeadingSection(md, 'Nope')).toBe(md);
  });

  it('ignores heading-looking lines inside code fences', () => {
    const fenced = '## Real\n```\n## Fake\n```\nafter\n## Next\nx';
    expect(sliceHeadingSection(fenced, 'Real')).toBe('## Real\n```\n## Fake\n```\nafter');
  });
});
