import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Briefcase, Loader2, CheckCircle2, Send, FileText, RefreshCw,
  ExternalLink, History, X, Eye,
} from 'lucide-react';
import { useDesignAgent, type DesignLogEntry } from './useDesignAgent';

// 빠릿 코워크: Cowork-style knowledge-work studio. Left = conversational agent
// (bbarit-cowork skill over the same bbarit-agent RPC child the Design Studio
// uses), right = deliverables produced into makeke/cowork/<session>/ with a
// live preview for html/md/txt/csv files.

export interface CoworkPanelProps {
  projectRoot: string;
  theme: { bg: string; text: string; accent: string };
  onOpenFile?: (path: string) => void;
}

interface CoworkSession {
  id: string;
  prompt: string;
  dir: string;
  createdAt: number;
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size_bytes?: number | null;
}

const MAX_HISTORY = 40;
const PREVIEWABLE = /\.(html?|md|markdown|txt|csv|json|svg)$/i;

function historyKey(root: string) {
  return `octo-cowork-history:${(root || 'global').replace(/\/$/, '')}`;
}
function loadHistory(root: string): CoworkSession[] {
  try {
    const raw = localStorage.getItem(historyKey(root));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is CoworkSession =>
      typeof s?.id === 'string' && typeof s?.dir === 'string' && typeof s?.createdAt === 'number'
    ).slice(0, MAX_HISTORY);
  } catch { return []; }
}
function saveHistory(root: string, items: CoworkSession[]) {
  try { localStorage.setItem(historyKey(root), JSON.stringify(items.slice(0, MAX_HISTORY))); } catch { /* quota */ }
}

export function CoworkPanel({ projectRoot, theme, onOpenFile }: CoworkPanelProps) {
  const agent = useDesignAgent(projectRoot, 'cowork');
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState<CoworkSession[]>(() => loadHistory(projectRoot));
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => loadHistory(projectRoot)[0]?.id ?? null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const activeSession = history.find((s) => s.id === activeSessionId) || history[0] || null;

  useEffect(() => {
    const items = loadHistory(projectRoot);
    setHistory(items);
    setActiveSessionId(items[0]?.id ?? null);
    setActiveFilePath(null);
  }, [projectRoot]);

  useEffect(() => { saveHistory(projectRoot, history); }, [projectRoot, history]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [agent.log.length, agent.activity]);

  const refreshFiles = useCallback(async (dir: string | null) => {
    if (!dir) { setFiles([]); return []; }
    try {
      const entries = await invoke<FileEntry[]>('read_directory', { path: dir });
      const flat = entries.filter((e) => !e.is_dir).sort((a, b) => a.name.localeCompare(b.name));
      setFiles(flat);
      return flat;
    } catch {
      setFiles([]);
      return [];
    }
  }, []);

  useEffect(() => { void refreshFiles(activeSession?.dir ?? null); }, [activeSession?.dir, refreshFiles]);

  // Load preview for the selected deliverable.
  useEffect(() => {
    let cancelled = false;
    if (!activeFilePath || !PREVIEWABLE.test(activeFilePath)) { setPreviewText(''); return; }
    (async () => {
      try {
        const text = await invoke<string>('read_file', { path: activeFilePath });
        if (!cancelled) setPreviewText(text);
      } catch {
        if (!cancelled) setPreviewText('');
      }
    })();
    return () => { cancelled = true; };
  }, [activeFilePath]);

  const run = useCallback(async () => {
    const req = prompt.trim();
    if (!req) { setError('Enter your request.'); return; }
    if (!projectRoot) { setError('Open a project first — deliverables are saved into the project folder.'); return; }
    if (agent.busy) return;
    setError(null);

    // Follow-ups land in the same session folder; new topics get a fresh one.
    let session = activeSession;
    if (!session) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dir = `${projectRoot.replace(/\/$/, '')}/makeke/cowork/${ts}`;
      await invoke('create_directory', { path: dir }).catch(() => {});
      session = { id: `c-${Date.now()}`, prompt: req, dir, createdAt: Date.now() };
      setHistory((prev) => [session!, ...prev].slice(0, MAX_HISTORY));
      setActiveSessionId(session.id);
    }

    agent.note('you', req);
    setPrompt('');
    const message = `당신은 빠릿 코워크(bbarit-cowork 스킬)로 일하는 지식노동 에이전트입니다. 먼저 스킬 파일을 read 도구로 읽고 그 워크플로우를 그대로 따르세요.

[출력 디렉토리] ${session.dir}
모든 산출물 파일은 반드시 이 디렉토리 안에만 저장하세요.

[요청] ${req}

[마무리 규칙]
- 산출물이 있으면 저장한 파일 경로를 짧게 보고하고, 웹/파일 출처가 있으면 Sources: 섹션을 붙이세요.
- 질문이 필요하면 도구 없이 질문만 하고 턴을 끝내세요.`;
    const result = await agent.run(message);
    if (!result.ok) {
      setError(result.error || 'The cowork agent did not finish.');
      agent.note('sys', `⚠ ${result.error || 'no result'}`);
      return;
    }
    const flat = await refreshFiles(session.dir);
    if (flat.length > 0 && !activeFilePath) setActiveFilePath(flat[0].path);
    agent.note('sys', flat.length > 0 ? `✓ ${flat.length} file${flat.length > 1 ? 's' : ''} in workspace` : '✓ done');
  }, [prompt, projectRoot, agent, activeSession, refreshFiles, activeFilePath]);

  const newSession = useCallback(() => {
    setActiveSessionId(null);
    setActiveFilePath(null);
    setFiles([]);
    agent.clearLog();
  }, [agent]);

  const isHtml = !!activeFilePath && /\.html?$/i.test(activeFilePath);
  const busy = agent.busy;
  const t = theme;

  const previewBody = useMemo(() => {
    if (!activeFilePath) return null;
    if (isHtml) {
      return (
        <iframe title="cowork-preview" srcDoc={previewText} sandbox="allow-scripts"
          style={{ width: '100%', height: '100%', border: 0, display: 'block', background: '#fff' }} />
      );
    }
    if (PREVIEWABLE.test(activeFilePath)) {
      return (
        <pre style={{ margin: 0, padding: 16, height: '100%', overflow: 'auto', boxSizing: 'border-box',
          fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: t.text, background: t.bg }}>{previewText}</pre>
      );
    }
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: `${t.text}66`, fontSize: 12 }}>
        <FileText size={26} opacity={0.5} />
        No inline preview for this file type — open it in the editor.
      </div>
    );
  }, [activeFilePath, isHtml, previewText, t.bg, t.text]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, background: t.bg, color: t.text }}>
      {/* ── Left rail: cowork conversation ── */}
      <div style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${t.text}18`, minHeight: 0 }}>
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.text}14`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Briefcase size={16} color={t.accent} />
          <span style={{ fontSize: 13, fontWeight: 800 }}>빠릿 코워크</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55, display: 'flex', alignItems: 'center', gap: 4 }}>
            {agent.status === 'starting' ? <><Loader2 size={11} className="spin" /> starting</> : agent.status === 'running' ? <><Loader2 size={11} className="spin" /> working</> : <><CheckCircle2 size={11} /> ready</>}
          </span>
        </div>

        <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 7, minHeight: 0 }}>
          {agent.log.length === 0 && (
            <div style={{ fontSize: 11.5, opacity: 0.45, textAlign: 'center', marginTop: 24, lineHeight: 1.7 }}>
              리서치, 보고서, 문서 작성, 파일 정리 같은 일을 맡겨 보세요.<br />
              산출물은 프로젝트의 makeke/cowork 폴더에 파일로 저장됩니다.
            </div>
          )}
          {agent.log.map((l) => <LogRow key={l.id} entry={l} t={t} />)}
          {busy && agent.activity && <div style={{ fontSize: 11, opacity: 0.6, display: 'flex', alignItems: 'center', gap: 5 }}><Loader2 size={11} className="spin" /> {agent.activity}</div>}
        </div>

        <div style={{ padding: 12, borderTop: `1px solid ${t.text}12`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {error && <div style={{ fontSize: 11, color: '#ff6b6b', display: 'flex', alignItems: 'center', gap: 4 }}><X size={12} /> {error}</div>}
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
            placeholder="예: 지난 분기 AI 코딩 도구 동향을 조사해서 보고서로 정리해줘"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run(); }}
            style={{ width: '100%', resize: 'vertical', background: `${t.text}08`, color: t.text, border: `1px solid ${t.text}20`, borderRadius: 8, padding: 9, fontSize: 12.5, fontFamily: 'inherit', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={() => void run()} disabled={!prompt.trim() || busy}
              style={{ flex: 1, padding: '9px 12px', borderRadius: 9, border: 0, cursor: !prompt.trim() || busy ? 'not-allowed' : 'pointer',
                background: !prompt.trim() || busy ? `${t.text}18` : t.accent, color: !prompt.trim() || busy ? `${t.text}55` : '#fff',
                fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
              {busy ? 'Working…' : 'Send'}
            </button>
            <button type="button" onClick={newSession} disabled={busy} title="New session"
              style={{ padding: '9px 12px', borderRadius: 9, cursor: busy ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700,
                border: `1px solid ${t.text}22`, background: 'transparent', color: t.text }}>
              New
            </button>
          </div>
        </div>

        {history.length > 0 && (
          <div style={{ borderTop: `1px solid ${t.text}12`, padding: 10, maxHeight: 140, overflowY: 'auto' }}>
            <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}><History size={11} /> Sessions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {history.map((s) => (
                <button key={s.id} type="button" title={s.prompt}
                  onClick={() => { setActiveSessionId(s.id); setActiveFilePath(null); }}
                  style={{ textAlign: 'left', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11.5,
                    border: `1px solid ${activeSessionId === s.id ? t.accent : `${t.text}18`}`,
                    background: activeSessionId === s.id ? `${t.accent}18` : 'transparent', color: t.text,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.prompt.slice(0, 44) || 'cowork'}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Right: deliverables ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderBottom: `1px solid ${t.text}14`, flexWrap: 'wrap' }}>
          {files.map((f) => (
            <button key={f.path} type="button" onClick={() => setActiveFilePath(f.path)} title={f.path}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 11.5, fontWeight: 700,
                border: `1px solid ${activeFilePath === f.path ? t.accent : `${t.text}20`}`,
                background: activeFilePath === f.path ? t.accent : 'transparent', color: activeFilePath === f.path ? '#fff' : t.text,
                maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <FileText size={12} /> {f.name}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button type="button" onClick={() => void refreshFiles(activeSession?.dir ?? null)} disabled={!activeSession} title="Refresh files"
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 9px', borderRadius: 7, fontSize: 11.5, fontWeight: 700,
              cursor: activeSession ? 'pointer' : 'not-allowed', border: `1px solid ${t.text}20`, background: 'transparent',
              color: activeSession ? t.text : `${t.text}45` }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button type="button" onClick={() => activeFilePath && onOpenFile?.(activeFilePath)} disabled={!activeFilePath}
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 9px', borderRadius: 7, fontSize: 11.5, fontWeight: 700,
              cursor: activeFilePath ? 'pointer' : 'not-allowed', border: `1px solid ${t.text}20`, background: 'transparent',
              color: activeFilePath ? t.text : `${t.text}45` }}>
            <ExternalLink size={14} /> Editor
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, background: isHtml ? '#f4f4f5' : t.bg }}>
          {activeFilePath ? previewBody : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: `${t.text}66`, fontSize: 13, gap: 8, flexDirection: 'column' }}>
              <Eye size={28} opacity={0.4} />
              Deliverables appear here as files.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LogRow({ entry, t }: { entry: DesignLogEntry; t: { text: string; accent: string } }) {
  if (entry.role === 'you') {
    return <div style={{ alignSelf: 'flex-end', maxWidth: '90%', background: t.accent, color: '#fff', borderRadius: '10px 10px 2px 10px', padding: '6px 10px', fontSize: 12 }}>{entry.text}</div>;
  }
  if (entry.role === 'sys') {
    return <div style={{ fontSize: 10.5, opacity: 0.55, textAlign: 'center' }}>{entry.text}</div>;
  }
  if (entry.role === 'tool') {
    return <div style={{ fontSize: 10.5, opacity: 0.5, fontFamily: 'monospace' }}>▸ {entry.text}</div>;
  }
  return <div style={{ alignSelf: 'flex-start', maxWidth: '92%', background: `${t.text}0d`, color: t.text, borderRadius: '10px 10px 10px 2px', padding: '6px 10px', fontSize: 12, whiteSpace: 'pre-wrap' }}>{entry.text}</div>;
}
