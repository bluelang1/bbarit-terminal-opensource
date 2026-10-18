#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export function sourceBuildEnvironment(parentEnvironment, platform = process.platform) {
  const environment = { ...parentEnvironment };
  for (const name of Object.keys(environment)) {
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
  const [command = '--help', ...rest] = args;
  if (command === 'build' || command === 'dev') {
    if (rest.some((arg) => arg === '--config' || arg.startsWith('--config=') || /^-c/.test(arg))) {
      throw new Error('The source build uses tauri.opensource.conf.json. Edit that file instead of passing --config.');
    }
    return [command, '--config', 'src-tauri/tauri.opensource.conf.json', ...rest];
  }
  if (['info', '--help', '-h', '--version', '-V'].includes(command)) return [command, ...rest];
  throw new Error('Use this source wrapper with dev, build, info, --help, or --version.');
}

function main() {
  const cli = path.join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (!existsSync(cli)) throw new Error('Tauri CLI is missing. Run npm ci first.');
  const args = sourceTauriArguments(process.argv.slice(2));
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: sourceBuildEnvironment(process.env),
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
