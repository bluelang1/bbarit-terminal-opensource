import { describe, it, expect } from 'vitest';
import { fileExt, isTiff, mimeForName, editedFileName } from './ImageViewer';

describe('fileExt', () => {
  it('returns lowercased extension', () => {
    expect(fileExt('Photo.PNG')).toBe('png');
    expect(fileExt('a.b.JPEG')).toBe('jpeg');
  });

  it('returns empty string when there is no extension', () => {
    expect(fileExt('README')).toBe('readme');
    expect(fileExt('')).toBe('');
  });
});

describe('isTiff', () => {
  it('detects tif and tiff regardless of case', () => {
    expect(isTiff('scan.tif')).toBe(true);
    expect(isTiff('scan.TIFF')).toBe(true);
  });

  it('rejects non-tiff images', () => {
    expect(isTiff('photo.png')).toBe(false);
    expect(isTiff('photo.jpg')).toBe(false);
  });
});

describe('mimeForName', () => {
  it('maps jpg/jpeg to image/jpeg', () => {
    expect(mimeForName('a.jpg')).toBe('image/jpeg');
    expect(mimeForName('a.JPEG')).toBe('image/jpeg');
  });

  it('maps webp to image/webp', () => {
    expect(mimeForName('a.webp')).toBe('image/webp');
  });

  it('falls back to image/png for png and unknown types', () => {
    expect(mimeForName('a.png')).toBe('image/png');
    expect(mimeForName('a.gif')).toBe('image/png');
    expect(mimeForName('noext')).toBe('image/png');
  });
});

describe('editedFileName', () => {
  it('inserts _edited before the extension', () => {
    expect(editedFileName('photo.png')).toBe('photo_edited.png');
    expect(editedFileName('my.photo.jpg')).toBe('my.photo_edited.jpg');
  });

  it('appends _edited when there is no extension', () => {
    expect(editedFileName('photo')).toBe('photo_edited');
  });

  it('treats a leading dot as no extension', () => {
    expect(editedFileName('.gitignore')).toBe('.gitignore_edited');
  });
});
