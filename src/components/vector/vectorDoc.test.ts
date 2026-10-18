import { describe, expect, it } from 'vitest';

import { parseVNode, parseVScene, resolveInstance, vNodeBBox, type VFrameNode, type VInstanceNode, type VTextNode } from './VectorDoc';

const frame = (extra: Record<string, unknown> = {}) => ({
  id: 'f1', type: 'vframe', layout: 'column', gap: 12, padding: [16, 16, 16, 16],
  w: 400, h: 300, fill: '#fff',
  children: [
    { id: 't1', type: 'vtext', text: 'Hello', size: 24, weight: 700 },
    { id: 'b1', type: 'vbox', fill: '#DE2A44', w: 100, h: 40, sizing: { w: 'fixed', h: 'fixed' } },
  ],
  ...extra,
});

describe('parseVNode', () => {
  it('parses a frame tree with defaults filled in', () => {
    const n = parseVNode(frame()) as VFrameNode;
    expect(n.type).toBe('vframe');
    expect(n.children).toHaveLength(2);
    expect(n.alignMain).toBe('start');
    expect((n.children[0] as VTextNode).lineHeight).toBe(1.4);
    expect(n.clip).toBe(true);
  });

  it('drops malformed nodes but keeps valid siblings', () => {
    const n = parseVNode(frame({ children: [{ type: 'nope' }, { id: 't', type: 'vtext', text: 'ok' }, null] })) as VFrameNode;
    expect(n.children).toHaveLength(1);
    expect(n.children[0].type).toBe('vtext');
  });

  it('rejects paths with fewer than 2 points and images without a file', () => {
    expect(parseVNode({ type: 'vpath', points: [[1, 1]] })).toBeNull();
    expect(parseVNode({ type: 'vimage' })).toBeNull();
  });
});

describe('parseVScene', () => {
  it('returns undefined for empty or missing scenes', () => {
    expect(parseVScene(undefined)).toBeUndefined();
    expect(parseVScene({ roots: [] })).toBeUndefined();
  });

  it('parses components and roots', () => {
    const s = parseVScene({ components: { Card: frame() }, roots: [frame({ id: 'r1', x: 100, y: 50 })] });
    expect(s?.roots).toHaveLength(1);
    expect(s?.components.Card.type).toBe('vframe');
  });
});

describe('resolveInstance', () => {
  it('clones the component, remaps ids, and applies overrides', () => {
    const scene = parseVScene({
      components: { Card: frame() },
      roots: [{ id: 'i1', type: 'vinstance', of: 'Card', x: 10, y: 20, overrides: { t1: { text: 'Changed' } } }],
    })!;
    const resolved = resolveInstance(scene, scene.roots[0] as VInstanceNode) as VFrameNode;
    expect(resolved.id).toBe('i1:f1');
    expect(resolved.x).toBe(10);
    expect((resolved.children[0] as VTextNode).text).toBe('Changed');
    expect(resolved.children[0].id).toBe('i1:t1');
    expect((resolved.children[1] as VFrameNode & { fill: string }).fill).toBe('#DE2A44');
  });

  it('returns null for unknown components', () => {
    const scene = parseVScene({ components: {}, roots: [{ id: 'i', type: 'vinstance', of: 'Nope' }] });
    expect(scene && resolveInstance(scene, scene.roots[0] as VInstanceNode)).toBeNull();
  });
});

describe('vNodeBBox', () => {
  it('uses geometry for frames and point extents for paths', () => {
    const f = parseVNode(frame({ x: 5, y: 6 }))!;
    expect(vNodeBBox(f)).toEqual({ x: 5, y: 6, w: 400, h: 300 });
    const p = parseVNode({ type: 'vpath', points: [[10, 20], [30, 60]] })!;
    expect(vNodeBBox(p)).toEqual({ x: 10, y: 20, w: 20, h: 40 });
  });
});
