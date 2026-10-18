import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ChevronRight, FilePlus, FolderPlus, FolderOpen, Scissors, ClipboardPaste, Play, FileUp, CopyPlus,
  Copy, ClipboardCopy, Route, NotebookPen, Sparkles,
  FileText, FileCode2, FileImage, FileVideo, FileAudio, FileArchive,
  FileSpreadsheet, FileLock2, FileTerminal, FileCog, FileKey,
  Folder, FolderGit2, FolderCog, FolderCode, FolderDot, FolderInput,
  Database, Braces, Gem, Coffee, Bug, Shield, Globe, Palette, Package,
  Terminal, Settings, Eye, EyeOff, BookOpen,
} from 'lucide-react';
import { OctoPencil, OctoTrash } from '../octoIcons';
import type { FileEntry } from '../store/appState';
import { useTranslation } from '../i18n';
import { buildFileTreeMenu, type FileTreeMenuItem, type FileTreeMenuItemId } from './fileTreeMenuModel';

export const buildChildPath = (parentPath: string, childName: string): string => {
  const name = String(childName || '').replace(/^[/\\]+/g, '');
  const parentRaw = String(parentPath || '').trim();
  if (!name) return parentRaw;

  if (parentRaw.startsWith('ssh://')) {
    const body = parentRaw.slice('ssh://'.length);
    const sep = body.indexOf('::');
    if (sep >= 0) {
      const meta = body.slice(0, sep);
      let remote = body.slice(sep + 2).trim().replace(/\\/g, '/');
      if (!remote) remote = '/';
      if (!remote.startsWith('/')) remote = `/${remote}`;
      remote = remote.replace(/\/+$/g, '');
      if (!remote) remote = '/';
      const base = remote === '/' ? '' : remote;
      return `ssh://${meta}::${base}/${name}`;
    }
  }

  const trimmed = parentRaw.replace(/[\\/]+$/g, '');
  if (!trimmed) {
    if (parentRaw.startsWith('/')) return `/${name}`;
    return name;
  }
  if (trimmed === '/' || trimmed === '\\') return `${trimmed}${name}`;
  if (/^[a-zA-Z]:$/.test(trimmed)) return `${trimmed}\\${name}`;
  const sep = trimmed.includes('\\') ? '\\' : '/';
  return `${trimmed}${sep}${name}`;
};

const mapChildrenWithParentPath = (parentPath: string, children: FileEntry[]): FileEntry[] =>
  children.map((child) => ({ ...child, path: buildChildPath(parentPath, child.name) }));

// ── Folder icon by name ──
const FOLDER_ICONS: Record<string, React.FC<any>> = {
  src:           FolderCode,
  components:    FolderCode,
  hooks:         FolderCode,
  lib:           FolderCode,
  utils:         FolderCog,
  config:        FolderCog,
  '.config':     FolderCog,
  node_modules:  Package,
  '.git':        FolderGit2,
  '.github':     FolderGit2,
  dist:          FolderInput,
  build:         FolderInput,
  out:           FolderInput,
  target:        FolderInput,
  public:        Globe,
  assets:        Palette,
  images:        FileImage,
  styles:        Palette,
  test:          Bug,
  tests:         Bug,
  '__tests__':   Bug,
  docs:          FileText,
  scripts:       FileTerminal,
  '.vscode':     FolderCog,
  types:         Braces,
  store:         Database,
  i18n:          Globe,
  commands:      Terminal,
  editor:        FileCode2,
  keybindings:   Settings,
  integrations:  Package,
  split:         FolderCode,
  terminal:      Terminal,
  kanban:        FileSpreadsheet,
  analyzer:      Eye,
};

// ── Language badge icons (VS Code seti 스타일) ──
// 코드 파일은 전부 같은 FileCode2 모양이라 구분이 어렵다 —
// 언어 약칭이 새겨진 라운드 배지로 구분한다. 색은 트리 톤 체계를 따른다.
const LANG_BADGES: Record<string, string> = {
  ts: 'TS', tsx: 'TSX',
  js: 'JS', jsx: 'JSX', mjs: 'JS', cjs: 'JS',
  rs: 'RS',
  py: 'PY', pyi: 'PY',
  go: 'GO',
  kt: 'KT',
  c: 'C', h: 'H',
  cpp: 'C++', hpp: 'C++',
};

// 트리 아이콘 색 통일 — 종류 구분은 글리프(모양)와 배지 글자가 맡고,
// 색은 3단 톤만 쓴다: 폴더=액센트, 파일=중립, 숨김=흐림.
const ICON_TONE = {
  dir: 'color-mix(in srgb, var(--accent-color) 78%, var(--text-color) 22%)',
  dirHidden: 'color-mix(in srgb, var(--accent-color) 40%, transparent)',
  file: 'color-mix(in srgb, var(--text-color) 60%, transparent)',
  fileHidden: 'color-mix(in srgb, var(--text-color) 34%, transparent)',
};

export function LangBadgeIcon({ label, size = 15 }: { label: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ flexShrink: 0 }} aria-hidden="true">
      <rect x="1" y="1" width="14" height="14" rx="3.5" style={{ fill: 'color-mix(in srgb, var(--text-color) 14%, transparent)' }} />
      <text
        x="8" y="8.6"
        textAnchor="middle" dominantBaseline="central"
        fontSize={label.length > 2 ? 5.4 : 6.6} fontWeight="700"
        fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif"
        style={{ fill: 'color-mix(in srgb, var(--text-color) 82%, transparent)' }}
      >{label}</text>
    </svg>
  );
}

// ── File icon by extension ──
const FILE_ICON_MAP: Record<string, React.FC<any>> = {
  // Web
  html: Globe,
  htm:  Globe,
  css:  Palette,
  scss: Palette,
  less: Palette,
  // Data / Config
  json: Braces,
  yaml: FileCog,
  yml:  FileCog,
  toml: FileCog,
  xml:  FileCode2,
  csv:  FileSpreadsheet,
  // Markdown / Docs
  md:    BookOpen,
  mdx:   BookOpen,
  txt:   FileText,
  pdf:   FileText,
  // Ruby
  rb:    Gem,
  // Java
  java:  Coffee,
  // Shell
  sh:    FileTerminal,
  bash:  FileTerminal,
  zsh:   FileTerminal,
  fish:  FileTerminal,
  // Images
  png:   FileImage,
  jpg:   FileImage,
  jpeg:  FileImage,
  gif:   FileImage,
  webp:  FileImage,
  ico:   FileImage,
  svg:   FileImage,
  // Video / Audio
  mp4:   FileVideo,
  webm:  FileVideo,
  mp3:   FileAudio,
  wav:   FileAudio,
  // Archive
  zip:   FileArchive,
  tar:   FileArchive,
  gz:    FileArchive,
  // Lock / Security
  lock:  FileLock2,
  // Database
  db:    Database,
  sql:   Database,
  sqlite: Database,
  // Env / Config
  env:   FileKey,
  // Misc
  wasm:  FileCode2,
  graphql: Braces,
  gql:   Braces,
  prisma: Database,
  dockerfile: Package,
};

// ── Special filenames ──
const SPECIAL_FILES: Record<string, React.FC<any>> = {
  'package.json':    Package,
  'tsconfig.json':   Settings,
  'vite.config.ts':  Settings,
  'vite.config.js':  Settings,
  '.gitignore':      EyeOff,
  '.gitkeep':        EyeOff,
  '.eslintrc':       Shield,
  '.eslintrc.js':    Shield,
  '.eslintrc.json':  Shield,
  'eslint.config.js':  Shield,
  'eslint.config.mjs': Shield,
  '.prettierrc':     Settings,
  'prettier.config.js': Settings,
  'Cargo.toml':      Package,
  'Cargo.lock':      FileLock2,
  'Dockerfile':      Package,
  'docker-compose.yml': Package,
  '.env':            FileKey,
  '.env.local':      FileKey,
  '.env.production': FileKey,
  'LICENSE':         Shield,
  'README.md':       BookOpen,
  'CLAUDE.md':       BookOpen,
  'AGENTS.md':       BookOpen,
  'Makefile':        FileCog,
  'tailwind.config.js': Palette,
  'tailwind.config.ts': Palette,
  'postcss.config.js':  Settings,
};

// File icon — 글리프는 타입별, 색은 ICON_TONE 3단 톤으로 통일
export function FileIcon({ name, isDir, expanded }: { name: string; isDir: boolean; expanded?: boolean }) {
  const sz = 15;
  const hidden = name.startsWith('.');

  if (isDir) {
    const Icon = FOLDER_ICONS[name] || FOLDER_ICONS[name.toLowerCase()]
      || (hidden ? FolderDot : (expanded ? FolderOpen : Folder));
    return <Icon size={sz} style={{ color: hidden ? ICON_TONE.dirHidden : ICON_TONE.dir, opacity: expanded ? 1 : 0.85, flexShrink: 0 }} />;
  }

  const tone = hidden ? ICON_TONE.fileHidden : ICON_TONE.file;

  // Special filenames → extension: language badges first, generic file icons next
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : '';
  const badgeLabel = !SPECIAL_FILES[name] ? LANG_BADGES[ext] : undefined;
  if (badgeLabel) {
    return <LangBadgeIcon label={badgeLabel} size={sz} />;
  }
  const Icon = SPECIAL_FILES[name] || FILE_ICON_MAP[ext] || FileText;
  return <Icon size={sz} style={{ color: tone, flexShrink: 0 }} />;
}

// Context menu for file tree
export function FileTreeContextMenu({ x, y, entry, isRoot, onClose, onNewFile, onNewFolder, onOpenInSystem, onRename, onDelete, onCopy, onCut, onPaste, onCopyPath, onCopyRelativePath, hasCutOrCopyFile, canOpenInSystem, multiSelectCount, onDeleteMultiple, onCopyToNotes, onCopyToProject, noteCopyDestinations, treeType = 'project', onRunSkill, onImportFiles, onOrganizeNote, onDuplicate }: {
  x: number; y: number; entry: FileEntry | null;
  isRoot?: boolean;
  onClose: () => void;
  onNewFile: () => void; onNewFolder: () => void; onOpenInSystem: () => void; onRename: () => void; onDelete: () => void;
  onCopy: () => void; onCut: () => void; onPaste: () => void; onCopyPath: () => void; onCopyRelativePath?: () => void; hasCutOrCopyFile: boolean;
  canOpenInSystem: boolean;
  multiSelectCount?: number;
  onDeleteMultiple?: () => void;
  onCopyToNotes?: () => void;
  onCopyToProject?: () => void;
  noteCopyDestinations?: { label: string; action: () => void }[];
  treeType?: 'project' | 'notes';
  onRunSkill?: () => void;
  onImportFiles?: () => void;
  onOrganizeNote?: () => void;
  onDuplicate?: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Adjust position so menu stays within viewport
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let top = y;
    let left = x;
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - rect.height - 8);
    }
    if (left + rect.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - rect.width - 8);
    }
    if (top !== y || left !== x) setPos({ top, left });
  }, [x, y]);

  const sections = buildFileTreeMenu({
    entry,
    isRoot,
    treeType,
    hasCutOrCopyFile,
    canOpenInSystem,
    multiSelectCount: multiSelectCount ?? 0,
    noteCopyDestinationCount: noteCopyDestinations?.length,
    hasImportFiles: !!onImportFiles,
    hasRunSkill: !!onRunSkill,
    hasDuplicate: !!onDuplicate,
    hasCopyRelativePath: !!onCopyRelativePath,
    hasCopyToNotes: !!onCopyToNotes,
    hasOrganizeNote: !!onOrganizeNote,
    hasCopyToProject: !!onCopyToProject,
    hasDeleteMultiple: !!onDeleteMultiple,
  });

  const count = multiSelectCount ?? 0;
  const countSuffix = count > 1 ? ` (${count})` : '';
  // 항목별 아이콘·라벨·핸들러 — 표시/활성 판단은 buildFileTreeMenu가 담당.
  const renderers: Record<FileTreeMenuItemId, { icon: React.ReactNode; label: string; title?: string; action: () => void }> = {
    newFile: { icon: <FilePlus size={13} aria-hidden="true" />, label: t('fileTree.newFile'), title: t('fileTree.newFileDesc'), action: onNewFile },
    newFolder: { icon: <FolderPlus size={13} aria-hidden="true" />, label: t('fileTree.newFolder'), title: t('fileTree.newFolderDesc'), action: onNewFolder },
    importFiles: { icon: <FileUp size={13} aria-hidden="true" />, label: t('fileTree.importFiles'), title: t('fileTree.importFilesDesc'), action: () => onImportFiles?.() },
    openInSystem: { icon: <FolderOpen size={13} aria-hidden="true" />, label: t('fileTree.openInSystem'), title: t('fileTree.openInSystemDesc'), action: onOpenInSystem },
    runSkill: { icon: <Play size={13} aria-hidden="true" />, label: t('fileTree.runSkill'), title: t('fileTree.runSkillDesc'), action: () => onRunSkill?.() },
    copy: { icon: <Copy size={13} aria-hidden="true" />, label: t('fileTree.copy'), title: t('fileTree.copyDesc'), action: onCopy },
    cut: { icon: <Scissors size={13} aria-hidden="true" />, label: t('fileTree.cut'), title: t('fileTree.cutDesc'), action: onCut },
    paste: { icon: <ClipboardPaste size={13} aria-hidden="true" />, label: t('fileTree.paste'), title: t('fileTree.pasteDesc'), action: onPaste },
    duplicate: { icon: <CopyPlus size={13} aria-hidden="true" />, label: t('fileTree.duplicate'), title: t('fileTree.duplicateDesc'), action: () => onDuplicate?.() },
    copyPath: { icon: <ClipboardCopy size={13} aria-hidden="true" />, label: t('fileTree.copyPath'), title: t('fileTree.copyPathDesc'), action: onCopyPath },
    copyRelativePath: { icon: <Route size={13} aria-hidden="true" />, label: t('fileTree.copyRelativePath'), title: t('fileTree.copyRelativePathDesc'), action: () => onCopyRelativePath?.() },
    copyToNotes: { icon: <NotebookPen size={13} aria-hidden="true" />, label: `${t('fileTree.copyToNotes')}${countSuffix}`, title: t('fileTree.copyToNotesDesc'), action: () => onCopyToNotes?.() },
    organizeNote: { icon: <Sparkles size={13} aria-hidden="true" />, label: t('editor.aiOrganizeNote'), title: t('editor.aiOrganizeNote'), action: () => onOrganizeNote?.() },
    noteDest: { icon: <NotebookPen size={13} aria-hidden="true" />, label: '', action: () => {} },
    copyToProject: { icon: <FolderInput size={13} aria-hidden="true" />, label: `${t('fileTree.copyToProject')}${countSuffix}`, title: t('fileTree.copyToProjectDesc'), action: () => onCopyToProject?.() },
    rename: { icon: <OctoPencil size={13} />, label: t('fileTree.rename'), title: t('fileTree.renameDesc'), action: onRename },
    delete: { icon: <OctoTrash size={13} aria-hidden="true" />, label: t('fileTree.delete'), title: t('fileTree.deleteDesc'), action: onDelete },
    deleteMultiple: { icon: <OctoTrash size={13} aria-hidden="true" />, label: `${count} ${t('fileTree.delete')}`, title: t('fileTree.deleteMultipleDesc'), action: () => onDeleteMultiple?.() },
  };

  const renderItem = (item: FileTreeMenuItem) => {
    const base = renderers[item.id];
    const dest = item.id === 'noteDest' ? noteCopyDestinations?.[item.destIndex ?? 0] : null;
    const label = dest ? dest.label : base.label;
    const action = dest ? dest.action : base.action;
    const key = item.id === 'noteDest' ? `noteDest-${item.destIndex}` : item.id;
    return (
      <button
        key={key}
        role="menuitem"
        className={item.danger ? 'ftree-ctx-danger' : undefined}
        onClick={() => { if (!item.disabled) action(); onClose(); }}
        disabled={item.disabled}
        aria-disabled={item.disabled}
        aria-label={label}
        title={dest ? undefined : base.title}
      >
        {base.icon} {label}
      </button>
    );
  };

  return (
    <div ref={ref} className="ftree-ctx-menu" role="menu" aria-label={t('fileTree.contextMenu')} style={{ top: pos.top, left: pos.left }}>
      {sections.map((items, i) => (
        <React.Fragment key={i}>
          {i > 0 && <div className="ftree-ctx-sep" role="separator" />}
          {items.map(renderItem)}
        </React.Fragment>
      ))}
    </div>
  );
}

// Inline input for new file/folder creation
export function InlineNewInput({ depth, type, onSubmit, onDismiss }: {
  depth: number; type: 'file' | 'folder'; onSubmit: (name: string) => void; onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const submitPendingRef = useRef(false);
  useEffect(() => { ref.current?.focus(); }, []);
  const doSubmit = (v: string) => {
    if (composingRef.current) return;
    const n = v.trim();
    if (n) onSubmit(n); else onDismiss();
  };
  return (
    <div className="file-tree-row ftree-new-row" style={{ paddingLeft: depth * 18 + 8 }}>
      <span style={{ width: 12, flexShrink: 0 }} />
      <FileIcon name={type === 'folder' ? '__dir__' : 'newfile'} isDir={type === 'folder'} />
      <input
        ref={ref}
        className="ftree-inline-input"
        value={value}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label={type === 'file' ? t('fileTree.newFile') : t('fileTree.newFolder')}
        placeholder={type === 'file' ? t('fileTree.filenamePlaceholder') : t('fileTree.foldernamePlaceholder')}
        onChange={(e) => setValue(e.target.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={(e) => {
          composingRef.current = false;
          if (submitPendingRef.current) {
            submitPendingRef.current = false;
            doSubmit((e.target as HTMLInputElement).value);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (composingRef.current) { submitPendingRef.current = true; }
            else { doSubmit(value); }
          }
          if (e.key === 'Escape') { composingRef.current = false; submitPendingRef.current = false; onDismiss(); }
        }}
        onBlur={(e) => { composingRef.current = false; submitPendingRef.current = false; doSubmit(e.currentTarget.value); }}
      />
    </div>
  );
}

// Inline input for AI note generation (topic → AI content → save)
export function AiNoteInlineInput({ generating, onSubmit, onDismiss }: {
  generating: boolean; onSubmit: (topic: string) => void; onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const submitPendingRef = useRef(false);
  useEffect(() => { ref.current?.focus(); }, []);
  const doSubmit = (v: string) => {
    if (composingRef.current) return;
    const n = v.trim();
    if (n) onSubmit(n); else onDismiss();
  };
  return (
    <div className="file-tree-row ftree-new-row ftree-ai-row" style={{ paddingLeft: 8 }}>
      <span style={{ width: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {generating
          ? <span className="ftree-ai-spinner" />
          : <span style={{ fontSize: 11 }}>&#x2728;</span>
        }
      </span>
      <input
        ref={ref}
        className="ftree-inline-input"
        value={value}
        aria-label={t('fileTree.aiNoteTopicAria')}
        aria-busy={generating}
        placeholder={generating ? t('fileTree.aiGenerating') : t('fileTree.aiTopicPlaceholder')}
        disabled={generating}
        onChange={(e) => setValue(e.target.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={(e) => {
          composingRef.current = false;
          if (submitPendingRef.current) {
            submitPendingRef.current = false;
            doSubmit((e.target as HTMLInputElement).value);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (composingRef.current) { submitPendingRef.current = true; }
            else { doSubmit(value); }
          }
          if (e.key === 'Escape') { composingRef.current = false; submitPendingRef.current = false; onDismiss(); }
        }}
        onBlur={() => { if (!generating) { composingRef.current = false; submitPendingRef.current = false; onDismiss(); } }}
      />
    </div>
  );
}

// File tree item (VS Code style)
export const FileTreeItem = React.memo(function FileTreeItem({
  parentPath,
  entry, depth, onFileClick, onSelect, selectedPath,
  renamingPath, onStartRename, onFinishRename,
  inlineInput, onInlineSubmit, onInlineDismiss,
  aiInput, aiGenerating, onAiSubmit, onAiDismiss,
  onContextMenu, cutPaths, refreshToken,
  multiSelectedPaths, onMultiSelect, onRangeSelect,
  draggingPaths, dropTargetPath,
  onTreeDragStart, onTreeDragEnd, onTreeDragOverDir, onTreeDragLeaveDir, onTreeDropOnDir,
  onTreeMouseDown, onTreeMouseEnter, onTreeMouseUp,
  expandedPaths, onSetExpanded,
  revealPath,
  deleteConfirmPath, onDeleteConfirm, onDeleteCancel,
}: {
  parentPath?: string;
  entry: FileEntry; depth: number;
  onFileClick: (e: FileEntry) => void;
  onSelect: (e: FileEntry) => void;
  selectedPath: string | null;
  renamingPath: string | null;
  onStartRename: (entry: FileEntry) => void;
  onFinishRename: (oldPath: string, newName: string) => void;
  inlineInput: { parentPath: string; type: 'file' | 'folder' } | null;
  onInlineSubmit: (name: string) => void;
  onInlineDismiss: () => void;
  aiInput?: { parentPath: string } | null;
  aiGenerating?: boolean;
  onAiSubmit?: (topic: string) => void;
  onAiDismiss?: () => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  cutPaths: string[];
  refreshToken: number;
  multiSelectedPaths?: Set<string>;
  onMultiSelect?: (entry: FileEntry, e: React.MouseEvent) => void;
  onRangeSelect?: (entry: FileEntry, e: React.MouseEvent) => void;
  draggingPaths?: Set<string>;
  dropTargetPath?: string | null;
  onTreeDragStart?: (entry: FileEntry, e: React.DragEvent) => void;
  onTreeDragEnd?: (entry: FileEntry, e: React.DragEvent) => void;
  onTreeDragOverDir?: (entry: FileEntry, e: React.DragEvent) => void;
  onTreeDragLeaveDir?: (entry: FileEntry, e: React.DragEvent) => void;
  onTreeDropOnDir?: (entry: FileEntry, e: React.DragEvent) => void;
  onTreeMouseDown?: (entry: FileEntry, e: React.MouseEvent) => void;
  onTreeMouseEnter?: (entry: FileEntry, e: React.MouseEvent) => void;
  onTreeMouseUp?: (entry: FileEntry, e: React.MouseEvent) => void;
  expandedPaths?: Set<string>;
  onSetExpanded?: (path: string, expanded: boolean) => void;
  revealPath?: string | null;
  deleteConfirmPath?: string | null;
  onDeleteConfirm?: (entry: FileEntry) => void;
  onDeleteCancel?: () => void;
}) {
  const { t } = useTranslation();
  const entryPath = useMemo(
    () => (parentPath ? buildChildPath(parentPath, entry.name) : entry.path),
    [parentPath, entry.name, entry.path],
  );
  const resolvedEntry = useMemo(() => ({ ...entry, path: entryPath }), [entry, entryPath]);
  const [localExpanded, setLocalExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const renameComposingRef = useRef(false);
  const renameSubmitPendingRef = useRef(false);
  const hoverExpandTimerRef = useRef<number | null>(null);
  const lastAutoRevealPathRef = useRef<string | null>(null);
  const isRenaming = renamingPath === entryPath;
  const isDeleteConfirm = deleteConfirmPath === entryPath;
  const isCut = cutPaths.includes(entryPath);
  const useCustomDrag = Boolean(onTreeMouseDown);
  const expanded = expandedPaths ? expandedPaths.has(entryPath) : localExpanded;
  const setExpanded = useCallback((nextExpanded: boolean) => {
    if (expandedPaths) {
      onSetExpanded?.(entryPath, nextExpanded);
      return;
    }
    setLocalExpanded(nextExpanded);
  }, [entryPath, expandedPaths, onSetExpanded]);

  // Auto-expand folder when inlineInput targets this directory
  useEffect(() => {
    if (entry.is_dir && inlineInput?.parentPath === entryPath && !expanded) {
      setExpanded(true);
    }
  }, [entry.is_dir, entryPath, inlineInput?.parentPath, expanded]);

  // Auto-expand folder when revealPath is a descendant of this directory
  useEffect(() => {
    const rp = revealPath ? revealPath.replace(/\\/g, '/') : null;
    const prevRevealPath = lastAutoRevealPathRef.current;
    lastAutoRevealPathRef.current = rp;
    if (!entry.is_dir || !rp || expanded) return;
    if (rp === prevRevealPath) return;
    const ep = entryPath.replace(/\\/g, '/');
    if (rp.startsWith(ep + '/')) {
      setExpanded(true);
    }
  }, [entry.is_dir, entryPath, revealPath, expanded, setExpanded]);

  // Handle Enter/Escape for inline delete confirm
  useEffect(() => {
    if (!isDeleteConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onDeleteConfirm?.(entry); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDeleteCancel?.(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isDeleteConfirm, entry, onDeleteConfirm, onDeleteCancel]);

  const clearHoverExpandTimer = useCallback(() => {
    if (hoverExpandTimerRef.current != null) {
      window.clearTimeout(hoverExpandTimerRef.current);
      hoverExpandTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(entry.name);
      setTimeout(() => {
        if (renameRef.current) {
          renameRef.current.focus();
          const dotIdx = entry.name.lastIndexOf('.');
          renameRef.current.setSelectionRange(0, dotIdx > 0 ? dotIdx : entry.name.length);
        }
      }, 0);
    }
  }, [isRenaming, entry.name]);

  useEffect(() => () => {
    clearHoverExpandTimer();
  }, [clearHoverExpandTimer]);

  // Load children when expanded; re-load on refreshToken change.
  const childrenLoadedRef = useRef(false);
  const lastRefreshTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (!entry.is_dir || !expanded) {
      lastRefreshTokenRef.current = refreshToken;
      if (!expanded) childrenLoadedRef.current = false;
      return;
    }
    const isRefresh = lastRefreshTokenRef.current !== refreshToken;
    lastRefreshTokenRef.current = refreshToken;
    // If children already loaded and this isn't a file-tree refresh, skip re-fetch
    if (childrenLoadedRef.current && !isRefresh) return;
    let alive = true;
    void invoke<FileEntry[]>('read_directory', { path: entryPath })
      .then((files) => {
        if (alive) { setChildren(mapChildrenWithParentPath(entryPath, files)); childrenLoadedRef.current = true; }
      })
      .catch(() => { if (alive) setChildren([]); });
    return () => { alive = false; };
  }, [expanded, entry.is_dir, entryPath, refreshToken]);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.button === 2) return;
    if (isRenaming) return;
    if (e.shiftKey && onRangeSelect) {
      onRangeSelect(resolvedEntry, e);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && onMultiSelect) {
      onMultiSelect(resolvedEntry, e);
      return;
    }
    onSelect(resolvedEntry);
    if (entry.is_dir) {
      setExpanded(!expanded);
    } else {
      onFileClick(resolvedEntry);
    }
  };

  const handleRenameSubmit = (val?: string) => {
    if (renameComposingRef.current) return;
    const n = (val ?? renameValue).trim();
    if (n && n !== entry.name) onFinishRename(entryPath, n);
    else onStartRename(null as unknown as FileEntry); // cancel
  };

  const showInlineInput = inlineInput && entry.is_dir && expanded && inlineInput.parentPath === entryPath;
  const showAiInput = aiInput && entry.is_dir && expanded && aiInput.parentPath === entryPath;

  // Auto-expand folder when AI input targets it
  useEffect(() => {
    if (entry.is_dir && aiInput?.parentPath === entryPath && !expanded) {
      setExpanded(true);
    }
  }, [entry.is_dir, entryPath, aiInput?.parentPath, expanded]);

  return (
    <div className="file-tree-item">
      <div
        className={`file-tree-row ${selectedPath === entryPath ? 'selected' : ''} ${isCut ? 'cut' : ''} ${multiSelectedPaths?.has(entryPath) ? 'multi-selected' : ''} ${(multiSelectedPaths?.has(entryPath) && selectedPath === entryPath) ? 'multi-selected-active' : ''} ${draggingPaths?.has(entryPath) ? 'dragging' : ''} ${dropTargetPath === entryPath ? 'drop-target' : ''}`}
        style={{ paddingLeft: depth * 18 + 8 }}
        role="treeitem"
        aria-label={entry.name}
        aria-selected={selectedPath === entryPath}
        aria-expanded={entry.is_dir ? expanded : undefined}
        tabIndex={0}
        draggable={!isRenaming && !useCustomDrag}
        onDragStart={(e) => {
          if (useCustomDrag) { e.preventDefault(); e.stopPropagation(); return; }
          onTreeDragStart?.(resolvedEntry, e);
        }}
        onDragEnd={(e) => { onTreeDragEnd?.(resolvedEntry, e); }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (entry.is_dir) {
            onTreeDragOverDir?.(resolvedEntry, e);
          } else if (parentPath) {
            // Hovering over a file → treat as parent directory
            onTreeDragOverDir?.({ name: '', path: parentPath, is_dir: true } as FileEntry, e);
          }
        }}
        onDragLeave={(e) => {
          if (entry.is_dir) {
            onTreeDragLeaveDir?.(resolvedEntry, e);
          } else if (parentPath) {
            onTreeDragLeaveDir?.({ name: '', path: parentPath, is_dir: true } as FileEntry, e);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (entry.is_dir) {
            onTreeDropOnDir?.(resolvedEntry, e);
          } else if (parentPath) {
            // Dropping on a file → move to file's parent directory
            onTreeDropOnDir?.({ name: '', path: parentPath, is_dir: true } as FileEntry, e);
          }
        }}
        onClick={handleClick}
        onMouseDown={(e) => { onTreeMouseDown?.(resolvedEntry, e); }}
        onMouseEnter={(e) => { onTreeMouseEnter?.(resolvedEntry, e); }}
        onMouseUp={(e) => { onTreeMouseUp?.(resolvedEntry, e); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(e as unknown as React.MouseEvent); }
        }}
        onDoubleClick={() => { if (!entry.is_dir) return; }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!multiSelectedPaths?.has(entryPath)) onSelect(resolvedEntry); onContextMenu(e, resolvedEntry); }}
        data-filepath={entryPath}
        data-isdir={entry.is_dir ? 'true' : 'false'}
      >
        {/* Indent guides */}
        {Array.from({ length: depth }).map((_, i) => (
          <span key={i} className="ftree-indent-guide" style={{ left: i * 18 + 14 }} />
        ))}
        {entry.is_dir ? (
          <span className={`ftree-chevron ${expanded ? 'expanded' : ''}`} aria-hidden="true">
            <ChevronRight size={12} />
          </span>
        ) : <span style={{ width: 12, flexShrink: 0 }} />}
        <FileIcon name={entry.name} isDir={entry.is_dir} expanded={expanded} />
        {isRenaming ? (
          <input
            ref={renameRef}
            className="ftree-inline-input"
            value={renameValue}
            aria-label={`${entry.name} ${t('fileTree.rename')}`}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setRenameValue(e.target.value)}
            onCompositionStart={() => { renameComposingRef.current = true; }}
            onCompositionEnd={(e) => {
              renameComposingRef.current = false;
              if (renameSubmitPendingRef.current) {
                renameSubmitPendingRef.current = false;
                handleRenameSubmit((e.target as HTMLInputElement).value);
              }
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                if (renameComposingRef.current) { renameSubmitPendingRef.current = true; }
                else { handleRenameSubmit(); }
              }
              if (e.key === 'Escape') { renameComposingRef.current = false; renameSubmitPendingRef.current = false; onStartRename(null as unknown as FileEntry); }
            }}
            onBlur={(e) => { renameComposingRef.current = false; renameSubmitPendingRef.current = false; handleRenameSubmit(e.currentTarget.value); }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : deleteConfirmPath === entryPath ? (
          <span className="ftree-inline-delete" style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
            <span className="file-name" style={{ opacity: 0.6, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
            <span style={{ fontSize: 10, opacity: 0.5, flexShrink: 0 }}>{t('fileTree.deletePrompt')}</span>
            <button
              className="ftree-inline-delete-yes"
              onClick={(e) => { e.stopPropagation(); onDeleteConfirm?.(resolvedEntry); }}
              style={{ background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 'var(--brutal-radius)', fontSize: 10, padding: '1px 6px', cursor: 'pointer', flexShrink: 0, fontFamily: 'inherit' }}
              title={t('fileTree.confirmDelete')}
            >{t('fileTree.confirmDelete')}</button>
            <button
              className="ftree-inline-delete-no"
              onClick={(e) => { e.stopPropagation(); onDeleteCancel?.(); }}
              style={{ background: 'color-mix(in srgb, var(--text-color) 15%, transparent)', color: 'var(--text-color)', border: 'none', borderRadius: 'var(--brutal-radius)', fontSize: 10, padding: '1px 6px', cursor: 'pointer', flexShrink: 0, fontFamily: 'inherit' }}
              title={t('fileTree.cancelDelete')}
            >{t('fileTree.cancelDelete')}</button>
          </span>
        ) : (<>
          <span className="file-name">{entry.name}</span>
          {(() => {
            const p = entryPath;
            const claudeHints: Record<string, string> = {
              'CLAUDE.md': t('fileTree.hintTeamInstructions'),
              'CLAUDE.local.md': t('fileTree.hintPersonalOverrides'),
              '.claude': t('fileTree.hintControlCenter'),
              'settings.json': t('fileTree.hintPermissionsConfig'),
              'settings.local.json': t('fileTree.hintPersonalConfig'),
              'commands': t('fileTree.hintSlashCommands'),
              'rules': t('fileTree.hintInstructionFiles'),
              'skills': t('fileTree.hintSkills'),
              'agents': t('fileTree.hintAgents'),
              'review.md': '/project:review',
              'fix-issue.md': '/project:fix-issue',
              'deploy.md': '/project:deploy',
              'code-style.md': t('fileTree.hintCodeStyle'),
              'testing.md': t('fileTree.hintTesting'),
              'api-conventions.md': t('fileTree.hintApiConventions'),
              'code-reviewer.md': t('fileTree.hintCodeReviewer'),
              'security-auditor.md': t('fileTree.hintSecurityAuditor'),
              'SKILL.md': t('fileTree.hintSkillDefinition'),
            };
            const isClaudePath = p.includes('/.claude/') || p.includes('/.claude') || entry.name === 'CLAUDE.md' || entry.name === 'CLAUDE.local.md';
            const hint = isClaudePath ? (claudeHints[entry.name] || null) : (entry.name === 'CLAUDE.md' || entry.name === 'CLAUDE.local.md' ? claudeHints[entry.name] : null);
            return hint ? <span style={{ fontSize: 9, opacity: 0.35, marginLeft: 4, flexShrink: 0, whiteSpace: 'nowrap' }}>{hint}</span> : null;
          })()}
        </>)}
      </div>
      {expanded && (
        <div className="file-tree-children">
          {showInlineInput && (
            <InlineNewInput
              depth={depth + 1}
              type={inlineInput!.type}
              onSubmit={onInlineSubmit}
              onDismiss={onInlineDismiss}
            />
          )}
          {showAiInput && onAiSubmit && onAiDismiss && (
            <AiNoteInlineInput
              generating={!!aiGenerating}
              onSubmit={onAiSubmit}
              onDismiss={onAiDismiss}
            />
          )}
          {children.map((child) => (
            <FileTreeItem
            key={buildChildPath(entryPath, child.name)}
            parentPath={entryPath}
            entry={child}
              depth={depth + 1}
              onFileClick={onFileClick}
              onSelect={onSelect}
              selectedPath={selectedPath}
              renamingPath={renamingPath}
              onStartRename={onStartRename}
              onFinishRename={onFinishRename}
              inlineInput={inlineInput}
              onInlineSubmit={onInlineSubmit}
              onInlineDismiss={onInlineDismiss}
              aiInput={aiInput}
              aiGenerating={aiGenerating}
              onAiSubmit={onAiSubmit}
              onAiDismiss={onAiDismiss}
              onContextMenu={onContextMenu}
              cutPaths={cutPaths}
              refreshToken={refreshToken}
              multiSelectedPaths={multiSelectedPaths}
              onMultiSelect={onMultiSelect}
              onRangeSelect={onRangeSelect}
              draggingPaths={draggingPaths}
              dropTargetPath={dropTargetPath}
              onTreeDragStart={onTreeDragStart}
              onTreeDragEnd={onTreeDragEnd}
              onTreeDragOverDir={onTreeDragOverDir}
              onTreeDragLeaveDir={onTreeDragLeaveDir}
              onTreeDropOnDir={onTreeDropOnDir}
              onTreeMouseDown={onTreeMouseDown}
              onTreeMouseEnter={onTreeMouseEnter}
              onTreeMouseUp={onTreeMouseUp}
              expandedPaths={expandedPaths}
              onSetExpanded={onSetExpanded}
              revealPath={revealPath}
              deleteConfirmPath={deleteConfirmPath}
              onDeleteConfirm={onDeleteConfirm}
              onDeleteCancel={onDeleteCancel}
            />
          ))}
        </div>
      )}
    </div>
  );
});
