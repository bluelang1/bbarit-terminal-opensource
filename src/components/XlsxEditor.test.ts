import { describe, expect, it } from 'vitest';
import {
  adjustFormulaReferences,
  adjustFormulaAxisEdit,
  remapSheetMetaAxis,
  buildFormulaFromHelper,
  cellRef,
  colorScaleColor,
  computeConditionalFormatMap,
  FORMULA_FUNCTION_NAMES,
  nextAutoFillValue,
  type ConditionalRule,
  colToLetter,
  computeVisibleRowRange,
  expandRowRangeForMerges,
  computeColRenderPlan,
  gridColSpanForMerge,
  computeRowLayout,
  computeColLayout,
  rangeForScroll,
  computeBorderEdges,
  hasAnyBorder,
  freezeToPane,
  paneToFreeze,
  evaluateFormula,
  expandRange,
  formatDisplayValue,
  analyzeSpreadsheetRange,
  applySpreadsheetHeatmap,
  buildSpreadsheetCorrelationSheet,
  buildSpreadsheetCleanRoomSheet,
  buildSpreadsheetDataDoctorSheet,
  buildSpreadsheetDashboardSheet,
  buildSpreadsheetAnomalyMonitorSheet,
  buildSpreadsheetExecutiveBriefSheet,
  buildSpreadsheetExecutiveWorkbookSheets,
  buildSpreadsheetFormulaAuditSheet,
  buildSpreadsheetForecastSheet,
  buildSpreadsheetInsightSheet,
  buildSpreadsheetKpiStudioSheet,
  buildSpreadsheetPivotSheet,
  buildSpreadsheetScenarioSheet,
  buildSpreadsheetSensitivitySheet,
  buildSpreadsheetSolverSheet,
  buildSpreadsheetSummarySheet,
  buildSpreadsheetVarianceControlSheet,
  buildSpreadsheetWaterfallBridgeSheet,
  calculateSpreadsheetCorrelations,
  generateSpreadsheetInsights,
  jumpToDataEdge,
  nextSpreadsheetCellRef,
  parseCellRef,
  parseClipboardTable,
  profileSpreadsheetRange,
  type CellData,
  type SheetData,
  XLSX_FORMULA_LIBRARY,
} from './XlsxEditor';

describe('XlsxEditor spreadsheet utilities', () => {
  it('converts cell references and ranges', () => {
    expect(colToLetter(0)).toBe('A');
    expect(colToLetter(27)).toBe('AB');
    expect(cellRef(2, 4)).toBe('C5');
    expect(parseCellRef('C5')).toEqual({ col: 2, row: 4 });
    expect(expandRange('A1:B2')).toEqual(['A1', 'B1', 'A2', 'B2']);
    expect(nextSpreadsheetCellRef('A1', { maxCol: 1, maxRow: 1 }, 1, 0)).toBe('B1');
    expect(nextSpreadsheetCellRef('A1', { maxCol: 0, maxRow: 0 }, 1, 0, true)).toBe('B1');
    expect(nextSpreadsheetCellRef('A1', { maxCol: 0, maxRow: 0 }, -1, 0, true)).toBe('A1');
    expect(nextSpreadsheetCellRef('A1', { maxCol: 0, maxRow: 0 }, 0, 1, true)).toBe('A2');
  });

  it('jumps to the edge of a data block like Excel Ctrl+Arrow', () => {
    const sheet: SheetData = {
      name: 'Nav',
      cells: {
        A1: { value: '1' },
        A2: { value: '2' },
        A3: { value: '3' },
        // A4 blank
        A5: { value: '5' },
      },
      colWidths: {},
      rowHeights: {},
      maxCol: 3,
      maxRow: 9,
    };

    // On data with a filled neighbor: stop at the last contiguous filled cell.
    expect(jumpToDataEdge(sheet, 0, 0, 0, 1)).toEqual({ col: 0, row: 2 });
    // On data with a blank neighbor: skip the gap to the next filled cell.
    expect(jumpToDataEdge(sheet, 0, 2, 0, 1)).toEqual({ col: 0, row: 4 });
    // On a blank cell: jump to the next filled cell.
    expect(jumpToDataEdge(sheet, 0, 3, 0, 1)).toEqual({ col: 0, row: 4 });
    // No data ahead: land on the sheet edge.
    expect(jumpToDataEdge(sheet, 0, 4, 0, 1)).toEqual({ col: 0, row: 9 });
    // Already at the boundary: stay put.
    expect(jumpToDataEdge(sheet, 0, 0, 0, -1)).toEqual({ col: 0, row: 0 });
  });

  it('evaluates common spreadsheet formulas', () => {
    const cells: Record<string, CellData> = {
      A1: { value: '10' },
      A2: { value: '20' },
      A3: { value: '30' },
      B1: { value: 'alpha' },
      B2: { value: 'bravo' },
      C1: { value: '100' },
      C2: { value: '200' },
    };

    expect(evaluateFormula('=SUM(A1:A3)', cells)).toBe('60');
    expect(evaluateFormula('=AVERAGE(A1:A3)', cells)).toBe('20');
    expect(evaluateFormula('=IF(A1>5,"yes","no")', cells)).toBe('yes');
    expect(evaluateFormula('=VLOOKUP("bravo",B1:C3,2)', cells)).toBe('200');
    expect(evaluateFormula('=A1+A2*2', cells)).toBe('50');
  });

  it('evaluates modern lookup and criteria formulas', () => {
    const cells: Record<string, CellData> = {
      A1: { value: 'Region' },
      B1: { value: 'Revenue' },
      C1: { value: 'Owner' },
      A2: { value: 'West' },
      B2: { value: '100' },
      C2: { value: 'Ari' },
      A3: { value: 'East' },
      B3: { value: '160' },
      C3: { value: 'Bo' },
      A4: { value: 'West' },
      B4: { value: '140' },
      C4: { value: 'Cam' },
    };

    expect(evaluateFormula('=SUMIF(A2:A4,"West",B2:B4)', cells)).toBe('240');
    expect(evaluateFormula('=COUNTIF(B2:B4,">=140")', cells)).toBe('2');
    expect(evaluateFormula('=COUNTIF(A2:A4,"W*")', cells)).toBe('2');
    expect(evaluateFormula('=XLOOKUP("East",A2:A4,C2:C4,"missing")', cells)).toBe('Bo');
    expect(evaluateFormula('=XLOOKUP("North",A2:A4,C2:C4,"missing")', cells)).toBe('missing');
    expect(evaluateFormula('=INDEX(B2:C4,2,2)', cells)).toBe('Bo');
    expect(evaluateFormula('=MATCH("Cam",C2:C4,0)', cells)).toBe('3');
    expect(evaluateFormula('=ABS(-12.5)', cells)).toBe('12.5');
  });

  it('evaluates nested functions, operators, and absolute references', () => {
    const cells: Record<string, CellData> = {
      A1: { value: '10' },
      A2: { value: '20' },
      A3: { value: '30' },
      B1: { value: 'north' },
      B2: { value: 'SOUTH' },
      C1: { value: '2026-03-15' },
    };

    // Nested calls + operator precedence + parentheses
    expect(evaluateFormula('=SUM(A1:A3)*2', cells)).toBe('120');
    expect(evaluateFormula('=ROUND(AVERAGE(A1:A3)/7,2)', cells)).toBe('2.86');
    expect(evaluateFormula('=IF(SUM(A1:A2)>25,MAX(A1:A3),MIN(A1:A3))', cells)).toBe('30');
    expect(evaluateFormula('=(A1+A2)*A3', cells)).toBe('900');
    expect(evaluateFormula('=2^3^2', cells)).toBe('64'); // left-assoc like Excel
    expect(evaluateFormula('=50%', cells)).toBe('0.5');
    expect(evaluateFormula('=-A1+5', cells)).toBe('-5');

    // Text concatenation and comparisons
    expect(evaluateFormula('="Total: "&SUM(A1:A2)', cells)).toBe('Total: 30');
    expect(evaluateFormula('=UPPER(B1)&"-"&LOWER(B2)', cells)).toBe('NORTH-south');
    expect(evaluateFormula('=A1<>A2', cells)).toBe('TRUE');
    expect(evaluateFormula('=IF(AND(A1>5,A2<25),"in","out")', cells)).toBe('in');

    // Absolute references evaluate like relative ones
    expect(evaluateFormula('=SUM($A$1:$A$3)', cells)).toBe('60');
    expect(evaluateFormula('=$A$2*2', cells)).toBe('40');

    // Column ranges
    expect(evaluateFormula('=SUM(A:A)', cells)).toBe('60');
  });

  it('evaluates the expanded function library', () => {
    const cells: Record<string, CellData> = {
      A1: { value: '4' },
      A2: { value: '9' },
      A3: { value: '16' },
      B1: { value: 'apple pie' },
      C1: { value: '2026-03-15' },
      C2: { value: '2026-05-20' },
      D1: { value: 'x' },
      D2: { value: 'y' },
      E1: { value: '2' },
      E2: { value: '3' },
    };

    expect(evaluateFormula('=MEDIAN(A1:A3)', cells)).toBe('9');
    expect(evaluateFormula('=PRODUCT(A1:A2)', cells)).toBe('36');
    expect(evaluateFormula('=SQRT(A3)', cells)).toBe('4');
    expect(evaluateFormula('=POWER(2,10)', cells)).toBe('1024');
    expect(evaluateFormula('=MOD(-3,5)', cells)).toBe('2'); // Excel-style sign
    expect(evaluateFormula('=ROUNDUP(1.21,1)', cells)).toBe('1.3');
    expect(evaluateFormula('=ROUNDDOWN(1.29,1)', cells)).toBe('1.2');
    expect(evaluateFormula('=CEILING(7,3)', cells)).toBe('9');
    expect(evaluateFormula('=LARGE(A1:A3,2)', cells)).toBe('9');
    expect(evaluateFormula('=SUMPRODUCT(D1:E1,D2:E2)', cells)).toBe('6'); // text cells count as 0
    expect(evaluateFormula('=SUMPRODUCT(E1:E2,E1:E2)', cells)).toBe('13');

    expect(evaluateFormula('=IFS(A1>100,"big",A1>1,"small")', cells)).toBe('small');
    expect(evaluateFormula('=SWITCH(D1,"x","ex","why")', cells)).toBe('ex');
    expect(evaluateFormula('=IFERROR(1/0,"fallback")', cells)).toBe('fallback');
    expect(evaluateFormula('=ISNUMBER(A1)', cells)).toBe('TRUE');
    expect(evaluateFormula('=ISTEXT(B1)', cells)).toBe('TRUE');
    expect(evaluateFormula('=ISBLANK(Z99)', cells)).toBe('TRUE');
    expect(evaluateFormula('=NOT(FALSE)', cells)).toBe('TRUE');
    expect(evaluateFormula('=XOR(TRUE,TRUE,TRUE)', cells)).toBe('TRUE');

    expect(evaluateFormula('=PROPER(B1)', cells)).toBe('Apple Pie');
    expect(evaluateFormula('=SUBSTITUTE(B1,"pie","tart")', cells)).toBe('apple tart');
    expect(evaluateFormula('=REPLACE(B1,1,5,"cherry")', cells)).toBe('cherry pie');
    expect(evaluateFormula('=FIND("pie",B1)', cells)).toBe('7');
    expect(evaluateFormula('=SEARCH("PIE",B1)', cells)).toBe('7');
    expect(evaluateFormula('=REPT("ab",3)', cells)).toBe('ababab');
    expect(evaluateFormula('=TEXTJOIN(", ",TRUE,D1:E2)', cells)).toBe('x, 2, y, 3'); // row-major like Excel
    expect(evaluateFormula('=CONCAT(D1,D2,E1)', cells)).toBe('xy2');
    expect(evaluateFormula('=TEXT(1234.567,"#,##0.00")', cells)).toBe('1,234.57');
    expect(evaluateFormula('=TEXT(0.125,"0.0%")', cells)).toBe('12.5%');

    expect(evaluateFormula('=YEAR(C1)', cells)).toBe('2026');
    expect(evaluateFormula('=MONTH(C1)', cells)).toBe('3');
    expect(evaluateFormula('=DAY(C1)', cells)).toBe('15');
    expect(evaluateFormula('=DATE(2026,3,15)', cells)).toBe('2026-03-15');
    expect(evaluateFormula('=EDATE(C1,2)', cells)).toBe('2026-05-15');
    expect(evaluateFormula('=EOMONTH(C1,0)', cells)).toBe('2026-03-31');
    expect(evaluateFormula('=DAYS(C2,C1)', cells)).toBe('66');
    expect(evaluateFormula('=DATEDIF(C1,C2,"M")', cells)).toBe('2');

    expect(evaluateFormula('=CHOOSE(2,"a","b","c")', cells)).toBe('b');
    expect(evaluateFormula('=ROW(A3)', cells)).toBe('3');
    expect(evaluateFormula('=COLUMN(E1)', cells)).toBe('5');
    expect(evaluateFormula('=ROWS(A1:A3)', cells)).toBe('3');
    expect(evaluateFormula('=COLUMNS(D1:E1)', cells)).toBe('2');
  });

  it('evaluates multi-criteria aggregation functions', () => {
    const cells: Record<string, CellData> = {
      A1: { value: 'West' }, B1: { value: 'Q1' }, C1: { value: '100' },
      A2: { value: 'West' }, B2: { value: 'Q2' }, C2: { value: '150' },
      A3: { value: 'East' }, B3: { value: 'Q1' }, C3: { value: '200' },
      A4: { value: 'East' }, B4: { value: 'Q2' }, C4: { value: '250' },
    };

    expect(evaluateFormula('=SUMIFS(C1:C4,A1:A4,"West")', cells)).toBe('250');
    expect(evaluateFormula('=SUMIFS(C1:C4,A1:A4,"East",B1:B4,"Q2")', cells)).toBe('250');
    expect(evaluateFormula('=COUNTIFS(A1:A4,"West",B1:B4,"Q1")', cells)).toBe('1');
    expect(evaluateFormula('=AVERAGEIF(A1:A4,"East",C1:C4)', cells)).toBe('225');
    expect(evaluateFormula('=AVERAGEIFS(C1:C4,B1:B4,"Q1")', cells)).toBe('150');
    expect(evaluateFormula('=MAXIFS(C1:C4,A1:A4,"West")', cells)).toBe('150');
    expect(evaluateFormula('=MINIFS(C1:C4,B1:B4,"Q2")', cells)).toBe('150');
    expect(evaluateFormula('=HLOOKUP("Q1",B1:C4,3,FALSE)', cells)).toBe('Q1'); // column under the Q1 header, row 3
    expect(evaluateFormula('=HLOOKUP("zzz",B1:C4,2,FALSE)', cells)).toBe('#N/A');
  });

  it('propagates Excel-style errors', () => {
    const cells: Record<string, CellData> = {
      A1: { value: '10' },
      A2: { value: '0' },
      B1: { value: '', formula: '=A1/A2' },
      B2: { value: '', formula: '=B1+1' },
      C1: { value: '', formula: '=C2' },
      C2: { value: '', formula: '=C1' },
    };

    expect(evaluateFormula('=A1/A2', cells)).toBe('#DIV/0!');
    expect(evaluateFormula('=B2', cells)).toBe('#DIV/0!'); // errors flow through chains
    expect(evaluateFormula('=NOSUCHFN(1)', cells)).toBe('#NAME?');
    expect(evaluateFormula('=VLOOKUP("zzz",A1:B2,2)', cells)).toBe('#N/A');
    expect(evaluateFormula('=SQRT(-1)', cells)).toBe('#NUM!');
    expect(evaluateFormula('=C1', cells)).toBe('#REF!'); // circular reference
    expect(evaluateFormula('=IFERROR(C1,"cycle")', cells)).toBe('cycle');
  });

  it('shifts relative references on copy/fill like Excel', () => {
    expect(adjustFormulaReferences('=A1+B1', 0, 1)).toBe('=A2+B2');
    expect(adjustFormulaReferences('=SUM(A1:A5)', 1, 0)).toBe('=SUM(B1:B5)');
    expect(adjustFormulaReferences('=$A$1+B2', 2, 3)).toBe('=$A$1+D5');
    expect(adjustFormulaReferences('=$A1+A$2', 1, 1)).toBe('=$A2+B$2'); // mixed anchors
    expect(adjustFormulaReferences('=LOG10(A1)', 0, 1)).toBe('=LOG10(A2)'); // function names untouched
    expect(adjustFormulaReferences('="A1 is "&A1', 0, 1)).toBe('="A1 is "&A2'); // strings untouched
    expect(adjustFormulaReferences('=A1', 0, -1)).toBe('=#REF!'); // pushed off the sheet
    expect(adjustFormulaReferences('=A1+A2', 0, 0)).toBe('=A1+A2');
  });

  it('continues fill series for numbers, suffixed labels, and dates', () => {
    expect(nextAutoFillValue('7', 2)).toBe('9');
    expect(nextAutoFillValue('Item 3', 1)).toBe('Item 4');
    expect(nextAutoFillValue('Q01', 2)).toBe('Q03'); // zero padding kept
    expect(nextAutoFillValue('2026-01-31', 1)).toBe('2026-02-01');
    expect(nextAutoFillValue('hello', 4)).toBe('hello');
  });

  it('evaluates conditional formatting rules like Excel', () => {
    const cells: Record<string, CellData> = {
      A1: { value: '10' }, A2: { value: '50' }, A3: { value: '90' },
      B1: { value: 'apple' }, B2: { value: 'banana' }, B3: { value: 'apple' },
      C1: { value: '5' }, C2: { value: '', formula: '=C1*2' },
    };
    const rule = (partial: Omit<ConditionalRule, 'id'>): ConditionalRule => ({ id: 'r', ...partial });

    // Highlight: greater than
    const gt = computeConditionalFormatMap({ cells, conditionalRules: [rule({ range: 'A1:A3', type: 'gt', value1: '40' })] });
    expect(gt.has('A1')).toBe(false);
    expect(gt.get('A2')?.bg).toBeTruthy();
    expect(gt.get('A3')?.bg).toBeTruthy();

    // Between uses an inclusive numeric window
    const between = computeConditionalFormatMap({ cells, conditionalRules: [rule({ range: 'A1:A3', type: 'between', value1: '10', value2: '50' })] });
    expect(between.has('A1')).toBe(true);
    expect(between.has('A2')).toBe(true);
    expect(between.has('A3')).toBe(false);

    // Duplicates flag both copies, text contains matches case-insensitively
    const dup = computeConditionalFormatMap({ cells, conditionalRules: [rule({ range: 'B1:B3', type: 'duplicate' })] });
    expect(dup.has('B1')).toBe(true);
    expect(dup.has('B2')).toBe(false);
    expect(dup.has('B3')).toBe(true);
    const contains = computeConditionalFormatMap({ cells, conditionalRules: [rule({ range: 'B1:B3', type: 'contains', value1: 'APP' })] });
    expect(contains.has('B1')).toBe(true);
    expect(contains.has('B2')).toBe(false);

    // Formula cells are evaluated before matching (C2 = 10)
    const viaFormula = computeConditionalFormatMap({ cells, conditionalRules: [rule({ range: 'C1:C2', type: 'gt', value1: '7' })] });
    expect(viaFormula.has('C1')).toBe(false);
    expect(viaFormula.has('C2')).toBe(true);

    // Color scale: min red → max green; data bars scale 0..1
    const scale = computeConditionalFormatMap({ cells, conditionalRules: [rule({ range: 'A1:A3', type: 'colorScale' })] });
    expect(scale.get('A1')?.bg).toBe(colorScaleColor(0));
    expect(scale.get('A3')?.bg).toBe(colorScaleColor(1));
    const bars = computeConditionalFormatMap({ cells, conditionalRules: [rule({ range: 'A1:A3', type: 'dataBar' })] });
    expect(bars.get('A3')?.barFraction).toBe(1);
    expect(bars.get('A1')?.barFraction).toBeCloseTo(10 / 90);

    // First rule wins a contested field (Excel priority order)
    const stacked = computeConditionalFormatMap({
      cells,
      conditionalRules: [
        rule({ range: 'A1:A3', type: 'colorScale' }),
        rule({ range: 'A1:A3', type: 'gt', value1: '0' }),
      ],
    });
    expect(stacked.get('A2')?.bg).toBe(colorScaleColor(0.5));
  });

  it('survives adversarial formula edge cases', () => {
    const cells: Record<string, CellData> = {
      A1: { value: '10' }, A2: { value: '20' }, A3: { value: '30' },
      B1: { value: '10%' }, B2: { value: '-5' },
      C1: { value: '', formula: '=A1*2' },
      D1: { value: '20' },
    };

    // Whitespace and case insensitivity
    expect(evaluateFormula('= sum ( a1 : a3 )', cells)).toBe('60');
    expect(evaluateFormula('=SuM(A1:a3)', cells)).toBe('60');

    // Excel operator quirks: unary minus binds tighter than ^
    expect(evaluateFormula('=-2^2', cells)).toBe('4');
    expect(evaluateFormula('=2^-2', cells)).toBe('0.25');
    expect(evaluateFormula('=(1+2)*3^2', cells)).toBe('27');

    // String literals with parens, commas, escaped quotes
    expect(evaluateFormula('=LEN("a(b,c)d")', cells)).toBe('7');
    expect(evaluateFormula('=LEN("say ""hi""")', cells)).toBe('8');
    expect(evaluateFormula('="A"&"B"="ab"', cells)).toBe('TRUE'); // & binds tighter than =

    // Percent cells and literals in arithmetic
    expect(evaluateFormula('=B1*2', cells)).toBe('0.2');
    expect(evaluateFormula('="x"&5%', cells)).toBe('x0.05');

    // Mixed args, lazy IF, negatives in ranges
    expect(evaluateFormula('=SUM(A1:A3,B2,5)', cells)).toBe('60');
    expect(evaluateFormula('=IF(TRUE,1,1/0)', cells)).toBe('1'); // untaken branch must not evaluate
    expect(evaluateFormula('=MIN(A1:A3,B2)', cells)).toBe('-5');

    // Formula cells feeding other formulas, numeric lookup keys
    expect(evaluateFormula('=SUM(C1:C1)+1', cells)).toBe('21');
    expect(evaluateFormula('=VLOOKUP(20,A2:D2,2,FALSE)', cells)).toBe('-5'); // numeric key matches text cell "20"

    // Nested text/date functions
    expect(evaluateFormula('=UPPER(IF(A1>5,"y","n"))', cells)).toBe('Y');
    expect(evaluateFormula('=MID("hello",2,100)', cells)).toBe('ello');
    expect(evaluateFormula('=DATEDIF("2026-01-31","2026-03-01","M")', cells)).toBe('1');
    expect(evaluateFormula('=ROUND(2.675,2)', cells)).toBe('2.68'); // no float-noise 2.67

    // Malformed input degrades to an error, never a crash
    expect(evaluateFormula('=A1+', cells)).toBe('#VALUE!');
    expect(evaluateFormula('=SUM(A1:A3', cells)).toBe('#VALUE!');
    expect(evaluateFormula('=)(', cells)).toBe('#VALUE!');
    expect(evaluateFormula('="unclosed', cells)).toBe('#VALUE!');
    expect(evaluateFormula('=A1 A2', cells)).toBe('#VALUE!');
  });

  it('suggests worksheet functions for autocomplete prefixes', () => {
    expect(FORMULA_FUNCTION_NAMES).toContain('SUMIFS');
    expect(FORMULA_FUNCTION_NAMES.filter((n) => n.startsWith('SUM'))).toEqual([
      'SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT',
    ]);
  });

  it('builds formula helper examples with selected references', () => {
    const sum = XLSX_FORMULA_LIBRARY.find((helper) => helper.name === 'SUM');
    const lookup = XLSX_FORMULA_LIBRARY.find((helper) => helper.name === 'XLOOKUP');
    expect(sum).toBeTruthy();
    expect(lookup).toBeTruthy();
    expect(buildFormulaFromHelper(sum!, 'B2:B5', 'C2')).toBe('=SUM(B2:B5)');
    expect(buildFormulaFromHelper(lookup!, 'A2:A5', 'C2')).toBe('=XLOOKUP(C2,A2:A5,A2:A5,"not found")');
  });

  it('parses TSV and quoted CSV clipboard payloads', () => {
    expect(parseClipboardTable('Name\tValue\nAlpha\t10')).toEqual([
      ['Name', 'Value'],
      ['Alpha', '10'],
    ]);

    expect(parseClipboardTable('"Name","Note"\n"Alpha","line, with comma"\n"Beta","quote ""ok"""')).toEqual([
      ['Name', 'Note'],
      ['Alpha', 'line, with comma'],
      ['Beta', 'quote "ok"'],
    ]);
  });

  it('formats numeric display values', () => {
    expect(formatDisplayValue('1234.5', 'integer')).toBe('1,235');
    expect(formatDisplayValue('0.125', 'percent')).toBe('12.5%');
    expect(formatDisplayValue('abc', 'number')).toBe('abc');
  });

  it('builds numeric summaries for workbook ranges', () => {
    const sheet: SheetData = {
      name: 'Revenue',
      cells: {
        A1: { value: 'Month' },
        B1: { value: 'Sales' },
        C1: { value: 'Margin' },
        A2: { value: 'Jan' },
        B2: { value: '100' },
        C2: { value: '25' },
        A3: { value: 'Feb' },
        B3: { value: '150' },
        C3: { value: '45' },
      },
      colWidths: {},
      rowHeights: {},
      maxCol: 2,
      maxRow: 2,
    };

    const summaries = analyzeSpreadsheetRange(sheet, ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3']);
    expect(summaries.map((item) => item.label)).toEqual(['Sales', 'Margin']);
    expect(summaries[0]).toMatchObject({ count: 2, sum: 250, avg: 125, min: 100, max: 150 });

    const summarySheet = buildSpreadsheetSummarySheet(sheet);
    expect(summarySheet.name).toBe('Revenue Summary');
    expect(summarySheet.cells.A1.value).toBe('Field');
    expect(summarySheet.cells.A2.value).toBe('Sales');
    expect(summarySheet.cells.C2.value).toBe('250');
    expect(summarySheet.frozenRows).toBe(1);

    const dashboardSheet = buildSpreadsheetDashboardSheet(sheet);
    expect(dashboardSheet.name).toBe('Revenue Dashboard');
    expect(dashboardSheet.cells.A1.value).toBe('Revenue Dashboard');
    expect(dashboardSheet.cells.D4.value).toMatch(/^#+$/);
    expect(dashboardSheet.cells.F4.value).toBe('Sales');

    const heatmapSheet = applySpreadsheetHeatmap(sheet, ['B2', 'B3']);
    expect(heatmapSheet.cells.B2.format?.bgColor).toBe('#fee2e2');
    expect(heatmapSheet.cells.B3.format?.bgColor).toBe('#dcfce7');
    expect(heatmapSheet.cells.B3.format?.bold).toBe(true);
  });

  it('builds trend forecast sheets from a dimension and numeric metric', () => {
    const sheet: SheetData = {
      name: 'Bookings',
      cells: {
        A1: { value: 'Month' },
        B1: { value: 'ARR' },
        C1: { value: 'Deals' },
        A2: { value: 'Jan' },
        B2: { value: '100' },
        C2: { value: '5' },
        A3: { value: 'Feb' },
        B3: { value: '130' },
        C3: { value: '6' },
        A4: { value: 'Mar' },
        B4: { value: '160' },
        C4: { value: '7' },
        A5: { value: 'Apr' },
        B5: { value: '220' },
        C5: { value: '8' },
        A6: { value: 'May' },
        B6: { value: '' },
      },
      colWidths: {},
      rowHeights: {},
      maxCol: 2,
      maxRow: 5,
    };

    const forecast = buildSpreadsheetForecastSheet(sheet);

    expect(forecast.name).toBe('Bookings Forecast');
    expect(forecast.cells.A1.value).toBe('Bookings Forecast');
    expect(forecast.cells.A4.value).toBe('Month');
    expect(forecast.cells.B4.value).toBe('ARR');
    expect(forecast.cells.A9.value).toBe('Forecast +1');
    expect(forecast.cells.F9.value).toBe('260');
    expect(forecast.cells.A10.value).toBe('Forecast +2');
    expect(forecast.cells.A17.value).toBe('Recommendation');
    expect(forecast.frozenRows).toBe(4);
  });

  it('profiles data, generates insights, and builds pivot sheets', () => {
    const sheet: SheetData = {
      name: 'Pipeline',
      cells: {
        A1: { value: 'Region' },
        B1: { value: 'Revenue' },
        C1: { value: 'Owner' },
        A2: { value: 'West' },
        B2: { value: '100' },
        C2: { value: 'Ari' },
        A3: { value: 'West' },
        B3: { value: '150' },
        C3: { value: 'Ari' },
        A4: { value: 'East' },
        B4: { value: '90' },
        C4: { value: '' },
      },
      colWidths: {},
      rowHeights: {},
      maxCol: 2,
      maxRow: 3,
    };

    const profiles = profileSpreadsheetRange(sheet);
    expect(profiles.find((profile) => profile.label === 'Region')).toMatchObject({ type: 'category', uniqueCount: 2, topValue: 'West' });
    expect(profiles.find((profile) => profile.label === 'Revenue')).toMatchObject({ type: 'numeric', sum: 340, avg: 113.33 });

    const insights = generateSpreadsheetInsights(sheet);
    expect(insights.some((insight) => insight.title === 'Largest metric')).toBe(true);
    expect(insights.some((insight) => insight.title === 'Data quality warning')).toBe(true);

    const insightSheet = buildSpreadsheetInsightSheet(sheet);
    expect(insightSheet.name).toBe('Pipeline Insights');
    expect(insightSheet.cells.A1.value).toBe('Pipeline Insights');
    expect(insightSheet.cells.A8.value).toBe('Field');

    const pivotSheet = buildSpreadsheetPivotSheet(sheet);
    expect(pivotSheet.name).toBe('Pipeline Pivot');
    expect(pivotSheet.cells.A3.value).toBe('Region');
    expect(pivotSheet.cells.A4.value).toBe('West');
    expect(pivotSheet.cells.B4.value).toBe('250');
    expect(pivotSheet.frozenCols).toBe(1);
  });

  it('builds correlation sheets for numeric driver analysis', () => {
    const sheet: SheetData = {
      name: 'Metrics',
      cells: {
        A1: { value: 'Month' },
        B1: { value: 'Revenue' },
        C1: { value: 'Cost' },
        D1: { value: 'Quality' },
        A2: { value: 'Jan' },
        B2: { value: '10' },
        C2: { value: '5' },
        D2: { value: '40' },
        A3: { value: 'Feb' },
        B3: { value: '20' },
        C3: { value: '10' },
        D3: { value: '30' },
        A4: { value: 'Mar' },
        B4: { value: '30' },
        C4: { value: '15' },
        D4: { value: '20' },
        A5: { value: 'Apr' },
        B5: { value: '40' },
        C5: { value: '20' },
        D5: { value: '10' },
      },
      colWidths: {},
      rowHeights: {},
      maxCol: 3,
      maxRow: 4,
    };

    const pairs = calculateSpreadsheetCorrelations(sheet);
    const correlation = buildSpreadsheetCorrelationSheet(sheet);

    expect(pairs[0]).toMatchObject({
      leftLabel: 'Revenue',
      rightLabel: 'Cost',
      correlation: 1,
      strength: 'very strong',
      direction: 'positive',
      sampleSize: 4,
    });
    expect(pairs.some((pair) => pair.leftLabel === 'Revenue' && pair.rightLabel === 'Quality' && pair.correlation === -1)).toBe(true);
    expect(correlation.name).toBe('Metrics Correlation');
    expect(correlation.cells.A1.value).toBe('Metrics Correlation Lab');
    expect(correlation.cells.A5.value).toBe('very strong positive');
    expect(correlation.cells.B5.value).toContain('Revenue and Cost correlate');
    expect(correlation.cells.A9.value).toBe('Correlation Matrix');
    expect(correlation.cells.B11.value).toBe('1');
    expect(correlation.cells.D11.value).toBe('-1');
    expect(correlation.cells.A16.value).toBe('Top Relationships');
    expect(correlation.frozenCols).toBe(1);
  });

  it('builds an executive workbook pack from a selected range', () => {
    const sheet: SheetData = {
      name: 'Ops',
      cells: {
        A1: { value: 'Region' },
        B1: { value: 'Revenue' },
        C1: { value: 'Margin' },
        A2: { value: 'West' },
        B2: { value: '100' },
        C2: { value: '20' },
        A3: { value: 'East' },
        B3: { value: '160' },
        C3: { value: '40' },
        A4: { value: 'West' },
        B4: { value: '140' },
        C4: { value: '' },
        A5: { value: 'Total' },
        B5: { value: '400' },
        C5: { value: '60' },
      },
      colWidths: {},
      rowHeights: {},
      maxCol: 2,
      maxRow: 4,
    };

    const brief = buildSpreadsheetExecutiveBriefSheet(sheet, ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3', 'A4', 'B4', 'C4']);
    const cleanRoom = buildSpreadsheetCleanRoomSheet(sheet);
    const kpi = buildSpreadsheetKpiStudioSheet(sheet);
    const dataDoctor = buildSpreadsheetDataDoctorSheet(sheet);
    const formulaAudit = buildSpreadsheetFormulaAuditSheet(sheet);
    const scenario = buildSpreadsheetScenarioSheet(sheet);
    const sensitivity = buildSpreadsheetSensitivitySheet(sheet);
    const variance = buildSpreadsheetVarianceControlSheet(sheet);
    const solver = buildSpreadsheetSolverSheet(sheet);
    const correlation = buildSpreadsheetCorrelationSheet(sheet);
    const waterfall = buildSpreadsheetWaterfallBridgeSheet(sheet);
    const anomaly = buildSpreadsheetAnomalyMonitorSheet(sheet);
    const pack = buildSpreadsheetExecutiveWorkbookSheets(sheet);

    expect(brief.name).toBe('Ops Executive Brief');
    expect(brief.cells.A1.value).toBe('Ops Executive Brief');
    expect(brief.cells.B5.value).toBe('A1:C4');
    expect(brief.cells.A13.value).toBe('Top Metrics');
    expect(brief.cells.A22.value).toBe('Key Insights');
    expect(brief.cells.A23.value).toBe('Insight');
    expect(Number(brief.cells.B10.value)).toBeLessThan(100);
    expect(cleanRoom.name).toBe('Ops Clean Room');
    expect(cleanRoom.cells.A1.value).toBe('Source Row');
    expect(cleanRoom.cells.B1.value).toBe('QA Status');
    expect(cleanRoom.frozenCols).toBe(2);
    expect(kpi.name).toBe('Ops KPI Studio');
    expect(kpi.cells.A1.value).toBe('Ops KPI Studio');
    expect(kpi.cells.A4.value).toBe('Command Center');
    expect(kpi.cells.A6.value).toBe('Revenue');
    expect(kpi.cells.B6.value).toBe('140');
    expect(kpi.cells.C6.value).toBe('160');
    expect(kpi.cells.D6.value).toBe('-20');
    expect(kpi.cells.A10.value).toBe('Segment Leaderboard');
    expect(kpi.cells.A12.value).toBe('West');
    expect(kpi.cells.G12.value).toContain('Double down');
    expect(dataDoctor.name).toBe('Ops Data Doctor');
    expect(dataDoctor.cells.A1.value).toBe('Ops Data Doctor');
    expect(dataDoctor.cells.E5.value).toBe('A1:C5');
    expect(formulaAudit.name).toBe('Ops Formula Audit');
    expect(formulaAudit.cells.A9.value).toBe('No formulas found in the selected range.');
    expect(scenario.name).toBe('Ops Scenario');
    expect(scenario.cells.A1.value).toBe('Ops Scenario Model');
    expect(scenario.cells.B6.value).toBe('Revenue');
    expect(scenario.cells.B7.value).toBe('400');
    expect(scenario.cells.D5.value).toBe('3 detail rows modeled');
    expect(scenario.cells.A12.value).toBe('Downside');
    expect(scenario.cells.E12.formula).toBe('=B12*(1+C12)*D12');
    expect(evaluateFormula(scenario.cells.E12.formula || '', scenario.cells)).toBe('316.8');
    expect(sensitivity.name).toBe('Ops Sensitivity');
    expect(sensitivity.cells.A1.value).toBe('Ops Sensitivity Lab');
    expect(sensitivity.cells.B6.value).toBe('Revenue');
    expect(sensitivity.cells.B7.value).toBe('400');
    expect(sensitivity.cells.B8.value).toBe('460');
    expect(evaluateFormula(sensitivity.cells.B9.formula || '', sensitivity.cells)).toBe('0.15');
    expect(sensitivity.cells.A16.value).toBe('-0.2');
    expect(evaluateFormula(sensitivity.cells.B20.formula || '', sensitivity.cells)).toBe('460');
    expect(sensitivity.cells.F16.value).toBe('West');
    expect(evaluateFormula(sensitivity.cells.I16.formula || '', sensitivity.cells)).toBe('264');
    expect(variance.name).toBe('Ops Variance');
    expect(variance.cells.A1.value).toBe('Ops Variance Control');
    expect(variance.cells.B6.value).toBe('Revenue');
    expect(variance.cells.B7.value).toBe('Margin');
    expect(variance.cells.A13.value).toBe('Variance Table');
    expect(variance.cells.A15.value).toBe('West');
    expect(evaluateFormula(variance.cells.D15.formula || '', variance.cells)).toBe('80');
    expect(evaluateFormula(variance.cells.E15.formula || '', variance.cells)).toBe('4');
    expect(evaluateFormula(variance.cells.F15.formula || '', variance.cells)).toBe('Critical');
    expect(solver.name).toBe('Ops Solver');
    expect(solver.cells.A1.value).toBe('Ops Solver');
    expect(solver.cells.A13.value).toBe('Solver Allocation');
    expect(solver.cells.A20.value).toBe('Tradeoff Frontier');
    expect(solver.cells.A28.value).toBe('Optimization Actions');
    expect(correlation.name).toBe('Ops Correlation');
    expect(correlation.cells.A1.value).toBe('Ops Correlation Lab');
    expect(waterfall.name).toBe('Ops Waterfall');
    expect(waterfall.cells.A1.value).toBe('Ops Waterfall Bridge');
    expect(waterfall.cells.A13.value).toBe('West -> East');
    expect(waterfall.cells.C13.value).toBe('60');
    expect(anomaly.name).toBe('Ops Anomaly');
    expect(anomaly.cells.A1.value).toBe('Ops Anomaly Monitor');
    expect(anomaly.cells.A11.value).toBe('Anomaly Queue');
    expect(pack.map((item) => item.name)).toEqual([
      'Ops Executive Brief',
      'Ops KPI Studio',
      'Ops Variance',
      'Ops Solver',
      'Ops Clean Room',
      'Ops Data Doctor',
      'Ops Formula Audit',
      'Ops Waterfall',
      'Ops Anomaly',
      'Ops Dashboard',
      'Ops Insights',
      'Ops Pivot',
      'Ops Correlation',
      'Ops Forecast',
      'Ops Scenario',
      'Ops Sensitivity',
    ]);
    expect(pack.every((item) => Object.keys(item.cells).length > 0)).toBe(true);
  });

  it('builds waterfall bridge and anomaly monitor sheets for movement analysis', () => {
    const sheet: SheetData = {
      name: 'Growth',
      cells: {
        A1: { value: 'Month' },
        B1: { value: 'Revenue' },
        C1: { value: 'Cost' },
        A2: { value: 'Jan' },
        B2: { value: '100' },
        C2: { value: '40' },
        A3: { value: 'Feb' },
        B3: { value: '120' },
        C3: { value: '45' },
        A4: { value: 'Mar' },
        B4: { value: '500' },
        C4: { value: '150' },
        A5: { value: 'Apr' },
        B5: { value: '130' },
        C5: { value: '47' },
      },
      colWidths: {},
      rowHeights: {},
      maxCol: 2,
      maxRow: 4,
    };

    const waterfall = buildSpreadsheetWaterfallBridgeSheet(sheet);
    const anomaly = buildSpreadsheetAnomalyMonitorSheet(sheet);
    const anomalyValues = Object.values(anomaly.cells).map((cell) => cell.value).join(' | ');

    expect(waterfall.name).toBe('Growth Waterfall');
    expect(waterfall.cells.A1.value).toBe('Growth Waterfall Bridge');
    expect(waterfall.cells.B6.value).toBe('Revenue');
    expect(waterfall.cells.D5.value).toContain('moved from');
    expect(waterfall.cells.A13.value).toBe('Jan -> Feb');
    expect(waterfall.cells.C14.value).toBe('380');
    expect(waterfall.cells.A19.value).toBe('Top Drivers');
    expect(waterfall.frozenCols).toBe(1);

    expect(anomaly.name).toBe('Growth Anomaly');
    expect(anomaly.cells.A1.value).toBe('Growth Anomaly Monitor');
    expect(anomaly.cells.A11.value).toBe('Anomaly Queue');
    expect(anomalyValues).toContain('Revenue');
    expect(anomalyValues).toContain('Mar');
    expect(anomalyValues).toContain('critical');
    expect(anomaly.frozenCols).toBe(4);
  });

  it('builds solver sheets for constrained objective allocation', () => {
    const sheet: SheetData = {
      name: 'Allocation',
      cells: {
        A1: { value: 'Program' },
        B1: { value: 'Profit' },
        C1: { value: 'Spend' },
        D1: { value: 'Capacity' },
        A2: { value: 'Alpha' },
        B2: { value: '100' },
        C2: { value: '40' },
        D2: { value: '5' },
        A3: { value: 'Beta' },
        B3: { value: '90' },
        C3: { value: '30' },
        D3: { value: '4' },
        A4: { value: 'Gamma' },
        B4: { value: '70' },
        C4: { value: '20' },
        D4: { value: '3' },
        A5: { value: 'Delta' },
        B5: { value: '80' },
        C5: { value: '60' },
        D5: { value: '6' },
      },
      colWidths: {},
      rowHeights: {},
      maxCol: 3,
      maxRow: 4,
    };

    const solver = buildSpreadsheetSolverSheet(sheet);
    const values = Object.values(solver.cells).map((cell) => cell.value).join(' | ');

    expect(solver.name).toBe('Allocation Solver');
    expect(solver.cells.B6.value).toBe('Profit');
    expect(solver.cells.B7.value).toBe('Spend');
    expect(solver.cells.B8.value).toBe('Capacity');
    expect(solver.cells.E5.value).toBe('90');
    expect(solver.cells.A13.value).toBe('Solver Allocation');
    expect(solver.cells.B15.value).toBe('Gamma');
    expect(solver.cells.E15.value).toBe('3.5');
    expect(evaluateFormula(solver.cells.G15.formula || '', solver.cells)).toBe('20');
    expect(evaluateFormula(solver.cells.H15.formula || '', solver.cells)).toBe('70');
    expect(solver.cells.A22.value).toBe('Tradeoff Frontier');
    expect(solver.cells.A30.value).toBe('Optimization Actions');
    expect(values).toContain('Fund Gamma first');
    expect(solver.frozenRows).toBe(14);
    expect(solver.frozenCols).toBe(1);
  });

  it('builds a clean room sheet with typed values, duplicate flags, and source row traceability', () => {
    const sheet: SheetData = {
      name: 'Messy',
      cells: {
        A1: { value: ' Account ' },
        B1: { value: 'Revenue' },
        C1: { value: 'Revenue' },
        A2: { value: '  North  ' },
        B2: { value: '$1,200.50' },
        C2: { value: '12%' },
        A3: { value: 'North' },
        B3: { value: '$1,200.50' },
        C3: { value: '12%' },
        A4: { value: ' ' },
        B4: { value: '' },
        C4: { value: '' },
        A5: { value: ' South ' },
        B5: { value: '900' },
        C5: { value: '', formula: '=B5/10000' },
      },
      colWidths: {},
      rowHeights: {},
      maxCol: 2,
      maxRow: 4,
    };

    const cleanRoom = buildSpreadsheetCleanRoomSheet(sheet);

    expect(cleanRoom.cells.C1.value).toBe('Account');
    expect(cleanRoom.cells.D1.value).toBe('Revenue');
    expect(cleanRoom.cells.E1.value).toBe('Revenue 2');
    expect(cleanRoom.cells.A2.value).toBe('2');
    expect(cleanRoom.cells.C2.value).toBe('North');
    expect(cleanRoom.cells.D2.value).toBe('1200.5');
    expect(cleanRoom.cells.D2.format?.numberFormat).toBe('currency');
    expect(cleanRoom.cells.E2.value).toBe('0.12');
    expect(cleanRoom.cells.E2.format?.numberFormat).toBe('percent');
    expect(cleanRoom.cells.B3.value).toContain('possible duplicate');
    expect(cleanRoom.cells.B4.value).toContain('formula flattened');
    expect(cleanRoom.cells.A8.value).toBe('Rows exported');
    expect(cleanRoom.cells.B9.value).toBe('1');
  });

  it('builds a data doctor sheet with duplicates, blanks, formula errors, and outliers', () => {
    const sheet: SheetData = {
      name: 'Quality',
      cells: {
        A1: { value: 'Region' },
        B1: { value: 'Revenue' },
        C1: { value: 'Owner' },
        D1: { value: 'Profit' },
        A2: { value: 'West' },
        B2: { value: '100' },
        C2: { value: 'Ari' },
        D2: { value: '', formula: '=B2-20' },
        A3: { value: 'West' },
        B3: { value: '100' },
        C3: { value: 'Ari' },
        D3: { value: '', formula: '=B3-20' },
        A4: { value: 'East' },
        B4: { value: 'text' },
        C4: { value: '' },
        D4: { value: '', formula: '=VLOOKUP("missing",A2:B2,2)' },
        A5: { value: 'North' },
        B5: { value: '1000' },
        C5: { value: '42' },
        D5: { value: '900' },
        A6: { value: 'South' },
        B6: { value: '105' },
        C6: { value: '' },
        D6: { value: '80' },
      },
      colWidths: {},
      rowHeights: {},
      maxCol: 3,
      maxRow: 5,
    };

    const doctor = buildSpreadsheetDataDoctorSheet(sheet);
    const issueValues = Object.values(doctor.cells).map((cell) => cell.value).join(' | ');

    expect(doctor.name).toBe('Quality Data Doctor');
    expect(doctor.cells.A1.value).toBe('Quality Data Doctor');
    expect(Number(doctor.cells.A5.value)).toBeLessThan(100);
    expect(doctor.cells.B5.value).toBe('1');
    expect(issueValues).toContain('Mixed data type');
    expect(issueValues).toContain('Possible duplicate');
    expect(issueValues).toContain('Formula error');
    expect(issueValues).toContain('Numeric outlier');
    expect(doctor.frozenRows).toBe(8);
    expect(doctor.frozenCols).toBe(2);
  });

  it('builds formula audit sheets with dependency and risk flags', () => {
    const sheet: SheetData = {
      name: 'Model',
      cells: {
        A1: { value: 'Revenue' },
        B1: { value: 'Cost' },
        C1: { value: 'Profit' },
        D1: { value: 'Broken' },
        E1: { value: 'Lookup' },
        A2: { value: '120' },
        B2: { value: '50' },
        C2: { value: '', formula: '=A2-B2' },
        D2: { value: '', formula: '=Z9+1' },
        C3: { value: '', formula: '=SUM(A2:B2)' },
        E3: { value: '', formula: '=VLOOKUP("x",A2:B2,2)' },
        F3: { value: '', formula: '=TODAY()' },
      },
      colWidths: {},
      rowHeights: {},
      maxCol: 5,
      maxRow: 2,
    };

    const audit = buildSpreadsheetFormulaAuditSheet(sheet);

    expect(audit.name).toBe('Model Formula Audit');
    expect(audit.cells.A1.value).toBe('Model Formula Audit');
    expect(audit.cells.A5.value).toBe('5');
    expect(audit.cells.B5.value).toBe('1');
    // TODAY() now evaluates (volatile, not an error), so only VLOOKUP's #N/A counts.
    expect(audit.cells.C5.value).toBe('1');
    expect(audit.cells.D5.value).toBe('1');
    expect(audit.cells.A9.value).toBe('C2');
    expect(audit.cells.B9.value).toBe('=A2-B2');
    expect(audit.cells.C9.value).toBe('70');
    expect(audit.cells.D9.value).toContain('A2');
    expect(audit.cells.D9.value).toContain('B2');
    expect(audit.cells.E10.value).toContain('Z9');
    expect(audit.cells.F10.value).toBe('Broken ref');
    expect(audit.cells.F12.value).toBe('Formula error');
    expect(audit.cells.F13.value).toBe('Volatile');
    expect(audit.cells.G13.value).toContain('Volatile function');
    expect(audit.frozenRows).toBe(8);
    expect(audit.frozenCols).toBe(1);
  });
});

describe('XlsxEditor row virtualization', () => {
  it('windows visible rows with overscan and clamps to sheet bounds', () => {
    // 24px rows, 480px viewport => 20 rows visible, 10 overscan each side.
    const top = computeVisibleRowRange({ rowCount: 10000, rowHeight: 24, scrollTop: 0, viewportHeight: 480, overscan: 10 });
    expect(top.startRow).toBe(0);
    expect(top.endRow).toBe(30);

    const mid = computeVisibleRowRange({ rowCount: 10000, rowHeight: 24, scrollTop: 2400, viewportHeight: 480, overscan: 10 });
    expect(mid.startRow).toBe(90); // floor(2400/24)=100, -10 overscan
    expect(mid.endRow).toBe(130);  // ceil((2400+480)/24)=120, +10 overscan

    const end = computeVisibleRowRange({ rowCount: 100, rowHeight: 24, scrollTop: 100000, viewportHeight: 480, overscan: 10 });
    expect(end.endRow).toBe(99); // clamped to rowCount-1
    expect(end.startRow).toBeLessThanOrEqual(99);
  });

  it('returns an empty range for empty sheets', () => {
    expect(computeVisibleRowRange({ rowCount: 0, rowHeight: 24, scrollTop: 0, viewportHeight: 480, overscan: 10 }))
      .toEqual({ startRow: 0, endRow: -1 });
  });

  it('pulls the window start up to include a merge that crosses into it', () => {
    const merges = [
      { startCol: 0, startRow: 3, endCol: 0, endRow: 8 },   // crosses the window top
      { startCol: 1, startRow: 20, endCol: 1, endRow: 24 }, // fully below, ignored
    ];
    expect(expandRowRangeForMerges(6, 15, merges)).toEqual({ startRow: 3, endRow: 15 });
    // A merge entirely inside the window leaves the start untouched.
    expect(expandRowRangeForMerges(2, 10, [{ startCol: 0, startRow: 4, endCol: 0, endRow: 6 }]))
      .toEqual({ startRow: 2, endRow: 10 });
    // A merge entirely above the window is not pulled in.
    expect(expandRowRangeForMerges(10, 20, [{ startCol: 0, startRow: 1, endCol: 0, endRow: 5 }]))
      .toEqual({ startRow: 10, endRow: 20 });
  });
});

describe('XlsxEditor merge-aware column windowing', () => {
  // Uniform 90px columns: offsets[i] === i * 90.
  const uniform = (colCount: number) => Array.from({ length: colCount + 1 }, (_, i) => i * 90);
  const merge = (startCol: number, endCol: number, startRow = 0, endRow = 0) => ({ startCol, endCol, startRow, endRow });

  it('renders all columns with no spacers when virtualization is off', () => {
    const plan = computeColRenderPlan({
      colCount: 5, frozenCols: 0, winColStart: 0, winColEnd: 4, merges: [], offsets: uniform(5), virtualize: false,
    });
    expect(plan.renderCols).toEqual([0, 1, 2, 3, 4]);
    expect(plan.slots.every((s) => s.kind === 'col')).toBe(true);
    // Without a plan compression, a merge spans its raw column count.
    expect(gridColSpanForMerge(plan.slots, 1, 3)).toBe(3);
  });

  it('brackets the window with left and right spacers when there are no merges', () => {
    const plan = computeColRenderPlan({
      colCount: 100, frozenCols: 0, winColStart: 40, winColEnd: 50, merges: [], offsets: uniform(100), virtualize: true,
    });
    expect(plan.renderCols).toEqual(Array.from({ length: 11 }, (_, i) => 40 + i));
    expect(plan.slots[0]).toEqual({ kind: 'spacer', startCol: 0, endCol: 39, width: 40 * 90 });
    expect(plan.slots[1]).toMatchObject({ kind: 'col', startCol: 40 });
    const last = plan.slots[plan.slots.length - 1];
    expect(last).toEqual({ kind: 'spacer', startCol: 51, endCol: 99, width: 49 * 90 });
  });

  it('keeps frozen columns rendered ahead of the window', () => {
    const plan = computeColRenderPlan({
      colCount: 100, frozenCols: 2, winColStart: 40, winColEnd: 50, merges: [], offsets: uniform(100), virtualize: true,
    });
    expect(plan.renderCols.slice(0, 2)).toEqual([0, 1]);
    expect(plan.slots[0]).toMatchObject({ kind: 'col', startCol: 0 });
    expect(plan.slots[1]).toMatchObject({ kind: 'col', startCol: 1 });
    // The gap between the frozen band and the window collapses into one spacer.
    expect(plan.slots[2]).toEqual({ kind: 'spacer', startCol: 2, endCol: 39, width: 38 * 90 });
  });

  it('mounts a merge anchor sitting left of the window and spans it in over the gap', () => {
    const plan = computeColRenderPlan({
      colCount: 100, frozenCols: 0, winColStart: 40, winColEnd: 50,
      merges: [merge(2, 44)], offsets: uniform(100), virtualize: true,
    });
    // The anchor column joins the render set even though it is far left of the window.
    expect(plan.renderCols).toContain(2);
    const anchorSlot = plan.slots.find((s) => s.kind === 'col' && s.startCol === 2);
    expect(anchorSlot).toBeTruthy();
    // Leading columns before the anchor stay a spacer; the interior gap is flagged
    // as covered by the merge so it is dropped on the merge's rows.
    expect(plan.slots[0]).toEqual({ kind: 'spacer', startCol: 0, endCol: 1, width: 2 * 90 });
    const interior = plan.slots.find((s) => s.kind === 'spacer' && s.startCol === 3);
    expect(interior).toMatchObject({ endCol: 39, coverRows: [{ startRow: 0, endRow: 0 }] });
    // colSpan counts grid slots (anchor + interior spacer + window cols up to 44), not raw sheet columns.
    expect(gridColSpanForMerge(plan.slots, 2, 44)).toBe(7);
  });

  it('breaks the right spacer at a merge whose span runs past the window edge', () => {
    const plan = computeColRenderPlan({
      colCount: 100, frozenCols: 0, winColStart: 40, winColEnd: 50,
      merges: [merge(48, 55, 2, 2)], offsets: uniform(100), virtualize: true,
    });
    // The span past the window becomes its own covered spacer ending exactly at 55.
    const tail = plan.slots.find((s) => s.kind === 'spacer' && s.startCol === 51);
    expect(tail).toMatchObject({ endCol: 55, coverRows: [{ startRow: 2, endRow: 2 }] });
    const rest = plan.slots.find((s) => s.kind === 'spacer' && s.startCol === 56);
    expect(rest).toMatchObject({ endCol: 99 });
    expect(rest?.coverRows).toBeUndefined();
    // Anchor is inside the window; colSpan reaches across window cols + the tail spacer.
    expect(gridColSpanForMerge(plan.slots, 48, 55)).toBe(4);
  });

  it('handles a single merge that swallows the whole window on both sides', () => {
    const plan = computeColRenderPlan({
      colCount: 100, frozenCols: 0, winColStart: 40, winColEnd: 50,
      merges: [merge(38, 52)], offsets: uniform(100), virtualize: true,
    });
    expect(plan.renderCols).toContain(38);
    expect(plan.slots.find((s) => s.kind === 'col' && s.startCol === 38)).toBeTruthy();
    // Both the left interior gap and the right overflow are covered spacers.
    expect(plan.slots.find((s) => s.startCol === 39 && s.kind === 'spacer')).toMatchObject({ endCol: 39, coverRows: [{ startRow: 0, endRow: 0 }] });
    expect(plan.slots.find((s) => s.startCol === 51 && s.kind === 'spacer')).toMatchObject({ endCol: 52, coverRows: [{ startRow: 0, endRow: 0 }] });
    expect(gridColSpanForMerge(plan.slots, 38, 52)).toBe(14);
  });

  it('carries multi-row merge ranges onto the covered spacer so every merged row drops it', () => {
    const plan = computeColRenderPlan({
      colCount: 100, frozenCols: 0, winColStart: 40, winColEnd: 55,
      merges: [merge(2, 44, 0, 3), merge(45, 47, 3, 3)], offsets: uniform(100), virtualize: true,
    });
    // First merge crosses in from the left; its interior gap is covered across rows 0..3.
    const interior = plan.slots.find((s) => s.kind === 'spacer' && s.startCol === 3);
    expect(interior).toMatchObject({ endCol: 39, coverRows: [{ startRow: 0, endRow: 3 }] });
    expect(gridColSpanForMerge(plan.slots, 2, 41)).toBe(4);
    // Second merge lives fully inside the window: raw span, no spacer involved.
    expect(gridColSpanForMerge(plan.slots, 45, 47)).toBe(3);
  });

  it('falls back to the raw span when an anchor is not a slot boundary, and handles empty sheets', () => {
    const plan = computeColRenderPlan({
      colCount: 100, frozenCols: 0, winColStart: 40, winColEnd: 50, merges: [], offsets: uniform(100), virtualize: true,
    });
    // Column 10 sits inside the left spacer, so it is not a rendered slot boundary.
    expect(gridColSpanForMerge(plan.slots, 10, 12)).toBe(3);
    expect(computeColRenderPlan({
      colCount: 0, frozenCols: 0, winColStart: 0, winColEnd: 0, merges: [], offsets: [0], virtualize: true,
    })).toEqual({ slots: [], renderCols: [] });
  });
});

describe('XlsxEditor prefix-sum windowing', () => {
  it('builds a zero-length layout for an empty sheet (or an all-hidden filter)', () => {
    expect(computeRowLayout([], {}, 24)).toEqual({ offsets: [0], total: 0 });
    expect(computeColLayout(0, {}, 90)).toEqual({ offsets: [0], total: 0 });
    // A range over a zero-slot layout renders nothing.
    expect(rangeForScroll(0, 480, [0], 10)).toEqual({ startIdx: 0, endIdx: -1 });
  });

  it('accumulates default row heights and honours per-row custom heights', () => {
    // Visible rows 0, 2, 4 (rows 1 and 3 filtered out); row 2 is a tall 40px row.
    expect(computeRowLayout([0, 2, 4], { 2: 40 }, 24))
      .toEqual({ offsets: [0, 24, 64, 88], total: 88 });
    // A single visible row spans exactly its own height.
    expect(computeRowLayout([5], {}, 24)).toEqual({ offsets: [0, 24], total: 24 });
  });

  it('accumulates default column widths and honours per-column custom widths', () => {
    expect(computeColLayout(3, { 1: 120 }, 90))
      .toEqual({ offsets: [0, 90, 210, 300], total: 300 });
    expect(computeColLayout(1, {}, 90)).toEqual({ offsets: [0, 90], total: 90 });
  });

  it('windows uniform slots to the viewport and pads with overscan', () => {
    const { offsets } = computeRowLayout(Array.from({ length: 10 }, (_, i) => i), {}, 24);
    // Top of scroll: slots 0..4 intersect a 100px viewport (rows span 0..120).
    expect(rangeForScroll(0, 100, offsets, 0)).toEqual({ startIdx: 0, endIdx: 4 });
    // Overscan pads both ends but clamps to the grid bounds.
    expect(rangeForScroll(0, 100, offsets, 2)).toEqual({ startIdx: 0, endIdx: 6 });
    // Scrolled into the middle: only the two slots crossing [120,168) show.
    expect(rangeForScroll(120, 48, offsets, 0)).toEqual({ startIdx: 5, endIdx: 6 });
  });

  it('clamps the window to the last slot when scrolled past the end', () => {
    const { offsets } = computeRowLayout(Array.from({ length: 10 }, (_, i) => i), {}, 24);
    expect(rangeForScroll(100000, 480, offsets, 0)).toEqual({ startIdx: 9, endIdx: 9 });
  });

  it('handles a single-slot layout on both axes', () => {
    const row = computeRowLayout([0], {}, 24);
    expect(rangeForScroll(0, 10, row.offsets, 0)).toEqual({ startIdx: 0, endIdx: 0 });
    const col = computeColLayout(1, {}, 90);
    expect(rangeForScroll(0, 50, col.offsets, 3)).toEqual({ startIdx: 0, endIdx: 0 });
  });

  it('windows across mixed custom heights by real pixels, not slot counts', () => {
    // Rows: 24, 40, 24, 24 => offsets [0,24,64,88,112]. A 20px viewport at
    // scrollTop 30 sits entirely inside the tall second slot.
    const { offsets } = computeRowLayout([0, 1, 2, 3], { 1: 40 }, 24);
    expect(offsets).toEqual([0, 24, 64, 88, 112]);
    expect(rangeForScroll(30, 20, offsets, 0)).toEqual({ startIdx: 1, endIdx: 1 });
    // A viewport straddling the tall slot and the next one shows both.
    expect(rangeForScroll(60, 10, offsets, 0)).toEqual({ startIdx: 1, endIdx: 2 });
  });
});

describe('XlsxEditor cell borders', () => {
  it('maps border presets to per-edge flags', () => {
    expect(computeBorderEdges('all', 2, 2, 0, 4, 0, 4)).toEqual({ top: true, bottom: true, left: true, right: true });
    expect(computeBorderEdges('top', 2, 2, 0, 4, 0, 4)).toEqual({ top: true });
    expect(computeBorderEdges('bottom', 2, 2, 0, 4, 0, 4)).toEqual({ bottom: true });
    expect(computeBorderEdges('left', 2, 2, 0, 4, 0, 4)).toEqual({ left: true });
    expect(computeBorderEdges('right', 2, 2, 0, 4, 0, 4)).toEqual({ right: true });
    expect(computeBorderEdges('none', 2, 2, 0, 4, 0, 4)).toEqual({});
  });

  it('draws outline only on the perimeter of the selection', () => {
    // 3x3 selection cols 0..2, rows 0..2.
    expect(computeBorderEdges('outline', 0, 0, 0, 2, 0, 2)).toEqual({ top: true, bottom: false, left: true, right: false });
    expect(computeBorderEdges('outline', 2, 2, 0, 2, 0, 2)).toEqual({ top: false, bottom: true, left: false, right: true });
    // The interior cell gets no edges.
    expect(computeBorderEdges('outline', 1, 1, 0, 2, 0, 2)).toEqual({ top: false, bottom: false, left: false, right: false });
    // A single-cell selection outlines all four sides.
    expect(computeBorderEdges('outline', 5, 5, 5, 5, 5, 5)).toEqual({ top: true, bottom: true, left: true, right: true });
  });

  it('detects whether any edge is set', () => {
    expect(hasAnyBorder(undefined)).toBe(false);
    expect(hasAnyBorder({})).toBe(false);
    expect(hasAnyBorder({ top: false, bottom: false, left: false, right: false })).toBe(false);
    expect(hasAnyBorder({ bottom: true })).toBe(true);
  });
});

describe('XlsxEditor freeze panes', () => {
  it('converts per-sheet freeze counts to a SheetJS pane and back', () => {
    const pane = freezeToPane(2, 1);
    expect(pane).toMatchObject({ xSplit: 1, ySplit: 2, topLeftCell: 'B3', state: 'frozen' });
    expect(paneToFreeze(pane)).toEqual({ frozenRows: 2, frozenCols: 1 });
  });

  it('returns null when nothing is frozen', () => {
    expect(freezeToPane(0, 0)).toBeNull();
    expect(paneToFreeze(undefined)).toEqual({ frozenRows: 0, frozenCols: 0 });
    expect(paneToFreeze(null)).toEqual({ frozenRows: 0, frozenCols: 0 });
  });
});

describe('axis insert/delete remapping', () => {
  it('shifts formula references past an inserted row (absolute refs included)', () => {
    expect(adjustFormulaAxisEdit('=A1+A5', 'row', 'insert', 2)).toBe('=A1+A6');
    expect(adjustFormulaAxisEdit('=$A$5', 'row', 'insert', 2)).toBe('=$A$6');
    expect(adjustFormulaAxisEdit('=SUM(A1:A10)', 'row', 'insert', 4)).toBe('=SUM(A1:A11)');
    // References at/before the edit point stay put
    expect(adjustFormulaAxisEdit('=A1+A2', 'row', 'insert', 4)).toBe('=A1+A2');
    // Column axis
    expect(adjustFormulaAxisEdit('=B1+D1', 'col', 'insert', 1)).toBe('=B1+E1');
  });

  it('turns references to a deleted row into #REF! but clamps range endpoints', () => {
    expect(adjustFormulaAxisEdit('=A5', 'row', 'delete', 4)).toBe('=#REF!');
    expect(adjustFormulaAxisEdit('=A6', 'row', 'delete', 4)).toBe('=A5');
    // Range end clamps instead of dying: A1:A10 minus row 10 -> A1:A9
    expect(adjustFormulaAxisEdit('=SUM(A1:A10)', 'row', 'delete', 9)).toBe('=SUM(A1:A9)');
    // Range start slides onto the next row
    expect(adjustFormulaAxisEdit('=SUM(A5:A10)', 'row', 'delete', 4)).toBe('=SUM(A5:A9)');
  });

  it('leaves string literals untouched', () => {
    expect(adjustFormulaAxisEdit('=IF(A5>0,"A5 up","down")', 'row', 'insert', 2))
      .toBe('=IF(A6>0,"A5 up","down")');
  });

  it('remaps sizes, merges, conditional ranges, and frozen panes on insert', () => {
    const meta = remapSheetMetaAxis({
      rowHeights: { 1: 40, 5: 60 },
      colWidths: { 2: 120 },
      merges: [{ startCol: 0, startRow: 1, endCol: 1, endRow: 3 }],
      conditionalRules: [{ id: 'r1', range: 'B2:B10', type: 'gt', value1: '0' } as ConditionalRule],
      frozenRows: 1,
      frozenCols: 0,
    }, 'row', 'insert', 2);
    expect(meta.rowHeights).toEqual({ 1: 40, 6: 60 });
    // Insert inside the merge span grows it (Excel behavior)
    expect(meta.merges).toEqual([{ startCol: 0, startRow: 1, endCol: 1, endRow: 4 }]);
    expect(meta.conditionalRules?.[0].range).toBe('B2:B11');
    // Insert below the freeze line leaves it alone
    expect(meta.frozenRows).toBeUndefined();
  });

  it('remaps metadata on delete and drops collapsed merges', () => {
    const meta = remapSheetMetaAxis({
      rowHeights: { 2: 50, 4: 70 },
      colWidths: {},
      merges: [
        { startCol: 0, startRow: 2, endCol: 0, endRow: 3 },
        { startCol: 2, startRow: 2, endCol: 3, endRow: 2 },
        { startCol: 5, startRow: 1, endCol: 6, endRow: 4 },
      ],
      conditionalRules: [{ id: 'r1', range: 'A3:A5', type: 'lt', value1: '0' } as ConditionalRule],
      frozenRows: 3,
      frozenCols: 0,
    }, 'row', 'delete', 2);
    // The deleted row's height disappears; later rows shift up
    expect(meta.rowHeights).toEqual({ 3: 70 });
    // Merges living only on the deleted row (or collapsing to one cell) drop;
    // a taller merge just shrinks by one row.
    expect(meta.merges).toEqual([{ startCol: 5, startRow: 1, endCol: 6, endRow: 3 }]);
    expect(meta.conditionalRules?.[0].range).toBe('A3:A4');
    // Deleting above the freeze line pulls it up
    expect(meta.frozenRows).toBe(2);
  });
});
