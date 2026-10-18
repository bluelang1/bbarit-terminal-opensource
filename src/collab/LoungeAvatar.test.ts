import { describe, expect, it } from 'vitest';
import { AVATAR_IMAGE_COUNT, avatarSrc, isImageAvatar } from './LoungeAvatar';

describe('avatar wire format', () => {
  it('recognizes av:N ids and maps them to bundled files', () => {
    expect(isImageAvatar('av:0')).toBe(true);
    expect(isImageAvatar(`av:${AVATAR_IMAGE_COUNT - 1}`)).toBe(true);
    expect(avatarSrc('av:42')).toBe('/avatars/lounge/42.png');
  });

  it('treats emoji and junk as non-image avatars', () => {
    expect(isImageAvatar('🦊')).toBe(false);
    expect(isImageAvatar(undefined)).toBe(false);
    expect(isImageAvatar('av:')).toBe(false);
    expect(isImageAvatar('av:9999')).toBe(false);
    expect(isImageAvatar(`av:${AVATAR_IMAGE_COUNT}`)).toBe(false); // out of range → text fallback
    expect(isImageAvatar('av:1x')).toBe(false);
  });

  it('every bundled id stays within the 16-char icon wire limit', () => {
    for (let i = 0; i < AVATAR_IMAGE_COUNT; i += 1) {
      expect(`av:${i}`.length).toBeLessThanOrEqual(16);
    }
  });
});
