import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useConfig } from '../config/ConfigContext';
import { normalizeBbaritAgentLanguage } from '../terminal/bbaritAgentLanguage';

// Drives one bbarit-agent RPC child for the Design Studio: spawn on first
// run(), send a design prompt, resolve when the agent finishes the turn.
// Mirrors the exact agent_rpc_start / agent_rpc_write / agent-rpc-<panelId>
// protocol that AgentChatPanel uses, minus the chat UI. The caller pre-decides
// the output file path and tells the agent to write there, so no tool-output
// parsing is needed — we just open the file after `agent_end`.
//
// The panelId is stable per (kind, workDir) and unmount does NOT stop the
// child: a tab switch mid-generation would otherwise kill a minutes-long fal
// render. agent_rpc_start reattaches to a live child and replays its session
// frame, so the remounted hook picks the same process back up.

export type DesignAgentStatus = 'starting' | 'idle' | 'running';

export interface DesignRunResult {
  ok: boolean;
  error?: string;
}

export interface DesignLogEntry {
  id: number;
  role: 'you' | 'agent' | 'tool' | 'sys';
  text: string;
}

export interface UseDesignAgent {
  status: DesignAgentStatus;
  activity: string;
  busy: boolean;
  model: string;
  cycleModel: () => void;
  log: DesignLogEntry[];
  note: (role: DesignLogEntry['role'], text: string) => void;
  clearLog: () => void;
  run: (message: string) => Promise<DesignRunResult>;
}

function stableHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

export function useDesignAgent(workDir: string, kind: string): UseDesignAgent {
  const { config } = useConfig();
  const bbaritLanguage = normalizeBbaritAgentLanguage(config.agent.bbaritLanguage);
  const panelId = `design-rpc-${kind}-${stableHash(workDir)}`;

  const [status, setStatus] = useState<DesignAgentStatus>('idle');
  const [activity, setActivity] = useState('');
  const [model, setModel] = useState('');
  // Lazy spawn: the agent child process is only started on the first run(), not
  // on mount — mounting the studio (which can happen on HMR or tab switches)
  // must never spin up an agent process.
  const [armed, setArmed] = useState(false);
  const [log, setLog] = useState<DesignLogEntry[]>([]);
  const logIdRef = useRef(1);

  const note = useCallback((role: DesignLogEntry['role'], text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setLog((prev) => [...prev, { id: logIdRef.current++, role, text: trimmed }].slice(-120));
  }, []);
  const clearLog = useCallback(() => setLog([]), []);

  const idRef = useRef(1);
  const aliveRef = useRef(false);
  const sessionWaiters = useRef<Array<{ resolve: () => void; reject: (error: Error) => void }>>([]);
  const idleWaiters = useRef<Array<() => void>>([]);
  const remoteRunIdRef = useRef<string | null>(null);
  const expectedRunIdRef = useRef<string | null>(null);
  const runResolveRef = useRef<((r: DesignRunResult) => void) | null>(null);

  const sendWithId = useCallback((frame: Record<string, unknown>) => {
    const id = idRef.current++;
    const line = JSON.stringify({ id, ...frame });
    return { id, promise: invoke<void>('agent_rpc_write', { panelId, line }) };
  }, [panelId]);
  const send = useCallback((frame: Record<string, unknown>) => sendWithId(frame).promise, [sendWithId]);

  const finishRun = useCallback((result: DesignRunResult) => {
    const resolve = runResolveRef.current;
    runResolveRef.current = null;
    expectedRunIdRef.current = null;
    if (resolve) resolve(result);
  }, []);

  const failSessionWaiters = useCallback((message: string) => {
    const error = new Error(message);
    for (const waiter of sessionWaiters.current.splice(0)) waiter.reject(error);
  }, []);

  // Keep the frame handler in a ref so the spawn effect can stay pinned to
  // [panelId, workDir] and never re-subscribes (which would double-count).
  const handleFrameRef = useRef<(raw: string) => void>(() => {});
  handleFrameRef.current = (raw: string) => {
    let frame: any;
    try { frame = JSON.parse(raw); } catch { return; }
    switch (frame.type) {
      case 'session':
        aliveRef.current = true;
        setStatus(remoteRunIdRef.current ? 'running' : 'idle');
        void send({ type: 'get_state' }).catch(() => {});
        for (const waiter of sessionWaiters.current.splice(0)) waiter.resolve();
        break;
      case 'response':
        if ((frame.command === 'get_state' || frame.command === 'cycle_model') && frame.data?.model) {
          setModel(String(frame.data.model.name || frame.data.model.id || ''));
        }
        break;
      case 'agent_start':
        remoteRunIdRef.current = frame.runId == null ? null : String(frame.runId);
        setStatus('running');
        break;
      case 'message_end': {
        const m = frame.message || {};
        const role = String(m.role || '');
        if (role === 'assistant') {
          const text = String(m.content || '').trim();
          if (text) {
            setActivity(text.slice(0, 160));
            setLog((prev) => [...prev, { id: logIdRef.current++, role: 'agent' as const, text }].slice(-120));
          }
        } else if (role === 'tool') {
          const name = m.tool_name || m.toolName || 'tool';
          setActivity(`· ${name}`);
          const arg = String(m.content || '').split('\n')[0].slice(0, 80);
          setLog((prev) => [...prev, { id: logIdRef.current++, role: 'tool' as const, text: `${name}${arg ? ` — ${arg}` : ''}` }].slice(-120));
        }
        break;
      }
      case 'agent_end': {
        const endedRunId = frame.runId == null ? null : String(frame.runId);
        remoteRunIdRef.current = null;
        setStatus('idle');
        for (const resolve of idleWaiters.current.splice(0)) resolve();
        if (expectedRunIdRef.current == null
          || endedRunId == null
          || expectedRunIdRef.current === endedRunId) {
          finishRun({
            ok: !frame.errorMessage && !frame.cancelled && !frame.incomplete,
            error: frame.errorMessage
              ? String(frame.errorMessage)
              : frame.cancelled
                ? 'agent cancelled'
                : frame.incomplete
                  ? String(frame.stopReason || 'agent stopped before completing the task')
                  : undefined,
          });
        }
        break;
      }
      default:
        break;
    }
  };

  useEffect(() => {
    if (!armed) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    aliveRef.current = false;
    setStatus('starting');
    (async () => {
      const un = await listen<{ kind: string; line?: string }>(`agent-rpc-${panelId}`, (event) => {
        const { kind, line } = event.payload || ({} as any);
        if (kind === 'line' && line) handleFrameRef.current(line);
        else if (kind === 'exit') {
          aliveRef.current = false;
          remoteRunIdRef.current = null;
          setStatus('idle');
          failSessionWaiters('agent exited');
          for (const resolve of idleWaiters.current.splice(0)) resolve();
          finishRun({ ok: false, error: 'agent exited' });
        }
      });
      if (disposed) { un(); return; }
      unlisten = un;
      try {
        await invoke('agent_rpc_start', { panelId, workDir, bbaritLanguage });
      } catch (e) {
        const message = `agent start failed: ${e}`;
        setStatus('idle');
        setActivity(message);
        failSessionWaiters(message);
        finishRun({ ok: false, error: message });
      }
    })();
    return () => {
      // Deliberately no agent_rpc_stop: the child must survive unmounts so an
      // in-flight generation keeps running; remount reattaches via panelId.
      disposed = true;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, panelId, workDir, bbaritLanguage, failSessionWaiters, finishRun]);

  const waitAlive = useCallback(() => new Promise<void>((resolve, reject) => {
    if (aliveRef.current) resolve();
    else sessionWaiters.current.push({ resolve, reject });
  }), []);

  const waitIdle = useCallback(async () => {
    const snapshot = await invoke<{ alive: boolean; running: boolean; runId?: string | number | null }>('agent_rpc_status', { panelId });
    if (!snapshot.running) return;
    remoteRunIdRef.current = snapshot.runId == null ? null : String(snapshot.runId);
    setStatus('running');
    await new Promise<void>((resolve) => idleWaiters.current.push(resolve));
  }, [panelId]);

  const run = useCallback(async (message: string): Promise<DesignRunResult> => {
    if (runResolveRef.current) return { ok: false, error: 'agent busy' };
    setArmed(true);
    try {
      await waitAlive();
      await waitIdle();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return new Promise<DesignRunResult>((resolve) => {
      runResolveRef.current = resolve;
      const request = sendWithId({ type: 'prompt', message });
      expectedRunIdRef.current = String(request.id);
      void request.promise.catch((e) => finishRun({ ok: false, error: String(e) }));
    });
  }, [sendWithId, waitAlive, waitIdle, finishRun]);

  const cycleModel = useCallback(() => {
    setArmed(true);
    void waitAlive().then(() => send({ type: 'cycle_model' })).catch(() => {});
  }, [send, waitAlive]);

  return { status, activity, busy: status === 'running', model, cycleModel, log, note, clearLog, run };
}
