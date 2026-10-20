import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assetFileName,
  findUpdaterArtifact,
  mergeManifest,
  parseArgs,
  platformKey,
  prepareRelease,
  releaseAssetUrl,
  tagMatchesVersion,
} from '../scripts/fork-release-manifest.mjs';

function fakeRepo({ version = '1.1.51', signed = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'fork-release-'));
  mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  writeFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: '0.0.0' }));
  writeFileSync(path.join(root, 'src-tauri', 'tauri.macos.conf.json'), JSON.stringify({ version }));
  const bundle = path.join(root, 'src-tauri', 'target', 'release', 'bundle');
  mkdirSync(path.join(bundle, 'macos'), { recursive: true });
  mkdirSync(path.join(bundle, 'dmg'), { recursive: true });
  writeFileSync(path.join(bundle, 'macos', 'BBARIT Terminal Source.app.tar.gz'), 'archive');
  if (signed) writeFileSync(path.join(bundle, 'macos', 'BBARIT Terminal Source.app.tar.gz.sig'), 'signature-text\n');
  writeFileSync(path.join(bundle, 'dmg', `BBARIT Terminal Source_${version}_aarch64.dmg`), 'dmg');
  return root;
}

test('asset names and URLs never contain spaces', () => {
  assert.equal(assetFileName('BBARIT Terminal Source.app.tar.gz'), 'BBARIT-Terminal-Source.app.tar.gz');
  assert.equal(
    releaseAssetUrl('bluelang1/bbarit-terminal-opensource', 'v1.1.51', 'BBARIT Terminal Source.app.tar.gz'),
    'https://github.com/bluelang1/bbarit-terminal-opensource/releases/download/v1.1.51/BBARIT-Terminal-Source.app.tar.gz',
  );
});

test('platform keys follow the Tauri updater naming', () => {
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-aarch64');
  assert.equal(platformKey('darwin', 'x64'), 'darwin-x86_64');
  assert.equal(platformKey('win32', 'x64'), 'windows-x86_64');
  assert.throws(() => platformKey('freebsd', 'x64'));
});

test('the release tag must equal v<version>', () => {
  assert.equal(tagMatchesVersion('v1.1.51', '1.1.51'), true);
  assert.equal(tagMatchesVersion('1.1.51', '1.1.51'), false);
  assert.equal(tagMatchesVersion('v1.1.52', '1.1.51'), false);
});

test('argument parsing requires tag and repo', () => {
  assert.deepEqual(parseArgs(['--tag', 'v1.1.51', '--repo', 'a/b']), {
    tag: 'v1.1.51', repo: 'a/b', out: 'release-out', bundleDir: 'src-tauri/target/release/bundle', notes: null, merge: null,
  });
  assert.throws(() => parseArgs(['--tag', 'v1.1.51']));
  assert.throws(() => parseArgs(['--tag', 'v1.1.51', '--repo', 'a/b', '--bogus']));
});

test('an unsigned bundle is rejected', () => {
  const root = fakeRepo({ signed: false });
  assert.throws(
    () => findUpdaterArtifact(path.join(root, 'src-tauri', 'target', 'release', 'bundle'), 'darwin'),
    /signature is missing/,
  );
});

test('prepareRelease copies renamed assets and writes latest.json', () => {
  const root = fakeRepo();
  const now = new Date('2026-10-20T05:00:00.000Z');
  const result = prepareRelease(
    { tag: 'v1.1.51', repo: 'bluelang1/bbarit-terminal-opensource', out: 'release-out', bundleDir: 'src-tauri/target/release/bundle', notes: null, merge: null },
    { root, platform: 'darwin', arch: 'arm64', now },
  );
  assert.equal(result.version, '1.1.51');
  const names = result.files.map((file) => path.basename(file)).sort();
  assert.deepEqual(names, [
    'BBARIT-Terminal-Source.app.tar.gz',
    'BBARIT-Terminal-Source.app.tar.gz.sig',
    'BBARIT-Terminal-Source_1.1.51_aarch64.dmg',
    'latest.json',
  ]);
  const manifest = JSON.parse(readFileSync(path.join(root, 'release-out', 'latest.json'), 'utf8'));
  assert.deepEqual(manifest, {
    version: '1.1.51',
    notes: 'BBARIT Terminal Source v1.1.51',
    pub_date: '2026-10-20T05:00:00.000Z',
    platforms: {
      'darwin-aarch64': {
        signature: 'signature-text',
        url: 'https://github.com/bluelang1/bbarit-terminal-opensource/releases/download/v1.1.51/BBARIT-Terminal-Source.app.tar.gz',
      },
    },
  });
});

test('prepareRelease refuses a tag that does not match the app version', () => {
  const root = fakeRepo({ version: '1.1.51' });
  assert.throws(
    () => prepareRelease(
      { tag: 'v9.9.9', repo: 'a/b', out: 'release-out', bundleDir: 'src-tauri/target/release/bundle', notes: null, merge: null },
      { root, platform: 'darwin', arch: 'arm64' },
    ),
    /does not match/,
  );
});

test('manifests for other platforms merge without losing entries', () => {
  const mac = { version: '1.1.51', notes: 'n', pub_date: 'd', platforms: { 'darwin-aarch64': { signature: 's', url: 'u' } } };
  const win = { version: '1.1.51', notes: 'n', pub_date: 'd2', platforms: { 'windows-x86_64': { signature: 's2', url: 'u2' } } };
  assert.deepEqual(Object.keys(mergeManifest(mac, win).platforms), ['darwin-aarch64', 'windows-x86_64']);
  assert.throws(() => mergeManifest(mac, { ...win, version: '1.1.52' }));
});
