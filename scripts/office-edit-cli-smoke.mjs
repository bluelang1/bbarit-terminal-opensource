#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'scripts/office-edit.mjs');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbarit-office-cli-'));

const run = (args) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error([
      `office-edit failed: ${args.join(' ')}`,
      result.stdout.trim(),
      result.stderr.trim(),
    ].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
};

const json = (args) => JSON.parse(run(args));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const main = () => {
  const results = [];
  const docx = path.join(tmpDir, 'brief.docx');
  const xlsx = path.join(tmpDir, 'model.xlsx');
  const pptx = path.join(tmpDir, 'review.pptx');
  const projectDir = path.join(tmpDir, 'office-project');
  const wordProjectDir = path.join(tmpDir, 'word-project');
  const excelProjectDir = path.join(tmpDir, 'excel-project');
  const pptProjectDir = path.join(tmpDir, 'powerpoint-project');

  const capabilities = json(['capabilities']);
  assert(capabilities.capabilities.common.includes('project:create'), 'capabilities include project:create');
  assert(capabilities.capabilities.projectTypes.includes('word'), 'capabilities include Office project types');
  assert(capabilities.capabilities.common.includes('apply'), 'capabilities include apply');
  assert(capabilities.capabilities.docx.includes('docx:from-markdown'), 'capabilities include docx:from-markdown');
  assert(capabilities.capabilities.docx.includes('docx:from-json'), 'capabilities include docx:from-json');
  assert(capabilities.capabilities.docx.includes('docx:search'), 'capabilities include docx:search');
  assert(capabilities.capabilities.xlsx.includes('xlsx:add-sheet'), 'capabilities include xlsx:add-sheet');
  assert(capabilities.capabilities.xlsx.includes('xlsx:from-json'), 'capabilities include xlsx:from-json');
  assert(capabilities.capabilities.xlsx.includes('xlsx:range'), 'capabilities include xlsx:range');
  assert(capabilities.capabilities.xlsx.includes('xlsx:clear'), 'capabilities include xlsx:clear');
  assert(capabilities.capabilities.pptx.includes('pptx:delete-slide'), 'capabilities include pptx:delete-slide');
  assert(capabilities.capabilities.pptx.includes('pptx:insert-slide'), 'capabilities include pptx:insert-slide');
  assert(capabilities.capabilities.pptx.includes('pptx:update-slide'), 'capabilities include pptx:update-slide');
  assert(capabilities.capabilities.pptx.includes('pptx:duplicate-slide'), 'capabilities include pptx:duplicate-slide');
  assert(capabilities.capabilities.docx.includes('docx:replace'), 'capabilities include docx:replace');
  assert(capabilities.capabilities.docx.includes('docx:redline'), 'capabilities include docx:redline');
  assert(capabilities.capabilities.xlsx.includes('xlsx:formula-audit'), 'capabilities include xlsx:formula-audit');
  assert(capabilities.capabilities.pptx.includes('pptx:replace-text'), 'capabilities include pptx:replace-text');
  results.push('capabilities expose Office edit commands');

  const prompt = run(['agent-prompt', '엑셀 수식을 점검하고 PPT 요약을 업데이트해줘']);
  assert(prompt.includes('User editing request') && prompt.includes('xlsx:range') && prompt.includes('pptx:update-slide') && prompt.includes('docx:search') && prompt.includes('project:create'), 'agent prompt includes request and API');
  results.push('agent-prompt prints code-agent API instructions');

  let res;
  res = json(['project:create', projectDir, '--name', 'Office Smoke']);
  assert(
    res.ok
      && res.projectType === 'full'
      && fs.existsSync(path.join(projectDir, 'AGENTS.md'))
      && fs.existsSync(path.join(projectDir, 'CLAUDE.md'))
      && fs.existsSync(path.join(projectDir, 'claude.md'))
      && fs.existsSync(path.join(projectDir, 'docs', 'brief.md'))
      && fs.existsSync(path.join(projectDir, 'sheets'))
      && fs.existsSync(path.join(projectDir, 'decks'))
      && fs.existsSync(path.join(projectDir, 'patches', 'example.docx.json'))
      && fs.existsSync(path.join(projectDir, 'patches', 'example.xlsx.json'))
      && fs.existsSync(path.join(projectDir, 'patches', 'example.pptx.json')),
    'project:create scaffolds full Office project files',
  );
  res = json(['project:create', wordProjectDir, '--name', 'Word Smoke', '--type', 'word']);
  assert(
    res.projectType === 'word'
      && fs.existsSync(path.join(wordProjectDir, 'docs', 'brief.md'))
      && fs.existsSync(path.join(wordProjectDir, 'patches', 'example.docx.json'))
      && !fs.existsSync(path.join(wordProjectDir, 'sheets'))
      && !fs.existsSync(path.join(wordProjectDir, 'decks')),
    'project:create --type word creates a Word-focused project',
  );
  res = json(['project:create', excelProjectDir, '--name', 'Excel Smoke', '--type', 'excel']);
  assert(
    res.projectType === 'excel'
      && fs.existsSync(path.join(excelProjectDir, 'sheets'))
      && fs.existsSync(path.join(excelProjectDir, 'patches', 'example.xlsx.json'))
      && !fs.existsSync(path.join(excelProjectDir, 'docs'))
      && !fs.existsSync(path.join(excelProjectDir, 'decks')),
    'project:create --type excel creates an Excel-focused project',
  );
  res = json(['project:create', pptProjectDir, '--name', 'PowerPoint Smoke', '--type', 'powerpoint']);
  assert(
    res.projectType === 'powerpoint'
      && fs.existsSync(path.join(pptProjectDir, 'decks'))
      && fs.existsSync(path.join(pptProjectDir, 'patches', 'example.pptx.json'))
      && !fs.existsSync(path.join(pptProjectDir, 'docs'))
      && !fs.existsSync(path.join(pptProjectDir, 'sheets')),
    'project:create --type powerpoint creates a PowerPoint-focused project',
  );
  results.push('project:create makes typed Office folders with AGENTS.md, CLAUDE.md, and sample patches');

  res = json(['docx:template', docx, '--template', 'business-proposal', '--theme', 'executive-memo']);
  assert(res.ok && fs.existsSync(docx), 'docx template creates a document');
  res = json(['docx:append', docx, '--heading', 'Next Steps', '--paragraph', 'Approve the revised proposal.']);
  assert(res.ok && res.heading === 'Next Steps', 'docx append adds heading');
  res = json(['docx:replace', docx, '--from', 'Approve', '--to', 'Confirm']);
  assert(res.replacements >= 1, 'docx replace edits text');
  res = json(['docx:append', docx, '--heading', 'Editorial Risk', '--paragraph', 'The launch should probably happen very soon because the approval decision needs review.']);
  assert(res.ok, 'docx append adds redline test paragraph');
  res = json(['docx:redline', docx]);
  assert(res.suggestionCount >= 1 && res.suggestions.some((item) => item.reason.includes('Vague') || item.reason.includes('action')), 'docx redline finds editorial suggestions');
  res = json(['docx:to-markdown', docx]);
  assert(res.markdown.includes('Confirm the revised proposal'), 'docx markdown reflects replacement');
  res = json(['docx:from-markdown', path.join(tmpDir, 'markdown.docx'), '--markdown', '# Markdown Brief\n\n- One\n- Two\n\n| A | B |\n|---|---|\n| 1 | 2 |']);
  assert(res.ok && fs.existsSync(path.join(tmpDir, 'markdown.docx')), 'docx from-markdown creates a document');
  const docxJson = path.join(tmpDir, 'json.docx');
  res = json(['docx:from-json', docxJson, '--json', JSON.stringify({
    title: 'JSON Brief',
    sections: [
      { heading: 'Decision', paragraphs: ['Approve the CLI control surface.'], bullets: ['Inspect', 'Patch', 'Verify'] },
      { heading: 'Table', rows: [['Metric', 'Value'], ['Coverage', 'Expanded']] },
    ],
  })]);
  assert(res.ok && fs.existsSync(docxJson), 'docx from-json creates a document');
  res = json(['docx:search', docxJson, '--query', 'coverage']);
  assert(res.count >= 1, 'docx search finds generated text');
  res = json(['docx:to-json', docxJson]);
  assert(res.blocks.some((block) => block.text?.includes('JSON Brief')), 'docx to-json exports blocks');
  results.push('DOCX template, markdown, JSON, append, replace, search, redline, and export commands work');

  res = json(['xlsx:from-json', xlsx, '--json', JSON.stringify({
    sheets: [
      { name: 'Plan', rows: [['Quarter', 'Revenue', 'Cost'], ['Q1', 1200, 800]] },
      { name: 'Archive', rows: [['Status'], ['Old']] },
    ],
  })]);
  assert(res.sheets.includes('Plan') && res.sheets.includes('Archive'), 'xlsx from-json creates workbook sheets');
  res = json(['xlsx:add-sheet', xlsx, '--sheet', 'Scratch']);
  assert(res.ok && res.sheet === 'Scratch', 'xlsx add-sheet creates a worksheet');
  res = json(['xlsx:copy-sheet', xlsx, '--from', 'Plan', '--to', 'Plan Copy']);
  assert(res.ok && res.to === 'Plan Copy', 'xlsx copy-sheet duplicates a worksheet');
  res = json(['xlsx:rename-sheet', xlsx, '--from', 'Scratch', '--to', 'Scratch Archive']);
  assert(res.ok && res.to === 'Scratch Archive', 'xlsx rename-sheet renames a worksheet');
  res = json(['xlsx:range', xlsx, '--sheet', 'Plan', '--cell', 'A1', '--json', JSON.stringify([
    ['Quarter', 'Revenue', 'Cost', 'Profit', 'Margin'],
    ['Q1', 1200, 800, '=B2-C2', '=D2/B2'],
  ])]);
  assert(res.rows === 2 && res.cols === 5, 'xlsx range writes a rectangular block');
  res = json(['xlsx:bulk-set', xlsx, '--json', JSON.stringify([
    { sheet: 'Plan', cell: 'A1', value: 'Quarter' },
    { sheet: 'Plan', cell: 'B1', value: 'Revenue' },
    { sheet: 'Plan', cell: 'C1', value: 'Cost' },
    { sheet: 'Plan', cell: 'A2', value: 'Q1' },
    { sheet: 'Plan', cell: 'B2', value: 1200 },
    { sheet: 'Plan', cell: 'C2', value: 800 },
    { sheet: 'Plan', cell: 'D2', formula: 'B2-C2', value: 400 },
  ])]);
  assert(res.cells === 7 && fs.existsSync(xlsx), 'xlsx bulk-set writes cells');
  res = json(['xlsx:append-row', xlsx, '--sheet', 'Plan', '--json', JSON.stringify(['Q2', 1400, 900, 500])]);
  assert(res.cells === 4, 'xlsx append-row writes data');
  res = json(['xlsx:formula-audit', xlsx]);
  assert(
    res.formulaCount === 2
      && res.formulas.some((formula) => formula.formula === '=B2-C2')
      && res.formulas.some((formula) => formula.formula === '=D2/B2'),
    'xlsx formula-audit finds bulk-set and range formulas',
  );
  res = json(['xlsx:to-json', xlsx, '--sheet', 'Plan']);
  assert(res.rows[0][0] === 'Quarter' && res.rows[1][3] === '=B2-C2' && res.rows[1][4] === '=D2/B2', 'xlsx to-json returns values and formulas');
  res = json(['xlsx:clear', xlsx, '--sheet', 'Plan', '--range', 'E1:E10']);
  assert(res.ok && res.cleared >= 0, 'xlsx clear removes a range without failing');
  res = json(['xlsx:delete-sheet', xlsx, '--sheet', 'Plan Copy']);
  assert(res.deleted === true, 'xlsx delete-sheet removes copied worksheet');
  res = json(['xlsx:delete-sheet', xlsx, '--sheet', 'Scratch Archive']);
  assert(res.deleted === true, 'xlsx delete-sheet removes renamed worksheet');
  res = json(['xlsx:delete-sheet', xlsx, '--sheet', 'Archive']);
  assert(res.deleted === true, 'xlsx delete-sheet removes a worksheet');
  const xlsxPatch = path.join(tmpDir, 'xlsx.patch.json');
  fs.writeFileSync(xlsxPatch, JSON.stringify([
    { op: 'xlsx:set', sheet: 'Plan', cell: 'E1', value: 'Notes' },
    { op: 'xlsx:append-row', sheet: 'Plan', row: ['Q3', 1500, 950, 550, 'Applied'] },
  ]));
  res = json(['apply', xlsx, '--json', xlsxPatch]);
  assert(res.operations === 2, 'apply runs xlsx patch operations');
  results.push('XLSX JSON import, sheet controls, range, clear, bulk-set, append-row, formula-audit, to-json, and apply commands work');

  res = json(['pptx:create', pptx, '--template', 'finance', '--theme', 'finance-terminal', '--title', 'CFO Review', '--subtitle', 'Q3 operating plan']);
  assert(res.slides === 5 && fs.existsSync(pptx), 'pptx finance template creates five slides');
  res = json(['pptx:append-slide', pptx, '--title', 'Decision Request', '--body', 'Approve spend\\nConfirm owner', '--notes', 'Close with the ask.']);
  assert(res.slides === 6, 'pptx append-slide adds a slide');
  res = json(['pptx:insert-slide', pptx, '--index', '2', '--title', 'Inserted Slide', '--body', 'Inserted body', '--theme', 'finance-terminal']);
  assert(res.slides === 7 && res.index === 2, 'pptx insert-slide inserts at an index');
  res = json(['pptx:update-slide', pptx, '--index', '2', '--title', 'Updated Insert', '--body', 'Updated body', '--theme', 'finance-terminal']);
  assert(res.slides === 7, 'pptx update-slide edits a specific slide');
  res = json(['pptx:duplicate-slide', pptx, '--index', '2', '--to', '3', '--theme', 'finance-terminal']);
  assert(res.slides === 8 && res.to === 3, 'pptx duplicate-slide copies a slide');
  res = json(['pptx:replace-text', pptx, '--from', 'CFO Review', '--to', 'Finance Review', '--theme', 'finance-terminal']);
  assert(res.replacements >= 1, 'pptx replace-text edits extracted deck text');
  res = json(['pptx:move-slide', pptx, '--from', '2', '--to', '1', '--theme', 'finance-terminal']);
  assert(res.slides === 8, 'pptx move-slide reorders the deck');
  res = json(['pptx:delete-slide', pptx, '--index', '8', '--theme', 'finance-terminal']);
  assert(res.deleted === true && res.slides === 7, 'pptx delete-slide removes a slide');
  res = json(['pptx:to-json', pptx]);
  assert(res.slides.length === 7 && res.slides.some((slide) => slide.title.includes('Updated Insert')), 'pptx to-json exports slide text');
  res = json(['inspect', pptx]);
  assert(res.slides.some((slide) => slide.title.includes('Finance Review')), 'pptx inspect reflects replacement');
  const pptxPatch = path.join(tmpDir, 'pptx.patch.json');
  fs.writeFileSync(pptxPatch, JSON.stringify([
    { op: 'pptx:append-slide', title: 'Applied Slide', body: 'CLI patch', theme: 'finance-terminal' },
    { op: 'pptx:replace-text', from: 'Applied Slide', to: 'Patched Slide', theme: 'finance-terminal' },
  ]));
  res = json(['apply', pptx, '--json', pptxPatch]);
  assert(res.operations === 2, 'apply runs pptx patch operations');
  results.push('PPTX finance template, append, insert, update, duplicate, move, delete, replace, to-json, inspect, and apply commands work');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.stdout.write(`Office CLI smoke passed:\n${results.map((item) => `- ${item}`).join('\n')}\n`);
};

try {
  main();
} catch (err) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
