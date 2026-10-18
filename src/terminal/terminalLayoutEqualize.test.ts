import { describe, expect, it } from 'vitest';
import { equalizeLayoutRatios, layoutLeafCount, type EqualizableLayoutNode } from './terminalLayoutEqualize';

type TestNode =
  | { kind: 'leaf'; id: string; terminalId: string }
  | { kind: 'split'; id: string; dir: 'row' | 'col'; ratio: number; first: TestNode; second: TestNode };

const leaf = (terminalId: string): TestNode => ({ kind: 'leaf', id: `L-${terminalId}`, terminalId });
const split = (ratio: number, first: TestNode, second: TestNode, dir: 'row' | 'col' = 'col'): TestNode => ({
  kind: 'split',
  id: `S-${first.kind === 'leaf' ? (first as { terminalId: string }).terminalId : 'x'}`,
  dir,
  ratio,
  first,
  second,
});

/** Compute each leaf's area share from ratios (percent-based), depth-first. */
function leafShares(node: TestNode, share = 100): number[] {
  if (node.kind === 'leaf') return [share];
  return [
    ...leafShares(node.first, (share * node.ratio) / 100),
    ...leafShares(node.second, (share * (100 - node.ratio)) / 100),
  ];
}

describe('equalizeLayoutRatios (터미널 추가 시 균등 분할)', () => {
  it('turns the degraded 50/25/25 chain into three equal panes', () => {
    // Splitting the active pane twice: ((A|B)|C) with every ratio at 50
    // → A=25%, B=25%, C=50%. Equalize → each pane one third.
    const tree = split(50, split(50, leaf('A'), leaf('B')), leaf('C'));
    const even = equalizeLayoutRatios(tree);
    const shares = leafShares(even);
    expect(shares).toHaveLength(3);
    for (const s of shares) expect(s).toBeCloseTo(100 / 3, 5);
    // Outer split gives its 2-leaf subtree two thirds.
    expect((even as { ratio: number }).ratio).toBeCloseTo((2 / 3) * 100, 5);
  });

  it('equalizes across mixed directions and four panes', () => {
    const tree = split(70, split(20, leaf('A'), leaf('B'), 'row'), split(80, leaf('C'), leaf('D')), 'col');
    const shares = leafShares(equalizeLayoutRatios(tree));
    expect(shares).toHaveLength(4);
    for (const s of shares) expect(s).toBeCloseTo(25, 5);
  });

  it('keeps structure and extra fields intact (only ratios change)', () => {
    const tree = split(50, leaf('A'), split(50, leaf('B'), leaf('C'), 'row'));
    const even = equalizeLayoutRatios(tree);
    expect(even.kind).toBe('split');
    if (even.kind !== 'split') return;
    expect(even.dir).toBe('col');
    expect(even.first).toMatchObject({ kind: 'leaf', terminalId: 'A' });
    expect(even.second).toMatchObject({ kind: 'split', dir: 'row', ratio: 50 });
    expect(even.ratio).toBeCloseTo(100 / 3, 5);
  });

  it('passes leaves and undefined through unchanged', () => {
    const single = leaf('only');
    expect(equalizeLayoutRatios(single)).toBe(single);
    expect(equalizeLayoutRatios(undefined as TestNode | undefined)).toBeUndefined();
  });

  it('counts leaves for arbitrary trees', () => {
    const tree: EqualizableLayoutNode = split(50, split(50, leaf('A'), leaf('B')), leaf('C'));
    expect(layoutLeafCount(tree)).toBe(3);
    expect(layoutLeafCount(leaf('A'))).toBe(1);
  });
});
