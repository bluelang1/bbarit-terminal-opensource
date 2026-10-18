import { describe, expect, it, vi } from 'vitest';
import { copyFileTreePathToClipboard, shouldHandoffFileTreeDragToNative } from './fileTreeInteractions';

describe('copyFileTreePathToClipboard', () => {
  it('stops after the preferred writer succeeds', async () => {
    const preferred = vi.fn(async () => {});
    const fallback = vi.fn(async () => {});

    await expect(copyFileTreePathToClipboard('/project/file.ts', [preferred, fallback])).resolves.toBe(true);
    expect(preferred).toHaveBeenCalledWith('/project/file.ts');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back in order when a clipboard backend fails', async () => {
    const calls: string[] = [];
    const plugin = vi.fn(async () => { calls.push('plugin'); throw new Error('denied'); });
    const invoke = vi.fn(async () => { calls.push('invoke'); });
    const browser = vi.fn(async () => { calls.push('browser'); });

    await expect(copyFileTreePathToClipboard('/project/file.ts', [plugin, invoke, browser])).resolves.toBe(true);
    expect(calls).toEqual(['plugin', 'invoke']);
    expect(browser).not.toHaveBeenCalled();
  });

  it('reports failure when every backend fails', async () => {
    const fail = async () => { throw new Error('failed'); };
    await expect(copyFileTreePathToClipboard('/project/file.ts', [fail, fail])).resolves.toBe(false);
  });
});

describe('shouldHandoffFileTreeDragToNative', () => {
  it('keeps the custom drag active over an in-app terminal outside the sidebar', () => {
    expect(shouldHandoffFileTreeDragToNative(900, 500, 1400, 900)).toBe(false);
  });

  it('hands off only when the pointer reaches the app viewport edge', () => {
    expect(shouldHandoffFileTreeDragToNative(1, 500, 1400, 900)).toBe(true);
    expect(shouldHandoffFileTreeDragToNative(1398, 500, 1400, 900)).toBe(true);
    expect(shouldHandoffFileTreeDragToNative(700, 899, 1400, 900)).toBe(true);
  });
});
