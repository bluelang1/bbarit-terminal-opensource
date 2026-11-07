#!/usr/bin/env node
/**
 * Read and update CHANGELOG.md (Keep a Changelog layout).
 *
 * Usage:
 *   node scripts/changelog-section.mjs 1.1.65            # print the body of "## [1.1.65] - …"
 *   node scripts/changelog-section.mjs v1.1.65 --file path/to/CHANGELOG.md
 *
 * Exits 1 when the version has no section or the section is empty, so the
 * release workflow can fall back to the install guide + generated notes.
 *
 * bump-version.mjs uses releaseUnreleased() to move the [Unreleased] entries
 * into a new "## [X.Y.Z] - YYYY-MM-DD" section and fix the compare links.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADING = /^## \[([^\]]+)\]/;
const LINK_DEF = /^\[([^\]]+)\]:\s*(\S+)\s*$/;

export function normalizeVersion(input) {
  return String(input ?? '').trim().replace(/^v/, '');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Index range [start, end) of the lines belonging to `## [name]`, or null. */
function sectionRange(lines, name) {
  const start = lines.findIndex((line) => {
    const m = line.match(HEADING);
    return m && m[1].toLowerCase() === name.toLowerCase();
  });
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i]) || LINK_DEF.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function trimBlankLines(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === '') a++;
  while (b > a && lines[b - 1].trim() === '') b--;
  return lines.slice(a, b);
}

/** Body of a version's section (without its heading), or null if missing/empty. */
export function extractSection(text, version) {
  const lines = String(text).split(/\r?\n/);
  const range = sectionRange(lines, normalizeVersion(version));
  if (!range) return null;
  const body = trimBlankLines(lines.slice(range.start + 1, range.end));
  return body.length ? body.join('\n') : null;
}

/**
 * Move the [Unreleased] entries into "## [version] - date" and update the
 * compare links. Returns { text, changed, reason }; text is unchanged when
 * the version already has a section or [Unreleased] is missing or empty.
 */
export function releaseUnreleased(text, version, date) {
  const v = normalizeVersion(version);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)) throw new Error(`Invalid version: ${version}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text).split(/\r?\n/);
  if (sectionRange(lines, v)) return { text, changed: false, reason: `[${v}] already exists` };
  const range = sectionRange(lines, 'Unreleased');
  if (!range) return { text, changed: false, reason: 'no [Unreleased] section' };
  const body = trimBlankLines(lines.slice(range.start + 1, range.end));
  if (!body.length) return { text, changed: false, reason: '[Unreleased] is empty' };

  const out = [
    ...lines.slice(0, range.start + 1),
    '',
    `## [${v}] - ${date}`,
    '',
    ...body,
    '',
    ...lines.slice(range.end),
  ];

  // [Unreleased]: …/compare/vPREV...HEAD  ->  …/compare/vX.Y.Z...HEAD
  // and a new [X.Y.Z]: …/compare/vPREV...vX.Y.Z right below it.
  const linkIdx = out.findIndex((line) => /^\[Unreleased\]:/i.test(line));
  if (linkIdx !== -1) {
    const url = out[linkIdx].match(LINK_DEF)?.[2] ?? '';
    const m = url.match(/^(.*\/compare\/)(\S+?)\.\.\.HEAD$/);
    if (m) {
      const [, base, prev] = m;
      const prefix = prev.startsWith('v') ? 'v' : '';
      out[linkIdx] = `[Unreleased]: ${base}${prefix}${v}...HEAD`;
      const already = out.some((line) => new RegExp(`^\\[${escapeRegExp(v)}\\]:`).test(line));
      if (!already) out.splice(linkIdx + 1, 0, `[${v}]: ${base}${prev}...${prefix}${v}`);
    }
  }

  return { text: out.join(eol), changed: true, reason: '' };
}

function parseArgs(argv) {
  const out = { version: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') out.file = argv[++i];
    else if (!a.startsWith('--') && out.version === null) out.version = a;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) {
    console.error('Usage: node scripts/changelog-section.mjs <X.Y.Z> [--file CHANGELOG.md]');
    process.exit(2);
  }
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const file = path.resolve(args.file ?? path.join(repoRoot, 'CHANGELOG.md'));
  if (!fs.existsSync(file)) {
    console.error(`Missing changelog: ${file}`);
    process.exit(1);
  }
  const body = extractSection(fs.readFileSync(file, 'utf8'), args.version);
  if (body === null) {
    console.error(`No CHANGELOG section for ${normalizeVersion(args.version)} in ${file}`);
    process.exit(1);
  }
  process.stdout.write(body + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
