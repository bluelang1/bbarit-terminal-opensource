#!/usr/bin/env node
/**
 * Bump BBARIT Terminal version.
 *
 * Usage:
 *   node scripts/bump-version.mjs 0.1.70              # bump both mac + win (and package.json/Cargo.toml)
 *   node scripts/bump-version.mjs --mac 0.1.70        # bump macOS only
 *   node scripts/bump-version.mjs --win 0.1.70        # bump Windows only
 *   node scripts/bump-version.mjs --mac 0.1.70 --win 0.1.71
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function writeText(p, s) {
  fs.writeFileSync(p, s, "utf8");
}

function isSemver(s) {
  return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(s || "").trim());
}

function parseArgs(argv) {
  const out = { mac: null, win: null, both: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mac") out.mac = argv[++i];
    else if (a === "--win") out.win = argv[++i];
    else if (!a.startsWith("--") && out.both === null) out.both = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.mac && !args.win && !args.both) {
  die(
    "Usage:\n" +
    "  node scripts/bump-version.mjs 0.1.70            # both platforms\n" +
    "  node scripts/bump-version.mjs --mac 0.1.70      # macOS only\n" +
    "  node scripts/bump-version.mjs --win 0.1.70      # Windows only"
  );
}

const macVersion = args.mac || args.both;
const winVersion = args.win || args.both;

for (const v of [macVersion, winVersion].filter(Boolean)) {
  if (!isSemver(v)) die(`Invalid version: ${v} (expected X.Y.Z)`);
}

const files = {
  pkg: path.join(ROOT, "package.json"),
  tauriConf: path.join(ROOT, "src-tauri", "tauri.conf.json"),
  tauriMac: path.join(ROOT, "src-tauri", "tauri.macos.conf.json"),
  tauriWin: path.join(ROOT, "src-tauri", "tauri.windows.conf.json"),
  cargo: path.join(ROOT, "src-tauri", "Cargo.toml"),
  readme: path.join(ROOT, "README.md"),
};

function bumpJsonVersion(p, nextVersion, label) {
  if (!fs.existsSync(p)) die(`Missing: ${p}`);
  const json = JSON.parse(readText(p));
  const prev = json.version;
  json.version = nextVersion;
  writeText(p, JSON.stringify(json, null, 2) + "\n");
  console.log(`${label}: ${prev} -> ${nextVersion}`);
}

function bumpCargoVersion(p, nextVersion, label) {
  const raw = readText(p);
  const re = /^version\s*=\s*"([^"]+)"/m;
  if (!re.test(raw)) die(`Could not find package version in ${p}`);
  const prev = raw.match(re)?.[1];
  const next = raw.replace(re, `version = "${nextVersion}"`);
  writeText(p, next);
  console.log(`${label}: ${prev} -> ${nextVersion}`);
}

if (args.mac || args.both) {
  bumpJsonVersion(files.tauriMac, macVersion, "tauri.macos.conf.json");
}
if (args.win || args.both) {
  bumpJsonVersion(files.tauriWin, winVersion, "tauri.windows.conf.json");
}

if (args.both) {
  bumpJsonVersion(files.pkg, args.both, "package.json");
  bumpJsonVersion(files.tauriConf, args.both, "src-tauri/tauri.conf.json");
  bumpCargoVersion(files.cargo, args.both, "src-tauri/Cargo.toml");

  if (fs.existsSync(files.readme)) {
    const raw = readText(files.readme);
    const next = raw.replace(
      /(img\.shields\.io\/badge\/version-)([0-9]+\.[0-9]+\.[0-9]+)(-blue)/g,
      `$1${args.both}$3`
    );
    if (next !== raw) {
      writeText(files.readme, next);
      console.log(`README.md: badge updated -> ${args.both}`);
    }
  }
}
