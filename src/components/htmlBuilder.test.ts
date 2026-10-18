import { describe, expect, it } from 'vitest';
import {
  BUILDER_BLOCK_CATEGORIES,
  EMPTY_PAGE_HTML,
  cleanBuilderMarkup,
  placeholderImage,
} from './htmlBuilderBlocks';
import {
  buildLayerTree,
  cssColorToHex,
  elementDisplayName,
  getElementPath,
  isDropContainer,
  isTextEditable,
  pxToNumber,
  resolveElementPath,
} from './htmlBuilderCore';

const allBlocks = BUILDER_BLOCK_CATEGORIES.flatMap((c) => c.blocks);

describe('builder block library', () => {
  it('has unique non-empty ids and English UI labels', () => {
    const ids = new Set<string>();
    for (const block of allBlocks) {
      expect(block.id).toBeTruthy();
      expect(ids.has(block.id)).toBe(false);
      ids.add(block.id);
      // Editor UI labels must be English (block HTML content may be Korean).
      expect(block.name).toMatch(/^[\x20-\x7E]+$/);
      expect(block.description).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it('every block parses to exactly one root element with no scripts', () => {
    for (const block of allBlocks) {
      const host = document.createElement('div');
      host.innerHTML = block.html;
      expect(host.children.length, block.id).toBe(1);
      expect(host.querySelector('script'), block.id).toBeNull();
    }
  });

  it('blocks carry no builder-only markers into documents', () => {
    for (const block of allBlocks) {
      expect(block.html).not.toContain('data-bbarit-');
    }
  });

  it('empty page skeleton parses with an empty body', () => {
    const doc = new DOMParser().parseFromString(EMPTY_PAGE_HTML, 'text/html');
    expect(doc.body).toBeTruthy();
    expect(doc.body.children.length).toBe(0);
  });

  it('placeholderImage returns a self-contained data URI', () => {
    const uri = placeholderImage(100, 50, 'Test');
    expect(uri.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(uri)).toContain('Test');
  });
});

describe('cleanBuilderMarkup', () => {
  it('strips selection markers, editing flags, and injected styles', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<style data-bbarit-builder>p{}</style>',
      '<section data-bbarit-selected="1"><p data-bbarit-editing="1" contenteditable="true">hi</p></section>',
      '<div data-bbarit-hover="1">x</div>',
    ].join('');
    cleanBuilderMarkup(root);
    expect(root.querySelector('style')).toBeNull();
    expect(root.innerHTML).not.toContain('data-bbarit-');
    expect(root.innerHTML).not.toContain('contenteditable');
    expect(root.textContent).toContain('hi');
  });

  it('leaves user contenteditable untouched when not builder-flagged', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div contenteditable="true">user editable</div>';
    cleanBuilderMarkup(root);
    expect(root.innerHTML).toContain('contenteditable');
  });
});

describe('element paths', () => {
  const make = () => {
    const body = document.createElement('body');
    body.innerHTML = '<header><nav></nav></header><main><section><p>a</p><p>b</p></section></main>';
    return body;
  };

  it('round-trips path → element → path', () => {
    const body = make();
    const p2 = body.querySelectorAll('p')[1];
    const path = getElementPath(p2, body);
    expect(path).toEqual([1, 0, 1]);
    expect(resolveElementPath(body, path)).toBe(p2);
  });

  it('returns [] for detached elements and null for stale paths', () => {
    const body = make();
    expect(getElementPath(document.createElement('div'), body)).toEqual([]);
    expect(resolveElementPath(body, [9, 0])).toBeNull();
  });
});

describe('layer tree', () => {
  it('mirrors the element structure with names and paths', () => {
    const body = document.createElement('body');
    body.innerHTML = '<header id="top"></header><main><p class="lead intro">x</p></main>';
    const tree = buildLayerTree(body);
    expect(tree.map((n) => n.name)).toEqual(['header#top', 'main']);
    expect(tree[1].children[0].name).toBe('p.lead');
    expect(tree[1].children[0].path).toEqual([1, 0]);
  });
});

describe('inspector value helpers', () => {
  it('converts rgb and short hex to #rrggbb', () => {
    expect(cssColorToHex('rgb(59, 130, 246)')).toBe('#3b82f6');
    expect(cssColorToHex('rgba(15, 23, 42, 0.5)')).toBe('#0f172a');
    expect(cssColorToHex('#fff')).toBe('#ffffff');
    expect(cssColorToHex('#0F172A')).toBe('#0f172a');
  });

  it('falls back for unparseable or fully transparent colors', () => {
    expect(cssColorToHex('rgba(0,0,0,0)', '#123456')).toBe('#123456');
    expect(cssColorToHex('linear-gradient(#fff,#000)', '#123456')).toBe('#123456');
    expect(cssColorToHex('', '#123456')).toBe('#123456');
  });

  it('parses px numbers', () => {
    expect(pxToNumber('16px')).toBe(16);
    expect(pxToNumber('-4.5px')).toBe(-4.5);
    expect(pxToNumber('auto')).toBeNull();
    expect(pxToNumber('50%')).toBeNull();
  });

  it('marks text-bearing elements editable and media elements not', () => {
    expect(isTextEditable(document.createElement('p'))).toBe(true);
    expect(isTextEditable(document.createElement('img'))).toBe(false);
    expect(isTextEditable(document.createElement('hr'))).toBe(false);
  });

  it('refuses inline editing of elements with block-level children', () => {
    const section = document.createElement('section');
    section.innerHTML = '<h2>title</h2><p>body</p>';
    expect(isTextEditable(section)).toBe(false);
    const p = document.createElement('p');
    p.innerHTML = 'hello <strong>bold</strong> world';
    expect(isTextEditable(p)).toBe(true);
  });

  it('identifies empty structural containers as drop targets', () => {
    const empty = document.createElement('div');
    expect(isDropContainer(empty)).toBe(true);
    const withChild = document.createElement('div');
    withChild.innerHTML = '<p>x</p>';
    expect(isDropContainer(withChild)).toBe(false);
    expect(isDropContainer(document.createElement('p'))).toBe(false);
  });
});

describe('elementDisplayName', () => {
  it('prefers id, then first class, then tag', () => {
    const el = document.createElement('section');
    expect(elementDisplayName(el)).toBe('section');
    el.setAttribute('class', 'hero  big');
    expect(elementDisplayName(el)).toBe('section.hero');
    el.id = 'main-hero';
    expect(elementDisplayName(el)).toBe('section#main-hero');
  });
});
