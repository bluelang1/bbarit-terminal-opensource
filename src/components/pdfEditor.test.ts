import { describe, expect, it, vi } from 'vitest';

// react-pdf pulls in pdfjs, which references DOMMatrix at module-eval time and
// blows up under jsdom. We only test the pure model helpers, so stub the render
// layer out entirely.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {}, version: '0' },
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

import {
  hexToRgbTuple,
  createInitialPages,
  isIdentityPages,
  pctPointToPdf,
  pctRectToPdf,
  remapAnnotationPages,
  applyPageOperation,
  type PageSlot,
  type Annotation,
  type TextAnnotation,
} from './PdfEditor';

function textAnn(page: number, id = `a${page}`): TextAnnotation {
  return { kind: 'text', id, page, x: 10, y: 10, text: 't', color: '#000000', fontSize: 12 };
}

describe('hexToRgbTuple', () => {
  it('normalizes hex channels to the 0..1 range', () => {
    expect(hexToRgbTuple('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToRgbTuple('#000000')).toEqual([0, 0, 0]);
    const [r, g, b] = hexToRgbTuple('#804020');
    expect(r).toBeCloseTo(128 / 255);
    expect(g).toBeCloseTo(64 / 255);
    expect(b).toBeCloseTo(32 / 255);
  });
});

describe('createInitialPages / isIdentityPages', () => {
  it('creates identity slots 0..n-1', () => {
    const pages = createInitialPages(3);
    expect(pages.map((p) => p.src)).toEqual([0, 1, 2]);
    expect(pages.every((p) => p.rotation === 0)).toBe(true);
    expect(isIdentityPages(pages, 3)).toBe(true);
  });
  it('detects non-identity after rotation, reorder, or count change', () => {
    const pages = createInitialPages(3);
    expect(isIdentityPages([{ ...pages[0], rotation: 90 }, pages[1], pages[2]], 3)).toBe(false);
    expect(isIdentityPages([pages[1], pages[0], pages[2]], 3)).toBe(false);
    expect(isIdentityPages(pages.slice(0, 2), 3)).toBe(false);
  });
});

describe('coordinate transforms', () => {
  it('flips the Y axis for a point (top-left pct -> bottom-left pdf)', () => {
    const pt = pctPointToPdf(0, 0, 200, 100);
    expect(pt).toEqual({ x: 0, y: 100 });
    const mid = pctPointToPdf(50, 50, 200, 100);
    expect(mid).toEqual({ x: 100, y: 50 });
  });
  it('produces a bottom-left rectangle', () => {
    // A 20%x10% box at (10%,10%) on a 200x100 page.
    const rc = pctRectToPdf(10, 10, 20, 10, 200, 100);
    expect(rc.width).toBeCloseTo(40);
    expect(rc.height).toBeCloseTo(10);
    expect(rc.x).toBeCloseTo(20);
    // top of box is at y=10% from top -> 90 in pdf; bottom is 10 lower -> 80.
    expect(rc.y).toBeCloseTo(80);
  });
});

describe('remapAnnotationPages', () => {
  it('drops annotations that map to null and shifts the rest', () => {
    const annos = [textAnn(1), textAnn(2), textAnn(3)];
    const out = remapAnnotationPages(annos, (p) => (p === 2 ? null : p > 2 ? p - 1 : p));
    expect(out.map((a) => a.page)).toEqual([1, 2]);
  });
  it('keeps object identity when the page is unchanged', () => {
    const a = textAnn(1);
    const [out] = remapAnnotationPages([a], (p) => p);
    expect(out).toBe(a);
  });
});

describe('applyPageOperation', () => {
  const base = (): { pages: PageSlot[]; annos: Annotation[] } => ({
    pages: createInitialPages(4),
    annos: [textAnn(1), textAnn(2), textAnn(3), textAnn(4)],
  });

  it('rotate: bumps only the target slot rotation, leaves annotations', () => {
    const { pages, annos } = base();
    const r = applyPageOperation(pages, annos, { kind: 'rotate', index: 1, delta: 90 });
    expect(r.pages[1].rotation).toBe(90);
    expect(r.pages[0].rotation).toBe(0);
    expect(r.annotations).toBe(annos);
    // rotation wraps modulo 360
    const r2 = applyPageOperation(r.pages, annos, { kind: 'rotate', index: 1, delta: 300 });
    expect(r2.pages[1].rotation).toBe(30);
  });

  it('delete: removes the slot and remaps annotations, dropping the deleted page', () => {
    const { pages, annos } = base();
    const r = applyPageOperation(pages, annos, { kind: 'delete', index: 1 });
    expect(r.pages.map((p) => p.src)).toEqual([0, 2, 3]);
    // page 2 dropped; 3->2, 4->3
    expect(r.annotations.map((a) => a.page).sort()).toEqual([1, 2, 3]);
    expect(r.annotations.find((a) => a.page === 2)?.id).toBe('a3');
  });

  it('delete: refuses to remove the last remaining page', () => {
    const pages = createInitialPages(1);
    const annos = [textAnn(1)];
    const r = applyPageOperation(pages, annos, { kind: 'delete', index: 0 });
    expect(r.pages).toBe(pages);
    expect(r.annotations).toBe(annos);
  });

  it('duplicate: inserts a copy after the slot and shifts later annotations', () => {
    const { pages, annos } = base();
    const r = applyPageOperation(pages, annos, { kind: 'duplicate', index: 1 });
    expect(r.pages.map((p) => p.src)).toEqual([0, 1, 1, 2, 3]);
    // pages 1,2 keep; the duplicate (new page 3) has no annotations; old 3->4, 4->5
    expect(r.annotations.map((a) => a.page).sort((x, y) => x - y)).toEqual([1, 2, 4, 5]);
  });

  it('insertBlank: adds a blank slot and pushes annotations at/after the position down', () => {
    const { pages, annos } = base();
    const r = applyPageOperation(pages, annos, { kind: 'insertBlank', index: 1 });
    expect(r.pages.map((p) => p.src)).toEqual([0, 'blank', 1, 2, 3]);
    // blank inserted at 1-based position 2; annotations on page>=2 shift +1
    expect(r.annotations.map((a) => a.page).sort((x, y) => x - y)).toEqual([1, 3, 4, 5]);
  });

  it('move: reorders slots and remaps annotations to follow their page', () => {
    const { pages, annos } = base();
    // move first page to the end
    const r = applyPageOperation(pages, annos, { kind: 'move', from: 0, to: 3 });
    expect(r.pages.map((p) => p.src)).toEqual([1, 2, 3, 0]);
    // old page1 -> new position 4; old 2->1, 3->2, 4->3
    const byId = Object.fromEntries(r.annotations.map((a) => [a.id, a.page]));
    expect(byId.a1).toBe(4);
    expect(byId.a2).toBe(1);
    expect(byId.a3).toBe(2);
    expect(byId.a4).toBe(3);
  });

  it('move: no-op when from === to', () => {
    const { pages, annos } = base();
    const r = applyPageOperation(pages, annos, { kind: 'move', from: 2, to: 2 });
    expect(r.pages).toBe(pages);
    expect(r.annotations).toBe(annos);
  });
});
