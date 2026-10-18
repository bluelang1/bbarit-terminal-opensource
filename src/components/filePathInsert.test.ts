import { describe, it, expect } from 'vitest';
import { isImagePath, looksLikeFilePath, toRelativePath, insertTextAtSelection } from './filePathInsert';

describe('isImagePath', () => {
  it('detects common image extensions case-insensitively', () => {
    expect(isImagePath('/a/b/pic.png')).toBe(true);
    expect(isImagePath('/a/b/pic.JPG')).toBe(true);
    expect(isImagePath('/a/b/pic.jpeg')).toBe(true);
    expect(isImagePath('C:/x/y.webp')).toBe(true);
    expect(isImagePath('  /a/logo.svg  ')).toBe(true);
  });
  it('rejects non-image paths', () => {
    expect(isImagePath('/a/b/main.ts')).toBe(false);
    expect(isImagePath('/a/b/README.md')).toBe(false);
    expect(isImagePath('/a/b/pngfile')).toBe(false);
  });
});

describe('looksLikeFilePath', () => {
  it('accepts absolute unix, home, windows drive and UNC paths', () => {
    expect(looksLikeFilePath('/Users/me/file.ts')).toBe(true);
    expect(looksLikeFilePath('~/notes/todo.md')).toBe(true);
    expect(looksLikeFilePath('C:\\Users\\me\\file.ts')).toBe(true);
    expect(looksLikeFilePath('D:/data/x.txt')).toBe(true);
    expect(looksLikeFilePath('\\\\server\\share\\f.txt')).toBe(true);
  });
  it('rejects ordinary text, relative paths, and multiline content', () => {
    expect(looksLikeFilePath('just some words')).toBe(false);
    expect(looksLikeFilePath('relative/path.ts')).toBe(false);
    expect(looksLikeFilePath('')).toBe(false);
    expect(looksLikeFilePath('/a/b\n/c/d')).toBe(false);
  });
});

describe('toRelativePath', () => {
  it('strips the project root and leading separator', () => {
    expect(toRelativePath('/proj/src/a.ts', '/proj')).toBe('src/a.ts');
    expect(toRelativePath('C:\\proj\\src\\a.ts', 'C:\\proj')).toBe('src\\a.ts');
  });
  it('returns the absolute path when root is missing or unrelated', () => {
    expect(toRelativePath('/proj/src/a.ts')).toBe('/proj/src/a.ts');
    expect(toRelativePath('/other/a.ts', '/proj')).toBe('/other/a.ts');
  });
});

describe('insertTextAtSelection', () => {
  it('appends to empty text without leading space', () => {
    const r = insertTextAtSelection('', 0, 0, '/a/b.ts');
    expect(r.text).toBe('/a/b.ts');
    expect(r.cursor).toBe('/a/b.ts'.length);
  });
  it('adds a separating space when appending after non-space text', () => {
    const r = insertTextAtSelection('hello', 5, 5, '/a/b.ts');
    expect(r.text).toBe('hello /a/b.ts');
    expect(r.cursor).toBe('hello /a/b.ts'.length);
  });
  it('does not double a space that already precedes the caret', () => {
    const r = insertTextAtSelection('hello ', 6, 6, '/a/b.ts');
    expect(r.text).toBe('hello /a/b.ts');
  });
  it('inserts in the middle with spaces on both sides and caret after the path', () => {
    const r = insertTextAtSelection('ab', 1, 1, 'X');
    expect(r.text).toBe('a X b');
    expect(r.cursor).toBe('a X'.length);
  });
  it('replaces the current selection', () => {
    const r = insertTextAtSelection('hello world', 6, 11, '/p');
    expect(r.text).toBe('hello /p');
    expect(r.cursor).toBe('hello /p'.length);
  });
  it('clamps out-of-range selection indices', () => {
    const r = insertTextAtSelection('abc', 99, 99, 'Z');
    expect(r.text).toBe('abc Z');
  });
});
