import { describe, expect, it } from 'vitest';
import type { BoardTask } from '../terminal/agentTasks';
import { deriveTaskViews } from './model';
import { dagChain, dagNeighbor, depSubgraph, depTree, layoutDag, DAG_NODE_W } from './graph';

const NOW = 1_800_000_000_000;
const task = (seq: number, state: string, deps: number[] = []): BoardTask => ({
  seq, title: `task ${seq}`, state, createdAt: NOW - 60_000, updatedAt: NOW - 60_000, deps: deps.map((d) => ({ seq: d, state: 'open' })),
});
const views = (tasks: BoardTask[]) => deriveTaskViews(tasks, NOW, 30 * 60_000);

describe('layoutDag', () => {
  it('layers by longest path, left to right, and adds dummy nodes for long edges', () => {
    // 1 -> 2 -> 3 and 1 -> 3 (long edge 1 -> 3 spans two layers).
    const l = layoutDag([1, 2, 3], [[1, 2], [2, 3], [1, 3]]);
    expect(l.mode).toBe('graph');
    if (l.mode !== 'graph') return;
    const layerOf = Object.fromEntries(l.nodes.map((n) => [n.seq, n.layer]));
    expect(layerOf).toEqual({ 1: 0, 2: 1, 3: 2 });
    expect(l.layers[1]).toContain('d:1-3:1');
    expect(l.nodes.find((n) => n.seq === 2)!.x).toBeGreaterThan(l.nodes.find((n) => n.seq === 1)!.x + DAG_NODE_W - 1);
    // The long edge goes through the dummy point: two cubic segments.
    const long = l.paths.find((p) => p.from === 1 && p.to === 3)!;
    expect(long.d.match(/C/g)?.length).toBe(2);
    expect(l.paths.find((p) => p.from === 1 && p.to === 2)!.d.match(/C/g)?.length).toBe(1);
  });

  it('is deterministic whatever the input order', () => {
    const nodes = [5, 1, 4, 2, 3, 6];
    const edges: Array<[number, number]> = [[1, 4], [2, 3], [1, 3], [2, 4], [5, 6], [3, 6]];
    const a = layoutDag(nodes, edges);
    const b = layoutDag([...nodes].reverse(), [...edges].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keeps the ordering with the fewest crossings', () => {
    // 1 -> 4, 2 -> 3: sorted by # the edges cross; the sweeps untangle them.
    const l = layoutDag([1, 2, 3, 4], [[1, 4], [2, 3]]);
    expect(l.mode === 'graph' && l.crossings).toBe(0);
  });

  it('falls back to a tree for cycles, too many nodes and too many layers', () => {
    expect(layoutDag([1, 2, 3], [[1, 2], [2, 3], [3, 1]])).toEqual({ mode: 'tree', reason: 'cycle' });
    expect(layoutDag([1], [[1, 1]])).toEqual({ mode: 'tree', reason: 'cycle' });
    const many = Array.from({ length: 41 }, (_, i) => i + 1);
    expect(layoutDag(many, [])).toEqual({ mode: 'tree', reason: 'tooMany' });
    const chain = Array.from({ length: 9 }, (_, i) => i + 1);
    const chainEdges = chain.slice(1).map((n) => [n - 1, n] as [number, number]);
    expect(layoutDag(chain, chainEdges)).toEqual({ mode: 'tree', reason: 'tooDeep' });
    expect(layoutDag(chain.slice(0, 8), chainEdges.slice(0, 7)).mode).toBe('graph');
    // The walk cap wins over a larger maxLayers.
    const long = Array.from({ length: 70 }, (_, i) => i + 1);
    expect(layoutDag(long, long.slice(1).map((n) => [n - 1, n] as [number, number]), { maxNodes: 100, maxLayers: 100 })).toEqual({ mode: 'tree', reason: 'tooDeep' });
    expect(layoutDag([], [])).toEqual({ mode: 'tree', reason: 'empty' });
  });

  it('lays out the worst case it accepts (40 nodes, 8 layers, dense) quickly', () => {
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    const edges: Array<[number, number]> = [];
    // 8 layers of 5; every node depends on every node of the previous layer and on one two back.
    for (let l = 1; l < 8; l++) {
      for (let k = 0; k < 5; k++) {
        const to = l * 5 + k + 1;
        for (let j = 0; j < 5; j++) edges.push([(l - 1) * 5 + j + 1, to]);
        if (l >= 2) edges.push([(l - 2) * 5 + ((k + 2) % 5) + 1, to]);
      }
    }
    const start = performance.now();
    const l = layoutDag(ids, edges);
    const ms = performance.now() - start;
    expect(l.mode).toBe('graph');
    expect(ms).toBeLessThan(1000);
  });

  it('finds chains and arrow-key neighbours', () => {
    const edges: Array<[number, number]> = [[1, 2], [2, 3], [4, 3], [5, 6]];
    expect([...dagChain(2, edges)].sort()).toEqual([1, 2, 3]);
    const l = layoutDag([1, 2, 3, 4, 5, 6], edges);
    if (l.mode !== 'graph') throw new Error('graph expected');
    expect(dagNeighbor(l, 2, 'ArrowLeft', edges)).toBe(1);
    expect(dagNeighbor(l, 2, 'ArrowRight', edges)).toBe(3);
    expect(dagNeighbor(l, 3, 'ArrowRight', edges)).toBeNull();
    const row0 = l.nodes.filter((n) => n.layer === 0).sort((a, b) => a.order - b.order).map((n) => n.seq);
    expect(dagNeighbor(l, row0[0], 'ArrowDown', edges)).toBe(row0[1]);
    expect(dagNeighbor(l, row0[0], 'ArrowUp', edges)).toBeNull();
  });
});

describe('depSubgraph / depTree', () => {
  it('shows open tasks with dependencies and done ones only as direct deps', () => {
    const v = views([task(1, 'done'), task(2, 'open', [1]), task(3, 'open', [2]), task(4, 'claimed'), task(5, 'done', [1]), task(6, 'cancelled')]);
    const g = depSubgraph(v);
    expect(g.views.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(g.edges).toEqual([[1, 2], [2, 3]]);
    expect(g.isolated).toBe(1); // #4
  });

  it('roots at tasks nothing depends on, children are what they wait on', () => {
    const v = views([task(1, 'claimed'), task(2, 'open', [1]), task(3, 'open', [1, 2])]);
    const tree = depTree(v);
    expect(tree.map((n) => n.seq)).toEqual([3]);
    expect(tree[0].children.map((n) => n.seq)).toEqual([1, 2]);
    // #1 was expanded under #3 already, so under #2 it is a leaf (no deps: still shown).
    expect(tree[0].children[1].children.map((n) => n.seq)).toEqual([1]);
    const keys = new Set<string>();
    const walk = (ns: typeof tree) => ns.forEach((n) => { expect(keys.has(n.key)).toBe(false); keys.add(n.key); walk(n.children); });
    walk(tree);
  });

  it('stays finite on a cycle and marks it', () => {
    const v = views([task(1, 'open', [2]), task(2, 'open', [1])]);
    const tree = depTree(v);
    expect(tree.length).toBe(1);
    expect(tree[0].seq).toBe(1);
    expect(tree[0].children[0].seq).toBe(2);
    expect(tree[0].children[0].children[0]).toMatchObject({ seq: 1, cycle: true, children: [] });
  });
});
