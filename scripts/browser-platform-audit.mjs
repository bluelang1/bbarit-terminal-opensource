#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);

function readArg(name, fallback = '') {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

function read(rel) {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function includesAll(text, needles) {
  return needles.filter((needle) => !text.includes(needle));
}

function check(name, ok, details = {}) {
  return { name, ok: Boolean(ok), ...details };
}

function walkFiles(relDir, out = []) {
  const absDir = join(repoRoot, relDir);
  for (const child of readdirSync(absDir)) {
    const abs = join(absDir, child);
    const rel = join(relDir, child).replaceAll('\\', '/');
    let stats;
    try {
      stats = statSync(abs);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      walkFiles(rel, out);
    } else if (stats.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function queryWindowsWebView2Runtime() {
  if (process.platform !== 'win32') {
    return { applicable: false, found: null, evidence: [] };
  }

  const evidence = [];
  const applicationRoots = [
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft', 'EdgeWebView', 'Application'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Microsoft', 'EdgeWebView', 'Application'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'EdgeWebView', 'Application'),
  ].filter(Boolean);

  for (const root of applicationRoots) {
    const direct = join(root, 'msedgewebview2.exe');
    if (existsSync(direct)) evidence.push({ type: 'file', path: direct });
    if (!existsSync(root)) continue;
    for (const child of readdirSync(root)) {
      const dir = join(root, child);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const versioned = join(dir, 'msedgewebview2.exe');
      if (existsSync(versioned)) evidence.push({ type: 'file', path: versioned });
    }
  }

  const regQueries = [
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients', '/s', '/f', 'WebView2'],
    ['query', 'HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients', '/s', '/f', 'WebView2'],
    ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients', '/s', '/f', 'WebView2'],
  ];
  for (const query of regQueries) {
    const result = spawnSync('reg.exe', query, { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0 && /WebView2/i.test(result.stdout || '')) {
      evidence.push({
        type: 'registry',
        key: query[1],
        match: (result.stdout || '').split(/\r?\n/).find((line) => /WebView2/i.test(line))?.trim() || 'WebView2',
      });
    }
  }

  return { applicable: true, found: evidence.length > 0, evidence };
}

function main() {
  const pkg = readJson('package.json');
  const tauriBase = readJson('src-tauri/tauri.conf.json');
  const tauriMac = readJson('src-tauri/tauri.macos.conf.json');
  const tauriWindows = readJson('src-tauri/tauri.windows.conf.json');
  const browserPage = read('src/pages/BrowserPage.tsx');
  const browserCli = read('agent-browser-cli/bin/bbarit-browser-control.mjs');
  const agentBrowser = read('bbarit-agent/src/browser.rs');
  const nativeWebview = read('src-tauri/src/webview_browser.rs');
  const cliDocs = read('agent-browser-cli/CLI.md');
  const commonVerifier = read('scripts/browser-agent-verify.mjs');
  const reportChecker = read('scripts/browser-agent-report-check.mjs');
  const reportCheckerSelfTest = read('scripts/browser-agent-report-check-selftest.mjs');
  const windowsVerifier = read('scripts/windows/browser-agent-verify.ps1');
  const releaseWin = read('scripts/release-win.sh');
  const browserSourceFiles = walkFiles('src')
    .filter((file) => /(^|\/)BrowserPage\.(tsx|ts|jsx|js)$/.test(file)
      || /(^|\/)BrowserPage\.(macos|darwin|windows|win32|linux)\./i.test(file)
      || /(^|\/)webview_browser\.(macos|darwin|windows|win32|linux)\./i.test(file));

  const checks = [];

  checks.push(check(
    'package exposes one browser verification gate',
    pkg.scripts?.['browser:platform-audit']?.includes('scripts/browser-platform-audit.mjs')
      && pkg.scripts?.['browser:ai-audit']?.includes('scripts/browser-ai-capability-audit.mjs')
      && pkg.scripts?.['browser-agent:verify']?.includes('scripts/browser-agent-verify.mjs')
      && pkg.scripts?.['browser-agent:report-check']?.includes('scripts/browser-agent-report-check.mjs')
      && pkg.scripts?.['browser-agent:report-check:self-test']?.includes('scripts/browser-agent-report-check-selftest.mjs')
      && pkg.scripts?.['browser-agent:compare-reports']?.includes('--compare-platform win32')
      && pkg.scripts?.['platform:verify']?.includes('scripts/platform-full-verify.mjs')
      && pkg.scripts?.['mac:verify']?.includes('--require-platform darwin')
      && pkg.scripts?.['win:verify']?.includes('--require-platform win32')
      && pkg.scripts?.['mac:browser-agent:verify']?.includes('scripts/browser-agent-verify.mjs')
      && pkg.scripts?.['win:browser-agent:verify']?.includes('scripts/browser-agent-verify.mjs')
      && pkg.scripts?.['browser:assert']?.includes('--file .octo-tmp/browser-assert.json')
      && pkg.scripts?.['browser:control-audit']?.includes('control-audit --url https://www.naver.com')
      && pkg.scripts?.['browser:verify'] === 'npm run browser:ai-audit && npm run browser:platform-audit && npm run browser:assert && npm run browser:control-audit',
    { verify: pkg.scripts?.['browser:verify'] || null },
  ));

  checks.push(check(
    'browser UI reports native engine per platform',
    includesAll(browserPage, [
      'const nativeWebviewEngineLabel = () =>',
      "return 'webview2';",
      "return 'wkwebview';",
      "return 'webkitgtk';",
      'browserEngine: nativeWebviewEngineLabel()',
    ]).length === 0 && !browserPage.includes("browserEngine: 'webview2'"),
  ));

  checks.push(check(
    'macOS and Windows use the same browser source and frontend entry',
    browserSourceFiles.length === 1
      && browserSourceFiles[0] === 'src/pages/BrowserPage.tsx'
      && tauriBase.build?.devUrl === 'http://127.0.0.1:5175'
      && tauriBase.build?.frontendDist === '../dist'
      && !tauriMac.build
      && !tauriWindows.build
      && !tauriMac.app
      && !tauriWindows.app,
    {
      browserSourceFiles,
      baseDevUrl: tauriBase.build?.devUrl || null,
      baseFrontendDist: tauriBase.build?.frontendDist || null,
      macOverridesBuild: Boolean(tauriMac.build),
      windowsOverridesBuild: Boolean(tauriWindows.build),
      macOverridesApp: Boolean(tauriMac.app),
      windowsOverridesApp: Boolean(tauriWindows.app),
    },
  ));

  checks.push(check(
    'Windows bundle ensures WebView2 is installed for native browser control',
    tauriWindows.bundle?.windows?.webviewInstallMode?.type === 'downloadBootstrapper'
      && Array.isArray(tauriWindows.bundle?.targets)
      && tauriWindows.bundle.targets.includes('nsis')
      && tauriWindows.bundle.targets.includes('msi'),
    {
      webviewInstallMode: tauriWindows.bundle?.windows?.webviewInstallMode || null,
      targets: tauriWindows.bundle?.targets || [],
    },
  ));

  checks.push(check(
    'browser tabs keep CLI sessions stable',
    includesAll(browserPage, [
      "const initialSessionId = params.get('session') || undefined;",
      'newTab: async (url = DEFAULT_BROWSER_URL, sessionId?: string)',
      'const activeSessionId = sessionId || cefTabsRef.current.find((t) => t.id === cefActiveIdRef.current)?.sessionId;',
      'cefOpenTab(target, activeSessionId || undefined)',
      'pendingOpen?.sessionId',
      't.sessionId === sid && t.id === cefActiveIdRef.current',
    ]).length === 0,
  ));

  checks.push(check(
    'browser history keeps local WebView entries across back and forward',
    includesAll(browserPage, [
      'pendingCefHistoryNavRef',
      "withCefHistory(t, eventUrl, 'index', pendingHistoryNav.index)",
      'pendingCefHistoryNavRef.current.delete(id)',
    ]).length === 0,
  ));

  checks.push(check(
    'native WebView catches external links and popups',
    includesAll(nativeWebview, [
      'link_bridge_script',
      'bbarit-popup://open?url=',
      '.on_new_window',
      'NewWindowResponse::Deny',
      '.add_child(',
      'PageLoadEvent::Started',
    ]).length === 0,
  ));

  checks.push(check(
    'browser CLI is Windows path safe',
    browserCli.includes("import { fileURLToPath } from 'node:url';")
      && browserCli.includes("resolve(fileURLToPath(new URL('../..', import.meta.url)))")
      && !/new\s+URL\([^)]*\)\.pathname/.test(browserCli)
      && !browserCli.includes('process.env.TERM_SESSION_ID'),
  ));

  checks.push(check(
    'agent browser bridge is Windows path and session safe',
    includesAll(agentBrowser, [
      'fn strip_extended_length_prefix(path: &str) -> String',
      'extended_length_prefix_is_stripped_for_node',
      'fn browser_session_from_values',
      'browser_session_prefers_explicit_agent_ids',
      'browser_session_falls_back_to_stable_process_scope',
      'fn find_browser_cli_from',
      'browser_cli_is_found_by_walking_ancestors',
    ]).length === 0
      && !agentBrowser.includes('"--chrome".into()')
      && !agentBrowser.includes("'--chrome'"),
  ));

  checks.push(check(
    'browser CLI docs describe the same macOS/Windows gate',
    includesAll(cliDocs, [
      'Tauri WebView/WebView2',
      'Windows에서는 WebView2',
      'macOS에서는 WKWebView',
      'npm run browser:verify',
      'control-audit',
    ]).length === 0,
  ));

  checks.push(check(
    'macOS and Windows expose one-click browser and BBARIT agent verification',
    pkg.scripts?.['browser-agent:verify'] === 'node scripts/browser-agent-verify.mjs'
      && pkg.scripts?.['browser-agent:report-check'] === 'node scripts/browser-agent-report-check.mjs'
      && pkg.scripts?.['browser-agent:report-check:self-test'] === 'node scripts/browser-agent-report-check-selftest.mjs'
      && pkg.scripts?.['browser-agent:compare-reports']?.includes('.octo-tmp/mac-browser-agent-verify.json')
      && pkg.scripts?.['browser-agent:compare-reports']?.includes('.octo-tmp/win-browser-agent-verify.json')
      && pkg.scripts?.['browser-agent:compare-reports']?.includes('--compare-platform win32')
      && pkg.scripts?.['platform:verify'] === 'node scripts/platform-full-verify.mjs'
      && pkg.scripts?.['mac:verify']?.includes('.octo-tmp/mac-full-verify.json')
      && pkg.scripts?.['win:verify']?.includes('.octo-tmp/win-full-verify.json')
      && pkg.scripts?.['mac:browser-agent:verify']?.includes('--require-platform darwin')
      && pkg.scripts?.['mac:browser-agent:verify']?.includes('.octo-tmp/mac-browser-agent-verify.json')
      && pkg.scripts?.['mac:browser-agent:report-check']?.includes('--platform darwin')
      && pkg.scripts?.['mac:browser-agent:report-check']?.includes('--allow-skip-build')
      && pkg.scripts?.['win:browser-agent:verify']?.includes('--require-platform win32')
      && pkg.scripts?.['win:browser-agent:verify']?.includes('.octo-tmp/win-browser-agent-verify.json')
      && pkg.scripts?.['win:browser-agent:report-check']?.includes('--platform win32')
      && !pkg.scripts?.['win:browser-agent:report-check']?.includes('--allow-skip-build')
      && includesAll(commonVerifier, [
        'ensureTauriDev',
        'sourceSnapshot',
        'projectConfigSnapshot',
        'verificationScope',
        'checkGeneratedReport',
        'generated browser-agent report check',
        "['run', 'browser:verify']",
        "'cargo', ['test', '--manifest-path', 'bbarit-agent/Cargo.toml', 'browser']",
        'src/pages/browserAppIntegration.test.ts',
        'src/pages/browserDiagnostics.test.ts',
        'expectedNativeEngine',
        'webviewInstallMode',
        'gitDirty',
      ]).length === 0
      && includesAll(reportChecker, [
        'validateReport',
        'compareReports',
        'comparePlatform',
        'buildStepCheck',
        'allowSkipBuild',
        'REQUIRED_CONTROL_AUDIT_STEPS',
        'controlAuditStepCheck',
        'REQUIRED_CONTROL_AUDIT_TARGET_HOST',
        'REQUIRED_CONTROL_AUDIT_SESSION',
        'external-link-open',
        'explicitSessionEvidenceOk',
        'Windows runtime WebView2 check found runtime',
        'Windows bundle guarantees WebView2 bootstrapper',
        'reports use same git head',
      ]).length === 0
      && includesAll(reportCheckerSelfTest, [
        'windows report without WebView2 runtime fails',
        'mac skip-build report fails without explicit allowance',
        'mac skip-build report passes with explicit allowance',
        'mac report missing external link audit fails',
        'mac report missing explicit tab session evidence fails',
        'mac report using non-Naver control target fails',
        'mac/windows comparison fails on git mismatch',
        'valid mac report passes',
        'mac/windows comparison passes with same source',
      ]).length === 0,
    {
      common: pkg.scripts?.['browser-agent:verify'] || null,
      reportCheck: pkg.scripts?.['browser-agent:report-check'] || null,
      mac: pkg.scripts?.['mac:browser-agent:verify'] || null,
      windows: pkg.scripts?.['win:browser-agent:verify'] || null,
    },
  ));

  checks.push(check(
    'Windows PowerShell verifier remains available for native Windows shells',
    pkg.scripts?.['win:browser-agent:verify:ps1']?.includes('scripts/windows/browser-agent-verify.ps1')
      && includesAll(windowsVerifier, [
        'scripts/browser-agent-verify.mjs',
        '--require-platform", "win32"',
        '--report", $ReportPath',
        '--startup-timeout-seconds", "$StartupTimeoutSeconds"',
        '--skip-build',
        'This verifier must be run on Windows',
      ]).length === 0,
  ));

  checks.push(check(
    'Windows release requires a browser and BBARIT agent verification report',
    includesAll(releaseWin, [
      'WIN_BROWSER_AGENT_REPORT',
      '.octo-tmp/win-browser-agent-verify.json',
      'release-files-win/win-browser-agent-verify.json',
      'npm run win:browser-agent:verify',
      'scripts/browser-agent-report-check.mjs',
      '--platform win32',
    ]).length === 0,
  ));

  const webview2Runtime = queryWindowsWebView2Runtime();
  checks.push(check(
    'Windows WebView2 runtime is available when running on Windows',
    !webview2Runtime.applicable || webview2Runtime.found,
    webview2Runtime,
  ));

  const platformHints = {
    nodePlatform: process.platform,
    expectedNativeEngine:
      process.platform === 'win32' ? 'webview2'
        : process.platform === 'darwin' ? 'wkwebview'
          : process.platform === 'linux' ? 'webkitgtk'
            : 'tauri-webview',
    webview2RuntimeCheck:
      process.platform === 'win32'
        ? (webview2Runtime.found ? 'found' : 'missing')
        : 'not-applicable-on-this-platform',
  };

  const report = {
    ok: checks.every((item) => item.ok),
    generatedAt: new Date().toISOString(),
    platform: platformHints,
    checks,
  };

  const file = readArg('--file', '');
  if (file) {
    const out = resolve(repoRoot, file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const report = { ok: false, error: message };
  const file = readArg('--file', '');
  if (file) {
    const out = resolve(repoRoot, file);
    if (existsSync(dirname(out)) || dirname(out)) mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
