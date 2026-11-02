import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  PASTE_CHUNK_SIZE,
  splitPasteChunks,
  stripBracketedPasteEnd,
  writePasteChunked,
} from './pasteChunks';

afterEach(() => { vi.useRealTimers(); });

describe('splitPasteChunks', () => {
  it('keeps short text in one chunk and returns nothing for empty text', () => {
    expect(splitPasteChunks('')).toEqual([]);
    expect(splitPasteChunks('hello')).toEqual(['hello']);
    expect(splitPasteChunks('x'.repeat(PASTE_CHUNK_SIZE))).toHaveLength(1);
  });

  it('splits long text into 4096-char chunks that join back losslessly', () => {
    const text = 'a'.repeat(PASTE_CHUNK_SIZE * 2 + 10);
    const chunks = splitPasteChunks(text);
    expect(chunks.map((c) => c.length)).toEqual([PASTE_CHUNK_SIZE, PASTE_CHUNK_SIZE, 10]);
    expect(chunks.join('')).toBe(text);
  });

  it('never splits a surrogate pair across chunks', () => {
    const text = 'a'.repeat(PASTE_CHUNK_SIZE - 1) + '😀' + 'b';
    const chunks = splitPasteChunks(text);
    expect(chunks[0]).toHaveLength(PASTE_CHUNK_SIZE - 1);
    expect(chunks[1].startsWith('😀')).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});

describe('stripBracketedPasteEnd', () => {
  it('removes every embedded end marker', () => {
    expect(stripBracketedPasteEnd(`a${BRACKETED_PASTE_END}b${BRACKETED_PASTE_END}`)).toBe('ab');
  });
});

describe('writePasteChunked', () => {
  it('wraps short text in bracketed paste markers as separate writes', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const done = writePasteChunked((d) => writes.push(d), 'hi');
    await vi.runAllTimersAsync();
    await done;
    expect(writes).toEqual([BRACKETED_PASTE_START, 'hi', BRACKETED_PASTE_END]);
  });

  it('writes long text in chunks and skips markers when bracketed paste is off', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const text = 'z'.repeat(PASTE_CHUNK_SIZE + 5);
    const done = writePasteChunked((d) => writes.push(d), text, false);
    await vi.runAllTimersAsync();
    await done;
    expect(writes).toEqual(['z'.repeat(PASTE_CHUNK_SIZE), 'zzzzz']);
  });

  it('does nothing for empty text', async () => {
    const writes: string[] = [];
    await writePasteChunked((d) => writes.push(d), '');
    expect(writes).toEqual([]);
  });
});
