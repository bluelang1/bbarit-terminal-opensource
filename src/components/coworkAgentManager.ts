import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// BBARIT Cowork agent manager — owns the bbarit-agent RPC children for cowork
// sessions OUTSIDE the React tree. Claude Cowork keeps working when you look
// away; so do we: closing or switching the panel must never kill an in-flight
// turn. Components subscribe to a session handle (useSyncExternalStore) and
// unsubscribing changes nothing about the process. The manager also persists
// each session transcript to <dir>/.cowork/chat.json itself, so deliverable
// reports survive even if no panel is mounted when a turn finishes.

export interface CoworkEntry {
  id: number;
  kind: 'user' | 'assistant' | 'tool' | 'sys';
  text: string;
  toolName?: string;
  isError?: boolean;
}

export interface CoworkRunResult {
  ok: boolean;
  error?: string;
}

export interface CoworkSnapshot {
  /** stopped = no child process (lazy, or reclaimed); it respawns on the next run. */
  status: 'stopped' | 'starting' | 'idle' | 'running';
  model: string;
  streaming: string;
  thinking: string;
  queued: number;
  /** Whether the current child has already received the cowork system prompt. */
  primed: boolean;
  entries: CoworkEntry[];
}

const MAX_ENTRIES = 400;
const MAX_THINKING = 4000;
/** Live agent children across all cowork sessions; oldest idle one is reclaimed. */
const MAX_LIVE = 3;

export class CoworkAgentHandle {
  readonly dir: string;
  readonly panelId: string;
  lastUsed = Date.now();

  private snap: CoworkSnapshot = {
    status: 'stopped', model: '', streaming: '', thinking: '', queued: 0, primed: false, entries: [],
  };
  private listeners = new Set<() => void>();
  private aliveWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private idleWaiters: Array<() => void> = [];
  private runResolvers: Array<{ runId: string; resolve: (r: CoworkRunResult) => void }> = [];
  private pendingRuns: Array<{ message: string; resolve: (r: CoworkRunResult) => void }> = [];
  private remoteRunId: string | null = null;
  private pumping = false;
  private unlisten: (() => void) | null = null;
  private alive = false;
  private starting = false;
  private entryId = 1;
  private frameId = 1;
  private restored = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private language: string | undefined;

  constructor(dir: string, language?: string) {
    this.dir = dir;
    // Deterministic per session dir: after a frontend reload (HMR, window
    // refresh) the new page can re-attach to the still-running child instead
    // of orphaning it and spawning a second one.
    this.panelId = `cowork-${sessionSlug(dir)}`;
    this.language = language;
    void this.restore();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getSnapshot = (): CoworkSnapshot => this.snap;

  private patch(partial: Partial<CoworkSnapshot>) {
    this.snap = { ...this.snap, ...partial };
    for (const fn of this.listeners) fn();
  }

  private pushEntry(entry: Omit<CoworkEntry, 'id'>) {
    const text = entry.text.trim();
    if (!text) return;
    this.patch({ entries: [...this.snap.entries, { ...entry, text, id: this.entryId++ }].slice(-MAX_ENTRIES) });
    this.schedulePersist();
  }

  note = (kind: CoworkEntry['kind'], text: string) => { this.pushEntry({ kind, text }); };

  // ── transcript persistence (survives panel unmounts and app restarts) ──
  private chatPath() { return `${this.dir}/.cowork/chat.json`; }

  private async restore() {
    try {
      const raw = await invoke<string>('read_file', { path: this.chatPath() });
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.entries) && this.snap.entries.length === 0) {
        const entries = parsed.entries
          .filter((e: any) => (e?.kind === 'user' || e?.kind === 'assistant' || e?.kind === 'tool' || e?.kind === 'sys')
            && typeof e?.text === 'string' && e.text.trim())
          .slice(-MAX_ENTRIES)
          .map((e: any) => ({
            kind: e.kind, text: e.text, id: this.entryId++,
            toolName: typeof e.toolName === 'string' ? e.toolName : undefined,
            isError: !!e.isError,
          }));
        if (entries.length > 0) this.patch({ entries });
      }
    } catch { /* fresh session */ }
    this.restored = true;
  }

  private schedulePersist() {
    if (!this.restored) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const payload = JSON.stringify({
        entries: this.snap.entries.map(({ kind, text, toolName, isError }) => ({ kind, text, toolName, isError })),
      });
      void invoke('write_file', { path: this.chatPath(), content: payload }).catch(() => {});
    }, 700);
  }

  // ── RPC child lifecycle ──
  private sendWithId(frame: Record<string, unknown>) {
    const id = this.frameId++;
    const line = JSON.stringify({ id, ...frame });
    return { id, promise: invoke<void>('agent_rpc_write', { panelId: this.panelId, line }) };
  }

  private send(frame: Record<string, unknown>) { return this.sendWithId(frame).promise; }

  private handleFrame(raw: string) {
    let frame: any;
    try { frame = JSON.parse(raw); } catch { return; }
    switch (frame.type) {
      case 'session':
        this.alive = true;
        this.starting = false;
        this.patch({ status: this.remoteRunId ? 'running' : 'idle' });
        void this.send({ type: 'get_state' }).catch(() => {});
        for (const waiter of this.aliveWaiters.splice(0)) waiter.resolve();
        break;
      case 'response':
        if ((frame.command === 'get_state' || frame.command === 'cycle_model') && frame.data?.model) {
          this.patch({ model: String(frame.data.model.name || frame.data.model.id || '') });
        }
        if (frame.command === 'get_messages' && Array.isArray(frame.data?.messages)) {
          this.mergeChildMessages(frame.data.messages);
        }
        break;
      case 'agent_start':
        this.remoteRunId = frame.runId == null ? null : String(frame.runId);
        this.patch({ status: 'running', streaming: '', thinking: '', queued: Math.max(0, this.runResolvers.length - 1) });
        break;
      case 'message_update': {
        const delta = frame.delta || {};
        const chunk = String(delta.text || '');
        if (!chunk) break;
        // Deltas prove a turn is in flight — after re-attaching to a live
        // child mid-turn there was no agent_start frame to tell us.
        const status = this.snap.status === 'running' ? {} : { status: 'running' as const };
        if (delta.type === 'thinking_delta') this.patch({ ...status, thinking: (this.snap.thinking + chunk).slice(-MAX_THINKING) });
        else this.patch({ ...status, streaming: this.snap.streaming + chunk });
        break;
      }
      case 'message_end': {
        const m = frame.message || {};
        const role = String(m.role || '');
        if (role === 'assistant') {
          this.pushEntry({ kind: 'assistant', text: String(m.content || ''), isError: !!(m.isError || m.is_error) });
        } else if (role === 'tool') {
          this.pushEntry({
            kind: 'tool', text: String(m.content || ''),
            toolName: String(m.tool_name || m.toolName || 'tool'),
            isError: !!(m.is_error || m.isError),
          });
        }
        break;
      }
      case 'agent_end': {
        const endedRunId = frame.runId == null ? null : String(frame.runId);
        this.remoteRunId = null;
        this.patch({ status: 'idle', streaming: '', thinking: '' });
        for (const resolve of this.idleWaiters.splice(0)) resolve();
        const index = this.runResolvers.findIndex((item) => endedRunId == null || item.runId === endedRunId);
        const current = index >= 0 ? this.runResolvers.splice(index, 1)[0] : null;
        this.patch({ queued: this.pendingRuns.length });
        if (current) current.resolve({
          ok: !frame.errorMessage && !frame.cancelled && !frame.incomplete,
          error: frame.errorMessage
            ? String(frame.errorMessage)
            : frame.cancelled
              ? 'agent cancelled'
              : frame.incomplete
                ? String(frame.stopReason || 'agent stopped before completing the task')
                : undefined,
        });
        void this.pumpRuns();
        break;
      }
      default:
        break;
    }
  }

  private onExit() {
    this.alive = false;
    this.starting = false;
    this.remoteRunId = null;
    this.patch({ status: 'stopped', streaming: '', thinking: '', queued: 0, primed: false });
    const error = new Error('agent exited');
    for (const waiter of this.aliveWaiters.splice(0)) waiter.reject(error);
    for (const resolve of this.idleWaiters.splice(0)) resolve();
    for (const item of this.runResolvers.splice(0)) item.resolve({ ok: false, error: 'agent exited' });
    for (const item of this.pendingRuns.splice(0)) item.resolve({ ok: false, error: 'agent exited' });
  }

  private async ensureStarted() {
    if (this.alive || this.starting) return;
    this.starting = true;
    this.patch({ status: 'starting', primed: false });
    reclaimIdleHandles(this);
    try {
      if (!this.unlisten) {
        this.unlisten = await listen<{ kind: string; line?: string }>(`agent-rpc-${this.panelId}`, (event) => {
          const { kind, line } = event.payload || ({} as any);
          if (kind === 'line' && line) this.handleFrame(line);
          else if (kind === 'exit') this.onExit();
        });
      }
      // agent_rpc_start itself reattaches to a live child and replays both the
      // session and any active run marker. Never infer "idle" from a successful
      // stdin write: a busy child accepts writes too.
      await invoke('agent_rpc_start', { panelId: this.panelId, workDir: this.dir, bbaritLanguage: this.language });
    } catch (e) {
      this.starting = false;
      this.patch({ status: 'stopped' });
      this.pushEntry({ kind: 'sys', text: `agent start failed: ${e}` });
      throw e;
    }
  }

  /** Rebuild the transcript from the child's own message history when it is
   *  richer than what we restored from chat.json (re-attach after reload). */
  private mergeChildMessages(messages: any[]) {
    const rebuilt: CoworkEntry[] = [];
    for (const m of messages) {
      const role = String(m?.role || '');
      let text = String(m?.content || '').trim();
      if (!text) continue;
      if (role === 'user') {
        // The primed first message carries the whole system prompt; show only
        // the actual request part.
        const marker = text.lastIndexOf('[요청]');
        if (marker >= 0) text = text.slice(marker + '[요청]'.length).trim();
        rebuilt.push({ id: this.entryId++, kind: 'user', text });
      } else if (role === 'assistant') {
        rebuilt.push({ id: this.entryId++, kind: 'assistant', text, isError: !!(m.isError || m.is_error) });
      } else if (role === 'tool') {
        rebuilt.push({
          id: this.entryId++, kind: 'tool', text,
          toolName: String(m.tool_name || m.toolName || 'tool'),
          isError: !!(m.is_error || m.isError),
        });
      }
    }
    if (rebuilt.length > this.snap.entries.length) {
      this.patch({ entries: rebuilt.slice(-MAX_ENTRIES) });
      this.schedulePersist();
    }
  }

  private waitAlive() {
    return new Promise<void>((resolve, reject) => {
      if (this.alive) resolve();
      else this.aliveWaiters.push({ resolve, reject });
    });
  }

  private async waitIdle() {
    const snapshot = await invoke<{ alive: boolean; running: boolean; runId?: string | number | null }>('agent_rpc_status', { panelId: this.panelId });
    if (!snapshot.running) return;
    this.remoteRunId = snapshot.runId == null ? null : String(snapshot.runId);
    this.patch({ status: 'running' });
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  isBusy() { return this.snap.status === 'running' || this.runResolvers.length > 0 || this.pendingRuns.length > 0; }

  private async pumpRuns() {
    if (this.pumping || this.runResolvers.length > 0 || this.pendingRuns.length === 0) return;
    this.pumping = true;
    try {
      try {
        await this.ensureStarted();
        await this.waitAlive();
        await this.waitIdle();
      } catch (error) {
        const queued = this.pendingRuns.splice(0);
        this.patch({ queued: 0 });
        for (const item of queued) item.resolve({ ok: false, error: String(error) });
        return;
      }
      if (this.runResolvers.length > 0 || this.pendingRuns.length === 0) return;
      this.starting = false;
      this.patch({ primed: true });
      const next = this.pendingRuns.shift()!;
      const request = this.sendWithId({ type: 'prompt', message: next.message });
      this.runResolvers.push({ runId: String(request.id), resolve: next.resolve });
      this.patch({ queued: this.pendingRuns.length });
      void request.promise.catch((error) => {
        const index = this.runResolvers.findIndex((item) => item.runId === String(request.id));
        const current = index >= 0 ? this.runResolvers.splice(index, 1)[0] : null;
        current?.resolve({ ok: false, error: String(error) });
        this.patch({ status: 'idle', queued: this.pendingRuns.length });
        void this.pumpRuns();
      });
    } finally {
      this.pumping = false;
    }
  }

  run = async (message: string): Promise<CoworkRunResult> => {
    this.lastUsed = Date.now();
    return new Promise<CoworkRunResult>((resolve) => {
      this.pendingRuns.push({ message, resolve });
      this.patch({ queued: Math.max(0, this.pendingRuns.length - (this.runResolvers.length === 0 ? 1 : 0)) });
      void this.pumpRuns();
    });
  };

  abort = () => {
    for (const item of this.pendingRuns.splice(0)) item.resolve({ ok: false, error: 'agent cancelled' });
    this.patch({ queued: 0 });
    void this.send({ type: 'abort' }).catch(() => {});
  };

  cycleModel = () => {
    void (async () => {
      try { await this.ensureStarted(); } catch { return; }
      await this.waitAlive();
      await this.send({ type: 'cycle_model' }).catch(() => {});
    })();
  };

  /** Kill the child (session delete / LRU reclaim). Transcript stays; respawns lazily. */
  stop() {
    if (this.unlisten) { this.unlisten(); this.unlisten = null; }
    this.alive = false;
    this.starting = false;
    this.remoteRunId = null;
    void invoke('agent_rpc_stop', { panelId: this.panelId }).catch(() => {});
    this.patch({ status: 'stopped', streaming: '', thinking: '', queued: 0, primed: false });
    const error = new Error('agent stopped');
    for (const waiter of this.aliveWaiters.splice(0)) waiter.reject(error);
    for (const resolve of this.idleWaiters.splice(0)) resolve();
    for (const item of this.runResolvers.splice(0)) item.resolve({ ok: false, error: 'agent stopped' });
    for (const item of this.pendingRuns.splice(0)) item.resolve({ ok: false, error: 'agent stopped' });
  }
}

/** Stable, filesystem-safe id for a session dir (reload-safe panelId). */
function sessionSlug(dir: string): string {
  let hash = 0;
  for (let i = 0; i < dir.length; i++) hash = ((hash << 5) - hash + dir.charCodeAt(i)) | 0;
  const tail = dir.split('/').filter(Boolean).slice(-1)[0] || 'session';
  return `${tail.replace(/[^a-zA-Z0-9-]/g, '-')}-${(hash >>> 0).toString(36)}`;
}

const handles = new Map<string, CoworkAgentHandle>();

export function acquireCoworkAgent(dir: string, language?: string): CoworkAgentHandle {
  let handle = handles.get(dir);
  if (!handle) {
    handle = new CoworkAgentHandle(dir, language);
    handles.set(dir, handle);
  }
  return handle;
}

export function disposeCoworkAgent(dir: string) {
  const handle = handles.get(dir);
  if (!handle) return;
  handle.stop();
  handles.delete(dir);
}

/** Keep at most MAX_LIVE children: reclaim the least-recently-used idle one. */
function reclaimIdleHandles(starting: CoworkAgentHandle) {
  const live = [...handles.values()].filter((h) =>
    h !== starting && (h.getSnapshot().status === 'idle' || h.getSnapshot().status === 'running'));
  if (live.length < MAX_LIVE) return;
  const idle = live.filter((h) => !h.isBusy()).sort((a, b) => a.lastUsed - b.lastUsed);
  for (const victim of idle.slice(0, live.length - MAX_LIVE + 1)) victim.stop();
}
