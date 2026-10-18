import { describe, expect, it } from 'vitest';

import {
  FRAME_GAP, FRAME_W, emptyPenDoc, frameOf, parsePenDoc, pathD, penDocPath, penNodeBBox,
  serializePenDoc, syncFrames, translatePenNode,
  type PenArrowNode, type PenFrameNode, type PenPathNode, type PenTextNode,
} from './DesignPenDoc';

describe('parsePenDoc', () => {
  it('parses a round-tripped doc', () => {
    const doc = emptyPenDoc();
    doc.nodes.push({ id: 'r1', type: 'rect', x: 10, y: 20, w: 100, h: 80, stroke: '#DE2A44', fill: 'transparent' });
    expect(parsePenDoc(serializePenDoc(doc))).toEqual(doc);
  });

  it('fills defaults for agent-written minimal nodes', () => {
    const raw = JSON.stringify({ nodes: [
      { type: 'text', x: 5, y: 6, text: 'hi' },
      { type: 'arrow', x: 0, y: 0 },
      { type: 'rect', x: 1, y: 2 },
    ] });
    const doc = parsePenDoc(raw);
    const text = doc.nodes[0] as PenTextNode;
    expect(text.size).toBeGreaterThan(0);
    expect(text.weight).toBe(700);
    expect(text.color).toBeTruthy();
    expect(doc.nodes[1]).toMatchObject({ type: 'arrow', x2: 200, y2: 0, stroke: '#DE2A44' });
    expect(doc.nodes[2]).toMatchObject({ type: 'rect', w: 240, h: 160 });
  });

  it('drops malformed nodes and survives invalid JSON', () => {
    expect(parsePenDoc('not json').nodes).toEqual([]);
    const doc = parsePenDoc(JSON.stringify({ nodes: [null, 42, { type: 'wat' }, { type: 'frame' }] }));
    expect(doc.nodes).toEqual([]);
  });

  it('assigns ids to nodes that lack one', () => {
    const doc = parsePenDoc(JSON.stringify({ nodes: [{ type: 'note', x: 0, y: 0, text: '' }] }));
    expect(doc.nodes[0].id).toBeTruthy();
  });
});

describe('syncFrames', () => {
  it('adds frames for new files to the right of existing content', () => {
    const doc = emptyPenDoc();
    const synced = syncFrames(doc, ['a.html', 'b.html']);
    const frames = synced.nodes as PenFrameNode[];
    expect(frames.map((f) => f.file)).toEqual(['a.html', 'b.html']);
    expect(frames[1].x - frames[0].x).toBe(FRAME_W + FRAME_GAP);
  });

  it('keeps user-moved frame positions and drops frames for deleted files', () => {
    const doc = emptyPenDoc();
    doc.nodes.push({ id: 'f1', type: 'frame', file: 'a.html', x: 999, y: -50 });
    doc.nodes.push({ id: 'f2', type: 'frame', file: 'gone.html', x: 0, y: 0 });
    const synced = syncFrames(doc, ['a.html']);
    expect(synced.nodes).toEqual([{ id: 'f1', type: 'frame', file: 'a.html', x: 999, y: -50 }]);
  });

  it('returns the same object when nothing changed', () => {
    const doc = syncFrames(emptyPenDoc(), ['a.html']);
    expect(syncFrames(doc, ['a.html'])).toBe(doc);
  });

  it('leaves shape nodes untouched', () => {
    const doc = emptyPenDoc();
    doc.nodes.push({ id: 'n1', type: 'note', x: 1, y: 2, text: 'keep' });
    const synced = syncFrames(doc, ['a.html']);
    expect(synced.nodes[0]).toEqual({ id: 'n1', type: 'note', x: 1, y: 2, text: 'keep' });
  });
});

describe('frameOf', () => {
  it('reads the frame position from the doc', () => {
    const doc = syncFrames(emptyPenDoc(), ['a.html']);
    expect(frameOf(doc, 'a.html', 3)).toEqual({ x: 0, y: 0 });
  });

  it('falls back to an index-based slot when the doc has no frame yet', () => {
    expect(frameOf(null, 'a.html', 2)).toEqual({ x: 2 * (FRAME_W + FRAME_GAP), y: 0 });
  });
});

describe('penDocPath', () => {
  it('joins without duplicating the trailing slash', () => {
    expect(penDocPath('/tmp/session/')).toBe('/tmp/session/design.pen.json');
    expect(penDocPath('/tmp/session')).toBe('/tmp/session/design.pen.json');
  });
});

describe('path and image nodes', () => {
  it('parses paths, drops those with fewer than two valid points', () => {
    const doc = parsePenDoc(JSON.stringify({ nodes: [
      { type: 'path', points: [[0, 0], [10, 5], ['x', 1], [3, 4]] },
      { type: 'path', points: [[1, 1]] },
      { type: 'image', file: 'assets/a.png', x: 5, y: 6 },
      { type: 'image', x: 0, y: 0 },
    ] }));
    expect(doc.nodes.map((n) => n.type)).toEqual(['path', 'image']);
    expect((doc.nodes[0] as PenPathNode).points).toEqual([[0, 0], [10, 5], [3, 4]]);
    expect(doc.nodes[1]).toMatchObject({ file: 'assets/a.png', w: 480, h: 360 });
  });

  it('keeps the design system meta through a round trip', () => {
    const doc = parsePenDoc(serializePenDoc({ version: 1, meta: { designSystem: 'brand: BBARIT red' }, nodes: [] }));
    expect(doc.meta?.designSystem).toBe('brand: BBARIT red');
    expect(parsePenDoc(serializePenDoc({ version: 1, nodes: [] })).meta).toBeUndefined();
  });
});

describe('geometry helpers', () => {
  it('translatePenNode shifts arrows by both endpoints and paths by every point', () => {
    const arrow: PenArrowNode = { id: 'a', type: 'arrow', x: 0, y: 0, x2: 10, y2: 10, stroke: '#000' };
    expect(translatePenNode(arrow, 5, -5)).toMatchObject({ x: 5, y: -5, x2: 15, y2: 5 });
    const path: PenPathNode = { id: 'p', type: 'path', points: [[0, 0], [4, 4]], stroke: '#000' };
    expect(translatePenNode(path, 1, 2).points).toEqual([[1, 2], [5, 6]]);
  });

  it('penNodeBBox covers arrows and paths by their extents', () => {
    expect(penNodeBBox({ id: 'a', type: 'arrow', x: 10, y: 20, x2: 0, y2: 5, stroke: '#000' }))
      .toEqual({ x: 0, y: 5, w: 10, h: 15 });
    expect(penNodeBBox({ id: 'p', type: 'path', points: [[2, 3], [8, 1], [5, 9]], stroke: '#000' }))
      .toEqual({ x: 2, y: 1, w: 6, h: 8 });
  });

  it('pathD emits a line for two points and beziers beyond', () => {
    expect(pathD([[0, 0], [10, 0]])).toBe('M0,0 L10,0');
    expect(pathD([[0, 0], [10, 0], [10, 10]])).toMatch(/^M0,0C/);
    expect(pathD([[0, 0]])).toBe('');
  });
});
