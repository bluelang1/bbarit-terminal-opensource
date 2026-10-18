import { invoke } from '@tauri-apps/api/core';

export interface HarnessProjectDoc {
  path: string;
  content: string;
  truncated: boolean;
}

export const DEFAULT_PROJECT_DOC_PATHS = [
  'AGENTS.md',
  'CLAUDE.md',
  'CODEX.md',
  'README.md',
  'README.ko.md',
  'README.en.md',
  '.mcp.json',
  'package.json',
  '.codex/AGENTS.md',
  '.codex/instructions.md',
  '.claude/CLAUDE.md',
  '.claude/settings.json',
  '.github/copilot-instructions.md',
  '.cursor/rules',
  '.cursorrules',
  '.windsurfrules',
  'GEMINI.md',
  'QWEN.md',
  'CONTRIBUTING.md',
  'DEVELOPMENT.md',
  'ARCHITECTURE.md',
  'docs/README.md',
  'docs/ARCHITECTURE.md',
  'docs/DEVELOPMENT.md',
  'src-tauri/Cargo.toml',
  'src-tauri/tauri.conf.json',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'netlify.toml',
] as const;

const MAX_DOC_CHARS = 6000;
const MAX_TOTAL_CHARS = 32000;
const DISCOVERED_DOC_LIMIT = 10;

const DISCOVERY_DIRS = [
  '',
  'docs',
  '.github',
  '.cursor/rules',
  '.windsurf/rules',
] as const;

const IMPORTANT_DOC_NAME_RE = /(?:agent|claude|codex|cursor|rules|instruction|readme|contributing|development|architecture|setup|mcp|tauri|vite|package|config)/i;
const READABLE_DOC_EXT_RE = /\.(?:md|mdc|txt|json|toml|yaml|yml)$/i;

function normalizeWorkDir(workDir: string): string {
  return String(workDir || '').trim().replace(/\/+$/, '');
}

function isRemoteWorkDir(workDir: string): boolean {
  return /^ssh:\/\//i.test(String(workDir || '').trim());
}

function joinRelativePath(dir: string, name: string): string {
  return dir ? `${dir.replace(/\/+$/, '')}/${name}` : name;
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const normalized = String(path || '').replace(/^\/+/, '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function truncateText(content: string, limit: number): { content: string; truncated: boolean } {
  const text = String(content || '').trim();
  if (text.length <= limit) return { content: text, truncated: false };
  return {
    content: `${text.slice(0, limit).trimEnd()}\n\n[truncated after ${limit} characters]`,
    truncated: true,
  };
}

async function readProjectDoc(workDir: string, relativePath: string, remainingChars: number): Promise<HarnessProjectDoc | null> {
  if (remainingChars <= 0) return null;
  const baseDir = normalizeWorkDir(workDir);
  if (!baseDir || isRemoteWorkDir(baseDir)) return null;
  const absolutePath = `${baseDir}/${relativePath}`;
  try {
    const raw = await invoke<string>('read_file', { path: absolutePath });
    if (!String(raw || '').trim()) return null;
    const limit = Math.max(0, Math.min(MAX_DOC_CHARS, remainingChars));
    const truncated = truncateText(raw, limit);
    return {
      path: relativePath,
      content: truncated.content,
      truncated: truncated.truncated || String(raw || '').trim().length > limit,
    };
  } catch {
    return null;
  }
}

async function discoverProjectDocPaths(workDir: string): Promise<string[]> {
  const baseDir = normalizeWorkDir(workDir);
  if (!baseDir || isRemoteWorkDir(baseDir)) return [];

  const discovered: string[] = [];
  for (const dir of DISCOVERY_DIRS) {
    if (discovered.length >= DISCOVERED_DOC_LIMIT) break;
    const absoluteDir = dir ? `${baseDir}/${dir}` : baseDir;
    try {
      const entries = await invoke<Array<{ name: string; is_dir: boolean }>>('read_directory', { path: absoluteDir });
      for (const entry of entries) {
        if (discovered.length >= DISCOVERED_DOC_LIMIT) break;
        if (entry.is_dir) continue;
        if (!READABLE_DOC_EXT_RE.test(entry.name) && !['package.json', '.mcp.json', '.cursorrules', '.windsurfrules'].includes(entry.name)) continue;
        if (!IMPORTANT_DOC_NAME_RE.test(entry.name)) continue;
        discovered.push(joinRelativePath(dir, entry.name));
      }
    } catch {
      /* optional discovery */
    }
  }
  return discovered;
}

function safeJsonParse(value: string): any | null {
  try {
    return JSON.parse(String(value || '').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function getPackageJson(docs: HarnessProjectDoc[]): any | null {
  const packageDoc = docs.find(doc => doc.path === 'package.json');
  if (!packageDoc) return null;
  const parsed = safeJsonParse(packageDoc.content);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function collectPackageNames(packageJson: any): Set<string> {
  const names = new Set<string>();
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = packageJson?.[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

function detectStackSignals(docs: HarnessProjectDoc[]): string[] {
  const packageJson = getPackageJson(docs);
  const deps = collectPackageNames(packageJson);
  const paths = new Set(docs.map(doc => doc.path));
  const allText = docs.map(doc => `${doc.path}\n${doc.content.slice(0, 2000)}`).join('\n').toLowerCase();
  const signals: string[] = [];
  const add = (condition: boolean, label: string) => {
    if (condition && !signals.includes(label)) signals.push(label);
  };

  add(deps.has('@tauri-apps/api') || paths.has('src-tauri/Cargo.toml') || paths.has('src-tauri/tauri.conf.json'), 'Tauri desktop app');
  add(deps.has('react') || /react\s+19|react/.test(allText), 'React frontend');
  add(deps.has('vite') || paths.has('vite.config.ts'), 'Vite build pipeline');
  add(deps.has('typescript') || paths.has('tsconfig.json') || paths.has('tsconfig.app.json'), 'TypeScript');
  add(deps.has('xterm') || deps.has('@xterm/xterm') || /xterm/.test(allText), 'xterm.js terminal UI');
  add(deps.has('lucide-react'), 'lucide-react icons');
  add(deps.has('vitest'), 'Vitest tests');
  add(deps.has('electron'), 'Electron/Node desktop code present');
  add(deps.has('next'), 'Next.js');
  add(deps.has('remotion'), 'Remotion video stack');
  add(paths.has('go.mod'), 'Go module');
  add(paths.has('pyproject.toml') || paths.has('requirements.txt'), 'Python tooling');
  add(paths.has('netlify.toml'), 'Netlify config');

  return signals;
}

function formatPackageScripts(docs: HarnessProjectDoc[]): string {
  const packageJson = getPackageJson(docs);
  const scripts = packageJson?.scripts;
  if (!scripts || typeof scripts !== 'object') return '';
  return Object.entries(scripts)
    .slice(0, 14)
    .map(([name, command]) => `- npm run ${name}: ${String(command).slice(0, 140)}`)
    .join('\n');
}

function formatInstructionIndex(docs: HarnessProjectDoc[]): string {
  const instructionDocs = docs
    .filter(doc => /(?:AGENTS|CLAUDE|CODEX|GEMINI|QWEN|rules|instruction|copilot)/i.test(doc.path))
    .map(doc => `- ${doc.path}${doc.truncated ? ' (truncated)' : ''}`);
  return instructionDocs.join('\n');
}

export function formatProjectMap(docs: HarnessProjectDoc[]): string {
  const sections: string[] = [];
  const stackSignals = detectStackSignals(docs);
  const scripts = formatPackageScripts(docs);
  const instructionIndex = formatInstructionIndex(docs);

  if (docs.length > 0) {
    sections.push(`Loaded files:\n${docs.map(doc => `- ${doc.path}${doc.truncated ? ' (truncated)' : ''}`).join('\n')}`);
  }
  if (stackSignals.length > 0) {
    sections.push(`Detected stack:\n${stackSignals.map(signal => `- ${signal}`).join('\n')}`);
  }
  if (scripts) {
    sections.push(`Package scripts:\n${scripts}`);
  }
  if (instructionIndex) {
    sections.push(`Instruction files:\n${instructionIndex}`);
  }

  return sections.length ? `## Auto Project Map\n${sections.join('\n\n')}` : '';
}

export function formatProjectDocsContext(docs: HarnessProjectDoc[]): string {
  if (docs.length === 0) return '';
  const projectMap = formatProjectMap(docs);
  const body = docs.map((doc) => (
    `--- ${doc.path}${doc.truncated ? ' (truncated)' : ''} ---\n${doc.content}`
  )).join('\n\n');

  return `Project default docs were loaded automatically before this turn.
Treat these as current project instructions and configuration. Follow them unless the user explicitly overrides them.
Use the Auto Project Map first, then inspect full file excerpts below when details matter.

${projectMap ? `${projectMap}\n\n` : ''}${body}`;
}

export async function loadHarnessProjectDocs(workDir: string): Promise<HarnessProjectDoc[]> {
  const docs: HarnessProjectDoc[] = [];
  let remainingChars = MAX_TOTAL_CHARS;
  const paths = dedupePaths([
    ...DEFAULT_PROJECT_DOC_PATHS,
    ...await discoverProjectDocPaths(workDir),
  ]);

  for (const relativePath of paths) {
    const doc = await readProjectDoc(workDir, relativePath, remainingChars);
    if (!doc) continue;
    docs.push(doc);
    remainingChars -= doc.content.length;
    if (remainingChars <= 0) break;
  }

  return docs;
}

export async function loadHarnessProjectDocsContext(workDir: string): Promise<string> {
  if (workDir.includes('/BBARIT Projects/') || workDir.includes('\\BBARIT Projects\\')) {
    // 코린이모드 앱 공간에서는 예전 터미널/부모 코드베이스 지침을 자동 주입하지 않는다.
    return '';
  }
  const docs = await loadHarnessProjectDocs(workDir);
  return formatProjectDocsContext(docs);
}
