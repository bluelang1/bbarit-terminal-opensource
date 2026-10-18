#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_OPENJARVIS_ROOT = '../OpenJarvis';
const DEFAULT_OUTPUT = 'src/skills/openJarvisSkills.ts';
const DEFAULT_PUBLIC_CACHE = '.octo-tmp/openjarvis-sources';

const PUBLIC_SOURCES = [
  {
    key: 'hermes',
    name: 'Hermes Agent',
    repoUrl: 'https://github.com/NousResearch/hermes-agent.git',
    cacheDir: 'hermes-agent',
    sourcePack: 'openjarvis-hermes',
    urlBase: 'https://github.com/NousResearch/hermes-agent/blob/main',
  },
  {
    key: 'openclaw-agent-skills',
    name: 'OpenClaw Agent Skills',
    repoUrl: 'https://github.com/openclaw/agent-skills.git',
    cacheDir: 'openclaw-agent-skills',
    sourcePack: 'openjarvis-openclaw-agent-skills',
    urlBase: 'https://github.com/openclaw/agent-skills/blob/main',
  },
];

function parseArgs(argv) {
  const out = {
    openjarvisRoot: DEFAULT_OPENJARVIS_ROOT,
    output: DEFAULT_OUTPUT,
    publicCache: DEFAULT_PUBLIC_CACHE,
    syncPublic: false,
    skipPublic: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--openjarvis-root' || token === '--source') {
      out.openjarvisRoot = argv[i + 1] || out.openjarvisRoot;
      i += 1;
      continue;
    }
    if (token === '--output') {
      out.output = argv[i + 1] || out.output;
      i += 1;
      continue;
    }
    if (token === '--public-cache') {
      out.publicCache = argv[i + 1] || out.publicCache;
      i += 1;
      continue;
    }
    if (token === '--sync-public') {
      out.syncPublic = true;
      continue;
    }
    if (token === '--skip-public') {
      out.skipPublic = true;
      continue;
    }
    if (token === '-h' || token === '--help') {
      process.stdout.write([
        'Usage: node scripts/skills-pack/import-openjarvis-skills.mjs [options]',
        '',
        'Options:',
        '  --openjarvis-root <dir>  OpenJarvis repository root',
        '  --source <dir>           Alias for --openjarvis-root',
        '  --public-cache <dir>     Cache directory for public skill repos',
        '  --sync-public            Clone/pull public sources before importing',
        '  --skip-public            Only import OpenJarvis bundled skills',
        '  --output <file>          Generated TypeScript output file',
        '',
      ].join('\n'));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return out;
}

function stripQuotes(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._\s-]+/g, '')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeTag(value) {
  return slugify(value).slice(0, 48);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root, predicate) {
  const out = [];
  if (!(await pathExists(root))) return out;
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && predicate(full, entry.name)) {
        out.push(full);
      }
    }
  }
  await visit(root);
  return out.sort((a, b) => a.localeCompare(b));
}

function parseTomlArray(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((item) => stripQuotes(item.trim()))
    .filter(Boolean);
}

function parseTomlSkill(raw, fileName) {
  const lines = raw.split(/\r?\n/);
  const skill = {
    name: path.basename(fileName, '.toml'),
    description: '',
    version: '0.1.0',
    author: 'openjarvis',
    tags: [],
    steps: [],
  };
  let inSkill = false;
  let currentStep = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed === '[skill]') {
      inSkill = true;
      currentStep = null;
      continue;
    }
    if (trimmed === '[[skill.steps]]') {
      inSkill = false;
      currentStep = {};
      skill.steps.push(currentStep);
      continue;
    }
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    const value = stripQuotes(rawValue);
    if (currentStep) {
      currentStep[key] = value;
    } else if (inSkill && key in skill) {
      skill[key] = key === 'tags' ? parseTomlArray(rawValue) : value;
    }
  }
  return skill;
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return [{}, raw];
  const rest = raw.slice(3).replace(/^\r?\n/, '');
  const end = rest.search(/\r?\n---\r?\n/);
  if (end < 0) return [{}, raw];
  const fmText = rest.slice(0, end);
  const body = rest.slice(end).replace(/^\r?\n---\r?\n/, '');
  const fm = {};
  let currentArrayKey = '';
  for (const line of fmText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const arrayItem = trimmed.match(/^-\s+(.+)$/);
    if (arrayItem && currentArrayKey) {
      fm[currentArrayKey].push(stripQuotes(arrayItem[1]));
      continue;
    }
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    currentArrayKey = '';
    const key = match[1];
    const value = match[2].trim();
    if (!value) {
      fm[key] = [];
      currentArrayKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      fm[key] = value.slice(1, -1).split(',').map((item) => stripQuotes(item.trim())).filter(Boolean);
    } else {
      fm[key] = stripQuotes(value);
    }
  }
  return [fm, body];
}

function inferCategory(input) {
  const text = `${input.name} ${input.description} ${input.category || ''} ${(input.tags || []).join(' ')} ${input.steps?.map((s) => s.tool_name || s.skill_name || '').join(' ') || ''}`.toLowerCase();
  if (text.includes('security') || text.includes('audit')) return 'security';
  if (text.includes('test') || text.includes('bench')) return 'testing';
  if (text.includes('review')) return 'review';
  if (text.includes('debug')) return 'debug';
  if (text.includes('architecture')) return 'architecture';
  if (text.includes('performance')) return 'performance';
  if (text.includes('git') || text.includes('pull request') || text.includes('commit')) return 'git';
  if (text.includes('code') || text.includes('dependency') || text.includes('dev')) return 'dev';
  if (text.includes('api')) return 'api';
  if (text.includes('web') || text.includes('research') || text.includes('doc') || text.includes('pdf') || text.includes('meeting') || text.includes('email')) return 'docs';
  if (text.includes('data')) return 'db';
  if (text.includes('backup') || text.includes('file') || text.includes('ops')) return 'ops';
  return 'ai';
}

const DANGEROUS_SKILL_NAMES = new Set([
  '1password',
  'domain-intel',
  'drug-discovery',
  'fitness-nutrition',
  'github-auth',
  'godmode',
  'obliteratus',
  'osint-investigation',
  'sherlock',
  'web-pentest',
]);

const DANGEROUS_PATTERNS = [
  { label: 'destructive filesystem operation', re: /\b(rm\s+-rf|remove-item\s+-recurse|delete\s+.*--yes|format\s+disk|wipe|destroy|obliterate)\b/i },
  { label: 'offensive security or OSINT workflow', re: /\b(pentest|exploit|vulnerability scan|osint|sherlock|reconnaissance|credential stuffing|phishing)\b/i },
];

const CAUTION_PATTERNS = [
  { label: 'arbitrary code execution bridge', re: /\b(arbitrary .*code|execute_code|eval\(|exec\(|socket server|run any command|bypass)\b/i },
  { label: 'credential or secret handling', re: /\b(api[_-]?key|access[_-]?token|secret|password|credential|authorization|x-api-key|service account)\b/i },
  { label: 'downloads or installs external tooling', re: /\b(curl\s+|wget\s+|go install|pip install|npm install|npx\s+-y|docker run|brew install|apt install)\b/i },
  { label: 'external network/API integration', re: /\b(webhook|oauth|api token|bearer token|http request|host_permissions|socket|localhost:\d+)\b/i },
  { label: 'writes project or user files', re: /\b(write_file|create_directory|mkdir|cat\s+>|tee\s+|touch\s+|append|save to)\b/i },
  { label: 'browser/session/account automation', re: /\b(login|sign in|session cookie|browser_navigate|account|auth)\b/i },
];

function uniqueReasons(reasons) {
  return Array.from(new Set(reasons)).slice(0, 6);
}

function classifyImportedSkill({ name, description, body, command, sourcePack, sourceName }) {
  const normalizedName = slugify(name);
  const text = `${name || ''}\n${description || ''}\n${body || ''}\n${command || ''}`.toLowerCase();
  const dangerousReasons = [];
  const cautionReasons = [];

  if (DANGEROUS_SKILL_NAMES.has(normalizedName)) {
    dangerousReasons.push(`denylisted skill name: ${normalizedName}`);
  }
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.re.test(text)) dangerousReasons.push(pattern.label);
  }
  for (const pattern of CAUTION_PATTERNS) {
    if (pattern.re.test(text)) cautionReasons.push(pattern.label);
  }

  const trustLevel = sourcePack === 'openjarvis-workflows' ? 'trusted' : 'community';
  const safetyLevel = dangerousReasons.length > 0
    ? 'dangerous'
    : cautionReasons.length > 0
      ? 'caution'
      : 'safe';
  const safetyReasons = safetyLevel === 'dangerous'
    ? uniqueReasons(dangerousReasons)
    : uniqueReasons(cautionReasons);
  const safetyTags = safetyLevel === 'safe'
    ? ['safety-safe', `trust-${trustLevel}`]
    : [`safety-${safetyLevel}`, `trust-${trustLevel}`, ...safetyReasons.map((reason) => `risk-${reason}`)];
  return {
    safetyLevel,
    safetyReasons,
    trustLevel,
    safetyTags: safetyTags.map(normalizeTag).filter(Boolean),
    sourceName,
  };
}

function buildPipelineText(skill) {
  const steps = skill.steps.map((step, index) => {
    const target = step.tool_name || step.skill_name || 'unknown';
    const args = step.arguments_template || '{}';
    const output = step.output_key ? ` -> ${step.output_key}` : '';
    return `${index + 1}. ${target}${output}\n   args: ${args}`;
  });
  return steps.join('\n');
}

function getGitCommit(repoDir) {
  try {
    return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function toOctoTomlSkill(skill, sourceUrl, sourcePack) {
  const id = `openjarvis-${slugify(skill.name)}`;
  const pipeline = buildPipelineText(skill);
  const command = [
    `Apply the OpenJarvis skill "${skill.name}" to this project.`,
    '',
    `Description: ${skill.description || skill.name}`,
    '',
    'OpenJarvis pipeline:',
    pipeline || '(instruction-only skill)',
    '',
    'Use equivalent local capabilities in this environment. If an OpenJarvis tool name is not available, perform the same step manually with repository inspection, shell commands, or the available agent tools. Return concrete file-level results and verification steps.',
    '',
    `Source: ${sourceUrl}`,
  ].join('\n');
  const safety = classifyImportedSkill({
    name: skill.name,
    description: skill.description,
    body: pipeline,
    command,
    sourcePack,
    sourceName: 'OpenJarvis',
  });

  const tags = [
    'openjarvis',
    'imported',
    'skill.toml',
    ...(skill.tags || []),
    ...skill.steps.map((step) => step.tool_name || step.skill_name).filter(Boolean),
    ...safety.safetyTags,
  ].map(normalizeTag).filter(Boolean);

  return {
    id,
    name: `OpenJarvis: ${skill.name}`,
    description: skill.description || `OpenJarvis skill ${skill.name}`,
    emoji: 'OJ',
    command,
    cliType: 'codex',
    category: inferCategory(skill),
    tags: Array.from(new Set(tags)),
    builtIn: false,
    originalName: skill.name,
    originalDescription: skill.description || '',
    originalCommand: command,
    sourcePack,
    sourceUrl,
    safetyLevel: safety.safetyLevel,
    safetyReasons: safety.safetyReasons,
    trustLevel: safety.trustLevel,
  };
}

function toOctoMarkdownSkill({ name, description, body, sourceUrl, sourcePack, sourceName, category, tags }) {
  const safeName = name || path.basename(sourceUrl || 'skill');
  const command = [
    `Apply the ${sourceName} skill "${safeName}" to this project.`,
    '',
    `Description: ${description || safeName}`,
    '',
    'Skill instructions:',
    body.trim() || '(No instruction body found.)',
    '',
    'Follow these instructions using the available local tools. Do not run external scripts from the skill unless the user explicitly asks and the script has been inspected first. Return concrete file-level results and verification steps.',
    '',
    `Source: ${sourceUrl}`,
  ].join('\n');
  const safety = classifyImportedSkill({
    name: safeName,
    description,
    body,
    command,
    sourcePack,
    sourceName,
  });
  const allTags = ['openjarvis', 'imported', 'SKILL.md', sourceName, category, ...(tags || []), ...safety.safetyTags]
    .map(normalizeTag)
    .filter(Boolean);
  return {
    id: `openjarvis-${slugify(sourceName)}-${slugify(safeName)}`,
    name: `${sourceName}: ${safeName}`,
    description: description || `${sourceName} skill ${safeName}`,
    emoji: 'OJ',
    command,
    cliType: 'codex',
    category: inferCategory({ name: safeName, description, category, tags }),
    tags: Array.from(new Set(allTags)),
    builtIn: false,
    originalName: safeName,
    originalDescription: description || '',
    originalCommand: command,
    sourcePack,
    sourceUrl,
    safetyLevel: safety.safetyLevel,
    safetyReasons: safety.safetyReasons,
    trustLevel: safety.trustLevel,
  };
}

async function importBundledOpenJarvis(openjarvisRoot) {
  const sourceDir = path.join(openjarvisRoot, 'src/openjarvis/skills/data');
  const tomlFiles = await walkFiles(sourceDir, (full, name) => name.endsWith('.toml'));
  const skills = [];
  for (const filePath of tomlFiles) {
    const raw = await fs.readFile(filePath, 'utf8');
    const fileName = path.basename(filePath);
    skills.push(toOctoTomlSkill(
      parseTomlSkill(raw, fileName),
      `https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/skills/data/${fileName}`,
      'openjarvis-core',
    ));
  }
  return skills;
}

async function syncPublicSources(publicCache) {
  await fs.mkdir(publicCache, { recursive: true });
  for (const source of PUBLIC_SOURCES) {
    const target = path.join(publicCache, source.cacheDir);
    if (await pathExists(path.join(target, '.git'))) {
      execFileSync('git', ['-C', target, 'pull', '--ff-only'], { stdio: 'inherit' });
    } else {
      execFileSync('git', ['clone', '--depth', '1', source.repoUrl, target], { stdio: 'inherit' });
    }
  }
}

async function importPublicMarkdownSources(publicCache) {
  const skills = [];
  for (const source of PUBLIC_SOURCES) {
    const repoDir = path.join(publicCache, source.cacheDir);
    if (!(await pathExists(repoDir))) continue;
    const commit = getGitCommit(repoDir);
    const skillFiles = await walkFiles(repoDir, (full, name) => name.toLowerCase() === 'skill.md');
    for (const skillFile of skillFiles) {
      const raw = await fs.readFile(skillFile, 'utf8');
      const [frontmatter, body] = parseFrontmatter(raw);
      const relative = path.relative(repoDir, skillFile).replace(/\\/g, '/');
      const sourceUrl = `${source.urlBase}/${relative}`;
      const category = path.dirname(relative).split('/').filter(Boolean).slice(-2, -1)[0] || source.key;
      const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
      skills.push(toOctoMarkdownSkill({
        name: String(frontmatter.name || path.basename(path.dirname(skillFile))),
        description: String(frontmatter.description || ''),
        body,
        sourceUrl,
        sourcePack: commit ? `${source.sourcePack}@${commit.slice(0, 12)}` : source.sourcePack,
        sourceName: source.name,
        category,
        tags,
      }));
    }
  }
  return skills;
}

function buildOpenJarvisWorkflowSkills() {
  const workflowSpecs = [
    {
      id: 'openjarvis-source-hermes-sync',
      name: 'OpenJarvis: Sync Hermes Skills',
      description: 'Clone or update NousResearch/hermes-agent and import every SKILL.md into the Octo skill gallery.',
      category: 'ops',
      tags: ['openjarvis', 'hermes', 'sync', 'skills'],
      command: 'Run `npm run skills:openjarvis:import:public` from the Octo project root. This updates the Hermes Agent cache, converts all discovered `SKILL.md` files, and regenerates `src/skills/openJarvisSkills.ts`.',
      sourceUrl: 'https://github.com/NousResearch/hermes-agent',
    },
    {
      id: 'openjarvis-source-openclaw-sync',
      name: 'OpenJarvis: Sync OpenClaw Skills',
      description: 'Import audited OpenClaw agent workflow skills and keep community registry handling separate from the app bundle.',
      category: 'ops',
      tags: ['openjarvis', 'openclaw', 'sync', 'skills', 'security'],
      command: 'Run `npm run skills:openjarvis:import:public` and review all OpenClaw-derived skills before installing them into a project. Treat community registry entries as untrusted until their `SKILL.md` body and scripts have been inspected.',
      sourceUrl: 'https://github.com/openclaw/agent-skills',
    },
    {
      id: 'openjarvis-source-github-import',
      name: 'OpenJarvis: Import GitHub SKILL.md Repo',
      description: 'Import skills from any GitHub repository that contains `SKILL.md` or `skill.md` files.',
      category: 'ops',
      tags: ['openjarvis', 'github', 'SKILL.md', 'import'],
      command: 'Clone the target GitHub repository into `.octo-tmp/openjarvis-sources/<repo-name>`, then run `node scripts/skills-pack/import-openjarvis-skills.mjs --public-cache .octo-tmp/openjarvis-sources`. Inspect any scripts before use.',
      sourceUrl: 'https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/skills/sources/github.py',
    },
    {
      id: 'openjarvis-skill-discovery',
      name: 'OpenJarvis: Discover Skills From Traces',
      description: 'Mine repeated tool sequences from trace history and turn them into reusable skill candidates.',
      category: 'ai',
      tags: ['openjarvis', 'trace', 'discovery', 'skills'],
      command: 'Review recent task traces, identify repeated tool sequences, and propose reusable Octo skills. Output each candidate with name, routing description, trigger cases, required tools, and a safe command body.',
      sourceUrl: 'https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/skills/manager.py',
    },
    {
      id: 'openjarvis-skill-optimization',
      name: 'OpenJarvis: Optimize Skills From Traces',
      description: 'Improve skill descriptions and examples using trace history, mirroring OpenJarvis DSPy/GEPA overlays.',
      category: 'performance',
      tags: ['openjarvis', 'optimization', 'dspy', 'gepa', 'skills'],
      command: 'Analyze usage traces for selected skills. Tighten the description for routing, add few-shot examples, and keep the original skill unchanged. Store proposed overlay text separately so the user can accept it.',
      sourceUrl: 'https://github.com/open-jarvis/OpenJarvis/blob/main/docs/user-guide/skills.md',
    },
    {
      id: 'openjarvis-skill-benchmark',
      name: 'OpenJarvis: Benchmark Skill Impact',
      description: 'Benchmark whether a skill improves task success, latency, or quality.',
      category: 'testing',
      tags: ['openjarvis', 'benchmark', 'skills', 'evaluation'],
      command: 'Create a small before/after benchmark for the chosen skill. Define sample prompts, success criteria, seeds or repeat count, observed failures, and whether the skill should stay enabled.',
      sourceUrl: 'https://github.com/open-jarvis/OpenJarvis/blob/main/docs/user-guide/skills.md',
    },
  ];
  return workflowSpecs.map((spec) => ({
    ...spec,
    emoji: 'OJ',
    cliType: 'codex',
    builtIn: false,
    originalName: spec.name,
    originalDescription: spec.description,
    originalCommand: spec.command,
    sourcePack: 'openjarvis-workflows',
    safetyLevel: 'safe',
    safetyReasons: [],
    trustLevel: 'trusted',
  }));
}

function dedupeSkills(skills) {
  const seen = new Map();
  for (const skill of skills) {
    let id = skill.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${skill.id}-${suffix}`;
      suffix += 1;
    }
    seen.set(id, { ...skill, id });
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const openjarvisRoot = path.resolve(process.cwd(), args.openjarvisRoot);
  const outputPath = path.resolve(process.cwd(), args.output);
  const publicCache = path.resolve(process.cwd(), args.publicCache);

  if (args.syncPublic && !args.skipPublic) {
    await syncPublicSources(publicCache);
  }

  const skills = [
    ...await importBundledOpenJarvis(openjarvisRoot),
    ...buildOpenJarvisWorkflowSkills(),
  ];

  if (!args.skipPublic) {
    skills.push(...await importPublicMarkdownSources(publicCache));
  }

  const finalSkills = dedupeSkills(skills);
  const publicNote = args.skipPublic
    ? 'Public sources skipped.'
    : `Public cache: ${path.relative(process.cwd(), publicCache).replace(/\\/g, '/')}`;

  const serialized = [
    "import type { Skill } from './types';",
    '',
    '// Generated by scripts/skills-pack/import-openjarvis-skills.mjs.',
    '// Sources: OpenJarvis bundled skills, Hermes Agent, OpenClaw Agent Skills, OpenJarvis workflow patterns.',
    `// ${publicNote}`,
    '',
    `export const OPENJARVIS_SKILLS: Skill[] = ${JSON.stringify(finalSkills, null, 2)} as Skill[];`,
    '',
  ].join('\n');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, serialized, 'utf8');
  process.stdout.write(`Imported ${finalSkills.length} OpenJarvis-related skill(s) -> ${outputPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`[openjarvis-skills] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
