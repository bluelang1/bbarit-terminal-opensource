#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);

const VS_EDITIONS = ['BuildTools', 'Community', 'Professional', 'Enterprise'];
const VS_BASES = [
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022',
  'C:\\Program Files\\Microsoft Visual Studio\\2022',
];

function argValue(name, fallback = '') {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

function vsEditionRoots() {
  const roots = [];
  for (const base of VS_BASES) {
    for (const edition of VS_EDITIONS) {
      roots.push(`${base}\\${edition}`);
    }
  }
  return roots;
}

export function windowsVsDevCmdPath() {
  return vsEditionRoots()
    .map((root) => `${root}\\Common7\\Tools\\VsDevCmd.bat`)
    .find((candidate) => existsSync(candidate)) || '';
}

function msvcRoots() {
  return vsEditionRoots()
    .map((root) => `${root}\\VC\\Tools\\MSVC`)
    .filter((root) => existsSync(root));
}

function findMsvcEvidence(relativeCandidates) {
  const evidence = [];
  for (const root of msvcRoots()) {
    let versions = [];
    try {
      versions = readdirSync(root);
    } catch {
      continue;
    }
    for (const version of versions) {
      for (const relative of relativeCandidates) {
        const candidate = `${root}\\${version}\\${relative}`;
        if (existsSync(candidate)) {
          evidence.push(candidate);
        }
      }
    }
  }
  return evidence;
}

function findWindowsSdkEvidence(relative) {
  const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\Lib';
  if (!existsSync(sdkRoot)) return [];
  try {
    return readdirSync(sdkRoot)
      .map((version) => `${sdkRoot}\\${version}\\${relative}`)
      .filter((candidate) => existsSync(candidate));
  } catch {
    return [];
  }
}

export function windowsRustTarget() {
  if (process.platform !== 'win32') return '';
  return /arm64/i.test(process.env.PROCESSOR_ARCHITECTURE || process.arch || '')
    ? 'aarch64-pc-windows-msvc'
    : 'x86_64-pc-windows-msvc';
}

export function windowsVsArchForTarget(target) {
  if (/^x86_64-/.test(target)) return 'x64';
  if (/^aarch64-/.test(target)) return 'arm64';
  return /arm64/i.test(process.env.PROCESSOR_ARCHITECTURE || process.arch || '') ? 'arm64' : 'x64';
}

export function windowsVsHostArch() {
  return /arm64/i.test(process.env.PROCESSOR_ARCHITECTURE || process.arch || '') ? 'arm64' : 'x64';
}

export function windowsArm64BuildPrereqStatus() {
  const architecture = process.env.PROCESSOR_ARCHITECTURE || process.arch || '';
  const applicable = process.platform === 'win32' && /arm64/i.test(architecture);
  const devCmd = windowsVsDevCmdPath();
  const linkerEvidence = findMsvcEvidence([
    'bin\\Hostarm64\\arm64\\link.exe',
    'bin\\Hostx64\\arm64\\link.exe',
  ]);
  const libraryEvidence = findMsvcEvidence(['lib\\arm64\\msvcrt.lib']);
  const sdkEvidence = findWindowsSdkEvidence('um\\arm64\\kernel32.lib');
  const checks = [
    {
      name: 'Visual Studio Build Tools developer command prompt',
      ok: Boolean(devCmd),
      expected: 'Common7\\Tools\\VsDevCmd.bat',
      evidence: devCmd ? [devCmd] : [],
    },
    {
      name: 'VC Tools ARM64 linker',
      ok: linkerEvidence.length > 0,
      expected: 'bin\\Hostarm64\\arm64\\link.exe or bin\\Hostx64\\arm64\\link.exe',
      evidence: linkerEvidence,
    },
    {
      name: 'VC Tools ARM64 libraries',
      ok: libraryEvidence.length > 0,
      expected: 'lib\\arm64\\msvcrt.lib',
      evidence: libraryEvidence,
    },
    {
      name: 'Windows SDK ARM64 libraries',
      ok: sdkEvidence.length > 0,
      expected: 'um\\arm64\\kernel32.lib',
      evidence: sdkEvidence,
    },
  ];
  const missing = applicable ? checks.filter((check) => !check.ok) : [];
  return {
    ok: !applicable || missing.length === 0,
    applicable,
    platform: process.platform,
    architecture,
    rustTarget: windowsRustTarget(),
    vsArch: windowsVsArchForTarget(windowsRustTarget()),
    vsHostArch: windowsVsHostArch(),
    checks,
    missing: missing.map((check) => `${check.name} (${check.expected})`),
  };
}

export function assertWindowsArm64BuildPrereqs(options = {}) {
  const {
    context = 'Windows ARM64 verification',
    rerunCommand = 'npm run win:verify',
  } = options;
  const status = windowsArm64BuildPrereqStatus();
  if (!status.applicable || status.ok) return status;
  throw new Error([
    `${context} cannot start because required ARM64 MSVC build tools are missing.`,
    `Missing: ${status.missing.join(', ')}.`,
    'Install Visual Studio Build Tools Desktop development with C++, MSVC v143 C++ ARM64/ARM64EC build tools, and Windows 11 SDK.',
    `Then rerun ${rerunCommand}.`,
  ].join(' '));
}

function writeReport(path, report) {
  const fullPath = resolve(repoRoot, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return fullPath;
}

function main() {
  const requiredPlatform = argValue('--require-platform', '');
  if (requiredPlatform && process.platform !== requiredPlatform) {
    throw new Error(`This prereq check must be run on ${requiredPlatform}; current platform is ${process.platform}.`);
  }
  const status = windowsArm64BuildPrereqStatus();
  const report = {
    generatedAt: new Date().toISOString(),
    ...status,
  };
  const reportPath = argValue('--report', '');
  if (reportPath) {
    console.log(`Report: ${writeReport(reportPath, report)}`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!status.ok) process.exit(1);
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  return basename(process.argv[1]) === 'windows-msvc-prereq.mjs';
}

if (isDirectRun()) {
  main();
}
