import { describe, it, expect } from 'vitest';
import { parseNcxToc, parseNavToc, scopeCss, upsertOpfField } from './EpubReader';

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>Chapter 1</text></navLabel>
      <content src="ch1.xhtml"/>
      <navPoint id="np1-1" playOrder="2">
        <navLabel><text>Section 1.1</text></navLabel>
        <content src="ch1.xhtml#s1"/>
      </navPoint>
    </navPoint>
    <navPoint id="np2" playOrder="3">
      <navLabel><text>Chapter 2</text></navLabel>
      <content src="ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;

describe('parseNcxToc', () => {
  const spine = ['ch1.xhtml', 'ch2.xhtml'];

  it('should parse top-level and nested navPoints with depth', () => {
    const toc = parseNcxToc(NCX, spine);
    expect(toc.map(t => [t.title, t.level, t.spineIndex])).toEqual([
      ['Chapter 1', 0, 0],
      ['Section 1.1', 1, 0],
      ['Chapter 2', 0, 1],
    ]);
  });

  it('should return empty array when there is no navMap', () => {
    expect(parseNcxToc('<ncx></ncx>', spine)).toEqual([]);
  });

  it('should resolve spine index by basename when paths differ', () => {
    const toc = parseNcxToc(NCX, ['text/ch1.xhtml', 'text/ch2.xhtml']);
    expect(toc[2].spineIndex).toBe(1);
  });
});

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="toc">
    <ol>
      <li><a href="ch1.xhtml">Chapter 1</a>
        <ol>
          <li><a href="ch1.xhtml#s1">Section 1.1</a></li>
          <li><a href="ch1.xhtml#s2">Section 1.2</a></li>
        </ol>
      </li>
      <li><a href="ch2.xhtml">Chapter 2</a></li>
    </ol>
  </nav>
  <nav epub:type="landmarks"><ol><li><a href="ch1.xhtml">Start</a></li></ol></nav>
</body>
</html>`;

describe('parseNavToc', () => {
  const spine = ['ch1.xhtml', 'ch2.xhtml'];

  it('should parse the toc nav with nested depth', () => {
    const toc = parseNavToc(NAV, spine);
    expect(toc.map(t => [t.title, t.level, t.spineIndex])).toEqual([
      ['Chapter 1', 0, 0],
      ['Section 1.1', 1, 0],
      ['Section 1.2', 1, 0],
      ['Chapter 2', 0, 1],
    ]);
  });

  it('should ignore the landmarks nav and only read the toc nav', () => {
    const toc = parseNavToc(NAV, spine);
    expect(toc.find(t => t.title === 'Start')).toBeUndefined();
  });

  it('should fall back to the first nav when no epub:type=toc exists', () => {
    const html = '<html><body><nav><ol><li><a href="a.xhtml">A</a></li></ol></nav></body></html>';
    const toc = parseNavToc(html, ['a.xhtml']);
    expect(toc).toHaveLength(1);
    expect(toc[0].title).toBe('A');
  });
});

describe('scopeCss', () => {
  const scope = '.epub-chapter';

  it('should prefix a plain selector', () => {
    expect(scopeCss('p { color: red; }', scope)).toContain('.epub-chapter p{ color: red; }');
  });

  it('should rewrite body/html to the scope itself', () => {
    const out = scopeCss('body { margin: 0; } html.x { color: blue; }', scope);
    expect(out).toContain('.epub-chapter{ margin: 0; }');
    expect(out).toContain('.epub-chapter .x{ color: blue; }');
  });

  it('should scope each selector in a comma list', () => {
    const out = scopeCss('h1, h2 { font-weight: bold; }', scope);
    expect(out).toContain('.epub-chapter h1, .epub-chapter h2{ font-weight: bold; }');
  });

  it('should recurse into @media blocks', () => {
    const out = scopeCss('@media (max-width: 600px) { p { color: green; } }', scope);
    expect(out).toContain('@media (max-width: 600px)');
    expect(out).toContain('.epub-chapter p{ color: green; }');
  });

  it('should leave @font-face untouched (no selector prefixing)', () => {
    const out = scopeCss('@font-face { font-family: "X"; src: url(x.ttf); }', scope);
    expect(out).toContain('@font-face{');
    expect(out).not.toContain('.epub-chapter font-family');
  });

  it('should drop @import and @charset', () => {
    const out = scopeCss('@charset "utf-8"; @import url(x.css); p { color: red; }', scope);
    expect(out).not.toContain('@import');
    expect(out).not.toContain('@charset');
    expect(out).toContain('.epub-chapter p{ color: red; }');
  });

  it('should strip comments', () => {
    const out = scopeCss('/* hi */ p { color: red; }', scope);
    expect(out).not.toContain('hi');
    expect(out).toContain('.epub-chapter p{ color: red; }');
  });
});

describe('upsertOpfField', () => {
  const OPF = `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Old Title</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="uid">x</dc:identifier>
  </metadata>`;

  it('should replace an existing field, preserving attributes', () => {
    const out = upsertOpfField(OPF, 'dc:title', 'New Title');
    expect(out).toContain('<dc:title>New Title</dc:title>');
    expect(out).not.toContain('Old Title');
    expect(out).toContain('id="uid"');
  });

  it('should insert a missing field before </metadata>', () => {
    const out = upsertOpfField(OPF, 'dc:publisher', 'BBARIT Press');
    expect(out).toContain('<dc:publisher>BBARIT Press</dc:publisher>');
    expect(out.indexOf('<dc:publisher>')).toBeLessThan(out.indexOf('</metadata>'));
  });

  it('should escape XML special characters in the value', () => {
    const out = upsertOpfField(OPF, 'dc:creator', 'Tom & <Jerry>');
    expect(out).toContain('<dc:creator>Tom &amp; &lt;Jerry&gt;</dc:creator>');
  });

  it('should remove an optional field when the value is empty', () => {
    const withCreator = upsertOpfField(OPF, 'dc:creator', 'Someone');
    const removed = upsertOpfField(withCreator, 'dc:creator', '');
    expect(removed).not.toContain('<dc:creator>');
  });

  it('should keep a required field untouched when given an empty value', () => {
    const out = upsertOpfField(OPF, 'dc:title', '');
    expect(out).toContain('<dc:title>Old Title</dc:title>');
  });
});
