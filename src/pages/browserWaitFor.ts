// Wait-for-condition on dynamic pages.
//
// SPAs load content asynchronously; an action often fails because the target text or
// element is not there YET. This lets the agent wait until a condition holds (text
// appears/disappears, an element exists, a list reaches N items) before proceeding.
// The condition EVALUATION is pure and tested here; the poll loop is a thin caller.
//
// D1: Conditions are declarative and evaluated against a plain page PROBE object
//     (textPresent, elementCount, url). Reason: the in-page read stays a dumb snapshot;
//     all the matching logic is here where it can be tested without a browser.

export interface WaitProbe {
  text?: string;          // visible page text (lowercased by the caller or here)
  elementCount?: number;  // count of a target selector, if the caller measured one
  url?: string;
}

export interface WaitCondition {
  containsText?: string;     // page text must include this
  missingText?: string;      // page text must NOT include this (e.g. "loading")
  minCount?: number;         // elementCount must be >= this
  urlIncludes?: string;      // url must include this
}

export interface WaitEval { satisfied: boolean; reason: string }

export function evaluateWait(condition: WaitCondition, probe: WaitProbe): WaitEval {
  const c = condition || {};
  const text = String(probe?.text ?? '').toLowerCase();
  const url = String(probe?.url ?? '').toLowerCase();
  const count = Number(probe?.elementCount ?? 0);

  // An empty condition is trivially satisfied (nothing to wait for).
  const checks: Array<{ ok: boolean; fail: string }> = [];
  if (condition && condition.containsText !== undefined) {
    checks.push({ ok: text.includes(String(c.containsText).toLowerCase()), fail: `text does not yet contain "${c.containsText}"` });
  }
  if (condition && condition.missingText !== undefined) {
    checks.push({ ok: !text.includes(String(c.missingText).toLowerCase()), fail: `text still contains "${c.missingText}"` });
  }
  if (condition && condition.minCount !== undefined) {
    checks.push({ ok: count >= Number(c.minCount), fail: `count ${count} < ${c.minCount}` });
  }
  if (condition && condition.urlIncludes !== undefined) {
    checks.push({ ok: url.includes(String(c.urlIncludes).toLowerCase()), fail: `url does not include "${c.urlIncludes}"` });
  }

  if (!checks.length) return { satisfied: true, reason: 'no condition specified' };
  const failed = checks.find((ch) => !ch.ok);
  return failed ? { satisfied: false, reason: failed.fail } : { satisfied: true, reason: 'all conditions met' };
}

export const DEFAULT_WAIT_ATTEMPTS = 15;   // ~15 polls
export const DEFAULT_WAIT_INTERVAL_MS = 600;

// Normalize a free-form wait spec (from the tool args) into a WaitCondition.
export function parseWaitSpec(spec: unknown): WaitCondition {
  if (!spec || typeof spec !== 'object') {
    // A bare string means "wait until this text appears".
    return typeof spec === 'string' && spec.trim() ? { containsText: spec.trim() } : {};
  }
  const s = spec as Record<string, unknown>;
  const out: WaitCondition = {};
  if (typeof s.containsText === 'string' && s.containsText) out.containsText = s.containsText;
  if (typeof s.missingText === 'string' && s.missingText) out.missingText = s.missingText;
  if (Number(s.minCount) > 0) out.minCount = Number(s.minCount);
  if (typeof s.urlIncludes === 'string' && s.urlIncludes) out.urlIncludes = s.urlIncludes;
  return out;
}
