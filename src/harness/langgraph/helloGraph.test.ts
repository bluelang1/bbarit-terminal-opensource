import { describe, it, expect } from 'vitest';
import { runHelloGraph } from './helloGraph';

describe('helloGraph (Phase 0 sanity)', () => {
  it('runs greet → shout and produces uppercased output', async () => {
    const result = await runHelloGraph('BBARIT');
    expect(result.steps).toEqual(['greet', 'shout']);
    expect(result.output).toBe('HELLO, BBARIT!');
  });

  it('handles empty input gracefully', async () => {
    const result = await runHelloGraph('');
    expect(result.steps).toEqual(['greet', 'shout']);
    expect(result.output).toBe('HELLO, !');
  });
});
