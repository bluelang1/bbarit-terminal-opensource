import { describe, it, expect } from 'vitest';
import {
  noteAndCheckRepeat,
  resetReadOnlyCounters,
  READ_ONLY_TOOLS,
  STATE_CHANGING,
  shouldBlockNavigation,
} from './browserAgentLoopGuard';

// Simulate the agent's per-request guard: feed a sequence of tool calls and
// return the list of calls that the guard blocked. Mirrors the loop in
// the browser agent loop: read-only counters reset after a state-changing tool.
function runGuard(seq: Array<{ tool: string; args?: unknown }>): string[] {
  const callCounts = new Map<string, number>();
  const blocked: string[] = [];
  for (const { tool, args } of seq) {
    const args2 = args ?? {};
    if (noteAndCheckRepeat(callCounts, tool, args2)) {
      blocked.push(tool);
      continue;
    }
    if (STATE_CHANGING.has(tool)) resetReadOnlyCounters(callCounts);
  }
  return blocked;
}

describe('browser agent loop guard', () => {
  it('allows re-observing the page after each state-changing action', () => {
    const blocked = runGuard([
      { tool: 'browser_snapshot' },
      { tool: 'browser_navigate', args: { url: 'https://sports.daum.net/' } },
      { tool: 'browser_snapshot' },
      { tool: 'browser_click', args: { selector: '@e8' } },
      { tool: 'browser_snapshot' },
      { tool: 'browser_click', args: { selector: '@e12' } },
      { tool: 'browser_snapshot' },
    ]);
    expect(blocked).toEqual([]);
  });

  it('never blocks a read that follows progress, even over a long session', () => {
    const seq = Array.from({ length: 10 }, (_, i) => [
      { tool: 'browser_click', args: { selector: `@e${i + 1}` } },
      { tool: 'browser_snapshot' },
    ]).flat();
    expect(runGuard(seq)).toEqual([]);
  });

  it('blocks the third consecutive identical read with no intervening action', () => {
    const blocked = runGuard([
      { tool: 'browser_snapshot' },
      { tool: 'browser_snapshot' },
      { tool: 'browser_snapshot' },
    ]);
    expect(blocked).toEqual(['browser_snapshot']);
  });

  it('blocks the same action repeated three times', () => {
    const blocked = runGuard([
      { tool: 'browser_click', args: { selector: '@e8' } },
      { tool: 'browser_click', args: { selector: '@e8' } },
      { tool: 'browser_click', args: { selector: '@e8' } },
    ]);
    expect(blocked).toEqual(['browser_click']);
  });

  it('treats distinct args as distinct calls', () => {
    const blocked = runGuard([
      { tool: 'browser_click', args: { selector: '@e1' } },
      { tool: 'browser_click', args: { selector: '@e2' } },
      { tool: 'browser_click', args: { selector: '@e3' } },
    ]);
    expect(blocked).toEqual([]);
  });

  it('handles missing args and unknown tools with the strict repeat guard', () => {
    expect(runGuard([
      { tool: 'browser_snapshot', args: undefined },
      { tool: 'browser_snapshot', args: {} },
      { tool: 'browser_snapshot' },
    ])).toEqual(['browser_snapshot']);

    expect(runGuard([
      { tool: 'mystery_tool' },
      { tool: 'mystery_tool' },
      { tool: 'mystery_tool' },
    ])).toEqual(['mystery_tool']);
  });

  it('blocks repeated navigation to the same URL before it opens tabs forever', () => {
    const seenUrls = new Map<string, number>();
    expect(shouldBlockNavigation(seenUrls, { url: 'https://news.daum.net/#top' })).toBeNull();
    expect(shouldBlockNavigation(seenUrls, { url: 'https://news.daum.net/' })).toContain('repeated navigation blocked');
  });

  it('allows distinct explicit navigation targets up to the configured cap', () => {
    const seenUrls = new Map<string, number>();
    expect(shouldBlockNavigation(seenUrls, { url: 'https://naver.com/' }, 2)).toBeNull();
    expect(shouldBlockNavigation(seenUrls, { url: 'https://daum.net/' }, 2)).toBeNull();
    expect(shouldBlockNavigation(seenUrls, { url: 'https://example.com/' }, 2)).toContain('navigation limit reached');
  });

  it('keeps the read-only and state-changing sets disjoint', () => {
    for (const tool of READ_ONLY_TOOLS) expect(STATE_CHANGING.has(tool)).toBe(false);
  });

  // Every browser_* tool exposed to the agent must be classified in exactly one set,
  // so re-observation after progress is handled correctly. This caught browser_eval
  // falling through both sets (arbitrary JS can mutate the page). Keep in sync with
  // the agent tool spec when adding a tool.
  const ALL_BROWSER_TOOLS = [
    'browser_navigate', 'browser_dom', 'browser_snapshot', 'browser_eval', 'browser_click',
    'browser_type', 'browser_console', 'browser_network', 'browser_html', 'browser_text',
    'browser_inspect', 'browser_reverse_engineer', 'browser_design_skill', 'browser_see', 'browser_scaffold_clone',
    'browser_fill_form', 'browser_batch', 'browser_history', 'browser_check_access',
    'browser_help', 'browser_a11y', 'browser_translate', 'browser_diagnose', 'browser_perf',
    'browser_audit', 'browser_extract', 'browser_watch', 'browser_consent', 'browser_find_click',
    'browser_load_more', 'browser_export', 'browser_links', 'browser_wait_for', 'browser_select',
    'browser_press_key',
  ];
  it('classifies every browser tool in exactly one set', () => {
    for (const tool of ALL_BROWSER_TOOLS) {
      const inRead = READ_ONLY_TOOLS.has(tool);
      const inState = STATE_CHANGING.has(tool);
      expect(inRead || inState, `${tool} is unclassified`).toBe(true);
      expect(inRead && inState, `${tool} is in both sets`).toBe(false);
    }
  });
});
