#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const targets = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const roots = targets.length ? targets : ['src'];
const allowedExtensions = new Set(['.css', '.js', '.jsx', '.ts', '.tsx']);
const ignoredDirs = new Set(['.git', '.octo-tmp', 'dist', 'node_modules', 'src-tauri', 'target']);

const patterns = [
  { name: 'replacement-character', regex: /\uFFFD/u },
  { name: 'c1-control-byte', regex: /[\u0080-\u009F]/u },
  { name: 'question-hangul-fragment', regex: /\?[\u3130-\u318F\uAC00-\uD7A3]{2,}/u },
  { name: 'cjk-hangul-adjacent', regex: /(?:[\u4E00-\u9FFF][\u3130-\u318F\uAC00-\uD7A3]{1,5}|[\u3130-\u318F\uAC00-\uD7A3]{1,5}[\u4E00-\u9FFF])/u },
  { name: 'latin-hangul-latin-fragment', regex: /[A-Za-z][\u3130-\u318F\uAC00-\uD7A3][A-Za-z]/u },
];

const allowedFindings = new Set([
  // Intentional CJK Unicode range used to choose EPUB cover wrapping rules.
  'src/utils/mdToEpub.ts:cjk-hangul-adjacent:const isCjk = /[぀-ヿ㐀-鿿가-힯]/.test(cleanTitle);',
]);

function walk(entry, files = []) {
  const abs = path.resolve(repoRoot, entry);
  if (!existsSync(abs)) return files;
  const stat = statSync(abs);
  if (stat.isDirectory()) {
    const name = path.basename(abs);
    if (ignoredDirs.has(name)) return files;
    for (const child of readdirSync(abs)) {
      walk(path.join(abs, child), files);
    }
    return files;
  }
  if (stat.isFile() && allowedExtensions.has(path.extname(abs))) {
    files.push(abs);
  }
  return files;
}

function lineAndColumn(text, index) {
  const before = text.slice(0, index);
  const line = before.split(/\r?\n/).length;
  const lineStart = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1;
  return { line, column: index - lineStart + 1 };
}

const findings = [];
for (const root of roots) {
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      const match = pattern.regex.exec(text);
      if (!match) continue;
      const index = match.index;
      const { line, column } = lineAndColumn(text, index);
      const lineText = text.split(/\r?\n/)[line - 1] || '';
      const findingKey = [
        path.relative(repoRoot, file).replace(/\\/g, '/'),
        pattern.name,
        lineText.trim(),
      ].join(':');
      if (allowedFindings.has(findingKey)) continue;
      findings.push({
        file: path.relative(repoRoot, file).replace(/\\/g, '/'),
        line,
        column,
        pattern: pattern.name,
        sample: lineText.trim().slice(0, 180),
      });
    }
  }
}

if (findings.length) {
  console.error('[ui:mojibake] Found suspicious mojibake-like text:');
  for (const finding of findings.slice(0, 80)) {
    console.error(`${finding.file}:${finding.line}:${finding.column} ${finding.pattern} ${finding.sample}`);
  }
  if (findings.length > 80) {
    console.error(`[ui:mojibake] ...and ${findings.length - 80} more`);
  }
  process.exitCode = 1;
} else {
  console.log(`[ui:mojibake] ok (${roots.join(', ')})`);
}
