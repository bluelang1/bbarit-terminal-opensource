#!/usr/bin/env node
// Collect the updater artifacts of a fork release build and write the
// `latest.json` that the Tauri updater endpoint in tauri.fork.conf.json serves.
//
//   node scripts/fork-release-manifest.mjs --tag v1.1.51 --repo bluelang1/bbarit-terminal-opensource --out release-out
//
// The output directory then holds the renamed bundle files (no spaces, so the
// GitHub asset names are predictable) and latest.json; upload all of them as
// assets of the GitHub release named by --tag.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export const DEFAULT_BUNDLE_DIR = 'src-tauri/target/release/bundle';

const ARCH_BY_NODE = { arm64: 'aarch64', x64: 'x86_64', ia32: 'i686' };
const OS_BY_NODE = { darwin: 'darwin', win32: 'windows', linux: 'linux' };

export function platformKey(platform = process.platform, arch = process.arch) {
  const os = OS_BY_NODE[platform];
  const cpu = ARCH_BY_NODE[arch];
  if (!os || !cpu) throw new Error(`Unsupported platform for the updater manifest: ${platform}/${arch}`);
  return `${os}-${cpu}`;
}

export function assetFileName(name) {
  // GitHub rewrites spaces in asset names; do it ourselves so the URL in
  // latest.json matches the uploaded file exactly.
  return name.replace(/\s+/g, '-');
}

export function releaseAssetUrl(repo, tag, name) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetFileName(name))}`;
}

export function tagMatchesVersion(tag, version) {
  return tag === `v${version}`;
}

// The bundle file (plus its .sig) that the updater downloads, per OS.
export function updaterArtifactPattern(platform) {
  if (platform === 'darwin') return { dir: 'macos', test: (name) => name.endsWith('.app.tar.gz') };
  if (platform === 'win32') return { dir: 'nsis', test: (name) => name.endsWith('-setup.exe') };
  if (platform === 'linux') return { dir: 'appimage', test: (name) => name.endsWith('.AppImage') };
  throw new Error(`No updater artifact layout known for ${platform}`);
}

// Human-installable bundle files worth attaching next to the updater artifact.
export function installerArtifactDirs(platform) {
  if (platform === 'darwin') return ['dmg'];
  if (platform === 'win32') return ['msi'];
  if (platform === 'linux') return ['deb', 'rpm'];
  return [];
}

export function findUpdaterArtifact(bundleDir, platform) {
  const { dir, test } = updaterArtifactPattern(platform);
  const folder = path.join(bundleDir, dir);
  if (!existsSync(folder)) throw new Error(`Bundle folder is missing: ${folder}. Run \`npm run tauri:build:fork\` first.`);
  const candidates = readdirSync(folder).filter((name) => test(name) && !name.endsWith('.sig'));
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one updater artifact in ${folder}, found: ${candidates.join(', ') || '(none)'}`);
  }
  const file = path.join(folder, candidates[0]);
  const signature = `${file}.sig`;
  if (!existsSync(signature)) {
    throw new Error(`Updater signature is missing: ${signature}. The build must run with TAURI_SIGNING_PRIVATE_KEY set.`);
  }
  return { file, signature };
}

export function findInstallerArtifacts(bundleDir, platform) {
  const files = [];
  for (const dir of installerArtifactDirs(platform)) {
    const folder = path.join(bundleDir, dir);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      if (/\.(dmg|msi|deb|rpm)$/i.test(name)) files.push(path.join(folder, name));
    }
  }
  return files;
}

export function buildUpdaterManifest({ version, notes, pubDate, platforms }) {
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms,
  };
}

export function mergeManifest(existing, next) {
  if (!existing) return next;
  if (existing.version !== next.version) {
    throw new Error(`Cannot merge manifests for different versions (${existing.version} vs ${next.version})`);
  }
  return { ...existing, ...next, platforms: { ...existing.platforms, ...next.platforms } };
}

export function readBuildVersion(root = repoRoot, platform = process.platform) {
  const base = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const platformFile = { darwin: 'tauri.macos.conf.json', win32: 'tauri.windows.conf.json', linux: 'tauri.linux.conf.json' }[platform];
  const platformPath = platformFile ? path.join(root, 'src-tauri', platformFile) : null;
  if (platformPath && existsSync(platformPath)) {
    const override = JSON.parse(readFileSync(platformPath, 'utf8'));
    if (typeof override.version === 'string') return override.version;
  }
  return base.version;
}

export function parseArgs(argv) {
  const out = { tag: null, repo: null, out: 'release-out', bundleDir: DEFAULT_BUNDLE_DIR, notes: null, merge: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--tag') out.tag = value();
    else if (arg === '--repo') out.repo = value();
    else if (arg === '--out') out.out = value();
    else if (arg === '--bundle-dir') out.bundleDir = value();
    else if (arg === '--notes') out.notes = value();
    else if (arg === '--merge') out.merge = value();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.tag || !out.repo) throw new Error('Usage: fork-release-manifest.mjs --tag vX.Y.Z --repo owner/name [--out dir] [--bundle-dir dir] [--notes text] [--merge latest.json]');
  return out;
}

export function prepareRelease(options, { root = repoRoot, platform = process.platform, arch = process.arch, now = new Date() } = {}) {
  const version = readBuildVersion(root, platform);
  if (!tagMatchesVersion(options.tag, version)) {
    throw new Error(`Tag ${options.tag} does not match the configured app version ${version}. Bump with \`node scripts/bump-version.mjs\` first.`);
  }
  const bundleDir = path.resolve(root, options.bundleDir);
  const outDir = path.resolve(root, options.out);
  mkdirSync(outDir, { recursive: true });

  const updater = findUpdaterArtifact(bundleDir, platform);
  const copied = [];
  const copy = (file) => {
    const target = path.join(outDir, assetFileName(path.basename(file)));
    copyFileSync(file, target);
    copied.push(target);
    return target;
  };
  const updaterAsset = copy(updater.file);
  copy(updater.signature);
  for (const file of findInstallerArtifacts(bundleDir, platform)) copy(file);

  const manifest = buildUpdaterManifest({
    version,
    notes: options.notes ?? `BBARIT Terminal Source ${options.tag}`,
    pubDate: now.toISOString(),
    platforms: {
      [platformKey(platform, arch)]: {
        signature: readFileSync(updater.signature, 'utf8').trim(),
        url: releaseAssetUrl(options.repo, options.tag, path.basename(updaterAsset)),
      },
    },
  });
  const existing = options.merge && existsSync(path.resolve(root, options.merge))
    ? JSON.parse(readFileSync(path.resolve(root, options.merge), 'utf8'))
    : null;
  const merged = mergeManifest(existing, manifest);
  const manifestPath = path.join(outDir, 'latest.json');
  writeFileSync(manifestPath, `${JSON.stringify(merged, null, 2)}\n`);
  copied.push(manifestPath);
  return { version, manifest: merged, files: copied };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = prepareRelease(options);
  console.log(`Prepared release ${options.tag} (version ${result.version}) in ${options.out}:`);
  for (const file of result.files) console.log(`  ${path.relative(repoRoot, file)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
