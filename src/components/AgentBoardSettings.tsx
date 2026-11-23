// Settings group "Agent team board" (config.json `agents.board`): usage type (SQLite only,
// both with sync, PostgreSQL only), the PostgreSQL connection fields, a write-only password,
// Test connection, Create / upgrade tables (shows the statements before running them),
// Copy data in a direction the person picks, Clean up old teams on the server (count first,
// then a confirmation) and a status line. Rendered in the agent tab of SettingsPanel.
// The fourth usage type, "Board server", has its own section (BoardServerSettings.tsx); in that
// type the controls the host refuses there (sync, machine name, Copy data, Clean up) are hidden.
//
// The connection fields are a draft: nothing reaches config.json (and so the live store)
// until Apply, so a half-typed host never becomes the board. Test / Create / Copy / Clean up
// send the draft to the host (src-tauri/src/agent_board/admin.rs); the password always comes
// from the 0600 secret file and is only used for the server it was saved for, so these
// buttons wait while a typed password is not saved yet. The password never comes back.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useConfig } from '../config/ConfigContext';
import { emitAgentBoardEvent } from '../terminal/agentBoard';
import { useSyncStatus } from '../teamStatus/source';
import { BoardServerSettings, useBoardServer } from './BoardServerSettings';
import { useTranslation, type TranslationKey } from '../i18n';
import {
  BOARD_MODES,
  SSL_MODES,
  copySource,
  draftFromPg,
  fillText,
  missingPgFields,
  nextStep,
  normalizeBoardPg,
  parsePgDraft,
  pgLabel,
  readBoardMode,
  readBoardModeSetting,
  sameDraft,
  type BoardMode,
  type BoardModeSetting,
  type BoardPgSettings,
  type NextStep,
  type PgDraft,
  type PgTestResult,
  checkMachineName,
  normalizeRestorePreview,
  normalizeSyncStatus,
  needsTableUpgrade,
  parseBoardRefusal,
  type RestorePreview,
  type SyncStatus,
} from '../terminal/agentBoardStorage';

interface BoardStatus {
  mode: BoardModeSetting;
  modeWarning?: string | null;
  backend: 'sqlite' | 'postgres' | 'server';
  envOverride: boolean;
  passwordSaved: boolean;
  passwordFor?: string | null;
  target?: string;
  schema?: string;
  schemaVersion?: number | null;
  codeVersion?: number;
  counts?: { teams: number; posts: number; tasks: number };
  lastError?: { at: number; error: string } | null;
  error?: string;
  /** Usage type `server`: the configured address (no network read). */
  server?: { server?: string };
}

interface MigratePlan {
  schema: string;
  from: number | null;
  to: number;
  steps: Array<{ version: number; description: string; sql: string[] }>;
  upToDate: boolean;
  applied: boolean;
}

interface CopyResult {
  teams: number;
  posts: number;
  tasks: number;
  skippedTeams: string[];
}

type CopyFrom = 'sqlite' | 'postgres';

const MODE_KEYS: Record<BoardModeSetting, [TranslationKey, TranslationKey]> = {
  sqlite: ['settings.agentBoard.mode.sqlite', 'settings.agentBoard.mode.sqlite.desc'],
  sync: ['settings.agentBoard.mode.sync', 'settings.agentBoard.mode.sync.desc'],
  postgres: ['settings.agentBoard.mode.postgres', 'settings.agentBoard.mode.postgres.desc'],
  server: ['settings.agentBoard.mode.server', 'settings.agentBoard.mode.server.desc'],
};

const MODE_CHOICES: readonly BoardModeSetting[] = [...BOARD_MODES, 'server'];

const NEXT_KEYS: Record<NextStep, TranslationKey> = {
  checkConnection: 'settings.agentBoard.next.checkConnection',
  updateApp: 'settings.agentBoard.next.updateApp',
  emptySchema: 'settings.agentBoard.next.emptySchema',
  createTables: 'settings.agentBoard.next.createTables',
  askOwner: 'settings.agentBoard.next.askOwner',
  upgradeTables: 'settings.agentBoard.next.upgradeTables',
  askPrivileges: 'settings.agentBoard.next.askPrivileges',
  ready: 'settings.agentBoard.next.ready',
};

// The panel's own color pattern (reads in light and dark themes).
const DANGER = 'color-mix(in srgb, #ef4444 75%, var(--settings-text) 25%)';
const WARN = 'color-mix(in srgb, #f59e0b 75%, var(--settings-text) 25%)';

const monoBox: CSSProperties = {
  marginTop: 6,
  padding: '8px 10px',
  borderRadius: 'var(--brutal-radius)',
  border: '1px solid color-mix(in srgb, var(--settings-text) 12%, transparent)',
  background: 'color-mix(in srgb, var(--settings-bg) 80%, #000 20%)',
  color: 'var(--settings-text)',
  fontSize: 11,
  fontFamily: "'SF Mono', 'Fira Code', monospace",
  whiteSpace: 'pre-wrap',
  maxHeight: 220,
  overflow: 'auto',
};

const ID = 'agent-board';

/** Every refusal code the host's restore and takeover commands send (a test checks this
 * against the Rust source); each has `settings.agentBoard.restore.refused.<code>`. */
export const RESTORE_REFUSAL_CODES = [
  'sync_off', 'settings', 'local', 'error', 'unsent', 'host_alive', 'takeover_needed', 'nothing', 'upgrade_tables', 'server_newer',
  'not_copy', 'team_gone', 'already_home', 'same_team_here', 'changed', 'home_alive',
] as const;

export function AgentBoardSettings() {
  const { config, updateConfig } = useConfig();
  const { t } = useTranslation();
  const board = (config.agents?.board ?? {}) as Record<string, unknown>;
  const mode = readBoardMode(board);
  // `server` (board server): its own section; leaving it always asks first (and offers to sign
  // out while signed in), so the usage type is never dropped silently.
  const modeSetting = readBoardModeSetting(board);
  const serverMode = modeSetting === 'server';
  const serverCfg = (board.server && typeof board.server === 'object' ? board.server : {}) as Record<string, unknown>;
  const savedServerUrl = typeof serverCfg.url === 'string' ? serverCfg.url : '';
  const boardServer = useBoardServer(serverMode, savedServerUrl);
  const [leaveAsk, setLeaveAsk] = useState<BoardMode | null>(null);
  const leaveFirst = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (leaveAsk !== null) leaveFirst.current?.focus();
  }, [leaveAsk]);
  const saved = normalizeBoardPg(board.postgres);
  const savedDraft = draftFromPg(saved);
  const [draft, setDraft] = useState<PgDraft>(savedDraft);
  const [status, setStatus] = useState<BoardStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [plan, setPlan] = useState<{ plan: MigratePlan; pg: BoardPgSettings } | null>(null);
  const [cleanupAsk, setCleanupAsk] = useState<{ count: number; pg: BoardPgSettings } | null>(null);
  const [merge, setMerge] = useState(false);
  const [copyFrom, setCopyFrom] = useState<CopyFrom>(copySource(mode));
  const statusSeq = useRef(0);
  const [syncNonce, setSyncNonce] = useState(0);
  const busyRef = useRef(false);
  // Sync status: polled while syncing (keyed on the usage type), read once otherwise; a
  // "Sync now" answer is shown until the next poll replaces it.
  const polled = useSyncStatus(isTauri() ? () => invoke('agent_board_sync_status') : undefined, { key: `${mode}|${syncNonce}`, poll: mode === 'sync' });
  const [fresh, setFresh] = useState<SyncStatus | null>(null);
  useEffect(() => setFresh(null), [polled]);
  const sync: SyncStatus | null = fresh ?? polled;
  const setSync = setFresh;
  const [nameDraft, setNameDraft] = useState<string>(typeof board.hostName === 'string' ? board.hostName : '');
  const [removeAsk, setRemoveAsk] = useState<number | null>(null);
  // Stage 3c: "Restore my teams from the server" shows what would come down first.
  const [restoreAsk, setRestoreAsk] = useState<RestorePreview | null>(null);
  const [takeoverOk, setTakeoverOk] = useState(false);

  // A saved change elsewhere (or Revert) replaces an untouched draft.
  const savedKey = JSON.stringify(savedDraft);
  const lastSaved = useRef(savedKey);
  useEffect(() => {
    if (lastSaved.current === savedKey) return;
    const prevSaved = JSON.parse(lastSaved.current) as PgDraft;
    lastSaved.current = savedKey;
    setDraft((d) => (sameDraft(d, prevSaved) ? (JSON.parse(savedKey) as PgDraft) : d));
  }, [savedKey]);

  useEffect(() => setCopyFrom(copySource(mode)), [mode]);

  // A plan or a cleanup question belongs to the fields it was made for.
  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    setPlan(null);
    setCleanupAsk(null);
  }, [draftKey]);

  const refresh = useCallback(() => {
    if (!isTauri()) return;
    const seq = ++statusSeq.current;
    invoke<BoardStatus>('agent_board_settings_status')
      .then((s) => {
        if (seq !== statusSeq.current) return;
        setStatus(s);
        setStatusError(null);
      })
      .catch((e) => {
        if (seq !== statusSeq.current) return;
        setStatusError(String(e));
      });
  }, []);

  // The raw usage type: SQLite ↔ Board server both read as `sqlite` in `mode`.
  const statusKey = `${modeSetting}|${savedKey}`;
  useEffect(() => {
    const timer = window.setTimeout(refresh, 800);
    return () => window.clearTimeout(timer);
  }, [statusKey, refresh]);

  const parsed = parsePgDraft(draft);
  const pg: BoardPgSettings | null = parsed.ok ? parsed.value : null;
  const dirty = !sameDraft(draft, savedDraft);
  const envOverride = status?.envOverride ?? false;
  const missing = envOverride || !pg ? [] : missingPgFields(pg);
  const pgUsable = !!pg && missing.length === 0;
  const savedMissing = envOverride ? [] : missingPgFields(saved);
  const passwordUnsaved = password.length > 0;
  const passwordForOther = !envOverride && !!pg && !!status?.passwordSaved && !!status.passwordFor && status.passwordFor !== pgLabel(pg);
  const canRun = pgUsable && !passwordUnsaved && busy === null;

  const setField = <K extends keyof PgDraft>(key: K, value: PgDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const applyDraft = () => {
    if (!pg) return;
    updateConfig((prev) => ({ ...prev, agents: { ...prev.agents, board: { ...prev.agents.board, postgres: { ...pg } } } }));
    setMessage({ ok: true, lines: [t('settings.agentBoard.pg.applied')] });
  };

  const writeMode = (next: BoardModeSetting) =>
    updateConfig((prev) => {
      const b: typeof prev.agents.board = { ...prev.agents.board, mode: next };
      delete b.backend;
      return { ...prev, agents: { ...prev.agents, board: b } };
    });

  const setMode = (next: BoardModeSetting) => {
    if (next === modeSetting) return;
    if (next === 'server') {
      // Nothing is copied: local (or PostgreSQL) teams stay where they are.
      if (!window.confirm(t('settings.agentBoard.mode.serverEnter'))) return;
      setLeaveAsk(null);
      writeMode('server');
      return;
    }
    if (next === 'postgres' && !envOverride && (dirty || savedMissing.length > 0)) {
      setMessage({ ok: false, lines: [t(dirty ? 'settings.agentBoard.mode.applyFirst' : 'settings.agentBoard.mode.fieldsMissing')] });
      return;
    }
    if (serverMode) {
      // Leaving the board server: ask first (and offer to sign out while signed in).
      setLeaveAsk(next);
      return;
    }
    writeMode(next);
  };

  const saveServerUrl = (origin: string) =>
    updateConfig((prev) => {
      const old = prev.agents.board.server;
      const server = { ...(old && typeof old === 'object' ? (old as Record<string, unknown>) : {}), url: origin };
      return { ...prev, agents: { ...prev.agents, board: { ...prev.agents.board, server } } };
    });

  const leave = (signOut: boolean) =>
    leaveAsk &&
    run('leave', async () => {
      const next = leaveAsk;
      if (signOut) {
        try {
          await invoke('board_server_sign_out', { localOnly: false });
        } catch (e) {
          // Nothing changes when the server could not be asked (the person decides again).
          setLeaveAsk(null);
          boardServer.reload();
          throw e;
        }
      }
      setLeaveAsk(null);
      writeMode(next);
      if (signOut) setMessage({ ok: true, lines: [t('settings.agentBoard.server.signedOutNow')] });
    });

  const run = async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    // One action at a time (a second click while one runs does nothing).
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(label);
    setMessage(null);
    try {
      return await fn();
    } catch (e) {
      setMessage({ ok: false, lines: [e instanceof Error ? e.message : String(e)] });
      return null;
    } finally {
      busyRef.current = false;
      setBusy(null);
      refresh();
    }
  };

  const savePassword = () =>
    pg &&
    run('password', async () => {
      await invoke('agent_board_secret_save', { password, postgres: pg });
      setPassword('');
      setMessage({ ok: true, lines: [fillText(t('settings.agentBoard.password.savedNow'), { target: pgLabel(pg) })] });
    });

  const clearPassword = () =>
    run('password', async () => {
      await invoke('agent_board_secret_clear');
      setMessage({ ok: true, lines: [t('settings.agentBoard.password.cleared')] });
    });

  const testConnection = () =>
    pg &&
    run('test', async () => {
      const r = await invoke<PgTestResult>('agent_board_pg_test', { postgres: pg });
      const lines: string[] = [];
      if (!r.reachable) {
        lines.push(t('settings.agentBoard.test.unreachable'));
      } else {
        lines.push(`${t('settings.agentBoard.test.reachable')} — ${r.user ?? ''} · ${r.target ?? ''}`);
        if (r.serverVersion) lines.push(fillText(t('settings.agentBoard.test.server'), { v: r.serverVersion }));
        lines.push(t(r.tls ? 'settings.agentBoard.test.tlsOn' : 'settings.agentBoard.test.tlsOff'));
        if (r.tlsWarning) lines.push(t('settings.agentBoard.test.tlsWarning'));
        const schema = r.schema ?? pg.schema;
        if (!r.schemaExists) lines.push(fillText(t('settings.agentBoard.test.schemaMissing'), { schema }));
        else if (r.schemaVersion == null) lines.push(fillText(t('settings.agentBoard.test.schemaEmpty'), { schema }));
        else lines.push(fillText(t('settings.agentBoard.test.schemaVersion'), { schema, v: r.schemaVersion }));
        if (r.foreignTables && r.foreignTables.length > 0) lines.push(fillText(t('settings.agentBoard.test.foreign'), { tables: r.foreignTables.join(', ') }));
        lines.push(t(r.canCreate ? 'settings.agentBoard.test.canCreate' : 'settings.agentBoard.test.cannotCreate'));
        if (r.canReadWrite != null) lines.push(t(r.canReadWrite ? 'settings.agentBoard.test.canReadWrite' : 'settings.agentBoard.test.cannotReadWrite'));
      }
      if (r.error) lines.push(r.error);
      const next = nextStep(r);
      lines.push(fillText(t('settings.agentBoard.next'), { next: t(NEXT_KEYS[next]) }));
      setMessage({ ok: next === 'ready' && !r.tlsWarning, lines });
    });

  const previewMigrate = () =>
    pg &&
    run('migrate', async () => {
      const used = { ...pg };
      const p = await invoke<MigratePlan>('agent_board_pg_migrate', { postgres: used, apply: false });
      if (p.upToDate) {
        setPlan(null);
        setMessage({ ok: true, lines: [fillText(t('settings.agentBoard.migrate.upToDate'), { v: p.to })] });
      } else {
        setPlan({ plan: p, pg: used });
      }
    });

  // Runs exactly what was previewed: the same fields, never the ones typed since.
  const applyMigrate = () =>
    plan &&
    run('migrate', async () => {
      const p = await invoke<MigratePlan>('agent_board_pg_migrate', { postgres: plan.pg, apply: true });
      setPlan(null);
      setMessage({ ok: true, lines: [fillText(t(p.applied ? 'settings.agentBoard.migrate.done' : 'settings.agentBoard.migrate.upToDate'), { v: p.to })] });
    });

  const copyData = () =>
    pg &&
    run('copy', async () => {
      const r = await invoke<CopyResult>('agent_board_copy', { from: copyFrom, merge, postgres: pg });
      const lines = [fillText(t('settings.agentBoard.copy.done'), { teams: r.teams, posts: r.posts, tasks: r.tasks })];
      if (r.skippedTeams.length > 0) lines.push(fillText(t('settings.agentBoard.copy.skipped'), { teams: r.skippedTeams.join(', ') }));
      setMessage({ ok: true, lines });
    });

  const askCleanup = () =>
    pg &&
    run('cleanup', async () => {
      const used = { ...pg };
      const r = await invoke<{ wouldRetire: number }>('agent_board_pg_cleanup', { postgres: used, apply: false });
      if (r.wouldRetire === 0) setMessage({ ok: true, lines: [t('settings.agentBoard.cleanup.none')] });
      else setCleanupAsk({ count: r.wouldRetire, pg: used });
    });

  const runCleanup = () =>
    cleanupAsk &&
    run('cleanup', async () => {
      const r = await invoke<{ retired: number }>('agent_board_pg_cleanup', { postgres: cleanupAsk.pg, apply: true });
      setCleanupAsk(null);
      setMessage({ ok: true, lines: [fillText(t('settings.agentBoard.cleanup.done'), { n: r.retired })] });
    });

  const statusLine = (() => {
    if (!status) return statusError ? t('settings.agentBoard.status.failed') : '…';
    const parts: string[] = [];
    if (status.backend === 'server') return fillText(t('settings.agentBoard.status.server'), { server: status.server?.server || '-' });
    parts.push(status.backend === 'postgres' ? fillText(t('settings.agentBoard.status.postgres'), { target: status.target ?? '' }) : t('settings.agentBoard.status.sqlite'));
    if (status.schemaVersion != null) parts.push(fillText(t('settings.agentBoard.status.schema'), { v: status.schemaVersion }));
    else if (status.backend === 'postgres' && !status.error) parts.push(t('settings.agentBoard.status.noTables'));
    if (status.counts) parts.push(fillText(t('settings.agentBoard.status.counts'), status.counts));
    return parts.join(' · ');
  })();

  const disabled = busy !== null;

  // ── Sync (usage type "Both (sync)") ──
  const savedName = typeof board.hostName === 'string' ? board.hostName : '';
  useEffect(() => setNameDraft(savedName), [savedName]);
  const nameCheck = checkMachineName(nameDraft);
  const saveName = () =>
    run('name', async () => {
      if (!nameCheck.ok) throw new Error(t('settings.agentBoard.hostName.invalid'));
      let r: { host: string };
      try {
        r = await invoke<{ host: string }>('agent_board_check_host_name', { name: nameCheck.value });
      } catch (e) {
        throw new Error(refusalText(e));
      }
      updateConfig((prev) => {
        const b: typeof prev.agents.board = { ...prev.agents.board };
        if (nameCheck.value) b.hostName = nameCheck.value;
        else delete b.hostName;
        return { ...prev, agents: { ...prev.agents, board: b } };
      });
      setMessage({ ok: true, lines: [fillText(t('settings.agentBoard.hostName.saved'), { name: r.host })] });
    });
  const syncNow = () =>
    run('sync', async () => {
      const raw = await invoke<Record<string, unknown>>('agent_board_sync_now');
      const r = normalizeSyncStatus(raw);
      setSync(r);
      setMessage(r?.ok
        ? { ok: true, lines: [fillText(t('settings.agentBoard.sync.nowDone'), { pushed: Number(raw?.pushed ?? 0), pulled: Number(raw?.pulled ?? 0) })] }
        : { ok: false, lines: [fillText(t('settings.agentBoard.sync.nowFailed'), { e: r?.lastError ?? '?' })] });
    });
  const otherTeams = (sync?.machines ?? []).reduce((n, m) => n + m.teams, 0);
  const runRemove = () =>
    run('remove', async () => {
      let r: { removed: number };
      try {
        r = await invoke<{ removed: number }>('agent_board_remove_mirrors');
      } catch (e) {
        setRemoveAsk(null);
        throw new Error(refusalText(e));
      }
      setRemoveAsk(null);
      setSyncNonce((n) => n + 1);
      // Open team views drop the removed teams at once.
      emitAgentBoardEvent({ team: '', action: 'sync' });
      setMessage({ ok: true, lines: [fillText(t('settings.agentBoard.sync.removed'), { n: r.removed })] });
    });
  const restorePreview = () =>
    run('restore', async () => {
      let raw: unknown;
      try {
        raw = await invoke('agent_board_restore_preview');
      } catch (e) {
        const r = parseBoardRefusal(e);
        throw new Error(r.code ? refusalText(e) : fillText(t('settings.agentBoard.restore.previewFailed'), { e: r.message }));
      }
      const preview = normalizeRestorePreview(raw);
      // An answer that cannot be read is an error, never an empty dialog.
      if (!preview) throw new Error(fillText(t('settings.agentBoard.restore.previewFailed'), { e: '?' }));
      setTakeoverOk(false);
      setRestoreAsk(preview);
    });
  const runRestore = () =>
    run('restore', async () => {
      let r: Record<string, number>;
      try {
        r = await invoke<Record<string, number>>('agent_board_restore', { takeover: takeoverOk });
      } catch (e) {
        throw new Error(refusalText(e));
      } finally {
        setRestoreAsk(null);
      }
      setSyncNonce((n) => n + 1);
      emitAgentBoardEvent({ team: '', action: 'sync' });
      setMessage({ ok: true, lines: [fillText(t('settings.agentBoard.restore.done'), { teams: r.teams ?? 0, tasks: r.tasks ?? 0, notes: r.notes ?? 0, kept: r.keptNewer ?? 0 })] });
    });
  // Host refusals carry a stable code; shown in the person's language.
  const refusalText = (e: unknown): string => {
    const r = parseBoardRefusal(e);
    const known: Record<string, TranslationKey> = {
      env_set: 'settings.agentBoard.hostName.refused.env_set',
      invalid: 'settings.agentBoard.hostName.refused.invalid',
      live_teams: 'settings.agentBoard.hostName.refused.live_teams',
      sync_on: 'settings.agentBoard.sync.removeOnlyOff',
      ...Object.fromEntries(RESTORE_REFUSAL_CODES.map((c) => [c, `settings.agentBoard.restore.refused.${c}` as TranslationKey])),
    };
    return known[r.code] ? fillText(t(known[r.code]), { ...r.vars, message: r.message }) : r.message;
  };
  const syncProblem = (st: SyncStatus): string | null => {
    if (st.lastErrorCode === 'replaced') return fillText(t('settings.agentBoard.sync.replaced'), { host: st.host, n: st.waiting });
    if (st.lastErrorCode === 'name_changed') return t('settings.agentBoard.sync.nameChanged');
    if (st.lastErrorCode === 'name_taken') return t('settings.agentBoard.sync.nameTaken');
    if (st.lastErrorCode === 'agents_disabled') return t('settings.agentBoard.sync.agentsDisabled');
    return st.lastError ?? null;
  };
  const syncTime = (ms?: number | null) => (ms ? new Date(ms).toLocaleString() : t('settings.agentBoard.sync.never'));
  const blockHint = !pg
    ? null
    : passwordUnsaved
      ? t('settings.agentBoard.password.unsavedHint')
      : passwordForOther
        ? fillText(t('settings.agentBoard.password.otherServer'), { target: status?.passwordFor ?? '' })
        : null;

  const field = (key: 'host' | 'database' | 'user' | 'schema', label: TranslationKey, extra?: { placeholder?: string; autoComplete?: string }) => (
    <div className="setting-item">
      <label htmlFor={`${ID}-${key}`}>{t(label)}</label>
      <input
        id={`${ID}-${key}`}
        type="text"
        value={draft[key]}
        maxLength={key === 'host' ? 255 : 63}
        placeholder={extra?.placeholder}
        autoComplete={extra?.autoComplete ?? 'off'}
        onChange={(e) => setField(key, e.target.value)}
      />
    </div>
  );

  return (
    <div className="settings-group">
      <h3>{t('settings.agentBoard.title')}</h3>
      <span className="setting-description" style={{ display: 'block', marginBottom: 8 }}>
        {t('settings.agentBoard.desc')}
      </span>

      <div className="setting-item" style={{ alignItems: 'flex-start' }}>
        <span id={`${ID}-usage`} style={{ fontWeight: 600, fontSize: 13 }}>
          {t('settings.agentBoard.usage')}
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} role="radiogroup" aria-labelledby={`${ID}-usage`}>
          {MODE_CHOICES.map((m) => (
            <label key={m} htmlFor={`${ID}-mode-${m}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontWeight: 'normal' }}>
              <input id={`${ID}-mode-${m}`} type="radio" name={`${ID}-mode`} checked={modeSetting === m} disabled={busy === 'leave'} onChange={() => setMode(m)} style={{ marginTop: 3 }} />
              <span>
                <span style={{ fontWeight: 600 }}>{t(MODE_KEYS[m][0])}</span>
                <span className="setting-description" style={{ display: 'block' }}>
                  {t(MODE_KEYS[m][1])}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
      {leaveAsk !== null && (
        <div style={{ ...monoBox, fontFamily: 'inherit', fontSize: 12 }} role="alertdialog"
          aria-label={t('settings.agentBoard.usage')}
          data-testid="agent-board-server-leave"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !busyRef.current) {
              e.stopPropagation();
              setLeaveAsk(null);
            }
          }}
        >
          <div style={{ color: WARN }}>{t('settings.agentBoard.mode.serverLeave')}</div>
          {boardServer.status?.signedIn && (
            <div style={{ color: WARN, marginTop: 4 }}>
              {fillText(t('settings.agentBoard.mode.serverLeaveSignedIn'), { server: boardServer.status.signedInServer ?? '-', n: boardServer.status.heldTasks })}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {boardServer.status?.signedIn ? (
              <>
                <button ref={leaveFirst} type="button" className="btn-secondary" disabled={disabled} onClick={() => leave(true)}>
                  {busy === 'leave' ? t('settings.agentBoard.working') : t('settings.agentBoard.mode.serverLeaveSignOut')}
                </button>
                <button type="button" className="btn-secondary" disabled={disabled} onClick={() => leave(false)}>
                  {t('settings.agentBoard.mode.serverLeaveKeep')}
                </button>
              </>
            ) : (
              <button ref={leaveFirst} type="button" className="btn-secondary" disabled={disabled} onClick={() => leave(false)}>
                {t('settings.agentBoard.mode.serverLeaveYes')}
              </button>
            )}
            <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setLeaveAsk(null)}>
              {t('settings.agentBoard.cancel')}
            </button>
          </div>
        </div>
      )}
      {status?.modeWarning && (
        <span className="setting-description" style={{ display: 'block', color: WARN }}>
          {t('settings.agentBoard.mode.unknown')}
        </span>
      )}

      {serverMode && (
        <BoardServerSettings server={boardServer} savedUrl={savedServerUrl} onSaveUrl={saveServerUrl} defaultComputer={sync?.host ?? ''} />
      )}

      {!serverMode && (
      <div className="setting-item">
        <label htmlFor={`${ID}-host-name`} style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.agentBoard.hostName')}</label>
        {sync?.hostSource === 'env' ? (
          <span className="setting-description">{fillText(t('settings.agentBoard.hostName.env'), { name: sync.host })}</span>
        ) : (
          <span style={{ display: 'flex', gap: 6 }}>
            <input id={`${ID}-host-name`} type="text" value={nameDraft} maxLength={120} placeholder={sync?.hostSource === 'system' ? sync.host : ''} onChange={(e) => setNameDraft(e.target.value)} />
            <button type="button" className="btn-secondary" disabled={disabled || !nameCheck.ok || nameDraft.trim() === savedName} onClick={saveName}>
              {t('settings.agentBoard.hostName.save')}
            </button>
          </span>
        )}
        <span className="setting-description">{fillText(t('settings.agentBoard.hostName.desc'), { system: sync?.hostSource === 'system' ? sync.host : '-' })}</span>
      </div>
      )}

      {!serverMode && (mode === 'sync' || otherTeams > 0) && (
        <div className="setting-item" data-testid="agent-board-sync" style={{ alignItems: 'flex-start' }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.agentBoard.sync.title')}</span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {mode === 'sync' && sync && (
              <>
                <span role="status">{fillText(t('settings.agentBoard.sync.state'), { state: t(`settings.agentBoard.sync.state.${sync.state}` as TranslationKey) })}</span>
                <span className="setting-description">{fillText(t('settings.agentBoard.sync.times'), { push: syncTime(sync.lastPushAt), pull: syncTime(sync.lastPullAt) })}</span>
                <span className="setting-description">{fillText(t('settings.agentBoard.sync.counts'), { waiting: sync.waiting, skipped: sync.skipped })}</span>
                {sync.fullPush && <span className="setting-description">{t('settings.agentBoard.sync.fullPush')}</span>}
                {sync.refused > 0 && (
                  <span className="setting-description" style={{ color: WARN }}>
                    {fillText(t('settings.agentBoard.sync.refused'), { n: sync.refused, reason: sync.refusedReason ?? '-' })}
                  </span>
                )}
                {sync.outboxWaiting > 0 && (
                  <span className="setting-description">{fillText(t('settings.agentBoard.sync.outbox'), { n: sync.outboxWaiting })}</span>
                )}
                {sync.outboxRefused > 0 && (
                  <span className="setting-description" style={{ color: WARN }}>{fillText(t('settings.agentBoard.sync.outboxRefused'), { n: sync.outboxRefused })}</span>
                )}
                {sync.serverEvent && (
                  <span className="setting-description" style={{ color: WARN }} data-testid="agent-board-server-event">
                    {fillText(t(`settings.agentBoard.sync.${sync.serverEvent === 'server_restored' ? 'serverRestored' : 'serverReplaced'}` as TranslationKey), { time: syncTime(sync.serverEventAt) })}
                  </span>
                )}
                {sync.keptRows > 0 && (
                  <span className="setting-description" style={{ color: WARN }} data-testid="agent-board-kept">
                    {fillText(t('settings.agentBoard.sync.kept'), { n: sync.keptRows, file: sync.keptFile ?? '-' })}{' '}
                    {sync.keptFile && (
                      <button type="button" className="btn-secondary" onClick={() => void invoke('reveal_in_explorer', { path: sync.keptFile }).catch((e) => setMessage({ ok: false, lines: [String(e)] }))}>
                        {t('settings.agentBoard.sync.keptReveal')}
                      </button>
                    )}
                  </span>
                )}
                {needsTableUpgrade(sync) && (
                  <span className="setting-description" style={{ color: WARN }} data-testid="agent-board-upgrade-3c">{t('settings.agentBoard.sync.upgradeFor3c')}</span>
                )}
                {syncProblem(sync) && <span className="setting-description" style={{ color: sync.state === 'paused' ? WARN : DANGER }}>{fillText(t('settings.agentBoard.status.lastError'), { e: syncProblem(sync) ?? '' })}</span>}
              </>
            )}
            {otherTeams > 0 && (
              <span className="setting-description">
                {fillText(t('settings.agentBoard.sync.others'), { list: (sync?.machines ?? []).map((m) => `${m.host} (${m.teams})`).join(', ') })}
              </span>
            )}
            <span style={{ display: 'flex', gap: 6 }}>
              {mode === 'sync' && (
                <button type="button" className="btn-secondary" disabled={disabled} onClick={syncNow}>
                  {busy === 'sync' ? t('settings.agentBoard.working') : t('settings.agentBoard.sync.now')}
                </button>
              )}
              {mode === 'sync' && (
                <button type="button" className="btn-secondary" disabled={disabled} onClick={restorePreview}>
                  {busy === 'restore' ? t('settings.agentBoard.working') : t('settings.agentBoard.restore')}
                </button>
              )}
              {otherTeams > 0 && mode !== 'sync' && (
                <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setRemoveAsk(otherTeams)}>
                  {t('settings.agentBoard.sync.remove')}
                </button>
              )}
            </span>
            {restoreAsk !== null && (
              <div style={{ ...monoBox, fontFamily: 'inherit', fontSize: 12 }} role="alertdialog" aria-label={t('settings.agentBoard.restore')}>
                {restoreAsk.teams === 0 ? (
                  <div>{fillText(t('settings.agentBoard.restore.refused.nothing'), { host: restoreAsk.host })}</div>
                ) : (
                  <div>{fillText(t('settings.agentBoard.restore.preview'), { host: restoreAsk.host, teams: restoreAsk.teams, tasks: restoreAsk.tasks, notes: restoreAsk.notes })}</div>
                )}
                {restoreAsk.unsent > 0 && <div style={{ color: WARN }}>{fillText(t('settings.agentBoard.restore.refused.unsent'), { n: restoreAsk.unsent })}</div>}
                {restoreAsk.takeover && (
                  <div style={{ color: WARN, marginTop: 4 }}>
                    {fillText(t('settings.agentBoard.restore.takeover'), { host: restoreAsk.host, min: Math.floor(restoreAsk.takeover.ageMs / 60_000) })}
                    {restoreAsk.takeover.allowed ? (
                      <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                        <input type="checkbox" checked={takeoverOk} onChange={(e) => setTakeoverOk(e.target.checked)} />
                        {fillText(t('settings.agentBoard.restore.takeoverConfirm'), { host: restoreAsk.host })}
                      </label>
                    ) : (
                      <div>{fillText(t('settings.agentBoard.restore.takeoverWait'), { min: Math.round(restoreAsk.takeover.minAgeMs / 60_000) })}</div>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={disabled || restoreAsk.teams === 0 || restoreAsk.unsent > 0 || (!!restoreAsk.takeover && (!restoreAsk.takeover.allowed || !takeoverOk))}
                    onClick={runRestore}
                  >
                    {t('settings.agentBoard.restore.yes')}
                  </button>
                  <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setRestoreAsk(null)}>{t('settings.agentBoard.cancel')}</button>
                </div>
              </div>
            )}
            {removeAsk !== null && (
              <div style={{ ...monoBox, fontFamily: 'inherit', fontSize: 12 }} role="alertdialog" aria-label={t('settings.agentBoard.sync.remove')}>
                <div style={{ color: WARN }}>{fillText(t('settings.agentBoard.sync.removeConfirm'), { n: removeAsk })}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button type="button" className="btn-secondary" disabled={disabled} onClick={runRemove}>{t('settings.agentBoard.sync.removeYes')}</button>
                  <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setRemoveAsk(null)}>{t('settings.agentBoard.cancel')}</button>
                </div>
              </div>
            )}
          </span>
        </div>
      )}

      <h4 style={{ margin: '12px 0 4px', fontSize: 12 }}>{t('settings.agentBoard.pg.title')}</h4>
      {envOverride && (
        <span className="setting-description" style={{ display: 'block', marginBottom: 6 }}>
          {t('settings.agentBoard.pg.envOverride')}
        </span>
      )}
      {field('host', 'settings.agentBoard.pg.host', { placeholder: 'db.example.com' })}
      <div className="setting-item">
        <label htmlFor={`${ID}-port`}>{t('settings.agentBoard.pg.port')}</label>
        <input id={`${ID}-port`} type="text" inputMode="numeric" value={draft.port} maxLength={5} onChange={(e) => setField('port', e.target.value)} />
        {!parsed.ok && parsed.errors.includes('port') && <span className="setting-description" style={{ color: DANGER }}>{t('settings.agentBoard.pg.portInvalid')}</span>}
      </div>
      {field('database', 'settings.agentBoard.pg.database')}
      {field('user', 'settings.agentBoard.pg.user')}
      <div className="setting-item">
        <label htmlFor={`${ID}-ssl`}>{t('settings.agentBoard.pg.sslMode')}</label>
        <select id={`${ID}-ssl`} value={draft.sslMode} onChange={(e) => setField('sslMode', e.target.value as PgDraft['sslMode'])}>
          {SSL_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="setting-description">{t('settings.agentBoard.pg.sslDesc')}</span>
      </div>
      {field('schema', 'settings.agentBoard.pg.schema')}
      {!parsed.ok && parsed.errors.includes('schema') && (
        <span className="setting-description" style={{ display: 'block', color: DANGER }}>
          {t('settings.agentBoard.pg.schemaInvalid')}
        </span>
      )}
      {missing.length > 0 && (
        <span className="setting-description" style={{ display: 'block' }}>
          {fillText(t('settings.agentBoard.pg.missing'), { fields: missing.map((f) => t(`settings.agentBoard.pg.${f}` as TranslationKey)).join(', ') })}
        </span>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
        <button type="button" className="btn-secondary" disabled={!dirty || !pg} onClick={applyDraft}>
          {t('settings.agentBoard.pg.apply')}
        </button>
        <button type="button" className="btn-secondary" disabled={!dirty} onClick={() => setDraft(savedDraft)}>
          {t('settings.agentBoard.pg.revert')}
        </button>
        {dirty && <span className="setting-description">{t('settings.agentBoard.pg.unapplied')}</span>}
      </div>

      <div className="setting-item" style={{ marginTop: 8 }}>
        <label htmlFor={`${ID}-password`}>{t('settings.agentBoard.pg.password')}</label>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            id={`${ID}-password`}
            type="password"
            value={password}
            autoComplete="new-password"
            maxLength={1024}
            placeholder={status?.passwordSaved ? t('settings.agentBoard.password.placeholderSaved') : t('settings.agentBoard.password.placeholderNone')}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="button" className="btn-secondary" disabled={disabled || !password || !pgUsable} onClick={savePassword}>
            {t('settings.agentBoard.password.save')}
          </button>
          {status?.passwordSaved && (
            <>
              <span className="setting-description">
                {status.passwordFor ? fillText(t('settings.agentBoard.password.savedFor'), { target: status.passwordFor }) : t('settings.agentBoard.password.saved')}
              </span>
              <button type="button" className="btn-secondary" disabled={disabled} onClick={clearPassword}>
                {t('settings.agentBoard.password.clear')}
              </button>
            </>
          )}
        </span>
        <span className="setting-description">{t('settings.agentBoard.password.desc')}</span>
      </div>
      {blockHint && (
        <span className="setting-description" style={{ display: 'block', color: WARN }}>
          {blockHint}
        </span>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <button type="button" className="btn-secondary" disabled={!canRun} onClick={testConnection}>
          {busy === 'test' ? t('settings.agentBoard.working') : t('settings.agentBoard.test')}
        </button>
        <button type="button" className="btn-secondary" disabled={!canRun} onClick={previewMigrate}>
          {busy === 'migrate' ? t('settings.agentBoard.working') : t('settings.agentBoard.migrate')}
        </button>
      </div>
      {plan && (
        <div style={{ marginTop: 8 }}>
          <span className="setting-description" style={{ display: 'block' }}>
            {fillText(t('settings.agentBoard.migrate.preview'), { target: pgLabel(plan.pg), schema: plan.plan.schema, from: plan.plan.from ?? '—', to: plan.plan.to })}
          </span>
          <div style={monoBox}>{plan.plan.steps.map((s) => `-- ${s.description}\n${s.sql.join(';\n')};`).join('\n\n')}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button type="button" className="btn-secondary" disabled={disabled || passwordUnsaved} onClick={applyMigrate}>
              {t('settings.agentBoard.migrate.run')}
            </button>
            <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setPlan(null)}>
              {t('settings.agentBoard.cancel')}
            </button>
          </div>
        </div>
      )}

      {!serverMode && (
      <div className="setting-item" style={{ marginTop: 10, alignItems: 'flex-start' }}>
        <span id={`${ID}-copy`} style={{ fontWeight: 600, fontSize: 13 }}>
          {t('settings.agentBoard.copy')}
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }} role="radiogroup" aria-labelledby={`${ID}-copy`}>
          {(['sqlite', 'postgres'] as const).map((f) => (
            <label key={f} htmlFor={`${ID}-copy-${f}`} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 'normal' }}>
              <input id={`${ID}-copy-${f}`} type="radio" name={`${ID}-copy-from`} checked={copyFrom === f} onChange={() => setCopyFrom(f)} />
              {t(f === 'sqlite' ? 'settings.agentBoard.copy.toPg' : 'settings.agentBoard.copy.toSqlite')}
            </label>
          ))}
          <label htmlFor={`${ID}-merge`} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 'normal' }}>
            <input id={`${ID}-merge`} type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} />
            {t('settings.agentBoard.copy.merge')}
          </label>
          <button type="button" className="btn-secondary" style={{ alignSelf: 'flex-start' }} disabled={!canRun} onClick={copyData}>
            {busy === 'copy' ? t('settings.agentBoard.working') : t('settings.agentBoard.copy.run')}
          </button>
        </span>
        <span className="setting-description">{t('settings.agentBoard.copy.desc')}</span>
      </div>
      )}

      {!serverMode && (
      <div className="setting-item">
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.agentBoard.cleanup')}</span>
        <button type="button" className="btn-secondary" disabled={!canRun} onClick={askCleanup}>
          {busy === 'cleanup' ? t('settings.agentBoard.working') : t('settings.agentBoard.cleanup.run')}
        </button>
        <span className="setting-description">{t('settings.agentBoard.cleanup.desc')}</span>
      </div>
      )}
      {cleanupAsk && !serverMode && (
        <div style={{ ...monoBox, fontFamily: 'inherit', fontSize: 12 }} role="alertdialog" aria-label={t('settings.agentBoard.cleanup')}>
          <div style={{ color: WARN }}>{fillText(t('settings.agentBoard.cleanup.confirm'), { n: cleanupAsk.count, target: pgLabel(cleanupAsk.pg) })}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button type="button" className="btn-secondary" disabled={disabled} onClick={runCleanup}>
              {fillText(t('settings.agentBoard.cleanup.yes'), { n: cleanupAsk.count })}
            </button>
            <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setCleanupAsk(null)}>
              {t('settings.agentBoard.cancel')}
            </button>
          </div>
        </div>
      )}

      {message && (
        <div style={{ ...monoBox, color: message.ok ? 'var(--settings-text)' : DANGER }} role="status">
          {message.lines.join('\n')}
        </div>
      )}

      <div className="setting-item" style={{ marginTop: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.agentBoard.status')}</span>
        <span>
          {statusLine}
          <button
            type="button"
            className="btn-secondary"
            style={{ marginLeft: 8 }}
            disabled={disabled}
            onClick={() => {
              refresh();
              if (serverMode) boardServer.reload();
            }}
          >
            {t('settings.agentBoard.status.refresh')}
          </button>
        </span>
        {(statusError || status?.error) && (
          <span className="setting-description" style={{ color: DANGER }}>
            {statusError ?? status?.error}
          </span>
        )}
        {status?.lastError && (
          <span className="setting-description">
            {fillText(t('settings.agentBoard.status.lastError'), { e: `${new Date(status.lastError.at).toLocaleString()} ${status.lastError.error}` })}
          </span>
        )}
      </div>
    </div>
  );
}
