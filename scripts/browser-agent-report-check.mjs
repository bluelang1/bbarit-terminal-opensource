#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);

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

function readJson(path) {
  const fullPath = resolve(repoRoot, path);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing report: ${fullPath}`);
  }
  return JSON.parse(readFileSync(fullPath, 'utf8'));
}

function fail(name, details = {}) {
  return { name, ok: false, ...details };
}

function pass(name, details = {}) {
  return { name, ok: true, ...details };
}

function expectedEngine(platform) {
  if (platform === 'win32') return 'webview2';
  if (platform === 'darwin') return 'wkwebview';
  if (platform === 'linux') return 'webkitgtk';
  return 'tauri-webview';
}

const REQUIRED_CONTROL_AUDIT_STEPS = [
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
const REQUIRED_CONTROL_AUDIT_TARGET_HOST = 'www.naver.com';
const REQUIRED_CONTROL_AUDIT_SESSION = 'browser-control-audit';

function controlAuditStepCheck(controlAudit) {
  const steps = Array.isArray(controlAudit?.steps) ? controlAudit.steps : [];
  const byName = new Map(steps.map((step) => [step?.name, step]));
  const targetHost = (() => {
    try {
      return new URL(String(controlAudit?.targetUrl || '')).host;
    } catch {
      return '';
    }
  })();
  const targetOk = targetHost === REQUIRED_CONTROL_AUDIT_TARGET_HOST;
  const auditSession = typeof controlAudit?.session === 'string' ? controlAudit.session : '';
  const auditSessionOk = auditSession === REQUIRED_CONTROL_AUDIT_SESSION;
  const missing = REQUIRED_CONTROL_AUDIT_STEPS.filter((name) => !byName.has(name));
  const failed = REQUIRED_CONTROL_AUDIT_STEPS
    .map((name) => byName.get(name))
    .filter((step) => step && step.ok !== true)
    .map((step) => ({ name: step.name, ok: step.ok }));
  const external = byName.get('external-link-open');
  const externalSessionOk = external?.sessionOk === true;
  const expectedSession = typeof external?.expectedSession === 'string' && external.expectedSession
    ? external.expectedSession
    : null;
  const expectedSessionOk = expectedSession === REQUIRED_CONTROL_AUDIT_SESSION;
  const checkedSessionTabs = Array.isArray(external?.checkedSessionTabs)
    ? external.checkedSessionTabs
    : [external?.activeTab, ...(Array.isArray(external?.newTabs) ? external.newTabs : [])].filter(Boolean);
  const explicitSessionEvidenceOk = expectedSessionOk
    && checkedSessionTabs.length > 0
    && checkedSessionTabs.every((tab) => tab?.sessionId === REQUIRED_CONTROL_AUDIT_SESSION);
  return {
    ok: targetOk && auditSessionOk && missing.length === 0 && failed.length === 0 && externalSessionOk && explicitSessionEvidenceOk,
    targetHost,
    targetOk,
    auditSession,
    auditSessionOk,
    missing,
    failed,
    externalSessionOk,
    expectedSession,
    expectedSessionOk,
    explicitSessionEvidenceOk,
    checkedSessionTabs,
    observed: steps.map((step) => step?.name).filter(Boolean),
  };
}

function buildStepCheck(report, allowSkipBuild) {
  const steps = Array.isArray(report.steps) ? report.steps : [];
  const frontendBuild = steps.find((step) => step?.name === 'frontend build');
  const skipped = report.verificationScope?.build === 'skipped by --skip-build';
  if (frontendBuild?.exitCode === 0) {
    return { ok: true, mode: 'build', step: frontendBuild.name };
  }
  if (skipped && allowSkipBuild) {
    return { ok: true, mode: 'skipped-with-explicit-allowance' };
  }
  return {
    ok: false,
    mode: skipped ? 'skipped-without-allowance' : 'missing-or-failed',
    buildScope: report.verificationScope?.build || null,
    frontendBuild: frontendBuild || null,
  };
}

function validateReport(report, platform, options = {}) {
  const allowSkipBuild = options.allowSkipBuild === true;
  const checks = [];
  checks.push(report.ok === true ? pass('report ok is true') : fail('report ok is true', { value: report.ok }));
  checks.push(
    report.platform?.nodePlatform === platform
      ? pass('report platform matches expected platform', { platform })
      : fail('report platform matches expected platform', { expected: platform, actual: report.platform?.nodePlatform }),
  );
  checks.push(
    report.platform?.expectedNativeEngine === expectedEngine(platform)
      ? pass('native engine matches platform', { engine: report.platform?.expectedNativeEngine })
      : fail('native engine matches platform', { expected: expectedEngine(platform), actual: report.platform?.expectedNativeEngine }),
  );
  checks.push(
    typeof report.source?.gitHead === 'string' && report.source.gitHead.length >= 7
      ? pass('source git head recorded')
      : fail('source git head recorded'),
  );
  checks.push(
    report.project?.packageVersion && report.project?.tauriVersion
      ? pass('package and Tauri versions recorded', {
        packageVersion: report.project?.packageVersion,
        tauriVersion: report.project?.tauriVersion,
      })
      : fail('package and Tauri versions recorded'),
  );
  checks.push(
    report.project?.frontend?.devUrl === 'http://127.0.0.1:5175'
      && report.project?.frontend?.frontendDist === '../dist'
      && report.project?.frontend?.macOverridesBuild === false
      && report.project?.frontend?.windowsOverridesBuild === false
      ? pass('macOS and Windows share one frontend entry')
      : fail('macOS and Windows share one frontend entry', { frontend: report.project?.frontend || null }),
  );
  checks.push(
    report.project?.nativeEngines?.macos === 'wkwebview'
      && report.project?.nativeEngines?.windows === 'webview2'
      ? pass('native engine map records macOS and Windows')
      : fail('native engine map records macOS and Windows', { nativeEngines: report.project?.nativeEngines || null }),
  );
  checks.push(
    report.project?.windowsBundle?.webviewInstallMode?.type === 'downloadBootstrapper'
      && Array.isArray(report.project?.windowsBundle?.targets)
      && report.project.windowsBundle.targets.includes('nsis')
      && report.project.windowsBundle.targets.includes('msi')
      ? pass('Windows bundle guarantees WebView2 bootstrapper')
      : fail('Windows bundle guarantees WebView2 bootstrapper', { windowsBundle: report.project?.windowsBundle || null }),
  );
  checks.push(
    Array.isArray(report.steps) && report.steps.length >= 3 && report.steps.every((step) => step.exitCode === 0)
      ? pass('all verification steps exited successfully', { steps: report.steps.map((step) => step.name) })
      : fail('all verification steps exited successfully', { steps: report.steps || [] }),
  );
  const buildStep = buildStepCheck(report, allowSkipBuild);
  checks.push(
    buildStep.ok
      ? pass('frontend build was verified or explicitly skipped', buildStep)
      : fail('frontend build was verified or explicitly skipped', buildStep),
  );
  checks.push(
    report.artifacts?.platformAudit?.ok === true
      && report.artifacts?.browserAssert?.ok === true
      && report.artifacts?.controlAudit?.ok === true
      ? pass('browser audit artifacts are ok')
      : fail('browser audit artifacts are ok', {
        platformAudit: report.artifacts?.platformAudit?.ok,
        browserAssert: report.artifacts?.browserAssert?.ok,
        controlAudit: report.artifacts?.controlAudit?.ok,
      }),
  );
  const controlSteps = controlAuditStepCheck(report.artifacts?.controlAudit);
  checks.push(
    controlSteps.ok
      ? pass('Naver control audit includes required browser control steps', {
        steps: REQUIRED_CONTROL_AUDIT_STEPS,
        expectedSession: controlSteps.expectedSession,
        explicitSessionEvidenceOk: controlSteps.explicitSessionEvidenceOk,
        checkedSessionTabs: controlSteps.checkedSessionTabs,
      })
      : fail('Naver control audit includes required browser control steps', controlSteps),
  );

  if (platform === 'win32') {
    const webview2 = report.artifacts?.platformAudit?.checks
      ?.find((check) => check.name === 'Windows WebView2 runtime is available when running on Windows');
    checks.push(
      webview2?.applicable === true && webview2?.found === true
        ? pass('Windows runtime WebView2 check found runtime', { evidence: webview2?.evidence || [] })
        : fail('Windows runtime WebView2 check found runtime', { check: webview2 || null }),
    );
  }

  return checks;
}

function compareReports(left, right) {
  const checks = [];
  const leftProject = left.project || {};
  const rightProject = right.project || {};
  checks.push(
    leftProject.packageVersion === rightProject.packageVersion
      && leftProject.tauriVersion === rightProject.tauriVersion
      ? pass('reports use same app versions', {
        packageVersion: leftProject.packageVersion,
        tauriVersion: leftProject.tauriVersion,
      })
      : fail('reports use same app versions', {
        left: { packageVersion: leftProject.packageVersion, tauriVersion: leftProject.tauriVersion },
        right: { packageVersion: rightProject.packageVersion, tauriVersion: rightProject.tauriVersion },
      }),
  );
  checks.push(
    leftProject.frontend?.devUrl === rightProject.frontend?.devUrl
      && leftProject.frontend?.frontendDist === rightProject.frontend?.frontendDist
      ? pass('reports use same frontend entry')
      : fail('reports use same frontend entry', { left: leftProject.frontend, right: rightProject.frontend }),
  );
  checks.push(
    left.source?.gitHead === right.source?.gitHead
      ? pass('reports use same git head', { gitHead: left.source?.gitHead })
      : fail('reports use same git head', { left: left.source?.gitHead, right: right.source?.gitHead }),
  );
  return checks;
}

function main() {
  const file = argValue('--file', '');
  const platform = argValue('--platform', process.platform);
  const compareFile = argValue('--compare', '');
  const comparePlatform = argValue('--compare-platform', '');
  const allowSkipBuild = hasArg('--allow-skip-build');
  if (!file) throw new Error('Usage: browser-agent-report-check.mjs --file <report.json> [--platform darwin|win32] [--compare other.json] [--compare-platform darwin|win32] [--allow-skip-build]');

  const report = readJson(file);
  let checks = validateReport(report, platform, { allowSkipBuild });
  if (compareFile) {
    const compareReport = readJson(compareFile);
    if (comparePlatform) {
      checks = checks.concat(validateReport(compareReport, comparePlatform, { allowSkipBuild }));
    }
    checks = checks.concat(compareReports(report, compareReport));
  }

  const summary = {
    ok: checks.every((check) => check.ok),
    file,
    platform,
    compare: compareFile || null,
    comparePlatform: comparePlatform || null,
    allowSkipBuild,
    checks,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
