// Integration safeguard: the AI-browser tool system must stay internally consistent as
// tools are added. This cross-checks the three registries that can drift apart:
//   - AI_CAPABILITIES (browserAiCapabilities.ts) — the user-facing/self-doc list
//   - READ_ONLY_TOOLS + STATE_CHANGING (browserAgentLoopGuard.ts) — loop classification
// Real bugs this prevents: a capability tool that is never classified (so re-observation
// misbehaves — this happened to browser_eval), or a tool in both sets, or a capability
// whose backing tool id is a typo.
import { describe, expect, it } from 'vitest';
import { AI_CAPABILITIES } from './browserAiCapabilities';
import { READ_ONLY_TOOLS, STATE_CHANGING } from './browserAgentLoopGuard';

const capabilityTools = AI_CAPABILITIES.map((c) => c.tool).filter((t): t is string => !!t);

describe('browser tool integrity', () => {
  // Every capability that names a backing tool must be classified in exactly one set.
  it('classifies every capability tool in exactly one loop-guard set', () => {
    for (const tool of capabilityTools) {
      const inRead = READ_ONLY_TOOLS.has(tool);
      const inState = STATE_CHANGING.has(tool);
      expect(inRead || inState, `${tool} is unclassified in the loop guard`).toBe(true);
      expect(inRead && inState, `${tool} is in BOTH loop-guard sets`).toBe(false);
    }
  });

  // The read-only and state-changing sets never overlap (any tool, not just capabilities).
  it('keeps READ_ONLY_TOOLS and STATE_CHANGING disjoint', () => {
    for (const t of READ_ONLY_TOOLS) expect(STATE_CHANGING.has(t), `${t} in both sets`).toBe(false);
  });

  // Capability ids and backing tool ids are unique (no accidental duplicate wiring).
  it('has unique capability ids and tool ids', () => {
    const ids = AI_CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(capabilityTools).size).toBe(capabilityTools.length);
  });

  // Every capability tool follows the browser_* naming convention (catches typos like
  // "broser_" or a stray file_* leaking into the browser capability list).
  it('names capability tools with the browser_ prefix', () => {
    for (const tool of capabilityTools) expect(tool).toMatch(/^browser_[a-z0-9_]+$/);
  });
});
