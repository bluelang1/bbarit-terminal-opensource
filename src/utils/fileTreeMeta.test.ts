import { describe, expect, it } from 'vitest';
import { countTextLines, countUtf8Bytes, extractExternalDropPathsFromDataTransfer, formatFileSize, isLineCountEligiblePath } from './fileTreeMeta';

describe('fileTreeMeta', () => {
  it('counts text lines safely', () => {
    expect(countTextLines('')).toBe(0);
    expect(countTextLines('one')).toBe(1);
    expect(countTextLines('one\ntwo\nthree')).toBe(3);
    expect(countUtf8Bytes('abc')).toBe(3);
  });

  it('detects line-count eligible paths', () => {
    expect(isLineCountEligiblePath('/tmp/test.ts')).toBe(true);
    expect(isLineCountEligiblePath('README')).toBe(true);
    expect(isLineCountEligiblePath('/tmp/image.png')).toBe(false);
  });

  it('extracts native file paths from dropped files first', () => {
    const paths = extractExternalDropPathsFromDataTransfer({
      files: [
        { path: '/tmp/a.txt' },
        { path: '/tmp/b.md' },
      ],
      getData: () => '',
    });
    expect(paths).toEqual(['/tmp/a.txt', '/tmp/b.md']);
  });

  it('falls back to text/uri-list file urls', () => {
    const paths = extractExternalDropPathsFromDataTransfer({
      files: [],
      getData: (type: string) => type === 'text/uri-list' ? 'file:///Users/me/test.md\n#comment\nfile:///Users/me/notes.txt' : '',
    });
    expect(paths).toEqual(['/Users/me/test.md', '/Users/me/notes.txt']);
  });

  it('accepts windows file paths from plain text drops', () => {
    const paths = extractExternalDropPathsFromDataTransfer({
      files: [],
      getData: (type: string) => type === 'text/plain' ? 'C:\\Users\\me\\Desktop\\note.md' : '',
    });
    expect(paths).toEqual(['C:\\Users\\me\\Desktop\\note.md']);
  });

  it('normalizes windows file uris from plain text drops', () => {
    const paths = extractExternalDropPathsFromDataTransfer({
      files: [],
      getData: (type: string) => type === 'text/plain' ? 'file:///C:/Users/me/Desktop/note.md' : '',
    });
    expect(paths).toEqual(['C:/Users/me/Desktop/note.md']);
  });

  it('formats file size labels', () => {
    expect(formatFileSize(999)).toBe('999B');
    expect(formatFileSize(1536)).toBe('1.5KB');
    expect(formatFileSize(1024 * 1024)).toBe('1.0MB');
  });
});
