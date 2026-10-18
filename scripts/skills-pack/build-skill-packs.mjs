#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = {
    config: 'skills-pack/config.json',
    output: null,
    baseUrl: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--config') {
      out.config = argv[i + 1] || out.config;
      i += 1;
      continue;
    }
    if (token === '--output') {
      out.output = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (token === '--base-url') {
      out.baseUrl = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (token === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return out;
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/skills-pack/build-skill-packs.mjs [options]',
      '',
      'Options:',
      '  --config <path>    Skills pack config file (default: skills-pack/config.json)',
      '  --output <dir>     Override output directory from config',
      '  --base-url <url>   Override baseUrl from config',
      '  --dry-run          Validate and print summary without writing files',
      '  -h, --help         Show help',
      '',
    ].join('\n'),
  );
}

function toPosix(inputPath) {
  return inputPath.split(path.sep).join('/');
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function toStringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const dedup = new Set();
  for (const item of value) {
    const tag = toStringOrEmpty(item);
    if (tag) dedup.add(tag);
  }
  return Array.from(dedup);
}

function normalizeSkill(raw, index, packName) {
  if (!raw || typeof raw !== 'object') return null;

  const rawName = toStringOrEmpty(raw.name);
  const fallbackId = `${slugify(packName) || 'pack'}-${index + 1}`;
  const id = toStringOrEmpty(raw.id) || slugify(rawName) || fallbackId;
  const command = toStringOrEmpty(raw.command);
  if (!id || !command) return null;

  const normalized = {
    id,
    name: rawName || id,
    description: toStringOrEmpty(raw.description),
    emoji: toStringOrEmpty(raw.emoji) || '⚡',
    command,
    cliType: toStringOrEmpty(raw.cliType) || 'shell',
    category: toStringOrEmpty(raw.category) || 'custom',
    tags: normalizeTags(raw.tags),
    builtIn: false,
  };

  const model = toStringOrEmpty(raw.model);
  if (model) normalized.model = model;
  const originalName = toStringOrEmpty(raw.originalName);
  if (originalName) normalized.originalName = originalName;
  const originalCommand = toStringOrEmpty(raw.originalCommand);
  if (originalCommand) normalized.originalCommand = originalCommand;
  const originalDescription = toStringOrEmpty(raw.originalDescription);
  if (originalDescription) normalized.originalDescription = originalDescription;

  return normalized;
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function loadSourceSkills(configDir, sourcePath) {
  const absoluteSourcePath = path.resolve(configDir, sourcePath);
  const parsed = await readJsonFile(absoluteSourcePath);
  const skills = Array.isArray(parsed) ? parsed : parsed?.skills;
  if (!Array.isArray(skills)) {
    throw new Error(`Source file has invalid format: ${sourcePath}`);
  }
  return skills;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function joinUrl(baseUrl, relativePath) {
  const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  const cleanRel = String(relativePath || '').trim().replace(/^\/+/, '');
  if (!cleanBase) return cleanRel;
  return `${cleanBase}/${cleanRel}`;
}

async function buildPack({
  configDir,
  outputDir,
  baseUrl,
  pack,
  dryRun,
}) {
  const packName = toStringOrEmpty(pack.name);
  const packVersion = toStringOrEmpty(pack.version);
  if (!packName) throw new Error('pack.name is required');
  if (!packVersion) throw new Error(`pack.version is required (${packName})`);
  if (!Array.isArray(pack.sources) || pack.sources.length === 0) {
    throw new Error(`pack.sources is required (${packName})`);
  }

  const rawSkills = [];
  for (const sourcePath of pack.sources) {
    const oneSourceSkills = await loadSourceSkills(configDir, sourcePath);
    rawSkills.push(...oneSourceSkills);
  }

  const dedupById = new Map();
  rawSkills.forEach((raw, index) => {
    const normalized = normalizeSkill(raw, index, packName);
    if (!normalized) return;
    dedupById.set(normalized.id, normalized);
  });

  const normalizedSkills = Array.from(dedupById.values()).sort((a, b) => a.id.localeCompare(b.id));
  if (normalizedSkills.length === 0) {
    throw new Error(`No valid skills found for pack: ${packName}`);
  }

  const defaultFileName = `${slugify(packName) || 'pack'}-v${packVersion}.json`;
  const outputRelative = toPosix(toStringOrEmpty(pack.output) || `packs/${defaultFileName}`);
  const outputAbsolute = path.resolve(outputDir, outputRelative);

  const payload = { skills: normalizedSkills };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const checksumSha256 = sha256Hex(serialized);

  if (!dryRun) {
    await fs.mkdir(path.dirname(outputAbsolute), { recursive: true });
    await fs.writeFile(outputAbsolute, serialized, 'utf8');
  }

  return {
    name: packName,
    version: packVersion,
    description: toStringOrEmpty(pack.description),
    outputRelative,
    outputAbsolute,
    checksumSha256,
    skillCount: normalizedSkills.length,
    url: joinUrl(baseUrl, outputRelative),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(process.cwd(), args.config);
  const configDir = path.dirname(configPath);
  const config = await readJsonFile(configPath);

  const outputDirFromConfig = toStringOrEmpty(config.outputDir) || 'skills-pack/dist';
  const outputDir = path.resolve(configDir, args.output || outputDirFromConfig);
  const baseUrl = args.baseUrl || toStringOrEmpty(config.baseUrl);
  const schemaVersion = toStringOrEmpty(config.schemaVersion) || '1.0.0';
  const packs = Array.isArray(config.packs) ? config.packs : [];

  if (packs.length === 0) {
    throw new Error('config.packs must contain at least one pack');
  }

  if (!args.dryRun) {
    await fs.mkdir(outputDir, { recursive: true });
  }

  const builtPacks = [];
  for (const pack of packs) {
    const built = await buildPack({
      configDir,
      outputDir,
      baseUrl,
      pack,
      dryRun: args.dryRun,
    });
    builtPacks.push(built);
  }

  const manifest = {
    schemaVersion,
    generatedAt: new Date().toISOString(),
    packs: builtPacks.map((pack) => ({
      name: pack.name,
      version: pack.version,
      description: pack.description || undefined,
      url: pack.url,
      checksumSha256: pack.checksumSha256,
      skillCount: pack.skillCount,
    })),
  };

  const manifestPath = path.resolve(outputDir, 'manifest.json');
  const manifestSerialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!args.dryRun) {
    await fs.writeFile(manifestPath, manifestSerialized, 'utf8');
  }

  process.stdout.write(`Built ${builtPacks.length} pack(s)\n`);
  process.stdout.write(`Manifest: ${manifestPath}\n`);
  for (const pack of builtPacks) {
    process.stdout.write(
      `- ${pack.name}@${pack.version}: ${pack.skillCount} skills -> ${pack.outputAbsolute}\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(`[skills-pack] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
