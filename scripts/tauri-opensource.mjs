#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export const SOURCE_CONFIG = 'src-tauri/tauri.opensource.conf.json';
// Layered on top of the source config by `--fork-release`: this fork's own
// updater public key and GitHub release endpoint (never the original
// production ones). See README "포크 릴리스와 자동 업데이트".
export const FORK_RELEASE_CONFIG = 'src-tauri/tauri.fork.conf.json';
export const FORK_RELEASE_FLAG = '--fork-release';

const UPDATER_KEY_ENV = /^TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)?$/;

export function sourceBuildEnvironment(parentEnvironment, platform = process.platform, { forkRelease = false } = {}) {
  const environment = { ...parentEnvironment };
  for (const name of Object.keys(environment)) {
    // A fork release keeps only the updater signing key; Apple credentials,
    // Windows certificates and TAURI_CONFIG are always dropped.
    if (forkRelease && UPDATER_KEY_ENV.test(name)) continue;
    if (/^(APPLE_|TAURI_SIGNING_|WINDOWS_CERTIFICATE)/i.test(name) || name === 'TAURI_CONFIG') {
      delete environment[name];
    }
  }
  // Ad-hoc signing uses no Apple account or certificate. The explicit value
  // also prevents a developer's ambient identity from replacing the config.
  if (platform === 'darwin') environment.APPLE_SIGNING_IDENTITY = '-';
  return environment;
}

export function sourceTauriArguments(args) {
  const forkRelease = args.includes(FORK_RELEASE_FLAG);
  const [command = '--help', ...rest] = args.filter((arg) => arg !== FORK_RELEASE_FLAG);
  if (command === 'build' || command === 'dev') {
    if (rest.some((arg) => arg === '--config' || arg.startsWith('--config=') || /^-c/.test(arg))) {
      throw new Error('The source build uses tauri.opensource.conf.json. Edit that file instead of passing --config.');
    }
    const configs = ['--config', SOURCE_CONFIG];
    if (forkRelease) configs.push('--config', FORK_RELEASE_CONFIG);
    return [command, ...configs, ...rest];
  }
  if (forkRelease) throw new Error(`${FORK_RELEASE_FLAG} only applies to build or dev.`);
  if (['info', '--help', '-h', '--version', '-V'].includes(command)) return [command, ...rest];
  throw new Error('Use this source wrapper with dev, build, info, --help, or --version.');
}

export function checkForkReleaseEnvironment(environment, args) {
  if (!args.includes(FORK_RELEASE_FLAG) || !args.includes('build')) return;
  if (!environment.TAURI_SIGNING_PRIVATE_KEY) {
    throw new Error(
      'A fork release needs TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD if the key has one). ' +
        'Generate a key with `npx tauri signer generate -w ~/.tauri/bbarit-fork.key` and keep it out of Git.',
    );
  }
}

function main() {
  const cli = path.join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (!existsSync(cli)) throw new Error('Tauri CLI is missing. Run npm ci first.');
  const rawArgs = process.argv.slice(2);
  const forkRelease = rawArgs.includes(FORK_RELEASE_FLAG);
  const args = sourceTauriArguments(rawArgs);
  checkForkReleaseEnvironment(process.env, rawArgs);
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: sourceBuildEnvironment(process.env, process.platform, { forkRelease }),
    stdio: 'inherit',
  });
  child.once('error', (error) => {
    console.error(`Tauri failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
