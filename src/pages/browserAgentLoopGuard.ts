// Loop guard for the DeepSeek browser agent's tool-call loop.
//
// Read-only observation tools take no meaningful args (their args are usually `{}`),
// so re-reading the page after it changed produces an identical call key. That must
// not be treated as a no-progress loop, otherwise the natural
//   snapshot -> click -> snapshot -> click ...
// browsing pattern gets blocked on the third identical snapshot.
//
// Fix: reset the read-only counters whenever a state-changing tool runs, so only
// genuine spam (the same read repeated with no action between) stays blocked. The
// outer step cap and the per-action repeat guard still bound real loops.

// Idempotent reads whose output legitimately changes as the page changes.
export const READ_ONLY_TOOLS = new Set([
  'browser_snapshot',
  'browser_dom',
  'browser_console',
  'browser_network',
  'browser_inspect',
  'browser_html',
  'browser_text',
  'browser_reverse_engineer',
  'browser_design_skill',
  'browser_see',
  'browser_history',
  'browser_check_access',
  'browser_help',
  'browser_a11y',
  'browser_translate',
  'browser_diagnose',
  'browser_perf',
  'browser_audit',
  'browser_extract',
  'browser_wait_for',
  'browser_watch',
]);

// Tools that mutate the page or the codebase, i.e. make progress.
export const STATE_CHANGING = new Set([
  'browser_navigate',
  'browser_click',
  'browser_type',
  'file_write',
  'file_edit',
  'run_command',
  'browser_scaffold_clone',
  'browser_fill_form',
  'browser_select',
  'browser_press_key',
  'browser_batch',
  'browser_consent',
  'browser_find_click',
  'browser_load_more',
  'browser_export',
  'browser_links',
  // Arbitrary JS eval can mutate the page (location.reload(), DOM edits, clicks), so
  // treat it as state-changing: after it runs, re-observing the page is legitimate.
  'browser_eval',
]);

export function callKeyOf(fname: string, args: unknown): string {
  return `${fname}:${JSON.stringify(args)}`;
}

// Increment the counter for this call and report whether it should be blocked:
// the same call has already run twice with no intervening reset.
export function noteAndCheckRepeat(callCounts: Map<string, number>, fname: string, args: unknown): boolean {
  const key = callKeyOf(fname, args);
  const seen = callCounts.get(key) || 0;
  callCounts.set(key, seen + 1);
  return seen >= 2;
}

// After a successful state-changing action the page is different, so re-observing it
// is legitimate again: drop the read-only counters.
export function resetReadOnlyCounters(callCounts: Map<string, number>): void {
  for (const key of [...callCounts.keys()]) {
    if (READ_ONLY_TOOLS.has(key.split(':')[0])) callCounts.delete(key);
  }
}

export function normalizeUrlForLoopGuard(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.hash = '';
    return url.toString();
  } catch {
    return trimmed.replace(/#.*$/, '');
  }
}

export function shouldBlockNavigation(
  seenUrls: Map<string, number>,
  args: { url?: unknown },
  maxUniqueNavigations = 8,
): string | null {
  const url = normalizeUrlForLoopGuard(args?.url);
  if (!url) return 'navigation requires a URL';
  const seen = seenUrls.get(url) || 0;
  seenUrls.set(url, seen + 1);
  if (seen >= 1) return `repeated navigation blocked: ${url}`;
  if (seenUrls.size > maxUniqueNavigations) return `navigation limit reached (${maxUniqueNavigations} unique URLs)`;
  return null;
}
