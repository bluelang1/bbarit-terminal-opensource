import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { isPermissionGranted as notifIsPermissionGranted, requestPermission as notifRequestPermission, sendNotification as notifSend } from '@tauri-apps/plugin-notification';

// macOS system notification sounds (Windows uses its default toast sound).
const MAC_NOTIFY_SOUNDS = ['Glass', 'Ping', 'Pop', 'Hero', 'Submarine', 'Tink', 'Funk', 'Bottle', 'Frog', 'Sosumi', 'Blow', 'Basso', 'Morse', 'Purr'];
import { FONTS, STYLES, DARK_STYLES, LIGHT_STYLES, WACKY_STYLES, CUSTOM_FONT_INDEX, getEffectiveFont } from '../theme';
import { OctoGear, OctoNote, OctoPlane, OctoShell, OctoSpark, OctoAntler } from '../octoIcons';
import { FolderOpen, HardDrive, Upload, Download as DownloadIcon, RefreshCw } from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { IconPicker } from './IconPicker';
import { getAiTagProvider, setAiTagProvider, AI_TAG_PROVIDERS, type AiTagProvider } from '../notes/ollamaTagging';
import {
  clearLinearToken,
  fetchLinearTeams,
  getLinearSettings,
  isLinearConfigured,
  saveLinearSettings,
  type LinearTeam,
} from '../integrations/linear';
import { useConfig, getConfigSnapshot } from '../config/ConfigContext';
import { useTranslation } from '../i18n';
import type { TranslationKey } from '../i18n/en';
import { LATEST_OPENAI_STT_MODEL } from '../config/schema';
import type { AgentConfig, TerminalConfig, EditorConfig, NoteTemplate, SttConfig } from '../config/schema';
import { getModelsForCliType } from '../config/modelPresets';
import { kvGet, kvSet, kvDelete } from '../hooks/useKV';
import { ATLASCLOUD_DEFAULT_BASE_URL, ATLASCLOUD_DEFAULT_MODEL, ATLASCLOUD_KV_KEYS, normalizeAtlasCloudModelPreference } from '../harness/atlasCloudRuntime';
import { brokerSettingsText } from '../devreview/brokerSettingsText';
import { BROKER_AGENT_ROLES, ROLE_LABEL, normalizeBrokerAgentRole, type BrokerReviewMode, type DevReviewRole } from '../devreview/devReviewPair';
import { normalizeBbaritAgentLanguage, type BbaritAgentLanguage } from '../terminal/bbaritAgentLanguage';
import { buildBbaritPersonaProfile, personaIconUrl, type BbaritPersonaEntry } from '../terminal/bbaritAgentPersonaProfile';
import { BbaritPersonaPickerModal } from './BbaritPersonaPickerModal';
import { qrToDataUri } from '../utils/qrCode';
import { GATEWAY_UI_COMMAND_DOCS } from '../gatewayUiCommands';
import BBARIT_CLI_DOC from '../../docs/BBARIT_CLI.md?raw';
import BBARIT_CTL_SOURCE from '../../scripts/bbarit-ctl.mjs?raw';
import { DEFAULT_DASHBOARD_URL, loadDashboardUrl, normalizeDashboardUrl, saveDashboardUrl } from '../dashboard/dashboardUrl';
import './SettingsPanel.css';

// Control CLI 탭에서 버스 명령 → 복사용 CLI 예시 매핑 (bbarit-ctl 서브커맨드).
const CLI_EXAMPLES: Record<string, string> = {
  'status': 'status',
  'commands.list': 'commands',
  'project.list': 'project list',
  'project.create': 'project create ~/path "Name"',
  'project.switch': 'project switch <projectId>',
  'view.set': 'view side',
  'terminal.layout.set': 'layout vertical',
  'sidebar.set': 'sidebar off',
  'terminal.list': 'term list',
  'terminal.create': 'term create shell',
  'terminal.write': 'term write "git status"',
  'terminal.read': 'term read 80',
  'terminal.activate': 'term use <terminalId>',
  'terminal.close': 'term close <terminalId>',
  'editor.open': 'open ./README.md',
  'editor.list': 'files',
  'editor.close': 'close README.md',
  'kanban.list': 'kanban list todo',
  'kanban.add': 'kanban add "Ship v1.0" --col inprogress --pri high',
  'kanban.move': 'kanban move <taskId> done',
  'kanban.update': 'kanban update <taskId> --pri urgent',
  'kanban.delete': 'kanban delete <taskId>',
  'schedule.list': 'sched list',
  'schedule.add': 'sched add "매일 9시에 npm run build"',
  'schedule.delete': 'sched rm <jobId>',
  'schedule.toggle': 'sched off <jobId>',
  'schedule.run': 'sched run <jobId>',
  'schedule.panel': 'sched panel',
  'panel.open': 'panel settings',
  'image.generate': 'image "neon-style cat logo"',
  'design.open': 'design "landing page concept"',
  'cowork.open': 'cowork --dir ~/docs "summarize this folder"',
  'config.get': 'config get agent.bbaritPersona',
  'config.patch': 'config set terminal.fontSize 14',
  'persona.list': 'persona list architect',
  'persona.set': 'persona set code-reviewer',
  'clipboard.copy': 'copy "text to copy"',
  'notify': 'notify "Build finished" --title "CI"',
};

// Re-export config types as aliases for backward compatibility
export type AgentSettings = AgentConfig;
export type TerminalSettings = TerminalConfig;
export type EditorSettings = EditorConfig;
export type { NoteTemplate } from '../config/schema';

const BROKER_AGENT_OPTIONS = BROKER_AGENT_ROLES.map((id) => [id, ROLE_LABEL[id]] as const);

export interface ProjectInfo {
  id: string;
  displayName: string;
  workDir: string;
  icon: string;
  styleIndex: number;
  fontIndex: number;
  customFontFamily?: string;
  linearTeamId?: string;
  linearProjectId?: string;
  telegramChatId?: string;
  discordChannelId?: string;
  slackChannelId?: string;
  githubRepo?: string;
}

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  currentStyle: { bg: string; text: string; accent: string };
  currentStyleIndex?: number;
  onStyleChange?: (styleIndex: number) => void;
  currentFontIndex?: number;
  customFontFamily?: string;
  onFontChange?: (fontIndex: number) => void;
  onCustomFontChange?: (value: string) => void;
  onTerminalSettingsChange?: (settings: TerminalSettings) => void;
  onEditorSettingsChange?: (settings: EditorSettings) => void;
  keybindingPreset?: 'default' | 'vscode' | 'intellij';
  onKeybindingPresetChange?: (preset: 'default' | 'vscode' | 'intellij') => void;
  projects?: ProjectInfo[];
  activeProjectId?: string | null;
  onProjectUpdate?: (projectId: string, updates: Partial<Pick<ProjectInfo, 'displayName' | 'styleIndex' | 'fontIndex' | 'customFontFamily' | 'linearTeamId' | 'linearProjectId' | 'telegramChatId' | 'discordChannelId' | 'slackChannelId' | 'githubRepo'>>) => void;
  onProjectReorder?: (fromIndex: number, toIndex: number) => void;
  onAgentSettingsChange?: (settings: AgentSettings) => void;
  onTelegramBotTokenChange?: (token: string) => void;
  onDiscordBotTokenChange?: (token: string) => void;
  onSlackBotTokenChange?: (token: string) => void;
  onOpenFile?: (path: string) => void;
}

// Secrets stored in KV store (not safe for plaintext config.json)
const STORAGE_KEY_TELEGRAM_BOT_TOKEN = 'octo-telegram-bot-token';
const STORAGE_KEY_TELEGRAM_STATS = 'octo-telegram-stats';
const STORAGE_KEY_TELEGRAM_CHAT_LABELS = 'octo-telegram-chat-labels';
const STORAGE_KEY_DISCORD_BOT_TOKEN = 'octo-discord-bot-token';
const STORAGE_KEY_SLACK_BOT_TOKEN = 'octo-slack-bot-token';
const STORAGE_KEY_STT_OPENAI_API_KEY = 'octo-stt-openai-api-key';
const STORAGE_KEY_STT_LANGUAGE = 'octo-stt-language';
const STORAGE_KEY_STT_MODEL = 'octo-stt-model';
const STORAGE_KEY_STT_MIC_DEVICE_ID = 'octo-stt-mic-device-id';
const STORAGE_KEY_STT_AUTO_ENTER = 'octo-stt-auto-enter';
const STORAGE_KEY_STT_PROMPT = 'octo-stt-prompt';
const STORAGE_KEY_STT_SILENCE_GATE = 'octo-stt-silence-gate';
const STORAGE_KEY_STT_HALLUCINATION_FILTER = 'octo-stt-hallucination-filter';
const STORAGE_KEY_STT_MIN_DURATION_MS = 'octo-stt-min-duration-ms';
const STORAGE_KEY_STT_MIN_RMS = 'octo-stt-min-rms';
const STORAGE_KEY_STT_DISABLE_PROCESSING = 'octo-stt-disable-processing';
const STORAGE_KEY_STT_BOOST = 'octo-stt-boost';
const STORAGE_KEY_STT_USE_LOCAL_WHISPER = 'octo-stt-use-local-whisper';
const STORAGE_KEY_STT_LOCAL_WHISPER_MODEL = 'octo-stt-local-whisper-model';
const STORAGE_KEY_BROKER_LANGUAGE = 'octo-broker-language';
const STORAGE_KEY_BROKER_REVIEW_MODE = 'octo-broker-review-mode';
const STORAGE_KEY_BROKER_BROWSER_REVIEW = 'octo-broker-browser-review';
export const STORAGE_KEY_GEMINI_API_KEY = 'octo-gemini-api-key';

// Local Whisper voice input is macOS-only (see src-tauri/Cargo.toml). On Windows
// the whole Speech-to-Text settings group is hidden.
const IS_WINDOWS = (() => {
  try { return navigator.platform.toLowerCase().includes('win'); } catch { return false; }
})();

// Telegram types
interface TelegramIncoming {
  update_id: number;
  chat_id: number;
  text: string;
  chat_title?: string;
  chat_username?: string;
  chat_type?: string;
}

interface TelegramStats {
  sent: number;
  received: number;
  lastMessageAt: string | null;
}

interface TelegramChatInfo {
  chatId: string;
  title: string;
  type: string;
  username?: string;
  label?: string;
  linkedProjectId?: string;
}

type TelegramWizardStep = 1 | 2 | 3 | 4;

const loadTelegramStats = async (): Promise<TelegramStats> => {
  try {
    const raw = await kvGet(STORAGE_KEY_TELEGRAM_STATS);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { sent: 0, received: 0, lastMessageAt: null };
};

const saveTelegramStats = (stats: TelegramStats) => {
  void kvSet(STORAGE_KEY_TELEGRAM_STATS, JSON.stringify(stats));
};

const loadChatLabels = async (): Promise<Record<string, string>> => {
  try {
    const raw = await kvGet(STORAGE_KEY_TELEGRAM_CHAT_LABELS);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
};

const saveChatLabels = (labels: Record<string, string>) => {
  void kvSet(STORAGE_KEY_TELEGRAM_CHAT_LABELS, JSON.stringify(labels));
};



// Mode flags managed by dropdowns – hidden from the textarea
const CLAUDE_MODE_FLAGS = new Set(['--dangerously-skip-permissions']);
const CODEX_MODE_FLAGS = new Set(['--full-auto', '--yolo', '--dangerously-bypass-approvals-and-sandbox']);
const CURSOR_MODE_FLAGS = new Set(['--force', '-f']);
const KIMI_MODE_FLAGS = new Set(['--yolo']);

const withoutModeFlags = (flags: string[], modeFlags: Set<string>): string[] =>
  flags.filter(f => !modeFlags.has(f));

const normalizeFlagLines = (flags: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of flags) {
    const line = raw.trim();
    // Options textarea is for CLI flags only.
    if (!line.startsWith('-')) continue;
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
};

const parseFlagLines = (value: string): string[] => normalizeFlagLines(value.split('\n'));

const formatFlagLines = (flags: string[] | undefined): string => (flags || []).join('\n');


const deriveClaudeModeFromFlags = (flags: string[], prevMode: AgentSettings['claudeMode']): AgentSettings['claudeMode'] => {
  if (flags.includes('--dangerously-skip-permissions')) return 'bypass-permissions';
  // When no mode flags found, preserve the saved mode (flags are stored separately from mode)
  return prevMode;
};

const deriveCodexModeFromFlags = (flags: string[], prevMode: AgentSettings['codexMode']): AgentSettings['codexMode'] => {
  if (flags.includes('--yolo') || flags.includes('--dangerously-bypass-approvals-and-sandbox')) return 'yolo';
  if (flags.includes('--full-auto')) return 'full-auto';
  if (flags.includes('--auto-edit')) return 'auto-edit';
  // When no mode flags found, preserve the saved mode (flags are stored separately from mode)
  return prevMode;
};

const deriveCursorModeFromFlags = (flags: string[], prevMode: AgentSettings['cursorMode']): AgentSettings['cursorMode'] =>
  flags.includes('--force') || flags.includes('-f') ? 'force' : prevMode;

const deriveKimiModeFromFlags = (flags: string[], prevMode: AgentSettings['kimiMode']): AgentSettings['kimiMode'] =>
  flags.includes('--yolo') ? 'yolo' : prevMode;

const deriveQwenModeFromFlags = (flags: string[], prevMode: AgentSettings['qwenMode']): AgentSettings['qwenMode'] =>
  (flags.includes('--yolo') || flags.includes('-y') || flags.includes('--approval-mode=yolo') || flags.includes('--approval-mode')) ? 'yolo' : prevMode;

const clampTerminalFontSize = (n: number) => {
  const v = Number.isFinite(n) ? n : 14;
  return Math.min(20, Math.max(8, Math.floor(v)));
};

const clampEditorFontSize = (n: number) => {
  const v = Number.isFinite(n) ? n : 13;
  return Math.min(24, Math.max(10, Math.floor(v)));
};

const openExternalUrl = async (url: string) => {
  const u = String(url || '').trim();
  if (!u) return;
  try {
    await invoke('plugin:shell|open', { path: u });
    return;
  } catch {
    // fall back below
  }
  try {
    window.open(u, '_blank', 'noopener,noreferrer');
  } catch {
    // ignore
  }
};

const openFolderPath = async (path: string) => {
  const p = String(path || '').trim();
  if (!p) return;
  try {
    // Use tauri-plugin-opener to reveal folder in system file manager
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(p);
  } catch {
    try {
      await invoke('plugin:opener|open_path', { path: p });
    } catch {
      try {
        await invoke('plugin:shell|open', { path: p });
      } catch {
        // ignore
      }
    }
  }
};




export function SettingsPanel({
  isOpen,
  onClose,
  currentStyle,
  currentStyleIndex = 0,
  onStyleChange,
  currentFontIndex = 0,
  customFontFamily: customFontFamilyProp = '',
  onFontChange,
  onCustomFontChange,
  onTerminalSettingsChange,
  onEditorSettingsChange,
  keybindingPreset: keybindingPresetProp,
  onKeybindingPresetChange,
  onAgentSettingsChange,
  onTelegramBotTokenChange,
  onDiscordBotTokenChange,
  onSlackBotTokenChange,
  projects,
  activeProjectId,
  onProjectUpdate,
  onProjectReorder,
}: SettingsPanelProps) {
  const { config, updateConfig } = useConfig();
  const { t } = useTranslation();

  // Skip config writes on initial mount to prevent unnecessary re-renders that steal terminal focus.


  // settingsCategory removed — all tabs merged into one bar
  const [activeTab, setActiveTab] = useState<'terminal' | 'editor' | 'theme' | 'language' | 'projects' | 'agent' | 'telegram' | 'keys' | 'shortcuts' | 'notes' | 'web-terminal' | 'integrations' | 'data' | 'licenses' | 'broker' | 'channels' | 'cli'>('terminal');
  const [themeSubTab, setThemeSubTab] = useState<'dark' | 'light' | 'wacky'>('dark');
  const [aiTagProvider, setAiTagProviderState] = useState<AiTagProvider>('ollama');
  useEffect(() => { getAiTagProvider().then(p => setAiTagProviderState(p)).catch(() => {}); }, []);
  const [deepseekKey, setDeepseekKey] = useState('');
  const [deepseekSaved, setDeepseekSaved] = useState(false);
  useEffect(() => { kvGet('octo-deepseek-api-key').then((v) => setDeepseekKey((v || '').trim())).catch(() => {}); }, []);
  const [noteTemplates, setNoteTemplates] = useState<NoteTemplate[]>(() => config.noteTemplates);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [templateContent, setTemplateContent] = useState('');
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [qcIconPickerIndex, setQcIconPickerIndex] = useState<number | null>(null);

  // System fonts for Custom font picker
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [fontSearchQuery, setFontSearchQuery] = useState('');
  useEffect(() => {
    if (!isOpen) return;
    invoke<string[]>('list_system_fonts').then(setSystemFonts).catch(() => {});
  }, [isOpen]);

  // App version
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => { if (isOpen) getVersion().then(setAppVersion).catch(() => {}); }, [isOpen]);

  // BBARIT Browser runtime
  // Data Sync state
  const [syncPath, setSyncPath] = useState('');
  const [syncStatus, setSyncStatus] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);
  useEffect(() => { kvGet('octo-sync-path').then(v => { if (v) setSyncPath(v); }); }, []);
  const saveSyncPath = useCallback((p: string) => { setSyncPath(p); void kvSet('octo-sync-path', p); }, []);

  const SYNC_FILES = [
    { label: 'Config', rel: '.config/octo/config.json' },
    { label: 'Database', rel: '.config/octo/orchestra.db' },
    { label: 'Env', rel: '.config/octo/.env' },
  ];

  const doExport = useCallback(async () => {
    if (!syncPath.trim()) return;
    setSyncBusy(true);
    setSyncStatus('');
    try {
      const home = await invoke<string>('get_home_dir');
      await invoke('create_directory', { path: syncPath.trim() }).catch(() => {});
      const results: string[] = [];
      const failed: string[] = [];
      for (const f of SYNC_FILES) {
        const src = `${home}/${f.rel}`;
        const dest = `${syncPath.trim()}/${f.rel.split('/').pop()}`;
        try {
          await invoke('delete_path', { path: dest }).catch(() => {});
          await invoke('copy_path', { from: src, to: dest });
          results.push(f.label);
        } catch { failed.push(f.label); }
      }
      const msg = results.length > 0 ? `${t('settings.data.exportOk')}: ${results.join(', ')}` : t('settings.data.exportNothing');
      setSyncStatus(failed.length > 0 ? `${msg} | ${t('settings.data.failedList')}: ${failed.join(', ')}` : msg);
    } catch (e) {
      setSyncStatus(`${t('settings.data.exportFailed')}: ${e}`);
    }
    setSyncBusy(false);
  }, [syncPath]);

  const doImport = useCallback(async () => {
    if (!syncPath.trim()) return;
    setSyncBusy(true);
    setSyncStatus('');
    try {
      const home = await invoke<string>('get_home_dir');
      const results: string[] = [];
      const failed: string[] = [];
      for (const f of SYNC_FILES) {
        const src = `${syncPath.trim()}/${f.rel.split('/').pop()}`;
        const dest = `${home}/${f.rel}`;
        try {
          await invoke('delete_path', { path: dest }).catch(() => {});
          await invoke('copy_path', { from: src, to: dest });
          results.push(f.label);
        } catch { failed.push(f.label); }
      }
      const msg = results.length > 0 ? `${t('settings.data.importOk')}: ${results.join(', ')}` : t('settings.data.importNothing');
      setSyncStatus(failed.length > 0 ? `${msg} | ${t('settings.data.notFoundList')}: ${failed.join(', ')} — ${t('settings.data.restartToApply')}` : `${msg} — ${t('settings.data.restartToApply')}`);
    } catch (e) {
      setSyncStatus(`${t('settings.data.importFailed')}: ${e}`);
    }
    setSyncBusy(false);
  }, [syncPath]);

  const isTauri = useMemo(() => {
    const w = window as unknown as Record<string, unknown>;
    return ('__TAURI__' in w) || ('__TAURI_INTERNALS__' in w);
  }, []);

  const isMacPlatform = useMemo(() => {
    try {
      return navigator.platform.toUpperCase().includes('MAC');
    } catch {
      return false;
    }
  }, []);

  const [terminalSettings, setTerminalSettings] = useState<TerminalSettings>(() => {
    return { ...config.terminal, fontSize: clampTerminalFontSize(config.terminal.fontSize) };
  });

  const [editorSettings, setEditorSettings] = useState<EditorSettings>(() => {
    return { ...config.editor, fontSize: clampEditorFontSize(config.editor.fontSize) };
  });

  const [agentSettings, setAgentSettings] = useState<AgentSettings>(() => {
    const a = { ...config.agent };
    // Derive mode from flags first, then strip mode flags from flags arrays
    // This ensures the dropdown shows the correct mode based on actual flags
    a.claudeMode = deriveClaudeModeFromFlags(a.claudeFlags || [], a.claudeMode);
    a.codexMode = deriveCodexModeFromFlags(a.codexFlags || [], a.codexMode);
    a.cursorMode = deriveCursorModeFromFlags(a.cursorFlags || [], a.cursorMode || 'normal');
    a.kimiMode = deriveKimiModeFromFlags(a.kimiFlags || [], a.kimiMode);
    a.qwenMode = deriveQwenModeFromFlags(a.qwenFlags || [], a.qwenMode || 'normal');
      // Strip mode flags from flags arrays (now managed by dropdowns)
    a.claudeFlags = normalizeFlagLines(withoutModeFlags(a.claudeFlags || [], CLAUDE_MODE_FLAGS));
    a.codexFlags = normalizeFlagLines(withoutModeFlags(a.codexFlags || [], CODEX_MODE_FLAGS));
    a.cursorFlags = normalizeFlagLines(withoutModeFlags(a.cursorFlags || [], CURSOR_MODE_FLAGS));
    a.kimiFlags = normalizeFlagLines(withoutModeFlags(a.kimiFlags || [], KIMI_MODE_FLAGS));
    a.qwenFlags = normalizeFlagLines((a.qwenFlags || []).filter(flag => !flag.startsWith('--approval-mode') && flag !== '--yolo' && flag !== '-y'));
    a.reasonixFlags = normalizeFlagLines(a.reasonixFlags || []);
    a.bbaritLanguage = normalizeBbaritAgentLanguage(a.bbaritLanguage);
    a.bbaritPersona = a.bbaritPersona || '';
    a.bbaritFlags = normalizeFlagLines(a.bbaritFlags || []);
    return a;
  });
  const [claudeFlagsInput, setClaudeFlagsInput] = useState<string>(() =>
    formatFlagLines(normalizeFlagLines(withoutModeFlags(config.agent.claudeFlags || [], CLAUDE_MODE_FLAGS)))
  );
  const [codexFlagsInput, setCodexFlagsInput] = useState<string>(() =>
    formatFlagLines(normalizeFlagLines(withoutModeFlags(config.agent.codexFlags || [], CODEX_MODE_FLAGS)))
  );
  const [cursorFlagsInput, setCursorFlagsInput] = useState<string>(() =>
    formatFlagLines(normalizeFlagLines(withoutModeFlags(config.agent.cursorFlags || [], CURSOR_MODE_FLAGS)))
  );
  const [kimiFlagsInput, setKimiFlagsInput] = useState<string>(() =>
    formatFlagLines(normalizeFlagLines(withoutModeFlags(config.agent.kimiFlags || [], KIMI_MODE_FLAGS)))
  );
  const [geminiFlagsInput, setGeminiFlagsInput] = useState<string>(() =>
    formatFlagLines(normalizeFlagLines(config.agent.geminiFlags || []))
  );
  const [qwenFlagsInput, setQwenFlagsInput] = useState<string>(() =>
    formatFlagLines(normalizeFlagLines((config.agent.qwenFlags || []).filter(flag => !flag.startsWith('--approval-mode') && flag !== '--yolo' && flag !== '-y')))
  );
  const [reasonixFlagsInput, setReasonixFlagsInput] = useState<string>(() =>
    formatFlagLines(normalizeFlagLines(config.agent.reasonixFlags || []))
  );
  const [bbaritFlagsInput, setBbaritFlagsInput] = useState<string>(() =>
    formatFlagLines(normalizeFlagLines(config.agent.bbaritFlags || []))
  );
  const [bbaritPersonas, setBbaritPersonas] = useState<BbaritPersonaEntry[]>([]);
  const [bbaritPersonaPickerOpen, setBbaritPersonaPickerOpen] = useState(false);
  // Control CLI 탭 — 복사 피드백 + 문서 저장 경로.
  const [cliCopied, setCliCopied] = useState('');
  const [cliDocSavedPath, setCliDocSavedPath] = useState('');
  useEffect(() => {
    if (!cliCopied) return;
    const timer = setTimeout(() => setCliCopied(''), 1500);
    return () => clearTimeout(timer);
  }, [cliCopied]);
  const downloadCliDocs = useCallback(async () => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const dest = await save({ defaultPath: 'BBARIT_CLI.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (!dest) return;
      await invoke('write_file', { path: dest, content: BBARIT_CLI_DOC });
      setCliDocSavedPath(dest);
    } catch (e) {
      setCliDocSavedPath(`save failed: ${String(e)}`);
    }
  }, []);
  // 설치본 사용자가 저장소 없이 쓰도록 CLI 스크립트 자체를 저장해 준다.
  const downloadCliScript = useCallback(async () => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const dest = await save({ defaultPath: 'bbarit-ctl.mjs', filters: [{ name: 'JavaScript module', extensions: ['mjs'] }] });
      if (!dest) return;
      await invoke('write_file', { path: dest, content: BBARIT_CTL_SOURCE });
      setCliDocSavedPath(dest);
    } catch (e) {
      setCliDocSavedPath(`save failed: ${String(e)}`);
    }
  }, []);

  // Sync settings from config whenever the panel opens (component stays mounted,
  // so useState initializers only run once — this effect re-syncs on each open).
  useEffect(() => {
    if (!isOpen) return;
    const a = { ...config.agent };
    a.claudeMode = deriveClaudeModeFromFlags(a.claudeFlags || [], a.claudeMode);
    a.codexMode = deriveCodexModeFromFlags(a.codexFlags || [], a.codexMode);
    a.cursorMode = deriveCursorModeFromFlags(a.cursorFlags || [], a.cursorMode || 'normal');
    a.kimiMode = deriveKimiModeFromFlags(a.kimiFlags || [], a.kimiMode);
    a.qwenMode = deriveQwenModeFromFlags(a.qwenFlags || [], a.qwenMode || 'normal');
    a.claudeFlags = normalizeFlagLines(withoutModeFlags(a.claudeFlags || [], CLAUDE_MODE_FLAGS));
    a.codexFlags = normalizeFlagLines(withoutModeFlags(a.codexFlags || [], CODEX_MODE_FLAGS));
    a.cursorFlags = normalizeFlagLines(withoutModeFlags(a.cursorFlags || [], CURSOR_MODE_FLAGS));
    a.kimiFlags = normalizeFlagLines(withoutModeFlags(a.kimiFlags || [], KIMI_MODE_FLAGS));
    a.geminiFlags = normalizeFlagLines(a.geminiFlags || []);
    a.qwenFlags = normalizeFlagLines((a.qwenFlags || []).filter(flag => !flag.startsWith('--approval-mode') && flag !== '--yolo' && flag !== '-y'));
    a.reasonixFlags = normalizeFlagLines(a.reasonixFlags || []);
    a.bbaritLanguage = normalizeBbaritAgentLanguage(a.bbaritLanguage);
    a.bbaritPersona = a.bbaritPersona || '';
    a.bbaritFlags = normalizeFlagLines(a.bbaritFlags || []);
    setAgentSettings(a);
    setClaudeFlagsInput(formatFlagLines(a.claudeFlags));
    setCodexFlagsInput(formatFlagLines(a.codexFlags));
    setCursorFlagsInput(formatFlagLines(a.cursorFlags));
    setKimiFlagsInput(formatFlagLines(a.kimiFlags));
    setGeminiFlagsInput(formatFlagLines(a.geminiFlags));
    setQwenFlagsInput(formatFlagLines(a.qwenFlags));
    setReasonixFlagsInput(formatFlagLines(a.reasonixFlags));
    setBbaritFlagsInput(formatFlagLines(a.bbaritFlags));
    _setSttLanguage(config.stt.language || 'ko');
    _setSttMicDeviceId(config.stt.micDeviceId || '');
    _setSttAutoEnter(!!config.stt.autoEnter);
    _setSttPrompt(config.stt.prompt || '');
    _setSttSilenceGate(config.stt.silenceGate !== false);
    _setSttHallucinationFilter(config.stt.hallucinationFilter !== false);
    _setSttMinDurationMs(config.stt.minDurationMs ?? 300);
    _setSttMinRms(config.stt.minRms ?? 0.004);
    _setSttDisableProcessing(config.stt.disableProcessing !== false);
    _setSttBoost(config.stt.boost ?? 1);
    _setSttUseLocalWhisper(true);
    _setSttLocalWhisperModel(config.stt.localWhisperModel || 'ggml-large-v3-turbo.bin');
    // Initialize token configured states from KV store
    void (async () => {
      try { setTelegramTokenConfigured(!!((await kvGet(STORAGE_KEY_TELEGRAM_BOT_TOKEN)) || '').trim()); } catch { /* ignore */ }
      try { setDiscordTokenConfigured(!!((await kvGet(STORAGE_KEY_DISCORD_BOT_TOKEN)) || '').trim()); } catch { /* ignore */ }
      try { setSlackTokenConfigured(!!((await kvGet(STORAGE_KEY_SLACK_BOT_TOKEN)) || '').trim()); } catch { /* ignore */ }
      try { setTgStats(await loadTelegramStats()); } catch { /* ignore */ }
      try { setTgChatLabels(await loadChatLabels()); } catch { /* ignore */ }
      try { setBbaritPersonas(await invoke<BbaritPersonaEntry[]>('agent_personas_list')); } catch { /* ignore */ }
      try {
        const raw = await kvGet('octo-broker-developer');
        const role = normalizeBrokerAgentRole(raw, 'claude');
        setBrokerDeveloper(role);
        if (raw && raw !== role) void kvSet('octo-broker-developer', role);
      } catch { /* ignore */ }
      try {
        const raw = await kvGet('octo-broker-reviewer');
        const role = normalizeBrokerAgentRole(raw, 'codex');
        setBrokerReviewer(role);
        if (raw && raw !== role) void kvSet('octo-broker-reviewer', role);
      } catch { /* ignore */ }
      try {
        const lang = (localStorage.getItem(STORAGE_KEY_BROKER_LANGUAGE) || (await kvGet(STORAGE_KEY_BROKER_LANGUAGE)) || '').trim();
        setBrokerLanguage(lang === 'ko' || lang === 'en' ? lang : ((config.language || 'en') === 'ko' ? 'ko' : 'en'));
      } catch { /* ignore */ }
      try {
        const mode = (localStorage.getItem(STORAGE_KEY_BROKER_REVIEW_MODE) || (await kvGet(STORAGE_KEY_BROKER_REVIEW_MODE)) || '').trim();
        setBrokerReviewMode(
          mode === 'off' || mode === 'light' || mode === 'normal' || mode === 'careful' || mode === 'very_careful'
            ? mode
            : 'careful',
        );
      } catch { /* ignore */ }
      try {
        const browserReview = (localStorage.getItem(STORAGE_KEY_BROKER_BROWSER_REVIEW) || (await kvGet(STORAGE_KEY_BROKER_BROWSER_REVIEW)) || '').trim().toLowerCase();
        setBrokerBrowserReview(!(browserReview === '0' || browserReview === 'false' || browserReview === 'off' || browserReview === 'no'));
      } catch { /* ignore */ }
      try {
        const wi = await invoke<{ token: string; port: number; url: string }>('get_web_terminal_info');
        setWebTermInfo(wi);
        const resp = await invoke<{ status: number; body: string }>('http_request', { input: { method: 'GET', url: `http://127.0.0.1:${wi.port}/api/ngrok/status?token=${encodeURIComponent(wi.token)}`, headers: {}, body: null, timeout_ms: 8000 } });
        const data = JSON.parse(resp.body || '{}');
        if (data?.data?.active && data?.data?.url) setTunnelUrl(data.data.url);
      } catch { /* web terminal optional */ }
      try {
        const gw = await invoke<{ port: number; wsToken: string; localUrl: string }>('gateway_info');
        setGatewayInfo(gw);
      } catch { /* gateway optional */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const startWebTunnel = async () => {
    if (!webTermInfo) return;
    setTunnelBusy(true); setTunnelMsg(t('settings.web.startingCloudflareTunnel' as any, 'Starting Cloudflare tunnel... (falls back to ngrok if cloudflared is unavailable)'));
    try {
      const resp = await invoke<{ status: number; body: string }>('http_request', { input: { method: 'POST', url: `http://127.0.0.1:${webTermInfo.port}/api/ngrok/start?token=${encodeURIComponent(webTermInfo.token)}`, headers: {}, body: null, timeout_ms: 70000 } });
      const data = JSON.parse(resp.body || '{}');
      const url = data?.data?.url || data?.url;
      if (url) { setTunnelUrl(url); setTunnelMsg(t('settings.web.publicUrlCreated' as any, 'Connected - public URL created')); }
      else { setTunnelMsg(data?.error || t('settings.web.noUrlInstallHint' as any, 'Could not get a URL. Check cloudflared installation: brew install cloudflared / winget install cloudflare.cloudflared')); }
    } catch (e) { setTunnelMsg(e instanceof Error ? e.message : String(e)); }
    finally { setTunnelBusy(false); }
  };
  const stopWebTunnel = async () => {
    if (!webTermInfo) return;
    setTunnelBusy(true);
    try {
      await invoke('http_request', { input: { method: 'POST', url: `http://127.0.0.1:${webTermInfo.port}/api/ngrok/stop?token=${encodeURIComponent(webTermInfo.token)}`, headers: {}, body: null, timeout_ms: 20000 } });
      setTunnelUrl(null); setTunnelMsg(t('settings.web.tunnelStopped' as any, 'Tunnel stopped'));
    } catch (e) { setTunnelMsg(e instanceof Error ? e.message : String(e)); }
    finally { setTunnelBusy(false); }
  };
  const copyToClipboard = (text: string) => { try { void navigator.clipboard.writeText(text); setTunnelMsg(t('settings.web.copied' as any)); } catch { /* ignore */ } };

  // Operation rules (custom only)
  const [customOperationRules, setCustomOperationRules] = useState<string>(() => config.operationRules.customRules);

  // Broker Agent: which terminal CLI plays developer / reviewer.
  const [brokerLanguage, setBrokerLanguage] = useState<'en' | 'ko'>(() => ((config.language || 'en') === 'ko' ? 'ko' : 'en'));
  const [brokerDeveloper, setBrokerDeveloper] = useState<DevReviewRole>('claude');
  const [brokerReviewer, setBrokerReviewer] = useState<DevReviewRole>('codex');
  const [brokerReviewMode, setBrokerReviewMode] = useState<BrokerReviewMode>('careful');
  const [brokerBrowserReview, setBrokerBrowserReview] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_KEY_BROKER_BROWSER_REVIEW) !== '0'; } catch { return true; }
  });
  const brokerText = brokerSettingsText(brokerLanguage);
  const updateBrokerRole = useCallback((key: 'developer' | 'reviewer', value: DevReviewRole) => {
    if (key === 'developer') {
      setBrokerDeveloper(value);
      void kvSet('octo-broker-developer', value);
    } else {
      setBrokerReviewer(value);
      void kvSet('octo-broker-reviewer', value);
    }
  }, []);
  const updateBrokerLanguage = useCallback((value: 'en' | 'ko') => {
    setBrokerLanguage(value);
    localStorage.setItem(STORAGE_KEY_BROKER_LANGUAGE, value);
    void kvSet(STORAGE_KEY_BROKER_LANGUAGE, value);
    window.dispatchEvent(new CustomEvent('octo-broker-language-change'));
  }, []);
  const updateBrokerReviewMode = useCallback((value: BrokerReviewMode) => {
    setBrokerReviewMode(value);
    localStorage.setItem(STORAGE_KEY_BROKER_REVIEW_MODE, value);
    void kvSet(STORAGE_KEY_BROKER_REVIEW_MODE, value);
    window.dispatchEvent(new CustomEvent('octo-broker-review-mode-change'));
  }, []);
  const updateBrokerBrowserReview = useCallback((value: boolean) => {
    setBrokerBrowserReview(value);
    try { localStorage.setItem(STORAGE_KEY_BROKER_BROWSER_REVIEW, value ? '1' : '0'); } catch { /* ignore */ }
    void kvSet(STORAGE_KEY_BROKER_BROWSER_REVIEW, value ? '1' : '0');
    window.dispatchEvent(new CustomEvent('octo-broker-browser-review-change'));
  }, []);

  // Web Terminal — remote access via Cloudflare tunnel.
  const [webTermInfo, setWebTermInfo] = useState<{ token: string; port: number; url: string } | null>(null);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelMsg, setTunnelMsg] = useState<string | null>(null);

  // Secretary Gateway — external chat entry point (shares the REMOTE port/tunnel).
  const [gatewayInfo, setGatewayInfo] = useState<{ port: number; wsToken: string; localUrl: string } | null>(null);
  const [gatewayPwShow, setGatewayPwShow] = useState(false);

  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [telegramTokenConfigured, setTelegramTokenConfigured] = useState<boolean>(false);
  const [telegramTokenBusy, setTelegramTokenBusy] = useState(false);
  const [telegramTokenMsg, setTelegramTokenMsg] = useState<string | null>(null);
  const [telegramTokenShow, setTelegramTokenShow] = useState(false);

  // Telegram wizard & dashboard state
  const [tgWizardStep, setTgWizardStep] = useState<TelegramWizardStep>(1);
  const [tgDetecting, setTgDetecting] = useState(false);
  const [tgDetectedChats, setTgDetectedChats] = useState<TelegramChatInfo[]>([]);
  const [tgDetectMsg, setTgDetectMsg] = useState<string | null>(null);
  const [tgTestSending, setTgTestSending] = useState(false);
  const [tgTestMsg, setTgTestMsg] = useState<string | null>(null);
  const [tgBotInfo, setTgBotInfo] = useState<{ username: string; id: number } | null>(null);
  const [tgConnectionStatus, setTgConnectionStatus] = useState<'connected' | 'disconnected' | 'checking'>('disconnected');
  const [tgStats, setTgStats] = useState<TelegramStats>({ sent: 0, received: 0, lastMessageAt: null });
  const [tgErrorLog, setTgErrorLog] = useState<string[]>([]);
  const [tgManagedChats, setTgManagedChats] = useState<TelegramChatInfo[]>([]);
  const [tgChatLabels, setTgChatLabels] = useState<Record<string, string>>({});
  const [tgManualSettingsOpen, setTgManualSettingsOpen] = useState(false);
  const [tgPingBusy, setTgPingBusy] = useState(false);
  const [tgSelectedWizardChat, setTgSelectedWizardChat] = useState<string>('');

  const [discordBotToken, setDiscordBotToken] = useState('');
  const [discordTokenConfigured, setDiscordTokenConfigured] = useState<boolean>(false);
  const [discordTokenBusy, setDiscordTokenBusy] = useState(false);
  const [discordTokenMsg, setDiscordTokenMsg] = useState<string | null>(null);
  const [discordTokenShow, setDiscordTokenShow] = useState(false);
  const [slackBotToken, setSlackBotToken] = useState('');
  const [slackTokenConfigured, setSlackTokenConfigured] = useState<boolean>(false);
  const [slackTokenBusy, setSlackTokenBusy] = useState(false);
  const [slackTokenMsg, setSlackTokenMsg] = useState<string | null>(null);
  const [slackTokenShow, setSlackTokenShow] = useState(false);
  const [linearApiToken, setLinearApiToken] = useState('');
  const [linearTokenConfigured, setLinearTokenConfigured] = useState(false);
  const [linearTokenShow, setLinearTokenShow] = useState(false);
  const [linearBusy, setLinearBusy] = useState(false);
  const [linearMsg, setLinearMsg] = useState<string | null>(null);
  const [linearTeamId, setLinearTeamId] = useState('');
  const [linearProjectId, setLinearProjectId] = useState('');
  useEffect(() => {
    getLinearSettings().then(s => {
      setLinearTokenConfigured(isLinearConfigured(s));
      setLinearTeamId(s.teamId);
      setLinearProjectId(s.projectId);
    }).catch(() => {});
  }, []);
  const [linearTeams, setLinearTeams] = useState<LinearTeam[]>([]);
  const [linearSelectedProjectId, setLinearSelectedProjectId] = useState<string>(() => activeProjectId || '');
  const linearSelectedProject = useMemo(() => projects?.find(p => p.id === linearSelectedProjectId), [projects, linearSelectedProjectId]);
  const [linearPerProjectTeamId, setLinearPerProjectTeamId] = useState('');
  const [linearPerProjectProjectId, setLinearPerProjectProjectId] = useState('');
  useEffect(() => {
    if (linearSelectedProject) {
      setLinearPerProjectTeamId(linearSelectedProject.linearTeamId || '');
      setLinearPerProjectProjectId(linearSelectedProject.linearProjectId || '');
    }
  }, [linearSelectedProject]);

  // KV-backed integration settings (loaded async)
  const [kvSlackBotToken, setKvSlackBotToken] = useState('');
  const [kvSlackChannelId, setKvSlackChannelId] = useState('');
  const [kvGithubToken, setKvGithubToken] = useState('');
  const [kvGithubRepo, setKvGithubRepo] = useState('');
  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      setKvSlackBotToken(((await kvGet('octo-slack-bot-token')) || '').trim());
      setKvSlackChannelId(((await kvGet('octo-slack-channel-id')) || '').trim());
      setKvGithubToken(((await kvGet('octo-github-token')) || '').trim());
      setKvGithubRepo(((await kvGet('octo-github-repo')) || '').trim());
    })();
  }, [isOpen]);

  // GitHub repos
  const [ghRepos, setGhRepos] = useState<Array<{ full_name: string }>>([]);
  const [ghReposBusy, setGhReposBusy] = useState(false);
  const [ghReposMsg, setGhReposMsg] = useState('');
  const fetchGhRepos = useCallback(async () => {
    const token = ((await kvGet('octo-github-token')) || '').trim();
    if (!token) { setGhReposMsg(t('settings.integrations.github.tokenMissing')); return; }
    setGhReposBusy(true);
    setGhReposMsg('');
    try {
      const resp = await invoke<{ status: number; body: string }>('http_request', {
        input: {
          method: 'GET',
          url: 'https://api.github.com/user/repos?sort=updated&per_page=100&type=all',
          headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'OctoTerminal' },
        },
      });
      if (resp && resp.status < 400) {
        const list = JSON.parse(resp.body) as Array<{ full_name: string }>;
        if (list.length === 0) setGhReposMsg(t('settings.integrations.github.noRepos'));
        else setGhReposMsg(t('settings.integrations.github.reposFound').replace('{count}', String(list.length)));
        setGhRepos(list);
      } else {
        setGhReposMsg(`GitHub API error (${resp?.status || 0}): ${(resp?.body || '').slice(0, 100)}`);
      }
    } catch (e: any) { setGhReposMsg(`Fetch failed: ${e?.message || 'unknown'}`); } finally { setGhReposBusy(false); }
  }, []);

  // Slack channels
  const [slackChannels, setSlackChannels] = useState<Array<{ id: string; name: string }>>([]);
  const [slackChannelsBusy, setSlackChannelsBusy] = useState(false);
  const fetchSlackChannels = useCallback(async () => {
    const token = ((await kvGet('octo-slack-bot-token')) || '').trim();
    if (!token) return;
    setSlackChannelsBusy(true);
    try {
      const resp = await invoke<{ status: number; body: string }>('http_request', {
        input: {
          method: 'GET',
          url: 'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200&exclude_archived=true',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        },
      });
      if (resp && resp.status < 400) {
        const data = JSON.parse(resp.body);
        if (data.ok && Array.isArray(data.channels)) {
          setSlackChannels(data.channels.map((c: any) => ({ id: c.id, name: c.name })));
        }
      }
    } catch {} finally { setSlackChannelsBusy(false); }
  }, []);

  const [mediaEnvKeyName, setMediaEnvKeyName] = useState('MAKEKE_MEDIA_API_KEY');
  const [mediaEnvKeyValue, setMediaEnvKeyValue] = useState('');
  const [mediaEnvKeyShow, setMediaEnvKeyShow] = useState(false);
  const [mediaEnvKeyConfigured, setMediaEnvKeyConfigured] = useState(false);
  const [mediaEnvKeyMsg, setMediaEnvKeyMsg] = useState<string | null>(null);
  const [atlasApiKey, setAtlasApiKey] = useState('');
  const [atlasBaseUrl, setAtlasBaseUrl] = useState(ATLASCLOUD_DEFAULT_BASE_URL);
  const [atlasModel, setAtlasModel] = useState(ATLASCLOUD_DEFAULT_MODEL);
  const [atlasKeyShow, setAtlasKeyShow] = useState(false);
  const [atlasKeyConfigured, setAtlasKeyConfigured] = useState(false);
  const [atlasKeyMsg, setAtlasKeyMsg] = useState<string | null>(null);

  // Speech-to-text (local Whisper)
  const [_sttLanguage, _setSttLanguage] = useState(() => config.stt.language);
  const [_sttMicDeviceId, _setSttMicDeviceId] = useState(() => config.stt.micDeviceId);
  const [_sttMicDevices, _setSttMicDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [_sttMicDevicesError, _setSttMicDevicesError] = useState<string | null>(null);
  const [_sttMicTestStatus, _setSttMicTestStatus] = useState<string | null>(null);
  const [_sttAutoEnter, _setSttAutoEnter] = useState(() => config.stt.autoEnter);
  const [_sttPrompt, _setSttPrompt] = useState(() => config.stt.prompt);
  const [_sttSilenceGate, _setSttSilenceGate] = useState(() => config.stt.silenceGate);
  const [_sttHallucinationFilter, _setSttHallucinationFilter] = useState(() => config.stt.hallucinationFilter);
  const [_sttMinDurationMs, _setSttMinDurationMs] = useState(() => config.stt.minDurationMs);
  const [_sttMinRms, _setSttMinRms] = useState(() => config.stt.minRms);
  const [_sttDisableProcessing, _setSttDisableProcessing] = useState(() => config.stt.disableProcessing);
  const [_sttBoost, _setSttBoost] = useState(() => config.stt.boost);
  const [_sttUseLocalWhisper, _setSttUseLocalWhisper] = useState(true);
  const [_sttLocalWhisperModel, _setSttLocalWhisperModel] = useState(() => config.stt.localWhisperModel);
  const [_sttLocalModels, _setSttLocalModels] = useState<Array<{ value: string; label: string; size_mb: number; url: string }>>([]);
  const [_sttLocalModelStatus, _setSttLocalModelStatus] = useState<{ exists: boolean; size: number } | null>(null);
  const [_sttLocalModelDownloading, _setSttLocalModelDownloading] = useState(false);
  const [_sttLocalModelDownloadPct, _setSttLocalModelDownloadPct] = useState(0);

  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      const [atlasKey, atlasUrl, atlasModelValue] = await Promise.all([
        kvGet(ATLASCLOUD_KV_KEYS.apiKey).catch(() => ''),
        kvGet(ATLASCLOUD_KV_KEYS.baseUrl).catch(() => ''),
        kvGet(ATLASCLOUD_KV_KEYS.model).catch(() => ''),
      ]);
      setAtlasKeyConfigured(!!(atlasKey || '').trim());
      setAtlasBaseUrl((atlasUrl || '').trim() || ATLASCLOUD_DEFAULT_BASE_URL);
      setAtlasModel(normalizeAtlasCloudModelPreference(atlasModelValue));
      if (atlasKeyShow) setAtlasApiKey((atlasKey || '').trim());
    })();
  }, [isOpen, atlasKeyShow]);

  useEffect(() => {
    if (!isOpen) return;
    void kvDelete(STORAGE_KEY_STT_OPENAI_API_KEY);
    void kvDelete(STORAGE_KEY_GEMINI_API_KEY);
  }, [isOpen]);

  // Ollama
  const [ollamaUrl, setOllamaUrl] = useState(() => config.ollama.url);
  const [ollamaModel, setOllamaModel] = useState(() => config.ollama.model);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaStatus, setOllamaStatus] = useState<'idle' | 'loading' | 'connected' | 'error'>('idle');
  const [ollamaError, setOllamaError] = useState<string | null>(null);

  const [keybindingPreset, setKeybindingPreset] = useState<'default' | 'vscode' | 'intellij'>(() => {
    const fromProp = keybindingPresetProp;
    if (fromProp === 'vscode' || fromProp === 'intellij') return fromProp;
    if (fromProp === 'default') return 'default';
    return config.keybindingPreset;
  });

  const fetchOllamaModels = useCallback(async (url: string) => {
    setOllamaStatus('loading');
    setOllamaError(null);
    try {
      const res = await invoke<{ status: number; body: string }>('http_request', {
        input: {
          method: 'GET',
          url: `${url}/api/tags`,
          headers: {},
          body: '',
        },
      });
      const data = JSON.parse(res.body) as { models?: Array<{ name: string }> };
      const names = (data.models || []).map((m) => m.name);
      setOllamaModels(names);
      setOllamaStatus('connected');
    } catch (e) {
      setOllamaModels([]);
      setOllamaStatus('error');
      setOllamaError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const playTestSound = () => {
    try {
      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      const t0 = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      osc.stop(t0 + 0.14);
      osc.onended = () => {
        try { ctx.close(); } catch { /* ignore */ }
      };
    } catch {
      // ignore
    }
  };

  // Fire a real OS notification with the selected sound so the user can hear it.
  // Note: macOS suppresses the banner (and its sound) while the app is frontmost.
  const playTestOsSound = async () => {
    try {
      let granted = await notifIsPermissionGranted();
      if (!granted) granted = (await notifRequestPermission()) === 'granted';
      if (!granted) return;
      const name = agentSettings.osNotifySoundName || 'Glass';
      const isWin = navigator.platform.toLowerCase().includes('win');
      notifSend({ title: t('settings.agent.notifTestTitle'), body: name, ...(isWin ? {} : { sound: name }) });
    } catch { /* notifications unavailable */ }
  };

  const _refreshSttMicDevices = useCallback(async () => {
    _setSttMicDevicesError(null);
    try {
      const md = navigator.mediaDevices;
      if (!md?.enumerateDevices) {
        _setSttMicDevices([]);
        _setSttMicDevicesError(t('settings.agent.stt.micListUnsupported'));
        return;
      }
      const list = await md.enumerateDevices();
      const mics = list
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId ? d.deviceId.slice(-6) : ''}`.trim(),
        }))
        .filter((d) => d.deviceId);
      _setSttMicDevices(mics);
    } catch (e) {
      _setSttMicDevices([]);
      _setSttMicDevicesError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const _testSttMic = useCallback(async () => {
    _setSttMicDevicesError(null);
    _setSttMicTestStatus(t('settings.agent.stt.micRequesting'));
    try {
      const md = navigator.mediaDevices;
      if (!md?.getUserMedia) {
        _setSttMicTestStatus(null);
        _setSttMicDevicesError(t('settings.agent.stt.micUnsupported'));
        return;
      }

      const audio: MediaTrackConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
      if (_sttMicDeviceId) audio.deviceId = { exact: _sttMicDeviceId };

      const stream = await md.getUserMedia({ audio, video: false });
      await _refreshSttMicDevices();

      const AudioCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) {
        stream.getTracks().forEach((track) => track.stop());
        _setSttMicTestStatus(t('settings.agent.stt.micPermissionOk'));
        return;
      }

      _setSttMicTestStatus(t('settings.agent.stt.micListening'));
      const audioContext = new AudioCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const data = new Float32Array(analyser.fftSize);
      let maxRms = 0;
      const started = performance.now();
      await new Promise<void>((resolve) => {
        const tick = () => {
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
          maxRms = Math.max(maxRms, Math.sqrt(sum / data.length));
          if (performance.now() - started >= 1500) resolve();
          else requestAnimationFrame(tick);
        };
        tick();
      });

      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close().catch(() => {});

      const label = stream.getAudioTracks()[0]?.label || t('settings.agent.stt.selectedMic');
      _setSttMicTestStatus(
        maxRms >= 0.01
          ? t('settings.agent.stt.micOk').replace('{label}', label).replace('{pct}', (maxRms * 100).toFixed(1))
          : t('settings.agent.stt.micQuiet').replace('{label}', label)
      );
    } catch (e) {
      _setSttMicTestStatus(null);
      _setSttMicDevicesError(e instanceof Error ? e.message : String(e));
    }
  }, [_refreshSttMicDevices, _sttMicDeviceId]);

  const refreshSttLocalModels = useCallback(async () => {
    try {
      const models = await invoke<Array<{ value: string; label: string; size_mb: number; url: string }>>('list_local_whisper_models');
      _setSttLocalModels(models);
    } catch {
      _setSttLocalModels([]);
    }
  }, []);

  const refreshSttLocalModelStatus = useCallback(async (modelName?: string) => {
    try {
      const status = await invoke<{ exists: boolean; size: number }>('local_whisper_model_status', {
        modelName: (modelName || _sttLocalWhisperModel || config.stt.localWhisperModel || '').trim() || null,
      });
      _setSttLocalModelStatus({ exists: !!status.exists, size: Number(status.size) || 0 });
    } catch {
      _setSttLocalModelStatus(null);
    }
  }, [_sttLocalWhisperModel, config.stt.localWhisperModel]);

  useEffect(() => {
    if (!isOpen) return;
    void _refreshSttMicDevices();
    void refreshSttLocalModels();
  }, [_refreshSttMicDevices, isOpen, refreshSttLocalModels]);

  useEffect(() => {
    if (!isOpen || !_sttUseLocalWhisper) return;
    void refreshSttLocalModelStatus(_sttLocalWhisperModel);
  }, [_sttLocalWhisperModel, _sttUseLocalWhisper, isOpen, refreshSttLocalModelStatus]);

  // Live download progress for the local Whisper model (emitted from Rust).
  useEffect(() => {
    if (!isOpen) return;
    const unlisteners: Array<() => void> = [];
    void listen<{ percent?: number }>('local-whisper-download-progress', (e) => {
      const pct = Number(e.payload?.percent);
      if (Number.isFinite(pct)) _setSttLocalModelDownloadPct(Math.max(0, Math.min(100, pct)));
    }).then((un) => unlisteners.push(un));
    void listen('local-whisper-download-done', () => {
      _setSttLocalModelDownloadPct(100);
    }).then((un) => unlisteners.push(un));
    return () => { unlisteners.forEach((un) => un()); };
  }, [isOpen]);

  // Explicit, opt-in model download (triggered by the Settings button). The model
  // is never auto-downloaded during transcription — see download_local_whisper_model.
  const downloadSttLocalModel = useCallback(async () => {
    const modelName = (_sttLocalWhisperModel || config.stt.localWhisperModel || '').trim() || null;
    _setSttLocalModelDownloading(true);
    _setSttLocalModelDownloadPct(0);
    try {
      await invoke('download_local_whisper_model', { modelName });
      await refreshSttLocalModelStatus(modelName || undefined);
    } catch (e) {
      _setSttMicTestStatus(e instanceof Error ? e.message : String(e));
    } finally {
      _setSttLocalModelDownloading(false);
    }
  }, [_sttLocalWhisperModel, config.stt.localWhisperModel, refreshSttLocalModelStatus]);

  const buildSttConfig = useCallback((): SttConfig => ({
    language: _sttLanguage.trim() || 'ko',
    model: LATEST_OPENAI_STT_MODEL,
    micDeviceId: _sttMicDeviceId.trim(),
    autoEnter: !!_sttAutoEnter,
    prompt: _sttPrompt.trim(),
    silenceGate: !!_sttSilenceGate,
    hallucinationFilter: !!_sttHallucinationFilter,
    minDurationMs: Math.max(0, Math.min(5000, Number(_sttMinDurationMs) || 300)),
    minRms: Math.max(0, Math.min(0.2, Number(_sttMinRms) || 0.004)),
    disableProcessing: !!_sttDisableProcessing,
    boost: Math.max(1, Math.min(8, Number(_sttBoost) || 2)),
    useLocalWhisper: true,
    localWhisperModel: _sttLocalWhisperModel.trim() || 'ggml-large-v3-turbo.bin',
  }), [
    _sttAutoEnter,
    _sttBoost,
    _sttDisableProcessing,
    _sttHallucinationFilter,
    _sttLanguage,
    _sttLocalWhisperModel,
    _sttMicDeviceId,
    _sttMinDurationMs,
    _sttMinRms,
    _sttPrompt,
    _sttSilenceGate,
  ]);

  const persistSttConfig = useCallback((stt: SttConfig) => {
    void kvSet(STORAGE_KEY_STT_LANGUAGE, stt.language);
    void kvSet(STORAGE_KEY_STT_MODEL, stt.model);
    if (stt.micDeviceId) void kvSet(STORAGE_KEY_STT_MIC_DEVICE_ID, stt.micDeviceId);
    else void kvDelete(STORAGE_KEY_STT_MIC_DEVICE_ID);
    void kvSet(STORAGE_KEY_STT_AUTO_ENTER, stt.autoEnter ? '1' : '0');
    if (stt.prompt) void kvSet(STORAGE_KEY_STT_PROMPT, stt.prompt);
    else void kvDelete(STORAGE_KEY_STT_PROMPT);
    void kvSet(STORAGE_KEY_STT_SILENCE_GATE, stt.silenceGate ? '1' : '0');
    void kvSet(STORAGE_KEY_STT_HALLUCINATION_FILTER, stt.hallucinationFilter ? '1' : '0');
    void kvSet(STORAGE_KEY_STT_MIN_DURATION_MS, String(stt.minDurationMs));
    void kvSet(STORAGE_KEY_STT_MIN_RMS, String(stt.minRms));
    void kvSet(STORAGE_KEY_STT_DISABLE_PROCESSING, stt.disableProcessing ? '1' : '0');
    void kvSet(STORAGE_KEY_STT_BOOST, String(stt.boost));
    void kvSet(STORAGE_KEY_STT_USE_LOCAL_WHISPER, '1');
    void kvSet(STORAGE_KEY_STT_LOCAL_WHISPER_MODEL, stt.localWhisperModel);
  }, []);

  const saveTelegramToken = async () => {
    const tok = telegramBotToken.trim();
    if (!tok) {
      setTelegramTokenMsg(t('settings.agent.token.empty'));
      return;
    }
    setTelegramTokenBusy(true);
    setTelegramTokenMsg(null);
    try {
      await kvSet(STORAGE_KEY_TELEGRAM_BOT_TOKEN, tok);
      setTelegramTokenConfigured(true);
      // Keep the value only if user is currently showing it; otherwise clear the field.
      if (!telegramTokenShow) setTelegramBotToken('');
      onTelegramBotTokenChange?.(tok);
      setTelegramTokenMsg(t('settings.common.saved'));
    } catch (e) {
      setTelegramTokenMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTelegramTokenBusy(false);
    }
  };

  const clearTelegramToken = () => {
    void kvDelete(STORAGE_KEY_TELEGRAM_BOT_TOKEN);
    setTelegramTokenConfigured(false);
    setTelegramBotToken('');
    setTelegramTokenShow(false);
    onTelegramBotTokenChange?.('');
    setTelegramTokenMsg(t('settings.common.resetDone'));
  };

  const verifyTelegramToken = async () => {
    if (!isTauri) {
      setTelegramTokenMsg(t('settings.agent.token.verifyTauriOnly'));
      return;
    }
    setTelegramTokenBusy(true);
    setTelegramTokenMsg(null);
    try {
      const tok = telegramBotToken.trim() || ((await kvGet(STORAGE_KEY_TELEGRAM_BOT_TOKEN)) || '').trim();
      if (!tok) {
        setTelegramTokenMsg(t('settings.agent.token.empty'));
        return;
      }
      const res = await invoke<{ id: number; username?: string | null; first_name: string; is_bot: boolean }>(
        'telegram_verify_bot_token_any',
        { botToken: tok }
      );
      const uname = res.username ? `@${res.username}` : '(no username)';
      setTelegramTokenMsg(`OK. Bot: ${uname} (id: ${res.id})`);
      setTelegramTokenConfigured(true);
    } catch (e) {
      setTelegramTokenMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTelegramTokenBusy(false);
    }
  };

  // ── Telegram wizard helpers ──
  const getTelegramToken = async (): Promise<string> => {
    try { return ((await kvGet(STORAGE_KEY_TELEGRAM_BOT_TOKEN)) || '').trim(); } catch { return ''; }
  };

  const tgWizardVerifyAndSave = async () => {
    const tok = telegramBotToken.trim();
    if (!tok) { setTelegramTokenMsg(t('settings.agent.token.pastePrompt')); return; }
    if (!isTauri) { setTelegramTokenMsg(t('settings.common.tauriOnly')); return; }
    setTelegramTokenBusy(true);
    setTelegramTokenMsg(null);
    try {
      const res = await invoke<{ id: number; username?: string | null; first_name: string; is_bot: boolean }>(
        'telegram_verify_bot_token_any',
        { botToken: tok }
      );
      await kvSet(STORAGE_KEY_TELEGRAM_BOT_TOKEN, tok);
      setTelegramTokenConfigured(true);
      setTgBotInfo({ username: res.username || res.first_name, id: res.id });
      onTelegramBotTokenChange?.(tok);
      setTelegramTokenMsg(`@${res.username || res.first_name} (id: ${res.id})`);
      setTgWizardStep(3);
    } catch (e) {
      setTelegramTokenMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTelegramTokenBusy(false);
    }
  };

  const tgDetectChats = async () => {
    const tok = await getTelegramToken();
    if (!tok || !isTauri) return;
    setTgDetecting(true);
    setTgDetectMsg(t('settings.agent.telegram.detecting'));
    setTgDetectedChats([]);
    try {
      const res = await invoke<{ updates: TelegramIncoming[]; next_offset: number }>(
        'telegram_get_updates_any',
        { botToken: tok, offset: 0 }
      );
      const seen = new Map<string, TelegramChatInfo>();
      for (const u of res.updates) {
        const key = String(u.chat_id);
        if (!seen.has(key)) {
          seen.set(key, {
            chatId: key,
            title: u.chat_title || u.chat_username || `Chat ${key}`,
            type: u.chat_type || 'private',
            username: u.chat_username || undefined,
          });
        }
      }
      const chats = Array.from(seen.values());
      setTgDetectedChats(chats);
      setTgDetectMsg(chats.length > 0 ? t('settings.agent.telegram.chatsDetected').replace('{count}', String(chats.length)) : t('settings.agent.telegram.noChatsDetected'));
      // Update stats
      const stats = { ...tgStats, received: tgStats.received + res.updates.length, lastMessageAt: new Date().toISOString() };
      setTgStats(stats);
      saveTelegramStats(stats);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTgDetectMsg(msg);
      setTgErrorLog(prev => [`${new Date().toLocaleTimeString()}: ${msg}`, ...prev].slice(0, 5));
    } finally {
      setTgDetecting(false);
    }
  };

  const tgSendTestMessage = async (chatId: string) => {
    const tok = await getTelegramToken();
    if (!tok || !chatId || !isTauri) return;
    setTgTestSending(true);
    setTgTestMsg(null);
    try {
      await invoke('telegram_send_message_with_token', {
        botToken: tok,
        chatId,
        text: `BBARIT Terminal connection test complete! (${new Date().toLocaleTimeString()})`,
        replyMarkupJson: null,
      });
      const stats = { ...tgStats, sent: tgStats.sent + 1, lastMessageAt: new Date().toISOString() };
      setTgStats(stats);
      saveTelegramStats(stats);
      setTgTestMsg('Test message sent!');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTgTestMsg(msg);
      setTgErrorLog(prev => [`${new Date().toLocaleTimeString()}: ${msg}`, ...prev].slice(0, 5));
    } finally {
      setTgTestSending(false);
    }
  };

  const tgPingTest = async () => {
    const tok = await getTelegramToken();
    if (!tok || !isTauri) return;
    setTgPingBusy(true);
    setTgConnectionStatus('checking');
    try {
      const res = await invoke<{ id: number; username?: string | null; first_name: string; is_bot: boolean }>(
        'telegram_verify_bot_token_any',
        { botToken: tok }
      );
      setTgBotInfo({ username: res.username || res.first_name, id: res.id });
      setTgConnectionStatus('connected');
    } catch (e) {
      setTgConnectionStatus('disconnected');
      const msg = e instanceof Error ? e.message : String(e);
      setTgErrorLog(prev => [`${new Date().toLocaleTimeString()}: ${msg}`, ...prev].slice(0, 5));
    } finally {
      setTgPingBusy(false);
    }
  };

  const tgAddDetectedChatsToManaged = () => {
    const existing = new Set(tgManagedChats.map(c => c.chatId));
    const newChats = tgDetectedChats.filter(c => !existing.has(c.chatId));
    if (newChats.length > 0) {
      setTgManagedChats(prev => [...prev, ...newChats]);
    }
  };

  const tgRemoveChat = (chatId: string) => {
    setTgManagedChats(prev => prev.filter(c => c.chatId !== chatId));
    // Unlink from projects
    if (projects && onProjectUpdate) {
      for (const p of projects) {
        if (p.telegramChatId === chatId) {
          onProjectUpdate(p.id, { telegramChatId: undefined });
        }
      }
    }
  };

  const tgUpdateChatLabel = (chatId: string, label: string) => {
    const next = { ...tgChatLabels, [chatId]: label };
    setTgChatLabels(next);
    saveChatLabels(next);
    setTgManagedChats(prev => prev.map(c => c.chatId === chatId ? { ...c, label } : c));
  };

  const tgLinkChatToProject = (chatId: string, projectId: string) => {
    // Unlink other projects from this chat first
    if (projects && onProjectUpdate) {
      for (const p of projects) {
        if (p.telegramChatId === chatId && p.id !== projectId) {
          onProjectUpdate(p.id, { telegramChatId: undefined });
        }
      }
      if (projectId) {
        onProjectUpdate(projectId, { telegramChatId: chatId });
      }
    }
    setTgManagedChats(prev => prev.map(c => c.chatId === chatId ? { ...c, linkedProjectId: projectId || undefined } : c));
  };

  // Init telegram dashboard on panel open
  useEffect(() => {
    if (!isOpen || !telegramTokenConfigured) return;
    void (async () => {
      const tok = await getTelegramToken();
      if (!tok) return;
      // Build managed chats from projects
      const chatMap = new Map<string, TelegramChatInfo>();
      if (projects) {
        for (const p of projects) {
          if (p.telegramChatId) {
            const labels = await loadChatLabels();
            chatMap.set(p.telegramChatId, {
              chatId: p.telegramChatId,
              title: labels[p.telegramChatId] || `Chat ${p.telegramChatId}`,
              type: 'unknown',
              label: labels[p.telegramChatId],
              linkedProjectId: p.id,
            });
          }
        }
      }
      setTgManagedChats(Array.from(chatMap.values()));
      // Ping to check status
      void tgPingTest();
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, telegramTokenConfigured]);

  // ── Discord token functions ──
  const saveDiscordToken = async () => {
    const tok = discordBotToken.trim();
    if (!tok) {
      setDiscordTokenMsg(t('settings.agent.token.empty'));
      return;
    }
    setDiscordTokenBusy(true);
    setDiscordTokenMsg(null);
    try {
      await kvSet(STORAGE_KEY_DISCORD_BOT_TOKEN, tok);
      setDiscordTokenConfigured(true);
      if (!discordTokenShow) setDiscordBotToken('');
      onDiscordBotTokenChange?.(tok);
      setDiscordTokenMsg(t('settings.common.saved'));
    } catch (e) {
      setDiscordTokenMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscordTokenBusy(false);
    }
  };

  const clearDiscordToken = () => {
    void kvDelete(STORAGE_KEY_DISCORD_BOT_TOKEN);
    setDiscordTokenConfigured(false);
    setDiscordBotToken('');
    setDiscordTokenShow(false);
    onDiscordBotTokenChange?.('');
    setDiscordTokenMsg(t('settings.common.resetDone'));
  };

  const verifyDiscordToken = async () => {
    if (!isTauri) {
      setDiscordTokenMsg(t('settings.agent.token.verifyTauriOnly'));
      return;
    }
    setDiscordTokenBusy(true);
    setDiscordTokenMsg(null);
    try {
      const tok = discordBotToken.trim() || ((await kvGet(STORAGE_KEY_DISCORD_BOT_TOKEN)) || '').trim();
      if (!tok) {
        setDiscordTokenMsg(t('settings.agent.token.empty'));
        return;
      }
      const res = await invoke<{ id: string; username: string }>(
        'discord_verify_bot_token',
        { botToken: tok }
      );
      setDiscordTokenMsg(`OK. Bot: ${res.username} (id: ${res.id})`);
      setDiscordTokenConfigured(true);
    } catch (e) {
      setDiscordTokenMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscordTokenBusy(false);
    }
  };

  // ── Slack token functions ──
  const saveSlackToken = async () => {
    const tok = slackBotToken.trim();
    if (!tok) {
      setSlackTokenMsg(t('settings.agent.token.empty'));
      return;
    }
    setSlackTokenBusy(true);
    setSlackTokenMsg(null);
    try {
      await kvSet(STORAGE_KEY_SLACK_BOT_TOKEN, tok);
      setSlackTokenConfigured(true);
      if (!slackTokenShow) setSlackBotToken('');
      onSlackBotTokenChange?.(tok);
      setSlackTokenMsg(t('settings.common.saved'));
    } catch (e) {
      setSlackTokenMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSlackTokenBusy(false);
    }
  };

  const clearSlackToken = () => {
    void kvDelete(STORAGE_KEY_SLACK_BOT_TOKEN);
    setSlackTokenConfigured(false);
    setSlackBotToken('');
    setSlackTokenShow(false);
    onSlackBotTokenChange?.('');
    setSlackTokenMsg(t('settings.common.resetDone'));
  };

  const verifySlackToken = async () => {
    if (!isTauri) {
      setSlackTokenMsg(t('settings.agent.token.verifyTauriOnly'));
      return;
    }
    setSlackTokenBusy(true);
    setSlackTokenMsg(null);
    try {
      const tok = slackBotToken.trim() || ((await kvGet(STORAGE_KEY_SLACK_BOT_TOKEN)) || '').trim();
      if (!tok) {
        setSlackTokenMsg(t('settings.agent.token.empty'));
        return;
      }
      const res = await invoke<{ ok: boolean; user_id: string; team: string }>(
        'slack_verify_token',
        { botToken: tok }
      );
      setSlackTokenMsg(`OK. Team: ${res.team} (user: ${res.user_id})`);
      setSlackTokenConfigured(true);
    } catch (e) {
      setSlackTokenMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSlackTokenBusy(false);
    }
  };

  const saveLinearConnection = async () => {
    const next = await saveLinearSettings({
      apiToken: linearApiToken.trim() || undefined,
      teamId: linearTeamId.trim(),
      projectId: linearProjectId.trim(),
    });
    setLinearTokenConfigured(isLinearConfigured(next));
    if (!linearTokenShow) setLinearApiToken('');
    // Save per-project Linear overrides
    if (linearSelectedProjectId && onProjectUpdate) {
      onProjectUpdate(linearSelectedProjectId, {
        linearTeamId: linearPerProjectTeamId.trim() || undefined,
        linearProjectId: linearPerProjectProjectId.trim() || undefined,
      });
    }
    setLinearMsg(t('settings.integrations.linear.saved'));
  };

  const clearLinearConnectionToken = async () => {
    await clearLinearToken();
    setLinearTokenConfigured(false);
    setLinearApiToken('');
    setLinearTokenShow(false);
    setLinearTeams([]);
    setLinearMsg(t('settings.integrations.linear.tokenReset'));
  };

  const verifyLinearConnection = async () => {
    const token = linearApiToken.trim() || (await getLinearSettings()).apiToken;
    if (!token) {
      setLinearMsg(t('settings.integrations.linear.tokenEmpty'));
      return;
    }
    setLinearBusy(true);
    setLinearMsg(null);
    try {
      const teams = await fetchLinearTeams(token);
      setLinearTeams(teams);
      const currentTeam = linearTeamId.trim();
      if (!currentTeam && teams[0]?.id) setLinearTeamId(teams[0].id);
      void saveLinearSettings({ apiToken: token });
      setLinearTokenConfigured(true);
      if (!linearTokenShow) setLinearApiToken('');
      setLinearMsg(teams.length > 0
        ? t('settings.integrations.linear.teamsFetched').replace('{count}', String(teams.length))
        : t('settings.integrations.linear.noTeams'));
    } catch (e) {
      setLinearMsg(e instanceof Error ? e.message : String(e));
      setLinearTeams([]);
    } finally {
      setLinearBusy(false);
    }
  };

  const saveAtlasCloudKey = useCallback(async () => {
    const key = atlasApiKey.trim();
    if (!key) return;
    await Promise.all([
      kvSet(ATLASCLOUD_KV_KEYS.apiKey, key),
      kvSet(ATLASCLOUD_KV_KEYS.baseUrl, atlasBaseUrl.trim() || ATLASCLOUD_DEFAULT_BASE_URL),
      kvSet(ATLASCLOUD_KV_KEYS.model, normalizeAtlasCloudModelPreference(atlasModel)),
    ]);
    setAtlasKeyConfigured(true);
    setAtlasKeyMsg(t('settings.agent.atlas.saved'));
    if (!atlasKeyShow) setAtlasApiKey('');
  }, [atlasApiKey, atlasBaseUrl, atlasKeyShow, atlasModel]);

  const clearAtlasCloudKey = useCallback(async () => {
    await kvDelete(ATLASCLOUD_KV_KEYS.apiKey);
    setAtlasKeyConfigured(false);
    setAtlasApiKey('');
    setAtlasKeyShow(false);
    setAtlasKeyMsg(t('settings.agent.atlas.keyRemoved'));
  }, []);

  const normalizeEnvKeyName = (name: string) => name.trim().replace(/[^A-Z0-9_]/gi, '_').toUpperCase();

  const parseEnvValue = (content: string, name: string) => {
    const safeName = normalizeEnvKeyName(name);
    if (!safeName) return '';
    const line = content.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${safeName}=`));
    if (!line) return '';
    const raw = line.slice(line.indexOf('=') + 1).trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
    return raw;
  };

  const quoteEnvValue = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

  const readOctoEnvFile = useCallback(async () => {
    const home = await invoke<string>('get_home_dir');
    const path = `${home}/.config/octo/.env`;
    const content = await invoke<string>('read_file', { path }).catch(() => '');
    return { home, path, content: String(content || '') };
  }, []);

  const refreshMediaEnvKey = useCallback(async (keyName = mediaEnvKeyName) => {
    const safeName = normalizeEnvKeyName(keyName || 'MAKEKE_MEDIA_API_KEY');
    if (!safeName) return;
    try {
      const { content } = await readOctoEnvFile();
      const value = parseEnvValue(content, safeName);
      setMediaEnvKeyConfigured(!!value.trim());
      if (mediaEnvKeyShow) setMediaEnvKeyValue(value);
      else setMediaEnvKeyValue('');
      setMediaEnvKeyMsg(value.trim() ? `${safeName} configured` : `${safeName} not configured`);
    } catch (e) {
      setMediaEnvKeyConfigured(false);
      setMediaEnvKeyMsg(e instanceof Error ? e.message : String(e));
    }
  }, [mediaEnvKeyName, mediaEnvKeyShow, readOctoEnvFile]);

  useEffect(() => {
    if (!isOpen) return;
    void refreshMediaEnvKey();
  }, [isOpen, mediaEnvKeyName, refreshMediaEnvKey]);

  const saveMediaEnvKey = useCallback(async () => {
    const safeName = normalizeEnvKeyName(mediaEnvKeyName || 'MAKEKE_MEDIA_API_KEY');
    const key = mediaEnvKeyValue.trim();
    if (!safeName || !key) return;
    try {
      const { home, path, content } = await readOctoEnvFile();
      await invoke('create_directory', { path: `${home}/.config/octo` }).catch(() => {});
      const lines = content.split(/\r?\n/).filter((line, index, arr) => !(index === arr.length - 1 && line === ''));
      const nextLine = `${safeName}=${quoteEnvValue(key)}`;
      let replaced = false;
      const nextLines = lines.map((line) => {
        if (line.trim().startsWith(`${safeName}=`)) {
          replaced = true;
          return nextLine;
        }
        return line;
      });
      if (!replaced) nextLines.push(nextLine);
      await invoke('write_file', { path, content: `${nextLines.join('\n')}\n` });
      setMediaEnvKeyConfigured(true);
      if (!mediaEnvKeyShow) setMediaEnvKeyValue('');
      setMediaEnvKeyMsg(`${safeName} saved to ~/.config/octo/.env`);
    } catch (e) {
      setMediaEnvKeyMsg(e instanceof Error ? e.message : String(e));
    }
  }, [mediaEnvKeyName, mediaEnvKeyShow, mediaEnvKeyValue, readOctoEnvFile]);

  const clearMediaEnvKey = useCallback(async () => {
    const safeName = normalizeEnvKeyName(mediaEnvKeyName || 'MAKEKE_MEDIA_API_KEY');
    if (!safeName) return;
    try {
      const { path, content } = await readOctoEnvFile();
      const nextLines = content.split(/\r?\n/).filter((line) => !line.trim().startsWith(`${safeName}=`));
      await invoke('write_file', { path, content: `${nextLines.filter(Boolean).join('\n')}${nextLines.some(Boolean) ? '\n' : ''}` });
      setMediaEnvKeyConfigured(false);
      setMediaEnvKeyValue('');
      setMediaEnvKeyShow(false);
      setMediaEnvKeyMsg(`${safeName} removed from ~/.config/octo/.env`);
    } catch (e) {
      setMediaEnvKeyMsg(e instanceof Error ? e.message : String(e));
    }
  }, [mediaEnvKeyName, readOctoEnvFile]);



  const updateTerminalSetting = <K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) => {
    setTerminalSettings(prev => {
      const next = { ...prev, [key]: value };
      onTerminalSettingsChange?.(next);
      return next;
    });
  };

  const updateEditorSetting = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => {
    setEditorSettings(prev => ({ ...prev, [key]: value }));
  };

  const setPreset = (preset: 'default' | 'vscode' | 'intellij') => {
    setKeybindingPreset(preset);
    updateConfig(prev => ({ ...prev, keybindingPreset: preset }));
    onKeybindingPresetChange?.(preset);
  };

  // Update flags from textarea - called on blur or Cmd+Enter
  const updateFlags = (agent: 'claude' | 'codex' | 'cursor' | 'kimi' | 'gemini' | 'qwen' | 'reasonix' | 'bbarit', raw: string) => {
    const userFlags = parseFlagLines(raw);
    setAgentSettings(prev => {
      if (agent === 'claude') {
        return { ...prev, claudeFlags: withoutModeFlags(userFlags, CLAUDE_MODE_FLAGS) };
      }
      if (agent === 'codex') {
        return { ...prev, codexFlags: withoutModeFlags(userFlags, CODEX_MODE_FLAGS) };
      }
      if (agent === 'cursor') {
        return { ...prev, cursorFlags: withoutModeFlags(userFlags, CURSOR_MODE_FLAGS) };
      }
      if (agent === 'gemini') {
        return { ...prev, geminiFlags: userFlags };
      }
      if (agent === 'qwen') {
        return { ...prev, qwenFlags: userFlags.filter(flag => !flag.startsWith('--approval-mode') && flag !== '--yolo' && flag !== '-y') };
      }
      if (agent === 'reasonix') {
        return { ...prev, reasonixFlags: userFlags };
      }
      if (agent === 'bbarit') {
        return { ...prev, bbaritFlags: userFlags };
      }
      return { ...prev, kimiFlags: withoutModeFlags(userFlags, KIMI_MODE_FLAGS) };
    });
  };

  const normalizeFlagsText = (raw: string): string => formatFlagLines(parseFlagLines(raw));

  const renderBbaritPersonaPreview = () => {
    const personaId = agentSettings.bbaritPersona || '';
    const profile = buildBbaritPersonaProfile(
      bbaritPersonas.find((persona) => persona.id === personaId),
      personaId,
    );
    if (!profile) {
      return (
        <span className="setting-description">
          {t('settings.agent.bbaritPersona.defaultDesc' as any, 'No default persona. You can still inject one from the terminal persona button.')}
        </span>
      );
    }
    const iconUrl = personaIconUrl(profile.id);
    return (
      <div className="bbarit-persona-preview">
        {iconUrl
          ? <img className="bbarit-persona-icon" src={iconUrl} alt="" width={40} height={40} draggable={false} />
          : <span className="bbarit-persona-face">{profile.face}</span>}
        <span className="bbarit-persona-main">
          <strong>{profile.face} {profile.name}</strong>
          <span>{profile.description}</span>
        </span>
      </div>
    );
  };

  const shortcutLabel = useMemo(() => {
    const mod = isMacPlatform ? '⌘' : 'Ctrl';
    const alt = isMacPlatform ? '⌥' : 'Alt';
    const shift = 'Shift';

    if (keybindingPreset === 'vscode') {
      return {
        newTerminal: `${mod}+${shift}+\``,
        closeTerminal: `${mod}+W`,
        closeAllTerminals: `${mod}+${shift}+W`,
        nextTerminal: `${mod}+]`,
        prevTerminal: `${mod}+[`,
        lastCompletedTask: `Ctrl+Tab / ${mod}+${shift}+J`,
        toggleTerminalMode: `${mod}+\``,
        openSettings: `${mod}+,`,
        newProject: `${mod}+N`,
        splitRight: `${mod}+\\`,
        splitDown: `${mod}+${shift}+\\`,
        focusPane: `${mod}+${alt}+Arrow keys`,
        commandPalette: `${mod}+${shift}+P`,
        save: `${mod}+S`,
        closeAllEditors: `${mod}+${alt}+W`,
      };
    }

    if (keybindingPreset === 'intellij') {
      return {
        newTerminal: `${mod}+T`,
        closeTerminal: `${mod}+W`,
        closeAllTerminals: `${mod}+${shift}+W`,
        nextTerminal: `${mod}+]`,
        prevTerminal: `${mod}+[`,
        lastCompletedTask: `Ctrl+Tab / ${mod}+${shift}+J`,
        toggleTerminalMode: `${alt}+F12`,
        openSettings: isMacPlatform ? `${mod}+,` : `Ctrl+Alt+S`,
        newProject: `${mod}+N`,
        splitRight: `${mod}+\\`,
        splitDown: `${mod}+${shift}+\\`,
        focusPane: `${mod}+${alt}+Arrow keys`,
        commandPalette: `${mod}+${shift}+A`,
        save: `${mod}+S`,
        closeAllEditors: `${mod}+${alt}+W`,
      };
    }

    // default (Octo)
    return {
      newTerminal: `${mod}+T`,
      closeTerminal: `${mod}+W`,
      closeAllTerminals: `${mod}+${shift}+W`,
      nextTerminal: `${mod}+]`,
      prevTerminal: `${mod}+[`,
      lastCompletedTask: `Ctrl+Tab / ${mod}+${shift}+J`,
      toggleTerminalMode: `${mod}+${shift}+F`,
      openSettings: `${mod}+,`,
      newProject: `${mod}+N`,
      splitRight: `${mod}+D`,
      splitDown: `${mod}+${shift}+D`,
      focusPane: `${mod}+${alt}+Arrow keys`,
      commandPalette: `${mod}+${shift}+P`,
      save: `${mod}+S`,
      closeAllEditors: `${mod}+${alt}+W`,
    };
  }, [isMacPlatform, keybindingPreset]);

  // Keep hook order stable: don't return early before all hooks run.
  if (!isOpen) return null;

  // Build persisted settings and notify parent on close
  const handleCloseAndSave = () => {
    const normalizedClaudeInput = parseFlagLines(claudeFlagsInput);
    const normalizedCodexInput = parseFlagLines(codexFlagsInput);
    const normalizedCursorInput = parseFlagLines(cursorFlagsInput);
    const normalizedKimiInput = parseFlagLines(kimiFlagsInput);
    const normalizedGeminiInput = parseFlagLines(geminiFlagsInput);
    const normalizedQwenInput = parseFlagLines(qwenFlagsInput);
    const normalizedReasonixInput = parseFlagLines(reasonixFlagsInput);
    const normalizedBbaritInput = parseFlagLines(bbaritFlagsInput);

    // Mode is stored in codexMode/claudeMode/kimiMode fields only.
    // Flags array contains only user-specified extra flags (no mode flags).
    const persistedAgent: AgentSettings = {
      ...agentSettings,
      claudeFlags: withoutModeFlags(normalizedClaudeInput, CLAUDE_MODE_FLAGS),
      codexFlags: withoutModeFlags(normalizedCodexInput, CODEX_MODE_FLAGS),
      cursorMode: agentSettings.cursorMode || 'normal',
      cursorModel: agentSettings.cursorModel || '',
      cursorFlags: withoutModeFlags(normalizedCursorInput, CURSOR_MODE_FLAGS),
      kimiFlags: withoutModeFlags(normalizedKimiInput, KIMI_MODE_FLAGS),
      geminiFlags: normalizedGeminiInput,
      qwenMode: agentSettings.qwenMode || 'normal',
      qwenModel: agentSettings.qwenModel || '',
      qwenFlags: normalizedQwenInput.filter(flag => !flag.startsWith('--approval-mode') && flag !== '--yolo' && flag !== '-y'),
      reasonixFlags: normalizedReasonixInput,
      bbaritLanguage: normalizeBbaritAgentLanguage(agentSettings.bbaritLanguage),
      bbaritPersona: agentSettings.bbaritPersona || '',
      bbaritFlags: normalizedBbaritInput,
    };
    const persistedStt = buildSttConfig();
    // Persist all settings to config (file-backed)
    updateConfig(prev => ({
      ...prev,
      agent: persistedAgent,
      terminal: terminalSettings,
      editor: editorSettings,
      stt: persistedStt,
      operationRules: {
        activeRules: [],
        customRules: customOperationRules,
      },
    }));
    persistSttConfig(persistedStt);
    onTerminalSettingsChange?.(terminalSettings);
    onEditorSettingsChange?.(editorSettings);
    onAgentSettingsChange?.(persistedAgent);
    onClose();
  };

  const settingsTabs = [
    { id: 'projects' as const, label: t('settings.tab.projects'), title: t('settings.tab.projects'), icon: <FolderOpen size={14} /> },
    { id: 'terminal' as const, label: t('settings.tab.terminal'), title: t('settings.tab.terminal'), icon: <OctoShell size={14} /> },
    { id: 'editor' as const, label: t('settings.tab.editor'), title: t('settings.tab.editor'), icon: <OctoNote size={14} /> },
    { id: 'theme' as const, label: t('settings.tab.theme'), title: t('settings.tab.theme'), icon: <OctoSpark size={14} /> },
    { id: 'language' as const, label: t('settings.language'), title: t('settings.language'), icon: <LucideIcons.Languages size={14} /> },
    { id: 'agent' as const, label: t('settings.tab.agent'), title: t('settings.tab.agent'), icon: <OctoPlane size={14} /> },
    { id: 'broker' as const, label: t('settings.tab.broker'), title: t('settings.tab.brokerTitle'), icon: <OctoAntler size={14} /> },
    { id: 'channels' as const, label: t('settings.tab.channels'), title: t('settings.tab.channelsTitle'), icon: <LucideIcons.MessageCircle size={14} /> },
    { id: 'web-terminal' as const, label: 'Web Terminal', title: 'Web Terminal', icon: <LucideIcons.Globe2 size={14} /> },
    { id: 'integrations' as const, label: t('settings.tab.integrations'), title: t('settings.tab.integrations'), icon: <LucideIcons.Link size={14} /> },
    { id: 'shortcuts' as const, label: t('settings.tab.shortcuts'), title: t('settings.tab.shortcuts'), icon: <LucideIcons.Keyboard size={14} /> },
    { id: 'notes' as const, label: t('notes.title'), title: t('notes.title'), icon: <OctoNote size={14} /> },
    { id: 'data' as const, label: t('settings.tab.data'), title: t('settings.tab.data'), icon: <HardDrive size={14} /> },
    { id: 'cli' as const, label: 'Control CLI', title: 'Control CLI — bbarit-ctl', icon: <LucideIcons.SquareTerminal size={14} /> },
    { id: 'licenses' as const, label: t('settings.tab.about'), title: t('settings.tab.aboutTitle'), icon: <LucideIcons.Info size={14} /> },
  ];

  return (
    <div className="settings-overlay" onClick={handleCloseAndSave}>
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          '--settings-bg': currentStyle.bg,
          '--settings-text': currentStyle.text,
          '--settings-accent': currentStyle.accent,
        } as React.CSSProperties}
      >
        {/* Header */}
        <div className="settings-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <OctoGear size={16} /> {t('settings.title')}
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', marginRight: 8 }}>
            <select
              value={config.language || 'en'}
              onChange={e => updateConfig(prev => ({ ...prev, language: e.target.value } as any))}
              style={{
                background: 'transparent',
                color: 'inherit',
                border: `1px solid ${currentStyle?.accent || '#666'}`,
                borderRadius: 'var(--brutal-radius)',
                padding: '3px 8px',
                fontSize: 12,
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              <option value="en">🇺🇸 English</option>
              <option value="ko">🇰🇷 한국어</option>
              <option value="ja">🇯🇵 日本語</option>
              <option value="zh">🇨🇳 中文</option>
              <option value="fr">🇫🇷 Français</option>
              <option value="de">🇩🇪 Deutsch</option>
              <option value="it">🇮🇹 Italiano</option>
              <option value="es">🇪🇸 Español</option>
            </select>
          </div>
          <button className="modal-close-btn" onClick={handleCloseAndSave} title={`${t('common.close')} (Esc)`} aria-label="Close"><LucideIcons.X size={16} /></button>
        </div>

        <div className="settings-body">
          {/* Tabs */}
          <div className="settings-tabs" role="tablist" aria-label={t('settings.common.sectionsAria')}>
            {settingsTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                title={tab.title}
              >
                <span className="settings-tab-icon">{tab.icon}</span>
                <span className="settings-tab-label">{tab.label}</span>
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="settings-content" role="tabpanel">
          {activeTab === 'language' && (
            <div className="settings-section">
              <div className="settings-group">
                <h3>{t('settings.language')}</h3>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  {t('settings.language.desc' as any, 'Choose the app display language. Changes are saved immediately.')}
                </span>
                <div className="setting-item">
                  <label>{t('settings.language')}</label>
                  <select
                    value={config.language || 'en'}
                    onChange={e => updateConfig(prev => ({ ...prev, language: e.target.value } as any))}
                  >
                    <option value="en">English</option>
                    <option value="ko">한국어</option>
                    <option value="ja">日本語</option>
                    <option value="zh">中文</option>
                    <option value="fr">Français</option>
                    <option value="de">Deutsch</option>
                    <option value="it">Italiano</option>
                    <option value="es">Español</option>
                  </select>
                </div>
              </div>

              <div className="settings-group">
                <h3>{brokerText.language}</h3>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  {t('settings.broker.languageDesc' as any, 'Set the Broker Harness status text and briefing language.')}
                </span>
                <div className="setting-item">
                  <label>{brokerText.language}</label>
                  <select value={brokerLanguage} onChange={(e) => updateBrokerLanguage(e.target.value as 'en' | 'ko')}>
                    <option value="en">{brokerText.optionEnglish}</option>
                    <option value="ko">{brokerText.optionKorean}</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'terminal' && (
            <div className="settings-section">
              <div className="settings-group">
                <h3>{t('settings.terminal.display')}</h3>
	                <div className="setting-item">
	                  <label>{t('settings.terminal.fontSize')}</label>
	                  <input
	                    type="number"
	                    min={8}
	                    max={20}
	                    value={terminalSettings.fontSize}
	                    onChange={(e) => updateTerminalSetting('fontSize', clampTerminalFontSize(parseInt(e.target.value) || 14))}
	                  />
	                  <span className="setting-description">
	                    {t('settings.terminal.fontSize.desc')}
	                  </span>
	                </div>
                <div className="setting-item">
                  <label>{t('settings.terminal.scrollback')}</label>
                  <input
                    type="number"
                    min={500}
                    max={100000}
                    step={500}
                    value={terminalSettings.scrollback}
                    onChange={(e) => updateTerminalSetting('scrollback', parseInt(e.target.value) || 5000)}
                  />
                  <span className="setting-description">
                    {t('settings.terminal.scrollback.desc')}
                  </span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.terminal.maxTerminals')}</label>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={terminalSettings.maxTerminalsPerRow}
                    onChange={(e) => updateTerminalSetting('maxTerminalsPerRow', parseInt(e.target.value) || 3)}
                  />
                  <span className="setting-description">
                    {t('settings.terminal.maxTerminals.desc')}
                  </span>
                </div>
                <div className="setting-item toggle">
                  <label>{t('settings.terminal.showProjectName')}</label>
                  <input
                    type="checkbox"
                    checked={terminalSettings.showProjectName}
                    onChange={(e) => updateTerminalSetting('showProjectName', e.target.checked)}
                  />
                  <span className="setting-description">
                    {t('settings.terminal.showProjectName.desc')}
                  </span>
                </div>
              </div>

              <div className="settings-group">
                <h3>{t('settings.terminal.cursor')}</h3>
                <div className="setting-item">
                  <label>{t('settings.terminal.cursorShape')}</label>
                  <select
                    value={terminalSettings.cursorShape}
                    onChange={(e) => updateTerminalSetting('cursorShape', e.target.value as TerminalSettings['cursorShape'])}
                    title={t('settings.terminal.cursorShape.tooltip')}
                  >
                    <option value="bar">{t('settings.terminal.cursorShape.bar')}</option>
                    <option value="block">{t('settings.terminal.cursorShape.block')}</option>
                    <option value="underline">{t('settings.terminal.cursorShape.underline')}</option>
                  </select>
                </div>
                <div className="setting-item toggle">
                  <label>{t('settings.terminal.cursorBlink')}</label>
                  <input
                    type="checkbox"
                    checked={terminalSettings.cursorBlink}
                    onChange={(e) => updateTerminalSetting('cursorBlink', e.target.checked)}
                  />
                </div>
              </div>

              <div className="settings-group">
                <h3>{t('settings.terminal.input')}</h3>
                <div className="setting-item">
                  <label>{t('settings.terminal.inputMode')}</label>
                  <select
                    value={terminalSettings.inputMode}
                    onChange={(e) => updateTerminalSetting('inputMode', e.target.value as TerminalSettings['inputMode'])}
                    title={t('settings.terminal.inputMode.tooltip')}
                  >
                    <option value="direct">{t('settings.terminal.inputMode.direct')}</option>
                    <option value="ime">{t('settings.terminal.inputMode.ime')}</option>
                  </select>
                  <span className="setting-description">
                    {t('settings.terminal.inputMode.desc')}
                  </span>
                </div>

                {/* Windows 전용: 셸 선택 */}
                {navigator.platform?.toLowerCase().includes('win') && (
                  <div className="setting-item">
                    <label>{t('settings.terminal.shellType')}</label>
                    <select
                      value={terminalSettings.shellType || 'powershell'}
                      onChange={(e) => updateTerminalSetting('shellType', e.target.value as TerminalSettings['shellType'])}
                      title={t('settings.terminal.shellType.tooltip')}
                    >
                      <option value="powershell">PowerShell</option>
                      <option value="cmd">CMD (Command Prompt)</option>
                      <option value="gitbash">Git Bash</option>
                      <option value="wsl">WSL (Linux)</option>
                    </select>
                    <span className="setting-description">
                      {t('settings.terminal.shellType.desc')}
                    </span>
                  </div>
                )}

              </div>

              <div className="settings-group">
                <h3>{t('settings.terminal.autoSave')}</h3>
                <div className="setting-item toggle">
                  <label>{t('settings.terminal.autoSaveFiles')}</label>
                  <input
                    type="checkbox"
                    checked={terminalSettings.autoSaveFiles}
                    onChange={(e) => updateTerminalSetting('autoSaveFiles', e.target.checked)}
                  />
                  <span className="setting-description">
                    {t('settings.terminal.autoSaveFiles.desc')}
                  </span>
                </div>
                <div className="setting-item toggle">
                  <label>{t('settings.terminal.autoSaveSession')}</label>
                  <input
                    type="checkbox"
                    checked={terminalSettings.autoSaveSession}
                    onChange={(e) => updateTerminalSetting('autoSaveSession', e.target.checked)}
                  />
                  <span className="setting-description">
                    {t('settings.terminal.autoSaveSession.desc')}
                  </span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.terminal.tmuxAutoStart')}</label>
                  <input
                    type="checkbox"
                    checked={terminalSettings.tmuxAutoStart ?? false}
                    onChange={(e) => updateTerminalSetting('tmuxAutoStart', e.target.checked)}
                  />
                  <span className="setting-description">
                    {t('settings.terminal.tmuxAutoStart.desc')}
                  </span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.terminal.confirmOnClose')}</label>
                  <input
                    type="checkbox"
                    checked={terminalSettings.confirmOnClose ?? true}
                    onChange={(e) => updateTerminalSetting('confirmOnClose', e.target.checked)}
                  />
                  <span className="setting-description">
                    {t('settings.terminal.confirmOnClose.desc')}
                  </span>
                </div>
              </div>

              <div className="settings-group">
                <h3>{t('settings.terminal.quickCommands')}</h3>
                <span className="setting-description" style={{ marginBottom: 12, display: 'block' }}>
                  {t('settings.terminal.quickCommands.desc')}
                </span>
                {config.quickCommands.map((cmd, index) => {
                  const LIcon = (LucideIcons as any)[cmd.icon];
                  return (
                  <div key={cmd.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, minHeight: 36 }}>
                    <button
                      type="button"
                      onClick={() => setQcIconPickerIndex(index)}
                      style={{
                        width: 34, height: 34, minWidth: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: `${currentStyle.accent}15`, border: `1px solid ${currentStyle.accent}33`,
                        borderRadius: 'var(--brutal-radius)', cursor: 'pointer', flexShrink: 0, color: currentStyle.text,
                      }}
                      title={t('settings.terminal.quickCommands.pickIcon')}
                    >
                      {LIcon
                        ? <LIcon size={18} />
                        : <span style={{ fontSize: 18 }}>{cmd.icon || '⚡'}</span>}
                    </button>
                    <input
                      type="text"
                      placeholder={t('settings.terminal.quickCommands.placeholder')}
                      value={cmd.command}
                      onChange={(e) => {
                        const newCommands = [...config.quickCommands];
                        newCommands[index] = { ...cmd, command: e.target.value };
                        updateConfig((prev) => ({ ...prev, quickCommands: newCommands }));
                      }}
                      style={{ flex: 1, fontSize: 13, minWidth: 0, height: 32, padding: '0 8px', boxSizing: 'border-box' }}
                    />
                    <button
                      onClick={() => {
                        const newCommands = config.quickCommands.filter((_, i) => i !== index);
                        updateConfig((prev) => ({ ...prev, quickCommands: newCommands }));
                      }}
                      style={{
                        width: 26, height: 26, minWidth: 26, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'transparent', border: '1px solid #f38ba855', color: '#f38ba8',
                        borderRadius: 'var(--brutal-radius)', cursor: 'pointer', fontSize: 14, flexShrink: 0,
                      }}
                    >×</button>
                  </div>
                  );
                })}
                {qcIconPickerIndex !== null && (
                  <IconPicker
                    onSelect={(iconName) => {
                      const idx = qcIconPickerIndex;
                      const newCommands = [...config.quickCommands];
                      newCommands[idx] = { ...newCommands[idx], icon: iconName };
                      updateConfig((prev) => ({ ...prev, quickCommands: newCommands }));
                      setQcIconPickerIndex(null);
                    }}
                    onClose={() => setQcIconPickerIndex(null)}
                    style={{ bg: currentStyle.bg, text: currentStyle.text, accent: currentStyle.accent }}
                    isLightTheme={currentStyleIndex >= DARK_STYLES.length && currentStyleIndex < DARK_STYLES.length + LIGHT_STYLES.length}
                  />
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button
                    onClick={() => {
                      updateConfig((prev) => ({
                        ...prev,
                        quickCommands: [
                          ...prev.quickCommands,
                          { id: String(Date.now()), name: '', command: '', icon: 'Zap' },
                        ],
                      }));
                    }}
                    style={{
                      padding: '4px 10px', background: `${currentStyle.accent}33`,
                      border: `1px solid ${currentStyle.accent}55`, color: currentStyle.text,
                      borderRadius: 'var(--brutal-radius)', cursor: 'pointer', fontSize: 12,
                    }}
                  >{t('settings.common.add')}</button>
                  <button
                    onClick={() => {
                      updateConfig((prev) => ({
                        ...prev,
                        quickCommands: [
                          { id: '1', name: t('settings.terminal.quickCommands.rerun'), command: '!!', icon: 'RotateCcw' },
                          { id: '2', name: t('settings.terminal.quickCommands.compile'), command: 'npm run build', icon: 'Hammer' },
                          { id: '3', name: t('settings.terminal.quickCommands.doIt'), command: '', icon: 'Sparkles' },
                        ],
                      }));
                    }}
                    style={{
                      padding: '4px 10px', background: 'transparent',
                      border: `1px solid ${currentStyle.accent}33`, color: currentStyle.text,
                      borderRadius: 'var(--brutal-radius)', cursor: 'pointer', fontSize: 12,
                    }}
                  >{t('settings.common.reset')}</button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'editor' && (
            <div className="settings-section">
              <div className="settings-group">
                <h3>{t('settings.terminal.display')}</h3>
                <div className="setting-item">
                  <label>{t('settings.editor.fontSize')}</label>
                  <input
                    type="number"
                    min={10}
                    max={24}
                    value={editorSettings.fontSize}
                    onChange={(e) => updateEditorSetting('fontSize', clampEditorFontSize(parseInt(e.target.value) || 13))}
                  />
                  <span className="setting-description">
                    {t('settings.editor.fontSize.desc')}
                  </span>
                </div>
                <div className="setting-item toggle">
                  <label>{t('settings.editor.wordWrap')}</label>
                  <input
                    type="checkbox"
                    checked={editorSettings.wordWrap}
                    onChange={(e) => updateEditorSetting('wordWrap', e.target.checked)}
                  />
                </div>
                <div className="setting-item toggle">
                  <label>{t('settings.editor.minimap')}</label>
                  <input
                    type="checkbox"
                    checked={editorSettings.minimap}
                    onChange={(e) => updateEditorSetting('minimap', e.target.checked)}
                  />
                </div>
                <div className="setting-item">
                  <label>{t('settings.editor.renderWhitespace')}</label>
                  <select
                    value={editorSettings.renderWhitespace}
                    onChange={(e) => updateEditorSetting('renderWhitespace', e.target.value as EditorSettings['renderWhitespace'])}
                  >
                    <option value="none">{t('settings.common.none')}</option>
                    <option value="selection">{t('settings.common.selectionOnly')}</option>
                    <option value="all">{t('settings.common.all')}</option>
                  </select>
                </div>
              </div>

              <div className="settings-group">
                <h3>{t('settings.terminal.plugins')}</h3>
                <div className="setting-item toggle">
                  <label>{t('settings.editor.vimMode')} (monaco-vim)</label>
                  <input
                    type="checkbox"
                    checked={editorSettings.vimMode}
                    onChange={(e) => updateEditorSetting('vimMode', e.target.checked)}
                  />
                  <span className="setting-description">
                    {t('settings.editor.vimMode.desc')}
                  </span>
                </div>
                <div className="setting-item toggle">
                  <label>{t('settings.editor.emmet')} (emmet-monaco-es)</label>
                  <input
                    type="checkbox"
                    checked={editorSettings.emmet}
                    onChange={(e) => updateEditorSetting('emmet', e.target.checked)}
                  />
                  <span className="setting-description">
                    {t('settings.editor.emmet.desc')}
                  </span>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'theme' && (
            <div className="settings-section">
              <div className="settings-group">
                <h3>{t('settings.theme.projectTheme')}</h3>
                <p style={{ fontSize: '12px', marginBottom: '16px', opacity: 0.7 }}>
                  {t('settings.theme.projectTheme.desc')}
                </p>
                
                {/* Dark/Light Tabs */}
                <div className="theme-subtabs" style={{ 
                  display: 'flex', 
                  gap: '8px', 
                  marginBottom: '16px',
                  borderBottom: '1px solid color-mix(in srgb, var(--settings-accent) 20%, transparent)',
                  paddingBottom: '8px'
                }}>
                  <button
                    className={`theme-subtab ${themeSubTab === 'dark' ? 'active' : ''}`}
                    onClick={() => setThemeSubTab('dark')}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 'var(--brutal-radius)',
                      border: 'none',
                      background: themeSubTab === 'dark' 
                        ? 'color-mix(in srgb, var(--settings-accent) 25%, transparent)'
                        : 'transparent',
                      color: 'var(--settings-text)',
                      cursor: 'pointer',
                      fontSize: '13px',
                      fontWeight: themeSubTab === 'dark' ? 600 : 400,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    <span style={{ fontSize: '14px' }}>🌙</span> Dark ({DARK_STYLES.length})
                  </button>
                  <button
                    className={`theme-subtab ${themeSubTab === 'light' ? 'active' : ''}`}
                    onClick={() => setThemeSubTab('light')}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 'var(--brutal-radius)',
                      border: 'none',
                      background: themeSubTab === 'light'
                        ? 'color-mix(in srgb, var(--settings-accent) 25%, transparent)'
                        : 'transparent',
                      color: 'var(--settings-text)',
                      cursor: 'pointer',
                      fontSize: '13px',
                      fontWeight: themeSubTab === 'light' ? 600 : 400,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    <span style={{ fontSize: '14px' }}>☀️</span> Light ({LIGHT_STYLES.length})
                  </button>
                  <button
                    className={`theme-subtab ${themeSubTab === 'wacky' ? 'active' : ''}`}
                    onClick={() => setThemeSubTab('wacky')}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 'var(--brutal-radius)',
                      border: 'none',
                      background: themeSubTab === 'wacky'
                        ? 'color-mix(in srgb, var(--settings-accent) 25%, transparent)'
                        : 'transparent',
                      color: 'var(--settings-text)',
                      cursor: 'pointer',
                      fontSize: '13px',
                      fontWeight: themeSubTab === 'wacky' ? 600 : 400,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    <span style={{ fontSize: '14px' }}>🤪</span> Wacky ({WACKY_STYLES.length})
                  </button>
                </div>

                <div className="theme-grid">
                  {(themeSubTab === 'dark' ? DARK_STYLES : themeSubTab === 'light' ? LIGHT_STYLES : WACKY_STYLES).map((style, idx) => {
                    const actualIndex = themeSubTab === 'dark' 
                      ? idx 
                      : themeSubTab === 'light'
                        ? DARK_STYLES.length + idx
                        : DARK_STYLES.length + LIGHT_STYLES.length + idx;
                    return (
                      <button
                        key={`${themeSubTab}-${idx}`}
                        className={`theme-option ${currentStyleIndex === actualIndex ? 'active' : ''}`}
                        style={{
                          background: style.bg,
                          color: style.text,
                          borderColor: style.accent,
                        }}
                        onClick={() => onStyleChange?.(actualIndex)}
                        title={style.name}
                      >
                        <span className="theme-name">{style.name}</span>
                        <span className="theme-preview" style={{ background: style.accent }} />
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="settings-group">
                <h3>{t('settings.theme.font')}</h3>
                <div className="font-grid">
                  {FONTS.map((font, idx) => (
                    <button
                      key={idx}
                      className={`font-option ${currentFontIndex === idx ? 'active' : ''}`}
                      style={{ fontFamily: idx === CUSTOM_FONT_INDEX ? (customFontFamilyProp || 'monospace') : font.value }}
                      onClick={() => onFontChange?.(idx)}
                      title={`Font: ${font.name}`}
                    >
                      {font.name}
                    </button>
                  ))}
                </div>
                {currentFontIndex === CUSTOM_FONT_INDEX && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      type="text"
                      value={fontSearchQuery}
                      onChange={(e) => setFontSearchQuery(e.target.value)}
                      placeholder={t('settings.common.searchFonts')}
                      style={{
                        width: '100%',
                        padding: '6px 10px',
                        fontSize: 12,
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: '2px 2px 0 0',
                        color: 'inherit',
                        outline: 'none',
                        boxSizing: 'border-box',
                      }}
                    />
                    <div style={{
                      maxHeight: 200,
                      overflowY: 'auto',
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderTop: 'none',
                      borderRadius: '0 0 2px 2px',
                    }}>
                      {systemFonts
                        .filter((f) => !fontSearchQuery || f.toLowerCase().includes(fontSearchQuery.toLowerCase()))
                        .map((fontName) => (
                          <div
                            key={fontName}
                            onClick={() => { onCustomFontChange?.(fontName); setFontSearchQuery(''); }}
                            style={{
                              padding: '5px 10px',
                              fontSize: 12,
                              cursor: 'pointer',
                              fontFamily: `"${fontName}", monospace`,
                              background: customFontFamilyProp === fontName ? 'rgba(255,255,255,0.12)' : 'transparent',
                              borderLeft: customFontFamilyProp === fontName ? '2px solid var(--accent-color, #4fc3f7)' : '2px solid transparent',
                            }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = customFontFamilyProp === fontName ? 'rgba(255,255,255,0.12)' : 'transparent'; }}
                          >
                            {fontName}
                          </div>
                        ))}
                      {systemFonts.length === 0 && (
                        <div style={{ padding: '8px 10px', fontSize: 11, opacity: 0.5 }}>{t('settings.common.loadingFonts')}</div>
                      )}
                    </div>
                    {customFontFamilyProp && (
                      <div style={{ marginTop: 6, fontSize: 11, opacity: 0.6 }}>
                        {t('settings.common.selected')} <span style={{ fontFamily: `"${customFontFamilyProp}", monospace` }}>{customFontFamilyProp} — 가나다 ABC 123</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'projects' && (
            <div className="settings-section">
              <div className="settings-group">
                <h3>{t('settings.theme.allProjects')}</h3>
                {(!projects || projects.length === 0) ? (
                  <p style={{ fontSize: '13px', opacity: 0.6 }}>{t('settings.projects.noOpenProjects')}</p>
                ) : (
                  <div className="project-settings-list">
                    {projects.map((proj, idx) => {
                      const projStyle = STYLES[proj.styleIndex] || STYLES[0];
                      const projFont = { name: FONTS[proj.fontIndex]?.name || 'Custom', value: getEffectiveFont(proj.fontIndex, proj.customFontFamily) };
                      const isEditing = editingProjectId === proj.id;

                      return (
                        <div key={proj.id} className="project-settings-card">
                          <div className="project-settings-header">
                            <div className="project-settings-reorder">
                              <button
                                className="project-reorder-btn"
                                disabled={idx === 0}
                                onClick={() => onProjectReorder?.(idx, idx - 1)}
                                title={t('settings.common.moveUp')}
                              >
                                <svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 2L1 7h8z" fill="currentColor"/></svg>
                              </button>
                              <span className="project-settings-num">{idx + 1}</span>
                              <button
                                className="project-reorder-btn"
                                disabled={idx === (projects?.length || 0) - 1}
                                onClick={() => onProjectReorder?.(idx, idx + 1)}
                                title={t('settings.common.moveDown')}
                              >
                                <svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 8L1 3h8z" fill="currentColor"/></svg>
                              </button>
                            </div>
                            {isEditing ? (
                              <input
                                type="text"
                                className="project-settings-name-input"
                                value={editingName}
                                onChange={(e) => setEditingName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    const n = editingName.trim();
                                    if (n) onProjectUpdate?.(proj.id, { displayName: n });
                                    setEditingProjectId(null);
                                  } else if (e.key === 'Escape') {
                                    setEditingProjectId(null);
                                  }
                                }}
                                onBlur={() => {
                                  const n = editingName.trim();
                                  if (n) onProjectUpdate?.(proj.id, { displayName: n });
                                  setEditingProjectId(null);
                                }}
                                autoFocus
                              />
                            ) : (
                              <span
                                className="project-settings-name"
                                onClick={() => { setEditingProjectId(proj.id); setEditingName(proj.displayName); }}
                                title={t('settings.common.clickToRename')}
                              >
                                {proj.displayName}
                              </span>
                            )}
                          </div>
                          <div className="project-settings-path">{proj.workDir}</div>
                          <div className="project-settings-options">
                            <div className="project-settings-option">
                              <label>{t('settings.common.theme')}</label>
                              <select
                                value={proj.styleIndex}
                                onChange={(e) => onProjectUpdate?.(proj.id, { styleIndex: parseInt(e.target.value) })}
                                title={t('settings.projects.themeTooltip')}
                              >
                                {STYLES.map((s, i) => (
                                  <option key={i} value={i}>{s.name}</option>
                                ))}
                              </select>
                              <span
                                className="project-settings-color-dot"
                                style={{ background: projStyle.accent }}
                              />
                            </div>
                            <div className="project-settings-option">
                              <label>{t('settings.theme.font')}</label>
                              <select
                                value={proj.fontIndex}
                                onChange={(e) => onProjectUpdate?.(proj.id, { fontIndex: parseInt(e.target.value) })}
                                title={t('settings.projects.fontTooltip')}
                              >
                                {FONTS.map((f, i) => (
                                  <option key={i} value={i}>{f.name}</option>
                                ))}
                              </select>
                              <span className="project-settings-font-preview" style={{ fontFamily: projFont.value || 'monospace' }}>Aa</span>
                            </div>
                            {proj.fontIndex === CUSTOM_FONT_INDEX && (
                              <div className="project-settings-option" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                                <label>{t('settings.common.fontName')}</label>
                                <select
                                  value={proj.customFontFamily || ''}
                                  onChange={(e) => onProjectUpdate?.(proj.id, { customFontFamily: e.target.value })}
                                  style={{
                                    padding: '4px 8px',
                                    fontSize: 12,
                                    fontFamily: proj.customFontFamily ? `"${proj.customFontFamily}", monospace` : 'monospace',
                                    background: 'rgba(255,255,255,0.06)',
                                    border: '1px solid rgba(255,255,255,0.12)',
                                    borderRadius: 'var(--brutal-radius)',
                                    color: 'inherit',
                                  }}
                                >
                                  <option value="">-- Select font --</option>
                                  {systemFonts.map((f) => (
                                    <option key={f} value={f} style={{ fontFamily: `"${f}", monospace` }}>{f}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'broker' && (
            <div className="settings-section">
              <div className="settings-group">
                <h3>{brokerText.title}</h3>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  {brokerText.desc}
                </span>
                <div className="setting-item">
                  <label>{brokerText.developer}</label>
                  <select value={brokerDeveloper} onChange={(e) => updateBrokerRole('developer', normalizeBrokerAgentRole(e.target.value, 'claude'))}>
                    {BROKER_AGENT_OPTIONS.map(([id, label]) => (
                      <option key={id} value={id}>{label}</option>
                    ))}
                  </select>
                </div>
                <div className="setting-item">
                  <label>{brokerText.reviewer}</label>
                  <select value={brokerReviewer} onChange={(e) => updateBrokerRole('reviewer', normalizeBrokerAgentRole(e.target.value, 'codex'))}>
                    {BROKER_AGENT_OPTIONS.map(([id, label]) => (
                      <option key={id} value={id}>{label}</option>
                    ))}
                  </select>
                </div>
                <div className="setting-item">
                  <label>{brokerText.language}</label>
                  <select value={brokerLanguage} onChange={(e) => updateBrokerLanguage(e.target.value as 'en' | 'ko')}>
                    <option value="en">{brokerText.optionEnglish}</option>
                    <option value="ko">{brokerText.optionKorean}</option>
                  </select>
                </div>
                <div className="setting-item">
                  <label>{brokerText.reviewMode}</label>
                  <select value={brokerReviewMode} onChange={(e) => updateBrokerReviewMode(e.target.value as BrokerReviewMode)}>
                    <option value="off">{brokerText.reviewModeOptions.off}</option>
                    <option value="light">{brokerText.reviewModeOptions.light}</option>
                    <option value="normal">{brokerText.reviewModeOptions.normal}</option>
                    <option value="careful">{brokerText.reviewModeOptions.careful}</option>
                    <option value="very_careful">{brokerText.reviewModeOptions.very_careful}</option>
                  </select>
                </div>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  {brokerText.reviewModeDesc}
                </span>
                <div className="setting-item">
                  <label>{brokerText.browserReview}</label>
                  <input
                    type="checkbox"
                    checked={brokerBrowserReview}
                    onChange={(e) => updateBrokerBrowserReview(e.target.checked)}
                  />
                </div>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  {brokerText.browserReviewDesc}
                </span>
                {brokerDeveloper === brokerReviewer && (
                  <span className="setting-description" style={{ color: 'color-mix(in srgb, #f38ba8 75%, var(--settings-text) 25%)' }}>
                    {brokerText.sameAgentWarning}
                  </span>
                )}
              </div>
            </div>
          )}
          {activeTab === 'agent' && (
            <div className="settings-section">
              {/* ---- Claude Code ---- */}
              <div className="settings-group">
                <h3>Claude Code</h3>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  {t('settings.agent.claude.desc')}
                </span>
                <div className="setting-item">
                  <label>{t('settings.agent.claudeMode')}</label>
                  <select
                    value={agentSettings.claudeMode}
                    onChange={(e) => {
                      const mode = e.target.value as AgentSettings['claudeMode'];
                      setAgentSettings(prev => {
                        const extra = withoutModeFlags(prev.claudeFlags || [], CLAUDE_MODE_FLAGS);
                        return { ...prev, claudeMode: mode, claudeFlags: extra };
                      });
                    }}
                  >
                    <option value="normal">normal</option>
                    <option value="auto-accept">--auto-accept</option>
                    <option value="bypass-permissions">--dangerously-skip-permissions (default)</option>
                  </select>
                </div>
                <div className="setting-item toggle">
                  <label>{t('settings.agent.resumeLastSession')}</label>
                  <input type="checkbox" checked={agentSettings.resumeLastSession ?? false} onChange={(e) => setAgentSettings(prev => ({ ...prev, resumeLastSession: e.target.checked }))} />
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.claudeModel')}</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select
                      value={getModelsForCliType('claude').some(m => m.value === agentSettings.claudeModel) ? agentSettings.claudeModel : '__custom__'}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === '__custom__') return;
                        setAgentSettings(prev => ({ ...prev, claudeModel: v }));
                      }}
                      style={{ width: 'auto', flex: '0 0 auto' }}
                    >
                      {getModelsForCliType('claude').map((m, i) => (
                        <option key={`${m.value}-${i}`} value={m.value}>{m.label}</option>
                      ))}
                      {agentSettings.claudeModel && !getModelsForCliType('claude').some(m => m.value === agentSettings.claudeModel) && (
                        <option value="__custom__">{t('settings.common.custom')}</option>
                      )}
                    </select>
                    <input
                      type="text"
                      value={agentSettings.claudeModel}
                      onChange={(e) => setAgentSettings(prev => ({ ...prev, claudeModel: e.target.value }))}
                      placeholder={t('settings.agent.cli.customModelPlaceholder').replace('{model}', 'claude-sonnet-4-20250514')}
                      style={{ flex: 1, width: 'auto', minWidth: 0, fontSize: 12 }}
                    />
                  </div>
                  <span className="setting-description">{t('settings.agent.cli.defaultModelDesc')}</span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.cli.fullSettingsFile')}</label>
                  <button
                    type="button"
                    className="settings-open-file-btn"
                    onClick={async () => {
                      try {
                        const home = await invoke<string>('get_home_dir');
                        const dir = `${home}/.claude`;
                        // Create folder/file if not exists
                        try { await invoke<string>('read_file', { path: `${dir}/settings.json` }); } catch {
                          await invoke('create_directory', { path: dir });
                          await invoke('write_file', { path: `${dir}/settings.json`, content: '{\n  \n}\n' });
                        }
                        await openFolderPath(dir);
                      } catch (err) { console.error('Failed to open Claude settings folder:', err); }
                    }}
                  >
                    {t('settings.agent.cli.openFolder').replace('{path}', '~/.claude')}
                  </button>
                  <span className="setting-description">{t('settings.agent.cli.openSettingsFolderDesc')}</span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.cli.additionalOptions')}</label>
                  <textarea
                    className="settings-textarea"
                    value={claudeFlagsInput}
                    onChange={(e) => setClaudeFlagsInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        const normalized = normalizeFlagsText(e.currentTarget.value);
                        setClaudeFlagsInput(normalized);
                        updateFlags('claude', normalized);
                      }
                    }}
                    onBlur={(e) => {
                      const normalized = normalizeFlagsText(e.currentTarget.value);
                      setClaudeFlagsInput(normalized);
                      updateFlags('claude', normalized);
                    }}
                    placeholder={'--verbose'}
                  />
                  <span className="setting-description">{t('settings.agent.cli.optionsHint')}</span>
                </div>
              </div>

              {/* ---- Codex ---- */}
              <div className="settings-group">
                <h3>Codex</h3>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  {t('settings.agent.codex.desc')}
                </span>
                <div className="setting-item">
                  <label>{t('settings.agent.codexMode')}</label>
                  <select
                    value={agentSettings.codexMode}
                    onChange={(e) => {
                      const mode = e.target.value as AgentSettings['codexMode'];
                      setAgentSettings(prev => {
                        const extra = withoutModeFlags(prev.codexFlags || [], CODEX_MODE_FLAGS);
                        return { ...prev, codexMode: mode, codexFlags: extra };
                      });
                    }}
                  >
                    <option value="normal">normal</option>
                    <option value="auto-edit">auto-edit</option>
                    <option value="full-auto">--full-auto</option>
                    <option value="yolo">yolo (default, dangerous bypass)</option>
                  </select>
                </div>
                <div className="setting-item toggle">
                  <label>{t('settings.agent.resumeLastSession')}</label>
                  <input type="checkbox" checked={agentSettings.resumeLastSession ?? false} onChange={(e) => setAgentSettings(prev => ({ ...prev, resumeLastSession: e.target.checked }))} />
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.codexModel')}</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select
                      value={getModelsForCliType('codex').some(m => m.value === agentSettings.codexModel) ? agentSettings.codexModel : '__custom__'}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === '__custom__') return;
                        setAgentSettings(prev => ({ ...prev, codexModel: v }));
                      }}
                      style={{ width: 'auto', flex: '0 0 auto' }}
                    >
                      {getModelsForCliType('codex').map((m, i) => (
                        <option key={`${m.value}-${i}`} value={m.value}>{m.label}</option>
                      ))}
                      {agentSettings.codexModel && !getModelsForCliType('codex').some(m => m.value === agentSettings.codexModel) && (
                        <option value="__custom__">{t('settings.common.custom')}</option>
                      )}
                    </select>
                    <input
                      type="text"
                      value={agentSettings.codexModel}
                      onChange={(e) => setAgentSettings(prev => ({ ...prev, codexModel: e.target.value }))}
                      placeholder={t('settings.agent.cli.customModelPlaceholder').replace('{model}', 'o3')}
                      style={{ flex: 1, width: 'auto', minWidth: 0, fontSize: 12 }}
                    />
                  </div>
                  <span className="setting-description">{t('settings.agent.cli.defaultModelDesc')}</span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.cli.fullSettingsFile')}</label>
                  <button
                    type="button"
                    className="settings-open-file-btn"
                    onClick={async () => {
                      try {
                        const home = await invoke<string>('get_home_dir');
                        const dir = `${home}/.codex`;
                        try { await invoke<string>('read_file', { path: `${dir}/config.toml` }); } catch {
                          await invoke('create_directory', { path: dir });
                          await invoke('write_file', { path: `${dir}/config.toml`, content: '# Codex CLI config\n\n' });
                        }
                        await openFolderPath(dir);
                      } catch (err) { console.error('Failed to open Codex config folder:', err); }
                    }}
                  >
                    {t('settings.agent.cli.openFolder').replace('{path}', '~/.codex')}
                  </button>
                  <span className="setting-description">{t('settings.agent.cli.openSettingsFolderDesc')}</span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.cli.additionalOptions')}</label>
                  <textarea
                    className="settings-textarea"
                    value={codexFlagsInput}
                    onChange={(e) => setCodexFlagsInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        const normalized = normalizeFlagsText(e.currentTarget.value);
                        setCodexFlagsInput(normalized);
                        updateFlags('codex', normalized);
                      }
                    }}
                    onBlur={(e) => {
                      const normalized = normalizeFlagsText(e.currentTarget.value);
                      setCodexFlagsInput(normalized);
                      updateFlags('codex', normalized);
                    }}
                    placeholder={'--verbose'}
                  />
                  <span className="setting-description">{t('settings.agent.cli.optionsHint')}</span>
                </div>
              </div>

              {/* ---- Cursor Agent ---- */}
              <div className="settings-group">
                <h3>Cursor Agent</h3>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  {t('settings.agent.cursor.requires')}
                </span>
                <div className="setting-item">
                  <label>{t('settings.agent.cursorMode')}</label>
                  <select
                    value={agentSettings.cursorMode || 'normal'}
                    onChange={(e) => {
                      const mode = e.target.value as AgentSettings['cursorMode'];
                      setAgentSettings(prev => ({
                        ...prev,
                        cursorMode: mode,
                        cursorFlags: withoutModeFlags(prev.cursorFlags || [], CURSOR_MODE_FLAGS),
                      }));
                    }}
                  >
                    <option value="normal">normal</option>
                    <option value="force">--force</option>
                  </select>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.cursorModel')}</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select
                      value={getModelsForCliType('cursor').some(m => m.value === agentSettings.cursorModel) ? agentSettings.cursorModel : '__custom__'}
                      onChange={(e) => {
                        const v = e.target.value === '__custom__' ? (agentSettings.cursorModel || '') : e.target.value;
                        setAgentSettings(prev => ({ ...prev, cursorModel: v }));
                      }}
                    >
                      {getModelsForCliType('cursor').map((m, i) => (
                        <option key={i} value={m.value}>{m.label}</option>
                      ))}
                      {agentSettings.cursorModel && !getModelsForCliType('cursor').some(m => m.value === agentSettings.cursorModel) && (
                        <option value="__custom__">{t('settings.common.custom')}</option>
                      )}
                    </select>
                    <input
                      type="text"
                      value={agentSettings.cursorModel || ''}
                      onChange={(e) => setAgentSettings(prev => ({ ...prev, cursorModel: e.target.value }))}
                      placeholder={t('settings.agent.cli.customModelPlaceholder').replace('{model}', 'gpt-5')}
                      style={{ flex: 1, width: 'auto', minWidth: 0, fontSize: 12 }}
                    />
                  </div>
                  <span className="setting-description">{t('settings.agent.cli.defaultModelDesc')}</span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.cli.fullSettingsFolder')}</label>
                  <button
                    type="button"
                    className="settings-open-file-btn"
                    onClick={async () => {
                      try {
                        const home = await invoke<string>('get_home_dir');
                        const dir = `${home}/.cursor`;
                        await invoke('create_directory', { path: dir }).catch(() => {});
                        await openFolderPath(dir);
                      } catch (err) { console.error('Failed to open Cursor settings folder:', err); }
                    }}
                  >
                    {t('settings.agent.cli.openFolder').replace('{path}', '~/.cursor')}
                  </button>
                  <span className="setting-description">{t('settings.agent.cli.openSettingsFolderDesc')}</span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.cli.additionalOptions')}</label>
                  <textarea
                    className="settings-textarea"
                    value={cursorFlagsInput}
                    onChange={(e) => setCursorFlagsInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        const normalized = normalizeFlagsText(e.currentTarget.value);
                        setCursorFlagsInput(normalized);
                        updateFlags('cursor', normalized);
                      }
                    }}
                    onBlur={(e) => {
                      const normalized = normalizeFlagsText(e.currentTarget.value);
                      setCursorFlagsInput(normalized);
                      updateFlags('cursor', normalized);
                    }}
                    placeholder={'--fullscreen'}
                  />
                  <span className="setting-description">{t('settings.agent.cursorNoForce')}</span>
                </div>
              </div>

              {/* ---- Kimi ---- */}
              <div className="settings-group">
                <h3>Kimi</h3>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  {t('settings.agent.kimi.desc')}
                </span>
                <div className="setting-item">
                  <label>{t('settings.agent.kimiMode')}</label>
                  <select
                    value={agentSettings.kimiMode}
                    onChange={(e) => {
                      const mode = e.target.value as AgentSettings['kimiMode'];
                      setAgentSettings(prev => {
                        const extra = withoutModeFlags(prev.kimiFlags || [], KIMI_MODE_FLAGS);
                        return { ...prev, kimiMode: mode, kimiFlags: extra };
                      });
                    }}
                  >
                    <option value="normal">normal</option>
                    <option value="yolo">--yolo (default)</option>
                  </select>
                </div>
                <div className="setting-item toggle">
                  <label>{t('settings.agent.resumeLastSession')}</label>
                  <input type="checkbox" checked={agentSettings.resumeLastSession ?? false} onChange={(e) => setAgentSettings(prev => ({ ...prev, resumeLastSession: e.target.checked }))} />
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.cli.additionalOptions')}</label>
                  <textarea
                    className="settings-textarea"
                    value={kimiFlagsInput}
                    onChange={(e) => setKimiFlagsInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        const normalized = normalizeFlagsText(e.currentTarget.value);
                        setKimiFlagsInput(normalized);
                        updateFlags('kimi', normalized);
                      }
                    }}
                    onBlur={(e) => {
                      const normalized = normalizeFlagsText(e.currentTarget.value);
                      setKimiFlagsInput(normalized);
                      updateFlags('kimi', normalized);
                    }}
                    placeholder={'--model k2.5'}
                  />
                  <span className="setting-description">{t('settings.agent.cli.optionsHint')}</span>
                </div>
              </div>

              {/* ---- Gemini ---- */}
              <div className="settings-group">
                <h3>Gemini</h3>
                <div className="setting-item">
                  <label>{t('settings.agent.geminiModel')}</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select
                      value={getModelsForCliType('gemini').some(m => m.value === agentSettings.geminiModel) ? agentSettings.geminiModel : '__custom__'}
                      onChange={(e) => {
                        const v = e.target.value === '__custom__' ? (agentSettings.geminiModel || '') : e.target.value;
                        setAgentSettings(prev => ({ ...prev, geminiModel: v }));
                      }}
                    >
                      {getModelsForCliType('gemini').map((m, i) => (
                        <option key={i} value={m.value}>{m.label}</option>
                      ))}
                      {agentSettings.geminiModel && !getModelsForCliType('gemini').some(m => m.value === agentSettings.geminiModel) && (
                        <option value="__custom__">{t('settings.common.custom')}</option>
                      )}
                    </select>
                    <input
                      type="text"
                      value={agentSettings.geminiModel}
                      onChange={(e) => setAgentSettings(prev => ({ ...prev, geminiModel: e.target.value }))}
                      placeholder={t('settings.agent.cli.customModelPlaceholder').replace('{model}', 'gemini-2.5-pro')}
                      style={{ flex: 1, width: 'auto', minWidth: 0, fontSize: 12 }}
                    />
                  </div>
                  <span className="setting-description">{t('settings.agent.cli.defaultModelDesc')}</span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.cli.additionalOptions')}</label>
                  <textarea
                    className="settings-textarea"
                    value={geminiFlagsInput}
                    onChange={(e) => setGeminiFlagsInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        const normalized = normalizeFlagsText(e.currentTarget.value);
                        setGeminiFlagsInput(normalized);
                        updateFlags('gemini', normalized);
                      }
                    }}
                    onBlur={(e) => {
                      const normalized = normalizeFlagsText(e.currentTarget.value);
                      setGeminiFlagsInput(normalized);
                      updateFlags('gemini', normalized);
                    }}
                    placeholder={'--sandbox'}
                  />
                  <span className="setting-description">{t('settings.agent.cli.optionsHint')}</span>
                </div>
              </div>

              {/* ---- Qwen Code ---- */}
              <div className="settings-group">
                <h3>Qwen Code</h3>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  {t('settings.agent.qwen.requires')}
                </span>
                <div className="setting-item">
                  <label>{t('settings.agent.qwenMode')}</label>
                  <select
                    value={agentSettings.qwenMode || 'normal'}
                    onChange={(e) => {
                      const mode = e.target.value as AgentSettings['qwenMode'];
                      setAgentSettings(prev => ({
                        ...prev,
                        qwenMode: mode,
                        qwenFlags: (prev.qwenFlags || []).filter(flag => !flag.startsWith('--approval-mode') && flag !== '--yolo' && flag !== '-y'),
                      }));
                    }}
                  >
                    <option value="normal">normal</option>
                    <option value="yolo">--approval-mode=yolo</option>
                  </select>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.qwenModel')}</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select
                      value={getModelsForCliType('qwen').some(m => m.value === agentSettings.qwenModel) ? agentSettings.qwenModel : '__custom__'}
                      onChange={(e) => {
                        const v = e.target.value === '__custom__' ? (agentSettings.qwenModel || '') : e.target.value;
                        setAgentSettings(prev => ({ ...prev, qwenModel: v }));
                      }}
                    >
                      {getModelsForCliType('qwen').map((m, i) => (
                        <option key={i} value={m.value}>{m.label}</option>
                      ))}
                      {agentSettings.qwenModel && !getModelsForCliType('qwen').some(m => m.value === agentSettings.qwenModel) && (
                        <option value="__custom__">{t('settings.common.custom')}</option>
                      )}
                    </select>
                    <input
                      type="text"
                      value={agentSettings.qwenModel || ''}
                      onChange={(e) => setAgentSettings(prev => ({ ...prev, qwenModel: e.target.value }))}
                      placeholder={t('settings.agent.cli.customModelPlaceholder').replace('{model}', 'qwen3.6-plus')}
                      style={{ flex: 1, width: 'auto', minWidth: 0, fontSize: 12 }}
                    />
                  </div>
                  <span className="setting-description">{t('settings.agent.cli.defaultModelDesc')}</span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.cli.fullSettingsFile')}</label>
                  <button
                    type="button"
                    className="settings-open-file-btn"
                    onClick={async () => {
                      try {
                        const home = await invoke<string>('get_home_dir');
                        const dir = `${home}/.qwen`;
                        try { await invoke<string>('read_file', { path: `${dir}/settings.json` }); } catch {
                          await invoke('create_directory', { path: dir });
                          await invoke('write_file', { path: `${dir}/settings.json`, content: '{\n  \n}\n' });
                        }
                        await openFolderPath(dir);
                      } catch (err) { console.error('Failed to open Qwen settings folder:', err); }
                    }}
                  >
                    {t('settings.agent.cli.openFolder').replace('{path}', '~/.qwen')}
                  </button>
                  <span className="setting-description">{t('settings.agent.cli.openSettingsFolderDesc')}</span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.cli.additionalOptions')}</label>
                  <textarea
                    className="settings-textarea"
                    value={qwenFlagsInput}
                    onChange={(e) => setQwenFlagsInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        const normalized = normalizeFlagsText(e.currentTarget.value);
                        setQwenFlagsInput(normalized);
                        updateFlags('qwen', normalized);
                      }
                    }}
                    onBlur={(e) => {
                      const normalized = normalizeFlagsText(e.currentTarget.value);
                      setQwenFlagsInput(normalized);
                      updateFlags('qwen', normalized);
                    }}
                    placeholder={'--debug'}
                  />
                  <span className="setting-description">{t('settings.agent.qwenNoApprovalMode')}</span>
                </div>
              </div>
              <div className="settings-group">
                <h3>Reasonix</h3>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  Starts with <code>reasonix code</code>. If the binary is missing, BBARIT tries <code>npx -y reasonix@latest code</code>.
                </span>
                <div className="setting-item">
                  <label>{t('settings.agent.cli.additionalOptions')}</label>
                  <textarea
                    className="settings-textarea"
                    value={reasonixFlagsInput}
                    onChange={(e) => setReasonixFlagsInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        const normalized = normalizeFlagsText(e.currentTarget.value);
                        setReasonixFlagsInput(normalized);
                        updateFlags('reasonix', normalized);
                      }
                    }}
                    onBlur={(e) => {
                      const normalized = normalizeFlagsText(e.currentTarget.value);
                      setReasonixFlagsInput(normalized);
                      updateFlags('reasonix', normalized);
                    }}
                    placeholder={'--help'}
                  />
                  <span className="setting-description">{t('settings.agent.cli.optionsHint')}</span>
                </div>
              </div>
              <div className="settings-group">
                <h3>BBARIT Agent</h3>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  {t('settings.agent.bbaritDescription' as any, 'Our internal coding agent, bundled inside the app. Launches in the project folder (no setup required).')}
                </span>
                <div className="setting-item">
                  <label>{t('settings.agent.bbaritLanguage' as any, 'Response language')}</label>
                  <select
                    value={normalizeBbaritAgentLanguage(agentSettings.bbaritLanguage)}
                    onChange={(e) => setAgentSettings(prev => ({ ...prev, bbaritLanguage: normalizeBbaritAgentLanguage(e.currentTarget.value) as BbaritAgentLanguage }))}
                  >
                    <option value="ko">{t('settings.agent.bbaritLanguage.ko' as any, 'Korean')}</option>
                    <option value="en">{t('settings.agent.bbaritLanguage.en' as any, 'English')}</option>
                    <option value="ja">{t('settings.agent.bbaritLanguage.ja' as any, 'Japanese')}</option>
                    <option value="zh">{t('settings.agent.bbaritLanguage.zh' as any, 'Chinese')}</option>
                    <option value="auto">{t('settings.agent.bbaritLanguage.auto' as any, 'Auto')}</option>
                  </select>
                  <span className="setting-description">
                    {t('settings.agent.bbaritLanguage.desc' as any, 'Keeps BBARIT Agent replies in the selected language even when logs or quoted text use another language.')}
                  </span>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.bbaritPersona' as any, 'Default persona')}</label>
                  <button
                    className="bbarit-persona-picker-open"
                    onClick={() => setBbaritPersonaPickerOpen(true)}
                  >
                    {t('settings.agent.bbaritPersona.choose' as any, 'Choose persona…')}
                  </button>
                  {renderBbaritPersonaPreview()}
                  {bbaritPersonaPickerOpen && (
                    <BbaritPersonaPickerModal
                      personas={bbaritPersonas}
                      selectedId={agentSettings.bbaritPersona || ''}
                      onSelect={(id) => {
                        setAgentSettings(prev => ({ ...prev, bbaritPersona: id }));
                        setBbaritPersonaPickerOpen(false);
                      }}
                      onClose={() => setBbaritPersonaPickerOpen(false)}
                      title={t('settings.agent.bbaritPersona' as any, 'Default persona')}
                    />
                  )}
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.cli.additionalOptions')}</label>
                  <textarea
                    className="settings-textarea"
                    value={bbaritFlagsInput}
                    onChange={(e) => setBbaritFlagsInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        const normalized = normalizeFlagsText(e.currentTarget.value);
                        setBbaritFlagsInput(normalized);
                        updateFlags('bbarit', normalized);
                      }
                    }}
                    onBlur={(e) => {
                      const normalized = normalizeFlagsText(e.currentTarget.value);
                      setBbaritFlagsInput(normalized);
                      updateFlags('bbarit', normalized);
                    }}
                    placeholder={'--help'}
                  />
                  <span className="setting-description">{t('settings.agent.cli.optionsHint')}</span>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'agent' && (
            <div className="settings-section">
              <div className="settings-group">
                <h3>Ollama</h3>
                <div className="setting-item">
                  <label>{t('settings.common.serverUrl')}</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      value={ollamaUrl}
                      onChange={(e) => setOllamaUrl(e.target.value)}
                      placeholder="http://localhost:11434"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={() => { void fetchOllamaModels(ollamaUrl.trim()); }}
                      disabled={ollamaStatus === 'loading'}
                      title={t('settings.agent.ollama.testTooltip')}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 'var(--brutal-radius)',
                        border: `1px solid color-mix(in srgb, var(--settings-accent) 50%, transparent)`,
                        background: `color-mix(in srgb, var(--settings-accent) 22%, transparent)`,
                        color: 'var(--settings-text)',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {ollamaStatus === 'loading' ? t('settings.common.testing') : t('settings.common.testConnection')}
                    </button>
                  </div>
                  <span className="setting-description">
                    {t('settings.common.status')}:{' '}
                    <strong style={{
                      color: ollamaStatus === 'connected'
                        ? 'color-mix(in srgb, #22c55e 80%, var(--settings-text) 20%)'
                        : ollamaStatus === 'error'
                          ? 'color-mix(in srgb, #ef4444 75%, var(--settings-text) 25%)'
                          : ollamaStatus === 'loading'
                            ? 'color-mix(in srgb, #eab308 75%, var(--settings-text) 25%)'
                            : 'inherit'
                    }}>
                      {ollamaStatus === 'connected' ? t('settings.agent.ollama.connectedModels').replace('{count}', String(ollamaModels.length)) :
                       ollamaStatus === 'error' ? t('settings.common.connectionFailed') :
                       ollamaStatus === 'loading' ? t('settings.common.connecting') : t('settings.common.notTested')}
                    </strong>
                  </span>
                  {ollamaError && (
                    <span className="setting-description" style={{ color: 'color-mix(in srgb, #ef4444 75%, var(--settings-text) 25%)' }}>
                      {ollamaError}
                    </span>
                  )}
                </div>
                {ollamaModels.length > 0 && (
                  <div className="setting-item">
                    <label>{t('settings.common.model')}</label>
                    <select
                      value={ollamaModel}
                      onChange={(e) => setOllamaModel(e.target.value)}
                      title={t('settings.agent.ollama.selectTooltip')}
                    >
                      <option value="">{t('settings.agent.ollama.selectModel')}</option>
                      {ollamaModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                    <span className="setting-description">
                      {t('settings.agent.ollama.modelDesc')}
                    </span>
                  </div>
                )}
              </div>
                <div className="settings-group">
                  <h3>{t('settings.agent.behavior')}</h3>
                  <div className="setting-item toggle">
                    <label>{t('settings.agent.playSoundWhenDone')}</label>
                    <input
                      type="checkbox"
                      checked={agentSettings.playSoundWhenDone}
                      onChange={(e) => setAgentSettings(prev => ({ ...prev, playSoundWhenDone: e.target.checked }))}
                    />
                    <button
                      type="button"
                      onClick={playTestSound}
                      title={t('settings.agent.behavior.sound.title')}
                      style={{
                        marginLeft: 10,
                        padding: '6px 10px',
                        borderRadius: 'var(--brutal-radius)',
                        border: `1px solid color-mix(in srgb, var(--settings-accent) 40%, transparent)`,
                        background: `color-mix(in srgb, var(--settings-accent) 16%, transparent)`,
                        color: 'var(--settings-text)',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {t('settings.agent.behavior.sound.test')}
                    </button>
                  </div>
                  <div className="setting-item toggle">
                    <label>{t('settings.agent.osNotifySound')}</label>
                    <input
                      type="checkbox"
                      checked={agentSettings.playOsNotifySound !== false}
                      onChange={(e) => setAgentSettings(prev => ({ ...prev, playOsNotifySound: e.target.checked }))}
                    />
                    <select
                      value={agentSettings.osNotifySoundName || 'Glass'}
                      onChange={(e) => setAgentSettings(prev => ({ ...prev, osNotifySoundName: e.target.value }))}
                      disabled={agentSettings.playOsNotifySound === false}
                      title={t('settings.agent.osNotifySound.macTitle')}
                      style={{
                        marginLeft: 10,
                        padding: '5px 8px',
                        borderRadius: 'var(--brutal-radius)',
                        background: 'color-mix(in srgb, var(--settings-accent) 8%, transparent)',
                        color: 'var(--settings-text)',
                        border: `1px solid color-mix(in srgb, var(--settings-accent) 30%, transparent)`,
                        fontSize: 12,
                        opacity: agentSettings.playOsNotifySound === false ? 0.5 : 1,
                      }}
                    >
                      {MAC_NOTIFY_SOUNDS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <button
                      type="button"
                      onClick={() => { void playTestOsSound(); }}
                      title={t('settings.agent.soundPreviewTitle')}
                      style={{
                        marginLeft: 8,
                        padding: '6px 10px',
                        borderRadius: 'var(--brutal-radius)',
                        border: `1px solid color-mix(in srgb, var(--settings-accent) 40%, transparent)`,
                        background: `color-mix(in srgb, var(--settings-accent) 16%, transparent)`,
                        color: 'var(--settings-text)',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {t('settings.agent.behavior.sound.test')}
                    </button>
                  </div>
                  <div className="setting-item">
                    <span className="setting-description">{t('settings.agent.osNotifySound.desc')}</span>
                  </div>
                  <div className="setting-item toggle">
                    <label>{t('settings.agent.useModifierToSend')}</label>
                    <input
                      type="checkbox"
                    checked={agentSettings.useModifierToSend}
                    onChange={(e) => setAgentSettings(prev => ({ ...prev, useModifierToSend: e.target.checked }))}
                  />
                  <span className="setting-description">{t('settings.agent.behavior.modifier.desc')}</span>
                </div>
              </div>
              <div className="settings-group">
                <h3>{t('settings.agent.operationRules')}</h3>
                <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                  {t('settings.agent.operationRules.desc')}
                </span>
                <div style={{ marginTop: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>{t('settings.agent.operationRules.custom')}</label>
                  <textarea
                    value={customOperationRules}
                    onChange={(e) => setCustomOperationRules(e.target.value)}
                    placeholder={t('settings.agent.operationRules.placeholder')}
                    style={{
                      width: '100%',
                      minHeight: 80,
                      padding: '8px 10px',
                      borderRadius: 'var(--brutal-radius)',
                      border: '1px solid color-mix(in srgb, var(--settings-text) 12%, transparent)',
                      background: 'color-mix(in srgb, var(--settings-bg) 80%, #000 20%)',
                      color: 'var(--settings-text)',
                      fontSize: 12,
                      fontFamily: "'SF Mono', 'Fira Code', monospace",
                      lineHeight: 1.5,
                      resize: 'vertical',
                      outline: 'none',
                    }}
                  />
                </div>
              </div>

            </div>
          )}

          {activeTab === 'keys' && (
            <div className="settings-section">
              <div className="settings-group">
                <h3>Atlas Cloud</h3>
                <span className="setting-description" style={{ marginBottom: 8, display: 'block' }}>
                  {t('settings.agent.atlasDesc')}
                </span>
                <div className="setting-item">
                  <label>
                    {t('settings.agent.atlas.apiKeyLabel')}{' '}
                    <strong style={{ color: atlasKeyConfigured ? 'color-mix(in srgb, #22c55e 80%, var(--settings-text) 20%)' : 'color-mix(in srgb, #ef4444 75%, var(--settings-text) 25%)' }}>
                      {atlasKeyConfigured ? t('settings.common.configured') : t('settings.common.notConfigured')}
                    </strong>
                  </label>
                  <input
                    type={atlasKeyShow ? 'text' : 'password'}
                    value={atlasApiKey}
                    placeholder={atlasKeyConfigured ? t('settings.common.configuredPlaceholder') : t('settings.agent.atlas.pasteKey')}
                    onChange={(e) => setAtlasApiKey(e.target.value)}
                  />
                </div>
                <div className="setting-item">
                  <label>{t('settings.common.baseUrl')}</label>
                  <input value={atlasBaseUrl} onChange={(e) => setAtlasBaseUrl(e.target.value)} placeholder={ATLASCLOUD_DEFAULT_BASE_URL} />
                </div>
                <div className="setting-item">
                  <label>{t('settings.common.model')}</label>
                  <input value={atlasModel} onChange={(e) => setAtlasModel(e.target.value)} placeholder={ATLASCLOUD_DEFAULT_MODEL} />
                </div>
                <div className="settings-button-row">
                  <button
                    type="button"
                    className="btn-toolbar"
                    onClick={() => {
                      setAtlasKeyShow((v) => {
                        const next = !v;
                        if (next && atlasKeyConfigured && !atlasApiKey.trim()) {
                          kvGet(ATLASCLOUD_KV_KEYS.apiKey).then(saved => {
                            if ((saved || '').trim()) setAtlasApiKey((saved || '').trim());
                          }).catch(() => {});
                        }
                        if (!next) setAtlasApiKey('');
                        return next;
                      });
                    }}
                  >
                    {atlasKeyShow ? t('settings.common.hide') : t('settings.common.show')}
                  </button>
                  <button type="button" className="btn-toolbar" onClick={() => { void saveAtlasCloudKey(); }} disabled={!atlasApiKey.trim()}>
                    {t('common.save')}
                  </button>
                  <button type="button" className="btn-toolbar danger" onClick={() => { void clearAtlasCloudKey(); }} disabled={!atlasKeyConfigured}>
                    {t('common.reset')}
                  </button>
                </div>
                {atlasKeyMsg && <span className="setting-description">{atlasKeyMsg}</span>}
              </div>

              <div className="settings-group">
                <h3>{t('settings.agent.designApi.title')}</h3>
                <span className="setting-description" style={{ marginBottom: 8, display: 'block' }}>
                  {t('settings.agent.designApi.desc')}
                </span>
                <div className="setting-item">
                  <label>
                    {t('settings.agent.designApi.envKeyLabel')}{' '}
                    <strong style={{ color: mediaEnvKeyConfigured ? 'color-mix(in srgb, #22c55e 80%, var(--settings-text) 20%)' : 'color-mix(in srgb, #ef4444 75%, var(--settings-text) 25%)' }}>
                      {mediaEnvKeyConfigured ? t('settings.common.configured') : t('settings.common.notConfigured')}
                    </strong>
                  </label>
                  <input
                    type="text"
                    value={mediaEnvKeyName}
                    list="media-api-key-presets"
                    onChange={(e) => {
                      setMediaEnvKeyName(normalizeEnvKeyName(e.target.value));
                      setMediaEnvKeyMsg(null);
                    }}
                    placeholder="MAKEKE_MEDIA_API_KEY"
                  />
                  <datalist id="media-api-key-presets">
                    <option value="MAKEKE_MEDIA_API_KEY" />
                    <option value="ATLAS_CLOUD_API_KEY" />
                    <option value="RUNWAY_API_KEY" />
                    <option value="KLING_API_KEY" />
                    <option value="VEO_API_KEY" />
                  </datalist>
                </div>
                <div className="setting-item">
                  <label>{t('settings.agent.designApi.keyValue')}</label>
                  <input
                    type={mediaEnvKeyShow ? 'text' : 'password'}
                    value={mediaEnvKeyValue}
                    placeholder={mediaEnvKeyConfigured ? t('settings.common.configuredPlaceholder') : t('settings.agent.designApi.pasteKey')}
                    onChange={(e) => setMediaEnvKeyValue(e.target.value)}
                  />
                  <div className="settings-button-row">
                    <button
                      type="button"
                      className="btn-toolbar"
                      onClick={() => {
                        setMediaEnvKeyShow((v) => {
                          const next = !v;
                          if (next) void refreshMediaEnvKey(mediaEnvKeyName);
                          else setMediaEnvKeyValue('');
                          return next;
                        });
                      }}
                    >
                      {mediaEnvKeyShow ? t('settings.common.hide') : t('settings.common.show')}
                    </button>
                    <button type="button" className="btn-toolbar" onClick={() => { void saveMediaEnvKey(); }} disabled={!mediaEnvKeyValue.trim()}>
                      {t('common.save')}
                    </button>
                    <button type="button" className="btn-toolbar danger" onClick={() => { void clearMediaEnvKey(); }} disabled={!mediaEnvKeyConfigured}>
                      {t('common.reset')}
                    </button>
                    <button type="button" className="btn-toolbar" onClick={() => { void refreshMediaEnvKey(mediaEnvKeyName); }}>
                      {t('settings.common.refresh')}
                    </button>
                  </div>
                  {mediaEnvKeyMsg && <span className="setting-description">{mediaEnvKeyMsg}</span>}
                </div>
              </div>

            </div>
          )}

          {activeTab === 'shortcuts' && (
            <div className="settings-section">
              <div className="settings-group">
                <h3>{t('settings.shortcuts.preset')}</h3>
                <p className="shortcut-note">{t('settings.shortcuts.desc')}</p>
                <div className="kb-preset-row">
                  <button type="button" className={`kb-preset-btn ${keybindingPreset === 'default' ? 'active' : ''}`} onClick={() => setPreset('default')} title={t('settings.shortcuts.preset.default.title')}>{t('settings.shortcuts.preset.defaultLabel')}</button>
                  <button type="button" className={`kb-preset-btn ${keybindingPreset === 'vscode' ? 'active' : ''}`} onClick={() => setPreset('vscode')} title={t('settings.shortcuts.preset.vscode.title')}>VSCode</button>
                  <button type="button" className={`kb-preset-btn ${keybindingPreset === 'intellij' ? 'active' : ''}`} onClick={() => setPreset('intellij')} title={t('settings.shortcuts.preset.intellij.title')}>IntelliJ</button>
                </div>
              </div>

              <div className="settings-group">
                <h3>{t('settings.shortcuts.basic')}</h3>
                <p className="shortcut-note">{t('settings.shortcuts.preset.label')}: {keybindingPreset}</p>
                <div className="shortcut-list">
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.commandPalette')}</span><span className="shortcut-key">{shortcutLabel.commandPalette}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.newTerminal')}</span><span className="shortcut-key">{shortcutLabel.newTerminal}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.closeTerminal')}</span><span className="shortcut-key">{shortcutLabel.closeTerminal}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.closeAllTerminals')}</span><span className="shortcut-key">{shortcutLabel.closeAllTerminals}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.nextTerminal')}</span><span className="shortcut-key">{shortcutLabel.nextTerminal}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.prevTerminal')}</span><span className="shortcut-key">{shortcutLabel.prevTerminal}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.lastCompletedTask')}</span><span className="shortcut-key">{shortcutLabel.lastCompletedTask}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.terminalOnlyMode')}</span><span className="shortcut-key">{shortcutLabel.toggleTerminalMode}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.copy')}</span><span className="shortcut-key">⌘/Ctrl+C</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.paste')}</span><span className="shortcut-key">⌘/Ctrl+V</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.openSettings')}</span><span className="shortcut-key">{shortcutLabel.openSettings}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.newProject')}</span><span className="shortcut-key">{shortcutLabel.newProject}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.switchProject')}</span><span className="shortcut-key">Mac: Ctrl+1~9 / Win: Alt+1~9</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.switchTerminal')}</span><span className="shortcut-key">⌘/Ctrl+1~9</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.terminalFontSize')}</span><span className="shortcut-key">⌘/Ctrl+= / ⌘/Ctrl+-</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.saveFile')}</span><span className="shortcut-key">{shortcutLabel.save}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.closeAllEditors')}</span><span className="shortcut-key">{shortcutLabel.closeAllEditors}</span></div>
                </div>
              </div>

              <div className="settings-group">
                <h3>{t('settings.shortcuts.split')}</h3>
                <p className="shortcut-note">{t('settings.shortcuts.split.desc')}</p>
                <div className="shortcut-list">
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.splitRight')}</span><span className="shortcut-key">{shortcutLabel.splitRight}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.splitDown')}</span><span className="shortcut-key">{shortcutLabel.splitDown}</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.panelFocus')}</span><span className="shortcut-key">{shortcutLabel.focusPane}</span></div>
                </div>
              </div>
              <div className="settings-group">
                <h3>{t('settings.shortcuts.terminalInput')}</h3>
                <div className="shortcut-list">
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.lineStart')}</span><span className="shortcut-key">Ctrl+A</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.lineEnd')}</span><span className="shortcut-key">Ctrl+E</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.deleteWord')}</span><span className="shortcut-key">Alt+Backspace</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.deleteToEnd')}</span><span className="shortcut-key">Ctrl+K</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.deleteToStart')}</span><span className="shortcut-key">Ctrl+U</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.prevCommand')}</span><span className="shortcut-key">↑ / Ctrl+P</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.nextCommand')}</span><span className="shortcut-key">↓ / Ctrl+N</span></div>
                  <div className="shortcut-item"><span className="shortcut-name">{t('settings.shortcuts.interrupt')}</span><span className="shortcut-key">Ctrl+C</span></div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'notes' && (
            <div className="settings-section">
              <div className="settings-group">
                <h3>{t('settings.notes.aiProvider')}</h3>
                <div className="setting-item">
                  <div className="kb-preset-row">
                    {AI_TAG_PROVIDERS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`kb-preset-btn ${aiTagProvider === p.id ? 'active' : ''}`}
                        onClick={() => {
                          setAiTagProvider(p.id);
                          setAiTagProviderState(p.id);
                        }}
                        title={`${t('settings.notes.aiProvider.title')}: ${p.label}`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <span className="setting-description">
                    {t('settings.notes.aiProvider.desc')}
                  </span>
                </div>
                <div className="setting-item">
                  <h3 style={{ marginBottom: 6 }}>DeepSeek API Key</h3>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="password"
                      className="setting-input"
                      style={{ flex: 1 }}
                      placeholder="sk-..."
                      value={deepseekKey}
                      onChange={(e) => { setDeepseekKey(e.target.value); setDeepseekSaved(false); }}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="kb-preset-btn"
                      onClick={() => { void kvSet('octo-deepseek-api-key', deepseekKey.trim()); setDeepseekSaved(true); }}
                    >
                      {deepseekSaved ? '✓' : (t('common.save' as any) || 'Save')}
                    </button>
                  </div>
                  <span className="setting-description">
                    {t('settings.deepseek.desc' as any) || 'DeepSeek 브라우저 에이전트(임베드 브라우저 안 🤖 버튼)에서 사용. api.deepseek.com에서 발급.'}
                  </span>
                </div>
              </div>

              <div className="settings-group">
                <h3>{t('settings.notes.templates')}</h3>
                <span className="setting-description" style={{ marginBottom: 8, display: 'block' }}>
                  {t('settings.notes.templatesDesc')}
                </span>

                {/* Template list */}
                {noteTemplates.map((tpl) => (
                  <div key={tpl.id} className="setting-item" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
                    <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.name}</span>
                    <button
                      type="button"
                      className="btn-toolbar"
                      style={{ fontSize: 11, padding: '2px 6px' }}
                      title={t('settings.notes.editTemplate')}
                      onClick={() => {
                        setEditingTemplateId(tpl.id);
                        setTemplateName(tpl.name);
                        setTemplateContent(tpl.content);
                      }}
                    >{t('skills.edit')}</button>
                    <button
                      type="button"
                      className="btn-toolbar"
                      style={{ fontSize: 11, padding: '2px 6px', color: '#e74c3c' }}
                      title={t('common.delete')}
                      onClick={() => {
                        const next = noteTemplates.filter(t => t.id !== tpl.id);
                        setNoteTemplates(next);
                        updateConfig(prev => ({ ...prev, noteTemplates: next }));
                        if (editingTemplateId === tpl.id) setEditingTemplateId(null);
                      }}
                    >{t('common.delete')}</button>
                  </div>
                ))}

                {/* Add/Edit form */}
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder={t('settings.notes.templateNamePlaceholder')}
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    style={{ fontSize: 12 }}
                    title={t('settings.notes.templateName')}
                  />
                  <textarea
                    className="settings-input"
                    placeholder={t('settings.notes.templateContentPlaceholder')}
                    value={templateContent}
                    onChange={(e) => setTemplateContent(e.target.value)}
                    rows={6}
                    style={{ fontSize: 12, resize: 'vertical', fontFamily: 'inherit' }}
                    title={t('settings.notes.template.placeholder')}
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ fontSize: 11, padding: '4px 10px' }}
                      disabled={!templateName.trim() || !templateContent.trim()}
                      title={editingTemplateId ? t('common.save') : t('common.apply')}
                      onClick={() => {
                        if (!templateName.trim() || !templateContent.trim()) return;
                        let next: NoteTemplate[];
                        if (editingTemplateId) {
                          next = noteTemplates.map(t => t.id === editingTemplateId ? { ...t, name: templateName.trim(), content: templateContent } : t);
                        } else {
                          next = [...noteTemplates, { id: Date.now().toString(36), name: templateName.trim(), content: templateContent }];
                        }
                        setNoteTemplates(next);
                        updateConfig(prev => ({ ...prev, noteTemplates: next }));
                        setEditingTemplateId(null);
                        setTemplateName('');
                        setTemplateContent('');
                      }}
                    >
                      {editingTemplateId ? t('common.save') : t('settings.common.add')}
                    </button>
                    {editingTemplateId && (
                      <button
                        type="button"
                        className="btn-secondary"
                        style={{ fontSize: 11, padding: '4px 10px' }}
                        onClick={() => { setEditingTemplateId(null); setTemplateName(''); setTemplateContent(''); }}
                      >{t('common.cancel')}</button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'channels' && (() => {
            const gwLocalUrl = gatewayInfo ? gatewayInfo.localUrl : '';
            const gwPublicUrl = tunnelUrl && gatewayInfo ? `${tunnelUrl}/gateway?token=${gatewayInfo.wsToken}` : '';
            const gwActiveUrl = gwPublicUrl || gwLocalUrl;
            const gwPassword = config.gateway?.password ?? '';
            const gwHasPassword = gwPassword.trim().length > 0;
            return (
              <div className="settings-section">
                <div className="settings-group">
                  <h3>BBARIT Secretary Gateway</h3>
                  <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                    Scan the QR or open the URL on your phone to chat with your secretary. The secretary can drive this app on your behalf.
                  </span>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ flexShrink: 0 }}>
                      {gwActiveUrl
                        ? <img src={qrToDataUri(gwActiveUrl, { size: 176, dark: '#111111', light: '#ffffff' })} alt="Gateway QR code" width={176} height={176} style={{ display: 'block', borderRadius: 8, background: '#ffffff', padding: 8 }} />
                        : <div style={{ width: 176, height: 176, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px dashed color-mix(in srgb, var(--settings-text) 30%, transparent)', fontSize: 12, opacity: 0.6 }}>Preparing...</div>}
                    </div>
                    <div style={{ flex: '1 1 320px', minWidth: 260 }}>
                      <div className="setting-item">
                        <label>Local URL</label>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <input type="text" readOnly value={gwLocalUrl || 'Preparing...'} style={{ flex: '1 1 240px' }} />
                          <button type="button" className="btn-toolbar" disabled={!gwLocalUrl} onClick={() => gwLocalUrl && copyToClipboard(gwLocalUrl)}>{t('settings.web.copy' as any)}</button>
                        </div>
                      </div>
                      <div className="setting-item">
                        <label>Public URL (Cloudflare)</label>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <input type="text" readOnly value={gwPublicUrl || '(Tunnel off)'} style={{ flex: '1 1 240px' }} />
                          {gwPublicUrl
                            ? <button type="button" className="btn-toolbar" onClick={() => copyToClipboard(gwPublicUrl)}>{t('settings.web.copy' as any)}</button>
                            : null}
                        </div>
                        <div className="settings-button-row">
                          {!tunnelUrl
                            ? <button type="button" className="btn-toolbar" disabled={!webTermInfo || tunnelBusy} onClick={() => { void startWebTunnel(); }}>{tunnelBusy ? t('settings.web.starting' as any) : 'Start Tunnel'}</button>
                            : <button type="button" className="btn-toolbar danger" disabled={tunnelBusy} onClick={() => { void stopWebTunnel(); }}>{tunnelBusy ? t('settings.web.stopping' as any, 'Stopping...') : t('settings.web.stopTunnel' as any)}</button>}
                        </div>
                        {tunnelMsg && <span className="setting-description">{tunnelMsg}</span>}
                      </div>
                      <div className="setting-item">
                        <label>Access Password (required for external access)</label>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <input
                            type={gatewayPwShow ? 'text' : 'password'}
                            value={gwPassword}
                            autoComplete="new-password"
                            placeholder="Set a password before exposing via tunnel"
                            onChange={(e) => updateConfig((prev) => ({ ...prev, gateway: { ...prev.gateway, password: e.target.value } }))}
                            style={{ flex: '1 1 240px' }}
                          />
                          <button type="button" className="btn-toolbar" onClick={() => setGatewayPwShow((v) => !v)}>{gatewayPwShow ? 'Hide' : 'Show'}</button>
                        </div>
                        <span className="setting-description">
                          When set, phone visitors must enter this password in addition to the token URL. Stored locally in plain text (this is a local app).
                        </span>
                      </div>
                      {gwHasPassword
                        ? <span className="setting-description" style={{ display: 'block', marginTop: 4, color: 'color-mix(in srgb, #2ea043 85%, var(--settings-text))' }}>
                            Password required for external access ✓
                          </span>
                        : <span className="setting-description" style={{ display: 'block', marginTop: 4, color: 'color-mix(in srgb, #e0662b 80%, var(--settings-text))' }}>
                            No password set — anyone with the token URL can access. Set a password before exposing via tunnel.
                          </span>}
                      <span className="setting-description" style={{ display: 'block', marginTop: 4, color: 'color-mix(in srgb, #e0662b 80%, var(--settings-text))' }}>
                        Security: anyone with this token URL can operate the app through the secretary while the tunnel is on. Share it carefully and stop the tunnel when done.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
          {activeTab === 'web-terminal' && (() => {
            const webLocalUrl = webTermInfo ? `${webTermInfo.url}#token=${webTermInfo.token}` : '';
            const webPublicUrl = tunnelUrl && webTermInfo ? `${tunnelUrl}/web#token=${webTermInfo.token}` : '';
            const webActiveUrl = webPublicUrl || webLocalUrl;
            return (
              <div className="settings-section">
                <div className="settings-group">
                  <h3>{t('settings.web.title' as any)} ({t('settings.web.externalAccess' as any)})</h3>
                  <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
                    {t('settings.web.desc' as any)}
                  </span>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ flexShrink: 0 }}>
                      {webActiveUrl
                        ? <img src={qrToDataUri(webActiveUrl, { size: 176, dark: '#111111', light: '#ffffff' })} alt="Web Terminal QR code" width={176} height={176} style={{ display: 'block', borderRadius: 8, background: '#ffffff', padding: 8 }} />
                        : <div style={{ width: 176, height: 176, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px dashed color-mix(in srgb, var(--settings-text) 30%, transparent)', fontSize: 12, opacity: 0.6 }}>Preparing...</div>}
                    </div>
                    <div style={{ flex: '1 1 320px', minWidth: 260 }}>
                      <div className="setting-item">
                        <label>{t('settings.web.localUrl' as any)}</label>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <input type="text" readOnly value={webLocalUrl || t('settings.web.preparing' as any, 'Preparing...')} style={{ flex: '1 1 240px' }} />
                          <button type="button" className="btn-toolbar" disabled={!webLocalUrl} onClick={() => webLocalUrl && copyToClipboard(webLocalUrl)}>{t('settings.web.copy' as any)}</button>
                        </div>
                      </div>
                      <div className="setting-item">
                        <label>{t('settings.web.externalUrl' as any)} (Cloudflare)</label>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <input type="text" readOnly value={webPublicUrl || t('settings.web.tunnelOff' as any, '(Tunnel off)')} style={{ flex: '1 1 240px' }} />
                          {webPublicUrl
                            ? <button type="button" className="btn-toolbar" onClick={() => copyToClipboard(webPublicUrl)}>{t('settings.web.copy' as any)}</button>
                            : null}
                        </div>
                        <div className="settings-button-row">
                          {!tunnelUrl
                            ? <button type="button" className="btn-toolbar" disabled={!webTermInfo || tunnelBusy} onClick={() => { void startWebTunnel(); }}>{tunnelBusy ? t('settings.web.starting' as any) : t('settings.web.startCloudflareTunnel' as any, 'Start Cloudflare Tunnel')}</button>
                            : <button type="button" className="btn-toolbar danger" disabled={tunnelBusy} onClick={() => { void stopWebTunnel(); }}>{tunnelBusy ? t('settings.web.stopping' as any, 'Stopping...') : t('settings.web.stopTunnel' as any)}</button>}
                        </div>
                        {tunnelMsg && <span className="setting-description">{tunnelMsg}</span>}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {activeTab === 'integrations' && (
            <div className="settings-section">
              <DashboardUrlSetting t={t} />
              <div className="settings-group" style={{ display: 'none' }}>
                <h3>{t('settings.agent.stt.title')}</h3>
                <span className="setting-description">
                  {t('settings.agent.stt.holdRightAlt')}
                </span>

                <div className="setting-item">
                  <label>{t('settings.agent.stt.engine')}</label>
                  <input type="text" value={t('settings.agent.stt.localWhisper')} disabled readOnly />
                  <span className="setting-description">
                    {t('settings.agent.stt.offlineDesc')}
                  </span>
                </div>

                <div className="setting-item">
                  <label>{t('settings.agent.stt.voiceModel')}</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      value={_sttLocalWhisperModel}
                      onChange={(e) => _setSttLocalWhisperModel(e.target.value)}
                      style={{ flex: '1 1 240px' }}
                    >
                      {(_sttLocalModels.length
                        ? _sttLocalModels
                        : [{ value: _sttLocalWhisperModel, label: _sttLocalWhisperModel, size_mb: 0, url: '' }]
                      ).map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}{m.size_mb ? ` (${(m.size_mb / 1024).toFixed(1)} GB)` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn-toolbar"
                      disabled={_sttLocalModelDownloading}
                      onClick={() => { void downloadSttLocalModel(); }}
                    >
                      {_sttLocalModelDownloading
                        ? t('settings.agent.stt.downloading').replace('{pct}', String(_sttLocalModelDownloadPct))
                        : (_sttLocalModelStatus?.exists ? t('settings.common.redownload') : t('settings.common.download'))}
                    </button>
                  </div>
                  <span className="setting-description">
                    {_sttLocalModelStatus?.exists
                      ? t('settings.agent.stt.downloaded').replace('{size}', (_sttLocalModelStatus.size / (1024 * 1024)).toFixed(0))
                      : t('settings.agent.stt.notDownloaded')}
                  </span>
                </div>

                <div className="setting-item">
                  <label>{t('settings.agent.stt.hints')}</label>
                  <input
                    type="text"
                    value={_sttPrompt}
                    placeholder={t('settings.agent.stt.hintsPlaceholder')}
                    onChange={(e) => _setSttPrompt(e.target.value)}
                  />
                  <span className="setting-description">
                    {t('settings.agent.stt.hintsDesc2')}
                  </span>
                </div>

                <div className="setting-item">
                  <label>{t('settings.language')}</label>
                  <select value={_sttLanguage} onChange={(e) => _setSttLanguage(e.target.value)}>
                    <option value="ko">{t('settings.agent.stt.lang.ko')}</option>
                    <option value="en">{t('settings.agent.stt.lang.en')}</option>
                    <option value="ja">{t('settings.agent.stt.lang.ja')}</option>
                    <option value="zh">{t('settings.agent.stt.lang.zh')}</option>
                    <option value="">{t('settings.agent.stt.lang.auto')}</option>
                  </select>
                </div>

                <div className="setting-item">
                  <label>{t('settings.agent.stt.microphone')}</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      value={_sttMicDeviceId}
                      onChange={(e) => _setSttMicDeviceId(e.target.value)}
                      style={{ flex: '1 1 260px' }}
                    >
                      <option value="">{t('settings.agent.stt.defaultMic')}</option>
                      {_sttMicDevices.map((mic) => (
                        <option key={mic.deviceId} value={mic.deviceId}>
                          {mic.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => { void _refreshSttMicDevices(); }}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 'var(--brutal-radius)',
                        border: '1px solid color-mix(in srgb, var(--settings-accent) 40%, transparent)',
                        background: 'color-mix(in srgb, var(--settings-accent) 16%, transparent)',
                        color: 'var(--settings-text)',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      {t('settings.common.refresh')}
                    </button>
                    <button
                      type="button"
                      onClick={() => { void _testSttMic(); }}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 'var(--brutal-radius)',
                        border: '1px solid color-mix(in srgb, var(--settings-accent) 40%, transparent)',
                        background: 'color-mix(in srgb, var(--settings-accent) 16%, transparent)',
                        color: 'var(--settings-text)',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      {t('settings.agent.stt.testMic')}
                    </button>
                  </div>
                  {_sttMicTestStatus && (
                    <span className="setting-description">
                      {_sttMicTestStatus}
                    </span>
                  )}
                  {_sttMicDevicesError && (
                    <span className="setting-description" style={{ color: 'color-mix(in srgb, #ef4444 75%, var(--settings-text) 25%)' }}>
                      {_sttMicDevicesError}
                    </span>
                  )}
                </div>

                <div className="setting-item toggle">
                  <label>{t('settings.agent.stt.pressEnter')}</label>
                  <input
                    type="checkbox"
                    checked={_sttAutoEnter}
                    onChange={(e) => _setSttAutoEnter(e.target.checked)}
                  />
                </div>

                <div className="setting-item toggle">
                  <label>{t('settings.agent.stt.skipSilence')}</label>
                  <input
                    type="checkbox"
                    checked={_sttSilenceGate}
                    onChange={(e) => _setSttSilenceGate(e.target.checked)}
                  />
                </div>

                <div className="setting-item toggle">
                  <label>{t('settings.agent.stt.filterHallucinations')}</label>
                  <input
                    type="checkbox"
                    checked={_sttHallucinationFilter}
                    onChange={(e) => _setSttHallucinationFilter(e.target.checked)}
                  />
                </div>

                <div className="setting-item">
                  <label>{t('settings.agent.stt.minDuration')}</label>
                  <input
                    type="number"
                    min={0}
                    max={5000}
                    value={_sttMinDurationMs}
                    onChange={(e) => _setSttMinDurationMs(Number(e.target.value) || 0)}
                  />
                </div>

                <div className="setting-item">
                  <label>{t('settings.agent.stt.minRms')}</label>
                  <input
                    type="number"
                    min={0}
                    max={0.2}
                    step={0.001}
                    value={_sttMinRms}
                    onChange={(e) => _setSttMinRms(Number(e.target.value) || 0)}
                  />
                </div>

                <div className="setting-item toggle">
                  <label>{t('settings.agent.stt.disableMicProcessing')}</label>
                  <input
                    type="checkbox"
                    checked={_sttDisableProcessing}
                    onChange={(e) => _setSttDisableProcessing(e.target.checked)}
                  />
                  <span className="setting-description">
                    {t('settings.agent.stt.disableMicProcessing.desc')}
                  </span>
                </div>

                <div className="setting-item">
                  <label>{t('settings.agent.stt.inputBoost')}</label>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    step={0.1}
                    value={_sttBoost}
                    onChange={(e) => _setSttBoost(Number(e.target.value) || 1)}
                  />
                </div>
              </div>

              <div className="settings-group">
                <h3>Linear</h3>
                <div className="setting-item">
                  <label>{t('settings.integrations.linear.apiToken')}</label>
                  <span className="setting-description">
                    {t('settings.integrations.linear.status')}:{' '}
                    <strong style={{ color: linearTokenConfigured ? 'color-mix(in srgb, #22c55e 80%, var(--settings-text) 20%)' : 'color-mix(in srgb, #ef4444 75%, var(--settings-text) 25%)' }}>
                      {linearTokenConfigured ? t('settings.integrations.linear.configured') : t('settings.integrations.linear.notConfigured')}
                    </strong>
                  </span>
                  <input
                    type={linearTokenShow ? 'text' : 'password'}
                    value={linearApiToken}
                    placeholder={linearTokenConfigured ? t('settings.integrations.linear.placeholderConfigured') : t('settings.integrations.linear.placeholder')}
                    onChange={(e) => setLinearApiToken(e.target.value)}
                    disabled={linearBusy}
                  />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => {
                        setLinearTokenShow((v) => {
                          const next = !v;
                          if (next && linearTokenConfigured && !linearApiToken.trim()) {
                            getLinearSettings().then(s => { if (s.apiToken) setLinearApiToken(s.apiToken); }).catch(() => {});
                          }
                          if (!next) setLinearApiToken('');
                          return next;
                        });
                      }}
                      disabled={linearBusy}
                      title={linearTokenShow ? t('settings.integrations.linear.hideToken') : t('settings.integrations.linear.showToken')}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 'var(--brutal-radius)',
                        border: `1px solid color-mix(in srgb, var(--settings-accent) 40%, transparent)`,
                        background: `color-mix(in srgb, var(--settings-bg) 75%, var(--settings-accent) 25%)`,
                        color: 'var(--settings-text)',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      {linearTokenShow ? t('settings.integrations.linear.hide') : t('settings.integrations.linear.show')}
                    </button>
                    <button
                      type="button"
                      onClick={() => { void verifyLinearConnection(); }}
                      disabled={linearBusy || (!linearApiToken.trim() && !linearTokenConfigured)}
                      title={t('settings.integrations.linear.verify.title')}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 'var(--brutal-radius)',
                        border: `1px solid color-mix(in srgb, var(--settings-accent) 40%, transparent)`,
                        background: `color-mix(in srgb, var(--settings-accent) 16%, transparent)`,
                        color: 'var(--settings-text)',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      {linearBusy ? `${t('settings.agent.telegram.verify')}...` : t('settings.agent.telegram.verify')}
                    </button>
                    <button
                      type="button"
                      onClick={saveLinearConnection}
                      disabled={linearBusy || (!linearApiToken.trim() && !linearTokenConfigured)}
                      title={t('settings.integrations.linear.save.title')}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 'var(--brutal-radius)',
                        border: `1px solid color-mix(in srgb, var(--settings-accent) 50%, transparent)`,
                        background: `color-mix(in srgb, var(--settings-accent) 22%, transparent)`,
                        color: 'var(--settings-text)',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {t('common.save')}
                    </button>
                    <button
                      type="button"
                      onClick={clearLinearConnectionToken}
                      disabled={linearBusy || !linearTokenConfigured}
                      title={t('common.reset')}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 'var(--brutal-radius)',
                        border: `1px solid color-mix(in srgb, #ef4444 55%, transparent)`,
                        background: `color-mix(in srgb, #ef4444 14%, transparent)`,
                        color: 'var(--settings-text)',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      {t('common.reset')}
                    </button>
                  </div>
                  <span className="setting-description">
                    {t('settings.integrations.linear.desc')}
                  </span>
                  <span className="setting-description">
                    {t('settings.integrations.linear.quickSetup')}
                  </span>
                  {linearMsg && (
                    <span className="setting-description" style={{ color: 'color-mix(in srgb, var(--settings-accent) 80%, var(--settings-text) 20%)' }}>
                      {linearMsg}
                    </span>
                  )}
                </div>
                <div className="setting-item">
                  <label>{t('settings.integrations.linear.defaultTeamId')}</label>
                  <input
                    value={linearTeamId}
                    onChange={(e) => setLinearTeamId(e.target.value)}
                    placeholder={t('settings.integrations.linear.defaultTeamId.placeholder')}
                    disabled={linearBusy}
                  />
                  {linearTeams.length > 0 && (
                    <select
                      value={linearTeamId}
                      onChange={(e) => setLinearTeamId(e.target.value)}
                      style={{ marginTop: 8 }}
                      title={t('settings.integrations.linear.selectTeam')}
                    >
                      <option value="">{t('settings.integrations.linear.selectTeam.placeholder')}</option>
                      {linearTeams.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.key} - {team.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="setting-item">
                  <label>{t('settings.integrations.linear.defaultProjectId')}</label>
                  <input
                    value={linearProjectId}
                    onChange={(e) => setLinearProjectId(e.target.value)}
                    placeholder={t('settings.integrations.linear.defaultProjectId.placeholder')}
                    disabled={linearBusy}
                  />
                </div>
                {projects && projects.length > 0 && (
                  <div className="setting-item" style={{ borderTop: '1px solid color-mix(in srgb, var(--settings-accent) 20%, transparent)', paddingTop: 12, marginTop: 8 }}>
                    <label>{t('settings.integrations.linear.perProject')}</label>
                    <span className="setting-description">
                      {t('settings.integrations.linear.perProject.desc')}
                    </span>
                    <select
                      value={linearSelectedProjectId}
                      onChange={(e) => setLinearSelectedProjectId(e.target.value)}
                      style={{ marginTop: 4 }}
                    >
                      <option value="">{t('settings.integrations.linear.selectProject')}</option>
                      {projects.map((proj) => (
                        <option key={proj.id} value={proj.id}>
                          {proj.icon} {proj.displayName}
                        </option>
                      ))}
                    </select>
                    {linearSelectedProject && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div>
                          <label style={{ fontSize: 12, opacity: 0.8 }}>Team ID ({linearSelectedProject.displayName})</label>
                          <input
                            value={linearPerProjectTeamId}
                            onChange={(e) => setLinearPerProjectTeamId(e.target.value)}
                            placeholder={linearTeamId || t('settings.integrations.linear.useDefault')}
                            disabled={linearBusy}
                          />
                          {linearTeams.length > 0 && (
                            <select
                              value={linearPerProjectTeamId}
                              onChange={(e) => setLinearPerProjectTeamId(e.target.value)}
                              style={{ marginTop: 4 }}
                              title={t('settings.integrations.linear.selectTeam')}
                            >
                              <option value="">{t('settings.integrations.linear.useDefault')}</option>
                              {linearTeams.map((team) => (
                                <option key={team.id} value={team.id}>
                                  {team.key} - {team.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                        <div>
                          <label style={{ fontSize: 12, opacity: 0.8 }}>Project ID ({linearSelectedProject.displayName})</label>
                          <input
                            value={linearPerProjectProjectId}
                            onChange={(e) => setLinearPerProjectProjectId(e.target.value)}
                            placeholder={linearProjectId || t('settings.integrations.linear.useDefault')}
                            disabled={linearBusy}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="settings-group">
                <h3>Slack</h3>
                <span className="setting-description">{t('settings.integrations.slack.hub.desc')}</span>
                <div className="setting-item">
                  <label>{t('settings.integrations.slack.globalToken')}</label>
                  <input
                    type="password"
                    defaultValue={kvSlackBotToken || ''}
                    placeholder="xoxb-..."
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v) void kvSet('octo-slack-bot-token', v);
                      else void kvDelete('octo-slack-bot-token');
                    }}
                  />
                </div>
                <div className="setting-item">
                  <label>{t('settings.integrations.slack.defaultChannel')}</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="text"
                      defaultValue={kvSlackChannelId || ''}
                      placeholder="C01XXXXXX"
                      style={{ flex: 1 }}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v) void kvSet('octo-slack-channel-id', v);
                        else void kvDelete('octo-slack-channel-id');
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => { void fetchSlackChannels(); }}
                      disabled={slackChannelsBusy || !kvSlackBotToken}
                      style={{
                        padding: '8px 10px', borderRadius: 'var(--brutal-radius)', fontSize: 12, cursor: 'pointer',
                        border: '1px solid color-mix(in srgb, var(--settings-accent) 40%, transparent)',
                        background: 'color-mix(in srgb, var(--settings-accent) 16%, transparent)',
                        color: 'var(--settings-text)', whiteSpace: 'nowrap',
                      }}
                    >
                      {slackChannelsBusy ? t('settings.integrations.slack.fetching') : t('settings.integrations.slack.fetchChannels')}
                    </button>
                  </div>
                  {slackChannels.length > 0 && (
                    <select
                      value={kvSlackChannelId || ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v) void kvSet('octo-slack-channel-id', v);
                        else void kvDelete('octo-slack-channel-id');
                        setSlackChannels([...slackChannels]);
                      }}
                      style={{ marginTop: 8 }}
                    >
                      <option value="">{t('settings.integrations.slack.selectChannel')}</option>
                      {slackChannels.map(c => (
                        <option key={c.id} value={c.id}>#{c.name} ({c.id})</option>
                      ))}
                    </select>
                  )}
                  <span className="setting-description">{t('settings.integrations.slack.defaultChannel.desc')}</span>
                </div>
                {projects && projects.length > 0 && (
                  <div className="setting-item" style={{ borderTop: '1px solid color-mix(in srgb, var(--settings-accent) 20%, transparent)', paddingTop: 12, marginTop: 8 }}>
                    <label>{t('settings.integrations.slack.perProject')}</label>
                    <span className="setting-description">{t('settings.integrations.slack.perProject.desc')}</span>
                    {projects.map((proj) => (
                      <div key={proj.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                        <span style={{ fontSize: 12, minWidth: 100, opacity: 0.7, flexShrink: 0 }}>{proj.icon} {proj.displayName}</span>
                        {slackChannels.length > 0 ? (
                          <select
                            defaultValue={proj.slackChannelId || ''}
                            style={{ flex: 1 }}
                            onChange={(e) => {
                              const v = e.target.value.trim();
                              onProjectUpdate?.(proj.id, { slackChannelId: v || undefined });
                            }}
                          >
                            <option value="">{kvSlackChannelId ? `${t('settings.integrations.linear.useDefault')} (${kvSlackChannelId})` : t('settings.integrations.linear.useDefault')}</option>
                            {slackChannels.map(c => (
                              <option key={c.id} value={c.id}>#{c.name} ({c.id})</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            defaultValue={proj.slackChannelId || ''}
                            placeholder={kvSlackChannelId || t('settings.integrations.linear.useDefault')}
                            style={{ flex: 1 }}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              onProjectUpdate?.(proj.id, { slackChannelId: v || undefined });
                            }}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="settings-group">
                <h3>GitHub</h3>
                <span className="setting-description">{t('settings.integrations.github.hub.desc')}</span>
                <div className="setting-item">
                  <label>{t('settings.integrations.github.globalToken')}</label>
                  <input
                    type="password"
                    defaultValue={kvGithubToken || ''}
                    placeholder="ghp_..."
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v) void kvSet('octo-github-token', v);
                      else void kvDelete('octo-github-token');
                    }}
                  />
                </div>
                <div className="setting-item">
                  <label>{t('settings.integrations.github.defaultRepo')}</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="text"
                      defaultValue={kvGithubRepo || ''}
                      placeholder="owner/repo"
                      style={{ flex: 1 }}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v) void kvSet('octo-github-repo', v);
                        else void kvDelete('octo-github-repo');
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => { void fetchGhRepos(); }}
                      disabled={ghReposBusy || !kvGithubToken}
                      style={{
                        padding: '8px 10px', borderRadius: 'var(--brutal-radius)', fontSize: 12, cursor: 'pointer',
                        border: '1px solid color-mix(in srgb, var(--settings-accent) 40%, transparent)',
                        background: 'color-mix(in srgb, var(--settings-accent) 16%, transparent)',
                        color: 'var(--settings-text)', whiteSpace: 'nowrap',
                      }}
                    >
                      {ghReposBusy ? t('settings.integrations.github.fetching') : t('settings.integrations.github.fetchRepos')}
                    </button>
                  </div>
                  {ghReposMsg && (
                    <span className="setting-description" style={{ color: ghRepos.length > 0 ? 'color-mix(in srgb, #22c55e 80%, var(--settings-text) 20%)' : 'color-mix(in srgb, #ef4444 75%, var(--settings-text) 25%)' }}>
                      {ghReposMsg}
                    </span>
                  )}
                  {ghRepos.length > 0 && (
                    <select
                      value={kvGithubRepo || ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v) void kvSet('octo-github-repo', v);
                        else void kvDelete('octo-github-repo');
                        setGhRepos([...ghRepos]);
                      }}
                      style={{ marginTop: 8 }}
                    >
                      <option value="">{t('settings.integrations.github.selectRepo')}</option>
                      {ghRepos.map(r => (
                        <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
                      ))}
                    </select>
                  )}
                  <span className="setting-description">{t('settings.integrations.github.defaultRepo.desc')}</span>
                </div>
                {projects && projects.length > 0 && (
                  <div className="setting-item" style={{ borderTop: '1px solid color-mix(in srgb, var(--settings-accent) 20%, transparent)', paddingTop: 12, marginTop: 8 }}>
                    <label>{t('settings.integrations.github.perProject')}</label>
                    <span className="setting-description">{t('settings.integrations.github.perProject.desc')}</span>
                    {projects.map((proj) => (
                      <div key={proj.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                        <span style={{ fontSize: 12, minWidth: 100, opacity: 0.7, flexShrink: 0 }}>{proj.icon} {proj.displayName}</span>
                        {ghRepos.length > 0 ? (
                          <select
                            defaultValue={proj.githubRepo || ''}
                            style={{ flex: 1 }}
                            onChange={(e) => {
                              const v = e.target.value.trim();
                              onProjectUpdate?.(proj.id, { githubRepo: v || undefined });
                            }}
                          >
                            <option value="">{kvGithubRepo || t('settings.integrations.linear.useDefault')}</option>
                            {ghRepos.map(r => (
                              <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            defaultValue={proj.githubRepo || ''}
                            placeholder={kvGithubRepo || t('settings.integrations.linear.useDefault')}
                            style={{ flex: 1 }}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              onProjectUpdate?.(proj.id, { githubRepo: v || undefined });
                            }}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'data' && (
            <div className="settings-section">
              <div className="settings-group">
                <h3>{t('settings.data.title')}</h3>
                <span className="setting-description" style={{ display: 'block', marginBottom: 12 }}>
                  {t('settings.data.desc')}
                </span>

                <div className="setting-item" style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, display: 'block' }}>{t('settings.data.syncFolder')}</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      className="settings-input"
                      value={syncPath}
                      onChange={(e) => saveSyncPath(e.target.value)}
                      placeholder="/Users/you/Google Drive/OctoBackup"
                      style={{ flex: 1, fontSize: 12 }}
                      title={t('settings.data.syncFolder')}
                    />
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ fontSize: 11, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}
                      onClick={async () => {
                        try {
                          const selected = await invoke<string | null>('open_folder_dialog');
                          if (selected) saveSyncPath(selected);
                        } catch { /* cancelled */ }
                      }}
                      title={t('settings.data.syncFolder')}
                    ><FolderOpen size={12} /></button>
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ fontSize: 11, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}
                      disabled={!syncPath.trim()}
                      onClick={async () => {
                        try {
                          await invoke('create_directory', { path: syncPath.trim() });
                          // Check which files exist in sync folder
                          const found: string[] = [];
                          for (const f of SYNC_FILES) {
                            try {
                              await invoke<string>('read_file', { path: `${syncPath.trim()}/${f.rel.split('/').pop()}` });
                              found.push(f.label);
                            } catch { /* not found */ }
                          }
                          setSyncStatus(found.length > 0
                            ? `${t('settings.data.folderVerified')} — ${found.join(', ')} found`
                            : `${t('settings.data.folderVerified')} — empty (no backups yet)`);
                        } catch (e) {
                          setSyncStatus(`Failed: ${e}`);
                        }
                      }}
                      title={t('settings.data.verify')}
                    >{t('settings.data.verify')}</button>
                  </div>
                  <span className="setting-description" style={{ marginTop: 4, display: 'block' }}>
                    {t('settings.data.syncFolderHint')}
                  </span>
                </div>

                <div className="setting-item" style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'block' }}>{t('settings.data.syncFiles')}</label>
                  <div style={{ fontSize: 11, opacity: 0.7, lineHeight: 1.8 }}>
                    {SYNC_FILES.map(f => (
                      <div key={f.rel} style={{ display: 'flex', gap: 6 }}>
                        <span style={{ fontWeight: 600, minWidth: 60 }}>{f.label}</span>
                        <span style={{ opacity: 0.6 }}>~/{f.rel}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ fontSize: 12, padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 5 }}
                    disabled={syncBusy || !syncPath.trim()}
                    onClick={() => void doExport()}
                    title={t('settings.data.export')}
                  ><Upload size={14} /> {t('settings.data.export')}</button>
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ fontSize: 12, padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 5 }}
                    disabled={syncBusy || !syncPath.trim()}
                    onClick={() => void doImport()}
                    title={t('settings.data.import')}
                  ><DownloadIcon size={14} /> {t('settings.data.import')}</button>
                </div>

                {syncStatus && (
                  <div style={{ marginTop: 8, fontSize: 11, padding: '6px 10px', background: syncStatus.includes('fail') ? '#ef444420' : '#22c55e20', borderRadius: 'var(--brutal-radius)', color: syncStatus.includes('fail') ? '#ef4444' : '#22c55e' }}>
                    {syncBusy && <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite', marginRight: 4 }} />}
                    {syncStatus}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'cli' && (
            <div className="settings-section">
              <h3>Control CLI — bbarit-ctl</h3>
              <p className="setting-description" style={{ maxWidth: 640 }}>
                Drive every feature of BBARIT Terminal from the command line — projects, layout,
                terminals (write &amp; read), editor, panels, config, personas, and harness roles.
                Run it from the repo root while the app is running. The dev app is auto-discovered
                (ports 9323–9422); target the installed build with <code>--port 9223</code>.
              </p>

              <div className="setting-item">
                <label>Quick start</label>
                <span className="setting-description">
                  Standalone: download the CLI below, then run it with Node.js — it finds the running
                  app automatically (dev 9323–9422, installed 9223). Inside the repo, use <code>npm run ctl --</code>.
                </span>
                {[
                  'node bbarit-ctl.mjs menu',
                  'node bbarit-ctl.mjs status',
                  'node bbarit-ctl.mjs term write "git status"',
                  'node bbarit-ctl.mjs action list',
                ].map((cmdLine) => (
                  <div key={cmdLine} className="cli-cmd-row">
                    <code>{cmdLine}</code>
                    <button
                      type="button"
                      className="cli-copy-btn"
                      title="Copy command"
                      onClick={() => { void invoke('copy_to_clipboard', { text: cmdLine }).then(() => setCliCopied(cmdLine)); }}
                    >
                      {cliCopied === cmdLine ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                ))}
              </div>

              <div className="setting-item">
                <label>Download</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ fontSize: 12, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 6 }}
                    onClick={() => { void downloadCliScript(); }}
                  >
                    <DownloadIcon size={13} /> Download CLI (bbarit-ctl.mjs)
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ fontSize: 12, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 6 }}
                    onClick={() => { void downloadCliDocs(); }}
                  >
                    <DownloadIcon size={13} /> Download docs (BBARIT_CLI.md)
                  </button>
                  <button
                    type="button"
                    className="cli-copy-btn"
                    onClick={() => { void invoke('copy_to_clipboard', { text: BBARIT_CLI_DOC }).then(() => setCliCopied('__doc__')); }}
                  >
                    {cliCopied === '__doc__' ? 'Copied!' : 'Copy docs as Markdown'}
                  </button>
                </div>
                {cliDocSavedPath && (
                  <span className="setting-description">Saved to {cliDocSavedPath}</span>
                )}
              </div>

              <div className="setting-item">
                <label>Command reference (app command bus)</label>
                <span className="setting-description">
                  Everything below is also reachable from the CLI (e.g. <code>terminal.write</code> →{' '}
                  <code>npm run ctl -- term write "ls"</code>) and from the gateway secretary's app_control tool.
                </span>
                <div className="cli-cmd-table">
                  {GATEWAY_UI_COMMAND_DOCS.map((c, i) => (
                    <Fragment key={c.cmd}>
                      {(i === 0 || GATEWAY_UI_COMMAND_DOCS[i - 1].group !== c.group) && (
                        <div className="cli-cmd-group">{c.group}</div>
                      )}
                      <div className="cli-cmd-item">
                        <code className="cli-cmd-name">{c.cmd}</code>
                        <span className="cli-cmd-args">{c.args}</span>
                        <span className="cli-cmd-desc">{c.desc}</span>
                        <button
                          type="button"
                          className="cli-copy-btn"
                          title="Copy CLI example"
                          onClick={() => {
                            const example = `npm run ctl -- ${CLI_EXAMPLES[c.cmd] || c.cmd}`;
                            void invoke('copy_to_clipboard', { text: example }).then(() => setCliCopied(c.cmd));
                          }}
                        >
                          {cliCopied === c.cmd ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                    </Fragment>
                  ))}
                </div>
                <span className="setting-description" style={{ marginTop: 6 }}>
                  CLI-only extras: <code>harness roles</code> · <code>harness model &lt;role&gt; &lt;ref&gt;</code> ·{' '}
                  <code>harness persona &lt;role&gt; &lt;id&gt;</code> (edits agent config directly) ·{' '}
                  <code>screenshot</code> · <code>snapshot</code> · <code>js</code>. Full details in BBARIT_CLI.md.
                </span>
              </div>
            </div>
          )}

          {activeTab === 'licenses' && (
            <div className="settings-section">
              {/* Product Info & Copyright */}
              <div className="settings-group" style={{ textAlign: 'center', padding: '24px 16px 20px' }}>
                <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.5px', marginBottom: 4 }}>BBARIT Terminal</div>
                <div style={{ fontSize: 13, opacity: 0.5, marginBottom: 16 }}>{t('settings.about.tagline')}</div>
                <div style={{
                  display: 'inline-block', padding: '4px 14px', borderRadius: 'var(--brutal-radius)', fontSize: 13, fontWeight: 700,
                  background: `${currentStyle.accent}20`, color: currentStyle.accent,
                  border: `1px solid ${currentStyle.accent}30`,
                }}>v{appVersion || '?'}</div>
                <div style={{
                  marginTop: 20, padding: '16px 20px', borderRadius: 'var(--brutal-radius)',
                  background: `${currentStyle.accent}08`,
                  border: `1px solid ${currentStyle.accent}15`,
                  textAlign: 'left', fontSize: 12, lineHeight: 1.8,
                }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: currentStyle.accent }}>상업용 소프트웨어 (Commercial Software)</div>
                  <div style={{ opacity: 0.8 }}>
                    © 2024–2026 BBARIT (빠릿). All rights reserved.<br />
                    본 소프트웨어는 BBARIT이 개발 및 배포하는 유료 상업용 제품입니다.<br />
                    정당한 라이선스 없이 본 소프트웨어를 복제, 배포, 수정, 리버스 엔지니어링하거나<br />
                    파생 저작물을 생성하는 행위는 관련 법률에 의해 엄격히 금지됩니다.<br />
                    단, 본 제품에 포함된 서드파티 오픈소스 구성요소는 위 제한의 적용을 받지 않으며<br />
                    각각의 원본 라이선스(아래 &quot;오픈소스 라이선스&quot; 참조)를 따릅니다.
                  </div>
                  <div style={{ marginTop: 12, opacity: 0.8 }}>
                    This software is a paid commercial product developed and distributed by BBARIT.<br />
                    Unauthorized copying, distribution, modification, reverse engineering, or creation of<br />
                    derivative works is strictly prohibited and subject to applicable laws.<br />
                    Third-party open-source components included in this product are exempt from the above<br />
                    restrictions and remain governed by their respective licenses (see &quot;Open Source Licenses&quot; below).
                  </div>
                </div>
                <div style={{ marginTop: 16, fontSize: 11, opacity: 0.4, lineHeight: 1.6 }}>
                  {t('settings.about.developer')}<br />
                  macOS (Apple Silicon) · Windows
                </div>
              </div>

              {/* Open Source Licenses */}
              <div className="settings-group">
                <h3>{t('settings.about.oss.title')}</h3>
                <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 16 }}>
                  {t('settings.about.oss.desc')}
                </p>

                <h4 style={{ fontSize: 13, marginTop: 16, marginBottom: 8, opacity: 0.9 }}>Frontend (npm)</h4>
                <div style={{ fontSize: 11, lineHeight: 1.8, opacity: 0.8 }}>
                  {[
                    { name: 'React', license: 'MIT', url: 'https://github.com/facebook/react' },
                    { name: 'xterm.js', license: 'MIT', url: 'https://github.com/xtermjs/xterm.js' },
                    { name: 'Monaco Editor', license: 'MIT', url: 'https://github.com/microsoft/monaco-editor' },
                    { name: 'Vite', license: 'MIT', url: 'https://github.com/vitejs/vite' },
                    { name: 'Tauri Apps API', license: 'MIT/Apache-2.0', url: 'https://github.com/tauri-apps/tauri' },
                    { name: 'Lucide React', license: 'ISC', url: 'https://github.com/lucide-icons/lucide' },
                    { name: 'Tiptap', license: 'MIT', url: 'https://github.com/ueberdosis/tiptap' },
                    { name: 'CodeMirror', license: 'MIT', url: 'https://github.com/codemirror/dev' },
                    { name: 'GrapesJS', license: 'BSD-3-Clause', url: 'https://github.com/GrapesJS/grapesjs' },
                    { name: 'Fabric.js', license: 'MIT', url: 'https://github.com/fabricjs/fabric.js' },
                    { name: 'pdf-lib', license: 'MIT', url: 'https://github.com/Hopding/pdf-lib' },
                    { name: 'pdfjs-dist', license: 'Apache-2.0', url: 'https://github.com/nicolo-ribaudo/pdfjs-dist' },
                    { name: 'Mammoth', license: 'BSD-2-Clause', url: 'https://github.com/mwilliamson/mammoth.js' },
                    { name: 'SheetJS (xlsx)', license: 'Apache-2.0', url: 'https://github.com/SheetJS/sheetjs' },
                    { name: 'JSZip', license: 'MIT/GPLv3', url: 'https://github.com/Stuk/jszip' },
                    { name: 'markdown-it', license: 'MIT', url: 'https://github.com/markdown-it/markdown-it' },
                    { name: 'react-markdown', license: 'MIT', url: 'https://github.com/remarkjs/react-markdown' },
                    { name: 'Mermaid', license: 'MIT', url: 'https://github.com/mermaid-js/mermaid' },
                    { name: 'MiniSearch', license: 'MIT', url: 'https://github.com/lucaong/minisearch' },
                    { name: 'Lowlight', license: 'MIT', url: 'https://github.com/wooorm/lowlight' },
                    { name: 'Prettier', license: 'MIT', url: 'https://github.com/prettier/prettier' },
                    { name: 'html2pdf.js', license: 'MIT', url: 'https://github.com/eKoopmans/html2pdf.js' },
                    { name: 'html-to-image', license: 'MIT', url: 'https://github.com/nicedoc/html-to-image' },
                    { name: 'styled-components', license: 'MIT', url: 'https://github.com/styled-components/styled-components' },
                    { name: 'Google GenAI SDK', license: 'Apache-2.0', url: 'https://github.com/google-gemini/generative-ai-js' },
                    { name: 'Docx', license: 'MIT', url: 'https://github.com/dolanmiu/docx' },
                    { name: 'PptxGenJS', license: 'MIT', url: 'https://github.com/gitbrent/PptxGenJS' },
                    { name: 'remark-gfm', license: 'MIT', url: 'https://github.com/remarkjs/remark-gfm' },
                    { name: 'rehype-highlight', license: 'MIT', url: 'https://github.com/rehypejs/rehype-highlight' },
                    { name: 'rehype-katex', license: 'MIT', url: 'https://github.com/remarkjs/remark-math' },
                    { name: 'remark-math', license: 'MIT', url: 'https://github.com/remarkjs/remark-math' },
                    { name: 'Emmet Monaco', license: 'MIT', url: 'https://github.com/nicolo-ribaudo/emmet-monaco-es' },
                    { name: 'monaco-vim', license: 'MIT', url: 'https://github.com/nicolo-ribaudo/monaco-vim' },
                  ].map((dep) => (
                    <div key={dep.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid rgba(128,128,128,0.1)' }}>
                      <span><strong>{dep.name}</strong></span>
                      <span style={{ opacity: 0.6 }}>{dep.license}</span>
                    </div>
                  ))}
                </div>

                <h4 style={{ fontSize: 13, marginTop: 20, marginBottom: 8, opacity: 0.9 }}>Backend (Rust crates)</h4>
                <div style={{ fontSize: 11, lineHeight: 1.8, opacity: 0.8 }}>
                  {[
                    { name: 'Tauri', license: 'MIT/Apache-2.0', url: 'https://github.com/tauri-apps/tauri' },
                    { name: 'portable-pty', license: 'MIT', url: 'https://github.com/nicolo-ribaudo/portable-pty' },
                    { name: 'tokio', license: 'MIT', url: 'https://github.com/tokio-rs/tokio' },
                    { name: 'reqwest', license: 'MIT/Apache-2.0', url: 'https://github.com/seanmonstar/reqwest' },
                    { name: 'serde / serde_json', license: 'MIT/Apache-2.0', url: 'https://github.com/serde-rs/serde' },
                    { name: 'axum', license: 'MIT', url: 'https://github.com/tokio-rs/axum' },
                    { name: 'SurrealDB', license: 'BSL 1.1', url: 'https://github.com/surrealdb/surrealdb' },
                    { name: 'parking_lot', license: 'MIT/Apache-2.0', url: 'https://github.com/Amanieu/parking_lot' },
                    { name: 'base64', license: 'MIT/Apache-2.0', url: 'https://github.com/marshallpierce/rust-base64' },
                    { name: 'regex', license: 'MIT/Apache-2.0', url: 'https://github.com/rust-lang/regex' },
                    { name: 'uuid', license: 'MIT/Apache-2.0', url: 'https://github.com/uuid-rs/uuid' },
                    { name: 'rand', license: 'MIT/Apache-2.0', url: 'https://github.com/rust-random/rand' },
                    { name: 'sysinfo', license: 'MIT', url: 'https://github.com/GuillaumeGomez/sysinfo' },
                    { name: 'arboard', license: 'MIT/Apache-2.0', url: 'https://github.com/1Password/arboard' },
                    { name: 'png', license: 'MIT/Apache-2.0', url: 'https://github.com/image-rs/image-png' },
                    { name: 'screenshots', license: 'MIT/Apache-2.0', url: 'https://github.com/nicolo-ribaudo/screenshots-rs' },
                    { name: 'tower', license: 'MIT', url: 'https://github.com/tower-rs/tower' },
                    { name: 'futures', license: 'MIT/Apache-2.0', url: 'https://github.com/rust-lang/futures-rs' },
                    { name: 'libc', license: 'MIT/Apache-2.0', url: 'https://github.com/rust-lang/libc' },
                  ].map((dep) => (
                    <div key={dep.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid rgba(128,128,128,0.1)' }}>
                      <span><strong>{dep.name}</strong></span>
                      <span style={{ opacity: 0.6 }}>{dep.license}</span>
                    </div>
                  ))}
                </div>

                <h4 style={{ fontSize: 13, marginTop: 20, marginBottom: 8, opacity: 0.9 }}>Bundled Content</h4>
                <div style={{ fontSize: 11, lineHeight: 1.8, opacity: 0.8 }}>
                  {[
                    { name: 'Agency Agents (페르소나 라이브러리)', license: 'MIT © 2025 AgentLand Contributors', url: 'https://github.com/msitarzewski/agency-agents' },
                    { name: 'agency-agents-zh (페르소나 중국 확장)', license: 'MIT', url: 'https://github.com/jnMetaCode/agency-agents-zh' },
                    { name: 'SEO/GEO Claude Skills', license: 'Apache-2.0 © aaron-he-zhu', url: 'https://github.com/aaron-he-zhu/seo-geo-claude-skills' },
                    { name: 'Nanum Gothic Coding (폰트)', license: 'OFL-1.1', url: 'https://github.com/fontsource/font-files' },
                    { name: 'Source Code Pro (폰트)', license: 'OFL-1.1', url: 'https://github.com/fontsource/font-files' },
                  ].map((dep) => (
                    <div key={dep.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid rgba(128,128,128,0.1)' }}>
                      <span><strong>{dep.name}</strong></span>
                      <span style={{ opacity: 0.6 }}>{dep.license}</span>
                    </div>
                  ))}
                </div>

                <h4 style={{ fontSize: 13, marginTop: 20, marginBottom: 8, opacity: 0.9 }}>Dev Dependencies</h4>
                <div style={{ fontSize: 11, lineHeight: 1.8, opacity: 0.8 }}>
                  {[
                    { name: 'TypeScript', license: 'Apache-2.0', url: 'https://github.com/microsoft/TypeScript' },
                    { name: 'ESLint', license: 'MIT', url: 'https://github.com/eslint/eslint' },
                  ].map((dep) => (
                    <div key={dep.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid rgba(128,128,128,0.1)' }}>
                      <span><strong>{dep.name}</strong></span>
                      <span style={{ opacity: 0.6 }}>{dep.license}</span>
                    </div>
                  ))}
                </div>

                <p style={{ fontSize: 10, opacity: 0.5, marginTop: 20, lineHeight: 1.6 }}>
                  {t('settings.about.oss.footer1')}<br />
                  {t('settings.about.oss.footer2')}<br />
                  {t('settings.about.oss.footer3')}
                </p>
              </div>
            </div>
          )}

          </div>
        </div>
      </div>
    </div>
  );
}

export function getAgentSettings(): AgentSettings {
  return { ...getConfigSnapshot().agent };
}

export function getTerminalSettings(): TerminalSettings {
  const t = getConfigSnapshot().terminal;
  return { ...t, fontSize: clampTerminalFontSize(t.fontSize) };
}

export function getOperationRules(): { activeRules: string[]; customRules: string; compiledRules: string } {
  const { customRules } = getConfigSnapshot().operationRules;
  const compiledRules = customRules.trim();
  return { activeRules: [], customRules, compiledRules };
}

export function getNoteTemplates(): NoteTemplate[] {
  return [...getConfigSnapshot().noteTemplates];
}

export function getEditorSettings(): EditorSettings {
  const e = getConfigSnapshot().editor;
  return { ...e, fontSize: clampEditorFontSize(e.fontSize) };
}

// Address of the user's own agent dashboard (toolbar "Dashboard" button).
// Same storage as the overlay's URL bar, see src/dashboard/dashboardUrl.ts.
function DashboardUrlSetting({ t }: { t: (key: TranslationKey, fallback?: string) => string }) {
  const [draft, setDraft] = useState(() => loadDashboardUrl());
  const [status, setStatus] = useState<'idle' | 'saved' | 'invalid'>('idle');
  const save = () => {
    const next = normalizeDashboardUrl(draft);
    if (!next) { setStatus('invalid'); return; }
    saveDashboardUrl(next);
    setDraft(next);
    setStatus('saved');
  };
  return (
    <div className="settings-group">
      <h3>{t('settings.dashboard.title')}</h3>
      <span className="setting-description">{t('settings.dashboard.desc')}</span>
      <div className="setting-item">
        <label htmlFor="dashboard-url-setting">{t('settings.dashboard.url')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            id="dashboard-url-setting"
            type="text"
            value={draft}
            placeholder={DEFAULT_DASHBOARD_URL}
            spellCheck={false}
            onChange={(e) => { setDraft(e.target.value); setStatus('idle'); }}
            onBlur={() => { if (normalizeDashboardUrl(draft)) save(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
            style={{ flex: '1 1 260px' }}
          />
          <button type="button" className="btn-toolbar" onClick={save}>{t('settings.dashboard.save')}</button>
          {status === 'saved' && <span className="setting-description">{t('settings.dashboard.saved')}</span>}
        </div>
        {status === 'invalid' && <span className="setting-description" style={{ color: '#f38ba8' }}>{t('settings.dashboard.invalid')}</span>}
      </div>
    </div>
  );
}
