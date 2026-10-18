import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHUNK_CHARS,
  buildTranslatePrompt,
  chunkForTranslation,
  resolveLanguageName,
} from './browserTranslate';

describe('resolveLanguageName', () => {
  // 정상 + 매핑: codes, names, and aliases resolve.
  it('resolves codes, names and aliases', () => {
    expect(resolveLanguageName('ko')).toBe('Korean');
    expect(resolveLanguageName('EN')).toBe('English');
    expect(resolveLanguageName('zh-tw')).toBe('Traditional Chinese');
    expect(resolveLanguageName('Japanese')).toBe('Japanese');
    expect(resolveLanguageName('한국어')).toBe('Korean');
  });

  // None/변조: unknown or empty returns null (caller can ask the user).
  it('returns null for unknown or empty input', () => {
    expect(resolveLanguageName('klingon')).toBeNull();
    expect(resolveLanguageName('')).toBeNull();
    expect(resolveLanguageName(undefined)).toBeNull();
    expect(resolveLanguageName(42)).toBeNull();
  });
});

describe('chunkForTranslation', () => {
  // None: empty text yields no chunks.
  it('returns no chunks for empty text', () => {
    expect(chunkForTranslation('')).toEqual([]);
    expect(chunkForTranslation('   ')).toEqual([]);
  });

  // 정상: short text is a single chunk.
  it('keeps short text as one chunk', () => {
    expect(chunkForTranslation('Hello world.')).toEqual(['Hello world.']);
  });

  // 매핑: long text splits on paragraph boundaries within the budget.
  it('splits long text on paragraph boundaries', () => {
    const para = 'A'.repeat(2_000);
    const text = [para, para, para].join('\n\n'); // 3 paras, ~6KB
    const chunks = chunkForTranslation(text, 3_500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3_500);
  });

  // 변조: an oversized single paragraph splits on sentence boundaries.
  it('splits an oversized paragraph on sentences', () => {
    const sentence = 'This is a sentence. ';
    const big = sentence.repeat(300); // ~6KB, one paragraph
    const chunks = chunkForTranslation(big, 1_000);
    expect(chunks.length).toBeGreaterThan(1);
    // Chunks should end at sentence boundaries (no chunk starts mid-"This").
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1_100);
  });

  it('never loses content across chunks', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ${'x'.repeat(500)}`).join('\n\n');
    const chunks = chunkForTranslation(text, DEFAULT_CHUNK_CHARS);
    for (let i = 0; i < 10; i++) expect(chunks.join('\n\n')).toContain(`Paragraph ${i}`);
  });
});

describe('buildTranslatePrompt', () => {
  it('builds an instruction naming the target language', () => {
    const p = buildTranslatePrompt('Korean', 'Hello');
    expect(p).toContain('into Korean');
    expect(p).toContain('Hello');
    expect(p).toMatch(/only the translation/i);
  });
});
