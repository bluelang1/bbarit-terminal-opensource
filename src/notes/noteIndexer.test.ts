import { describe, expect, it } from 'vitest';
import { buildBacklinkIndex, parseNoteContent } from './noteIndexer';
import type { NoteIndexEntry } from './noteState';

function makeEntry(partial: Partial<NoteIndexEntry> & { path: string; name: string }): NoteIndexEntry {
  return {
    title: partial.name,
    frontmatter: null,
    tags: [],
    outgoingLinks: [],
    incomingLinks: [],
    modifiedAt: '2026-01-01T00:00:00.000Z',
    size: 0,
    excerpt: '',
    ...partial,
  };
}

describe('parseNoteContent', () => {
  it('extracts frontmatter aliases (array and scalar)', () => {
    const arr = parseNoteContent('---\naliases: [foo, bar]\n---\nbody', 'n');
    expect(arr.aliases).toEqual(['foo', 'bar']);

    const scalar = parseNoteContent('---\nalias: baz\n---\nbody', 'n');
    expect(scalar.aliases).toEqual(['baz']);
  });

  it('extracts headings in order, skipping code fences', () => {
    const md = '# Title\n\n```\n# not a heading\n```\n\n## Second\n### Third\n';
    const parsed = parseNoteContent(md, 'n');
    expect(parsed.headings).toEqual(['Title', 'Second', 'Third']);
  });

  it('strips heading part from outgoing links', () => {
    const parsed = parseNoteContent('see [[target#section]] and ![[embed target]]', 'n');
    expect(parsed.outgoingLinks).toEqual(['target', 'embed target']);
  });
});

describe('buildBacklinkIndex with aliases', () => {
  it('resolves links written with an alias to the aliased note', () => {
    const target = makeEntry({ path: '/v/target.md', name: 'target', aliases: ['별칭'] });
    const source = makeEntry({ path: '/v/source.md', name: 'source', outgoingLinks: ['별칭'] });
    const index = buildBacklinkIndex(
      { '/v/source.md': ['별칭'], '/v/target.md': [] },
      [target, source],
    );
    expect(index['/v/target.md']).toEqual(['/v/source.md']);
  });
});
