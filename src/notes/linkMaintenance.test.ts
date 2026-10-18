import { describe, expect, it } from 'vitest';
import { rewriteWikiLinks } from './linkMaintenance';

describe('rewriteWikiLinks', () => {
  it('rewrites plain links to the new name', () => {
    const { content, count } = rewriteWikiLinks('see [[old note]] here', 'old note', 'new note');
    expect(content).toBe('see [[new note]] here');
    expect(count).toBe(1);
  });

  it('preserves alias when rewriting', () => {
    const { content } = rewriteWikiLinks('[[old note|shown text]]', 'old note', 'new note');
    expect(content).toBe('[[new note|shown text]]');
  });

  it('preserves heading when rewriting', () => {
    const { content } = rewriteWikiLinks('[[old note#Section One]]', 'old note', 'new note');
    expect(content).toBe('[[new note#Section One]]');
  });

  it('preserves embed prefix when rewriting', () => {
    const { content } = rewriteWikiLinks('![[old note]]', 'old note', 'new note');
    expect(content).toBe('![[new note]]');
  });

  it('matches case-insensitively but keeps other links untouched', () => {
    const { content, count } = rewriteWikiLinks(
      '[[Old Note]] and [[other]] and [[old note#h|a]]',
      'old note',
      'renamed',
    );
    expect(content).toBe('[[renamed]] and [[other]] and [[renamed#h|a]]');
    expect(count).toBe(2);
  });

  it('does not rewrite partial name matches', () => {
    const { content, count } = rewriteWikiLinks('[[old note 2]]', 'old note', 'new note');
    expect(content).toBe('[[old note 2]]');
    expect(count).toBe(0);
  });

  it('leaves markdown links alone', () => {
    const { content, count } = rewriteWikiLinks('[old note](./old%20note.md)', 'old note', 'new');
    expect(content).toBe('[old note](./old%20note.md)');
    expect(count).toBe(0);
  });
});
