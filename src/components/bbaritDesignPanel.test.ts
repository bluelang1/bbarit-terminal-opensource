import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { resolveRelativeAssets } from './BbaritDesignPanel';

const DIR = '/proj/makeke/bbarit-design/2026-07-07T00-00-00';

describe('resolveRelativeAssets', () => {
  it('rewrites relative image src to the asset protocol', () => {
    const out = resolveRelativeAssets('<img src="hero.png">', DIR);
    expect(out).toBe(`<img src="asset://localhost/${encodeURIComponent(`${DIR}/hero.png`)}">`);
  });

  it('rewrites absolute filesystem paths without doubling the dir', () => {
    const out = resolveRelativeAssets('<img src="/abs/logo.svg">', DIR);
    expect(out).toContain(encodeURIComponent('/abs/logo.svg'));
    expect(out).not.toContain(encodeURIComponent(`${DIR}//abs`));
  });

  it('leaves data URLs, http URLs, and anchors untouched', () => {
    const html = '<img src="data:image/png;base64,AA"><a href="#top">t</a><img src="https://x.io/a.png">';
    expect(resolveRelativeAssets(html, DIR)).toBe(html);
  });

  it('leaves non-media relative hrefs (scripts, pages) untouched', () => {
    const html = '<a href="other.html">next</a><script src="app.js"></script>';
    expect(resolveRelativeAssets(html, DIR)).toBe(html);
  });

  it('rewrites video and font references', () => {
    const out = resolveRelativeAssets('<source src="clip.mp4"><link href="f.woff2">', DIR);
    expect(out).toContain(encodeURIComponent(`${DIR}/clip.mp4`));
    expect(out).toContain(encodeURIComponent(`${DIR}/f.woff2`));
  });

  it('handles single-quoted attributes', () => {
    const out = resolveRelativeAssets("<img src='p 1.jpg'>", DIR);
    expect(out).toContain(encodeURIComponent(`${DIR}/p 1.jpg`));
  });

  it('returns empty string for empty input', () => {
    expect(resolveRelativeAssets('', DIR)).toBe('');
  });
});
