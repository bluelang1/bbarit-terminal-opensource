import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkForkReleaseEnvironment, sourceBuildEnvironment, sourceTauriArguments } from '../scripts/tauri-opensource.mjs';

test('source config replaces the production updater and signing settings', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.opensource.conf.json', import.meta.url), 'utf8'));
  assert.equal(config.identifier, 'com.bbarit.terminal.source');
  assert.deepEqual(config.plugins.updater.endpoints, []);
  assert.equal(config.plugins.updater.pubkey, '');
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(config.bundle.macOS.signingIdentity, '-');
  assert.equal(config.bundle.macOS.providerShortName, null);
  assert.equal(config.bundle.windows.signCommand, null);
});

test('source override keeps both platform versions and clears inherited production endpoints', () => {
  function mergePatch(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete target[key];
      else if (typeof value === 'object' && !Array.isArray(value)) {
        target[key] = mergePatch(target[key] && typeof target[key] === 'object' ? target[key] : {}, value);
      } else target[key] = value;
    }
    return target;
  }
  const read = (name) => JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), 'utf8'));
  for (const platform of ['macos', 'windows']) {
    const config = mergePatch(mergePatch(read('tauri.conf.json'), read(`tauri.${platform}.conf.json`)), read('tauri.opensource.conf.json'));
    assert.equal(config.version, read(`tauri.${platform}.conf.json`).version);
    assert.deepEqual(config.plugins.updater.endpoints, []);
    assert.equal(config.plugins.updater.pubkey, '');
    assert.equal(config.bundle.createUpdaterArtifacts, false);
    assert.equal(config.bundle.macOS.signingIdentity, '-');
    assert.equal(config.bundle.macOS.providerShortName, undefined);
  }
});

test('native commands always apply the source override', () => {
  assert.deepEqual(sourceTauriArguments(['build', '--debug', '--no-bundle']), [
    'build', '--config', 'src-tauri/tauri.opensource.conf.json', '--debug', '--no-bundle',
  ]);
  assert.deepEqual(sourceTauriArguments(['dev']), ['dev', '--config', 'src-tauri/tauri.opensource.conf.json']);
  assert.deepEqual(sourceTauriArguments(['dev', '--', '--example-app-argument']), [
    'dev', '--config', 'src-tauri/tauri.opensource.conf.json', '--', '--example-app-argument',
  ]);
  assert.deepEqual(sourceTauriArguments(['info']), ['info']);
  assert.throws(() => sourceTauriArguments(['build', '--config', 'production.json']));
  assert.throws(() => sourceTauriArguments(['build', '-cproduction.json']));
  assert.throws(() => sourceTauriArguments(['bundle']));
});

test('source builds do not inherit release signing or notarization credentials', () => {
  const parent = {
    PATH: '/toolchain',
    APPLE_ID: 'test-account',
    APPLE_API_KEY_PATH: '/example/key',
    APPLE_SIGNING_IDENTITY: 'Example Developer ID',
    TAURI_SIGNING_PRIVATE_KEY: 'test-only-placeholder',
    WINDOWS_CERTIFICATE_PASSWORD: 'test-only-placeholder',
    TAURI_CONFIG: '{"identifier":"example.production"}',
    USER_CHOSEN_AI_KEY: 'keep-local-provider-setting',
  };
  assert.deepEqual(sourceBuildEnvironment(parent, 'darwin'), {
    PATH: '/toolchain',
    USER_CHOSEN_AI_KEY: 'keep-local-provider-setting',
    APPLE_SIGNING_IDENTITY: '-',
  });
  assert.deepEqual(sourceBuildEnvironment(parent, 'win32'), {
    PATH: '/toolchain',
    USER_CHOSEN_AI_KEY: 'keep-local-provider-setting',
  });
  assert.equal(parent.APPLE_ID, 'test-account');
});

test('fork releases layer the fork updater config on top of the source config', () => {
  assert.deepEqual(sourceTauriArguments(['build', '--fork-release']), [
    'build', '--config', 'src-tauri/tauri.opensource.conf.json', '--config', 'src-tauri/tauri.fork.conf.json',
  ]);
  assert.deepEqual(sourceTauriArguments(['build', '--fork-release', '--no-bundle']), [
    'build', '--config', 'src-tauri/tauri.opensource.conf.json', '--config', 'src-tauri/tauri.fork.conf.json', '--no-bundle',
  ]);
  assert.throws(() => sourceTauriArguments(['info', '--fork-release']));
  assert.throws(() => sourceTauriArguments(['build', '--fork-release', '--config', 'x.json']));
});

test('fork config carries only this fork\'s updater key and GitHub endpoint', () => {
  const fork = JSON.parse(readFileSync(new URL('../src-tauri/tauri.fork.conf.json', import.meta.url), 'utf8'));
  const production = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(fork).sort(), ['$schema', 'bundle', 'plugins']);
  assert.equal(fork.bundle.createUpdaterArtifacts, true);
  assert.equal(fork.identifier, undefined, 'identifier stays com.bbarit.terminal.source from the source config');
  assert.notEqual(fork.plugins.updater.pubkey, production.plugins.updater.pubkey);
  assert.match(fork.plugins.updater.pubkey, /^[A-Za-z0-9+/=]{100,}$/);
  assert.deepEqual(fork.plugins.updater.endpoints, [
    'https://github.com/bluelang1/bbarit-terminal-opensource/releases/latest/download/latest.json',
  ]);
});

test('fork releases keep only the updater signing key in the environment', () => {
  const parent = {
    PATH: '/toolchain',
    APPLE_ID: 'test-account',
    APPLE_SIGNING_IDENTITY: 'Example Developer ID',
    TAURI_SIGNING_PRIVATE_KEY: 'test-only-placeholder',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'test-only-placeholder',
    TAURI_SIGNING_OTHER: 'dropped',
    WINDOWS_CERTIFICATE_PASSWORD: 'test-only-placeholder',
    TAURI_CONFIG: '{"identifier":"example.production"}',
  };
  assert.deepEqual(sourceBuildEnvironment(parent, 'darwin', { forkRelease: true }), {
    PATH: '/toolchain',
    TAURI_SIGNING_PRIVATE_KEY: 'test-only-placeholder',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'test-only-placeholder',
    APPLE_SIGNING_IDENTITY: '-',
  });
  assert.deepEqual(sourceBuildEnvironment(parent, 'darwin'), { PATH: '/toolchain', APPLE_SIGNING_IDENTITY: '-' });
  assert.throws(() => checkForkReleaseEnvironment({}, ['build', '--fork-release']), /TAURI_SIGNING_PRIVATE_KEY/);
  assert.doesNotThrow(() => checkForkReleaseEnvironment({ TAURI_SIGNING_PRIVATE_KEY: 'k' }, ['build', '--fork-release']));
  assert.doesNotThrow(() => checkForkReleaseEnvironment({}, ['build']));
  assert.doesNotThrow(() => checkForkReleaseEnvironment({}, ['dev', '--fork-release']));
});
