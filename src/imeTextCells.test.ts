import { describe, expect, it } from 'vitest';
import { imeTextCells } from './imeTextCells';

// The preedit anchor advances by exactly this many cells on each IME commit;
// a wrong width re-creates the "composition drifts forward/overlaps" bug.
describe('imeTextCells', () => {
  it('counts Hangul syllables as two cells', () => {
    expect(imeTextCells('한')).toBe(2);
    expect(imeTextCells('안녕하세요')).toBe(10);
  });

  it('counts ASCII as one cell', () => {
    expect(imeTextCells('a')).toBe(1);
    expect(imeTextCells('hello!')).toBe(6);
  });

  it('handles mixed Hangul + ASCII commits', () => {
    // Typical mid-sentence commit: "한a" → 2 + 1
    expect(imeTextCells('한a')).toBe(3);
    expect(imeTextCells('빠릿 agent')).toBe(4 + 1 + 5);
  });

  it('counts CJK ideographs and fullwidth forms as two cells', () => {
    expect(imeTextCells('漢')).toBe(2);
    expect(imeTextCells('日本語')).toBe(6);
    expect(imeTextCells('Ａ')).toBe(2); // fullwidth A
  });

  it('counts Hangul jamo (leading consonants) as two cells', () => {
    // Dubeolsik composes through bare jamo like "ㄴ" (U+1100 block feeds
    // some IMEs; compatibility jamo U+3131.. are in the 2e80..a4cf range).
    expect(imeTextCells('ㄴ')).toBe(2);
    expect(imeTextCells('ㅎ')).toBe(2);
  });

  it('handles empty and supplementary-plane input', () => {
    expect(imeTextCells('')).toBe(0);
    expect(imeTextCells('𠀀')).toBe(2); // CJK extension B (surrogate pair)
  });
});
