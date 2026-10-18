import { describe, expect, it } from 'vitest';
import { exportSlidesToSlidevMarkdown, parseSlidevMarkdown } from './slidevMarkdown';
import { createBlankSlide } from './types';

describe('slidev markdown transition metadata', () => {
  it('exports and parses slide transition comments', () => {
    const slide = {
      ...createBlankSlide(),
      title: 'Transition Slide',
      transition: { type: 'wipe' as const, durationMs: 800, advanceAfterSec: 5 },
      elements: [
        { id: 'title', type: 'text' as const, x: 8, y: 8, w: 80, h: 10, text: 'Transition Slide', fontSize: 30 },
      ],
    };

    const markdown = exportSlidesToSlidevMarkdown([slide]);
    expect(markdown).toContain('<!-- transition: wipe 800ms auto=5s -->');

    const parsed = parseSlidevMarkdown(markdown);
    expect(parsed[0].transition).toEqual({ type: 'wipe', durationMs: 800, advanceAfterSec: 5 });
  });
});
