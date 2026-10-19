#!/usr/bin/env node
import fs from 'fs';
import { createRequire } from 'node:module';
import path from 'path';
import process from 'process';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

// SheetJS 0.20+ (ESM build) no longer touches the filesystem on its own;
// readFile/writeFile need Node's fs handed over explicitly.
XLSX.set_fs(fs);

const require = createRequire(import.meta.url);
const pptxgen = require('pptxgenjs');

const DOCX_THEMES = {
  'executive-memo': { accent: '2563EB', heading: '0F172A', text: '111827' },
  'research-paper': { accent: '7C3AED', heading: '312E81', text: '1F2937' },
  'proposal-modern': { accent: '0D9488', heading: '064E3B', text: '10201C' },
  'legal-brief': { accent: '525252', heading: '171717', text: '171717' },
};

const PPTX_THEMES = {
  'executive-ink': { bg: 'F8FAFC', title: '0F172A', text: '111827', accent: '2563EB', surface: 'DBEAFE' },
  'startup-signal': { bg: '061512', title: 'ECFEFF', text: 'A7F3D0', accent: '14B8A6', surface: '12312B' },
  'editorial-red': { bg: 'FFF7ED', title: '7F1D1D', text: '1F2937', accent: 'DC2626', surface: 'FED7AA' },
  'data-lab': { bg: 'EEF2FF', title: '312E81', text: '172554', accent: '0891B2', surface: 'C7D2FE' },
  'studio-mono': { bg: 'FAFAFA', title: '18181B', text: '09090B', accent: '71717A', surface: 'E4E4E7' },
  'finance-terminal': { bg: 'F8FAFC', title: '102A43', text: '111827', accent: '16A34A', surface: 'DBEAFE' },
  'customer-aurora': { bg: 'FFF7F3', title: '0F766E', text: '1F2937', accent: 'E11D48', surface: 'CCFBF1' },
  'product-prism': { bg: 'F8FAFC', title: '4338CA', text: '111827', accent: 'F97316', surface: 'E0E7FF' },
};

const OFFICE_CAPABILITIES = {
  inspect: ['.docx', '.xlsx', '.pptx'],
  common: ['inspect', 'apply', 'project:create'],
  docx: ['docx:template', 'docx:from-markdown', 'docx:from-json', 'docx:append', 'docx:replace', 'docx:search', 'docx:to-markdown', 'docx:to-json', 'docx:redline'],
  xlsx: ['xlsx:from-json', 'xlsx:add-sheet', 'xlsx:copy-sheet', 'xlsx:rename-sheet', 'xlsx:delete-sheet', 'xlsx:set', 'xlsx:range', 'xlsx:clear', 'xlsx:bulk-set', 'xlsx:append-row', 'xlsx:to-json', 'xlsx:formula-audit'],
  pptx: ['pptx:create', 'pptx:append-slide', 'pptx:insert-slide', 'pptx:update-slide', 'pptx:duplicate-slide', 'pptx:delete-slide', 'pptx:move-slide', 'pptx:replace-text', 'pptx:to-json', 'pptx:from-json'],
  agent: ['api', 'capabilities', 'agent-prompt'],
  docxTemplates: ['business-proposal', 'meeting-brief', 'technical-report', 'one-page-brief'],
  docxThemes: Object.keys(DOCX_THEMES),
  pptxTemplates: ['pitch', 'report', 'finance', 'qbr', 'roadmap'],
  pptxThemes: Object.keys(PPTX_THEMES),
  projectTypes: ['full', 'word', 'excel', 'powerpoint'],
};

const OFFICE_PROJECT_TYPES = {
  full: {
    label: 'Full Office Project',
    dirs: ['docs', 'sheets', 'decks', 'patches'],
    samplePatches: ['docx', 'xlsx', 'pptx'],
  },
  word: {
    label: 'Word Document Project',
    dirs: ['docs', 'patches'],
    samplePatches: ['docx'],
  },
  excel: {
    label: 'Excel Workbook Project',
    dirs: ['sheets', 'patches'],
    samplePatches: ['xlsx'],
  },
  powerpoint: {
    label: 'PowerPoint Deck Project',
    dirs: ['decks', 'patches'],
    samplePatches: ['pptx'],
  },
};

const DOCX_TEMPLATES = {
  'business-proposal': {
    title: 'Business Proposal',
    sections: [
      ['Executive Summary', 'Summarize the opportunity, recommendation, and expected outcome.'],
      ['Scope', ['Primary deliverable', 'Key constraint', 'Success metric']],
      ['Timeline', [['Phase', 'Owner', 'Target'], ['Discovery', 'Team', 'Week 1'], ['Delivery', 'Team', 'Week 2']]],
      ['Decision', 'Approve the recommended path or request a revised scope.'],
    ],
  },
  'meeting-brief': {
    title: 'Meeting Brief',
    sections: [
      ['Agenda', ['Context', 'Discussion', 'Decision']],
      ['Decisions', ['Decision one', 'Decision two']],
      ['Action Items', [['Action', 'Owner', 'Due'], ['Next step', 'Name', 'Date']]],
    ],
  },
  'technical-report': {
    title: 'Technical Report',
    sections: [
      ['Problem Statement', 'Describe the technical problem, user impact, and constraints.'],
      ['Architecture', 'Outline the system design and core tradeoffs.'],
      ['Validation', [['Check', 'Result', 'Evidence'], ['Build', 'Pass', 'Command output']]],
      ['Risks', ['Operational risk', 'Compatibility risk', 'Follow-up item']],
    ],
  },
  'one-page-brief': {
    title: 'One-page Brief',
    sections: [
      ['Ask', 'State the decision clearly.'],
      ['Why Now', 'Explain urgency and expected impact.'],
      ['Options', [['Option', 'Pros', 'Tradeoffs'], ['A', 'Fast', 'Limited scope'], ['B', 'Complete', 'More time']]],
      ['Recommendation', 'Recommend one path and name the next concrete action.'],
    ],
  },
};

function usage() {
  return `BBARIT Office Edit CLI

Terminal/code-agent API:
  npm run office:api
  npm run office:edit -- capabilities
  npm run office:edit -- agent-prompt "요청을 여기에 입력"
  npm run office:edit -- inspect <file>
  npm run office:edit -- apply <file> --json patch.json
  npm run office:edit -- project:create ./office-project --name "Investor Update" --type full
  npm run office:project -- ./word-project --type word --name "Policy Memo"

DOCX:
  npm run office:edit -- docx:template <file.docx> --template business-proposal --theme executive-memo
  npm run office:edit -- docx:from-markdown <file.docx> --input outline.md
  npm run office:edit -- docx:from-markdown <file.docx> --markdown "# Title\n\nBody"
  npm run office:edit -- docx:from-json <file.docx> --json doc.json
  npm run office:edit -- docx:append <file.docx> --heading "Next Steps" --paragraph "Add this paragraph."
  npm run office:edit -- docx:replace <file.docx> --from "old" --to "new"
  npm run office:edit -- docx:search <file.docx> --query "decision"
  npm run office:edit -- docx:to-markdown <file.docx>
  npm run office:edit -- docx:to-json <file.docx>
  npm run office:edit -- docx:redline <file.docx>

XLSX:
  npm run office:edit -- xlsx:from-json <file.xlsx> --json workbook.json
  npm run office:edit -- xlsx:add-sheet <file.xlsx> --sheet "Plan"
  npm run office:edit -- xlsx:copy-sheet <file.xlsx> --from "Plan" --to "Plan Copy"
  npm run office:edit -- xlsx:rename-sheet <file.xlsx> --from "Sheet1" --to "Plan"
  npm run office:edit -- xlsx:delete-sheet <file.xlsx> --sheet "Old"
  npm run office:edit -- xlsx:set <file.xlsx> --sheet "Sheet1" --cell B2 --value 123
  npm run office:edit -- xlsx:set <file.xlsx> --sheet "Sheet1" --cell D2 --formula "B2-C2"
  npm run office:edit -- xlsx:range <file.xlsx> --sheet "Sheet1" --cell A1 --json '[["Metric","Value"],["ARR",1200]]'
  npm run office:edit -- xlsx:clear <file.xlsx> --sheet "Sheet1" --range A1:C10
  npm run office:edit -- xlsx:bulk-set <file.xlsx> --json '[{"sheet":"Sheet1","cell":"A1","value":"Quarter"}]'
  npm run office:edit -- xlsx:append-row <file.xlsx> --sheet "Sheet1" --json '["Q4",3000,1200]'
  npm run office:edit -- xlsx:to-json <file.xlsx> --sheet "Sheet1"
  npm run office:edit -- xlsx:formula-audit <file.xlsx>

PPTX:
  npm run office:edit -- pptx:create <file.pptx> --template finance --theme finance-terminal --title "CFO Review" --subtitle "Q3"
  npm run office:edit -- pptx:append-slide <file.pptx> --title "Next Step" --body "One\\nTwo" --notes "Speaker note"
  npm run office:edit -- pptx:insert-slide <file.pptx> --index 2 --title "Inserted" --body "One\\nTwo"
  npm run office:edit -- pptx:update-slide <file.pptx> --index 2 --title "Updated" --body "New body"
  npm run office:edit -- pptx:duplicate-slide <file.pptx> --index 2 --to 3
  npm run office:edit -- pptx:delete-slide <file.pptx> --index 2
  npm run office:edit -- pptx:move-slide <file.pptx> --from 3 --to 1
  npm run office:edit -- pptx:replace-text <file.pptx> --from "old" --to "new"
  npm run office:edit -- pptx:to-json <file.pptx>
  npm run office:edit -- pptx:from-json <file.pptx> --json deck.json

JSON deck shape:
  {"theme":"executive-ink","slides":[{"title":"Title","body":"Line one\\nLine two","notes":"Speaker note"}]}

JSON patch shape for apply:
  [{"op":"xlsx:set","sheet":"Plan","cell":"B2","value":123},{"op":"pptx:append-slide","title":"Next","body":"One\\nTwo"}]
`;
}

function agentPrompt(request = '') {
  return `BBARIT Office editing API for terminal code agents

User editing request:
${request || '(no request provided)'}

Workflow:
1. Inspect first:
   npm run office:edit -- inspect <file>
2. Use the matching document command:
   Common batch API: apply, project:create
   DOCX: docx:template, docx:from-markdown, docx:from-json, docx:append, docx:replace, docx:search, docx:to-markdown, docx:to-json, docx:redline
   XLSX: xlsx:from-json, xlsx:add-sheet, xlsx:copy-sheet, xlsx:rename-sheet, xlsx:delete-sheet, xlsx:set, xlsx:range, xlsx:clear, xlsx:bulk-set, xlsx:append-row, xlsx:to-json, xlsx:formula-audit
   PPTX: pptx:create, pptx:append-slide, pptx:insert-slide, pptx:update-slide, pptx:duplicate-slide, pptx:delete-slide, pptx:move-slide, pptx:replace-text, pptx:to-json, pptx:from-json
3. For a new Office work folder visible in the file tree, run:
   npm run office:edit -- project:create ./office-project --name "Project Name" --type full
   Types: ${Object.keys(OFFICE_PROJECT_TYPES).join(', ')}
4. For multi-step edits, prefer:
   npm run office:edit -- apply <file> --json patch.json
5. Inspect again and report the exact commands used.

Rules:
- Prefer JSON commands for bulk edits so the change is reproducible.
- For existing PPTX files, text replace and append rebuild a text-based editable deck from extracted text.
- Do not overwrite source files unless the user explicitly asked to edit in place.
- For design work, prefer PPTX themes: ${Object.keys(PPTX_THEMES).join(', ')}.
`;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(item);
    }
  }
  return { positional, flags };
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
}

function writeFileIfMissing(file, content) {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

function writeJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function readJsonArg(value, fallback) {
  if (!value) {
    if (fallback !== undefined) return fallback;
    throw new Error('--json is required');
  }
  const maybePath = path.resolve(String(value));
  const raw = fs.existsSync(maybePath) ? fs.readFileSync(maybePath, 'utf8') : String(value);
  return JSON.parse(raw);
}

function extOf(file) {
  return path.extname(file).toLowerCase();
}

async function inspectOffice(file) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const ext = extOf(file);
  if (ext === '.xlsx') {
    const workbook = XLSX.readFile(file, { cellFormula: true });
    return {
      type: 'xlsx',
      file,
      sheets: workbook.SheetNames.map((name) => ({
        name,
        range: workbook.Sheets[name]['!ref'] || null,
      })),
    };
  }
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: file });
    const text = result.value || '';
    return {
      type: 'docx',
      file,
      chars: text.length,
      words: text.trim() ? text.trim().split(/\s+/).length : 0,
      preview: text.trim().slice(0, 400),
    };
  }
  if (ext === '.pptx') {
    const slides = await readPptxSlides(file);
    return {
      type: 'pptx',
      file,
      slides: slides.map((slide, idx) => ({
        index: idx + 1,
        title: slide.title || `Slide ${idx + 1}`,
        text: slide.body.slice(0, 300),
      })),
    };
  }
  throw new Error(`Unsupported Office extension: ${ext}`);
}

async function createOfficeProject(targetDir, flags) {
  if (!targetDir) throw new Error('project:create requires a target folder');
  const root = path.resolve(targetDir);
  const name = flags.name || path.basename(root);
  const requestedType = String(flags.type || 'full').toLowerCase();
  const type = OFFICE_PROJECT_TYPES[requestedType] ? requestedType : 'full';
  const projectType = OFFICE_PROJECT_TYPES[type];
  const patchesDir = path.join(root, 'patches');
  const created = [];
  const dirs = [root, ...projectType.dirs.map((dir) => path.join(root, dir))];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }

  const agents = `# AGENTS.md — ${name}

이 폴더는 BBARIT Office CLI로 Office 산출물을 만드는 작업 폴더입니다.

- 프로젝트 종류: ${projectType.label} (\`${type}\`)

## 기본 원칙

- 터미널에서 먼저 \`npm run office:edit -- inspect <file>\`로 현재 문서를 확인합니다.
- 여러 변경은 \`npm run office:edit -- apply <file> --json patches/<name>.json\`로 재현 가능하게 적용합니다.
- Word는 \`docs/\`, Excel은 \`sheets/\`, PowerPoint는 \`decks/\`에 저장합니다. 현재 프로젝트에 없는 폴더가 필요하면 직접 만들거나 \`--type full\`로 다시 scaffold 하세요.
- 편집 후 다시 \`inspect\` 또는 변환 명령으로 결과를 확인합니다.
- 사용자가 요청하지 않은 원본 파일은 덮어쓰지 말고 새 파일명으로 만듭니다.

## 자주 쓰는 명령

\`\`\`bash
npm run office:edit -- capabilities
npm run office:edit -- docx:from-markdown docs/brief.docx --input docs/brief.md
npm run office:edit -- xlsx:set sheets/model.xlsx --sheet Plan --cell B2 --value 123
npm run office:edit -- pptx:create decks/review.pptx --template finance --theme finance-terminal --title "${name}"
\`\`\`
`;

  const claude = `# CLAUDE.md — ${name}

You are working inside a BBARIT Office project.

Use the terminal-first Office API:

\`\`\`bash
npm run office:edit -- inspect <file>
npm run office:edit -- apply <file> --json patches/change.json
npm run office:api
\`\`\`

Expected workflow:

1. Inspect the target Office file.
2. Create or edit DOCX/XLSX/PPTX with \`office:edit\`.
3. Save repeatable JSON patches under \`patches/\`.
4. Verify with inspect/to-json/to-markdown.
5. Report exact commands used.
`;

  const readme = `# ${name}

Office project scaffold created by BBARIT Terminal.

- Type: \`${type}\` (${projectType.label})
${projectType.dirs.includes('docs') ? '- `docs/` — Word/DOCX inputs and outputs\n' : ''}${projectType.dirs.includes('sheets') ? '- `sheets/` — Excel/XLSX workbooks\n' : ''}${projectType.dirs.includes('decks') ? '- `decks/` — PowerPoint/PPTX decks\n' : ''}- \`patches/\` — repeatable JSON edit plans for \`office:edit -- apply\`
`;

  const docxSamplePatch = JSON.stringify([
    { op: 'docx:append', heading: 'Next Steps', paragraph: 'Replace this with the next action.' },
  ], null, 2);
  const xlsxSamplePatch = JSON.stringify([
    { op: 'xlsx:add-sheet', sheet: 'Plan' },
    { op: 'xlsx:set', sheet: 'Plan', cell: 'A1', value: 'Metric' },
    { op: 'xlsx:set', sheet: 'Plan', cell: 'B1', value: 'Value' },
  ], null, 2);
  const pptxSamplePatch = JSON.stringify([
    { op: 'pptx:create', template: 'pitch', theme: 'executive-ink', title: name },
    { op: 'pptx:append-slide', title: 'Next Step', body: 'Decision\\nOwner\\nDate' },
  ], null, 2);

  const files = [
    [path.join(root, 'AGENTS.md'), agents],
    [path.join(root, 'CLAUDE.md'), claude],
    [path.join(root, 'claude.md'), claude],
    [path.join(root, 'README.md'), readme],
    ...(projectType.samplePatches.includes('docx') ? [
      [path.join(root, 'docs', 'brief.md'), `# ${name}\n\n- Draft the ask\n- Add evidence\n- Name the owner\n`],
      [path.join(patchesDir, 'example.docx.json'), `${docxSamplePatch}\n`],
    ] : []),
    ...(projectType.samplePatches.includes('xlsx') ? [
      [path.join(patchesDir, 'example.xlsx.json'), `${xlsxSamplePatch}\n`],
    ] : []),
    ...(projectType.samplePatches.includes('pptx') ? [
      [path.join(patchesDir, 'example.pptx.json'), `${pptxSamplePatch}\n`],
    ] : []),
  ];
  const createdFiles = [];
  for (const [file, content] of files) {
    if (writeFileIfMissing(file, content)) createdFiles.push(file);
  }
  return {
    ok: true,
    type: 'office-project',
    action: 'create',
    dir: root,
    name,
    projectType: type,
    createdDirs: created,
    createdFiles,
    next: [
      `cd ${root}`,
      'npm run office:api',
      'npm run office:edit -- capabilities',
    ],
  };
}

function coerceCellValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value != null && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value ?? '';
}

function normalizeXlsxCellValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.formula != null) {
      const formula = String(value.formula).replace(/^=/, '');
      const formulaValue = value.value ?? 0;
      return {
        t: typeof formulaValue === 'string' ? 's' : 'n',
        f: formula,
        v: formulaValue,
      };
    }
    if (Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
  }
  if (typeof value === 'string') {
    if (value.startsWith("'=")) return value.slice(1);
    if (value.startsWith('=')) return { t: 'n', f: value.slice(1), v: 0 };
  }
  return value;
}

function normalizeXlsxRows(rows) {
  return rows.map((row) => (
    Array.isArray(row)
      ? row.map((value) => normalizeXlsxCellValue(value))
      : [normalizeXlsxCellValue(row)]
  ));
}

function writeXlsxCell(sheet, cell, value) {
  const normalized = normalizeXlsxCellValue(value);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized) && normalized.f != null) {
    sheet[cell] = normalized;
    return;
  }
  XLSX.utils.sheet_add_aoa(sheet, [[typeof normalized === 'string' ? coerceCellValue(normalized) : normalized]], { origin: cell });
}

function getSheet(workbook, name) {
  const sheetName = name || workbook.SheetNames[0];
  if (!workbook.Sheets[sheetName]) {
    workbook.SheetNames.push(sheetName);
    workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet([]);
  }
  return { sheetName, sheet: workbook.Sheets[sheetName] };
}

function expandSheetRef(sheet, cell) {
  const point = XLSX.utils.decode_cell(cell);
  if (!sheet['!ref']) {
    sheet['!ref'] = cell;
    return;
  }
  const range = XLSX.utils.decode_range(sheet['!ref']);
  range.s.r = Math.min(range.s.r, point.r);
  range.s.c = Math.min(range.s.c, point.c);
  range.e.r = Math.max(range.e.r, point.r);
  range.e.c = Math.max(range.e.c, point.c);
  sheet['!ref'] = XLSX.utils.encode_range(range);
}

async function xlsxSet(file, flags) {
  const workbook = fs.existsSync(file) ? XLSX.readFile(file, { cellFormula: true }) : XLSX.utils.book_new();
  const { sheetName, sheet } = getSheet(workbook, flags.sheet);
  if (!flags.cell) throw new Error('--cell is required');
  if (flags.formula != null) {
    sheet[flags.cell] = { t: 'n', f: String(flags.formula).replace(/^=/, ''), v: Number(flags.value ?? 0) };
  } else {
    writeXlsxCell(sheet, flags.cell, flags.value ?? '');
  }
  expandSheetRef(sheet, flags.cell);
  ensureParent(file);
  XLSX.writeFile(workbook, file);
  return { ok: true, type: 'xlsx', action: 'set', file, sheet: sheetName, cell: flags.cell };
}

async function xlsxFromJson(file, flags) {
  const spec = readJsonArg(flags.json);
  const workbook = XLSX.utils.book_new();
  const sheets = Array.isArray(spec)
    ? [{ name: flags.sheet || 'Sheet1', rows: spec }]
    : Array.isArray(spec?.sheets)
      ? spec.sheets
      : Object.entries(spec || {}).map(([name, rows]) => ({ name, rows }));
  if (!sheets.length) throw new Error('xlsx:from-json needs rows or sheets');
  for (const sheetSpec of sheets) {
    const name = String(sheetSpec.name || sheetSpec.sheet || `Sheet${workbook.SheetNames.length + 1}`);
    const rows = Array.isArray(sheetSpec.rows) ? sheetSpec.rows : [];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(normalizeXlsxRows(rows)), name.slice(0, 31));
  }
  ensureParent(file);
  XLSX.writeFile(workbook, file);
  return { ok: true, type: 'xlsx', action: 'from-json', file, sheets: workbook.SheetNames };
}

async function xlsxRange(file, flags) {
  if (!flags.cell) throw new Error('--cell is required');
  const workbook = fs.existsSync(file) ? XLSX.readFile(file, { cellFormula: true }) : XLSX.utils.book_new();
  const { sheetName, sheet } = getSheet(workbook, flags.sheet);
  const raw = readJsonArg(flags.json);
  const rows = Array.isArray(raw) ? raw : raw.rows;
  if (!Array.isArray(rows)) throw new Error('--json must be an array of rows or an object with rows[]');
  XLSX.utils.sheet_add_aoa(sheet, normalizeXlsxRows(rows), { origin: flags.cell });
  ensureParent(file);
  XLSX.writeFile(workbook, file);
  return {
    ok: true,
    type: 'xlsx',
    action: 'range',
    file,
    sheet: sheetName,
    cell: flags.cell,
    rows: rows.length,
    cols: rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0),
  };
}

async function xlsxClear(file, flags) {
  const target = flags.range || flags.cell;
  if (!target) throw new Error('--range or --cell is required');
  const workbook = XLSX.readFile(file, { cellFormula: true });
  const { sheetName, sheet } = getSheet(workbook, flags.sheet);
  const range = target.includes(':')
    ? XLSX.utils.decode_range(target)
    : { s: XLSX.utils.decode_cell(target), e: XLSX.utils.decode_cell(target) };
  let cleared = 0;
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const address = XLSX.utils.encode_cell({ r, c });
      if (sheet[address]) {
        delete sheet[address];
        cleared += 1;
      }
    }
  }
  XLSX.writeFile(workbook, file);
  return { ok: true, type: 'xlsx', action: 'clear', file, sheet: sheetName, target, cleared };
}

function applyXlsxPatch(workbook, patch) {
  const { sheetName, sheet } = getSheet(workbook, patch.sheet);
  if (!patch.cell) throw new Error('Each xlsx:bulk-set patch needs a cell');
  if (patch.formula != null) {
    sheet[patch.cell] = { t: 'n', f: String(patch.formula).replace(/^=/, ''), v: Number(patch.value ?? 0) };
  } else {
    writeXlsxCell(sheet, patch.cell, patch.value ?? '');
  }
  expandSheetRef(sheet, patch.cell);
  return { sheet: sheetName, cell: patch.cell };
}

async function xlsxBulkSet(file, flags) {
  if (!flags.json) throw new Error('--json is required');
  const workbook = fs.existsSync(file) ? XLSX.readFile(file, { cellFormula: true }) : XLSX.utils.book_new();
  const patches = readJsonArg(flags.json);
  if (!Array.isArray(patches)) throw new Error('--json must be an array of patches');
  const applied = patches.map((patch) => applyXlsxPatch(workbook, patch));
  ensureParent(file);
  XLSX.writeFile(workbook, file);
  return { ok: true, type: 'xlsx', action: 'bulk-set', file, cells: applied.length, applied };
}

async function xlsxAppendRow(file, flags) {
  const workbook = fs.existsSync(file) ? XLSX.readFile(file, { cellFormula: true }) : XLSX.utils.book_new();
  const { sheetName, sheet } = getSheet(workbook, flags.sheet);
  const row = readJsonArg(flags.json, []);
  XLSX.utils.sheet_add_aoa(sheet, normalizeXlsxRows([row]), { origin: -1 });
  ensureParent(file);
  XLSX.writeFile(workbook, file);
  return { ok: true, type: 'xlsx', action: 'append-row', file, sheet: sheetName, cells: row.length };
}

async function xlsxAddSheet(file, flags) {
  const sheetName = flags.sheet || flags.name;
  if (!sheetName) throw new Error('--sheet is required');
  const workbook = fs.existsSync(file) ? XLSX.readFile(file, { cellFormula: true }) : XLSX.utils.book_new();
  if (!workbook.Sheets[sheetName]) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), sheetName);
  }
  ensureParent(file);
  XLSX.writeFile(workbook, file);
  return { ok: true, type: 'xlsx', action: 'add-sheet', file, sheet: sheetName };
}

async function xlsxCopySheet(file, flags) {
  const from = flags.from || flags.sheet;
  const to = flags.to || flags.name;
  if (!from || !to) throw new Error('--from and --to are required');
  const workbook = XLSX.readFile(file, { cellFormula: true });
  if (!workbook.Sheets[from]) throw new Error(`Sheet not found: ${from}`);
  if (workbook.Sheets[to]) throw new Error(`Sheet already exists: ${to}`);
  workbook.Sheets[to] = JSON.parse(JSON.stringify(workbook.Sheets[from]));
  workbook.SheetNames.push(to);
  XLSX.writeFile(workbook, file);
  return { ok: true, type: 'xlsx', action: 'copy-sheet', file, from, to };
}

async function xlsxRenameSheet(file, flags) {
  const from = flags.from || flags.sheet;
  const to = flags.to || flags.name;
  if (!from || !to) throw new Error('--from and --to are required');
  const workbook = XLSX.readFile(file, { cellFormula: true });
  if (!workbook.Sheets[from]) throw new Error(`Sheet not found: ${from}`);
  if (workbook.Sheets[to]) throw new Error(`Sheet already exists: ${to}`);
  workbook.Sheets[to] = workbook.Sheets[from];
  delete workbook.Sheets[from];
  workbook.SheetNames = workbook.SheetNames.map((name) => (name === from ? to : name));
  XLSX.writeFile(workbook, file);
  return { ok: true, type: 'xlsx', action: 'rename-sheet', file, from, to };
}

async function xlsxDeleteSheet(file, flags) {
  const sheetName = flags.sheet || flags.name;
  if (!sheetName) throw new Error('--sheet is required');
  const workbook = XLSX.readFile(file, { cellFormula: true });
  if (!workbook.Sheets[sheetName]) return { ok: true, type: 'xlsx', action: 'delete-sheet', file, sheet: sheetName, deleted: false };
  if (workbook.SheetNames.length <= 1) throw new Error('Cannot delete the last worksheet');
  delete workbook.Sheets[sheetName];
  workbook.SheetNames = workbook.SheetNames.filter((name) => name !== sheetName);
  XLSX.writeFile(workbook, file);
  return { ok: true, type: 'xlsx', action: 'delete-sheet', file, sheet: sheetName, deleted: true };
}

async function xlsxToJson(file, flags) {
  const workbook = XLSX.readFile(file, { cellFormula: true });
  const { sheetName, sheet } = getSheet(workbook, flags.sheet);
  if (!sheet['!ref']) return { type: 'xlsx-json', file, sheet: sheetName, rows: [] };
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      row.push(cell?.f ? `=${cell.f}` : (cell?.v ?? ''));
    }
    rows.push(row);
  }
  return { type: 'xlsx-json', file, sheet: sheetName, rows };
}

async function xlsxFormulaAudit(file, flags) {
  const workbook = XLSX.readFile(file, { cellFormula: true });
  const sheetNames = flags.sheet ? [flags.sheet] : workbook.SheetNames;
  const formulas = [];
  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    for (const address of Object.keys(sheet).filter((key) => !key.startsWith('!')).sort()) {
      const cell = sheet[address];
      if (!cell?.f) continue;
      formulas.push({
        sheet: sheetName,
        cell: address,
        formula: `=${cell.f}`,
        cachedValue: cell.v ?? null,
      });
    }
  }
  return {
    ok: true,
    type: 'xlsx',
    action: 'formula-audit',
    file,
    formulas,
    formulaCount: formulas.length,
  };
}

function paragraph(text, opts = {}) {
  return new Paragraph({ children: [new TextRun({ text, ...opts })] });
}

function tableFromRows(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((row) => new TableRow({
      children: row.map((cell) => new TableCell({ children: [paragraph(String(cell))] })),
    })),
  });
}

function markdownToDocxChildren(markdown) {
  const children = [];
  const lines = String(markdown || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (/^\|.+\|$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[i + 1].trim())) {
      const rows = [];
      const readRow = (value) => value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      rows.push(readRow(line));
      i += 1;
      while (i + 1 < lines.length && /^\|.+\|$/.test(lines[i + 1].trim())) {
        i += 1;
        rows.push(readRow(lines[i]));
      }
      children.push(tableFromRows(rows));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length === 1 ? HeadingLevel.HEADING_1 : heading[1].length === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ heading: level, children: [new TextRun({ text: heading[2], bold: true })] }));
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      children.push(new Paragraph({ children: [new TextRun({ text: bullet[1] })], bullet: { level: 0 } }));
      continue;
    }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      children.push(new Paragraph({ children: [new TextRun({ text: numbered[1] })], numbering: { reference: 'office-numbering', level: 0 } }));
      continue;
    }
    children.push(paragraph(line));
  }
  return children.length ? children : [paragraph('')];
}

function docxSpecToChildren(spec) {
  const children = [];
  const pushParagraph = (text, opts = {}) => {
    if (text == null) return;
    children.push(paragraph(String(text), opts));
  };
  const pushBlock = (block) => {
    if (typeof block === 'string') {
      pushParagraph(block);
      return;
    }
    if (!block || typeof block !== 'object') return;
    const type = block.type || block.kind;
    if (type === 'heading' || block.heading) {
      const levelNumber = Number(block.level || 2);
      const level = levelNumber <= 1 ? HeadingLevel.HEADING_1 : levelNumber === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ heading: level, children: [new TextRun({ text: String(block.text || block.heading || ''), bold: true })] }));
      return;
    }
    if (type === 'bullet' || type === 'list') {
      const items = Array.isArray(block.items) ? block.items : [block.text].filter(Boolean);
      for (const item of items) {
        children.push(new Paragraph({ children: [new TextRun({ text: String(item) })], bullet: { level: 0 } }));
      }
      return;
    }
    if (type === 'table' || block.rows) {
      const rows = Array.isArray(block.rows) ? block.rows : [];
      if (rows.length) children.push(tableFromRows(rows));
      return;
    }
    pushParagraph(block.text || block.paragraph || '');
  };

  if (spec.title) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: String(spec.title), bold: true })] }));
  }
  if (Array.isArray(spec.blocks)) {
    spec.blocks.forEach(pushBlock);
  }
  if (Array.isArray(spec.sections)) {
    for (const section of spec.sections) {
      if (section.heading || section.title) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: String(section.heading || section.title), bold: true })] }));
      }
      for (const item of section.paragraphs || []) pushParagraph(item);
      if (section.paragraph) pushParagraph(section.paragraph);
      if (Array.isArray(section.bullets)) pushBlock({ type: 'bullet', items: section.bullets });
      if (Array.isArray(section.table)) pushBlock({ type: 'table', rows: section.table });
      if (Array.isArray(section.rows)) pushBlock({ type: 'table', rows: section.rows });
      if (Array.isArray(section.blocks)) section.blocks.forEach(pushBlock);
    }
  }
  return children.length ? children : [paragraph('')];
}

function templateChildren(templateId, themeId) {
  const template = DOCX_TEMPLATES[templateId] || DOCX_TEMPLATES['business-proposal'];
  const theme = DOCX_THEMES[themeId] || DOCX_THEMES['executive-memo'];
  const children = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: template.title, bold: true, color: theme.heading })],
    }),
  ];
  for (const [heading, content] of template.sections) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: heading, bold: true, color: theme.accent })],
    }));
    if (Array.isArray(content) && Array.isArray(content[0])) {
      children.push(tableFromRows(content));
    } else if (Array.isArray(content)) {
      for (const item of content) {
        children.push(new Paragraph({ children: [new TextRun({ text: String(item), color: theme.text })], bullet: { level: 0 } }));
      }
    } else {
      children.push(paragraph(String(content), { color: theme.text }));
    }
  }
  return children;
}

async function writeDocx(file, children) {
  const doc = new Document({
    numbering: {
      config: [{
        reference: 'office-numbering',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left' }],
      }],
    },
    sections: [{ children }],
  });
  const buffer = await Packer.toBuffer(doc);
  ensureParent(file);
  fs.writeFileSync(file, buffer);
}

async function docxTemplate(file, flags) {
  const template = flags.template || 'business-proposal';
  const theme = flags.theme || 'executive-memo';
  await writeDocx(file, templateChildren(template, theme));
  return { ok: true, type: 'docx', action: 'template', file, template, theme };
}

async function docxAppend(file, flags) {
  const children = [];
  if (fs.existsSync(file)) {
    const result = await mammoth.extractRawText({ path: file });
    for (const line of (result.value || '').split(/\n+/).map((line) => line.trim()).filter(Boolean)) {
      children.push(paragraph(line));
    }
  }
  if (flags.heading) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: flags.heading, bold: true })] }));
  }
  if (flags.paragraph) children.push(paragraph(flags.paragraph));
  if (children.length === 0) children.push(paragraph(''));
  await writeDocx(file, children);
  return { ok: true, type: 'docx', action: 'append', file, heading: flags.heading || null };
}

async function docxFromMarkdown(file, flags) {
  const markdown = flags.input
    ? fs.readFileSync(flags.input, 'utf8')
    : String(flags.markdown ?? '');
  if (!markdown.trim()) throw new Error('--input or --markdown is required');
  await writeDocx(file, markdownToDocxChildren(markdown));
  return { ok: true, type: 'docx', action: 'from-markdown', file };
}

async function docxFromJson(file, flags) {
  const spec = readJsonArg(flags.json);
  await writeDocx(file, docxSpecToChildren(spec));
  return {
    ok: true,
    type: 'docx',
    action: 'from-json',
    file,
    blocks: Array.isArray(spec.blocks) ? spec.blocks.length : 0,
    sections: Array.isArray(spec.sections) ? spec.sections.length : 0,
  };
}

async function docxToMarkdown(file) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const result = await mammoth.convertToMarkdown({ path: file });
  return {
    ok: true,
    type: 'docx',
    action: 'to-markdown',
    file,
    markdown: result.value || '',
    messages: result.messages || [],
  };
}

async function docxToJson(file) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const result = await mammoth.convertToMarkdown({ path: file });
  const markdown = result.value || '';
  const blocks = markdown.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) return { type: 'heading', level: heading[1].length, text: heading[2] };
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) return { type: 'bullet', text: bullet[1] };
    return { type: 'paragraph', text: line };
  });
  return {
    ok: true,
    type: 'docx',
    action: 'to-json',
    file,
    blocks,
    markdown,
    messages: result.messages || [],
  };
}

async function docxReplace(file, flags) {
  if (!flags.from) throw new Error('--from is required');
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const result = await mammoth.extractRawText({ path: file });
  const source = result.value || '';
  const from = String(flags.from);
  const to = String(flags.to ?? '');
  const count = source.split(from).length - 1;
  if (count === 0) return { ok: true, type: 'docx', action: 'replace', file, replacements: 0 };
  const children = source
    .replaceAll(from, to)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => paragraph(line));
  await writeDocx(file, children.length ? children : [paragraph('')]);
  return { ok: true, type: 'docx', action: 'replace', file, replacements: count };
}

async function docxSearch(file, flags) {
  const query = String(flags.query || flags.text || '').trim();
  if (!query) throw new Error('--query is required');
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const result = await mammoth.extractRawText({ path: file });
  const lines = (result.value || '').split(/\n+/);
  const q = query.toLowerCase();
  const matches = lines
    .map((line, idx) => ({ line: idx + 1, text: line.trim() }))
    .filter((item) => item.text.toLowerCase().includes(q));
  return { ok: true, type: 'docx', action: 'search', file, query, matches, count: matches.length };
}

function summarizeSentence(sentence, maxWords = 28) {
  const words = String(sentence || '').trim().split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? words.join(' ') : `${words.slice(0, maxWords).join(' ')}...`;
}

function tightenRedlineSentence(sentence) {
  return summarizeSentence(sentence)
    .replace(/\bvery\s+/gi, '')
    .replace(/\breally\s+/gi, '')
    .replace(/\bmaybe\b/gi, 'if validated')
    .replace(/\bprobably\b/gi, 'based on current evidence')
    .replace(/\bASAP\b/g, 'by the agreed deadline')
    .replace(/\bsoon\b/gi, 'by a named date')
    .replace(/\btry to\b/gi, 'will')
    .replace(/\bshould\b/gi, 'will')
    .replace(/\bcould\b/gi, 'can')
    .replace(/\bmight\b/gi, 'may')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectDocxRedlines(text) {
  const sentences = String(text || '').split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const suggestions = [];
  const add = (item) => {
    if (!item.original || suggestions.some((existing) => existing.original === item.original && existing.reason === item.reason)) return;
    suggestions.push(item);
  };
  for (const sentence of sentences) {
    if (suggestions.length >= 12) break;
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length > 34) {
      add({ original: summarizeSentence(sentence, 34), suggestion: 'Split into two sentences: fact, then decision or implication.', reason: 'Long sentence', severity: 'warning' });
    }
    if (/\b(very|really|some|many|several|stuff|things|nice|good|bad|soon|ASAP|probably|maybe)\b/i.test(sentence)) {
      add({ original: summarizeSentence(sentence), suggestion: tightenRedlineSentence(sentence), reason: 'Vague wording', severity: 'warning' });
    }
    if (/\b(should|could|might|try to|need to)\b/i.test(sentence)) {
      add({ original: summarizeSentence(sentence), suggestion: tightenRedlineSentence(sentence), reason: 'Use action language', severity: 'info' });
    }
    if (/\b(decision|approve|approval|risk|launch|deadline|timeline|budget|forecast)\b/i.test(sentence)
      && !/\b(owner|due|by|date|responsible|담당|기한|마감)\b/i.test(sentence)) {
      add({ original: summarizeSentence(sentence), suggestion: `${summarizeSentence(sentence, 20)} Owner: TBD. Due: TBD.`, reason: 'Missing owner or timing', severity: 'warning' });
    }
  }
  if (!suggestions.length) {
    suggestions.push({ original: 'No major redline candidates detected.', suggestion: 'Add more decision, risk, metric, or approval language and rerun.', reason: 'Clean or short document', severity: 'info' });
  }
  return suggestions;
}

async function docxRedline(file) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const result = await mammoth.extractRawText({ path: file });
  const text = result.value || '';
  const suggestions = collectDocxRedlines(text);
  return {
    ok: true,
    type: 'docx',
    action: 'redline',
    file,
    suggestions,
    suggestionCount: suggestions.length,
  };
}

function splitLines(text = '') {
  return String(text).split(/\\n|\n/).map((line) => line.trim()).filter(Boolean);
}

function addPptxSlide(deck, slideSpec, theme) {
  const slide = deck.addSlide();
  slide.background = { color: theme.bg };
  slide.addText(slideSpec.title || 'Untitled Slide', {
    x: 0.7, y: 0.55, w: 11.8, h: 0.6,
    fontSize: 30, bold: true, color: theme.title,
  });
  const lines = splitLines(slideSpec.body);
  if (lines.length > 0) {
    slide.addText(lines.map((line) => ({ text: line, options: { bullet: { type: 'ul' } } })), {
      x: 0.9, y: 1.55, w: 8.4, h: 4.2,
      fontSize: 17, color: theme.text, breakLine: false, fit: 'shrink',
    });
  }
  slide.addShape(deck.ShapeType?.rect || 'rect', {
    x: 10.1, y: 1.55, w: 2.1, h: 4.2,
    fill: { color: theme.surface },
    line: { color: theme.accent },
  });
  if (slideSpec.notes) slide.addNotes(String(slideSpec.notes));
}

async function pptxCreateFromSpec(file, spec) {
  const theme = PPTX_THEMES[spec.theme || 'executive-ink'] || PPTX_THEMES['executive-ink'];
  const deck = new pptxgen();
  deck.layout = 'LAYOUT_WIDE';
  for (const slideSpec of spec.slides || []) addPptxSlide(deck, slideSpec, theme);
  if (!spec.slides?.length) addPptxSlide(deck, { title: spec.title || 'Untitled Deck', body: spec.subtitle || '' }, theme);
  ensureParent(file);
  await deck.writeFile({ fileName: file });
}

async function pptxCreate(file, flags) {
  const template = flags.template || 'pitch';
  const theme = flags.theme || 'executive-ink';
  const title = flags.title || (template === 'report' ? 'Report' : 'Presentation');
  const subtitle = flags.subtitle || '';
  const templateSlides = {
    report: [
      { title, body: subtitle || 'Summary\nFindings\nRecommendation', notes: flags.notes || '' },
      { title: 'Evidence', body: 'Data point one\nData point two\nData point three' },
    ],
    finance: [
      { title: flags.title || 'Financial Command Center', body: subtitle || 'Revenue\nMargin\nRunway', notes: flags.notes || 'Open with the decision finance needs.' },
      { title: 'P&L Bridge', body: 'Plan\nVolume\nPrice\nCost\nActual' },
      { title: 'Variance Drivers', body: 'Revenue\nCOGS\nOpEx\nCash' },
      { title: 'Forecast Range', body: 'Downside\nBase\nUpside' },
      { title: 'Capital Decisions', body: 'Hire\nSpend\nPrice\nRaise' },
    ],
    qbr: [
      { title: flags.title || 'Customer Value Review', body: subtitle || 'Outcomes\nAdoption\nExpansion', notes: flags.notes || 'Make the customer the hero.' },
      { title: 'Outcome Scorecard', body: 'Adoption\nValue\nHealth' },
      { title: 'Adoption Journey', body: 'Onboard\nActivate\nExpand\nAdvocate' },
      { title: 'Value Proof', body: 'Impact\nEvidence\nOwner' },
      { title: 'Renewal & Expansion Plan', body: 'Risk\nCommitment\nExpansion' },
    ],
    roadmap: [
      { title: flags.title || 'Product Strategy Review', body: subtitle || 'Customer outcome\nTradeoff\nDecision', notes: flags.notes || 'Frame the product bet and decision boundary.' },
      { title: 'Customer Evidence', body: 'Interview\nUsage\nSupport\nRevenue' },
      { title: 'Prioritization Matrix', body: 'Impact\nConfidence\nCapacity' },
      { title: 'Roadmap Now Next Later', body: 'Now\nNext\nLater' },
      { title: 'Launch Risks', body: 'Adoption\nQuality\nGTM\nSupport' },
    ],
    pitch: [
      { title, body: subtitle || 'Problem\nSolution\nNext step', notes: flags.notes || '' },
      { title: 'Plan', body: 'Milestone one\nMilestone two\nMilestone three' },
    ],
  };
  const slides = templateSlides[template] || templateSlides.pitch;
  await pptxCreateFromSpec(file, { theme, slides });
  return { ok: true, type: 'pptx', action: 'create', file, template, theme, slides: slides.length };
}

async function readPptxSlides(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] || 0) - Number(b.match(/slide(\d+)/)?.[1] || 0));
  const slides = [];
  for (const name of slideFiles) {
    const xml = await zip.file(name).async('string');
    const text = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)]
      .map((match) => match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
      .join('\n')
      .trim();
    const lines = splitLines(text);
    slides.push({ title: lines[0] || '', body: lines.slice(1).join('\n') });
  }
  return slides;
}

async function pptxAppendSlide(file, flags) {
  const existing = fs.existsSync(file) ? await readPptxSlides(file) : [];
  const theme = flags.theme || 'executive-ink';
  const slides = [
    ...existing.map((slide) => ({ title: slide.title || 'Slide', body: slide.body })),
    { title: flags.title || 'New Slide', body: flags.body || '', notes: flags.notes || '' },
  ];
  await pptxCreateFromSpec(file, { theme, slides });
  return { ok: true, type: 'pptx', action: 'append-slide', file, slides: slides.length, note: 'Deck was rebuilt from extracted slide text.' };
}

async function pptxInsertSlide(file, flags) {
  const index = Number(flags.index ?? flags.slide ?? 1);
  if (!Number.isInteger(index) || index < 1) throw new Error('--index must be a 1-based slide number');
  const existing = fs.existsSync(file) ? await readPptxSlides(file) : [];
  if (index > existing.length + 1) throw new Error(`Slide index out of range: deck has ${existing.length} slides`);
  const theme = flags.theme || 'executive-ink';
  const slides = existing.map((slide) => ({ title: slide.title || 'Slide', body: slide.body }));
  slides.splice(index - 1, 0, { title: flags.title || 'New Slide', body: flags.body || '', notes: flags.notes || '' });
  await pptxCreateFromSpec(file, { theme, slides });
  return { ok: true, type: 'pptx', action: 'insert-slide', file, index, slides: slides.length, note: 'Deck was rebuilt from extracted slide text.' };
}

async function pptxUpdateSlide(file, flags) {
  const index = Number(flags.index ?? flags.slide);
  if (!Number.isInteger(index) || index < 1) throw new Error('--index must be a 1-based slide number');
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const theme = flags.theme || 'executive-ink';
  const slides = await readPptxSlides(file);
  if (index > slides.length) throw new Error(`Slide index out of range: deck has ${slides.length} slides`);
  const current = slides[index - 1];
  slides[index - 1] = {
    title: flags.title != null ? String(flags.title) : (current.title || 'Slide'),
    body: flags.body != null ? String(flags.body) : current.body,
    notes: flags.notes || '',
  };
  await pptxCreateFromSpec(file, { theme, slides });
  return { ok: true, type: 'pptx', action: 'update-slide', file, index, slides: slides.length, note: 'Deck was rebuilt from extracted slide text.' };
}

async function pptxDuplicateSlide(file, flags) {
  const index = Number(flags.index ?? flags.slide);
  if (!Number.isInteger(index) || index < 1) throw new Error('--index must be a 1-based slide number');
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const theme = flags.theme || 'executive-ink';
  const slides = await readPptxSlides(file);
  if (index > slides.length) throw new Error(`Slide index out of range: deck has ${slides.length} slides`);
  const to = flags.to == null ? index + 1 : Number(flags.to);
  if (!Number.isInteger(to) || to < 1 || to > slides.length + 1) throw new Error('--to must be between 1 and slide count + 1');
  const duplicate = { ...slides[index - 1] };
  slides.splice(to - 1, 0, duplicate);
  await pptxCreateFromSpec(file, { theme, slides });
  return { ok: true, type: 'pptx', action: 'duplicate-slide', file, index, to, slides: slides.length, note: 'Deck was rebuilt from extracted slide text.' };
}

async function pptxDeleteSlide(file, flags) {
  const index = Number(flags.index ?? flags.slide);
  if (!Number.isInteger(index) || index < 1) throw new Error('--index must be a 1-based slide number');
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const theme = flags.theme || 'executive-ink';
  const existing = await readPptxSlides(file);
  if (index > existing.length) return { ok: true, type: 'pptx', action: 'delete-slide', file, index, deleted: false, slides: existing.length };
  if (existing.length <= 1) throw new Error('Cannot delete the last slide');
  const slides = existing.filter((_, idx) => idx !== index - 1);
  await pptxCreateFromSpec(file, { theme, slides });
  return { ok: true, type: 'pptx', action: 'delete-slide', file, index, deleted: true, slides: slides.length, note: 'Deck was rebuilt from extracted slide text.' };
}

async function pptxMoveSlide(file, flags) {
  const from = Number(flags.from);
  const to = Number(flags.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) throw new Error('--from and --to must be 1-based slide numbers');
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const theme = flags.theme || 'executive-ink';
  const slides = await readPptxSlides(file);
  if (from > slides.length || to > slides.length) throw new Error(`Slide index out of range: deck has ${slides.length} slides`);
  const [slide] = slides.splice(from - 1, 1);
  slides.splice(to - 1, 0, slide);
  await pptxCreateFromSpec(file, { theme, slides });
  return { ok: true, type: 'pptx', action: 'move-slide', file, from, to, slides: slides.length, note: 'Deck was rebuilt from extracted slide text.' };
}

async function pptxReplaceText(file, flags) {
  if (!flags.from) throw new Error('--from is required');
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const from = String(flags.from);
  const to = String(flags.to ?? '');
  const theme = flags.theme || 'executive-ink';
  const existing = await readPptxSlides(file);
  let replacements = 0;
  const slides = existing.map((slide) => {
    const titleCount = slide.title.split(from).length - 1;
    const bodyCount = slide.body.split(from).length - 1;
    replacements += titleCount + bodyCount;
    return {
      title: slide.title.replaceAll(from, to),
      body: slide.body.replaceAll(from, to),
    };
  });
  if (replacements > 0) await pptxCreateFromSpec(file, { theme, slides });
  return { ok: true, type: 'pptx', action: 'replace-text', file, replacements, slides: slides.length };
}

async function pptxFromJson(file, flags) {
  if (!flags.json) throw new Error('--json is required');
  const spec = readJsonArg(flags.json);
  await pptxCreateFromSpec(file, spec);
  return { ok: true, type: 'pptx', action: 'from-json', file, slides: spec.slides?.length || 1 };
}

async function pptxToJson(file) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const slides = await readPptxSlides(file);
  return {
    ok: true,
    type: 'pptx',
    action: 'to-json',
    file,
    slides: slides.map((slide) => ({ title: slide.title, body: slide.body })),
  };
}

async function applyPatchOperation(file, patch) {
  const op = patch.op || patch.command || patch.action;
  if (!op) throw new Error('Each patch item needs op, command, or action');
  const flags = { ...patch };
  delete flags.op;
  delete flags.command;
  delete flags.action;
  if (op === 'docx:template') return docxTemplate(file, flags);
  if (op === 'docx:from-markdown') return docxFromMarkdown(file, flags);
  if (op === 'docx:from-json') return docxFromJson(file, { ...flags, json: JSON.stringify(flags.spec || flags.document || flags) });
  if (op === 'docx:append') return docxAppend(file, flags);
  if (op === 'docx:replace') return docxReplace(file, flags);
  if (op === 'xlsx:from-json') return xlsxFromJson(file, { ...flags, json: JSON.stringify(flags.workbook || (flags.sheets ? { sheets: flags.sheets } : (flags.rows || []))) });
  if (op === 'xlsx:add-sheet') return xlsxAddSheet(file, flags);
  if (op === 'xlsx:copy-sheet') return xlsxCopySheet(file, flags);
  if (op === 'xlsx:rename-sheet') return xlsxRenameSheet(file, flags);
  if (op === 'xlsx:delete-sheet') return xlsxDeleteSheet(file, flags);
  if (op === 'xlsx:set') return xlsxSet(file, flags);
  if (op === 'xlsx:range') return xlsxRange(file, { ...flags, json: JSON.stringify(flags.rows || flags.values || []) });
  if (op === 'xlsx:clear') return xlsxClear(file, flags);
  if (op === 'xlsx:bulk-set') return xlsxBulkSet(file, { ...flags, json: JSON.stringify(flags.patches || flags.cells || []) });
  if (op === 'xlsx:append-row') return xlsxAppendRow(file, { ...flags, json: JSON.stringify(flags.row || flags.values || []) });
  if (op === 'pptx:create') return pptxCreate(file, flags);
  if (op === 'pptx:append-slide') return pptxAppendSlide(file, flags);
  if (op === 'pptx:insert-slide') return pptxInsertSlide(file, flags);
  if (op === 'pptx:update-slide') return pptxUpdateSlide(file, flags);
  if (op === 'pptx:duplicate-slide') return pptxDuplicateSlide(file, flags);
  if (op === 'pptx:delete-slide') return pptxDeleteSlide(file, flags);
  if (op === 'pptx:move-slide') return pptxMoveSlide(file, flags);
  if (op === 'pptx:replace-text') return pptxReplaceText(file, flags);
  if (op === 'pptx:from-json') {
    const spec = flags.spec || flags.deck || { theme: flags.theme, slides: flags.slides || [] };
    await pptxCreateFromSpec(file, spec);
    return { ok: true, type: 'pptx', action: 'from-json', file, slides: spec.slides?.length || 1 };
  }
  throw new Error(`Unsupported apply operation: ${op}`);
}

async function officeApply(file, flags) {
  const patches = readJsonArg(flags.json);
  const operations = Array.isArray(patches) ? patches : patches.operations;
  if (!Array.isArray(operations)) throw new Error('--json must be an array or an object with operations[]');
  const results = [];
  for (const patch of operations) {
    results.push(await applyPatchOperation(file, patch));
  }
  return {
    ok: true,
    type: 'office-apply',
    action: 'apply',
    file,
    operations: results.length,
    results,
  };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, file, ...rest] = positional;
  if (!command || command === 'help' || command === 'api') {
    process.stdout.write(usage());
    return;
  }
  if (command === 'capabilities') {
    writeJson({ ok: true, type: 'office-capabilities', capabilities: OFFICE_CAPABILITIES });
    return;
  }
  if (command === 'agent-prompt') {
    process.stdout.write(agentPrompt([file, ...rest].filter(Boolean).join(' ')));
    return;
  }
  // This CLI rewrites the target file on disk with no coordination with the app
  // editor, which has no external-change watcher. If the same file is open in
  // BBARIT Office, this edit and a later editor save can silently overwrite each
  // other. Warn on stderr (stdout stays clean JSON) for file-mutating commands.
  const READONLY_COMMANDS = new Set([
    'inspect', 'xlsx:to-json', 'xlsx:formula-audit',
    'docx:search', 'docx:to-markdown', 'docx:to-json', 'docx:redline',
    'pptx:to-json',
  ]);
  if (file && command !== 'project:create' && !READONLY_COMMANDS.has(command)) {
    process.stderr.write(
      `warning: office-edit writes "${file}" directly on disk. If this file is open in ` +
      `BBARIT Office, close it (or reopen after this edit) — the editor has no external-change ` +
      `watcher, so unsaved editor changes and this edit can overwrite each other.\n`,
    );
  }
  let result;
  if (command === 'inspect') result = await inspectOffice(file);
  else if (command === 'project:create') result = await createOfficeProject(file, flags);
  else if (command === 'apply') result = await officeApply(file, flags);
  else if (command === 'xlsx:from-json') result = await xlsxFromJson(file, flags);
  else if (command === 'xlsx:add-sheet') result = await xlsxAddSheet(file, flags);
  else if (command === 'xlsx:copy-sheet') result = await xlsxCopySheet(file, flags);
  else if (command === 'xlsx:rename-sheet') result = await xlsxRenameSheet(file, flags);
  else if (command === 'xlsx:delete-sheet') result = await xlsxDeleteSheet(file, flags);
  else if (command === 'xlsx:set') result = await xlsxSet(file, flags);
  else if (command === 'xlsx:range') result = await xlsxRange(file, flags);
  else if (command === 'xlsx:clear') result = await xlsxClear(file, flags);
  else if (command === 'xlsx:bulk-set') result = await xlsxBulkSet(file, flags);
  else if (command === 'xlsx:append-row') result = await xlsxAppendRow(file, flags);
  else if (command === 'xlsx:to-json') result = await xlsxToJson(file, flags);
  else if (command === 'xlsx:formula-audit') result = await xlsxFormulaAudit(file, flags);
  else if (command === 'docx:template') result = await docxTemplate(file, flags);
  else if (command === 'docx:from-markdown') result = await docxFromMarkdown(file, flags);
  else if (command === 'docx:from-json') result = await docxFromJson(file, flags);
  else if (command === 'docx:append') result = await docxAppend(file, flags);
  else if (command === 'docx:replace') result = await docxReplace(file, flags);
  else if (command === 'docx:search') result = await docxSearch(file, flags);
  else if (command === 'docx:to-markdown') result = await docxToMarkdown(file);
  else if (command === 'docx:to-json') result = await docxToJson(file);
  else if (command === 'docx:redline') result = await docxRedline(file);
  else if (command === 'pptx:create') result = await pptxCreate(file, flags);
  else if (command === 'pptx:append-slide') result = await pptxAppendSlide(file, flags);
  else if (command === 'pptx:insert-slide') result = await pptxInsertSlide(file, flags);
  else if (command === 'pptx:update-slide') result = await pptxUpdateSlide(file, flags);
  else if (command === 'pptx:duplicate-slide') result = await pptxDuplicateSlide(file, flags);
  else if (command === 'pptx:delete-slide') result = await pptxDeleteSlide(file, flags);
  else if (command === 'pptx:move-slide') result = await pptxMoveSlide(file, flags);
  else if (command === 'pptx:replace-text') result = await pptxReplaceText(file, flags);
  else if (command === 'pptx:to-json') result = await pptxToJson(file);
  else if (command === 'pptx:from-json') result = await pptxFromJson(file, flags);
  else throw new Error(`Unknown command: ${command}`);
  writeJson(result);
}

main().catch((err) => {
  process.stderr.write(`office-edit failed: ${err.message}\n`);
  process.exit(1);
});
