/**
 * mdToEpub.ts
 *
 * Converts Markdown content to EPUB using markdown-it (MD -> HTML)
 * and JSZip (HTML -> EPUB ZIP archive).
 *
 * Splits by H1 headings into chapters. If no H1 found, treats entire
 * content as a single chapter.
 */

import MarkdownIt from 'markdown-it';
import JSZip from 'jszip';

export type CoverTheme = 'ink' | 'midnight' | 'sage' | 'burgundy' | 'slate' | 'sand';
export type TypographyPreset = 'classic' | 'modern' | 'compact';

/** How the book cover is produced. */
export type CoverOption =
  | { kind: 'theme'; theme: CoverTheme }         // auto-generated SVG cover
  | { kind: 'image'; dataUrl: string }           // user-supplied image (data URL)
  | { kind: 'none' };                            // no cover

export interface EpubStyleOptions {
  fontSize?: number;       // px, default 16
  lineHeight?: number;     // default 1.7
  fontFamily?: 'serif' | 'sans-serif' | 'monospace';  // default 'serif'
  /** Typography preset — richer font stack + layout. Overrides fontFamily when set. */
  typography?: TypographyPreset;
  padding?: number;        // em, default 1
  author?: string;         // dc:creator
  language?: string;       // dc:language, default 'ko'
  chapterSplit?: 'h1' | 'h2' | 'file';  // default 'h1'
  publisher?: string;      // dc:publisher
  publishedDate?: string;  // dc:date (ISO yyyy-mm-dd)
  identifier?: string;     // dc:identifier — auto uuid when empty
  cover?: CoverOption;     // default { kind: 'theme', theme: 'ink' }
  titlePage?: boolean;     // half-title page in front matter, default true
  colophon?: boolean;      // colophon / imprint page, default true
  tocPage?: boolean;       // styled visual table-of-contents page, default true
}

export const EPUB_STYLE_DEFAULTS: Required<EpubStyleOptions> = {
  fontSize: 16,
  lineHeight: 1.7,
  fontFamily: 'serif',
  typography: 'classic',
  padding: 1,
  author: '',
  language: 'ko',
  chapterSplit: 'h1',
  publisher: '',
  publishedDate: '',
  identifier: '',
  cover: { kind: 'theme', theme: 'ink' },
  titlePage: true,
  colophon: true,
  tocPage: true,
};

export interface MdToEpubOptions {
  markdown: string;
  title?: string;
  style?: EpubStyleOptions;
}

/** Result of a build: the base64 EPUB and any structural validation warnings. */
export interface EpubBuildResult {
  base64: string;
  warnings: string[];
}

interface Chapter {
  title: string;
  html: string;
}

/**
 * Convert markdown to EPUB and return as base64 string.
 */
export async function markdownToEpubBase64(opts: MdToEpubOptions): Promise<string> {
  return (await markdownToEpub(opts)).base64;
}

/** Convert markdown to EPUB, returning the base64 payload and validation warnings. */
export async function markdownToEpub(opts: MdToEpubOptions): Promise<EpubBuildResult> {
  const { markdown, title = 'Untitled', style } = opts;
  const s = { ...EPUB_STYLE_DEFAULTS, ...style };

  const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
  const fullHtml = md.render(markdown);
  const chapters = splitByHeading(fullHtml, title, s.chapterSplit);

  return buildEpub(chapters, title, s);
}

/** Split rendered HTML by heading tags into chapters */
function splitByHeading(html: string, fallbackTitle: string, level: 'h1' | 'h2' | 'file' = 'h1'): Chapter[] {
  if (level === 'file') {
    return [{ title: fallbackTitle, html }];
  }

  const tag = level === 'h2' ? 'h[12]' : 'h1';
  const regex = new RegExp(`<(${tag})[^>]*>(.*?)<\\/\\1>`, 'gi');
  const matches: { index: number; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    matches.push({ index: m.index, title: stripHtml(m[2]) });
  }

  if (matches.length === 0) {
    return [{ title: fallbackTitle, html }];
  }

  const parts: Chapter[] = [];

  if (matches[0].index > 0) {
    const pre = html.substring(0, matches[0].index);
    if (pre.trim()) parts.push({ title: fallbackTitle, html: pre });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : html.length;
    parts.push({ title: matches[i].title, html: html.substring(start, end) });
  }

  return parts;
}

// ─── Multi-file EPUB ──────────────────────────────────────────

export interface EpubFileSource {
  /** Display name (e.g. "README.md") */
  name: string;
  /** File type */
  type: 'md' | 'docx' | 'pptx' | 'txt';
  /** For md/txt: raw text content. For docx/pptx: base64 data URL */
  data: string;
}

export interface MultiFileEpubOptions {
  files: EpubFileSource[];
  title?: string;
  style?: EpubStyleOptions;
}

/** Convert a docx base64 data URL to HTML using mammoth */
async function docxToHtml(dataUrl: string): Promise<string> {
  const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
  if (!base64.trim()) return '<p></p>';
  const mammoth = await import('mammoth');
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  const result = await mammoth.convertToHtml(
    { arrayBuffer: bytes.buffer },
    {
      convertImage: mammoth.images.imgElement(function (image: any) {
        return image.read('base64').then(function (buf: string) {
          return { src: `data:${image.contentType};base64,${buf}` };
        });
      }),
    },
  );
  return result.value;
}

/** Convert a pptx base64 data URL to HTML (text extraction from slides) */
async function pptxToHtml(dataUrl: string): Promise<string> {
  const { parsePptxFromBase64 } = await import('../components/pptx/pptxParser');
  const { slides } = await parsePptxFromBase64(dataUrl);
  const parts: string[] = [];
  for (let si = 0; si < slides.length; si++) {
    const slide = slides[si];
    const texts = slide.elements
      .filter((el) => el.type === 'text' && el.text?.trim())
      .map((el) => `<p>${escapeXml(el.text!)}</p>`)
      .join('\n');
    if (texts) {
      parts.push(`<h2>Slide ${si + 1}</h2>\n${texts}`);
    }
  }
  return parts.join('\n') || '<p>(No text content)</p>';
}

/** Convert multiple files (md, docx, pptx, txt) into a single EPUB (base64). */
export async function multiFilesToEpubBase64(opts: MultiFileEpubOptions): Promise<string> {
  return (await multiFilesToEpub(opts)).base64;
}

/** Convert multiple files into one EPUB, returning base64 plus validation warnings. */
export async function multiFilesToEpub(opts: MultiFileEpubOptions): Promise<EpubBuildResult> {
  const { files, title = 'Untitled', style } = opts;
  const s = { ...EPUB_STYLE_DEFAULTS, ...style };
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

  // Convert each file to chapter(s)
  const allChapters: Chapter[] = [];

  for (const file of files) {
    const label = file.name.replace(/\.[^.]+$/, '');
    let html: string;
    switch (file.type) {
      case 'md':
        html = md.render(file.data);
        allChapters.push(...splitByHeading(html, label, s.chapterSplit));
        continue;
      case 'docx':
        html = await docxToHtml(file.data);
        break;
      case 'pptx':
        html = await pptxToHtml(file.data);
        break;
      default: // txt
        html = `<pre>${escapeXml(file.data)}</pre>`;
        break;
    }
    allChapters.push({ title: label, html });
  }

  if (allChapters.length === 0) {
    allChapters.push({ title, html: '<p></p>' });
  }

  return buildEpub(allChapters, title, s);
}

/**
 * Assemble a full EPUB (cover, front matter, chapters, EPUB3 nav + NCX),
 * return the base64 payload, then re-open the archive to validate its
 * structure. Generation always succeeds; problems come back as warnings.
 */
async function buildEpub(chapters: Chapter[], title: string, style: Required<EpubStyleOptions>): Promise<EpubBuildResult> {
  const zip = assembleEpubZip(chapters, title, style);
  const base64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
  let warnings: string[] = [];
  try {
    const reopened = await JSZip.loadAsync(base64, { base64: true });
    warnings = await validateEpubZip(reopened);
  } catch (err) {
    warnings = [`Could not re-open the generated EPUB for validation: ${String(err)}`];
  }
  return { base64, warnings };
}

/** Build the in-memory zip for an EPUB. Kept separate from base64 generation. */
function assembleEpubZip(chapters: Chapter[], title: string, style: Required<EpubStyleOptions>): JSZip {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  const author = style.author.trim();
  const publisher = style.publisher.trim();
  const publishedDate = style.publishedDate.trim();
  const identifier = style.identifier.trim() || `urn:uuid:${generateUuid()}`;

  // Extract embedded (data URL) images into real files, then normalize each
  // chapter's HTML into valid XHTML before it goes into the zip.
  const embeddedImages: EmbeddedImage[] = [];
  const processedChapters = chapters.map((ch) => {
    const extracted = extractDataUrlImages(ch.html, embeddedImages.length);
    embeddedImages.push(...extracted.images);
    return { title: ch.title, html: normalizeXhtml(extracted.html) };
  });
  for (const img of embeddedImages) {
    zip.file(`OEBPS/${img.filename}`, img.base64, { base64: true });
  }

  // Shared stylesheet — one place for the whole book's typography.
  zip.file('OEBPS/style.css', buildBookCss(style));

  // ── Cover ────────────────────────────────────────────────
  const cover = resolveCover(style.cover, title, author);
  if (cover) {
    zip.file(`OEBPS/${cover.filename}`, cover.base64, { base64: true });
  }

  // ── Front matter + chapter spine, in reading order ───────
  interface Doc { id: string; href: string; }
  const manifestDocs: { id: string; href: string; media: string; properties?: string }[] = [];
  const spine: Doc[] = [];

  if (cover) {
    zip.file('OEBPS/cover.xhtml', coverPageXhtml(cover.filename, title));
    manifestDocs.push({ id: 'coverpage', href: 'cover.xhtml', media: 'application/xhtml+xml' });
    manifestDocs.push({ id: 'cover-image', href: cover.filename, media: cover.mediaType, properties: 'cover-image' });
    spine.push({ id: 'coverpage', href: 'cover.xhtml' });
  }
  if (style.titlePage) {
    zip.file('OEBPS/titlepage.xhtml', titlePageXhtml(title, author));
    manifestDocs.push({ id: 'titlepage', href: 'titlepage.xhtml', media: 'application/xhtml+xml' });
    spine.push({ id: 'titlepage', href: 'titlepage.xhtml' });
  }
  if (style.colophon) {
    zip.file('OEBPS/colophon.xhtml', colophonXhtml(title, author, publisher, publishedDate, identifier));
    manifestDocs.push({ id: 'colophon', href: 'colophon.xhtml', media: 'application/xhtml+xml' });
    spine.push({ id: 'colophon', href: 'colophon.xhtml' });
  }
  if (style.tocPage) {
    zip.file('OEBPS/contents.xhtml', tocPageXhtml(processedChapters.map(c => c.title)));
    manifestDocs.push({ id: 'contents', href: 'contents.xhtml', media: 'application/xhtml+xml' });
    spine.push({ id: 'contents', href: 'contents.xhtml' });
  }

  for (let i = 0; i < processedChapters.length; i++) {
    const ch = processedChapters[i];
    zip.file(`OEBPS/chapter${i}.xhtml`, chapterXhtml(ch.title, ch.html, style));
    manifestDocs.push({ id: `ch${i}`, href: `chapter${i}.xhtml`, media: 'application/xhtml+xml' });
    spine.push({ id: `ch${i}`, href: `chapter${i}.xhtml` });
  }

  // ── EPUB3 navigation document + legacy NCX ───────────────
  const chapterHrefs = processedChapters.map((_, i) => `chapter${i}.xhtml`);
  zip.file('OEBPS/nav.xhtml', navXhtml(title, processedChapters.map(c => c.title), chapterHrefs));

  const docManifest = manifestDocs.map(d =>
    `    <item id="${d.id}" href="${d.href}" media-type="${d.media}"${d.properties ? ` properties="${d.properties}"` : ''}/>`
  ).join('\n');
  const imageManifestItems = embeddedImages.map((img, i) =>
    `    <item id="eimg${i}" href="${img.filename}" media-type="${img.mediaType}"/>`
  ).join('\n');
  const spineItems = spine.map(d => `    <itemref idref="${d.id}"/>`).join('\n');

  const meta: string[] = [
    `    <dc:title>${escapeXml(title)}</dc:title>`,
    `    <dc:language>${escapeXml(style.language)}</dc:language>`,
  ];
  if (author) meta.push(`    <dc:creator>${escapeXml(author)}</dc:creator>`);
  if (publisher) meta.push(`    <dc:publisher>${escapeXml(publisher)}</dc:publisher>`);
  if (publishedDate) meta.push(`    <dc:date>${escapeXml(publishedDate)}</dc:date>`);
  meta.push(`    <dc:identifier id="uid">${escapeXml(identifier)}</dc:identifier>`);
  meta.push(`    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>`);
  meta.push(`    <meta name="generator" content="BBARIT Terminal"/>`);
  if (cover) meta.push(`    <meta name="cover" content="cover-image"/>`);

  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${meta.join('\n')}
  </metadata>
  <manifest>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${docManifest}${imageManifestItems ? '\n' + imageManifestItems : ''}
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>`);

  const navPoints = processedChapters.map((ch, i) =>
    `    <navPoint id="np${i}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(ch.title)}</text></navLabel>
      <content src="chapter${i}.xhtml"/>
    </navPoint>`
  ).join('\n');

  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${escapeXml(identifier)}"/></head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`);

  return zip;
}

// ─── Typography & book stylesheet ─────────────────────────────

const TYPOGRAPHY: Record<TypographyPreset, { indent: string; align: string; paraGap: string }> = {
  classic: { indent: '1.4em', align: 'justify', paraGap: '0' },
  modern:  { indent: '0',     align: 'left',    paraGap: '0.9em' },
  compact: { indent: '0',     align: 'left',    paraGap: '0.45em' },
};

/**
 * The shared book stylesheet (structure/typography — not the tunable body font).
 * Exported so the Book Studio preview can typeset a chapter with the exact CSS
 * the exported EPUB uses.
 */
export function buildBookCss(style: Required<EpubStyleOptions>): string {
  const t = TYPOGRAPHY[style.typography] || TYPOGRAPHY.classic;
  return `/* BBARIT Terminal — book stylesheet */
body { margin: 0 auto; max-width: 40em; word-break: keep-all; overflow-wrap: break-word; }
p { margin: ${t.paraGap} 0; text-align: ${t.align}; text-indent: ${t.indent}; }
p:first-of-type, h1 + p, h2 + p, h3 + p, h4 + p, blockquote p, li p { text-indent: 0; }
h1, h2, h3, h4 { font-weight: 700; line-height: 1.3; word-break: keep-all; }
h1 { margin: 1.8em 0 0.9em; padding-bottom: 0.35em; border-bottom: 2px solid currentColor; }
h2 { margin: 1.5em 0 0.6em; }
h3 { margin: 1.2em 0 0.4em; }
blockquote { border-left: 3px solid #b9b9b9; margin: 1.2em 0; padding: 0.4em 1.1em; color: #555; font-style: italic; }
code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace; background: #f2f2f2; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
pre { background: #f6f6f6; padding: 12px 14px; border-radius: 6px; overflow-x: auto; line-height: 1.5; }
pre code { background: none; padding: 0; font-size: 0.86em; }
table { border-collapse: collapse; width: 100%; margin: 1.2em 0; }
th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; }
th { background: #f0f0f0; }
img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid #ccc; margin: 2em 0; }
a { color: inherit; }
`;
}

// ─── Document templates ───────────────────────────────────────

function chapterXhtml(chTitle: string, bodyHtml: string, style: Required<EpubStyleOptions>): string {
  const bodyStyle = `font-family: ${style.fontFamily}; font-size: ${style.fontSize}px; line-height: ${style.lineHeight}; padding: ${style.padding}em;`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(chTitle)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
  <style>body { ${bodyStyle} }</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/** A front-matter page with its own centered layout. */
function frontMatterPage(titleAttr: string, inlineCss: string, bodyInner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(titleAttr)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
  <style>${inlineCss}</style>
</head>
<body>
${bodyInner}
</body>
</html>`;
}

function coverPageXhtml(coverFilename: string, title: string): string {
  return frontMatterPage(
    'Cover',
    `body { margin: 0; padding: 0; text-align: center; } .cover-full { max-width: 100%; max-height: 100vh; }`,
    `<div><img class="cover-full" src="${coverFilename}" alt="${escapeXml(title)}"/></div>`,
  );
}

function titlePageXhtml(title: string, author: string): string {
  const authorLine = author ? `<p class="tp-author">${escapeXml(author)}</p>` : '';
  return frontMatterPage(
    title,
    `body { display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 90vh; text-align: center; padding: 2em; }
     .tp-title { font-size: 2.2em; border: none; margin: 0 0 0.5em; line-height: 1.25; }
     .tp-rule { width: 3em; height: 3px; background: currentColor; opacity: 0.5; margin: 0.4em auto 0.8em; }
     .tp-author { font-size: 1.15em; opacity: 0.75; margin: 0; }`,
    `<h1 class="tp-title">${escapeXml(title)}</h1><div class="tp-rule"></div>${authorLine}`,
  );
}

function colophonXhtml(title: string, author: string, publisher: string, publishedDate: string, identifier: string): string {
  const rows: string[] = [];
  if (author) rows.push(`<p class="col-row"><span class="col-key">Author</span> ${escapeXml(author)}</p>`);
  if (publisher) rows.push(`<p class="col-row"><span class="col-key">Publisher</span> ${escapeXml(publisher)}</p>`);
  if (publishedDate) rows.push(`<p class="col-row"><span class="col-key">Published</span> ${escapeXml(publishedDate)}</p>`);
  rows.push(`<p class="col-row"><span class="col-key">Identifier</span> ${escapeXml(identifier)}</p>`);
  return frontMatterPage(
    'Colophon',
    `body { display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 90vh; text-align: center; padding: 2em; }
     .col-title { font-size: 1.5em; border: none; margin: 0 0 1.2em; }
     .col-row { margin: 0.3em 0; font-size: 0.95em; opacity: 0.85; text-indent: 0; }
     .col-key { display: inline-block; min-width: 5.5em; opacity: 0.55; text-align: right; margin-right: 0.6em; }
     .col-mark { margin-top: 2em; font-size: 0.85em; opacity: 0.5; letter-spacing: 0.08em; }`,
    `<h1 class="col-title">${escapeXml(title)}</h1>${rows.join('')}<p class="col-mark">Generated with BBARIT Terminal</p>`,
  );
}

function tocPageXhtml(chapterTitles: string[]): string {
  const items = chapterTitles.map((t, i) =>
    `<li class="toc-line"><a href="chapter${i}.xhtml">${escapeXml(t)}</a></li>`
  ).join('\n');
  return frontMatterPage(
    'Contents',
    `body { padding: 2.5em 2em; }
     .toc-h { font-size: 1.6em; border: none; margin: 0 0 1em; }
     ol.toc-list { list-style: none; padding: 0; margin: 0; counter-reset: toc; }
     .toc-line { counter-increment: toc; padding: 0.45em 0; border-bottom: 1px solid rgba(128,128,128,0.2); text-indent: 0; }
     .toc-line a { text-decoration: none; }
     .toc-line a::before { content: counter(toc) ".  "; opacity: 0.5; }`,
    `<h1 class="toc-h">Contents</h1><ol class="toc-list">\n${items}\n</ol>`,
  );
}

function navXhtml(title: string, chapterTitles: string[], hrefs: string[]): string {
  const items = chapterTitles.map((t, i) =>
    `      <li><a href="${hrefs[i]}">${escapeXml(t)}</a></li>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(title)}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>`;
}

// ─── Cover ────────────────────────────────────────────────────

export const COVER_THEMES: Record<CoverTheme, { bg: string; accent: string; title: string; sub: string }> = {
  ink:      { bg: '#161a23', accent: '#e0b15e', title: '#f5f2ea', sub: '#c8c2b4' },
  midnight: { bg: '#0b1220', accent: '#5aa9e6', title: '#eaf1fb', sub: '#a9bcd6' },
  sage:     { bg: '#28332c', accent: '#9db387', title: '#f1efe4', sub: '#c3ccb8' },
  burgundy: { bg: '#3f1622', accent: '#d3a15f', title: '#f6ece2', sub: '#d9bfb2' },
  slate:    { bg: '#2c3440', accent: '#8fa3b8', title: '#f4f6f9', sub: '#b6c0cc' },
  sand:     { bg: '#ece4d3', accent: '#a9784a', title: '#2c2416', sub: '#6a5b45' },
};

/**
 * Build a self-contained SVG book cover (1600×2560). Pure — no DOM access,
 * so it is unit-testable and deterministic apart from wrapping.
 */
export function buildCoverSvg(title: string, author: string, theme: CoverTheme): string {
  const c = COVER_THEMES[theme] || COVER_THEMES.ink;
  const W = 1600, H = 2560;
  const cleanTitle = (title || 'Untitled').trim() || 'Untitled';
  const isCjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(cleanTitle);
  const maxChars = isCjk ? 9 : 15;
  const lines = wrapCoverTitle(cleanTitle, maxChars);
  const base = isCjk ? 128 : 150;
  const titleSize = lines.length <= 2 ? base : lines.length === 3 ? Math.round(base * 0.82) : Math.round(base * 0.66);
  const lineGap = Math.round(titleSize * 1.18);
  const blockH = lines.length * lineGap;
  const firstBaseline = Math.round(H * 0.42 - blockH / 2 + titleSize);
  const tspans = lines.map((ln, i) =>
    `<tspan x="${W / 2}" y="${firstBaseline + i * lineGap}">${escapeXml(ln)}</tspan>`
  ).join('');
  const ruleY = firstBaseline + (lines.length - 1) * lineGap + Math.round(titleSize * 0.6);
  const authorSvg = author.trim()
    ? `\n  <text x="${W / 2}" y="${H - 360}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="60" fill="${c.sub}" letter-spacing="3">${escapeXml(author.trim())}</text>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${c.bg}"/>
  <rect x="70" y="70" width="${W - 140}" height="${H - 140}" fill="none" stroke="${c.accent}" stroke-width="4"/>
  <rect x="70" y="70" width="${W - 140}" height="16" fill="${c.accent}"/>
  <rect x="70" y="${H - 86}" width="${W - 140}" height="16" fill="${c.accent}"/>
  <text text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${titleSize}" fill="${c.title}">${tspans}</text>
  <rect x="${W / 2 - 120}" y="${ruleY}" width="240" height="6" fill="${c.accent}"/>${authorSvg}
  <text x="${W / 2}" y="${H - 168}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="34" fill="${c.sub}" letter-spacing="6" opacity="0.75">BBARIT TERMINAL</text>
</svg>`;
}

/** Word-wrap a cover title, hard-splitting words longer than maxChars. Pure. */
function wrapCoverTitle(text: string, maxChars: number): string[] {
  const rawWords = text.split(/\s+/).filter(Boolean);
  const words: string[] = [];
  for (const w of rawWords) {
    if (w.length <= maxChars) { words.push(w); continue; }
    for (let i = 0; i < w.length; i += maxChars) words.push(w.slice(i, i + maxChars));
  }
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines.slice(0, 6) : [''];
}

interface ResolvedCover { filename: string; mediaType: string; base64: string; }

/** Turn a CoverOption into an embeddable file, or null when there is no cover. */
function resolveCover(cover: CoverOption, title: string, author: string): ResolvedCover | null {
  if (cover.kind === 'none') return null;
  if (cover.kind === 'image') {
    const parsed = parseDataUrl(cover.dataUrl);
    if (!parsed) return null;
    return { filename: `cover.${parsed.ext}`, mediaType: parsed.mediaType, base64: parsed.base64 };
  }
  const svg = buildCoverSvg(title, author, cover.theme);
  return { filename: 'cover.svg', mediaType: 'image/svg+xml', base64: utf8ToBase64(svg) };
}

function parseDataUrl(dataUrl: string): { mediaType: string; ext: string; base64: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl.trim());
  if (!m) return null;
  const mediaType = m[1] || 'application/octet-stream';
  const base64 = m[2] ? m[3] : utf8ToBase64(decodeURIComponent(m[3]));
  const subtype = (mediaType.split('/')[1] || 'img').toLowerCase();
  const ext = IMAGE_EXT[subtype] || subtype.replace(/[^a-z0-9]/g, '') || 'img';
  return { mediaType, ext, base64 };
}

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function generateUuid(): string {
  // RFC4122-ish v4 from Math.random — adequate as a book identifier.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ─── Self-validation ──────────────────────────────────────────

/**
 * Re-open a generated EPUB and check its required structure: mimetype first
 * and correct, container.xml → OPF, every manifest href resolves, an EPUB3
 * nav document exists, and every spine idref maps to a manifest item.
 * Returns a list of warnings (empty means the archive looks well-formed).
 */
export async function validateEpubZip(zip: JSZip): Promise<string[]> {
  const warnings: string[] = [];
  const names = Object.keys(zip.files);
  if (names[0] !== 'mimetype') warnings.push('mimetype is not the first zip entry');

  const mimeFile = zip.file('mimetype');
  if (!mimeFile) warnings.push('mimetype file is missing');
  else {
    const mime = (await mimeFile.async('text')).trim();
    if (mime !== 'application/epub+zip') warnings.push(`mimetype content is "${mime}"`);
  }

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) { warnings.push('META-INF/container.xml is missing'); return warnings; }
  const containerXml = await containerFile.async('text');
  const opfPath = (containerXml.match(/full-path="([^"]+)"/) || [])[1];
  if (!opfPath) { warnings.push('container.xml has no rootfile full-path'); return warnings; }

  const opfFile = zip.file(opfPath);
  if (!opfFile) { warnings.push(`OPF package not found: ${opfPath}`); return warnings; }
  const opf = await opfFile.async('text');
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const manifest = new Map<string, { href: string; properties: string }>();
  const itemRe = /<item\b[^>]*>/g;
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(opf)) !== null) {
    const tag = im[0];
    const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
    const href = (tag.match(/\bhref="([^"]+)"/) || [])[1];
    const properties = (tag.match(/\bproperties="([^"]+)"/) || [])[1] || '';
    if (id && href) manifest.set(id, { href, properties });
  }
  if (manifest.size === 0) warnings.push('OPF manifest has no items');

  for (const [id, item] of manifest) {
    if (!zip.file(resolveZipPath(dir, item.href))) {
      warnings.push(`manifest item "${id}" points to a missing file: ${item.href}`);
    }
  }

  const hasNav = Array.from(manifest.values()).some(i => i.properties.split(/\s+/).includes('nav'));
  if (!hasNav) warnings.push('no EPUB3 navigation document (item with properties="nav")');

  const spineRe = /<itemref\b[^>]*\bidref="([^"]+)"/g;
  let sm: RegExpExecArray | null;
  let spineCount = 0;
  while ((sm = spineRe.exec(opf)) !== null) {
    spineCount++;
    if (!manifest.has(sm[1])) warnings.push(`spine references unknown manifest id: ${sm[1]}`);
  }
  if (spineCount === 0) warnings.push('spine has no itemref entries');

  return warnings;
}

/** Resolve a manifest href against the OPF directory (handles ./ and ../). */
function resolveZipPath(base: string, relative: string): string {
  if (relative.startsWith('/')) return relative.slice(1);
  const parts = (base + relative).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── XHTML normalization ──────────────────────────────────────
//
// markdown-it (html:true) and other converters emit HTML with unclosed void
// elements (<br>, <img ...>, <hr>, <meta ...>) that make the document invalid
// XHTML, which strict readers like Apple Books reject. normalizeXhtml rewrites
// every void element into its self-closing form.

const VOID_ELEMENTS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];

/** Rewrite void elements into self-closing XHTML form. Pure. */
export function normalizeXhtml(html: string): string {
  let out = html;
  for (const tag of VOID_ELEMENTS) {
    const re = new RegExp(`<${tag}((?:\\s[^>]*?)?)\\s*/?>`, 'gi');
    out = out.replace(re, (_m, attrs: string) => `<${tag}${attrs.replace(/\s+$/, '')}/>`);
  }
  return out;
}

// ─── Embedded image extraction ────────────────────────────────

export interface EmbeddedImage {
  filename: string;   // relative to the OEBPS chapter, e.g. "images/img0.png"
  mediaType: string;  // e.g. "image/png"
  base64: string;     // raw base64 payload (no data: prefix)
}

const IMAGE_EXT: Record<string, string> = {
  'png': 'png', 'jpeg': 'jpg', 'jpg': 'jpg', 'gif': 'gif',
  'webp': 'webp', 'svg+xml': 'svg', 'bmp': 'bmp',
};

/**
 * Replace inline `data:image/*;base64,...` <img> sources with real image files.
 * Returns the rewritten HTML plus the extracted images to embed in the zip.
 * Remote (http) and relative sources are left untouched. Pure.
 */
export function extractDataUrlImages(html: string, startIndex: number): { html: string; images: EmbeddedImage[] } {
  const images: EmbeddedImage[] = [];
  let counter = startIndex;
  const re = /(<img\b[^>]*?\ssrc=)(["'])data:image\/([a-zA-Z0-9.+-]+);base64,([^"']+)\2/gi;
  const out = html.replace(re, (_m, pre: string, quote: string, subtype: string, base64: string) => {
    const key = subtype.toLowerCase();
    const ext = IMAGE_EXT[key] || 'img';
    const filename = `images/img${counter++}.${ext}`;
    images.push({ filename, mediaType: `image/${key}`, base64 });
    return `${pre}${quote}${filename}${quote}`;
  });
  return { html: out, images };
}
