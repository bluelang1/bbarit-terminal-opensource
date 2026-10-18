import { describe, expect, it } from 'vitest';
import { parseMermaidErrorLine } from './MermaidFileEditor';

describe('parseMermaidErrorLine', () => {
  it('reads the line from a standard parse error', () => {
    expect(parseMermaidErrorLine('Parse error on line 3:\n...')).toBe(3);
  });

  it('reads the line from a lexical error', () => {
    expect(parseMermaidErrorLine('Lexical error on line 12. Unrecognized text.')).toBe(12);
  });

  it('reads a line reported with a colon', () => {
    expect(parseMermaidErrorLine('Error at line: 7')).toBe(7);
  });

  it('returns null when no line is present', () => {
    expect(parseMermaidErrorLine('Something went wrong')).toBeNull();
  });

  it('returns null for an empty message', () => {
    expect(parseMermaidErrorLine('')).toBeNull();
  });

  it('ignores non-positive line numbers', () => {
    expect(parseMermaidErrorLine('error on line 0')).toBeNull();
  });
});
