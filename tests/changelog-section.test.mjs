import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractSection, normalizeVersion, releaseUnreleased } from '../scripts/changelog-section.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(repoRoot, 'scripts', 'changelog-section.mjs');
const bumpScript = path.join(repoRoot, 'scripts', 'bump-version.mjs');
const REPO = 'https://github.com/o/r';

const SAMPLE = `# 변경 이력

Intro text.

## [Unreleased]

### 추가

- 새 기능.

## [1.2.0] - 2026-11-07

### 변경

- 바뀐 점.

## [1.1.0] - 2026-10-20

### 수정

- 고친 점.

## [1.0.0] - 2026-10-01

[Unreleased]: ${REPO}/compare/v1.2.0...HEAD
[1.2.0]: ${REPO}/compare/v1.1.0...v1.2.0
[1.1.0]: ${REPO}/compare/v1.0.0...v1.1.0
[1.0.0]: ${REPO}/releases/tag/v1.0.0
`;

function tempFile(name, text) {
  const dir = mkdtempSync(path.join(tmpdir(), 'changelog-'));
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return { dir, file };
}

test('normalizeVersion strips a leading v', () => {
  assert.equal(normalizeVersion('v1.1.65'), '1.1.65');
  assert.equal(normalizeVersion(' 1.1.65 '), '1.1.65');
});

test('extractSection returns the body between two headings', () => {
  assert.equal(extractSection(SAMPLE, '1.2.0'), '### 변경\n\n- 바뀐 점.');
  assert.equal(extractSection(SAMPLE, 'v1.2.0'), '### 변경\n\n- 바뀐 점.');
});

test('the last section stops at the link definitions', () => {
  assert.equal(extractSection(SAMPLE, '1.1.0'), '### 수정\n\n- 고친 점.');
});

test('missing or empty sections return null', () => {
  assert.equal(extractSection(SAMPLE, '9.9.9'), null);
  assert.equal(extractSection(SAMPLE, '1.0.0'), null);
  // "1.2" must not match "1.2.0".
  assert.equal(extractSection(SAMPLE, '1.2'), null);
});

test('CRLF files are read the same way', () => {
  assert.equal(extractSection(SAMPLE.replace(/\n/g, '\r\n'), '1.2.0'), '### 변경\n\n- 바뀐 점.');
});

test('CLI prints the section and exits 0', () => {
  const { file } = tempFile('CHANGELOG.md', SAMPLE);
  const r = spawnSync(process.execPath, [script, '1.1.0', '--file', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '### 수정\n\n- 고친 점.\n');
});

test('CLI exits non-zero for a missing version or file', () => {
  const { file } = tempFile('CHANGELOG.md', SAMPLE);
  const missing = spawnSync(process.execPath, [script, '1.1.65', '--file', file], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /No CHANGELOG section for 1\.1\.65/);
  const noFile = spawnSync(process.execPath, [script, '1.1.0', '--file', file + '.nope'], { encoding: 'utf8' });
  assert.notEqual(noFile.status, 0);
  const noArgs = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.notEqual(noArgs.status, 0);
});

test('the repository CHANGELOG has a section for the current app version', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const text = readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  assert.ok(extractSection(text, pkg.version), `CHANGELOG.md has no [${pkg.version}] section`);
  assert.match(text, /^## \[Unreleased\]$/m);
  assert.match(text, new RegExp(`^\\[${pkg.version.replace(/\./g, '\\.')}\\]: https://`, 'm'));
});

test('releaseUnreleased moves the entries and updates the compare links', () => {
  const r = releaseUnreleased(SAMPLE, '1.3.0', '2026-12-01');
  assert.equal(r.changed, true);
  assert.equal(extractSection(r.text, 'Unreleased'), null);
  assert.equal(extractSection(r.text, '1.3.0'), '### 추가\n\n- 새 기능.');
  assert.match(r.text, /## \[Unreleased\]\n\n## \[1\.3\.0\] - 2026-12-01\n\n### 추가\n\n- 새 기능\.\n\n## \[1\.2\.0\] - 2026-11-07/);
  assert.match(r.text, new RegExp(`^\\[Unreleased\\]: ${REPO}/compare/v1\\.3\\.0\\.\\.\\.HEAD$`, 'm'));
  assert.match(r.text, new RegExp(`^\\[1\\.3\\.0\\]: ${REPO}/compare/v1\\.2\\.0\\.\\.\\.v1\\.3\\.0$`, 'm'));
  // Older sections and links are untouched.
  assert.equal(extractSection(r.text, '1.2.0'), extractSection(SAMPLE, '1.2.0'));
  assert.ok(r.text.includes(`[1.0.0]: ${REPO}/releases/tag/v1.0.0`));
});

test('releaseUnreleased leaves the text alone when there is nothing to move', () => {
  const once = releaseUnreleased(SAMPLE, '1.3.0', '2026-12-01').text;
  const again = releaseUnreleased(once, '1.3.0', '2026-12-02');
  assert.equal(again.changed, false);
  assert.equal(again.text, once);
  const empty = releaseUnreleased(once, '1.4.0', '2026-12-02');
  assert.equal(empty.changed, false);
  assert.match(empty.reason, /empty/);
  assert.equal(releaseUnreleased('# no sections\n', '1.0.0', '2026-12-02').changed, false);
  assert.throws(() => releaseUnreleased(SAMPLE, '1.3', '2026-12-01'), /Invalid version/);
  assert.throws(() => releaseUnreleased(SAMPLE, '1.3.0', '12/01/2026'), /Invalid date/);
});

test('releaseUnreleased keeps CRLF line endings', () => {
  const r = releaseUnreleased(SAMPLE.replace(/\n/g, '\r\n'), '1.3.0', '2026-12-01');
  assert.equal(r.changed, true);
  assert.ok(!/[^\r]\n/.test(r.text), 'found a bare LF');
});

function fakeRepo(changelog) {
  const root = mkdtempSync(path.join(tmpdir(), 'bump-'));
  mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  const json = (p, v) => writeFileSync(path.join(root, p), JSON.stringify({ version: v }, null, 2) + '\n');
  json('package.json', '1.2.0');
  json('src-tauri/tauri.conf.json', '1.2.0');
  json('src-tauri/tauri.macos.conf.json', '1.2.0');
  json('src-tauri/tauri.windows.conf.json', '1.2.0');
  writeFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "x"\nversion = "1.2.0"\n');
  if (changelog !== undefined) writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);
  return root;
}

function bump(root, args) {
  return spawnSync(process.execPath, [bumpScript, ...args], { cwd: root, encoding: 'utf8' });
}

test('bump-version moves [Unreleased] into the new version section', () => {
  const root = fakeRepo(SAMPLE);
  const r = bump(root, ['1.3.0', '--date', '2026-12-01']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CHANGELOG\.md: \[Unreleased\] -> \[1\.3\.0\]/);
  const text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.equal(extractSection(text, '1.3.0'), '### 추가\n\n- 새 기능.');
  assert.match(text, /^## \[1\.3\.0\] - 2026-12-01$/m);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '1.3.0');
});

test('bump-version warns but still bumps when [Unreleased] is empty', () => {
  const emptied = releaseUnreleased(SAMPLE, '1.3.0', '2026-12-01').text;
  const root = fakeRepo(emptied);
  const r = bump(root, ['1.4.0', '--date', '2026-12-02']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /CHANGELOG\.md: not changed \(\[Unreleased\] is empty\)/);
  assert.equal(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), emptied);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '1.4.0');
});

test('bump-version --no-changelog and platform-only bumps leave CHANGELOG.md alone', () => {
  for (const args of [['1.3.0', '--no-changelog'], ['--mac', '1.3.0']]) {
    const root = fakeRepo(SAMPLE);
    const r = bump(root, args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), SAMPLE);
  }
});

test('bump-version rejects a bad --date before touching any file', () => {
  const root = fakeRepo(SAMPLE);
  const r = bump(root, ['1.3.0', '--date', 'tomorrow']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Invalid --date/);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '1.2.0');
});

test('bump-version works without a CHANGELOG.md', () => {
  const root = fakeRepo();
  const r = bump(root, ['1.3.0']);
  assert.equal(r.status, 0, r.stderr);
});
