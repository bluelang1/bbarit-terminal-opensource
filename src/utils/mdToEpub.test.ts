import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  normalizeXhtml,
  extractDataUrlImages,
  markdownToEpubBase64,
  multiFilesToEpubBase64,
  markdownToEpub,
  buildCoverSvg,
  validateEpubZip,
  COVER_THEMES,
} from './mdToEpub';

async function unzipEpub(base64: string): Promise<JSZip> {
  return JSZip.loadAsync(base64, { base64: true });
}

describe('normalizeXhtml', () => {
  it('should self-close bare <br>', () => {
    expect(normalizeXhtml('a<br>b')).toBe('a<br/>b');
  });

  it('should self-close <img> with attributes', () => {
    expect(normalizeXhtml('<img src="x.png" alt="y">')).toBe('<img src="x.png" alt="y"/>');
  });

  it('should not double-close an already self-closed void element', () => {
    expect(normalizeXhtml('<br/>')).toBe('<br/>');
    expect(normalizeXhtml('<img src="x" />')).toBe('<img src="x"/>');
  });

  it('should handle <hr>, <meta>, <input>', () => {
    expect(normalizeXhtml('<hr><meta charset="utf-8"><input type="text">'))
      .toBe('<hr/><meta charset="utf-8"/><input type="text"/>');
  });

  it('should leave non-void tags untouched', () => {
    expect(normalizeXhtml('<p>hello</p>')).toBe('<p>hello</p>');
    expect(normalizeXhtml('<div><span>x</span></div>')).toBe('<div><span>x</span></div>');
  });

  it('should preserve a slash inside a quoted attribute value', () => {
    expect(normalizeXhtml('<img src="a/b.png">')).toBe('<img src="a/b.png"/>');
  });

  it('should match void tags case-insensitively (normalizing to lowercase)', () => {
    expect(normalizeXhtml('<BR>')).toBe('<br/>');
  });
});

describe('extractDataUrlImages', () => {
  it('should extract a base64 png into a file and rewrite src', () => {
    const html = '<p><img src="data:image/png;base64,AAAA" alt="x"></p>';
    const { html: out, images } = extractDataUrlImages(html, 0);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ filename: 'images/img0.png', mediaType: 'image/png', base64: 'AAAA' });
    expect(out).toContain('src="images/img0.png"');
    expect(out).not.toContain('data:image');
  });

  it('should map jpeg to a .jpg extension', () => {
    const { images } = extractDataUrlImages('<img src="data:image/jpeg;base64,ZZ">', 0);
    expect(images[0].filename).toBe('images/img0.jpg');
    expect(images[0].mediaType).toBe('image/jpeg');
  });

  it('should continue numbering from startIndex', () => {
    const { images } = extractDataUrlImages('<img src="data:image/gif;base64,QQ">', 3);
    expect(images[0].filename).toBe('images/img3.gif');
  });

  it('should handle multiple images in one chapter', () => {
    const html = '<img src="data:image/png;base64,AA"><img src="data:image/png;base64,BB">';
    const { images } = extractDataUrlImages(html, 0);
    expect(images.map(i => i.filename)).toEqual(['images/img0.png', 'images/img1.png']);
  });

  it('should leave remote and relative image sources untouched', () => {
    const html = '<img src="https://x.com/a.png"><img src="local/b.png">';
    const { html: out, images } = extractDataUrlImages(html, 0);
    expect(images).toHaveLength(0);
    expect(out).toBe(html);
  });

  it('should support single-quoted sources', () => {
    const { images, html: out } = extractDataUrlImages("<img src='data:image/webp;base64,CC'>", 0);
    expect(images[0].filename).toBe('images/img0.webp');
    expect(out).toContain("src='images/img0.webp'");
  });
});

describe('markdownToEpubBase64 style options', () => {
  it('should apply author and language to content.opf', async () => {
    const base64 = await markdownToEpubBase64({
      markdown: '# Chapter\n\nbody',
      title: 'My Book',
      style: { author: 'Jane Doe', language: 'ja' },
    });
    const zip = await unzipEpub(base64);
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toContain('<dc:creator>Jane Doe</dc:creator>');
    expect(opf).toContain('<dc:language>ja</dc:language>');
    expect(opf).toContain('<dc:title>My Book</dc:title>');
  });

  it('should omit dc:creator when author is empty', async () => {
    const base64 = await markdownToEpubBase64({ markdown: '# H\n\nx', title: 'T' });
    const zip = await unzipEpub(base64);
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).not.toContain('<dc:creator>');
  });

  it('should apply fontFamily and lineHeight to chapter body style', async () => {
    const base64 = await markdownToEpubBase64({
      markdown: '# H\n\nbody',
      title: 'T',
      style: { fontFamily: 'sans-serif', lineHeight: 2.1 },
    });
    const zip = await unzipEpub(base64);
    const chapter = await zip.file('OEBPS/chapter0.xhtml')!.async('string');
    expect(chapter).toContain('font-family: sans-serif');
    expect(chapter).toContain('line-height: 2.1');
  });

  it('should split chapters by H2 when chapterSplit is h2', async () => {
    const base64 = await markdownToEpubBase64({
      markdown: '## First\n\na\n\n## Second\n\nb',
      title: 'T',
      style: { chapterSplit: 'h2' },
    });
    const zip = await unzipEpub(base64);
    expect(zip.file('OEBPS/chapter0.xhtml')).not.toBeNull();
    expect(zip.file('OEBPS/chapter1.xhtml')).not.toBeNull();
    const toc = await zip.file('OEBPS/toc.ncx')!.async('string');
    expect(toc).toContain('First');
    expect(toc).toContain('Second');
  });
});

describe('multiFilesToEpubBase64 style options', () => {
  it('should forward style to a merged multi-file book', async () => {
    const base64 = await multiFilesToEpubBase64({
      files: [
        { name: 'a.md', type: 'md', data: '# A\n\naaa' },
        { name: 'b.md', type: 'md', data: '# B\n\nbbb' },
      ],
      title: 'Merged',
      style: { author: 'Team', language: 'ko' },
    });
    const zip = await unzipEpub(base64);
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toContain('<dc:creator>Team</dc:creator>');
    expect(opf).toContain('<dc:language>ko</dc:language>');
    expect(zip.file('OEBPS/chapter1.xhtml')).not.toBeNull();
  });
});

describe('buildCoverSvg', () => {
  it('should produce a 1600x2560 SVG with the title text', () => {
    const svg = buildCoverSvg('Hello World', 'Jane Doe', 'ink');
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg).toContain('width="1600"');
    expect(svg).toContain('height="2560"');
    expect(svg).toContain('Hello');
    expect(svg).toContain('Jane Doe');
    expect(svg).toContain(COVER_THEMES.ink.bg);
  });

  it('should escape XML-special characters in the title', () => {
    const svg = buildCoverSvg('A & B <x>', '', 'midnight');
    expect(svg).toContain('A &amp; B &lt;x&gt;');
    expect(svg).not.toContain('<x>');
  });

  it('should omit the author line when no author is given', () => {
    const svg = buildCoverSvg('Solo', '', 'sage');
    // Only the fixed footer mark should remain as extra <text> beyond the title.
    expect(svg).toContain('BBARIT TERMINAL');
  });

  it('should fall back to a default theme for an unknown name', () => {
    const svg = buildCoverSvg('T', '', 'nope' as never);
    expect(svg).toContain(COVER_THEMES.ink.bg);
  });
});

describe('cover, front matter, and metadata', () => {
  it('should embed a generated SVG cover with cover-image + meta cover', async () => {
    const base64 = await markdownToEpubBase64({
      markdown: '# Ch\n\nbody',
      title: 'Covered',
      style: { cover: { kind: 'theme', theme: 'burgundy' } },
    });
    const zip = await unzipEpub(base64);
    expect(zip.file('OEBPS/cover.svg')).not.toBeNull();
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
  });

  it('should honor a user-supplied cover image', async () => {
    const base64 = await markdownToEpubBase64({
      markdown: '# Ch\n\nbody',
      title: 'ImgCover',
      style: { cover: { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' } },
    });
    const zip = await unzipEpub(base64);
    expect(zip.file('OEBPS/cover.png')).not.toBeNull();
    expect(zip.file('OEBPS/cover.svg')).toBeNull();
  });

  it('should omit cover files and pages when cover is none', async () => {
    const base64 = await markdownToEpubBase64({
      markdown: '# Ch\n\nbody',
      title: 'NoCover',
      style: { cover: { kind: 'none' } },
    });
    const zip = await unzipEpub(base64);
    expect(zip.file('OEBPS/cover.svg')).toBeNull();
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).not.toContain('cover-image');
  });

  it('should write front matter pages and publisher/date/identifier metadata', async () => {
    const base64 = await markdownToEpubBase64({
      markdown: '# One\n\na\n\n# Two\n\nb',
      title: 'Full Book',
      style: { publisher: 'BBARIT Press', publishedDate: '2026-01-02', identifier: 'urn:uuid:fixed-id' },
    });
    const zip = await unzipEpub(base64);
    expect(zip.file('OEBPS/titlepage.xhtml')).not.toBeNull();
    expect(zip.file('OEBPS/colophon.xhtml')).not.toBeNull();
    expect(zip.file('OEBPS/contents.xhtml')).not.toBeNull();
    expect(zip.file('OEBPS/nav.xhtml')).not.toBeNull();
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toContain('<dc:publisher>BBARIT Press</dc:publisher>');
    expect(opf).toContain('<dc:date>2026-01-02</dc:date>');
    expect(opf).toContain('urn:uuid:fixed-id');
    expect(opf).toContain('properties="nav"');
    const colophon = await zip.file('OEBPS/colophon.xhtml')!.async('string');
    expect(colophon).toContain('Generated with BBARIT Terminal');
  });

  it('should generate a uuid identifier when none is supplied', async () => {
    const base64 = await markdownToEpubBase64({ markdown: '# H\n\nx', title: 'T' });
    const zip = await unzipEpub(base64);
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toMatch(/<dc:identifier id="uid">urn:uuid:[0-9a-f-]{36}<\/dc:identifier>/);
  });

  it('should drop front matter pages when toggled off', async () => {
    const base64 = await markdownToEpubBase64({
      markdown: '# H\n\nx',
      title: 'T',
      style: { titlePage: false, colophon: false, tocPage: false, cover: { kind: 'none' } },
    });
    const zip = await unzipEpub(base64);
    expect(zip.file('OEBPS/titlepage.xhtml')).toBeNull();
    expect(zip.file('OEBPS/colophon.xhtml')).toBeNull();
    expect(zip.file('OEBPS/contents.xhtml')).toBeNull();
    // nav is always required by EPUB3
    expect(zip.file('OEBPS/nav.xhtml')).not.toBeNull();
  });
});

describe('validateEpubZip', () => {
  it('should report no warnings for a freshly generated book', async () => {
    const { base64, warnings } = await markdownToEpub({ markdown: '# H\n\nx', title: 'Valid' });
    expect(warnings).toEqual([]);
    const zip = await unzipEpub(base64);
    expect(await validateEpubZip(zip)).toEqual([]);
  });

  it('should flag a missing manifest target', async () => {
    const { base64 } = await markdownToEpub({ markdown: '# H\n\nx', title: 'Broken' });
    const zip = await unzipEpub(base64);
    zip.remove('OEBPS/chapter0.xhtml');
    const warnings = await validateEpubZip(zip);
    expect(warnings.some(w => w.includes('chapter0.xhtml'))).toBe(true);
  });

  it('should flag a wrong mimetype', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'text/plain');
    zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
    zip.file('OEBPS/content.opf', '<package><manifest></manifest><spine></spine></package>');
    const warnings = await validateEpubZip(zip);
    expect(warnings.some(w => w.includes('mimetype content'))).toBe(true);
  });
});
