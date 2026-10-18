import { describe, expect, it } from 'vitest';
import { loadNotifiedLoungeRooms, sanitizeUnreadCounts, totalLoungeUnread } from './loungeNotifications';
import { markLoungeMessagesSelf, type LoungeMessage } from './loungeClient';

describe('lounge unread counts', () => {
  it('keeps only positive integer room counts', () => {
    expect(sanitizeUnreadCounts({ general: 3.9, private: '2', empty: 0, bad: -4, nope: 'x' })).toEqual({
      general: 3,
      private: 2,
    });
  });

  it('calculates the toolbar total across rooms', () => {
    expect(totalLoungeUnread({ general: 2, design: 4 })).toBe(6);
  });

  it('keeps room notifications off by default', () => {
    expect([...loadNotifiedLoungeRooms()]).toEqual([]);
  });

  it('recognizes my replayed messages by account tag', () => {
    const messages: LoungeMessage[] = [
      { seq: 1, id: 'mine', from: { name: 'me', tag: 'mine' }, text: 'hello', ts: 1 },
      { seq: 2, id: 'theirs', from: { name: 'you', tag: 'theirs' }, text: 'hi', ts: 2 },
    ];
    expect(markLoungeMessagesSelf(messages, 'mine').map((message) => !!message.self)).toEqual([true, false]);
  });
});
