import { describe, expect, it } from 'vitest';
import {
  parseBookManifest,
  serializeBookManifest,
  createStarterManifest,
  bookDir,
  joinBookPath,
  resolveChapterPath,
  nextChapterFile,
  countWords,
  imageExt,
} from './BookStudio';

describe('parseBookManifest', () => {
  it('parses a full manifest and normalizes optional fields', () => {
    const json = JSON.stringify({
      title: 'My Book',
      author: 'Jane',
      language: 'ko',
      publisher: 'Acme',
      publishedDate: '2026-01-01',
      identifier: 'urn:uuid:x',
      cover: { mode: 'image', theme: 'sage', imagePath: 'cover.png' },
      style: { fontFamily: 'sans-serif', lineHeight: 1.5, chapterSplit: 'h1' },
      frontMatter: { titlePage: false, colophon: true, tocPage: false },
      chapters: [{ id: 'a', title: 'One', file: 'chapters/1.md' }],
    });
    const m = parseBookManifest(json);
    expect(m.title).toBe('My Book');
    expect(m.cover).toEqual({ mode: 'image', theme: 'sage', imagePath: 'cover.png' });
    expect(m.style).toEqual({ fontFamily: 'sans-serif', lineHeight: 1.5, chapterSplit: 'h1' });
    expect(m.frontMatter).toEqual({ titlePage: false, colophon: true, tocPage: false });
    expect(m.chapters).toHaveLength(1);
  });

  it('fills defaults for a minimal manifest', () => {
    const m = parseBookManifest(JSON.stringify({ chapters: [{ title: 'C', file: 'chapters/c.md' }] }));
    expect(m.title).toBe('Untitled Book');
    expect(m.language).toBe('en');
    expect(m.cover).toEqual({ mode: 'theme', theme: 'ink', imagePath: undefined });
    expect(m.style).toEqual({ fontFamily: 'serif', lineHeight: 1.7, chapterSplit: 'file' });
    expect(m.frontMatter).toEqual({ titlePage: true, colophon: true, tocPage: true });
    expect(m.chapters[0].id).toMatch(/^ch-/); // synthesized id
  });

  it('rejects an unknown cover theme and bad chapterSplit by falling back', () => {
    const m = parseBookManifest(JSON.stringify({ cover: { theme: 'neon' }, style: { chapterSplit: 'weird' }, chapters: [] }));
    expect(m.cover.theme).toBe('ink');
    expect(m.style.chapterSplit).toBe('file');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseBookManifest('{ not json')).toThrow(/not valid JSON/);
  });

  it('throws when chapters is not an array', () => {
    expect(() => parseBookManifest(JSON.stringify({ title: 'x' }))).toThrow(/chapters.*array/);
  });

  it('throws when a chapter has no file', () => {
    expect(() => parseBookManifest(JSON.stringify({ chapters: [{ title: 'x' }] }))).toThrow(/missing a "file"/);
  });

  it('throws on a non-object root', () => {
    expect(() => parseBookManifest('[]')).toThrow(/must be a JSON object/);
  });
});

describe('serializeBookManifest', () => {
  it('round-trips through parse', () => {
    const original = createStarterManifest('Round Trip', 'Author');
    const back = parseBookManifest(serializeBookManifest(original));
    expect(back.title).toBe('Round Trip');
    expect(back.author).toBe('Author');
    expect(back.chapters).toHaveLength(1);
    expect(back.chapters[0].file).toBe('chapters/chapter-1.md');
  });

  it('omits imagePath when absent', () => {
    const m = createStarterManifest('T', '');
    expect(serializeBookManifest(m)).not.toContain('imagePath');
  });

  it('ends with a trailing newline', () => {
    expect(serializeBookManifest(createStarterManifest('T', ''))).toMatch(/\n$/);
  });
});

describe('path helpers', () => {
  it('bookDir returns the folder for posix and windows paths', () => {
    expect(bookDir('/Users/me/books/my.bbook')).toBe('/Users/me/books');
    expect(bookDir('C:\\Users\\me\\my.bbook')).toBe('C:\\Users\\me');
    expect(bookDir('nofolder.bbook')).toBe('');
  });

  it('joinBookPath uses the folder separator and strips leading slashes', () => {
    expect(joinBookPath('/a/b', 'chapters/1.md')).toBe('/a/b/chapters/1.md');
    expect(joinBookPath('C:\\a\\b', 'chapters/1.md')).toBe('C:\\a\\b\\chapters\\1.md');
    expect(joinBookPath('/a/b', '/leading.md')).toBe('/a/b/leading.md');
    expect(joinBookPath('', 'rel.md')).toBe('rel.md');
  });

  it('resolveChapterPath joins a chapter onto the manifest folder', () => {
    expect(resolveChapterPath('/books/x.bbook', 'chapters/1.md')).toBe('/books/chapters/1.md');
    expect(resolveChapterPath('D:\\books\\x.bbook', 'chapters/1.md')).toBe('D:\\books\\chapters\\1.md');
  });
});

describe('nextChapterFile', () => {
  it('starts at chapter-1 when empty', () => {
    expect(nextChapterFile([])).toBe('chapters/chapter-1.md');
  });

  it('skips existing files case-insensitively', () => {
    expect(nextChapterFile(['chapters/chapter-1.md', 'chapters/Chapter-2.md'])).toBe('chapters/chapter-3.md');
  });
});

describe('countWords', () => {
  it('counts words separated by any whitespace', () => {
    expect(countWords('hello   world\nfoo')).toBe(3);
  });
  it('returns 0 for empty or whitespace', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n ')).toBe(0);
  });
});

describe('imageExt', () => {
  it('extracts a lowercase extension', () => {
    expect(imageExt('cover.PNG')).toBe('png');
    expect(imageExt('a.jpeg')).toBe('jpeg');
  });
  it('defaults to png when missing or odd', () => {
    expect(imageExt('noext')).toBe('png');
    expect(imageExt('weird.tar.gz')).toBe('gz');
  });
});
