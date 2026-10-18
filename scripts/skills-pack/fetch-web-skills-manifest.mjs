#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const OUTPUT_PATH = path.resolve(process.cwd(), 'public/skills-hub/famous-skills-manifest.json');

const SOURCES = [
  {
    repo: 'anthropics/skills',
    branch: 'main',
    packName: 'anthropic-skills',
    description: 'Anthropic 공식 skills 저장소',
    include: (relPath) => relPath.startsWith('skills/') && /SKILL\.md$/i.test(relPath),
    fallbackCategory: 'official',
  },
  {
    repo: 'anthropics/claude-code',
    branch: 'main',
    packName: 'anthropic-claude-code-official',
    description: 'Anthropic 공식 claude-code 플러그인 스킬',
    include: (relPath) => /plugins\/.+\/skills\/.+\/SKILL\.md$/i.test(relPath),
    fallbackCategory: 'official',
  },
  {
    repo: 'wshobson/agents',
    branch: 'main',
    packName: 'wshobson-agents-core',
    description: 'wshobson/agents 공개 스킬 컬렉션',
    include: (relPath) => /plugins\/.+\/skills\/.+\/SKILL\.md$/i.test(relPath),
    fallbackCategory: 'official',
  },
  {
    repo: 'sickn33/antigravity-awesome-skills',
    branch: 'main',
    packName: 'antigravity-awesome-skills',
    description: 'antigravity-awesome-skills 공개 스킬 모음',
    include: (relPath) => /^skills\/.+\/SKILL\.md$/i.test(relPath),
    fallbackCategory: 'custom',
  },
  {
    repo: 'daymade/claude-code-skills',
    branch: 'main',
    packName: 'daymade-claude-code-skills',
    description: 'daymade/claude-code-skills 공개 스킬 모음',
    include: (relPath) => /\/SKILL\.md$/i.test(relPath) && !relPath.startsWith('.'),
    fallbackCategory: 'custom',
  },
  {
    repo: 'alirezarezvani/claude-skills',
    branch: 'main',
    packName: 'alirezarezvani-claude-skills',
    description: 'alirezarezvani/claude-skills 공개 스킬 모음',
    include: (relPath) => /\/SKILL\.md$/i.test(relPath) && !relPath.startsWith('.'),
    fallbackCategory: 'custom',
  },
  {
    repo: 'levnikolaevich/claude-code-skills',
    branch: 'master',
    packName: 'levnikolaevich-claude-code-skills',
    description: 'levnikolaevich/claude-code-skills 공개 스킬 모음',
    include: (relPath) => /\/SKILL\.md$/i.test(relPath) && !relPath.startsWith('.'),
    fallbackCategory: 'custom',
  },
];

const CATEGORIES = [
  'dev', 'git', 'ai', 'ops', 'custom', 'docker', 'k8s', 'system', 'network',
  'python', 'rust', 'db', 'security', 'testing', 'frontend', 'cloud', 'go',
  'docs', 'official', 'refactor', 'review', 'debug', 'architecture', 'performance',
  'migration', 'cicd', 'react', 'node', 'mobile', 'java', 'api',
];

const CATEGORY_KEYWORDS = [
  ['security', ['security', 'owasp', 'xss', 'injection', 'auth', 'jwt', 'pentest', 'vuln', 'vulnerability', 'threat', 'soc2', 'iso27001', 'compliance']],
  ['testing', ['test', 'testing', 'qa', 'e2e', 'unit', 'integration', 'playwright', 'cypress', 'pytest', 'selenium']],
  ['performance', ['performance', 'perf', 'optimiz', 'latency', 'throughput', 'benchmark', 'profil', 'load-test']],
  ['debug', ['debug', 'trace', 'error', 'bug', 'exception', 'incident', 'troubleshoot', 'root-cause']],
  ['review', ['review', 'audit', 'code-review', 'pr-review', 'peer-review']],
  ['refactor', ['refactor', 'cleanup', 'clean-code', 'restructure', 'debt']],
  ['frontend', ['frontend', 'ui', 'ux', 'css', 'layout', 'animation', 'design', 'webapp', 'landing', 'figma', 'tailwind']],
  ['react', ['react', 'next.js', 'nextjs', 'jsx', 'tsx', 'hook', 'react-router']],
  ['api', ['api', 'rest', 'graphql', 'openapi', 'endpoint', 'rpc', 'swagger', 'postman']],
  ['db', ['database', 'db', 'sql', 'postgres', 'mysql', 'mongo', 'redis', 'query', 'schema']],
  ['python', ['python', 'pandas', 'numpy', 'fastapi', 'django']],
  ['rust', ['rust', 'cargo', 'tokio']],
  ['go', ['golang', 'go', 'gin', 'fiber']],
  ['java', ['java', 'spring', 'jvm', 'maven', 'gradle']],
  ['node', ['node', 'npm', 'pnpm', 'yarn', 'express', 'nestjs']],
  ['docker', ['docker', 'container', 'image', 'dockerfile']],
  ['k8s', ['k8s', 'kubernetes', 'helm', 'istio', 'kubectl']],
  ['cloud', ['cloud', 'aws', 'gcp', 'azure', 'terraform', 'iac']],
  ['cicd', ['ci', 'cd', 'pipeline', 'github actions', 'gitlab-ci', 'jenkins']],
  ['git', ['git', 'github', 'gitlab', 'merge', 'commit', 'rebase']],
  ['docs', ['doc', 'documentation', 'readme', 'adr', 'guide', 'manual', 'wiki']],
  ['architecture', ['architecture', 'system design', 'microservice', 'distributed', 'event-driven', 'domain-driven']],
  ['migration', ['migration', 'migrate', 'upgrade', 'versioning']],
  ['ops', ['ops', 'devops', 'monitor', 'logging', 'alerting', 'sre', 'observability']],
  ['network', ['network', 'tcp', 'udp', 'dns', 'http', 'cdn', 'proxy']],
  ['mobile', ['mobile', 'ios', 'android', 'react-native', 'flutter', 'swift', 'kotlin']],
  ['system', ['linux', 'bash', 'shell', 'systemd', 'kernel', 'terminal', 'cli']],
  ['ai', ['ai', 'llm', 'prompt', 'agent', 'model', 'mcp', 'rag', 'embedding']],
];

const PATH_HINTS = {
  'accessibility-compliance': 'testing',
  'backend-development': 'api',
  'blockchain-web3': 'security',
  'business-analytics': 'docs',
  'cicd-automation': 'cicd',
  'cloud-infrastructure': 'cloud',
  'cloudflare': 'cloud',
  'conductor': 'architecture',
  'cto': 'architecture',
  'ceo': 'docs',
  'data-engineering': 'db',
  'database': 'db',
  'design': 'frontend',
  'designer': 'frontend',
  'devops': 'ops',
  'documentation': 'docs',
  'frontend': 'frontend',
  'fullstack': 'api',
  'git': 'git',
  'growth': 'docs',
  'infrastructure': 'cloud',
  'jira': 'docs',
  'kotlin': 'mobile',
  'kubernetes': 'k8s',
  'llm': 'ai',
  'mcp': 'ai',
  'mobile': 'mobile',
  'network': 'network',
  'node': 'node',
  'observability': 'ops',
  'ops': 'ops',
  'postgres': 'db',
  'prompt': 'ai',
  'project-management': 'docs',
  'python': 'python',
  'react': 'react',
  'revenue': 'docs',
  'rust': 'rust',
  'sales': 'docs',
  'security': 'security',
  'senior-pm': 'docs',
  'site-reliability': 'ops',
  'sre': 'ops',
  'swift': 'mobile',
  'terraform': 'cloud',
  'testing': 'testing',
  'ui': 'frontend',
  'ux': 'frontend',
  'web-development': 'frontend',
};

const CATEGORY_ALIASES = {
  development: 'dev',
  engineering: 'dev',
  gitops: 'git',
  llm: 'ai',
  prompt: 'ai',
  devops: 'ops',
  database: 'db',
  data: 'db',
  frontend: 'frontend',
  backend: 'api',
  architecture: 'architecture',
  design: 'frontend',
  docs: 'docs',
  documentation: 'docs',
  security: 'security',
  testing: 'testing',
  test: 'testing',
  cloud: 'cloud',
  kubernetes: 'k8s',
  docker: 'docker',
  react: 'react',
  node: 'node',
  python: 'python',
  rust: 'rust',
  go: 'go',
  java: 'java',
  mobile: 'mobile',
  migration: 'migration',
  cicd: 'cicd',
  review: 'review',
  debug: 'debug',
  refactor: 'refactor',
  performance: 'performance',
  official: 'official',
  custom: 'custom',
};

const CATEGORY_PRIORITY = [
  'security', 'testing', 'performance', 'debug', 'review', 'refactor', 'architecture',
  'frontend', 'react', 'api', 'db', 'python', 'rust', 'go', 'java', 'node', 'mobile',
  'cloud', 'k8s', 'docker', 'ops', 'network', 'system', 'docs', 'git', 'cicd',
  'migration', 'ai', 'official', 'dev', 'custom',
];

const EMOJI_BY_CATEGORY = {
  dev: '🛠️',
  git: '🌿',
  ai: '🤖',
  ops: '🔧',
  custom: '⚡',
  docker: '🐳',
  k8s: '☸️',
  system: '🖥️',
  network: '🌐',
  python: '🐍',
  rust: '🦀',
  db: '🗄️',
  security: '🛡️',
  testing: '🧪',
  frontend: '🎨',
  cloud: '☁️',
  go: '🐹',
  docs: '📄',
  official: '🏢',
  refactor: '✨',
  review: '👀',
  debug: '🐛',
  architecture: '🏗️',
  performance: '⚡',
  migration: '🔄',
  cicd: '🚀',
  react: '⚛️',
  node: '💚',
  mobile: '📱',
  java: '☕',
  api: '🔌',
};

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
}

function titleFromPath(relPath) {
  const parts = relPath.split('/').filter(Boolean);
  const base = parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1] || 'skill';
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { name: '', description: '', body: content.trim(), category: '', tags: [] };
  }
  const yaml = match[1];
  const body = match[2].trim();
  const fields = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^['"]|['"]$/g, '');
    fields[key] = value;
  }
  const name = String(fields.name || '').trim();
  const description = String(fields.description || '').trim();
  const category = String(fields.category || fields.type || '').trim();
  const tagsInline = String(fields.tags || '').trim();
  const tags = tagsInline
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  return { name, description, body, category, tags };
}

function normalizeCategoryCandidate(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  if (CATEGORIES.includes(raw)) return raw;
  if (CATEGORY_ALIASES[raw]) return CATEGORY_ALIASES[raw];
  const compact = raw.replace(/[^a-z0-9]+/g, '');
  for (const category of CATEGORIES) {
    if (compact === category.replace(/[^a-z0-9]+/g, '')) {
      return category;
    }
  }
  return CATEGORY_ALIASES[compact] || '';
}

function addScore(scores, category, amount) {
  if (!scores.has(category)) return;
  scores.set(category, (scores.get(category) || 0) + amount);
}

function classifyCategory({ repo, relPath, name, description, frontmatterCategory, tags, fallbackCategory }) {
  const scores = new Map(CATEGORIES.map((category) => [category, 0]));
  const text = `${name} ${description} ${relPath} ${(tags || []).join(' ')}`.toLowerCase();
  const tokens = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const pathTokens = relPath.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  const normalizedFrontmatterCategory = normalizeCategoryCandidate(frontmatterCategory);
  if (normalizedFrontmatterCategory) {
    addScore(scores, normalizedFrontmatterCategory, 8);
  }
  for (const tag of tags || []) {
    const mapped = normalizeCategoryCandidate(tag);
    if (mapped) addScore(scores, mapped, 3);
  }

  for (const token of pathTokens) {
    const hint = PATH_HINTS[token];
    if (hint && scores.has(hint)) {
      addScore(scores, hint, 4);
    }
  }

  if (repo === 'anthropics/skills' || repo === 'anthropics/claude-code') {
    addScore(scores, 'official', 4);
  }
  if (repo === 'wshobson/agents') {
    addScore(scores, 'official', 2);
  }

  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    for (const keyword of keywords) {
      const normalizedKeyword = keyword.toLowerCase();
      if (normalizedKeyword.includes(' ') || normalizedKeyword.includes('.') || normalizedKeyword.includes('-')) {
        if (text.includes(normalizedKeyword)) addScore(scores, category, 2);
      } else if (tokens.has(normalizedKeyword)) {
        addScore(scores, category, 2);
      }
    }
  }

  let best = fallbackCategory;
  let bestScore = scores.get(fallbackCategory) || 0;
  const priority = CATEGORY_PRIORITY;
  for (const category of priority) {
    const score = scores.get(category) || 0;
    if (score > bestScore) {
      best = category;
      bestScore = score;
      continue;
    }
    if (score === bestScore && score > 0) {
      const bestPriority = priority.indexOf(best);
      const currentPriority = priority.indexOf(category);
      if (bestPriority < 0 || (currentPriority >= 0 && currentPriority < bestPriority)) {
        best = category;
      }
    }
  }
  return bestScore > 0 ? best : fallbackCategory;
}

async function walkFiles(rootDir, include) {
  const out = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    if (relDir === undefined) break;
    const absDir = path.join(rootDir, relDir);
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push(relPath);
      } else if (entry.isFile() && include(relPath)) {
        out.push(relPath);
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function ensureRepoCheckout(tmpRoot, source) {
  const safeRepo = source.repo.replace(/[^\w.-]+/g, '-');
  const repoDir = path.join(tmpRoot, safeRepo);
  try {
    await fs.access(repoDir);
    runGit(['fetch', '--depth', '1', 'origin', source.branch], repoDir);
    runGit(['checkout', '-f', source.branch], repoDir);
    runGit(['reset', '--hard', `origin/${source.branch}`], repoDir);
    return repoDir;
  } catch {
    await fs.mkdir(tmpRoot, { recursive: true });
    runGit(['clone', '--depth', '1', '--branch', source.branch, `https://github.com/${source.repo}.git`, repoDir], process.cwd());
    return repoDir;
  }
}

async function buildPack(tmpRoot, source) {
  const repoDir = await ensureRepoCheckout(tmpRoot, source);
  const paths = await walkFiles(repoDir, source.include);
  const skills = [];

  for (const relPath of paths) {
    const absPath = path.join(repoDir, relPath);
    const content = await fs.readFile(absPath, 'utf8');
    const parsed = parseFrontmatter(content);
    const name = parsed.name || titleFromPath(relPath);
    const description = parsed.description || `${source.repo} · ${relPath}`;
    const category = classifyCategory({
      repo: source.repo,
      relPath,
      name,
      description,
      frontmatterCategory: parsed.category,
      tags: parsed.tags,
      fallbackCategory: source.fallbackCategory,
    });
    const emoji = EMOJI_BY_CATEGORY[category] || '⚡';
    const rawUrl = `https://raw.githubusercontent.com/${source.repo}/${source.branch}/${relPath}`;
    const shortBody = parsed.body
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith('#'))
      .slice(0, 1)
      .join(' ');
    const command = [
      `Apply the "${name}" skill from ${source.repo}.`,
      `Source: ${rawUrl}`,
      shortBody ? `Context: ${shortBody}` : '',
      'Use it on this codebase and return concrete file-level changes.',
    ].filter(Boolean).join('\n');
    const id = slugify(`web-${source.repo}-${relPath.replace(/\/SKILL\.md$/i, '')}`).replace(/\//g, '-').slice(0, 140);
    const repoTag = source.repo.split('/')[1] || 'web';
    const pathSegments = relPath.replace(/\/SKILL\.md$/i, '').split('/').filter(Boolean);
    const pathTag = pathSegments[0] || 'skills';
    const secondPathTag = pathSegments[1] || '';
    const tags = Array.from(new Set([
      'web',
      repoTag,
      pathTag,
      secondPathTag,
      category,
      'skills-hub',
      ...(parsed.tags || []).map((t) => slugify(t).replace(/\//g, '-')).filter(Boolean),
    ]));

    skills.push({
      id,
      name,
      description,
      emoji,
      command,
      cliType: 'claude',
      category,
      tags,
      builtIn: false,
      originalName: name,
      originalDescription: description,
      originalCommand: command,
    });
  }

  return {
    name: source.packName,
    version: new Date().toISOString().slice(0, 10),
    description: source.description,
    url: `https://github.com/${source.repo}`,
    sourceUrl: `https://github.com/${source.repo}`,
    skillCount: skills.length,
    skills,
  };
}

async function main() {
  const tmpRoot = path.join(os.tmpdir(), 'octo-skills-repos');
  const packs = [];

  for (const source of SOURCES) {
    const pack = await buildPack(tmpRoot, source);
    packs.push(pack);
    process.stdout.write(`Built ${pack.name}: ${pack.skillCount} skills\n`);
  }

  const manifest = {
    schemaVersion: '1.1.0',
    generatedAt: new Date().toISOString(),
    packs,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const total = packs.reduce((acc, pack) => acc + pack.skillCount, 0);
  process.stdout.write(`Wrote ${OUTPUT_PATH} (${packs.length} packs / ${total} skills)\n`);
}

main().catch((err) => {
  process.stderr.write(`[fetch-web-skills-manifest] ${err?.stack || err}\n`);
  process.exit(1);
});
