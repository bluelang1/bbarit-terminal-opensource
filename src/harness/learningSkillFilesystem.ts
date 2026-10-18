import { invoke } from '@tauri-apps/api/core';
import type { CliProvider } from './cliRuntime';
import type { LearnedSkillEntry } from './learningRuntime';

const SKILL_ROOT_DIR = '.octo-self-improving/skills';
const VALID_SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

interface FsEntry {
  name: string;
  is_dir: boolean;
}

function normalizeSkillName(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function ensureValidSkillName(name: string): string {
  const normalized = normalizeSkillName(name);
  if (!normalized || !VALID_SKILL_NAME_RE.test(normalized)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return normalized;
}

function skillRootPath(workDir: string): string {
  return `${workDir.replace(/[\\\/]+$/, '')}/${SKILL_ROOT_DIR}`;
}

function skillDirPath(workDir: string, name: string): string {
  return `${skillRootPath(workDir)}/${ensureValidSkillName(name)}`;
}

function skillFilePath(workDir: string, name: string): string {
  return `${skillDirPath(workDir, name)}/SKILL.md`;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = String(content || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key) result[key] = value;
  }
  return result;
}

function buildSkillMarkdown(input: {
  name: string;
  description: string;
  procedure: string;
  cliType?: CliProvider | string;
}): string {
  return [
    '---',
    `name: ${ensureValidSkillName(input.name)}`,
    `description: ${input.description.trim()}`,
    `cliType: ${input.cliType || 'atlascloud'}`,
    'category: self-improving',
    '---',
    '',
    '# Procedure',
    '',
    input.procedure.trim(),
    '',
  ].join('\n');
}

export async function listFileBackedSkills(workDir: string): Promise<LearnedSkillEntry[]> {
  const root = skillRootPath(workDir);
  const dirs = await invoke<FsEntry[]>('read_directory', { path: root }).catch(() => []);
  const out: LearnedSkillEntry[] = [];
  for (const dir of dirs.filter((entry) => entry.is_dir)) {
    const filePath = `${root}/${dir.name}/SKILL.md`;
    const content = await invoke<string>('read_file', { path: filePath }).catch(() => '');
    if (!content.trim()) continue;
    const frontmatter = parseFrontmatter(content);
    const procedure = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
    out.push({
      id: `file:${dir.name}`,
      name: frontmatter.name || dir.name,
      description: frontmatter.description || `File-backed skill ${dir.name}`,
      command: procedure,
      cliType: (frontmatter.cliType || 'atlascloud') as CliProvider,
      category: frontmatter.category || 'self-improving',
      sourceThread: 'file-backed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return out;
}

export async function createOrReplaceFileBackedSkill(params: {
  workDir: string;
  name: string;
  description: string;
  procedure: string;
  cliType?: CliProvider | string;
}): Promise<string> {
  const dir = skillDirPath(params.workDir, params.name);
  await invoke('create_directory', { path: dir });
  const path = skillFilePath(params.workDir, params.name);
  await invoke('write_file', {
    path,
    content: buildSkillMarkdown(params),
  });
  return path;
}

export async function patchFileBackedSkill(params: {
  workDir: string;
  name: string;
  find: string;
  replace: string;
}): Promise<string> {
  const path = skillFilePath(params.workDir, params.name);
  const current = await invoke<string>('read_file', { path });
  if (!current.includes(params.find)) {
    throw new Error(`Pattern not found in ${params.name}`);
  }
  const next = current.replace(params.find, params.replace);
  await invoke('write_file', { path, content: next });
  return path;
}

export async function writeFileBackedSkillAsset(params: {
  workDir: string;
  name: string;
  relativePath: string;
  content: string;
}): Promise<string> {
  const normalizedSkill = ensureValidSkillName(params.name);
  const relative = String(params.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relative || relative.includes('..')) {
    throw new Error('Invalid skill relative path');
  }
  const fullPath = `${skillDirPath(params.workDir, normalizedSkill)}/${relative}`;
  const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
  if (dir) await invoke('create_directory', { path: dir });
  await invoke('write_file', { path: fullPath, content: params.content });
  return fullPath;
}

export async function removeFileBackedSkillAsset(params: {
  workDir: string;
  name: string;
  relativePath: string;
}): Promise<string> {
  const normalizedSkill = ensureValidSkillName(params.name);
  const relative = String(params.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relative || relative.includes('..')) {
    throw new Error('Invalid skill relative path');
  }
  const fullPath = `${skillDirPath(params.workDir, normalizedSkill)}/${relative}`;
  await invoke('delete_path', { path: fullPath });
  return fullPath;
}

export async function deleteFileBackedSkill(workDir: string, name: string): Promise<string> {
  const dir = skillDirPath(workDir, name);
  await invoke('delete_path', { path: dir });
  return dir;
}
