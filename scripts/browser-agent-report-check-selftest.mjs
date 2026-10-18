#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tmpDir = resolve(repoRoot, '.octo-tmp/browser-agent-report-check-selftest');
const checker = resolve(repoRoot, 'scripts/browser-agent-report-check.mjs');
const requiredControlSteps = [
  'open-browser',
  'load-page',
  'visual-screenshot',
  'find-input',
  'type-input',
  'find-submit-or-enter',
  'submit-search',
  'history-back',
  'history-forward',
  'find-external-link',
  'external-link-open',
];

function baseReport(platform, engine, { skipBuild = false } = {}) {
  const steps = [
    { name: 'browser verify (platform + WebView control + Naver control audit)', exitCode: 0, elapsedMs: 1 },
    { name: 'bbarit-agent browser unit tests', exitCode: 0, elapsedMs: 1 },
    { name: 'browser integration vitest', exitCode: 0, elapsedMs: 1 },
  ];
  if (!skipBuild) {
    steps.push({ name: 'frontend build', exitCode: 0, elapsedMs: 1 });
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: {
      gitHead: '0123456789abcdef0123456789abcdef01234567',
      gitBranch: 'main',
      gitDirty: true,
      gitStatusShort: [],
    },
    project: {
      packageName: 'octo-ui',
      packageVersion: '1.1.5',
      tauriIdentifier: 'com.octo.terminal',
      tauriProductName: 'BBARIT Terminal',
      tauriVersion: '1.1.5',
      frontend: {
        devUrl: 'http://127.0.0.1:5175',
        frontendDist: '../dist',
        macOverridesBuild: false,
        windowsOverridesBuild: false,
      },
      nativeEngines: {
        macos: 'wkwebview',
        windows: 'webview2',
        linux: 'webkitgtk',
      },
      windowsBundle: {
        webviewInstallMode: { type: 'downloadBootstrapper' },
        targets: ['nsis', 'msi'],
        updaterEndpoint: 'https://github.com/bbarit/terminal-win/releases/latest/download/latest.json',
      },
      macosBundle: {
        targets: ['app', 'dmg'],
        updaterEndpoint: 'https://github.com/bbarit/terminal/releases/latest/download/latest.json',
      },
    },
    verificationScope: {
      browser: ['platform audit', 'WebView control assert', 'Naver real-site control audit'],
      agent: ['bbarit-agent browser routing unit tests', 'browser integration Vitest'],
      build: skipBuild ? 'skipped by --skip-build' : 'frontend build',
    },
    platform: {
      nodePlatform: platform,
      expectedNativeEngine: engine,
      startedTauriDevPid: null,
    },
    steps,
    artifacts: {
      platformAudit: {
        ok: true,
        checks: [
          {
            name: 'Windows WebView2 runtime is available when running on Windows',
            ok: platform !== 'win32',
            applicable: platform === 'win32',
            found: false,
            evidence: [],
          },
        ],
      },
      browserAssert: { ok: true },
      controlAudit: {
        ok: true,
        targetUrl: 'https://www.naver.com',
        session: 'browser-control-audit',
        steps: requiredControlSteps.map((name) => ({
          name,
          ok: true,
          ...(name === 'external-link-open' ? {
            sessionOk: true,
            expectedSession: 'browser-control-audit',
            checkedSessionTabs: [{ url: 'https://www.naver.com/', active: true, sessionId: 'browser-control-audit' }],
            activeTab: { url: 'https://www.naver.com/', active: true, sessionId: 'browser-control-audit' },
            newTabs: [{ url: 'https://www.naver.com/', active: true, sessionId: 'browser-control-audit' }],
          } : {}),
        })),
      },
    },
  };
}

function writeReport(name, report) {
  const path = resolve(tmpDir, name);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

function runCase(name, args, shouldPass) {
  const result = spawnSync(process.execPath, [checker, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const passed = result.status === 0;
  if (passed !== shouldPass) {
    console.error(JSON.stringify({
      ok: false,
      case: name,
      expectedPass: shouldPass,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ case: name, ok: true, expectedPass: shouldPass }));
}

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const mac = baseReport('darwin', 'wkwebview');
const macSkipBuild = baseReport('darwin', 'wkwebview', { skipBuild: true });
const winMissingWebView2 = baseReport('win32', 'webview2');
const winOk = baseReport('win32', 'webview2');
const winDifferentGit = baseReport('win32', 'webview2');
const macMissingControlStep = baseReport('darwin', 'wkwebview');
const macMissingSessionEvidence = baseReport('darwin', 'wkwebview');
const macWrongControlTarget = baseReport('darwin', 'wkwebview');

const webviewCheck = winOk.artifacts.platformAudit.checks[0];
Object.assign(webviewCheck, {
  ok: true,
  applicable: true,
  found: true,
  evidence: [{ type: 'file', path: 'C:/Program Files (x86)/Microsoft/EdgeWebView/Application/1/msedgewebview2.exe' }],
});
const webviewDifferentGit = winDifferentGit.artifacts.platformAudit.checks[0];
Object.assign(webviewDifferentGit, {
  ok: true,
  applicable: true,
  found: true,
  evidence: [{ type: 'file', path: 'C:/Program Files (x86)/Microsoft/EdgeWebView/Application/1/msedgewebview2.exe' }],
});
winDifferentGit.source.gitHead = 'fedcba9876543210fedcba9876543210fedcba98';
macMissingControlStep.artifacts.controlAudit.steps = macMissingControlStep.artifacts.controlAudit.steps
  .filter((step) => step.name !== 'external-link-open');
const missingSessionExternal = macMissingSessionEvidence.artifacts.controlAudit.steps
  .find((step) => step.name === 'external-link-open');
missingSessionExternal.expectedSession = 'browser-control-audit';
missingSessionExternal.checkedSessionTabs = [{ url: 'https://www.naver.com/', active: true }];
missingSessionExternal.activeTab = { url: 'https://www.naver.com/', active: true };
missingSessionExternal.newTabs = [{ url: 'https://www.naver.com/', active: true }];
macWrongControlTarget.artifacts.controlAudit.targetUrl = 'https://example.com';

const macPath = writeReport('mac.json', mac);
const macSkipBuildPath = writeReport('mac-skip-build.json', macSkipBuild);
const winMissingPath = writeReport('win-missing-webview2.json', winMissingWebView2);
const winOkPath = writeReport('win-ok.json', winOk);
const winDifferentGitPath = writeReport('win-different-git.json', winDifferentGit);
const macMissingControlStepPath = writeReport('mac-missing-control-step.json', macMissingControlStep);
const macMissingSessionEvidencePath = writeReport('mac-missing-session-evidence.json', macMissingSessionEvidence);
const macWrongControlTargetPath = writeReport('mac-wrong-control-target.json', macWrongControlTarget);

runCase('valid mac report passes', ['--file', macPath, '--platform', 'darwin'], true);
runCase('mac skip-build report fails without explicit allowance', ['--file', macSkipBuildPath, '--platform', 'darwin'], false);
runCase('mac skip-build report passes with explicit allowance', ['--file', macSkipBuildPath, '--platform', 'darwin', '--allow-skip-build'], true);
runCase('windows report without WebView2 runtime fails', ['--file', winMissingPath, '--platform', 'win32'], false);
runCase('mac report missing external link audit fails', ['--file', macMissingControlStepPath, '--platform', 'darwin'], false);
runCase('mac report missing explicit tab session evidence fails', ['--file', macMissingSessionEvidencePath, '--platform', 'darwin'], false);
runCase('mac report using non-Naver control target fails', ['--file', macWrongControlTargetPath, '--platform', 'darwin'], false);
runCase('mac/windows comparison passes with same source', ['--file', macPath, '--platform', 'darwin', '--compare', winOkPath, '--compare-platform', 'win32'], true);
runCase('mac/windows comparison fails on git mismatch', ['--file', macPath, '--platform', 'darwin', '--compare', winDifferentGitPath, '--compare-platform', 'win32'], false);

console.log(JSON.stringify({ ok: true, selftest: 'browser-agent-report-check' }));
