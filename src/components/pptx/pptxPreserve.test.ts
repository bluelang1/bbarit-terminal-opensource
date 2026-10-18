import { describe, expect, it } from 'vitest';
import {
  parsePptxFromBase64,
  collectTransitiveParts,
  extractRelIds,
  detectGraphicFrameKind,
  relsPathForPart,
  partPathForRels,
  parseRelEntries,
  type RelEntry,
} from './pptxParser';
import {
  exportSlidesToPptx,
  nextRelId,
  remapGraphicFrameRelIds,
  injectGraphicFramesIntoSlide,
  relativeTargetFromSlide,
  mergeSlideRels,
  relIdsInXml,
  addContentTypes,
} from './pptxExport';
import { DEFAULT_SLIDE_SIZE } from './types';

const CHART_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';

// Minimal single-slide PPTX whose only shape is a chart graphicFrame that pulls
// in a chart part, that chart's rels, and an embedded worksheet.
async function makeChartPptx(): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>' +
      '<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>' +
      '</Types>',
  );

  zip.file(
    'ppt/presentation.xml',
    '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
  );

  zip.file(
    'ppt/slides/slide1.xml',
    '<?xml version="1.0"?>' +
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"' +
      ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<p:cSld><p:spTree>' +
      '<p:graphicFrame>' +
      '<p:xfrm><a:off x="1524000" y="1143000"/><a:ext cx="6096000" cy="2743200"/></p:xfrm>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
      '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId2"/>' +
      '</a:graphicData></a:graphic>' +
      '</p:graphicFrame>' +
      '</p:spTree></p:cSld></p:sld>',
  );

  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    '<?xml version="1.0"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      `<Relationship Id="rId2" Type="${CHART_REL_TYPE}" Target="../charts/chart1.xml"/>` +
      '</Relationships>',
  );

  zip.file(
    'ppt/charts/chart1.xml',
    '<?xml version="1.0"?>' +
      '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<c:externalData r:id="rId1"/></c:chartSpace>',
  );

  zip.file(
    'ppt/charts/_rels/chart1.xml.rels',
    '<?xml version="1.0"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet.xlsx"/>' +
      '</Relationships>',
  );

  zip.file('ppt/embeddings/Microsoft_Excel_Worksheet.xlsx', 'PKfake-xlsx-bytes');

  const base64 = await zip.generateAsync({ type: 'base64' });
  return `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${base64}`;
}

async function loadZip(base64: string) {
  const JSZip = (await import('jszip')).default;
  return JSZip.loadAsync(base64, { base64: true });
}

describe('parsePptxFromBase64 — preserved graphicFrames', () => {
  it('captures a chart graphicFrame and its referenced parts', async () => {
    const url = await makeChartPptx();
    const { slides } = await parsePptxFromBase64(url);
    const preserved = slides[0].preserved;
    expect(preserved).toBeTruthy();
    expect(preserved).toHaveLength(1);

    const part = preserved![0];
    expect(part.kind).toBe('chart');
    expect(part.graphicFrameXml).toContain('graphicFrame');
    // The relationship id survives serialization (prefix may be normalized to ns1: by jsdom).
    expect(part.graphicFrameXml).toContain('"rId2"');

    const paths = part.parts.map((p) => p.path).sort();
    expect(paths).toContain('ppt/charts/chart1.xml');
    expect(paths).toContain('ppt/charts/_rels/chart1.xml.rels');
    expect(paths).toContain('ppt/embeddings/Microsoft_Excel_Worksheet.xlsx');

    expect(part.rels).toEqual([
      { id: 'rId2', target: 'ppt/charts/chart1.xml', type: CHART_REL_TYPE },
    ]);

    const chart = part.parts.find((p) => p.path === 'ppt/charts/chart1.xml')!;
    expect(chart.contentType).toBe('application/vnd.openxmlformats-officedocument.drawingml.chart+xml');
  });

  it('still flags unsupported content so save falls back to a copy', async () => {
    const url = await makeChartPptx();
    const parsed = await parsePptxFromBase64(url);
    expect(parsed.hasUnsupportedContent).toBe(true);
  });

  it('records the frame position from its xfrm', async () => {
    const url = await makeChartPptx();
    const { slides } = await parsePptxFromBase64(url);
    const part = slides[0].preserved![0];
    expect(part.x).toBeCloseTo(12.5, 1); // 1524000 / 12192000
    expect(part.w).toBeCloseTo(50, 1);   // 6096000 / 12192000
  });
});

describe('exportSlidesToPptx — preserved graphicFrames round-trip', () => {
  it('writes the chart parts back and references them from the slide', async () => {
    const url = await makeChartPptx();
    const { slides, slideSize } = await parsePptxFromBase64(url);

    const outBase64 = await exportSlidesToPptx(slides, slideSize);
    const zip = await loadZip(outBase64);

    // Chart + embedding parts exist in the exported package.
    expect(zip.file('ppt/charts/chart1.xml')).toBeTruthy();
    expect(zip.file('ppt/embeddings/Microsoft_Excel_Worksheet.xlsx')).toBeTruthy();

    // A slide relationship points at the chart part …
    const relsXml = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string');
    expect(relsXml).toContain('../charts/chart1.xml');
    const chartRelId = new RegExp('Id="(rId\\d+)"[^>]*Target="\\.\\./charts/chart1\\.xml"').exec(relsXml)?.[1];
    expect(chartRelId).toBeTruthy();

    // … and the re-injected graphicFrame in the slide references it (prefix may be ns1:).
    const slideXml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(slideXml).toContain('graphicFrame');
    expect(slideXml).toContain(`"${chartRelId}"`);

    // Content types declare the chart override + embedding default.
    const ctXml = await zip.file('[Content_Types].xml')!.async('string');
    expect(ctXml).toContain('/ppt/charts/chart1.xml');
    expect(ctXml).toContain('Extension="xlsx"');
  });

  it('leaves a plain deck (no preserved parts) untouched by the pass', async () => {
    const slides = [{ id: 's1', bgColor: '#ffffff', elements: [] }];
    const outBase64 = await exportSlidesToPptx(slides, DEFAULT_SLIDE_SIZE);
    const zip = await loadZip(outBase64);
    expect(zip.file('ppt/charts/chart1.xml')).toBeNull();
  });
});

describe('collectTransitiveParts', () => {
  const relsMap: Record<string, RelEntry[]> = {
    'ppt/charts/chart1.xml': [
      { id: 'rId1', target: 'ppt/embeddings/data.xlsx', type: 'pkg', external: false },
      { id: 'rId2', target: 'ppt/charts/colors1.xml', type: 'colors', external: false },
      { id: 'rId3', target: 'https://example.com', type: 'hyperlink', external: true },
    ],
    'ppt/charts/colors1.xml': [],
    'ppt/embeddings/data.xlsx': [],
  };
  const relsFor = (p: string) => relsMap[p] || [];
  const exists = (p: string) => p in relsMap || p === 'ppt/embeddings/data.xlsx';

  it('walks relationships transitively and skips external targets', () => {
    const parts = collectTransitiveParts(['ppt/charts/chart1.xml'], relsFor, exists).sort();
    expect(parts).toEqual([
      'ppt/charts/chart1.xml',
      'ppt/charts/colors1.xml',
      'ppt/embeddings/data.xlsx',
    ]);
  });

  it('drops seeds that do not exist and does not loop on cycles', () => {
    const cyclic: Record<string, RelEntry[]> = {
      a: [{ id: 'r1', target: 'b', type: 't', external: false }],
      b: [{ id: 'r1', target: 'a', type: 't', external: false }],
    };
    const parts = collectTransitiveParts(['a', 'missing'], (p) => cyclic[p] || [], (p) => p in cyclic);
    expect(parts.sort()).toEqual(['a', 'b']);
  });
});

describe('preserve pure helpers', () => {
  it('extractRelIds finds every r:* id attribute', () => {
    const xml = '<x r:id="rId2" r:embed="rId7"/><y r:dm="rId3"/>';
    expect(extractRelIds(xml).sort()).toEqual(['rId2', 'rId3', 'rId7']);
  });

  it('detectGraphicFrameKind classifies by graphicData uri', () => {
    expect(detectGraphicFrameKind('<a:graphicData uri="http://x/chart">')).toBe('chart');
    expect(detectGraphicFrameKind('<a:graphicData uri="http://x/diagram">')).toBe('diagram');
    expect(detectGraphicFrameKind('<a:graphicData uri="http://x/ole">')).toBe('graphicFrame');
  });

  it('maps between a part and its .rels path', () => {
    expect(relsPathForPart('ppt/charts/chart1.xml')).toBe('ppt/charts/_rels/chart1.xml.rels');
    expect(partPathForRels('ppt/charts/_rels/chart1.xml.rels')).toBe('ppt/charts/chart1.xml');
  });

  it('parseRelEntries resolves internal targets and flags external ones', () => {
    const xml =
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="t1" Target="../charts/chart1.xml"/>' +
      '<Relationship Id="rId2" Type="t2" Target="http://x" TargetMode="External"/>' +
      '</Relationships>';
    const entries = parseRelEntries(xml, 'ppt/slides/slide1.xml');
    expect(entries[0]).toEqual({ id: 'rId1', target: 'ppt/charts/chart1.xml', type: 't1', external: false });
    expect(entries[1]).toEqual({ id: 'rId2', target: 'http://x', type: 't2', external: true });
  });

  it('nextRelId returns the next free id', () => {
    expect(nextRelId(['rId1', 'rId3'])).toBe('rId4');
    expect(nextRelId([])).toBe('rId1');
  });

  it('remapGraphicFrameRelIds rewrites all r:* attributes', () => {
    const xml = '<c:chart r:id="rId2"/><a:dgm r:dm="rId2"/>';
    const out = remapGraphicFrameRelIds(xml, new Map([['rId2', 'rId9']]));
    expect(out).toBe('<c:chart r:id="rId9"/><a:dgm r:dm="rId9"/>');
  });

  it('injectGraphicFramesIntoSlide inserts before spTree close', () => {
    const slide = '<p:spTree><p:sp/></p:spTree>';
    expect(injectGraphicFramesIntoSlide(slide, ['<p:graphicFrame/>']))
      .toBe('<p:spTree><p:sp/><p:graphicFrame/></p:spTree>');
    expect(injectGraphicFramesIntoSlide(slide, [])).toBe(slide);
  });

  it('relativeTargetFromSlide builds slide-relative targets', () => {
    expect(relativeTargetFromSlide('ppt/charts/chart1.xml')).toBe('../charts/chart1.xml');
  });

  it('mergeSlideRels appends and can create a fresh rels file', () => {
    const existing =
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="t" Target="../slideLayouts/slideLayout1.xml"/></Relationships>';
    const merged = mergeSlideRels(existing, [{ id: 'rId2', target: '../charts/chart1.xml', type: 'c' }]);
    expect(relIdsInXml(merged).sort()).toEqual(['rId1', 'rId2']);
    expect(merged).toContain('../charts/chart1.xml');

    const fresh = mergeSlideRels(null, [{ id: 'rId1', target: '../charts/chart1.xml', type: 'c' }]);
    expect(fresh).toContain('<Relationships');
    expect(fresh).toContain('Id="rId1"');
  });

  it('addContentTypes adds only missing defaults and overrides', () => {
    const ct =
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="app/rels"/></Types>';
    const out = addContentTypes(
      ct,
      [{ part: '/ppt/charts/chart1.xml', type: 'app/chart' }],
      [{ ext: 'rels', type: 'app/rels' }, { ext: 'xlsx', type: 'app/xlsx' }],
    );
    expect(out).toContain('Extension="xlsx"');
    expect(out).toContain('PartName="/ppt/charts/chart1.xml"');
    // 'rels' default already present → not duplicated.
    expect(out.match(/Extension="rels"/g)).toHaveLength(1);
  });
});
