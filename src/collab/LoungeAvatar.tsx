import React from 'react';

// Avatar wire format: either an emoji string or 'av:N' (N = 0..99) referencing
// the bundled Codex-generated set at public/avatars/lounge/N.png.

export const AVATAR_IMAGE_COUNT = 100;

export function isImageAvatar(icon: string | undefined): boolean {
  if (!icon || !/^av:\d{1,3}$/.test(icon)) return false;
  return Number(icon.slice(3)) < AVATAR_IMAGE_COUNT;
}

export function avatarSrc(icon: string): string {
  return `/avatars/lounge/${icon.slice(3)}.png`;
}

export function LoungeAvatar({ icon, size = 20 }: { icon?: string; size?: number }) {
  if (isImageAvatar(icon)) {
    return (
      <img
        src={avatarSrc(icon!)}
        alt=""
        width={size}
        height={size}
        style={{ borderRadius: '30%', display: 'block', objectFit: 'cover' }}
        draggable={false}
      />
    );
  }
  return <span style={{ fontSize: size * 0.9, lineHeight: 1 }}>{icon || '🙂'}</span>;
}
