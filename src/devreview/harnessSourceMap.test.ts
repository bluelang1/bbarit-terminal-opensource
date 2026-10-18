import { describe, expect, it } from 'vitest';
import { HARNESS_SOURCE_MAP, searchHarnessSourceMap } from './harnessSourceMap';

describe('harnessSourceMap', () => {
  it('lists the current broker harness and the other agent harness source', () => {
    const ids = HARNESS_SOURCE_MAP.map((group) => group.id);

    expect(ids).toContain('broker-harness');
    expect(ids).toContain('agent-harness');
    expect(HARNESS_SOURCE_MAP.flatMap((group) => group.entryFiles)).toContain('src/harness/');
    expect(HARNESS_SOURCE_MAP.flatMap((group) => group.entryFiles)).toContain('src/devreview/devReviewPair.ts');
  });

  it('searches by title, kind, summary, and file path', () => {
    expect(searchHarnessSourceMap('agent').map((group) => group.id)).toContain('agent-harness');
    expect(searchHarnessSourceMap('support')).toEqual([
      expect.objectContaining({ id: 'browser-agent-support' }),
    ]);
  });
});
