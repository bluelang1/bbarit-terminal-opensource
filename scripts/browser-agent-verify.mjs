#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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
const tauriCliJsCandidates = [
  resolve(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js'),
  resolve(repoRoot, 'node_modules/.pnpm/@tauri-apps+cli@2.11.1/node_modules/@tauri-apps/cli/tauri.js'),
];
const tauriCliJs = tauriCliJsCandidates.find((candidate) => existsSync(candidate));

function argValue(name, fallback = '') {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

function hasArg(name) {
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
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
  const argsWithTarget = target && !commandArgs.includes('--target')
    ? [...commandArgs, '--target', target]
    : commandArgs;
  const cargoCommand = [command, ...argsWithTarget].map(cmdQuote).join(' ');
  const scriptPath = writeWindowsCmdScript('browser-agent-vsdev-cargo', [
    `call ${cmdQuote(vsDevCmd)} -arch=${arch} -host_arch=${hostArch}`,
    'if errorlevel 1 exit /b %errorlevel%',
    `cd /d ${cmdQuote(repoRoot)}`,
    cargoCommand,
  ]);
  return { command: 'cmd.exe', args: ['/d', '/c', scriptPath], display: `${vsDevCmd} && ${cargoCommand}` };
}

function commandForWindowsVsDevStep(command, commandArgs) {
  if (process.platform !== 'win32') {
    return commandForStep(command, commandArgs);
  }
  const vsDevCmd = windowsVsDevCmdPath();
  if (!vsDevCmd) {
    return commandForStep(command, commandArgs);
  }
  const target = windowsRustTarget();
  const arch = windowsVsArchForTarget(target);
  const hostArch = windowsVsHostArch();
  let argsWithTarget = target && tauriCliJs && command === process.execPath && !commandArgs.includes('--target')
    ? [...commandArgs, '--target', target]
    : commandArgs;
  // Verification does not need Rust hot reload, and Tauri's watcher can panic
  // when the checkout lives on a Parallels/shared mapped drive because no
  // watchable local folder is produced. Keep normal `tauri:dev` unchanged and
  // disable watching only for the verifier-owned Windows process.
  if (tauriCliJs && command === process.execPath && !argsWithTarget.includes('--no-watch')) {
    argsWithTarget = [...argsWithTarget, '--no-watch'];
  }
  const nestedCommand = [command, ...argsWithTarget].map(cmdQuote).join(' ');
  const scriptPath = writeWindowsCmdScript('browser-agent-vsdev-tauri-dev', [
    `call ${cmdQuote(vsDevCmd)} -arch=${arch} -host_arch=${hostArch}`,
    'if errorlevel 1 exit /b %errorlevel%',
    `cd /d ${cmdQuote(repoRoot)}`,
    nestedCommand,
  ]);
  return { command: 'cmd.exe', args: ['/d', '/c', scriptPath], display: `${vsDevCmd} && ${nestedCommand}` };
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
  const elapsedMs = Date.now() - started;
  const exitCode = result.status ?? 1;
  const step = {
    name,
    command: prepared.display,
    exitCode,
    elapsedMs,
  };
  if (exitCode !== 0) {
    const error = result.error instanceof Error ? ` (${result.error.message})` : '';
    throw Object.assign(new Error(`${name} failed with exit code ${exitCode}${error}`), { step });
  }
  return step;
}

function devScreenReachable() {
  const result = spawnSync(process.execPath, [
    resolve(repoRoot, 'scripts/tauri-dev-screen.mjs'),
    'status',
    '--timeout-ms',
    '6000',
  ], {
    cwd: repoRoot,
    stdio: 'ignore',
    shell: false,
    timeout: 9000,
    killSignal: 'SIGKILL',
  });
  return result.status === 0;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function ensureTauriDev(timeoutMs) {
  if (devScreenReachable()) {
    console.log('tauri:dev is already reachable.');
    return null;
  }

  const tmpDir = resolve(repoRoot, '.octo-tmp');
  mkdirSync(tmpDir, { recursive: true });
  const logPath = resolve(tmpDir, `${process.platform}-tauri-dev.log`);
  writeFileSync(logPath, '', 'utf8');
  const logFd = openLog(logPath);
  const command = tauriCliJs ? process.execPath : npmCommand();
  const commandArgs = tauriCliJs ? [tauriCliJs, 'dev'] : ['run', 'tauri:dev'];
  const prepared = commandForWindowsVsDevStep(command, commandArgs);
  const child = spawn(prepared.command, prepared.args, {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    shell: prepared.shell || false,
  });
  child.unref();
  console.log(`Starting ${prepared.display} in background. Log: ${logPath}`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (devScreenReachable()) {
      console.log('tauri:dev is reachable.');
      return child.pid ?? null;
    }
    if (child.exitCode !== null) {
      throw new Error(`tauri:dev exited before dev:screen became reachable. See ${logPath}`);
    }
  }

  throw new Error(`Timed out waiting for tauri:dev after ${Math.round(timeoutMs / 1000)} seconds. See ${logPath}`);
}

function openLog(logPath) {
  return openSync(logPath, 'a');
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

function gitValue(argsForGit) {
  const result = spawnSync('git', argsForGit, {
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
    gitStatusShort: status ? status.split(/\r?\n/).slice(0, 80) : [],
  };
}

function projectConfigSnapshot() {
  const pkg = readJson('package.json') || {};
  const tauriBase = readJson('src-tauri/tauri.conf.json') || {};
  const tauriMac = readJson('src-tauri/tauri.macos.conf.json') || {};
  const tauriWindows = readJson('src-tauri/tauri.windows.conf.json') || {};
  return {
    packageName: pkg.name || null,
    packageVersion: pkg.version || null,
    tauriIdentifier: tauriBase.identifier || null,
    tauriProductName: tauriBase.productName || null,
    tauriVersion: tauriBase.version || null,
    frontend: {
      devUrl: tauriBase.build?.devUrl || null,
      frontendDist: tauriBase.build?.frontendDist || null,
      macOverridesBuild: Boolean(tauriMac.build),
      windowsOverridesBuild: Boolean(tauriWindows.build),
    },
    nativeEngines: {
      macos: 'wkwebview',
      windows: 'webview2',
      linux: 'webkitgtk',
    },
    windowsBundle: {
      webviewInstallMode: tauriWindows.bundle?.windows?.webviewInstallMode || null,
      targets: tauriWindows.bundle?.targets || [],
      updaterEndpoint: tauriWindows.plugins?.updater?.endpoints?.[0] || null,
    },
    macosBundle: {
      targets: tauriMac.bundle?.targets || [],
      updaterEndpoint: tauriMac.plugins?.updater?.endpoints?.[0] || null,
    },
  };
}

function verificationScope(skipBuild) {
  return {
    browser: [
      'platform audit',
      'WebView control assert',
      'Naver real-site control audit',
    ],
    agent: [
      'bbarit-agent browser routing unit tests',
      'browser integration Vitest',
    ],
    build: skipBuild ? 'skipped by --skip-build' : 'frontend build',
  };
}

function writeReport(reportPath, report) {
  const fullPath = resolve(repoRoot, reportPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(report, null, 2)}\n`);
  return fullPath;
}

function checkGeneratedReport(reportPath, skipBuild) {
  const argsForCheck = [
    resolve(repoRoot, 'scripts/browser-agent-report-check.mjs'),
    '--file',
    reportPath,
    '--platform',
    process.platform,
  ];
  if (skipBuild) {
    argsForCheck.push('--allow-skip-build');
  }
  return runStep('generated browser-agent report check', process.execPath, argsForCheck);
}

async function main() {
  const requiredPlatform = argValue('--require-platform', '');
  if (requiredPlatform && process.platform !== requiredPlatform) {
    throw new Error(`This verifier must be run on ${requiredPlatform}; current platform is ${process.platform}.`);
  }

  const skipBuild = hasArg('--skip-build');
  const timeoutSeconds = Number(argValue('--startup-timeout-seconds', '120'));
  const reportPath = argValue(
    '--report',
    `.octo-tmp/${process.platform === 'darwin' ? 'mac' : process.platform}-browser-agent-verify.json`,
  );

  const steps = [];
  let startedTauriDevPid = null;
  let report;
  try {
    assertWindowsArm64BuildPrereqs({
      context: 'Windows ARM64 GUI verification',
      rerunCommand: 'npm run win:browser-agent:verify',
    });
    startedTauriDevPid = await ensureTauriDev(timeoutSeconds * 1000);
    steps.push(runStep('browser verify (platform + WebView control + Naver control audit)', npmCommand(), ['run', 'browser:verify']));
    steps.push(runStep('bbarit-agent browser unit tests', 'cargo', ['test', '--manifest-path', 'bbarit-agent/Cargo.toml', 'browser']));
    steps.push(runStep('browser integration vitest', npmCommand(), [
      'run',
      'test:run',
      '--',
      'src/pages/browserAppIntegration.test.ts',
      'src/pages/browserDiagnostics.test.ts',
    ]));
    if (!skipBuild) {
      steps.push(runStep('frontend build', npmCommand(), ['run', 'build']));
    }

    report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      source: sourceSnapshot(),
      project: projectConfigSnapshot(),
      verificationScope: verificationScope(skipBuild),
      platform: {
        nodePlatform: process.platform,
        expectedNativeEngine:
          process.platform === 'win32' ? 'webview2'
            : process.platform === 'darwin' ? 'wkwebview'
              : process.platform === 'linux' ? 'webkitgtk'
                : 'tauri-webview',
        startedTauriDevPid,
      },
      steps,
      artifacts: {
        platformAudit: readJson('.octo-tmp/browser-platform-audit.json'),
        browserAssert: readJson('.octo-tmp/browser-assert.json'),
        controlAudit: readJson('.octo-tmp/browser-control-audit.json'),
      },
    };
  } catch (error) {
    if (error?.step) steps.push(error.step);
    report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      source: sourceSnapshot(),
      project: projectConfigSnapshot(),
      verificationScope: verificationScope(skipBuild),
      platform: {
        nodePlatform: process.platform,
        startedTauriDevPid,
      },
      error: error instanceof Error ? error.message : String(error),
      steps,
      artifacts: {
        platformAudit: readJson('.octo-tmp/browser-platform-audit.json'),
        browserAssert: readJson('.octo-tmp/browser-assert.json'),
        controlAudit: readJson('.octo-tmp/browser-control-audit.json'),
      },
    };
  }

  const out = writeReport(reportPath, report);
  console.log(`Report: ${out}`);
  if (!report.ok) process.exit(1);
  checkGeneratedReport(out, skipBuild);
  console.log('Browser + BBARIT agent verification passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
