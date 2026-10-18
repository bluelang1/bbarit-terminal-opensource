import { describe, expect, it } from 'vitest';
import {
  buildCodexImageJobPrompt,
  parseCustomSize,
  planBatchOutputs,
  planEditOutput,
  resizedOutputPath,
  runWithConcurrency,
} from './bbaritImageStudio';

describe('parseCustomSize', () => {
  it('parses x, ×, and * separators with spaces', () => {
    expect(parseCustomSize('1200x630')).toEqual({ w: 1200, h: 630 });
    expect(parseCustomSize('1080 × 1920')).toEqual({ w: 1080, h: 1920 });
    expect(parseCustomSize('800 * 600')).toEqual({ w: 800, h: 600 });
  });

  it('rejects malformed or out-of-range sizes', () => {
    expect(parseCustomSize('')).toBeNull();
    expect(parseCustomSize('big')).toBeNull();
    expect(parseCustomSize('1200')).toBeNull();
    expect(parseCustomSize('10x10')).toBeNull();
    expect(parseCustomSize('9000x100')).toBeNull();
  });
});

describe('planBatchOutputs', () => {
  it('creates one path per requested image inside the session dir', () => {
    const paths = planBatchOutputs('/tmp/session/', '귀여운 강아지 로고', 3, 1234);
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
    for (const p of paths) {
      expect(p.startsWith('/tmp/session/')).toBe(true);
      expect(p.endsWith('.png')).toBe(true);
      expect(p).not.toContain('//');
    }
  });

  it('sanitizes unsafe filename characters from the prompt', () => {
    const [p] = planBatchOutputs('/d', 'a/b:c*d?"<>|', 1, 7);
    const name = p.split('/').pop() || '';
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('falls back to a generic name for empty prompts', () => {
    const [p] = planBatchOutputs('/d', '   ', 1, 7);
    expect(p.split('/').pop()).toMatch(/^image-/);
  });
});

describe('planEditOutput', () => {
  it('appends " edit 1" next to the source image', () => {
    expect(planEditOutput('/d/cat.png', [])).toBe('/d/cat edit 1.png');
  });

  it('skips taken edit numbers', () => {
    expect(planEditOutput('/d/cat.png', ['/d/cat edit 1.png'])).toBe('/d/cat edit 2.png');
  });

  it('does not stack edit suffixes when editing an edit', () => {
    expect(planEditOutput('/d/cat edit 2.png', ['/d/cat edit 1.png', '/d/cat edit 2.png'])).toBe('/d/cat edit 3.png');
  });
});

describe('resizedOutputPath', () => {
  it('embeds the target size before the extension', () => {
    expect(resizedOutputPath('/d/cat.png', 512, 512)).toBe('/d/cat 512x512.png');
  });

  it('handles dotted directories without an extension on the file', () => {
    expect(resizedOutputPath('/d.v2/cat', 100, 200)).toBe('/d.v2/cat 100x200.png');
  });
});

describe('buildCodexImageJobPrompt', () => {
  it('includes the output path, exact size, and user prompt', () => {
    const text = buildCodexImageJobPrompt({ outPath: '/d/a.png', prompt: 'a red fox', w: 1024, h: 768 });
    expect(text).toContain('/d/a.png');
    expect(text).toContain('1024x768');
    expect(text).toContain('a red fox');
    expect(text).not.toContain('Edit source image');
  });

  it('adds the edit source and variation hints when present', () => {
    const text = buildCodexImageJobPrompt({
      outPath: '/d/a.png', prompt: 'make it blue', w: 512, h: 512,
      refPath: '/d/src.png', variation: { index: 2, total: 4 },
    });
    expect(text).toContain('/d/src.png');
    expect(text).toContain('variation 2 of 4');
  });

  it('omits the variation hint for single-image jobs', () => {
    const text = buildCodexImageJobPrompt({
      outPath: '/d/a.png', prompt: 'p', w: 512, h: 512, variation: { index: 1, total: 1 },
    });
    expect(text).not.toContain('variation');
  });

  it('lists reference images and the preset style rules', () => {
    const text = buildCodexImageJobPrompt({
      outPath: '/d/a.png', prompt: 'p', w: 512, h: 512,
      refImages: ['/d/refs/logo.png', '/d/refs/mood.png'],
      system: 'Keep the SAME design system across sections.',
    });
    expect(text).toContain('/d/refs/logo.png');
    expect(text).toContain('/d/refs/mood.png');
    expect(text).toContain('Style rules');
    expect(text).toContain('SAME design system');
  });

  it('uses the section hint (not variation) for series jobs', () => {
    const text = buildCodexImageJobPrompt({
      outPath: '/d/a.png', prompt: 'p', w: 512, h: 512,
      section: { index: 2, total: 3 }, variation: { index: 2, total: 3 },
    });
    expect(text).toContain('section 2 of 3');
    expect(text).not.toContain('variation 2 of 3');
  });
});

describe('runWithConcurrency', () => {
  it('preserves result order and captures failures per item', async () => {
    const results = await runWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      if (n === 3) throw new Error('boom');
      return n * 10;
    });
    expect(results[0]).toEqual({ ok: true, value: 10 });
    expect(results[1]).toEqual({ ok: true, value: 20 });
    expect(results[2]).toEqual({ ok: false, error: 'boom' });
    expect(results[3]).toEqual({ ok: true, value: 40 });
  });

  it('never runs more than the cap at once', async () => {
    let active = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
