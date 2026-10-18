#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertWindowsArm64BuildPrereqs,
  windowsRustTarget,
  windowsVsArchForTarget,
  windowsVsDevCmdPath,
  windowsVsHostArch,
} from './windows-msvc-prereq.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);

function argValue(name, fallback = '') {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function writeWindowsCmdScript(name, lines) {
  const tmpDir = resolve(repoRoot, '.octo-tmp');
  mkdirSync(tmpDir, { recursive: true });
  const scriptPath = resolve(tmpDir, `${name}.cmd`);
  writeFileSync(scriptPath, [`@echo off`, ...lines, ''].join('\r\n'), 'utf8');
  return scriptPath;
}

function commandForStep(command, commandArgs) {
  if (process.platform === 'win32' && /\.cmd$/i.test(command)) {
    return { command, args: commandArgs, shell: true, display: [command, ...commandArgs].join(' ') };
  }
  if (process.platform !== 'win32' || command !== 'cargo') {
    return { command, args: commandArgs, display: [command, ...commandArgs].join(' ') };
  }
  const vsDevCmd = windowsVsDevCmdPath();
  if (!vsDevCmd) {
    return { command, args: commandArgs, display: [command, ...commandArgs].join(' ') };
  }
  const target = windowsRustTarget();
  const arch = windowsVsArchForTarget(target);
  const hostArch = windowsVsHostArch();
  const manifestIdx = commandArgs.indexOf('--manifest-path');
  const manifestPath = manifestIdx >= 0 ? commandArgs[manifestIdx + 1] : '';
  const cargoCwd = manifestPath ? dirname(resolve(repoRoot, manifestPath)) : repoRoot;
  const cargoArgs = manifestPath
    ? commandArgs.map((arg, idx) => (idx === manifestIdx + 1 ? 'Cargo.toml' : arg))
    : commandArgs;
  const argsWithTarget = target && !cargoArgs.includes('--target')
    ? [...cargoArgs, '--target', target]
    : cargoArgs;
  const cargoCommand = [command, ...argsWithTarget].map(cmdQuote).join(' ');
  const scriptPath = writeWindowsCmdScript('platform-full-vsdev-cargo', [
    `call ${cmdQuote(vsDevCmd)} -arch=${arch} -host_arch=${hostArch}`,
    'if errorlevel 1 exit /b %errorlevel%',
    `cd /d ${cmdQuote(cargoCwd)}`,
    cargoCommand,
  ]);
  return { command: 'cmd.exe', args: ['/d', '/c', scriptPath], display: `${vsDevCmd} && ${cargoCommand}` };
}

function platformLabel() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  return process.platform;
}

function readJson(relPath) {
  const fullPath = resolve(repoRoot, relPath);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function gitValue(gitArgs) {
  const result = spawnSync('git', gitArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function sourceSnapshot() {
  const status = gitValue(['status', '--short']);
  return {
    gitHead: gitValue(['rev-parse', 'HEAD']),
    gitBranch: gitValue(['branch', '--show-current']),
    gitDirty: Boolean(status),
    gitStatusShort: status ? status.split(/\r?\n/).slice(0, 120) : [],
  };
}

function runStep(name, command, commandArgs) {
  const started = Date.now();
  console.log(`==> ${name}`);
  const prepared = commandForStep(command, commandArgs);
  const result = spawnSync(prepared.command, prepared.args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: prepared.shell || false,
  });
  const step = {
    name,
    command: prepared.display,
    exitCode: result.status ?? 1,
    elapsedMs: Date.now() - started,
  };
  if (step.exitCode !== 0) {
    const error = result.error instanceof Error ? ` (${result.error.message})` : '';
    throw Object.assign(new Error(`${name} failed with exit code ${step.exitCode}${error}`), { step });
  }
  return step;
}

function reportPathForPlatform() {
  return `.octo-tmp/${platformLabel()}-full-verify.json`;
}

function browserReportPathForPlatform() {
  return `.octo-tmp/${platformLabel()}-browser-agent-verify.json`;
}

function browserVerifyScriptForPlatform() {
  if (process.platform === 'darwin') return 'mac:browser-agent:verify';
  if (process.platform === 'win32') return 'win:browser-agent:verify';
  return 'browser-agent:verify';
}

function writeReport(path, report) {
  const fullPath = resolve(repoRoot, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(report, null, 2)}\n`);
  return fullPath;
}

function makeReport(ok, steps, error = null) {
  const browserReportPath = browserReportPathForPlatform();
  return {
    ok,
    generatedAt: new Date().toISOString(),
    platform: {
      nodePlatform: process.platform,
      label: platformLabel(),
    },
    source: sourceSnapshot(),
    requiredScope: [
      'BBARIT Browser and BBARIT agent end-to-end verification',
      'Naver real-site browser control audit',
      'frontend lint',
      'terminal-focused Vitest tests',
      'Office CLI smoke test',
      'all Vitest tests',
      'UI mojibake check',
      'app bootstrap smoke test',
      'bbarit-agent Rust tests',
      'Tauri Rust tests',
    ],
    steps,
    artifacts: {
      browserAgentReportPath: browserReportPath,
      browserAgentReport: readJson(browserReportPath),
    },
    ...(error ? { error } : {}),
  };
}

async function main() {
  const requiredPlatform = argValue('--require-platform', '');
  if (requiredPlatform && process.platform !== requiredPlatform) {
    throw new Error(`This verifier must be run on ${requiredPlatform}; current platform is ${process.platform}.`);
  }

  const reportPath = argValue('--report', reportPathForPlatform());
  const steps = [];
  try {
    assertWindowsArm64BuildPrereqs({
      context: 'Windows ARM64 full verification',
      rerunCommand: 'npm run win:verify',
    });
    steps.push(runStep('browser and BBARIT agent end-to-end verification', npmCommand(), ['run', browserVerifyScriptForPlatform()]));
    steps.push(runStep('frontend lint', npmCommand(), ['run', 'lint']));
    steps.push(runStep('bundled resource script import check', npmCommand(), ['run', 'check:bundled-scripts']));
    steps.push(runStep('terminal-focused Vitest tests', npmCommand(), [
      'run',
      'test:run',
      '--',
      'src/terminal/agentReadiness.test.ts',
      'src/terminal/cliCommandArgs.test.ts',
      'src/terminal/restoredPty.test.ts',
      'src/terminal/terminalLayoutEqualize.test.ts',
    ]));
    steps.push(runStep('Office CLI smoke test', npmCommand(), ['run', 'office:cli-smoke']));
    steps.push(runStep('all Vitest tests', npmCommand(), ['run', 'test:run']));
    steps.push(runStep('UI mojibake check', npmCommand(), ['run', 'ui:mojibake']));
    steps.push(runStep('app bootstrap smoke test', npmCommand(), ['run', 'app:bootstrap-smoke']));
    steps.push(runStep('bbarit-agent Rust tests', 'cargo', ['test', '--manifest-path', 'bbarit-agent/Cargo.toml']));
    steps.push(runStep('Tauri Rust tests', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml']));

    const out = writeReport(reportPath, makeReport(true, steps));
    console.log(`Full platform verification passed. Report: ${out}`);
  } catch (error) {
    if (error?.step) steps.push(error.step);
    const out = writeReport(reportPath, makeReport(false, steps, error instanceof Error ? error.message : String(error)));
    console.error(`Full platform verification failed. Report: ${out}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
