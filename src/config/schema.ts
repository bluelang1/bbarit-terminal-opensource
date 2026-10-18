/**
 * Phase 1.1: OctoConfig Schema
 *
 * Typed JSON config file schema. Replaces localStorage.
 * Persisted to ~/.config/octo/config.json.
 */

// ───────────────────────── Sub-types ─────────────────────────

export const LATEST_OPENAI_STT_MODEL = 'gpt-4o-transcribe';

export function normalizeOpenAiSttModel(model: string | null | undefined): string {
  const trimmed = (model || '').trim();
  if (!trimmed || /^whisper-\d+$/i.test(trimmed)) return LATEST_OPENAI_STT_MODEL;
  return trimmed;
}

export type ShellType = 'powershell' | 'cmd' | 'gitbash' | 'wsl';

export interface TerminalConfig {
  fontSize: number;
  cursorBlink: boolean;
  cursorShape: 'block' | 'underline' | 'bar';
  scrollback: number;
  maxTerminalsPerRow: number;
  inputMode: 'direct' | 'ime';
  autoSaveSession: boolean;
  autoSaveFiles: boolean;
  showProjectName: boolean;
  showTelegramControls: boolean;
  shellType: ShellType;
  tmuxAutoStart: boolean;
  confirmOnClose: boolean;
  /** Extended keyboard: send kitty-style CSI-u sequences for Ctrl/Alt+Enter combos. */
  csiUKeys: boolean;
  /** JIS keyboards: physical Yen (¥) key sends a backslash. */
  jisYenToBackslash: boolean;
  /** Floating terminal: starting working directory for new tabs ('' = home). */
  floatingTermStartDir: string;
}

export interface AgentConfig {
  claudeMode: 'normal' | 'auto-accept' | 'bypass-permissions';
  claudeFlags: string[];
  claudeModel: string;
  codexMode: 'normal' | 'auto-edit' | 'full-auto' | 'yolo';
  codexWebSearch: boolean;
  codexFlags: string[];
  codexModel: string;
  cursorMode: 'normal' | 'force';
  cursorFlags: string[];
  cursorModel: string;
  kimiMode: 'normal' | 'yolo';
  kimiFlags: string[];
  geminiModel: string;
  geminiFlags: string[];
  qwenMode: 'normal' | 'yolo';
  qwenModel: string;
  qwenFlags: string[];
  reasonixFlags: string[];
  bbaritLanguage: 'ko' | 'en' | 'ja' | 'zh' | 'auto';
  bbaritPersona: string;
  bbaritFlags: string[];
  resumeLastSession: boolean;
  playSoundWhenDone: boolean;
  playOsNotifySound: boolean;
  osNotifySoundName: string;
  useModifierToSend: boolean;
  alwaysAllowToolActions: boolean;
  notifyWhenWaiting: 'primary_screen' | 'all_screens' | 'never';
  notifyOnTaskComplete: boolean;
  telegramEnabled: boolean;
  telegramMirrorCommands: boolean;
  telegramMirrorOutput: boolean;
  telegramRemoteControl: boolean;
  discordEnabled: boolean;
  discordMirrorCommands: boolean;
  discordMirrorOutput: boolean;
  discordRemoteControl: boolean;
  slackEnabled: boolean;
  slackMirrorCommands: boolean;
  slackMirrorOutput: boolean;
  slackRemoteControl: boolean;
}

export interface EditorConfig {
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  renderWhitespace: 'none' | 'selection' | 'all';
  vimMode: boolean;
  emmet: boolean;
}

export interface SttConfig {
  language: string;
  model: string;
  micDeviceId: string;
  autoEnter: boolean;
  prompt: string;
  silenceGate: boolean;
  hallucinationFilter: boolean;
  minDurationMs: number;
  minRms: number;
  disableProcessing: boolean;
  boost: number;
  useLocalWhisper: boolean;
  localWhisperModel: string;
}

export interface OllamaConfig {
  url: string;
  model: string;
}

export interface NoteTemplate {
  id: string;
  name: string;
  content: string;
}

export interface OperationRulesConfig {
  activeRules: string[];
  customRules: string;
}

export interface LayoutConfig {
  viewMode: 'default' | 'terminal';
  terminalHeight: number;
  sidebarWidth: number;
}

export interface QuickCommand {
  id: string;
  name: string;
  command: string;
  icon: string;
  /** 'global' (default) shows everywhere; 'project' only in its projectRoot. */
  scope?: 'global' | 'project';
  projectRoot?: string;
}

/** Imported/custom terminal color theme (Ghostty/Warp import or user-defined). */
export interface CustomTheme {
  id: string;
  name: string;
  source: 'ghostty' | 'warp' | 'custom';
  bg: string;
  text: string;
  accent: string;
  /** ANSI 16-color palette (#RRGGBB × 16). */
  ansi?: string[];
  cursor?: string;
  selectionBg?: string;
}

export interface SSHConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  identityFile?: string;
}

export interface ShannonConfig {
  installPath: string;       // Shannon install path
  defaultOutputPath: string; // Report output path
  pollIntervalMs: number;    // Status polling interval (default 5000)
}

export interface EasterEggMedia {
  type: 'default' | 'image' | 'video';
  path: string;
}

export interface GatewayConfig {
  port: number;              // Gateway server port (default 3848)
  host: string;              // Gateway server host (default 127.0.0.1)
  autoStart: boolean;        // Auto-start Gateway on app launch
  password?: string;         // Secretary gateway access password — when set, external chat requires it in addition to the token URL
}

export interface RecentProject {
  path: string;
  name: string;
  lastOpened: string;
}

// ───────────────────────── MCP Server Types ─────────────────────────

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  autoStart?: boolean;
  useWithCli?: 'claude' | 'codex' | 'both' | 'none';
}

// ───────────────────────── Skill Types ─────────────────────────

export type SkillCliType = 'shell' | 'claude' | 'codex' | 'cursor' | 'opencode' | 'kimi' | 'gemini' | 'ollama' | 'qwen' | 'pi' | 'reasonix' | 'bbarit';
export type SkillCategory = 'dev' | 'git' | 'ai' | 'ops' | 'custom';

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  emoji: string;
  command: string;
  cliType: SkillCliType;
  category: SkillCategory;
  tags?: string[];
  builtIn?: boolean;
  model?: string;
}

// ───────────────────────── Database Types ─────────────────────────

export interface DatabaseConnection {
  id: string;
  name: string;
  dbType: 'mysql' | 'postgres';
  host: string;
  port: number;
  username: string;
  database: string;
  // password is stored in KV store with key 'octo-db-pw-{id}'
}

// ───────────────────────── Project-specific Config ─────────────────────────

export interface ProjectConfig {
  shellType?: ShellType;
  envVars?: Record<string, string>;
  fontSize?: number;
}

// ───────────────────────── Main Config ─────────────────────────

export interface OctoConfig {
  version: number;
  terminal: TerminalConfig;
  agent: AgentConfig;
  editor: EditorConfig;
  stt: SttConfig;
  ollama: OllamaConfig;
  language: 'en' | 'ko' | 'ja' | 'zh' | 'fr' | 'de' | 'it' | 'es';
  keybindingPreset: 'default' | 'vscode' | 'intellij';
  operationRules: OperationRulesConfig;
  noteTemplates: NoteTemplate[];
  layout: LayoutConfig;
  memos: {
    global: string;
    perProject: Record<string, string>;
  };
  quickCommands: QuickCommand[];
  customThemes: CustomTheme[];
  sshConnections: SSHConnection[];
  recentProjects: RecentProject[];
  browserDockUrls: Record<string, string>;
  telegramOffset: number;
  discordLastMessageIds: Record<string, string>;
  shannon: ShannonConfig;
  gateway: GatewayConfig;
  skills: SkillConfig[];
  mcpServers: McpServerConfig[];
  dbConnections: DatabaseConnection[];
  projectConfigs: Record<string, ProjectConfig>;
  easterEggMedia: EasterEggMedia;
}

// ───────────────────────── Defaults ─────────────────────────

export const DEFAULT_TERMINAL_CONFIG: TerminalConfig = {
  fontSize: 14,
  cursorBlink: false,
  cursorShape: 'bar',
  scrollback: 5000,
  maxTerminalsPerRow: 3,
  inputMode: 'direct',
  autoSaveSession: true,
  autoSaveFiles: true,
  showProjectName: true,
  showTelegramControls: false,
  shellType: 'powershell',
  tmuxAutoStart: false,
  confirmOnClose: true,
  csiUKeys: true,
  jisYenToBackslash: false,
  floatingTermStartDir: '',
};

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  claudeMode: 'bypass-permissions',
  claudeFlags: [],
  claudeModel: '',
  codexMode: 'yolo',
  codexWebSearch: false,
  codexFlags: [],
  codexModel: '',
  cursorMode: 'normal',
  cursorFlags: [],
  cursorModel: '',
  kimiMode: 'yolo',
  kimiFlags: [],
  geminiModel: '',
  geminiFlags: [],
  qwenMode: 'normal',
  qwenModel: '',
  qwenFlags: [],
  reasonixFlags: [],
  bbaritLanguage: 'ko',
  bbaritPersona: '',
  bbaritFlags: [],
  resumeLastSession: false,
  playSoundWhenDone: false,
  playOsNotifySound: true,
  osNotifySoundName: 'Glass',
  useModifierToSend: false,
  alwaysAllowToolActions: false,
  notifyWhenWaiting: 'primary_screen',
  notifyOnTaskComplete: true,
  telegramEnabled: false,
  telegramMirrorCommands: true,
  telegramMirrorOutput: true,
  telegramRemoteControl: false,
  discordEnabled: false,
  discordMirrorCommands: true,
  discordMirrorOutput: true,
  discordRemoteControl: false,
  slackEnabled: false,
  slackMirrorCommands: true,
  slackMirrorOutput: true,
  slackRemoteControl: false,
};

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  fontSize: 13,
  wordWrap: true,
  minimap: true,
  renderWhitespace: 'selection',
  vimMode: false,
  emmet: true,
};

export const DEFAULT_STT_CONFIG: SttConfig = {
  language: 'ko',
  model: LATEST_OPENAI_STT_MODEL,
  micDeviceId: '',
  autoEnter: false,
  prompt: '',
  silenceGate: true,
  hallucinationFilter: true,
  minDurationMs: 300,
  minRms: 0.004,
  disableProcessing: true,
  boost: 2,
  useLocalWhisper: true,
  localWhisperModel: 'ggml-large-v3-turbo.bin',
};

export const DEFAULT_OLLAMA_CONFIG: OllamaConfig = {
  url: 'http://localhost:11434',
  model: '',
};

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  viewMode: 'default',
  terminalHeight: 450,
  sidebarWidth: 220,
};

export const DEFAULT_QUICK_COMMANDS: QuickCommand[] = [
  { id: '1', name: '다시실행해', command: '!!', icon: 'RotateCcw' },
  { id: '2', name: '컴파일해', command: 'npm run build', icon: 'Hammer' },
  { id: '3', name: '해줘', command: '', icon: 'Sparkles' },
];

export const DEFAULT_CONFIG: OctoConfig = {
  version: 2,
  terminal: { ...DEFAULT_TERMINAL_CONFIG },
  agent: { ...DEFAULT_AGENT_CONFIG },
  editor: { ...DEFAULT_EDITOR_CONFIG },
  stt: { ...DEFAULT_STT_CONFIG },
  ollama: { ...DEFAULT_OLLAMA_CONFIG },
  language: 'en',
  keybindingPreset: 'default',
  operationRules: { activeRules: [], customRules: '' },
  noteTemplates: [],
  layout: { ...DEFAULT_LAYOUT_CONFIG },
  memos: { global: '', perProject: {} },
  quickCommands: [...DEFAULT_QUICK_COMMANDS],
  customThemes: [],
  sshConnections: [],
  recentProjects: [],
  browserDockUrls: {},
  telegramOffset: 0,
  discordLastMessageIds: {},
  shannon: {
    installPath: '',
    defaultOutputPath: '',
    pollIntervalMs: 5000,
  },
  gateway: {
    port: 3848,
    host: '127.0.0.1',
    autoStart: false,
  },
  skills: [],
  mcpServers: [],
  dbConnections: [],
  projectConfigs: {},
  easterEggMedia: { type: 'default', path: '' },
};

// ───────────────────────── Validation & Migration ─────────────────────────

/** Deep merge: fills missing fields from defaults */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMergeRecords(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(target)) {
    const val = target[key];
    if (val === undefined || val === null) continue;
    const defVal = defaults[key];
    if (isRecord(val) && isRecord(defVal)) {
      result[key] = deepMergeRecords(val, defVal);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function deepMerge<T extends object>(target: Partial<T>, defaults: T): T {
  const result = { ...defaults } as T;
  for (const key of Object.keys(target) as (keyof T)[]) {
    const val = target[key];
    if (val === undefined || val === null) continue;
    const defVal = defaults[key];
    if (isRecord(val) && isRecord(defVal)) {
      result[key] = deepMergeRecords(val, defVal) as unknown as T[keyof T];
    } else {
      result[key] = val as T[keyof T];
    }
  }
  return result;
}

/** Validate and fill missing fields with defaults */
export function validateConfig(raw: unknown): OctoConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG };
  const input = raw as Partial<OctoConfig>;
  const terminal = deepMerge(input.terminal ?? {}, DEFAULT_TERMINAL_CONFIG);

  // v2: Telegram controls are opt-in. Older configs may have inherited the old
  // visible default, so hide them once during migration.
  if ((input.version ?? 0) < 2) {
    terminal.showTelegramControls = false;
  }

  return {
    version: DEFAULT_CONFIG.version,
    terminal,
    agent: deepMerge(input.agent ?? {}, DEFAULT_AGENT_CONFIG),
    editor: deepMerge(input.editor ?? {}, DEFAULT_EDITOR_CONFIG),
    stt: deepMerge(input.stt ?? {}, DEFAULT_STT_CONFIG),
    ollama: deepMerge(input.ollama ?? {}, DEFAULT_OLLAMA_CONFIG),
    language: input.language ?? DEFAULT_CONFIG.language,
    keybindingPreset: input.keybindingPreset ?? DEFAULT_CONFIG.keybindingPreset,
    operationRules: deepMerge(input.operationRules ?? {}, DEFAULT_CONFIG.operationRules),
    noteTemplates: Array.isArray(input.noteTemplates) ? input.noteTemplates : [],
    layout: deepMerge(input.layout ?? {}, DEFAULT_LAYOUT_CONFIG),
    memos: {
      global: input.memos?.global ?? '',
      perProject: input.memos?.perProject ?? {},
    },
    quickCommands: (Array.isArray(input.quickCommands) && input.quickCommands.length > 0) ? input.quickCommands : [...DEFAULT_QUICK_COMMANDS],
    customThemes: Array.isArray(input.customThemes) ? input.customThemes : [],
    sshConnections: Array.isArray(input.sshConnections) ? input.sshConnections : [],
    recentProjects: Array.isArray(input.recentProjects) ? input.recentProjects : [],
    browserDockUrls: input.browserDockUrls ?? {},
    telegramOffset: input.telegramOffset ?? 0,
    discordLastMessageIds: input.discordLastMessageIds ?? {},
    shannon: deepMerge(input.shannon ?? {}, DEFAULT_CONFIG.shannon),
    gateway: deepMerge(input.gateway ?? {}, DEFAULT_CONFIG.gateway),
    skills: Array.isArray(input.skills) ? input.skills : [],
    mcpServers: Array.isArray(input.mcpServers) ? input.mcpServers : [],
    dbConnections: Array.isArray(input.dbConnections) ? input.dbConnections : [],
    projectConfigs: (input.projectConfigs && typeof input.projectConfigs === 'object') ? input.projectConfigs : {},
    easterEggMedia: input.easterEggMedia && typeof input.easterEggMedia === 'object'
      ? { type: input.easterEggMedia.type || 'default', path: input.easterEggMedia.path || '' }
      : { type: 'default', path: '' },
  };
}

/** Migrate from localStorage to OctoConfig (KV store backed) */
export async function migrateFromLocalStorage(): Promise<OctoConfig> {
  const { kvGet, kvGetMany } = await import('../hooks/useKV');
  const config: Record<string, unknown> = { ...DEFAULT_CONFIG };

  try {
    // Batch-fetch all known keys via kvGetMany
    const knownKeys = [
      'octo-terminal-settings',
      'octo-agent-settings',
      'octo-editor-settings',
      'octo-view-mode',
      'octo-terminal-height',
      'octo-sidebar-width',
      'octo-memo',
      'octo-project-memos',
      'octo-quick-commands',
      'octo-ssh-connections',
      'octo-recent-projects',
      'octo-telegram-offset',
      'octo-stt-language',
      'octo-stt-model',
      'octo-stt-mic-device-id',
      'octo-stt-auto-enter',
      'octo-stt-prompt',
      'octo-stt-silence-gate',
      'octo-stt-hallucination-filter',
      'octo-stt-min-duration-ms',
      'octo-stt-min-rms',
      'octo-stt-disable-processing',
      'octo-stt-boost',
      'octo-stt-use-local-whisper',
      'octo-stt-local-whisper-model',
      'octo-ollama-url',
      'octo-ollama-model',
      'octo-keybinding-preset',
      'octo-operation-rules',
      'octo-note-templates',
    ];
    const kv = await kvGetMany(knownKeys);

    // Terminal settings
    const ts = kv['octo-terminal-settings'];
    if (ts) (config as any).terminal = { ...DEFAULT_TERMINAL_CONFIG, ...JSON.parse(ts) };

    // Agent settings
    const as_ = kv['octo-agent-settings'];
    if (as_) (config as any).agent = { ...DEFAULT_AGENT_CONFIG, ...JSON.parse(as_) };

    // Editor settings
    const es = kv['octo-editor-settings'];
    if (es) (config as any).editor = { ...DEFAULT_EDITOR_CONFIG, ...JSON.parse(es) };

    // Layout
    const vh = kv['octo-view-mode'];
    if (vh === 'terminal') (config as any).layout = { ...(config as any).layout, viewMode: 'terminal' };

    const th = kv['octo-terminal-height'];
    if (th) (config as any).layout = { ...(config as any).layout, terminalHeight: parseInt(th, 10) || 450 };

    const sw = kv['octo-sidebar-width'];
    if (sw) (config as any).layout = { ...(config as any).layout, sidebarWidth: parseInt(sw, 10) || 220 };

    // Memos
    const memoGlobal = kv['octo-memo'] || '';
    let memoPerProject: Record<string, string> = {};
    try { const pm = kv['octo-project-memos']; if (pm) memoPerProject = JSON.parse(pm); } catch { /* skip */ }
    (config as any).memos = { global: memoGlobal, perProject: memoPerProject };

    // Quick commands
    const qc = kv['octo-quick-commands'];
    if (qc) {
      const parsed = JSON.parse(qc);
      if (Array.isArray(parsed) && parsed.length > 0) (config as any).quickCommands = parsed;
    }

    // SSH connections
    const ssh = kv['octo-ssh-connections'];
    if (ssh) (config as any).sshConnections = JSON.parse(ssh);

    // Recent projects
    const rp = kv['octo-recent-projects'];
    if (rp) (config as any).recentProjects = JSON.parse(rp);

    // Telegram offset
    const to = kv['octo-telegram-offset'];
    if (to) (config as any).telegramOffset = parseInt(to, 10) || 0;

    // STT settings
    const sttConfig: Partial<SttConfig> = {};
    const sttLang = kv['octo-stt-language'];
    if (sttLang) sttConfig.language = sttLang.trim();
    const sttModel = kv['octo-stt-model'];
    if (sttModel) sttConfig.model = normalizeOpenAiSttModel(sttModel);
    const sttMic = kv['octo-stt-mic-device-id'];
    if (sttMic) sttConfig.micDeviceId = sttMic.trim();
    const sttAE = kv['octo-stt-auto-enter'];
    if (sttAE) sttConfig.autoEnter = sttAE.trim() === '1' || sttAE.trim().toLowerCase() === 'true';
    const sttPr = kv['octo-stt-prompt'];
    if (sttPr) sttConfig.prompt = sttPr.trim();
    const sttSG = kv['octo-stt-silence-gate'];
    if (sttSG) sttConfig.silenceGate = sttSG.trim() === '1' || sttSG.trim().toLowerCase() === 'true';
    const sttHF = kv['octo-stt-hallucination-filter'];
    if (sttHF) sttConfig.hallucinationFilter = sttHF.trim() === '1' || sttHF.trim().toLowerCase() === 'true';
    const sttMD = kv['octo-stt-min-duration-ms'];
    if (sttMD) { const v = parseInt(sttMD.trim(), 10); if (Number.isFinite(v)) sttConfig.minDurationMs = Math.min(5000, Math.max(0, v)); }
    const sttMR = kv['octo-stt-min-rms'];
    if (sttMR) { const v = parseFloat(sttMR.trim()); if (Number.isFinite(v)) sttConfig.minRms = Math.min(0.2, Math.max(0, v)); }
    const sttDP = kv['octo-stt-disable-processing'];
    if (sttDP) sttConfig.disableProcessing = sttDP.trim() === '1' || sttDP.trim().toLowerCase() === 'true';
    const sttB = kv['octo-stt-boost'];
    if (sttB) { const v = parseFloat(sttB.trim()); if (Number.isFinite(v)) sttConfig.boost = Math.min(8, Math.max(1, v)); }
    sttConfig.useLocalWhisper = true;
    const sttLWM = kv['octo-stt-local-whisper-model'];
    if (sttLWM) sttConfig.localWhisperModel = sttLWM.trim();
    if (Object.keys(sttConfig).length > 0) {
      (config as any).stt = { ...DEFAULT_STT_CONFIG, ...sttConfig };
    }

    // Ollama settings
    const ollamaUrl = kv['octo-ollama-url'];
    const ollamaModel = kv['octo-ollama-model'];
    if (ollamaUrl || ollamaModel) {
      (config as any).ollama = {
        url: ollamaUrl?.trim() || DEFAULT_OLLAMA_CONFIG.url,
        model: ollamaModel?.trim() || DEFAULT_OLLAMA_CONFIG.model,
      };
    }

    // Keybinding preset
    const kbPreset = kv['octo-keybinding-preset'];
    if (kbPreset === 'vscode' || kbPreset === 'intellij') {
      (config as any).keybindingPreset = kbPreset;
    }

    // Operation rules
    const opRules = kv['octo-operation-rules'];
    if (opRules) {
      try {
        const parsed = JSON.parse(opRules);
        (config as any).operationRules = {
          activeRules: parsed.activeRules || [],
          customRules: parsed.customRules || '',
        };
      } catch { /* skip */ }
    }

    // Note templates
    const noteT = kv['octo-note-templates'];
    if (noteT) {
      try { (config as any).noteTemplates = JSON.parse(noteT); } catch { /* skip */ }
    }

    // Browser dock URLs (dynamic keys — discover from localStorage, fetch via kvGet)
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('octo-pi-browser-config:')) {
        const clientName = key.replace('octo-pi-browser-config:', '');
        try {
          const raw = await kvGet(key);
          const val = JSON.parse(raw || '{}');
          if (val.url) (config as any).browserDockUrls[clientName] = val.url;
        } catch { /* skip */ }
      }
    }
  } catch {
    // Migration failure → use defaults
  }

  return validateConfig(config);
}
