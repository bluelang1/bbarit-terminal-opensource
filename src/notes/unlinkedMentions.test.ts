import { describe, expect, it } from 'vitest';
import { lineHasUnlinkedMention, mentionTerms } from './unlinkedMentions';

describe('lineHasUnlinkedMention', () => {
  it('detects a plain-text mention', () => {
    expect(lineHasUnlinkedMention('I worked on project alpha today', 'project alpha')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(lineHasUnlinkedMention('See Project Alpha notes', 'project alpha')).toBe(true);
  });

  it('ignores mentions that are already wikilinks', () => {
    expect(lineHasUnlinkedMention('see [[project alpha]] for details', 'project alpha')).toBe(false);
    expect(lineHasUnlinkedMention('see [[project alpha|the plan]]', 'project alpha')).toBe(false);
    expect(lineHasUnlinkedMention('embed ![[project alpha]]', 'project alpha')).toBe(false);
  });

  it('detects a mention next to an unrelated wikilink', () => {
    expect(lineHasUnlinkedMention('[[other]] and project alpha', 'project alpha')).toBe(true);
  });
});

describe('mentionTerms', () => {
  it('dedupes name/title/aliases and drops short terms', () => {
    expect(mentionTerms('note', 'note', ['My Alias', 'ab'])).toEqual(['note', 'My Alias']);
  });
});
