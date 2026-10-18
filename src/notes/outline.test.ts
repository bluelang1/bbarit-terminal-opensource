import { describe, expect, it } from 'vitest';
import { parseOutline } from './outline';

describe('parseOutline', () => {
  it('parses headings with level and 1-based line numbers', () => {
    const md = '# One\ntext\n## Two\n### Three';
    expect(parseOutline(md)).toEqual([
      { level: 1, text: 'One', line: 1 },
      { level: 2, text: 'Two', line: 3 },
      { level: 3, text: 'Three', line: 4 },
    ]);
  });

  it('skips headings inside code fences', () => {
    const md = '# Real\n```\n# Fake\n```\n## After';
    expect(parseOutline(md).map(h => h.text)).toEqual(['Real', 'After']);
  });

  it('returns empty array for content without headings', () => {
    expect(parseOutline('just text\nmore text')).toEqual([]);
  });
});
