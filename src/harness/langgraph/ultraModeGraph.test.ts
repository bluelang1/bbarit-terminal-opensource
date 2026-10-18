import { describe, it, expect } from 'vitest';
import { runUltraGraph, extractTaskList } from './index';

describe('extractTaskList', () => {
  it('parses plain JSON array', () => {
    const r = extractTaskList('[{"id":"t1","description":"first"},{"id":"t2","description":"second"}]');
    expect(r).toEqual([
      { id: 't1', description: 'first' },
      { id: 't2', description: 'second' },
    ]);
  });

  it('tolerates code fences', () => {
    const r = extractTaskList('```json\n[{"id":"a","description":"x"}]\n```');
    expect(r).toEqual([{ id: 'a', description: 'x' }]);
  });

  it('extracts array from surrounding prose', () => {
    const r = extractTaskList('Here you go:\n[{"description":"only desc"}]\nCheers');
    expect(r?.[0].description).toBe('only desc');
  });

  it('returns null for malformed output', () => {
    expect(extractTaskList('not json at all')).toBeNull();
  });
});

describe('Ultra StateGraph (fallback executors)', () => {
  it('runs decompose → executeParallel → synthesize with defaults', async () => {
    const state = await runUltraGraph('Research React 19. Draft a blog post. Review the outline.');
    expect(state.tasks.length).toBeGreaterThan(0);
    expect(Object.keys(state.subResults).length).toBe(state.tasks.length);
    expect(state.finalAnswer).toBeTruthy();
    expect(state.errors.length).toBe(0);
  });

  it('uses injected executors when provided', async () => {
    const state = await runUltraGraph('Plan a launch', {
      decompose: async () => JSON.stringify([
        { id: 'a', description: 'write copy' },
        { id: 'b', description: 'design banner' },
      ]),
      subAgent: async (desc) => `done: ${desc}`,
      synthesize: async (prompt) => `SYNTH(${prompt.length})`,
    });
    expect(state.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(state.subResults).toEqual({ a: 'done: write copy', b: 'done: design banner' });
    expect(state.finalAnswer?.startsWith('SYNTH(')).toBe(true);
  });

  it('collects errors when sub-agent fails on one task', async () => {
    const state = await runUltraGraph('do things', {
      decompose: async () => JSON.stringify([
        { id: 'ok', description: 'will succeed' },
        { id: 'bad', description: 'will fail' },
      ]),
      subAgent: async (desc) => {
        if (desc === 'will fail') throw new Error('boom');
        return 'ok-result';
      },
    });
    expect(state.subResults.ok).toBe('ok-result');
    expect(state.subResults.bad).toBeUndefined();
    expect(state.errors.some((e) => e.includes('boom'))).toBe(true);
  });

  it('falls back to keyword split when decompose executor fails', async () => {
    const state = await runUltraGraph('alpha. beta. gamma', {
      decompose: async () => 'not-json',
    });
    expect(state.tasks.length).toBe(3);
    expect(state.errors[0]).toMatch(/decompose/);
  });
});
