import { describe, expect, it } from 'vitest';
import { parsePptxFromBase64, buildTableGrid, type RawTableCell } from './pptxParser';

// Build a minimal single-slide PPTX in-memory and return it as a base64 data URL.
async function makePptxWith(slideXml: string): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file(
    'ppt/presentation.xml',
    '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
  );
  zip.file('ppt/slides/slide1.xml', slideXml);
  const base64 = await zip.generateAsync({ type: 'base64' });
  return `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${base64}`;
}

async function makePptxPackage(files: Record<string, string>): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file(
    'ppt/presentation.xml',
    '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
  );
  Object.entries(files).forEach(([path, xml]) => zip.file(path, xml));
  const base64 = await zip.generateAsync({ type: 'base64' });
  return `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${base64}`;
}

const TABLE_SLIDE = `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:graphicFrame>
      <p:xfrm><a:off x="1524000" y="1143000"/><a:ext cx="6096000" cy="2743200"/></p:xfrm>
      <a:graphic><a:graphicData>
        <a:tbl>
          <a:tblGrid><a:gridCol w="3048000"/><a:gridCol w="3048000"/></a:tblGrid>
          <a:tr h="685800">
            <a:tc><a:txBody><a:p><a:r><a:t>Name</a:t></a:r></a:p></a:txBody></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:t>Score</a:t></a:r></a:p></a:txBody></a:tc>
          </a:tr>
          <a:tr h="685800">
            <a:tc><a:txBody><a:p><a:r><a:t>Alice</a:t></a:r></a:p></a:txBody></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:t>42</a:t></a:r></a:p></a:txBody></a:tc>
          </a:tr>
        </a:tbl>
      </a:graphicData></a:graphic>
    </p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`;

describe('parsePptxFromBase64 — a:tbl', () => {
  it('models a graphicFrame table into a table element', async () => {
    const url = await makePptxWith(TABLE_SLIDE);
    const { slides } = await parsePptxFromBase64(url);
    const table = slides[0].elements.find((e) => e.type === 'table');
    expect(table).toBeTruthy();
    expect(table!.table).toBeTruthy();
    expect(table!.table!.rows).toBe(2);
    expect(table!.table!.cols).toBe(2);
    expect(table!.table!.cells[0]).toEqual(['Name', 'Score']);
    expect(table!.table!.cells[1]).toEqual(['Alice', '42']);
  });

  it('derives column width ratios from the grid', async () => {
    const url = await makePptxWith(TABLE_SLIDE);
    const { slides } = await parsePptxFromBase64(url);
    const table = slides[0].elements.find((e) => e.type === 'table')!;
    const widths = table.table!.colWidths!;
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeCloseTo(0.5);
    expect(widths[1]).toBeCloseTo(0.5);
  });

  it('positions the table from the frame xfrm', async () => {
    const url = await makePptxWith(TABLE_SLIDE);
    const { slides } = await parsePptxFromBase64(url);
    const table = slides[0].elements.find((e) => e.type === 'table')!;
    // off x=1524000 EMU / 12192000 total ≈ 12.5%
    expect(table.x).toBeCloseTo(12.5, 1);
    expect(table.w).toBeCloseTo(50, 1);
  });

  it('gives simple cells default (unset) span metadata', async () => {
    const url = await makePptxWith(TABLE_SLIDE);
    const { slides } = await parsePptxFromBase64(url);
    const table = slides[0].elements.find((e) => e.type === 'table')!.table!;
    expect(table.cellData).toBeTruthy();
    expect(table.cellData![0][0]).toEqual({});
    expect(table.cellData![1][1]).toEqual({});
  });
});

describe('parsePptxFromBase64 — slide layout/master inheritance', () => {
  it('uses layout/master placeholder geometry when slide shapes omit xfrm', async () => {
    const url = await makePptxPackage({
      'ppt/slides/slide1.xml': `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr/><p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>Title</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>Body</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
      'ppt/slides/_rels/slide1.xml.rels': `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
      'ppt/slideLayouts/slideLayout1.xml': `<?xml version="1.0"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="10" name="Layout Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="1219200" y="1371600"/><a:ext cx="6096000" cy="2057400"/></a:xfrm></p:spPr>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`,
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
      'ppt/slideMasters/slideMaster1.xml': `<?xml version="1.0"?>
<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr/><p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="20" name="Master Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="609600" y="342900"/><a:ext cx="10972800" cy="1028700"/></a:xfrm></p:spPr>
    </p:sp>
  </p:spTree></p:cSld>
</p:sldMaster>`,
    });

    const { slides } = await parsePptxFromBase64(url);
    expect(slides[0].bgColor).toBe('#112233');

    const title = slides[0].elements.find((e) => e.text === 'Title')!;
    const body = slides[0].elements.find((e) => e.text === 'Body')!;
    expect(title.x).toBeCloseTo(5, 1);
    expect(title.y).toBeCloseTo(5, 1);
    expect(title.w).toBeCloseTo(90, 1);
    expect(title.h).toBeCloseTo(15, 1);
    expect(body.x).toBeCloseTo(10, 1);
    expect(body.y).toBeCloseTo(20, 1);
    expect(body.w).toBeCloseTo(50, 1);
    expect(body.h).toBeCloseTo(30, 1);
  });
});

// 3-column table: row0 col0 spans 2 cols (red fill) + col2 spans 2 rows (green fill);
// row1 col0 has a blue fill. Continuation cells carry hMerge/vMerge.
const MERGED_TABLE_SLIDE = `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:graphicFrame>
      <p:xfrm><a:off x="0" y="0"/><a:ext cx="6096000" cy="2743200"/></p:xfrm>
      <a:graphic><a:graphicData>
        <a:tbl>
          <a:tblGrid><a:gridCol w="2032000"/><a:gridCol w="2032000"/><a:gridCol w="2032000"/></a:tblGrid>
          <a:tr h="685800">
            <a:tc gridSpan="2">
              <a:txBody><a:p><a:r><a:t>Merged</a:t></a:r></a:p></a:txBody>
              <a:tcPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:tcPr>
            </a:tc>
            <a:tc hMerge="1"><a:txBody><a:p/></a:txBody></a:tc>
            <a:tc rowSpan="2">
              <a:txBody><a:p><a:r><a:t>Tall</a:t></a:r></a:p></a:txBody>
              <a:tcPr><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:tcPr>
            </a:tc>
          </a:tr>
          <a:tr h="685800">
            <a:tc>
              <a:txBody><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody>
              <a:tcPr><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:tcPr>
            </a:tc>
            <a:tc><a:txBody><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody></a:tc>
            <a:tc vMerge="1"><a:txBody><a:p/></a:txBody></a:tc>
          </a:tr>
        </a:tbl>
      </a:graphicData></a:graphic>
    </p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`;

describe('parsePptxFromBase64 — merged table cells and fills', () => {
  it('models gridSpan/rowSpan and merge continuation flags', async () => {
    const url = await makePptxWith(MERGED_TABLE_SLIDE);
    const { slides } = await parsePptxFromBase64(url);
    const table = slides[0].elements.find((e) => e.type === 'table')!.table!;
    expect(table.rows).toBe(2);
    expect(table.cols).toBe(3);
    expect(table.cells[0]).toEqual(['Merged', '', 'Tall']);
    expect(table.cells[1]).toEqual(['A', 'B', '']);

    const cd = table.cellData!;
    expect(cd[0][0].colSpan).toBe(2);
    expect(cd[0][1].hMerge).toBe(true);
    expect(cd[0][2].rowSpan).toBe(2);
    expect(cd[1][2].vMerge).toBe(true);
  });

  it('resolves per-cell fill colors from a:tcPr solidFill', async () => {
    const url = await makePptxWith(MERGED_TABLE_SLIDE);
    const { slides } = await parsePptxFromBase64(url);
    const cd = slides[0].elements.find((e) => e.type === 'table')!.table!.cellData!;
    expect(cd[0][0].fillColor).toBe('#FF0000');
    expect(cd[0][2].fillColor).toBe('#00FF00');
    expect(cd[1][0].fillColor).toBe('#0000FF');
    expect(cd[1][1].fillColor).toBeUndefined();
  });
});

const THEME_XML = `<?xml version="1.0"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/>
        <a:font script="Hang" typeface="맑은 고딕"/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>
        <a:font script="Hang" typeface="맑은 고딕"/></a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>`;

describe('parsePptxFromBase64 — MS fidelity: text styling', () => {
  it('honours algn, bodyPr anchor, <a:br/>, and first-wins run sizing', async () => {
    const url = await makePptxWith(`<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr/><p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6096000" cy="1028700"/></a:xfrm></p:spPr>
      <p:txBody>
        <a:bodyPr anchor="ctr"/>
        <a:p><a:pPr algn="ctr"/>
          <a:r><a:rPr lang="en-US" sz="4000"><a:solidFill><a:srgbClr val="22D3EE"/></a:solidFill></a:rPr><a:t>Big</a:t></a:r>
          <a:br/>
          <a:r><a:rPr lang="en-US" sz="1200"/><a:t>small</a:t></a:r>
        </a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`);
    const { slides } = await parsePptxFromBase64(url);
    const el = slides[0].elements.find((e) => e.type === 'text')!;
    expect(el.text).toBe('Big\nsmall');
    expect(el.fontSize).toBe(40);       // first explicit run wins, not the last
    expect(el.fontColor).toBe('#22D3EE');
    expect(el.textAlign).toBe('center');
    expect(el.verticalAlign).toBe('middle');
  });

  it('applies normAutofit fontScale the way PowerPoint displays it', async () => {
    const url = await makePptxWith(`<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr/><p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6096000" cy="1028700"/></a:xfrm></p:spPr>
      <p:txBody>
        <a:bodyPr><a:normAutofit fontScale="62500"/></a:bodyPr>
        <a:p><a:r><a:rPr sz="4000"/><a:t>Shrunk</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`);
    const { slides } = await parsePptxFromBase64(url);
    const el = slides[0].elements.find((e) => e.type === 'text')!;
    expect(el.fontSize).toBe(25); // 40pt × 62.5%
  });

  it('keeps the fill when an unknown preset shape carries text', async () => {
    const url = await makePptxWith(`<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr/><p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Step"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="3048000" cy="1028700"/></a:xfrm>
        <a:prstGeom prst="chevron"/>
        <a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>
      </p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>Step 1</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`);
    const { slides } = await parsePptxFromBase64(url);
    const el = slides[0].elements[0];
    expect(el.type).toBe('rect');
    expect(el.fillColor).toBe('#4472C4');
    expect(el.text).toBe('Step 1');
  });

  it('approximates a gradient fill with its first stop color', async () => {
    const url = await makePptxWith(`<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr/><p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Grad"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="3048000" cy="1028700"/></a:xfrm>
        <a:prstGeom prst="rect"/>
        <a:gradFill><a:gsLst>
          <a:gs pos="0"><a:srgbClr val="0EA5E9"/></a:gs>
          <a:gs pos="100000"><a:srgbClr val="1E293B"/></a:gs>
        </a:gsLst></a:gradFill>
      </p:spPr>
      <p:txBody><a:bodyPr/><a:p/></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`);
    const { slides } = await parsePptxFromBase64(url);
    expect(slides[0].elements[0].fillColor).toBe('#0EA5E9');
  });
});

describe('parsePptxFromBase64 — MS fidelity: theme fonts + master text styles', () => {
  it('resolves theme fonts and inherits master txStyles for placeholders', async () => {
    const url = await makePptxPackage({
      'ppt/theme/theme1.xml': THEME_XML,
      'ppt/slides/slide1.xml': `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr/><p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>제목 텍스트</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Plain"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="4572000"/><a:ext cx="3048000" cy="685800"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>plain box</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
      'ppt/slides/_rels/slide1.xml.rels': `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
      'ppt/slideLayouts/slideLayout1.xml': `<?xml version="1.0"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld>
</p:sldLayout>`,
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
      'ppt/slideMasters/slideMaster1.xml': `<?xml version="1.0"?>
<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr/><p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="20" name="Master Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="609600" y="342900"/><a:ext cx="10972800" cy="1028700"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:txStyles>
    <p:titleStyle>
      <a:lvl1pPr algn="ctr"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr>
    </p:titleStyle>
    <p:bodyStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200"/></a:lvl1pPr></p:bodyStyle>
    <p:otherStyle/>
  </p:txStyles>
</p:sldMaster>`,
    });

    const { slides } = await parsePptxFromBase64(url);
    const title = slides[0].elements.find((e) => e.text === '제목 텍스트')!;
    // Inherited from master titleStyle: 44pt, centered, theme major font, tx1 color
    expect(title.fontSize).toBe(44);
    expect(title.textAlign).toBe('center');
    expect(title.fontFamily).toContain('Calibri Light');
    expect(title.fontFamily).toContain('맑은 고딕');
    expect(title.fontColor).toBe('#000000');
    // Master title placeholder bodyPr anchor="ctr" → vertically centered
    expect(title.verticalAlign).toBe('middle');

    // Non-placeholder text falls back to the theme minor font, like PowerPoint
    const plain = slides[0].elements.find((e) => e.text === 'plain box')!;
    expect(plain.fontFamily).toContain('Calibri');
    expect(plain.fontSize).toBe(18);
  });
});

describe('buildTableGrid', () => {
  const cell = (over: Partial<RawTableCell> = {}): RawTableCell => ({
    text: '', gridSpan: 1, rowSpan: 1, hMerge: false, vMerge: false, ...over,
  });

  it('pads short rows to the grid column count', () => {
    const grid = buildTableGrid([[cell({ text: 'x' })]], 3);
    expect(grid.cols).toBe(3);
    expect(grid.cells[0]).toEqual(['x', '', '']);
    expect(grid.cellData[0]).toEqual([{}, {}, {}]);
  });

  it('grows the column count when a row is wider than the grid', () => {
    const grid = buildTableGrid([[cell(), cell(), cell()]], 2);
    expect(grid.cols).toBe(3);
  });

  it('translates spans and merge flags into cell metadata', () => {
    const grid = buildTableGrid([
      [cell({ text: 'M', gridSpan: 2, fillColor: '#ff0000' }), cell({ hMerge: true })],
    ], 2);
    expect(grid.cellData[0][0]).toEqual({ colSpan: 2, fillColor: '#ff0000' });
    expect(grid.cellData[0][1]).toEqual({ hMerge: true });
  });

  it('leaves span metadata empty for plain cells', () => {
    const grid = buildTableGrid([[cell({ text: 'a' }), cell({ text: 'b' })]], 2);
    expect(grid.cellData[0][0]).toEqual({});
    expect(grid.cellData[0][1]).toEqual({});
  });
});
