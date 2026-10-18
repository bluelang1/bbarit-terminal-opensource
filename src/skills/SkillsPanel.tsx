import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { Play, Pencil, Trash2, Upload, Download, Plus, Search, Check, ChevronDown, ChevronUp, FolderPlus, FolderDown, TerminalSquare, FileText, ExternalLink, Wand2, Save } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { Skill, SkillCliType, SkillCategory } from './types';
import { getModelsForCliType } from '../config/modelPresets';
import { useTranslation } from '../i18n';
import './SkillsPanel.css';

const CLI_TYPES: { value: SkillCliType; label: string }[] = [
  { value: 'shell', label: 'Shell' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'qwen', label: 'Qwen' },
  { value: 'pi', label: 'Pi' },
  { value: 'reasonix', label: 'Reasonix' },
];

/** raw.githubusercontent.com URL → GitHub 페이지 URL 변환, 또는 description/command에서 repo URL 추출 */
function getSkillSourceUrl(skill: Skill): string | null {
  // 1. sourceUrl (raw GitHub URL → blob URL)
  if (skill.sourceUrl) {
    const m = skill.sourceUrl.match(/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/(.+)/);
    if (m) return `https://github.com/${m[1]}/blob/${m[2]}/${m[3]}`;
    return skill.sourceUrl;
  }
  // 2. description: "owner/repo · path/to/SKILL.md"
  const descMatch = skill.description?.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*[·|]\s*(.+\/SKILL\.md)/);
  if (descMatch) return `https://github.com/${descMatch[1]}/blob/main/${descMatch[2]}`;
  // 3. command: "Use the 'skill-name' workflow from owner/repo"
  const cmdMatch = skill.command?.match(/^Use the '([^']+)' workflow from ([^\s]+)/);
  if (cmdMatch) return `https://github.com/${cmdMatch[2]}`;
  return null;
}

const openExternalUrl = async (url: string) => {
  const u = String(url || '').trim();
  if (!u) return;
  try {
    await invoke('plugin:shell|open', { path: u });
  } catch {
    window.open(u, '_blank');
  }
};

const CATEGORIES: { value: SkillCategory; label: string; emoji: string }[] = [
  { value: 'official', label: 'Official', emoji: '🏢' },
  { value: 'review', label: 'Review', emoji: '👀' },
  { value: 'debug', label: 'Debug', emoji: '🐛' },
  { value: 'refactor', label: 'Refactor', emoji: '✨' },
  { value: 'testing', label: 'Test', emoji: '🧪' },
  { value: 'performance', label: 'Perf', emoji: '⚡' },
  { value: 'security', label: 'Security', emoji: '🛡️' },
  { value: 'architecture', label: 'Arch', emoji: '🏗️' },
  { value: 'ai', label: 'AI', emoji: '🤖' },
  { value: 'react', label: 'React', emoji: '⚛️' },
  { value: 'frontend', label: 'Frontend', emoji: '🎨' },
  { value: 'api', label: 'API', emoji: '🔌' },
  { value: 'node', label: 'Node', emoji: '💚' },
  { value: 'docs', label: 'Docs', emoji: '📄' },
  { value: 'git', label: 'Git', emoji: '🌿' },
  { value: 'dev', label: 'Dev', emoji: '🛠️' },
  { value: 'migration', label: 'Migration', emoji: '🔄' },
  { value: 'cicd', label: 'CI/CD', emoji: '🚀' },
  { value: 'ops', label: 'Ops', emoji: '🔧' },
  { value: 'cloud', label: 'Cloud', emoji: '☁️' },
  { value: 'docker', label: 'Docker', emoji: '🐳' },
  { value: 'k8s', label: 'K8s', emoji: '☸️' },
  { value: 'system', label: 'System', emoji: '🖥️' },
  { value: 'network', label: 'Network', emoji: '🌐' },
  { value: 'db', label: 'DB', emoji: '🗄️' },
  { value: 'python', label: 'Python', emoji: '🐍' },
  { value: 'java', label: 'Java', emoji: '☕' },
  { value: 'rust', label: 'Rust', emoji: '🦀' },
  { value: 'go', label: 'Go', emoji: '🐹' },
  { value: 'mobile', label: 'Mobile', emoji: '📱' },
  { value: 'custom', label: 'Custom', emoji: '⚡' },
];

const CATEGORY_ORDER: SkillCategory[] = [
  'official', 'review', 'debug', 'refactor', 'testing', 'performance', 'security',
  'architecture', 'ai', 'react', 'frontend', 'api', 'node', 'docs', 'git', 'dev',
  'migration', 'cicd', 'ops', 'cloud', 'docker', 'k8s', 'system', 'network', 'db',
  'python', 'java', 'rust', 'go', 'mobile', 'custom',
];

type GalleryAiFilter = 'all' | 'claude' | 'codex' | 'cursor' | 'opencode' | 'kimi' | 'gemini' | 'ollama' | 'qwen' | 'pi' | 'reasonix' | 'octo';
type SkillBuilderTargets = { app: boolean; agents: boolean; claude: boolean };

const GALLERY_AI_FILTERS: { value: GalleryAiFilter; label: string }[] = [
  { value: 'all', label: 'All AI' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'qwen', label: 'Qwen' },
  { value: 'pi', label: 'Pi' },
  { value: 'reasonix', label: 'Reasonix' },
  { value: 'octo', label: 'Octo' },
];

function hasOctoTag(skill: Skill): boolean {
  return !!skill.tags?.some(t => t.toLowerCase() === 'octo');
}

function getSkillSafetyLabel(skill: Skill): string | null {
  if (!skill.safetyLevel || skill.safetyLevel === 'safe') return null;
  return skill.safetyLevel === 'dangerous' ? 'Quarantined' : 'Caution';
}

function getSkillSafetyTitle(skill: Skill): string {
  const reasons = skill.safetyReasons?.length
    ? skill.safetyReasons.join(', ')
    : 'Imported skill may require extra review before use.';
  const trust = skill.trustLevel ? `Trust: ${skill.trustLevel}. ` : '';
  return `${trust}${reasons}`;
}

function matchGalleryAiFilter(skill: Skill, filter: GalleryAiFilter): boolean {
  if (skill.cliType === 'shell') return false;
  if (filter === 'all') return true;
  if (filter === 'octo') return hasOctoTag(skill);
  return skill.cliType === filter;
}

function yamlQuoted(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, ' ').trim());
}

function firstCommandToken(command: string): string {
  return command.trim().split(/\s+/)[0]?.replace(/[^a-zA-Z0-9._-]/g, '') || 'sh';
}

function addExternalSkillSafetyNote(content: string, skill: Skill): string {
  if (!skill.sourcePack && !skill.sourceUrl) return content;
  const note = [
    '<!--',
    'Octo safety note:',
    'This skill was imported from an external source. Inspect referenced scripts, installers,',
    'network calls, and credential handling before executing them.',
    skill.safetyLevel ? `Safety level: ${skill.safetyLevel}` : '',
    skill.safetyReasons?.length ? `Safety reasons: ${skill.safetyReasons.join(', ')}` : '',
    skill.trustLevel ? `Trust level: ${skill.trustLevel}` : '',
    skill.sourcePack ? `Source pack: ${skill.sourcePack}` : '',
    skill.sourceUrl ? `Source URL: ${skill.sourceUrl}` : '',
    '-->',
    '',
  ].filter(Boolean).join('\n');
  if (content.startsWith('---')) {
    const rest = content.slice(3).replace(/^\r?\n/, '');
    const end = rest.search(/\r?\n---\r?\n/);
    if (end >= 0) {
      const frontmatter = rest.slice(0, end);
      const body = rest.slice(end).replace(/^\r?\n---\r?\n/, '');
      return ['---', frontmatter, '---', '', note, body].join('\n');
    }
  }
  return `${note}${content}`;
}

interface SkillsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  skills: Skill[];
  gallerySkills: Skill[];
  onAdd: (partial: { name: string; description: string; emoji: string; command: string; cliType: SkillCliType; category: SkillCategory; tags?: string[]; model?: string; allowedTools?: string[]; whenToUse?: string; disableModelInvocation?: boolean; paths?: string[]; priority?: number; sourcePack?: string; sourceUrl?: string; originalName?: string; originalCommand?: string; originalDescription?: string; safetyLevel?: Skill['safetyLevel']; safetyReasons?: string[]; trustLevel?: Skill['trustLevel'] }) => void;
  onUpdate: (id: string, updates: Partial<Omit<Skill, 'id' | 'builtIn'>>) => void;
  onRemove: (id: string) => void;
  onRun: (skill: Skill) => void;
  onExport: () => string;
  onImport: (json: string) => void;
  currentStyle?: { bg: string; text: string; accent: string };
  projectPath?: string;
  builderOpenRequest?: number;
}

export function SkillsPanel({
  isOpen,
  onClose,
  skills,
  gallerySkills,
  onAdd,
  onUpdate,
  onRemove,
  onRun,
  onExport,
  onImport,
  currentStyle,
  projectPath,
  builderOpenRequest = 0,
}: SkillsPanelProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'my' | 'gallery'>('my');
  const [formEmoji, setFormEmoji] = useState('');
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formCmd, setFormCmd] = useState('');
  const [formCliType, setFormCliType] = useState<SkillCliType>('shell');
  const [formCategory, setFormCategory] = useState<SkillCategory>('custom');
  const [formModel, setFormModel] = useState('');
  const [formAllowedTools, setFormAllowedTools] = useState('');
  const [formWhenToUse, setFormWhenToUse] = useState('');
  const [formPaths, setFormPaths] = useState('');
  const [formPriority, setFormPriority] = useState('');
  const [formDisableModelInvocation, setFormDisableModelInvocation] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Quick create state ──
  const [quickInput, setQuickInput] = useState('');
  const [quickSlug, setQuickSlug] = useState('');
  const [quickCli, setQuickCli] = useState<SkillCliType>('claude');
  const [quickCreating, setQuickCreating] = useState(false);
  const [quickMsg, setQuickMsg] = useState('');
  const [projectInstallResult, setProjectInstallResult] = useState<{ type: 'ok' | 'error'; msg: string } | null>(null);
  const [installingToProject, setInstallingToProject] = useState<Set<string>>(new Set());
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderSaving, setBuilderSaving] = useState(false);
  const [builderResult, setBuilderResult] = useState<{ type: 'ok' | 'error'; msg: string } | null>(null);
  const [builderIdea, setBuilderIdea] = useState('');
  const [builderName, setBuilderName] = useState('');
  const [builderDesc, setBuilderDesc] = useState('');
  const [builderBody, setBuilderBody] = useState('');
  const [builderEmoji, setBuilderEmoji] = useState('✨');
  const [builderCliType, setBuilderCliType] = useState<SkillCliType>('codex');
  const [builderCategory, setBuilderCategory] = useState<SkillCategory>('custom');
  const [builderTags, setBuilderTags] = useState('');
  const [builderTargets, setBuilderTargets] = useState<SkillBuilderTargets>({ app: true, agents: false, claude: false });
  const builderOpenRequestSeenRef = useRef(0);

  const normalizedProjectPath = useMemo(
    () => (projectPath || '').trim().replace(/[\\/]+$/g, ''),
    [projectPath],
  );
  const hasProjectPath = normalizedProjectPath.length > 0;

  const slugifyAscii = useCallback((text: string): string => {
    return text
      .replace(/[^\x20-\x7E]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[/\\:*?"<>|()]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
  }, []);

  /** Generate ASCII slug — strips non-ASCII (Korean etc), keeps latin+digits */
  const toAsciiSlug = useCallback((text: string): string => {
    return slugifyAscii(text) || `skill-${Date.now()}`;
  }, [slugifyAscii]);

  const inferCategory = useCallback((text: string): SkillCategory => {
    const q = text.toLowerCase();
    if (/(test|테스트|qa|playwright|vitest|pytest)/.test(q)) return 'testing';
    if (/(security|보안|audit|취약|owasp|secret)/.test(q)) return 'security';
    if (/(react|frontend|ui|css|design|화면|프론트)/.test(q)) return 'frontend';
    if (/(api|server|backend|node|express|fastapi)/.test(q)) return 'api';
    if (/(db|database|sql|postgres|redis)/.test(q)) return 'db';
    if (/(deploy|ci|cd|github action|release|배포)/.test(q)) return 'cicd';
    if (/(review|리뷰|검토)/.test(q)) return 'review';
    if (/(debug|bug|버그|오류|디버그)/.test(q)) return 'debug';
    if (/(doc|readme|문서|글)/.test(q)) return 'docs';
    return 'custom';
  }, []);

  const builderSafeName = useMemo(() => {
    return slugifyAscii(builderName) || slugifyAscii(builderIdea.split('\n')[0] || '');
  }, [builderName, builderIdea, slugifyAscii]);

  const buildSkillMarkdown = useCallback((skill: Skill, safeName: string, target: 'agents' | 'claude') => {
    const description = (skill.description || skill.name).slice(0, 1024);
    const frontmatter = [
      '---',
      `name: ${safeName}`,
      `description: ${yamlQuoted(description)}`,
    ];
    if (target === 'claude') {
      const allowedTools = skill.cliType === 'shell'
        ? `allowed-tools: Bash(${firstCommandToken(skill.command)} *)`
        : 'allowed-tools: Read, Grep, Glob, Bash, Edit, Write';
      frontmatter.push(allowedTools);
    } else if (skill.allowedTools?.length) {
      frontmatter.push(`allowedTools: [${skill.allowedTools.map(tool => yamlQuoted(tool)).join(', ')}]`);
    }
    if (skill.model) frontmatter.push(`model: ${yamlQuoted(skill.model)}`);
    if (skill.priority != null) frontmatter.push(`priority: ${skill.priority}`);
    if (skill.whenToUse) frontmatter.push(`when_to_use: ${yamlQuoted(skill.whenToUse)}`);
    if (skill.disableModelInvocation) frontmatter.push('disable-model-invocation: true');
    if (skill.paths?.length) {
      frontmatter.push('paths:');
      skill.paths.forEach(path => frontmatter.push(`  - ${yamlQuoted(path)}`));
    }
    if (skill.sourcePack || skill.sourceUrl || skill.originalName) {
      frontmatter.push('metadata:');
      frontmatter.push('  openjarvis:');
      if (skill.sourcePack) frontmatter.push(`    source: ${yamlQuoted(skill.sourcePack)}`);
      if (skill.sourceUrl) frontmatter.push(`    source_url: ${yamlQuoted(skill.sourceUrl)}`);
      if (skill.originalName) frontmatter.push(`    original_name: ${yamlQuoted(skill.originalName)}`);
      if (skill.trustLevel) frontmatter.push(`    trust_level: ${yamlQuoted(skill.trustLevel)}`);
      if (skill.safetyLevel) frontmatter.push(`    safety_level: ${yamlQuoted(skill.safetyLevel)}`);
      if (skill.safetyReasons?.length) {
        frontmatter.push('    safety_reasons:');
        skill.safetyReasons.forEach(reason => frontmatter.push(`      - ${yamlQuoted(reason)}`));
      }
    }
    return [...frontmatter, '---', '', skill.command.trim(), ''].join('\n');
  }, []);

  const writeSkillToSelectedProjectTargets = useCallback(async (
    skill: Skill,
    safeName: string,
    targets: Pick<SkillBuilderTargets, 'agents' | 'claude'>,
  ) => {
    if (!hasProjectPath) {
      throw new Error(t('skills.noActiveProject'));
    }
    if (targets.claude) {
      const claudeDir = `${normalizedProjectPath}/.claude/skills/${safeName}`;
      await invoke('create_directory', { path: claudeDir });
      await invoke('write_file', { path: `${claudeDir}/SKILL.md`, content: buildSkillMarkdown(skill, safeName, 'claude') });
    }
    if (targets.agents) {
      const codexDir = `${normalizedProjectPath}/.agents/skills/${safeName}`;
      await invoke('create_directory', { path: codexDir });
      await invoke('write_file', { path: `${codexDir}/SKILL.md`, content: buildSkillMarkdown(skill, safeName, 'agents') });
    }
  }, [hasProjectPath, normalizedProjectPath, buildSkillMarkdown, t]);

  const handleQuickCreate = useCallback(async () => {
    const text = quickInput.trim();
    if (!text || quickCreating) return;

    const slug = quickSlug.trim() ? toAsciiSlug(quickSlug.trim()) : `skill-${Date.now()}`;
    if (!slug) return;

    setQuickCreating(true);
    setQuickMsg('');

    const isAi = quickCli !== 'shell';
    const displayName = text.split('\n')[0].slice(0, 40);

    // 1) Add to app skill list
    onAdd({
      name: slug,
      description: displayName,
      emoji: isAi ? '🤖' : '⚡',
      command: text,
      cliType: quickCli,
      category: 'custom',
    });

    // 2) Save to project if path available
    if (hasProjectPath) {
      const allowedTools = isAi
        ? 'allowed-tools: Read, Grep, Glob, Bash, Edit, Write'
        : `allowed-tools: Bash(${text.split(' ')[0]} *)`;

      // Claude: .claude/skills/<slug>/SKILL.md  —  invoke with /slug
      const claudeDir = `${normalizedProjectPath}/.claude/skills/${slug}`;
      const claudeMd = ['---', `name: ${slug}`, `description: ${displayName}`, allowedTools, '---', '', text, ''].join('\n');

      // Codex: .agents/skills/<slug>/SKILL.md  —  invoke with $slug
      const codexDir = `${normalizedProjectPath}/.agents/skills/${slug}`;
      const codexMd = ['---', `name: ${slug}`, `description: ${displayName}`, '---', '', text, ''].join('\n');

      try {
        await invoke('create_directory', { path: claudeDir });
        await invoke('write_file', { path: `${claudeDir}/SKILL.md`, content: claudeMd });
        await invoke('create_directory', { path: codexDir });
        await invoke('write_file', { path: `${codexDir}/SKILL.md`, content: codexMd });
      } catch (err) {
        console.error('[skill-quick-create] project save failed:', err);
      }
    }

    setQuickInput('');
    setQuickSlug('');
    setQuickCreating(false);
    const prefix = quickCli === 'codex' ? '$' : '/';
    const hint = hasProjectPath
      ? t('skills.createdBoth').replace('{name}', slug)
      : t('skills.addedToApp').replace('{prefix}', prefix).replace('{name}', slug);
    setQuickMsg(hint);
    setTimeout(() => setQuickMsg(''), 4000);
  }, [quickInput, quickSlug, quickCli, quickCreating, hasProjectPath, normalizedProjectPath, onAdd, toAsciiSlug, t]);

  const openSkillBuilder = useCallback(() => {
    setBuilderOpen(true);
    setBuilderResult(null);
    setBuilderTargets({ app: true, agents: hasProjectPath, claude: hasProjectPath });
  }, [hasProjectPath]);

  useEffect(() => {
    if (!isOpen || !builderOpenRequest || builderOpenRequestSeenRef.current === builderOpenRequest) return;
    builderOpenRequestSeenRef.current = builderOpenRequest;
    openSkillBuilder();
  }, [isOpen, builderOpenRequest, openSkillBuilder]);

  const handleBuilderDraft = useCallback(() => {
    const idea = builderIdea.trim();
    if (!idea) return;
    const firstLine = idea.split('\n').find(Boolean)?.trim() || idea;
    const guessedName = builderName.trim() || firstLine.replace(/[.!?。！？]+$/g, '').slice(0, 54);
    const nextCli = builderCliType;
    setBuilderName(guessedName);
    setBuilderDesc(builderDesc.trim() || idea.replace(/\s+/g, ' ').slice(0, 180));
    setBuilderCategory(builderCategory === 'custom' ? inferCategory(idea) : builderCategory);
    setBuilderEmoji(builderEmoji.trim() || (nextCli === 'shell' ? '⚡' : '✨'));
    if (!builderBody.trim()) {
      if (nextCli === 'shell') {
        setBuilderBody(idea);
      } else {
        setBuilderBody([
          `Use this skill when the user asks for: ${idea}`,
          '',
          'First clarify the concrete goal only if the request is ambiguous.',
          'Inspect the relevant files before changing code.',
          'Make focused changes, verify them, and report the result with file references.',
        ].join('\n'));
      }
    }
    if (!builderTags.trim()) {
      const inferred = inferCategory(idea);
      setBuilderTags(['custom', inferred].filter((v, i, arr) => arr.indexOf(v) === i).join(', '));
    }
  }, [builderIdea, builderName, builderDesc, builderCliType, builderCategory, builderEmoji, builderBody, builderTags, inferCategory]);

  const builderSkill = useMemo<Skill>(() => {
    const name = builderName.trim() || 'New Skill';
    return {
      id: builderSafeName || 'new-skill',
      name,
      description: builderDesc.trim() || name,
      emoji: builderEmoji.trim() || (builderCliType === 'shell' ? '⚡' : '✨'),
      command: builderBody.trim(),
      cliType: builderCliType,
      category: builderCategory,
      tags: builderTags.split(',').map(tag => tag.trim()).filter(Boolean),
      allowedTools: [],
      paths: [],
      priority: 0,
      builtIn: false,
    };
  }, [builderName, builderSafeName, builderDesc, builderEmoji, builderBody, builderCliType, builderCategory, builderTags]);

  const builderValidation = useMemo(() => {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!builderName.trim()) errors.push(t('skills.builder.errName'));
    if (!builderBody.trim()) errors.push(t('skills.builder.errBody'));
    if (builderDesc.length > 1024) errors.push(t('skills.builder.errDescLength'));
    if (!builderTargets.app && !builderTargets.agents && !builderTargets.claude) errors.push(t('skills.builder.errTargets'));
    if ((builderTargets.agents || builderTargets.claude) && !hasProjectPath) errors.push(t('skills.builder.errNeedProject'));
    if (!builderSafeName) warnings.push(t('skills.builder.warnNoSlug'));
    if (builderCliType === 'shell' && /\n/.test(builderBody.trim())) warnings.push(t('skills.builder.warnShellMultiline'));
    return { errors, warnings };
  }, [builderName, builderBody, builderDesc, builderTargets, hasProjectPath, builderSafeName, builderCliType, t]);

  const builderPreview = useMemo(() => {
    const safeName = builderSafeName || 'skill-name';
    return buildSkillMarkdown(builderSkill, safeName, builderTargets.claude ? 'claude' : 'agents');
  }, [builderSkill, builderSafeName, builderTargets.claude, buildSkillMarkdown]);

  const handleBuilderSave = useCallback(async () => {
    if (builderSaving || builderValidation.errors.length > 0) return;
    setBuilderSaving(true);
    setBuilderResult(null);
    const safeName = builderSafeName || `skill-${Date.now()}`;
    const skill: Skill = { ...builderSkill, id: safeName };
    try {
      if (builderTargets.app) {
        onAdd({
          name: skill.name,
          description: skill.description,
          emoji: skill.emoji,
          command: skill.command,
          cliType: skill.cliType,
          category: skill.category,
          tags: skill.tags,
        });
      }
      if (builderTargets.agents || builderTargets.claude) {
        await writeSkillToSelectedProjectTargets(skill, safeName, {
          agents: builderTargets.agents,
          claude: builderTargets.claude,
        });
        setSavedToProject(prev => new Set(prev).add(skill.id));
      }
      setBuilderResult({ type: 'ok', msg: t('skills.builder.saveDone').replace('{name}', safeName) });
      setProjectInstallResult({ type: 'ok', msg: t('skills.builder.saveDone').replace('{name}', safeName) });
      setTimeout(() => setProjectInstallResult(null), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBuilderResult({ type: 'error', msg });
      setProjectInstallResult({ type: 'error', msg });
    } finally {
      setBuilderSaving(false);
    }
  }, [builderSaving, builderValidation.errors.length, builderSafeName, builderSkill, builderTargets, onAdd, writeSkillToSelectedProjectTargets, t]);

  // Gallery state
  const [gallerySearch, setGallerySearch] = useState('');
  const [galleryFilter, setGalleryFilter] = useState<SkillCategory | 'all'>('all');
  const [galleryType, setGalleryType] = useState<'shell' | 'ai'>('shell');
  const [galleryAiFilter, setGalleryAiFilter] = useState<GalleryAiFilter>('all');

  const resetForm = useCallback(() => {
    setFormEmoji('');
    setFormName('');
    setFormDesc('');
    setFormCmd('');
    setFormCliType('shell');
    setFormCategory('custom');
    setFormModel('');
    setFormAllowedTools('');
    setFormWhenToUse('');
    setFormPaths('');
    setFormPriority('');
    setFormDisableModelInvocation(false);
    setEditingId(null);
  }, []);

  const handleSubmit = useCallback(() => {
    const name = formName.trim();
    const command = formCmd.trim();
    if (!name || !command) return;

    const emoji = formEmoji.trim() || '⚡';
    const description = formDesc.trim();

    const model = formModel.trim() || undefined;
    const allowedTools = formAllowedTools.split(',').map(item => item.trim()).filter(Boolean);
    const paths = formPaths.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
    const priorityRaw = formPriority.trim();
    const priority = priorityRaw && Number.isFinite(Number(priorityRaw)) ? Number(priorityRaw) : undefined;
    const metadata = {
      model,
      allowedTools,
      whenToUse: formWhenToUse.trim() || undefined,
      disableModelInvocation: formDisableModelInvocation,
      paths,
      priority,
    };
    if (editingId) {
      onUpdate(editingId, { name, description, emoji, command, cliType: formCliType, category: formCategory, ...metadata });
    } else {
      onAdd({ name, description, emoji, command, cliType: formCliType, category: formCategory, ...metadata });
    }
    resetForm();
  }, [formName, formCmd, formEmoji, formDesc, formCliType, formCategory, formModel, formAllowedTools, formWhenToUse, formPaths, formPriority, formDisableModelInvocation, editingId, onAdd, onUpdate, resetForm]);

  const handleEdit = useCallback((skill: Skill) => {
    setEditingId(skill.id);
    setFormEmoji(skill.emoji);
    setFormName(skill.name);
    setFormDesc(skill.description);
    setFormCmd(skill.command);
    setFormCliType(skill.cliType);
    setFormCategory(skill.category);
    setFormModel(skill.model || '');
    setFormAllowedTools((skill.allowedTools || []).join(', '));
    setFormWhenToUse(skill.whenToUse || '');
    setFormPaths((skill.paths || []).join('\n'));
    setFormPriority(skill.priority != null ? String(skill.priority) : '');
    setFormDisableModelInvocation(!!skill.disableModelInvocation);
    setActiveTab('my');
  }, []);

  const handleExport = useCallback(() => {
    const json = onExport();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'octo-skills.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [onExport]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = ev.target?.result as string;
        onImport(json);
      } catch {
        // ignore import errors
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [onImport]);

  // Existing skill IDs for checking duplicates
  const existingSkillCommands = useMemo(() => new Set(skills.map(s => s.command)), [skills]);

  /** Try to fetch the original SKILL.md from GitHub */
  const fetchRemoteSkillMd = useCallback(async (skill: Skill): Promise<string | null> => {
    const tryFetch = async (url: string): Promise<string | null> => {
      try {
        const res = await invoke<{ status: number; body: string }>('http_request', {
          input: { method: 'GET', url, headers: {}, body: '' },
        });
        if (res.status >= 200 && res.status < 300 && res.body.length > 50) return res.body;
      } catch { /* ignore */ }
      return null;
    };

    // 1. sourceUrl takes precedence
    if (skill.sourceUrl) {
      const r = await tryFetch(skill.sourceUrl);
      if (r) return r;
    }

    // 2. Parse "owner/repo · path/to/SKILL.md" from description
    const descMatch = skill.description.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*[·|]\s*(.+\/SKILL\.md)/);
    if (descMatch) {
      const [, ownerRepo, filePath] = descMatch;
      for (const branch of ['main', 'master']) {
        const r = await tryFetch(`https://raw.githubusercontent.com/${ownerRepo}/${branch}/${filePath}`);
        if (r) return r;
      }
    }

    // 3. Parse "Use the 'skill-name' workflow from owner/repo" from command
    const cmdMatch = skill.command.match(/^Use the '([^']+)' workflow from ([^\s]+)/);
    if (cmdMatch) {
      const [, skillSlug, ownerRepo] = cmdMatch;
      const patterns = [
        `skills/${skillSlug}/SKILL.md`,
        `${skillSlug}/SKILL.md`,
        `plugins/${skillSlug}/SKILL.md`,
      ];
      for (const branch of ['main', 'master']) {
        for (const p of patterns) {
          const r = await tryFetch(`https://raw.githubusercontent.com/${ownerRepo}/${branch}/${p}`);
          if (r) return r;
        }
      }
    }

    return null;
  }, []);

  /** Write SKILL.md to .claude/skills/ + .agents/skills/ */
  const writeSkillToProject = useCallback(async (skill: Skill) => {
    if (!hasProjectPath) {
      throw new Error(t('skills.noActiveProject'));
    }
    const installName = skill.originalName || skill.name;
    const installDesc = skill.originalDescription || skill.description || skill.name;
    const safeName = slugifyAscii(installName) || slugifyAscii(skill.id) || `skill-${Date.now()}`;
    const isAiSkill = skill.cliType !== 'shell';

    // Try to fetch the real SKILL.md from GitHub
    let remoteContent: string | null = null;
    const hasRemoteHint = skill.sourceUrl
      || skill.tags?.includes('web') || skill.tags?.includes('curated')
      || /[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\s*[·|]\s*.+\/SKILL\.md/.test(skill.description)
      || /^Use the '[^']+' workflow from /.test(skill.command);
    if (hasRemoteHint) {
      try {
        remoteContent = await fetchRemoteSkillMd(skill);
      } catch { /* ignore, fall back to local command */ }
    }

    if (remoteContent) {
      const safeRemoteContent = addExternalSkillSafetyNote(remoteContent, skill);
      // Use the fetched content as-is (it already has frontmatter)
      if (hasProjectPath) {
        const claudeDir = `${normalizedProjectPath}/.claude/skills/${safeName}`;
        const codexDir = `${normalizedProjectPath}/.agents/skills/${safeName}`;
        await invoke('create_directory', { path: claudeDir });
        await invoke('write_file', { path: `${claudeDir}/SKILL.md`, content: safeRemoteContent });
        await invoke('create_directory', { path: codexDir });
        await invoke('write_file', { path: `${codexDir}/SKILL.md`, content: safeRemoteContent });
      }
    } else {
      // Fallback: generate from local command text
      const installCommand = skill.originalCommand || skill.command;
      await writeSkillToSelectedProjectTargets({
        ...skill,
        name: installName,
        description: installDesc,
        command: installCommand,
        cliType: isAiSkill ? skill.cliType : 'shell',
      }, safeName, { agents: true, claude: true });
    }

    return { safeName };
  }, [hasProjectPath, normalizedProjectPath, slugifyAscii, fetchRemoteSkillMd, writeSkillToSelectedProjectTargets, t]);

  /** Add to app skill list (dedup check) */
  const addToAppIfNew = useCallback((skill: Skill) => {
    if (!existingSkillCommands.has(skill.command)) {
      onAdd({
        name: skill.name,
        description: skill.description,
        emoji: skill.emoji,
        command: skill.command,
        cliType: skill.cliType,
        category: skill.category,
        tags: skill.tags,
        model: skill.model,
        allowedTools: skill.allowedTools,
        whenToUse: skill.whenToUse,
        disableModelInvocation: skill.disableModelInvocation,
        paths: skill.paths,
        priority: skill.priority,
        sourcePack: skill.sourcePack,
        sourceUrl: skill.sourceUrl,
        originalName: skill.originalName,
        originalCommand: skill.originalCommand,
        originalDescription: skill.originalDescription,
        safetyLevel: skill.safetyLevel,
        safetyReasons: skill.safetyReasons,
        trustLevel: skill.trustLevel,
      });
    }
  }, [onAdd, existingSkillCommands]);

  const handleGalleryAdd = useCallback(async (gallerySkill: Skill) => {
    // 앱 + 프로젝트 동시 추가
    addToAppIfNew(gallerySkill);
    if (!hasProjectPath) return;
    try {
      const { safeName } = await writeSkillToProject(gallerySkill);
      setSavedToProject(prev => new Set(prev).add(gallerySkill.id));
      setProjectInstallResult({ type: 'ok', msg: t('skills.installSuccess').replace('{name}', safeName) });
      setTimeout(() => setProjectInstallResult(null), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setProjectInstallResult({ type: 'error', msg: t('skills.installFail').replace('{msg}', msg) });
      setTimeout(() => setProjectInstallResult(null), 5000);
    }
  }, [addToAppIfNew, hasProjectPath, writeSkillToProject, t]);

  // Track which skills have been saved to project
  const [savedToProject, setSavedToProject] = useState<Set<string>>(new Set());

  const handleSaveToProject = useCallback(async (skill: Skill) => {
    if (!hasProjectPath) {
      setProjectInstallResult({ type: 'error', msg: t('skills.selectProjectFirst') });
      setTimeout(() => setProjectInstallResult(null), 4000);
      return;
    }
    if (installingToProject.has(skill.id)) return;
    setInstallingToProject(prev => new Set(prev).add(skill.id));
    try {
      const { safeName } = await writeSkillToProject(skill);
      // 프로젝트 설치 시 앱 스킬에도 자동 추가
      addToAppIfNew(skill);
      setSavedToProject(prev => new Set(prev).add(skill.id));
      setProjectInstallResult({ type: 'ok', msg: t('skills.installSuccess').replace('{name}', safeName) });
      setTimeout(() => setProjectInstallResult(null), 3000);
    } catch (err) {
      console.error('Failed to save skill to project:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setProjectInstallResult({ type: 'error', msg: t('skills.installFail').replace('{msg}', msg) });
      setTimeout(() => setProjectInstallResult(null), 5000);
    } finally {
      setInstallingToProject(prev => {
        const next = new Set(prev);
        next.delete(skill.id);
        return next;
      });
    }
  }, [hasProjectPath, installingToProject, writeSkillToProject, addToAppIfNew, t]);

  // ── Import skills from project (.claude/skills/ + .agents/skills/) ──
  const [importingFromProject, setImportingFromProject] = useState(false);
  const [importResult, setImportResult] = useState<{ count: number; msg: string } | null>(null);

  const handleImportFromProject = useCallback(async () => {
    if (!hasProjectPath || importingFromProject) return;
    setImportingFromProject(true);
    setImportResult(null);

    const imported: { name: string; description: string; emoji: string; command: string; cliType: SkillCliType; category: SkillCategory }[] = [];
    const existingNames = new Set(skills.map(s => s.name.toLowerCase()));

    const scanDir = async (basePath: string, cliType: SkillCliType) => {
      try {
        const entries: { name: string; is_dir: boolean }[] = await invoke('read_directory', { path: basePath });
        for (const entry of entries) {
          if (!entry.is_dir) continue;
          const skillMdPath = `${basePath}/${entry.name}/SKILL.md`;
          try {
            const content: string = await invoke('read_file', { path: skillMdPath });
            // Parse YAML frontmatter
            const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
            if (!fmMatch) continue;
            const yaml = fmMatch[1];
            const body = fmMatch[2].trim();

            const nameMatch = yaml.match(/^name:\s*(.+)$/m);
            const descMatch = yaml.match(/^description:\s*(.+)$/m);
            const skillName = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : entry.name;
            const skillDesc = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : '';

            // Skip if already exists
            if (existingNames.has(skillName.toLowerCase()) || existingNames.has(entry.name.toLowerCase())) continue;

            imported.push({
              name: skillName,
              description: skillDesc,
              emoji: cliType === 'claude' ? '🤖' : cliType === 'codex' ? '🧠' : '⚡',
              command: body || skillDesc,
              cliType,
              category: 'custom',
            });
            existingNames.add(skillName.toLowerCase());
          } catch {
            // SKILL.md not found or unreadable, skip
          }
        }
      } catch {
        // Directory doesn't exist, skip
      }
    };

    try {
      await scanDir(`${normalizedProjectPath}/.claude/skills`, 'claude');
      await scanDir(`${normalizedProjectPath}/.agents/skills`, 'codex');

      if (imported.length > 0) {
        for (const s of imported) onAdd(s);
        setImportResult({ count: imported.length, msg: t('skills.importedCount').replace('{count}', String(imported.length)) });
      } else {
        setImportResult({ count: 0, msg: t('skills.noSkillsToImport') });
      }
    } catch (err) {
      setImportResult({ count: 0, msg: t('skills.importError').replace('{err}', String(err)) });
    } finally {
      setImportingFromProject(false);
      setTimeout(() => setImportResult(null), 3000);
    }
  }, [hasProjectPath, importingFromProject, skills, onAdd, normalizedProjectPath, t]);

  // ── Reset project skills ──
  const [resettingProjectSkills, setResettingProjectSkills] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);

  const handleResetProjectSkills = useCallback(async () => {
    if (resettingProjectSkills) return;
    setResettingProjectSkills(true);
    setProjectInstallResult(null);

    const deleteDirRecursive = async (basePath: string) => {
      try {
        const entries: { name: string; is_dir: boolean }[] = await invoke('read_directory', { path: basePath });
        for (const entry of entries) {
          if (!entry.is_dir) continue;
          const skillDir = `${basePath}/${entry.name}`;
          await invoke('delete_path', { path: skillDir });
        }
      } catch {
        // Directory doesn't exist, that's fine
      }
    };

    try {
      if (hasProjectPath) {
        await deleteDirRecursive(`${normalizedProjectPath}/.claude/skills`);
        await deleteDirRecursive(`${normalizedProjectPath}/.agents/skills`);
      }
      setSavedToProject(new Set());
      setProjectInstallResult({ type: 'ok', msg: t('skills.projectSkillsReset') });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setProjectInstallResult({ type: 'error', msg: t('skills.resetFail').replace('{msg}', msg) });
    } finally {
      setResettingProjectSkills(false);
      setResetConfirm(false);
      setTimeout(() => setProjectInstallResult(null), 3000);
    }
  }, [hasProjectPath, resettingProjectSkills, normalizedProjectPath, t]);

  // Gallery base pool (type + AI CLI filter)
  const galleryBase = useMemo(() => {
    let list = gallerySkills.filter(s => galleryType === 'shell' ? s.cliType === 'shell' : s.cliType !== 'shell');
    if (galleryType === 'ai' && galleryAiFilter !== 'all') {
      list = list.filter(s => matchGalleryAiFilter(s, galleryAiFilter));
    }
    return list;
  }, [gallerySkills, galleryType, galleryAiFilter]);

  // Filtered gallery skills (base + category + search)
  const filteredGallery = useMemo(() => {
    let list = galleryBase;
    if (galleryFilter !== 'all') {
      list = list.filter(s => s.category === galleryFilter);
    }
    if (gallerySearch.trim()) {
      const q = gallerySearch.trim().toLowerCase();
      list = list.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        s.tags?.some(t => t.toLowerCase().includes(q))
      );
    }
    return list;
  }, [galleryBase, galleryFilter, gallerySearch]);

  // Counts for gallery type toggle
  const shellCount = useMemo(() => gallerySkills.filter(s => s.cliType === 'shell').length, [gallerySkills]);
  const aiCount = useMemo(() => gallerySkills.filter(s => s.cliType !== 'shell').length, [gallerySkills]);
  const galleryAiFilterLabel = useMemo(
    () => galleryAiFilter === 'all' ? t('skills.allAi') : (GALLERY_AI_FILTERS.find(f => f.value === galleryAiFilter)?.label || t('skills.allAi')),
    [galleryAiFilter, t]
  );

  // Group gallery by category
  const galleryGrouped = useMemo(() => {
    return CATEGORY_ORDER
      .map(cat => ({
        category: cat,
        label: CATEGORIES.find(c => c.value === cat)?.label || cat,
        emoji: CATEGORIES.find(c => c.value === cat)?.emoji || '',
        items: filteredGallery.filter(s => s.category === cat),
      }))
      .filter(g => g.items.length > 0);
  }, [filteredGallery]);

  // Group skills by category
  const grouped = CATEGORY_ORDER
    .map(cat => ({
      category: cat,
      label: CATEGORIES.find(c => c.value === cat)?.label || cat,
      items: skills.filter(s => s.category === cat),
    }))
    .filter(g => g.items.length > 0);

  if (!isOpen) return null;

  const style = currentStyle || { bg: '#1e1e2e', text: '#cdd6f4', accent: '#89b4fa' };

  return (
    <div className="skills-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="skills-panel"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          '--skills-bg': style.bg,
          '--skills-text': style.text,
          '--skills-accent': style.accent,
        } as React.CSSProperties}
      >
        {/* Header */}
        <div className="skills-header">
          <h3>{t('skills.title')}</h3>
          <div className="skills-tab-bar">
            <button
              className={`skills-tab-btn ${activeTab === 'my' ? 'active' : ''}`}
              onClick={() => setActiveTab('my')}
            >
              {t('skills.mySkills')} ({skills.length})
            </button>
            <button
              className={`skills-tab-btn ${activeTab === 'gallery' ? 'active' : ''}`}
              onClick={() => setActiveTab('gallery')}
            >
              {t('skills.gallery')}
            </button>
          </div>
          <button
            className="skills-builder-open"
            onClick={openSkillBuilder}
            title={t('skills.builder.title')}
          >
            <Wand2 size={13} /> {t('skills.builder.openBtn')}
          </button>
          {resetConfirm ? (
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <button
                className="skills-header-reset-btn confirm"
                onClick={() => void handleResetProjectSkills()}
                disabled={resettingProjectSkills}
              >
                <Trash2 size={13} /> {resettingProjectSkills ? t('skills.deleting') : t('skills.confirmReset')}
              </button>
              <button className="skills-header-reset-btn cancel" onClick={() => setResetConfirm(false)}>{t('skills.cancel')}</button>
            </span>
          ) : (
            <button
              className="skills-header-reset-btn"
              onClick={() => setResetConfirm(true)}
              title={t('skills.resetProjectTitle')}
            >
              <Trash2 size={13} /> {t('skills.reset')}
            </button>
          )}
          <button className="skills-close-btn" onClick={onClose} title={t('common.close')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {activeTab === 'my' && (
          <>
            {/* ── Quick Create: just type what you want ── */}
            <div className="skills-quick-create">
              <textarea
                className="skills-quick-input"
                value={quickInput}
                onChange={(e) => setQuickInput(e.target.value)}
                placeholder={t('skills.quickPlaceholder')}
                rows={2}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleQuickCreate();
                  }
                }}
              />
              <div className="skills-quick-bar">
                <input
                  type="text"
                  className="skills-quick-slug"
                  value={quickSlug}
                  onChange={(e) => setQuickSlug(e.target.value.replace(/[^a-zA-Z0-9\s-]/g, ''))}
                  placeholder={t('skills.slugPlaceholder')}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleQuickCreate(); }}
                />
                <select
                  className="skills-quick-cli"
                  value={quickCli}
                  onChange={(e) => setQuickCli(e.target.value as SkillCliType)}
                  title={t('skills.cliType')}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                  <option value="shell">Shell</option>
                  <option value="opencode">OpenCode</option>
                  <option value="kimi">Kimi</option>
                  <option value="ollama">Ollama</option>
                </select>
                <button
                  className="skills-quick-btn"
                  onClick={() => void handleQuickCreate()}
                  disabled={!quickInput.trim() || quickCreating}
                >
                  <Plus size={13} /> {quickCreating ? t('skills.creating') : quickMsg || t('skills.new')}
                </button>
              </div>
              {quickSlug.trim() && (
                <div className="skills-quick-hint">
                  Claude: <code>/{toAsciiSlug(quickSlug)}</code> &nbsp; Codex: <code>${toAsciiSlug(quickSlug)}</code>
                </div>
              )}
            </div>

            {/* ── Advanced Form (editing / detailed creation) ── */}
            {(editingId || showAdvanced) && (
            <div className="skills-form">
              <div className="skills-form-row">
                <input
                  type="text"
                  className="name-input"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={t('skills.skillName')}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
                />
                <div className="skills-form-actions">
                  {editingId && <button onClick={resetForm}>{t('skills.cancel')}</button>}
                  <button className="btn-primary" onClick={handleSubmit}>
                    {editingId ? t('skills.update') : t('skills.add')}
                  </button>
                </div>
              </div>
              <textarea
                className="cmd-input"
                value={formCmd}
                onChange={(e) => setFormCmd(e.target.value)}
                placeholder={t('skills.commandPlaceholder')}
                rows={2}
              />
              <div className="skills-form-row">
                <input
                  type="text"
                  className="emoji-input"
                  value={formEmoji}
                  onChange={(e) => setFormEmoji(e.target.value)}
                  placeholder="⚡"
                  maxLength={4}
                  title={t('skills.emojiTitle')}
                />
                <input
                  type="text"
                  className="desc-input"
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  placeholder={t('skills.descPlaceholder')}
                />
              </div>
              <div className="skills-form-row">
                <select value={formCliType} onChange={(e) => setFormCliType(e.target.value as SkillCliType)}>
                  {CLI_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <select value={formCategory} onChange={(e) => setFormCategory(e.target.value as SkillCategory)}>
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              {(formCliType === 'claude' || formCliType === 'codex' || formCliType === 'cursor' || formCliType === 'kimi' || formCliType === 'gemini' || formCliType === 'qwen') && (
                <div className="skills-form-row">
                  <select
                    value={getModelsForCliType(formCliType).some(m => m.value === formModel) ? formModel : (formModel ? '__custom__' : '')}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v !== '__custom__') setFormModel(v);
                    }}
                    style={{ minWidth: 120 }}
                  >
                    {getModelsForCliType(formCliType).map((m, i) => (
                      <option key={`${m.value}-${i}`} value={m.value}>{m.label}</option>
                    ))}
                    {formModel && !getModelsForCliType(formCliType).some(m => m.value === formModel) && (
                      <option value="__custom__">Custom</option>
                    )}
                  </select>
                  <input
                    type="text"
                    value={formModel}
                    onChange={(e) => setFormModel(e.target.value)}
                    placeholder={t('skills.modelPlaceholder')}
                    style={{ flex: 1 }}
                  />
                </div>
              )}
              <div className="skills-form-row">
                <input
                  type="text"
                  value={formPriority}
                  onChange={(e) => setFormPriority(e.target.value.replace(/[^\d.-]/g, ''))}
                  placeholder="priority"
                  title={t('skills.priorityTitle')}
                  style={{ maxWidth: 120 }}
                />
                <input
                  type="text"
                  value={formAllowedTools}
                  onChange={(e) => setFormAllowedTools(e.target.value)}
                  placeholder="allowed tools: read_file, grep, bash"
                />
              </div>
              <div className="skills-form-row">
                <input
                  type="text"
                  value={formWhenToUse}
                  onChange={(e) => setFormWhenToUse(e.target.value)}
                  placeholder="when_to_use"
                />
              </div>
              <textarea
                className="cmd-input"
                value={formPaths}
                onChange={(e) => setFormPaths(e.target.value)}
                placeholder="paths, one per line: src/**/*.tsx"
                rows={2}
              />
              <label className="skills-metadata-check">
                <input
                  type="checkbox"
                  checked={formDisableModelInvocation}
                  onChange={(e) => setFormDisableModelInvocation(e.target.checked)}
                />
                <span>disable model invocation</span>
              </label>
            </div>
            )}
            {!editingId && !showAdvanced && (
              <button className="skills-advanced-toggle" onClick={() => setShowAdvanced(true)} type="button">
                <ChevronDown size={12} /> {t('skills.openAdvanced')}
              </button>
            )}
            {showAdvanced && !editingId && (
              <button className="skills-advanced-toggle" onClick={() => setShowAdvanced(false)} type="button">
                <ChevronUp size={12} /> {t('skills.closeAdvanced')}
              </button>
            )}

            {/* List */}
            <div className="skills-list">
              {grouped.length === 0 && (
                <div className="skills-empty">
                  {t('skills.emptyList')}
                  <br />
                  <span style={{ fontSize: 11, opacity: 0.7 }}>{t('skills.emptyListHint')}</span>
                </div>
              )}
              {grouped.map(group => (
                <React.Fragment key={group.category}>
                  <div className="skills-category-header">{group.label}</div>
                  {group.items.map(skill => (
                    <div key={skill.id} className="skills-item" onClick={() => onRun(skill)}>
                      <span className="skills-item-emoji">{skill.emoji}</span>
                      <div className="skills-item-info">
                        <div className="skills-item-name">{skill.id} — {skill.name}</div>
                        <div className="skills-item-desc">{skill.description || skill.command.slice(0, 60)}</div>
                      </div>
                      <span className="skills-item-cli-badge">{skill.cliType}</span>
                      {skill.model && <span className="skills-item-model-badge">{skill.model.replace(/^claude-|^gpt-/i, '').split('-').slice(0, 2).join('-')}</span>}
                      {skill.priority != null && skill.priority !== 0 && <span className="skills-item-model-badge">P{skill.priority}</span>}
                      {skill.paths?.length ? <span className="skills-item-model-badge">paths</span> : null}
                      {skill.allowedTools?.length ? <span className="skills-item-model-badge">tools</span> : null}
                      <div className="skills-item-actions" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => onRun(skill)} title={t('skills.run')}><Play size={13} /></button>
                        <button onClick={() => handleEdit(skill)} title={t('skills.edit')}><Pencil size={13} /></button>
                        {!skill.builtIn && (
                          <button className="danger" onClick={() => onRemove(skill.id)} title={t('common.delete')}><Trash2 size={13} /></button>
                        )}
                      </div>
                    </div>
                  ))}
                </React.Fragment>
              ))}
            </div>

            {/* Footer */}
            <div className="skills-footer">
              <span className="skills-footer-hint">
                {t('skills.footerHint')}
                {projectInstallResult && (
                  <span className={`skills-install-result ${projectInstallResult.type === 'ok' ? 'ok' : 'error'}`} style={{ marginLeft: 8 }}>
                    {projectInstallResult.msg}
                  </span>
                )}
              </span>
              <div className="skills-footer-actions">
                {hasProjectPath && (
                  <button
                    onClick={handleImportFromProject}
                    disabled={importingFromProject}
                    title={t('skills.scanSkillMd')}
                    className={importResult ? (importResult.count > 0 ? 'success' : '') : ''}
                  >
                    <FolderDown size={12} /> {importingFromProject ? t('skills.scanning') : importResult ? importResult.msg : t('skills.importFromProject')}
                  </button>
                )}
                <button onClick={handleImportClick} title={t('skills.importJson')}><Upload size={12} /> JSON</button>
                <button onClick={handleExport} title={t('skills.export')}><Download size={12} /> {t('skills.export')}</button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                style={{ display: 'none' }}
                onChange={handleImportFile}
              />
            </div>
          </>
        )}

        {activeTab === 'gallery' && (
          <>
            {/* Gallery Type Toggle: Shell vs AI */}
            <div className="skills-gallery-type-bar">
              <button
                className={`skills-gallery-type-btn ${galleryType === 'shell' ? 'active' : ''}`}
                onClick={() => { setGalleryType('shell'); setGalleryFilter('all'); setGalleryAiFilter('all'); }}
              >
                <TerminalSquare size={13} /> {t('skills.shellCommands')} <span className="skills-gallery-type-count">{shellCount}</span>
              </button>
              <button
                className={`skills-gallery-type-btn ${galleryType === 'ai' ? 'active' : ''}`}
                onClick={() => { setGalleryType('ai'); setGalleryFilter('all'); setGalleryAiFilter('all'); }}
              >
                <FileText size={13} /> {t('skills.aiSkills')} <span className="skills-gallery-type-count">{aiCount}</span>
              </button>
            </div>

            {galleryType === 'ai' && (
              <div className="skills-gallery-ai-filter-bar">
                {GALLERY_AI_FILTERS.map(filter => {
                  const count = gallerySkills.filter(s => {
                    if (s.cliType === 'shell') return false;
                    if (galleryFilter !== 'all' && s.category !== galleryFilter) return false;
                    return matchGalleryAiFilter(s, filter.value);
                  }).length;
                  if (filter.value !== 'all' && count === 0) return null;
                  return (
                    <button
                      key={filter.value}
                      className={`skills-ai-filter-chip ${galleryAiFilter === filter.value ? 'active' : ''}`}
                      onClick={() => setGalleryAiFilter(filter.value)}
                    >
                      {filter.label} {count}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Gallery Search */}
            <div className="skills-gallery-search">
              <div className="skills-search-box">
                <Search size={14} />
                <input
                  type="text"
                  value={gallerySearch}
                  onChange={(e) => setGallerySearch(e.target.value)}
                  placeholder={galleryType === 'shell' ? t('skills.shellSearchPlaceholder') : t('skills.search')}
                />
              </div>
            </div>

            {/* Category Chips */}
            <div className="skills-gallery-chips">
              <button
                className={`skills-chip ${galleryFilter === 'all' ? 'active' : ''}`}
                onClick={() => setGalleryFilter('all')}
              >
                {t('skills.all')} {galleryBase.length}
              </button>
              {CATEGORIES.map(cat => {
                const count = gallerySkills.filter(s =>
                  s.category === cat.value &&
                  (galleryType === 'shell'
                    ? s.cliType === 'shell'
                    : matchGalleryAiFilter(s, galleryAiFilter))
                ).length;
                if (count === 0) return null;
                return (
                  <button
                    key={cat.value}
                    className={`skills-chip ${galleryFilter === cat.value ? 'active' : ''}`}
                    onClick={() => setGalleryFilter(galleryFilter === cat.value ? 'all' : cat.value)}
                  >
                    {cat.emoji} {cat.label} {count}
                  </button>
                );
              })}
            </div>

            {/* Gallery Content */}
            <div className="skills-gallery-scroll">
              {galleryType === 'ai' && (
                <div className="skills-gallery-result-meta">
                  {t('skills.filterResult').replace('{aiFilter}', galleryAiFilterLabel).replace('{category}', galleryFilter !== 'all' ? ` · ${CATEGORIES.find(c => c.value === galleryFilter)?.label || galleryFilter}` : '').replace('{count}', String(filteredGallery.length))}
                </div>
              )}

              {galleryGrouped.length === 0 && (
                <div className="skills-empty">{t('skills.noResults')}</div>
              )}

              {galleryType === 'shell' ? (
                /* ── Shell: compact list, click to run in terminal ── */
                galleryGrouped.map(group => (
                  <React.Fragment key={group.category}>
                    <div className="skills-gallery-section-header">{group.emoji} {group.label} <span className="skills-gallery-count">{group.items.length}</span></div>
                    {group.items.map(skill => (
                      <div
                        key={skill.id}
                        className="skills-shell-item"
                        onClick={() => onRun(skill)}
                        title={t('skills.clickToInput')}
                      >
                        <span className="skills-shell-item-emoji">{skill.emoji}</span>
                        <div className="skills-shell-item-info">
                          <span className="skills-shell-item-name">{skill.name}</span>
                          <span className="skills-shell-item-desc">{skill.description}</span>
                        </div>
                        <code className="skills-shell-item-cmd">{skill.command.length > 45 ? skill.command.slice(0, 42) + '...' : skill.command}</code>
                        <Play size={12} className="skills-shell-item-run" />
                      </div>
                    ))}
                  </React.Fragment>
                ))
              ) : (
                /* ── AI: card grid, save to project as SKILL.md ── */
                galleryGrouped.map(group => (
                  <React.Fragment key={group.category}>
                    <div className="skills-gallery-section-header">{group.emoji} {group.label} <span className="skills-gallery-count">{group.items.length}</span></div>
                    <div className="skills-gallery-grid">
                      {group.items.map(skill => {
                        const isAdded = existingSkillCommands.has(skill.command);
                        const isSaved = savedToProject.has(skill.id);
                        const isInstalling = installingToProject.has(skill.id);
                        const installDisabled = !hasProjectPath || isSaved || isInstalling;
                        const installLabel = !hasProjectPath
                          ? t('skills.needProject')
                          : isSaved
                            ? t('skills.installed')
                            : isInstalling
                              ? t('skills.installing')
                              : t('skills.installToProject');
                        const safetyLabel = getSkillSafetyLabel(skill);
                        return (
                          <div key={skill.id} className={`skills-gallery-card ${isAdded ? 'added' : ''} ${skill.safetyLevel ? `safety-${skill.safetyLevel}` : ''}`}>
                            <div className="skills-gallery-card-top">
                              <span className="skills-gallery-card-emoji">{skill.emoji}</span>
                              {safetyLabel && (
                                <span
                                  className={`skills-gallery-card-safety ${skill.safetyLevel === 'dangerous' ? 'dangerous' : 'caution'}`}
                                  title={getSkillSafetyTitle(skill)}
                                >
                                  {safetyLabel}
                                </span>
                              )}
                              <span className="skills-gallery-card-cli">{skill.cliType}</span>
                              {(() => { const u = getSkillSourceUrl(skill); return u ? (
                                <button
                                  className="skills-gallery-card-source"
                                  onClick={(e) => { e.stopPropagation(); void openExternalUrl(u); }}
                                  title={t('skills.viewOriginal')}
                                ><ExternalLink size={11} /></button>
                              ) : null; })()}
                            </div>
                            <div className="skills-gallery-card-name">{skill.name}</div>
                            <div className="skills-gallery-card-desc">{skill.description}</div>
                            <div className="skills-gallery-card-cmd">{skill.command.length > 50 ? skill.command.slice(0, 47) + '...' : skill.command}</div>
                            <div className="skills-gallery-card-buttons">
                              {isAdded ? (
                                <span className="skills-gallery-card-added"><Check size={11} /> {t('skills.added')}</span>
                              ) : (
                                <button
                                  className="skills-gallery-card-add"
                                  onClick={(e) => { e.stopPropagation(); handleGalleryAdd(skill); }}
                                >
                                  <Plus size={12} /> {t('skills.addToMySkills')}
                                </button>
                              )}
                              <button
                                className="skills-gallery-card-add skills-gallery-card-project"
                                onClick={(e) => { e.stopPropagation(); void handleSaveToProject(skill); }}
                                title={hasProjectPath
                                  ? 'Claude(.claude/skills/) + Codex(.agents/skills/) SKILL.md'
                                  : t('skills.selectProjectTooltip')}
                                disabled={installDisabled}
                              >
                                {isSaved ? <><Check size={12} /> {installLabel}</> : <><FolderPlus size={12} /> {installLabel}</>}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </React.Fragment>
                ))
              )}
            </div>

            {/* Gallery Footer */}
            <div className="skills-footer">
              <span className="skills-footer-hint">
                {galleryType === 'shell'
                  ? t('skills.shellFooter').replace('{count}', String(filteredGallery.length))
                  : t('skills.aiFooter').replace('{count}', String(filteredGallery.length))
                }
                {projectInstallResult && (
                  <span className={`skills-install-result ${projectInstallResult.type === 'ok' ? 'ok' : 'error'}`} style={{ marginLeft: 8 }}>
                    {projectInstallResult.msg}
                  </span>
                )}
              </span>
            </div>
          </>
        )}

        {builderOpen && (
          <div className="skills-builder-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) setBuilderOpen(false); }}>
            <div className="skills-builder-modal" onMouseDown={(e) => e.stopPropagation()}>
              <div className="skills-builder-head">
                <div>
                  <h3>{t('skills.builder.title')}</h3>
                  <span>Codex / Claude / Shell</span>
                </div>
                <button className="skills-close-btn" onClick={() => setBuilderOpen(false)} title={t('common.close')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>

              <div className="skills-builder-grid">
                <div className="skills-builder-form">
                  <label>
                    {t('skills.builder.ideaLabel')}
                    <textarea
                      value={builderIdea}
                      onChange={(e) => setBuilderIdea(e.target.value)}
                      placeholder={t('skills.builder.ideaPlaceholder')}
                      rows={3}
                    />
                  </label>
                  <button type="button" className="skills-builder-draft" onClick={handleBuilderDraft} disabled={!builderIdea.trim()}>
                    <Wand2 size={13} /> {t('skills.builder.draftBtn')}
                  </button>

                  <div className="skills-builder-two">
                    <label>
                      {t('skills.builder.nameLabel')}
                      <input value={builderName} onChange={(e) => setBuilderName(e.target.value)} placeholder="PR Review" />
                    </label>
                    <label>
                      {t('skills.builder.iconLabel')}
                      <input className="skills-builder-emoji" value={builderEmoji} onChange={(e) => setBuilderEmoji(e.target.value)} maxLength={4} />
                    </label>
                  </div>

                  <label>
                    {t('skills.builder.descLabel')}
                    <input value={builderDesc} onChange={(e) => setBuilderDesc(e.target.value)} placeholder={t('skills.builder.descPlaceholder')} />
                  </label>

                  <div className="skills-builder-two">
                    <label>
                      {t('skills.builder.cliLabel')}
                      <select value={builderCliType} onChange={(e) => setBuilderCliType(e.target.value as SkillCliType)}>
                        {CLI_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                      </select>
                    </label>
                    <label>
                      {t('skills.category')}
                      <select value={builderCategory} onChange={(e) => setBuilderCategory(e.target.value as SkillCategory)}>
                        {CATEGORIES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                      </select>
                    </label>
                  </div>

                  <label>
                    {t('skills.builder.bodyLabel')}
                    <textarea
                      value={builderBody}
                      onChange={(e) => setBuilderBody(e.target.value)}
                      placeholder={builderCliType === 'shell' ? 'npm run build' : t('skills.builder.bodyPlaceholderAi')}
                      rows={7}
                    />
                  </label>

                  <label>
                    {t('skills.builder.tagsLabel')}
                    <input value={builderTags} onChange={(e) => setBuilderTags(e.target.value)} placeholder="review, testing, codex" />
                  </label>

                  <div className="skills-builder-targets">
                    <label>
                      <input
                        type="checkbox"
                        checked={builderTargets.app}
                        onChange={(e) => setBuilderTargets(prev => ({ ...prev, app: e.target.checked }))}
                      />
                      {t('skills.addToMySkills')}
                    </label>
                    <label className={!hasProjectPath ? 'disabled' : ''}>
                      <input
                        type="checkbox"
                        checked={builderTargets.agents}
                        disabled={!hasProjectPath}
                        onChange={(e) => setBuilderTargets(prev => ({ ...prev, agents: e.target.checked }))}
                      />
                      {t('skills.builder.targetCodex')}
                    </label>
                    <label className={!hasProjectPath ? 'disabled' : ''}>
                      <input
                        type="checkbox"
                        checked={builderTargets.claude}
                        disabled={!hasProjectPath}
                        onChange={(e) => setBuilderTargets(prev => ({ ...prev, claude: e.target.checked }))}
                      />
                      {t('skills.builder.targetClaude')}
                    </label>
                  </div>
                </div>

                <div className="skills-builder-preview">
                  <div className="skills-builder-preview-head">
                    <span>{t('skills.builder.preview')}</span>
                    <code>{builderSafeName || t('skills.builder.autoName')}</code>
                  </div>
                  <pre>{builderPreview}</pre>
                  <div className="skills-builder-validation">
                    {builderValidation.errors.length === 0 && <span className="ok">{t('skills.builder.validationOk')}</span>}
                    {builderValidation.errors.map((err) => <span key={err} className="error">{err}</span>)}
                    {builderValidation.warnings.map((warning) => <span key={warning} className="warn">{warning}</span>)}
                  </div>
                </div>
              </div>

              <div className="skills-builder-foot">
                {builderResult && <span className={`skills-builder-result ${builderResult.type}`}>{builderResult.msg}</span>}
                <button type="button" onClick={() => setBuilderOpen(false)}>{t('common.close')}</button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void handleBuilderSave()}
                  disabled={builderSaving || builderValidation.errors.length > 0}
                >
                  <Save size={13} /> {builderSaving ? t('skills.builder.saving') : t('skills.builder.saveAndUse')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
