/**
 * Phase 0.1: Centralized AppState, AppAction union, and appReducer.
 *
 * Replaces the 62+ useState calls that were scattered throughout App.tsx.
 * State is grouped by domain (projects, fileTree, modals, layout, etc.)
 * and persisted to localStorage where appropriate.
 */

import type { TerminalSettings } from '../components/SettingsPanel';
import type { SSHConnection } from '../config/schema';
import type { OctoConfig } from '../config/schema';
import { kvGet, kvSet } from '../hooks/useKV';
// theme imports removed — STYLES/FONTS accessed via AppContext selectors

// ───────────────────────── Domain Types ─────────────────────────

export interface TerminalInstance {
  id: string;
  name: string;
  cliType?: 'shell' | 'claude' | 'codex' | 'cursor' | 'opencode' | 'kimi' | 'gemini' | 'ollama' | 'qwen' | 'pi' | 'reasonix' | 'bbarit';
  autoAccept?: boolean;
  startupMode?: 'normal' | 'auto-accept' | 'bypass-permissions' | 'auto-edit' | 'full-auto' | 'yolo';
  telegramChatId?: string;
  discordChannelId?: string;
  lastWorkDir?: string;
}

export type ProjectCategory = 'common' | 'coding' | 'design' | 'document' | 'office' | 'video' | 'browser';

export interface Project {
  id: string;
  workDir: string;
  name: string;
  displayName: string;
  icon: string;
  category?: ProjectCategory;
  memo?: string;
  styleIndex: number;
  fontIndex: number;
  customFontFamily?: string;
  readOnly?: boolean;
  sites?: {
    local?: string;
    staging?: string;
    prod?: string;
  };
  linearTeamId?: string;
  linearProjectId?: string;
  telegramChatId?: string;
  discordChannelId?: string;
  hidden?: boolean;
  terminals: TerminalInstance[];
  activeTerminalId: string;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size_bytes?: number | null;
}

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  modified: boolean;
  lineCount?: number;
  sizeBytes?: number;
  kind?: 'text' | 'image' | 'markdown' | 'mermaid' | 'video' | 'audio' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'html' | 'epub' | 'sqlite' | 'book';
}

export interface TelegramLinkTarget {
  projectId: string;
  terminalId: string;
}

export interface TelegramCandidate {
  update_id: number;
  chat_id: number;
  text: string;
  chat_title?: string | null;
  chat_username?: string | null;
  chat_type?: string | null;
}

// ───────────────────────── AgentSettings re-export ──────────────
// AgentSettings is not exported from SettingsPanel, so we define the shape here.
export interface AgentSettings {
  claudeMode: 'normal' | 'auto-accept' | 'bypass-permissions';
  claudeFlags: string[];
  codexMode: 'normal' | 'auto-edit' | 'full-auto' | 'yolo';
  codexWebSearch: boolean;
  codexFlags: string[];
  cursorMode: 'normal' | 'force';
  cursorFlags: string[];
  cursorModel: string;
  kimiFlags: string[];
  qwenMode: 'normal' | 'yolo';
  qwenModel: string;
  qwenFlags: string[];
  reasonixFlags: string[];
  bbaritLanguage: 'ko' | 'en' | 'ja' | 'zh' | 'auto';
  bbaritFlags: string[];
  resumeLastSession: boolean;
  playSoundWhenDone: boolean;
  useModifierToSend: boolean;
  alwaysAllowToolActions: boolean;
  notifyWhenWaiting: 'primary_screen' | 'all_screens' | 'never';
  telegramEnabled: boolean;
  telegramMirrorCommands: boolean;
  telegramMirrorOutput: boolean;
  telegramRemoteControl: boolean;
  discordEnabled: boolean;
  discordMirrorCommands: boolean;
  discordMirrorOutput: boolean;
  discordRemoteControl: boolean;
  slackEnabled?: boolean;
  slackMirrorCommands?: boolean;
  slackMirrorOutput?: boolean;
  slackRemoteControl?: boolean;
}

// ───────────────────────── AppState ─────────────────────────────

export interface AppState {
  // === Projects ===
  projects: Project[];
  activeProjectId: string | null;

  // === New Project Modal ===
  showNewProjectModal: boolean;
  newProjectPath: string;
  newProjectDisplayName: string;
  newStyleIndex: number;
  newFontIndex: number;
  newProjectReadOnly: boolean;

  // === Project Settings Modal ===
  showProjectSettingsModal: boolean;
  editProjectId: string | null;
  editProjectPath: string;
  editProjectDisplayName: string;
  editStyleIndex: number;
  editFontIndex: number;
  editRestartTerminals: boolean;
  editProjectReadOnly: boolean;
  editSiteLocal: string;
  editSiteStaging: string;
  editSiteProd: string;

  // === File Tree ===
  fileTree: FileEntry[];
  fileTreeRefreshToken: number;
  renamingPath: string | null;
  renamingValue: string;
  creatingKind: null | 'file' | 'folder';
  creatingBaseDir: string;
  creatingValue: string;
  creatingError: string | null;
  selectedFileEntry: FileEntry | null;
  fileTreeStatus: string | null;

  // === Open Files / Editor ===
  openFiles: OpenFile[];
  activeFilePath: string | null;

  // === UI Panels ===
  showGlobalSettings: boolean;
  showMemo: boolean;

  // === Layout ===
  viewMode: 'default' | 'terminal';
  terminalSplitMode: 'tabs' | 'horizontal' | 'vertical' | 'grid' | 'mix';
  terminalHeight: number;
  isResizing: boolean;
  sidebarWidth: number;
  isSidebarResizing: boolean;
  terminalSizes: number[];

  // === Project Drag & Drop ===
  dragProjectId: string | null;
  dragOverProjectId: string | null;

  // === Project Name Editing (inline) ===
  editingProjectId: string | null;
  editingProjectName: string;

  // === Memo ===
  globalMemoContent: string;
  projectMemos: Record<string, string>;

  // === Telegram Link Modal ===
  telegramLinkTarget: TelegramLinkTarget | null;
  telegramLinkChatId: string;
  telegramLinkDetecting: boolean;
  telegramLinkError: string | null;
  telegramLinkCandidates: TelegramCandidate[];

  // === Project Switch Overlay ===
  projectSwitchLabel: string | null;

  // === Settings (live) ===
  terminalSettings: TerminalSettings;
  agentSettings: AgentSettings;
  sshConnections: SSHConnection[];

  // === Tooltip ===
  tooltip: { text: string; x: number; y: number; visible: boolean; position: 'above' | 'below' };

  // === Update ===
  updateAvailable: { version: string; body?: string } | null;
  isUpdating: boolean;
}

// ───────────────────────── Helpers ──────────────────────────────

const STORAGE_KEY = 'octo-terminal-projects';

export const projectNumberIcon = (n: number): string => String(n);

const VALID_PROJECT_CATEGORIES: ProjectCategory[] = ['common', 'coding', 'design', 'document', 'office', 'video', 'browser'];

function normalizeProjectCategory(value: unknown, workDir?: string): ProjectCategory | undefined {
  if (typeof value === 'string' && VALID_PROJECT_CATEGORIES.includes(value as ProjectCategory)) {
    return value as ProjectCategory;
  }
  const normalized = String(workDir || '').replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)agent-browser-cli(?:\/|$)/.test(normalized)) return 'browser';
  return undefined;
}

export const renumberProjects = (list: Project[]): Project[] =>
  list.map((p, idx) => ({ ...p, icon: projectNumberIcon(idx + 1) }));

export function createTerminal(
  name: string = 'Terminal 1',
  cliType: 'shell' | 'claude' | 'codex' | 'cursor' | 'opencode' | 'kimi' | 'gemini' | 'ollama' | 'qwen' | 'pi' | 'reasonix' | 'bbarit' = 'shell',
  autoAccept: boolean = false
): TerminalInstance {
  return {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
    name,
    cliType,
    autoAccept,
    telegramChatId: '',
  };
}

export function saveProjects(projects: Project[], activeId: string | null) {
  const data = {
    version: 2,
    projects: projects.map(p => ({
      id: p.id,
      workDir: p.workDir,
      name: p.name,
      displayName: p.displayName,
      icon: p.icon,
      // category: p.category,
      category: 'coding',
      memo: p.memo || '',
      styleIndex: p.styleIndex,
      fontIndex: p.fontIndex,
      customFontFamily: p.customFontFamily || undefined,
      readOnly: !!p.readOnly,
      linearTeamId: p.linearTeamId || undefined,
      linearProjectId: p.linearProjectId || undefined,
      telegramChatId: p.telegramChatId || undefined,
      discordChannelId: p.discordChannelId || undefined,
      terminals: (p.terminals || []).map(t => ({
        id: t.id,
        name: t.name,
        cliType: t.cliType,
        autoAccept: !!t.autoAccept,
        startupMode: t.startupMode || undefined,
        telegramChatId: (t.telegramChatId || '').trim(),
        discordChannelId: (t.discordChannelId || '').trim(),
        lastWorkDir: t.lastWorkDir || '',
      })),
      activeTerminalId: p.activeTerminalId,
    })),
    activeProjectId: activeId,
  };
  void kvSet(STORAGE_KEY, JSON.stringify(data));
}

export async function loadProjects(): Promise<{ projects: Project[]; activeProjectId: string | null }> {
  try {
    const data = await kvGet(STORAGE_KEY);
    if (!data) return { projects: [], activeProjectId: null };
    const parsed = JSON.parse(data) as { projects?: unknown; activeProjectId?: unknown };
    const list = Array.isArray(parsed.projects) ? parsed.projects : [];

    const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

    const projects: Project[] = list.map((p, idx: number) => {
      const po = isRecord(p) ? p : {};
      const terminalsRaw = po.terminals;
      const terminals: TerminalInstance[] =
        Array.isArray(terminalsRaw) && terminalsRaw.length > 0
          ? terminalsRaw.map((t, tIdx: number) => {
              const to = isRecord(t) ? t : {};
              const id =
                (typeof to.id === 'string' && to.id.trim())
                  ? to.id
                  : (Date.now().toString() + Math.random().toString(36).slice(2));
              const name =
                (typeof to.name === 'string' && to.name.trim())
                  ? to.name
                  : `Terminal ${tIdx + 1}`;
              const cliType =
                to.cliType === 'claude' || to.cliType === 'codex' || to.cliType === 'cursor' || to.cliType === 'opencode' || to.cliType === 'kimi' || to.cliType === 'gemini' || to.cliType === 'ollama' || to.cliType === 'qwen' || to.cliType === 'pi' || to.cliType === 'reasonix' || to.cliType === 'bbarit' || to.cliType === 'shell'
                  ? to.cliType
                  : 'shell';
              const telegramChatId = typeof to.telegramChatId === 'string' ? to.telegramChatId : '';
              const discordChannelId = typeof to.discordChannelId === 'string' ? to.discordChannelId : '';
              const lastWorkDir = typeof to.lastWorkDir === 'string' && (to.lastWorkDir as string).trim() ? to.lastWorkDir as string : undefined;
              const VALID_STARTUP_MODES = ['normal', 'auto-accept', 'bypass-permissions', 'auto-edit', 'full-auto', 'yolo'];
              const startupMode = typeof to.startupMode === 'string' && VALID_STARTUP_MODES.includes(to.startupMode)
                ? to.startupMode as TerminalInstance['startupMode']
                : undefined;
              return { id, name, cliType, autoAccept: !!to.autoAccept, startupMode, telegramChatId, discordChannelId, lastWorkDir };
            })
          : [createTerminal()];

      const savedActiveTerminalId = typeof po.activeTerminalId === 'string' ? po.activeTerminalId : '';
      const activeTerminalId = terminals.some((t) => t.id === savedActiveTerminalId)
        ? savedActiveTerminalId
        : terminals[0].id;

      const id =
        (typeof po.id === 'string' && po.id.trim())
          ? po.id
          : (Date.now().toString() + Math.random().toString(36).slice(2));
      const workDir = typeof po.workDir === 'string' ? po.workDir : '';
      const name = typeof po.name === 'string' ? po.name : `Project ${idx + 1}`;
      const displayName = typeof po.displayName === 'string' ? po.displayName : name;
      const memo = typeof po.memo === 'string' ? po.memo : '';
      // const category = normalizeProjectCategory(po.category, workDir);
      const category: ProjectCategory = 'coding';
      const styleIndex = typeof po.styleIndex === 'number' ? po.styleIndex : 0;
      const fontIndex = typeof po.fontIndex === 'number' ? po.fontIndex : 0;
      const customFontFamily = typeof po.customFontFamily === 'string' && po.customFontFamily.trim() ? po.customFontFamily.trim() : undefined;
      const readOnly = !!po.readOnly;
      const linearTeamId = typeof po.linearTeamId === 'string' && po.linearTeamId.trim() ? po.linearTeamId.trim() : undefined;
      const linearProjectId = typeof po.linearProjectId === 'string' && po.linearProjectId.trim() ? po.linearProjectId.trim() : undefined;
      const telegramChatId = typeof po.telegramChatId === 'string' && (po.telegramChatId as string).trim() ? (po.telegramChatId as string).trim() : undefined;
      const discordChannelId = typeof po.discordChannelId === 'string' && (po.discordChannelId as string).trim() ? (po.discordChannelId as string).trim() : undefined;

      const sites = isRecord(po.sites) ? po.sites : {};
      const local = String((typeof sites.local === 'string' ? sites.local : (typeof po.localUrl === 'string' ? po.localUrl : '')) || '').trim();
      const staging = String((typeof sites.staging === 'string' ? sites.staging : (typeof po.stagingUrl === 'string' ? po.stagingUrl : '')) || '').trim();
      const prod = String((typeof sites.prod === 'string' ? sites.prod : (typeof po.prodUrl === 'string' ? po.prodUrl : '')) || '').trim();

      return {
        id,
        workDir,
        name,
        displayName,
        icon: projectNumberIcon(idx + 1),
        category,
        memo,
        styleIndex,
        fontIndex,
        customFontFamily,
        readOnly,
        linearTeamId,
        linearProjectId,
        telegramChatId,
        discordChannelId,
        sites: { local, staging, prod },
        terminals,
        activeTerminalId,
      };
    });

    const activeProjectId =
      typeof parsed.activeProjectId === 'string'
        ? parsed.activeProjectId
        : (projects[0]?.id || null);

    return { projects, activeProjectId };
  } catch {
    return { projects: [], activeProjectId: null };
  }
}

// ───────────────────────── Initial State ────────────────────────

export function createInitialState(config?: OctoConfig): AppState {
  return {
    // Projects (loaded async via loadProjects())
    projects: [],
    activeProjectId: null,

    // New Project Modal
    showNewProjectModal: true,
    newProjectPath: '',
    newProjectDisplayName: '',
    newStyleIndex: 0,
    newFontIndex: 0,
    newProjectReadOnly: false,

    // Project Settings Modal
    showProjectSettingsModal: false,
    editProjectId: null,
    editProjectPath: '',
    editProjectDisplayName: '',
    editStyleIndex: 0,
    editFontIndex: 0,
    editRestartTerminals: false,
    editProjectReadOnly: false,
    editSiteLocal: '',
    editSiteStaging: '',
    editSiteProd: '',

    // File Tree
    fileTree: [],
    fileTreeRefreshToken: 0,
    renamingPath: null,
    renamingValue: '',
    creatingKind: null,
    creatingBaseDir: '',
    creatingValue: '',
    creatingError: null,
    selectedFileEntry: null,
    fileTreeStatus: null,

    // Open Files / Editor
    openFiles: [],
    activeFilePath: null,

    // UI Panels
    showGlobalSettings: false,
    showMemo: false,

    // Layout (from config file)
    viewMode: config?.layout.viewMode ?? 'default',
    terminalSplitMode: 'tabs',
    terminalHeight: config?.layout.terminalHeight ?? 450,
    isResizing: false,
    sidebarWidth: config?.layout.sidebarWidth ?? 220,
    isSidebarResizing: false,
    terminalSizes: [],

    // Drag & Drop
    dragProjectId: null,
    dragOverProjectId: null,

    // Project Name Editing
    editingProjectId: null,
    editingProjectName: '',

    // Memo (from config file)
    globalMemoContent: config?.memos.global ?? '',
    projectMemos: config?.memos.perProject ?? {},

    // Telegram Link Modal
    telegramLinkTarget: null,
    telegramLinkChatId: '',
    telegramLinkDetecting: false,
    telegramLinkError: null,
    telegramLinkCandidates: [],

    // Project Switch Overlay
    projectSwitchLabel: null,

    // Settings (from config file)
    terminalSettings: (config?.terminal ?? {
      fontSize: 14, cursorBlink: false, cursorShape: 'bar', scrollback: 5000,
      maxTerminalsPerRow: 3, inputMode: 'direct', autoSaveSession: true, autoSaveFiles: true,
    }) as TerminalSettings,
    agentSettings: (config?.agent ?? {
      claudeMode: 'auto-accept', claudeFlags: [], codexMode: 'full-auto', codexWebSearch: true, codexFlags: [], kimiFlags: [], qwenMode: 'normal', qwenModel: '', qwenFlags: [], playSoundWhenDone: false,
      useModifierToSend: false, alwaysAllowToolActions: false, notifyWhenWaiting: 'primary_screen',
      telegramEnabled: false, telegramMirrorCommands: true, telegramMirrorOutput: true,
      telegramRemoteControl: false,
      discordEnabled: false, discordMirrorCommands: true, discordMirrorOutput: true,
      discordRemoteControl: false,
      slackEnabled: false, slackMirrorCommands: true, slackMirrorOutput: true,
      slackRemoteControl: false,
    }) as AgentSettings,
    sshConnections: config?.sshConnections ?? [],

    // Tooltip
    tooltip: { text: '', x: 0, y: 0, visible: false, position: 'below' as const },

    // Update
    updateAvailable: null,
    isUpdating: false,
  };
}

// ───────────────────────── Action Types ─────────────────────────

export type AppAction =
  // === Projects ===
  | { type: 'SET_PROJECTS'; projects: Project[] }
  | { type: 'UPDATE_PROJECT'; projectId: string; updater: (p: Project) => Project }
  | { type: 'SET_ACTIVE_PROJECT'; projectId: string | null }
  | { type: 'ADD_PROJECT'; project: Project }
  | { type: 'REMOVE_PROJECT'; projectId: string }
  | { type: 'REORDER_PROJECTS'; fromId: string; toId: string }

  // === New Project Modal ===
  | { type: 'SHOW_NEW_PROJECT_MODAL'; show: boolean }
  | { type: 'SET_NEW_PROJECT_PATH'; path: string }
  | { type: 'SET_NEW_PROJECT_DISPLAY_NAME'; name: string }
  | { type: 'SET_NEW_STYLE_INDEX'; index: number }
  | { type: 'SET_NEW_FONT_INDEX'; index: number }
  | { type: 'SET_NEW_PROJECT_READ_ONLY'; readOnly: boolean }

  // === Project Settings Modal ===
  | { type: 'OPEN_PROJECT_SETTINGS'; projectId: string; path: string; displayName: string; styleIndex: number; fontIndex: number; readOnly: boolean; siteLocal: string; siteStaging: string; siteProd: string }
  | { type: 'CLOSE_PROJECT_SETTINGS' }
  | { type: 'SET_EDIT_PROJECT_PATH'; path: string }
  | { type: 'SET_EDIT_PROJECT_DISPLAY_NAME'; name: string }
  | { type: 'SET_EDIT_STYLE_INDEX'; index: number }
  | { type: 'SET_EDIT_FONT_INDEX'; index: number }
  | { type: 'SET_EDIT_RESTART_TERMINALS'; restart: boolean }
  | { type: 'SET_EDIT_PROJECT_READ_ONLY'; readOnly: boolean }
  | { type: 'SET_EDIT_SITE_LOCAL'; value: string }
  | { type: 'SET_EDIT_SITE_STAGING'; value: string }
  | { type: 'SET_EDIT_SITE_PROD'; value: string }

  // === File Tree ===
  | { type: 'SET_FILE_TREE'; entries: FileEntry[] }
  | { type: 'BUMP_FILE_TREE_REFRESH' }
  | { type: 'SET_RENAMING_PATH'; path: string | null }
  | { type: 'SET_RENAMING_VALUE'; value: string }
  | { type: 'SET_CREATING_KIND'; kind: null | 'file' | 'folder' }
  | { type: 'SET_CREATING_BASE_DIR'; dir: string }
  | { type: 'SET_CREATING_VALUE'; value: string }
  | { type: 'SET_CREATING_ERROR'; error: string | null }
  | { type: 'CANCEL_CREATE' }
  | { type: 'SET_SELECTED_FILE_ENTRY'; entry: FileEntry | null }
  | { type: 'SET_FILE_TREE_STATUS'; status: string | null }

  // === Open Files / Editor ===
  | { type: 'SET_OPEN_FILES'; files: OpenFile[] }
  | { type: 'UPDATE_OPEN_FILES'; updater: (files: OpenFile[]) => OpenFile[] }
  | { type: 'ADD_OPEN_FILE'; file: OpenFile }
  | { type: 'CLOSE_FILE'; path: string }
  | { type: 'SET_ACTIVE_FILE_PATH'; path: string | null }
  | { type: 'UPDATE_FILE_CONTENT'; path: string; content: string }
  | { type: 'MARK_FILE_SAVED'; path: string; content: string }

  // === UI Panels ===
  | { type: 'SHOW_GLOBAL_SETTINGS'; show: boolean }
  | { type: 'SHOW_MEMO'; show: boolean }

  // === Layout ===
  | { type: 'SET_VIEW_MODE'; mode: 'default' | 'terminal' }
  | { type: 'TOGGLE_VIEW_MODE' }
  | { type: 'SET_TERMINAL_SPLIT_MODE'; mode: 'tabs' | 'horizontal' | 'vertical' | 'grid' | 'mix' }
  | { type: 'SET_TERMINAL_HEIGHT'; height: number }
  | { type: 'SET_IS_RESIZING'; resizing: boolean }
  | { type: 'SET_SIDEBAR_WIDTH'; width: number }
  | { type: 'SET_IS_SIDEBAR_RESIZING'; resizing: boolean }
  | { type: 'SET_TERMINAL_SIZES'; sizes: number[] }

  // === Drag & Drop ===
  | { type: 'SET_DRAG_PROJECT_ID'; id: string | null }
  | { type: 'SET_DRAG_OVER_PROJECT_ID'; id: string | null }

  // === Project Name Editing ===
  | { type: 'SET_EDITING_PROJECT_ID'; id: string | null }
  | { type: 'SET_EDITING_PROJECT_NAME'; name: string }

  // === Memo ===
  | { type: 'SET_GLOBAL_MEMO'; content: string }
  | { type: 'SET_PROJECT_MEMO'; projectId: string; content: string }

  // === Telegram Link ===
  | { type: 'OPEN_TELEGRAM_LINK'; target: TelegramLinkTarget; chatId: string }
  | { type: 'CLOSE_TELEGRAM_LINK' }
  | { type: 'SET_TELEGRAM_LINK_CHAT_ID'; chatId: string }
  | { type: 'SET_TELEGRAM_LINK_DETECTING'; detecting: boolean }
  | { type: 'SET_TELEGRAM_LINK_ERROR'; error: string | null }
  | { type: 'SET_TELEGRAM_LINK_CANDIDATES'; candidates: TelegramCandidate[] }

  // === Project Switch Overlay ===
  | { type: 'SET_PROJECT_SWITCH_LABEL'; label: string | null }

  // === Settings ===
  | { type: 'SET_TERMINAL_SETTINGS'; settings: TerminalSettings }
  | { type: 'SET_AGENT_SETTINGS'; settings: AgentSettings }
  | { type: 'SET_SSH_CONNECTIONS'; connections: SSHConnection[] }

  // === Tooltip ===
  | { type: 'SET_TOOLTIP'; tooltip: { text: string; x: number; y: number; visible: boolean; position: 'above' | 'below' } }

  // === Update ===
  | { type: 'SET_UPDATE_AVAILABLE'; update: { version: string; body?: string } | null }
  | { type: 'SET_IS_UPDATING'; updating: boolean }

  // === Reset on project switch ===
  | { type: 'RESET_ON_PROJECT_SWITCH' }
;

// ───────────────────────── Reducer ──────────────────────────────

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    // === Projects ===
    case 'SET_PROJECTS':
      return { ...state, projects: action.projects };

    case 'UPDATE_PROJECT':
      return {
        ...state,
        projects: state.projects.map(p =>
          p.id === action.projectId ? action.updater(p) : p
        ),
      };

    case 'SET_ACTIVE_PROJECT':
      return { ...state, activeProjectId: action.projectId };

    case 'ADD_PROJECT':
      return { ...state, projects: [...state.projects, action.project] };

    case 'REMOVE_PROJECT': {
      const remaining = state.projects.filter(p => p.id !== action.projectId);
      const renumbered = renumberProjects(remaining);
      const newActiveId = state.activeProjectId === action.projectId
        ? (renumbered[0]?.id || null)
        : state.activeProjectId;
      return {
        ...state,
        projects: renumbered,
        activeProjectId: newActiveId,
        showNewProjectModal: renumbered.length === 0 ? true : state.showNewProjectModal,
      };
    }

    case 'REORDER_PROJECTS': {
      const fromIdx = state.projects.findIndex(p => p.id === action.fromId);
      const toIdx = state.projects.findIndex(p => p.id === action.toId);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return state;
      const next = state.projects.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return { ...state, projects: renumberProjects(next) };
    }

    // === New Project Modal ===
    case 'SHOW_NEW_PROJECT_MODAL':
      return { ...state, showNewProjectModal: action.show };
    case 'SET_NEW_PROJECT_PATH':
      return { ...state, newProjectPath: action.path };
    case 'SET_NEW_PROJECT_DISPLAY_NAME':
      return { ...state, newProjectDisplayName: action.name };
    case 'SET_NEW_STYLE_INDEX':
      return { ...state, newStyleIndex: action.index };
    case 'SET_NEW_FONT_INDEX':
      return { ...state, newFontIndex: action.index };
    case 'SET_NEW_PROJECT_READ_ONLY':
      return { ...state, newProjectReadOnly: action.readOnly };

    // === Project Settings Modal ===
    case 'OPEN_PROJECT_SETTINGS':
      return {
        ...state,
        showProjectSettingsModal: true,
        editProjectId: action.projectId,
        editProjectPath: action.path,
        editProjectDisplayName: action.displayName,
        editStyleIndex: action.styleIndex,
        editFontIndex: action.fontIndex,
        editRestartTerminals: false,
        editProjectReadOnly: action.readOnly,
        editSiteLocal: action.siteLocal,
        editSiteStaging: action.siteStaging,
        editSiteProd: action.siteProd,
      };
    case 'CLOSE_PROJECT_SETTINGS':
      return { ...state, showProjectSettingsModal: false, editProjectId: null };
    case 'SET_EDIT_PROJECT_PATH':
      return { ...state, editProjectPath: action.path };
    case 'SET_EDIT_PROJECT_DISPLAY_NAME':
      return { ...state, editProjectDisplayName: action.name };
    case 'SET_EDIT_STYLE_INDEX':
      return { ...state, editStyleIndex: action.index };
    case 'SET_EDIT_FONT_INDEX':
      return { ...state, editFontIndex: action.index };
    case 'SET_EDIT_RESTART_TERMINALS':
      return { ...state, editRestartTerminals: action.restart };
    case 'SET_EDIT_PROJECT_READ_ONLY':
      return { ...state, editProjectReadOnly: action.readOnly };
    case 'SET_EDIT_SITE_LOCAL':
      return { ...state, editSiteLocal: action.value };
    case 'SET_EDIT_SITE_STAGING':
      return { ...state, editSiteStaging: action.value };
    case 'SET_EDIT_SITE_PROD':
      return { ...state, editSiteProd: action.value };

    // === File Tree ===
    case 'SET_FILE_TREE':
      return { ...state, fileTree: action.entries };
    case 'BUMP_FILE_TREE_REFRESH':
      return { ...state, fileTreeRefreshToken: state.fileTreeRefreshToken + 1 };
    case 'SET_RENAMING_PATH':
      return { ...state, renamingPath: action.path };
    case 'SET_RENAMING_VALUE':
      return { ...state, renamingValue: action.value };
    case 'SET_CREATING_KIND':
      return { ...state, creatingKind: action.kind };
    case 'SET_CREATING_BASE_DIR':
      return { ...state, creatingBaseDir: action.dir };
    case 'SET_CREATING_VALUE':
      return { ...state, creatingValue: action.value };
    case 'SET_CREATING_ERROR':
      return { ...state, creatingError: action.error };
    case 'CANCEL_CREATE':
      return { ...state, creatingKind: null, creatingBaseDir: '', creatingValue: '', creatingError: null };
    case 'SET_SELECTED_FILE_ENTRY':
      return { ...state, selectedFileEntry: action.entry };
    case 'SET_FILE_TREE_STATUS':
      return { ...state, fileTreeStatus: action.status };

    // === Open Files / Editor ===
    case 'SET_OPEN_FILES':
      return { ...state, openFiles: action.files };
    case 'UPDATE_OPEN_FILES':
      return { ...state, openFiles: action.updater(state.openFiles) };
    case 'ADD_OPEN_FILE':
      if (state.openFiles.some(f => f.path === action.file.path)) return state;
      return { ...state, openFiles: [...state.openFiles, action.file] };
    case 'CLOSE_FILE': {
      const remaining = state.openFiles.filter(f => f.path !== action.path);
      const newActive = state.activeFilePath === action.path
        ? (remaining[0]?.path || null)
        : state.activeFilePath;
      return { ...state, openFiles: remaining, activeFilePath: newActive };
    }
    case 'SET_ACTIVE_FILE_PATH':
      return { ...state, activeFilePath: action.path };
    case 'UPDATE_FILE_CONTENT':
      return {
        ...state,
        openFiles: state.openFiles.map(f =>
          f.path === action.path ? { ...f, content: action.content, modified: true } : f
        ),
      };
    case 'MARK_FILE_SAVED':
      return {
        ...state,
        openFiles: state.openFiles.map(f =>
          f.path === action.path && f.content === action.content ? { ...f, modified: false } : f
        ),
      };

    // === UI Panels ===
    case 'SHOW_GLOBAL_SETTINGS':
      return { ...state, showGlobalSettings: action.show };
    case 'SHOW_MEMO':
      return { ...state, showMemo: action.show };

    // === Layout ===
    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.mode };
    case 'TOGGLE_VIEW_MODE':
      return { ...state, viewMode: state.viewMode === 'terminal' ? 'default' : 'terminal' };
    case 'SET_TERMINAL_SPLIT_MODE':
      return { ...state, terminalSplitMode: action.mode };
    case 'SET_TERMINAL_HEIGHT':
      return { ...state, terminalHeight: action.height };
    case 'SET_IS_RESIZING':
      return { ...state, isResizing: action.resizing };
    case 'SET_SIDEBAR_WIDTH':
      return { ...state, sidebarWidth: action.width };
    case 'SET_IS_SIDEBAR_RESIZING':
      return { ...state, isSidebarResizing: action.resizing };
    case 'SET_TERMINAL_SIZES':
      return { ...state, terminalSizes: action.sizes };

    // === Drag & Drop ===
    case 'SET_DRAG_PROJECT_ID':
      return { ...state, dragProjectId: action.id };
    case 'SET_DRAG_OVER_PROJECT_ID':
      return { ...state, dragOverProjectId: action.id };

    // === Project Name Editing ===
    case 'SET_EDITING_PROJECT_ID':
      return { ...state, editingProjectId: action.id };
    case 'SET_EDITING_PROJECT_NAME':
      return { ...state, editingProjectName: action.name };

    // === Memo ===
    case 'SET_GLOBAL_MEMO':
      return { ...state, globalMemoContent: action.content };
    case 'SET_PROJECT_MEMO':
      return { ...state, projectMemos: { ...state.projectMemos, [action.projectId]: action.content } };

    // === Telegram Link ===
    case 'OPEN_TELEGRAM_LINK':
      return {
        ...state,
        telegramLinkTarget: action.target,
        telegramLinkChatId: action.chatId,
        telegramLinkError: null,
        telegramLinkCandidates: [],
      };
    case 'CLOSE_TELEGRAM_LINK':
      return {
        ...state,
        telegramLinkTarget: null,
        telegramLinkError: null,
        telegramLinkCandidates: [],
        telegramLinkDetecting: false,
      };
    case 'SET_TELEGRAM_LINK_CHAT_ID':
      return { ...state, telegramLinkChatId: action.chatId };
    case 'SET_TELEGRAM_LINK_DETECTING':
      return { ...state, telegramLinkDetecting: action.detecting };
    case 'SET_TELEGRAM_LINK_ERROR':
      return { ...state, telegramLinkError: action.error };
    case 'SET_TELEGRAM_LINK_CANDIDATES':
      return { ...state, telegramLinkCandidates: action.candidates };

    // === Project Switch Overlay ===
    case 'SET_PROJECT_SWITCH_LABEL':
      return { ...state, projectSwitchLabel: action.label };

    // === Settings ===
    case 'SET_TERMINAL_SETTINGS':
      return { ...state, terminalSettings: action.settings };
    case 'SET_AGENT_SETTINGS':
      return { ...state, agentSettings: action.settings };
    case 'SET_SSH_CONNECTIONS':
      return { ...state, sshConnections: action.connections };

    // === Tooltip ===
    case 'SET_TOOLTIP':
      return { ...state, tooltip: action.tooltip };

    // === Update ===
    case 'SET_UPDATE_AVAILABLE':
      return { ...state, updateAvailable: action.update };
    case 'SET_IS_UPDATING':
      return { ...state, isUpdating: action.updating };

    // === Reset on project switch ===
    case 'RESET_ON_PROJECT_SWITCH':
      return {
        ...state,
        selectedFileEntry: null,
        showProjectSettingsModal: false,
        editProjectId: null,
        creatingKind: null,
        creatingBaseDir: '',
        creatingValue: '',
        creatingError: null,
        renamingPath: null,
        renamingValue: '',
      };

    default:
      return state;
  }
}

// ───────────────────────── Persistence Side Effects ─────────────
// These are called from the Context provider via useEffect.

export function persistProjects(projects: Project[], activeProjectId: string | null) {
  saveProjects(projects, activeProjectId);
}

// persistLayout and persistMemos are now handled by AppContext via ConfigContext.
// Kept as no-ops for backwards compatibility during migration.
export function persistLayout() { /* now via config file */ }
export function persistMemos() { /* now via config file */ }
