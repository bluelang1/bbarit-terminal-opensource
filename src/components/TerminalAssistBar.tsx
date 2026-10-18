/**
 * Floating assist bar for activity summaries, project tree summaries, and quick
 * persona injection into the active terminal.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, Network, Sparkles, UserRound, X } from 'lucide-react';
import { kvGet } from '../hooks/useKV';
import { useTranslation } from '../i18n';
import { summarizeRecentPrompts } from '../notes/promptSummary';
import type { PromptEntry } from './PromptLibraryPanel';

interface PersonaEntry {
  id: string;
  division: string;
  name: string;
  emoji: string;
  path?: string;
}

interface TerminalAssistBarProps {
  workDir?: string;
  accent: string;
  terminalId?: string;
  cliType?: string;
}

const PROMPT_KV_KEY = 'octo-prompt-library';

let assistPersonaCache: PersonaEntry[] | null = null;

async function pasteToActiveTerminal(terminalId: string | undefined, text: string): Promise<void> {
  const id = terminalId ?? '';
  if (!id || !text) return;
  try {
    await invoke('write_to_pty', { terminalId: id, data: text });
  } catch (e) {
    console.error('[TerminalAssistBar] paste failed:', e);
  }
}

const stripFrontMatter = (raw: string): string => {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return raw;
  return raw.slice(end + 4).replace(/^[\r\n]+/, '');
};

export function TerminalAssistBar({ workDir, accent, terminalId, cliType }: TerminalAssistBarProps) {
  const { t } = useTranslation();
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'idle' | 'activity' | 'project'>('idle');
  const [activeKind, setActiveKind] = useState<'activity' | 'project' | null>(null);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [personas, setPersonas] = useState<PersonaEntry[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!personaOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setPersonaOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPersonaOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [personaOpen]);

  const togglePersonas = useCallback(async () => {
    if (!personaOpen) {
      try {
        assistPersonaCache ??= await invoke<PersonaEntry[]>('agent_personas_list');
        setPersonas(assistPersonaCache);
      } catch (e) {
        console.error('[TerminalAssistBar] persona load failed:', e);
      }
    }
    setPersonaOpen((v) => !v);
  }, [personaOpen]);

  const injectPersona = useCallback(async (p: PersonaEntry) => {
    setPersonaOpen(false);
    let text: string;
    if (cliType === 'bbarit') {
      text = `/persona ${p.id}`;
    } else if (String(workDir || '').startsWith('ssh://')) {
      if (!p.path) return;
      try {
        const raw = await invoke<string>('read_file', { path: p.path });
        text = `Fully adopt the persona below from now on: its expertise, judgment, and voice shape every decision and reply. Keep your tool usage and verification principles unchanged.\n\n${stripFrontMatter(raw).trim()}\n`;
      } catch (e) {
        console.error('[TerminalAssistBar] persona body load failed:', e);
        return;
      }
    } else {
      if (!p.path) return;
      text = `Read the persona brief in the md file below, then fully adopt that persona from now on: its expertise, judgment, and voice shape every decision and reply. Keep your tool usage and verification principles unchanged. Persona file: ${p.path.replace(/\\/g, '/')}`;
    }
    await pasteToActiveTerminal(terminalId, text);
  }, [terminalId, cliType, workDir]);

  const handleActivitySummary = useCallback(async () => {
    if (busy !== 'idle') return;
    setBusy('activity');
    setActiveKind('activity');
    setError('');
    setOutput('');
    try {
      const raw = await kvGet(PROMPT_KV_KEY);
      const entries: PromptEntry[] = raw ? JSON.parse(raw) : [];
      const text = await summarizeRecentPrompts(entries, { projectPath: workDir });
      setOutput(text);
      await pasteToActiveTerminal(terminalId, text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  }, [busy, workDir, terminalId]);

  const handleProjectSummary = useCallback(async () => {
    if (busy !== 'idle' || !workDir) return;
    setBusy('project');
    setActiveKind('project');
    setError('');
    setOutput('');
    try {
      const tree = await invoke<string>('semble_dependency_tree', {
        root: workDir,
        maxDepth: 5,
        maxEntries: 8,
        maxLines: 400,
      });
      setOutput(tree);
      await pasteToActiveTerminal(terminalId, tree);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  }, [busy, workDir, terminalId]);

  const close = useCallback(() => {
    setOutput('');
    setError('');
    setActiveKind(null);
  }, []);

  const btnBase: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    padding: 0,
    borderRadius: 'var(--brutal-radius)',
    background: 'color-mix(in srgb, var(--bg-color) 92%, var(--text-color) 8%)',
    color: 'color-mix(in srgb, var(--text-color) 78%, transparent)',
    border: '1px solid color-mix(in srgb, var(--text-color) 16%, transparent)',
    borderColor: 'color-mix(in srgb, var(--text-color) 16%, transparent)',
    cursor: busy === 'idle' ? 'pointer' : 'wait',
    boxShadow: 'none',
    transition: 'none',
  };
  const spinIcon = <Loader2 size={11} style={{ animation: 'octo-spin 0.9s linear infinite' }} />;

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <style>{`@keyframes octo-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <button
        onClick={handleActivitySummary}
        disabled={busy !== 'idle'}
        title={busy === 'activity' ? t('terminalAssist.analyzingActivity') : t('terminalAssist.activitySummaryTitle')}
        style={{
          ...btnBase,
          borderColor: activeKind === 'activity' ? `color-mix(in srgb, ${accent} 48%, transparent)` : btnBase.borderColor,
          background: busy === 'activity' ? `color-mix(in srgb, ${accent} 14%, var(--bg-color) 86%)` : btnBase.background,
          color: activeKind === 'activity' ? 'var(--text-color)' : btnBase.color,
        }}
      >
        {busy === 'activity' ? spinIcon : <Sparkles size={12} />}
      </button>
      <button
        onClick={handleProjectSummary}
        disabled={busy !== 'idle' || !workDir}
        title={busy === 'project' ? t('terminalAssist.analyzingProject') : t('terminalAssist.projectSummaryTitle')}
        style={{
          ...btnBase,
          borderColor: activeKind === 'project' ? `color-mix(in srgb, ${accent} 48%, transparent)` : btnBase.borderColor,
          background: busy === 'project' ? `color-mix(in srgb, ${accent} 14%, var(--bg-color) 86%)` : btnBase.background,
          color: activeKind === 'project' ? 'var(--text-color)' : btnBase.color,
          opacity: workDir ? 1 : 0.5,
        }}
      >
        {busy === 'project' ? spinIcon : <Network size={12} />}
      </button>
      <button
        onClick={togglePersonas}
        title="Inject a persona"
        style={{
          ...btnBase,
          marginLeft: 10,
          width: 30,
          height: 26,
          background: personaOpen
            ? `color-mix(in srgb, ${accent} 30%, var(--bg-color) 70%)`
            : `color-mix(in srgb, ${accent} 14%, var(--bg-color) 86%)`,
          border: `1px solid color-mix(in srgb, ${accent} 55%, transparent)`,
          color: 'var(--text-color)',
        }}
      >
        <UserRound size={13} />
      </button>
      {personaOpen && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          left: 0,
          zIndex: 90,
          maxHeight: 300,
          overflowY: 'auto',
          minWidth: 230,
          background: 'rgba(0,0,0,0.9)',
          color: 'rgba(255,255,255,0.9)',
          border: `1px solid ${accent}66`,
          borderRadius: 'var(--brutal-radius)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          fontSize: 12,
        }}>
          {personas.length === 0 && <div style={{ padding: '8px 10px', opacity: 0.7 }}>No persona library found</div>}
          {personas.map((p, i) => (
            <div key={`${p.division}/${p.id}`}>
              {(i === 0 || personas[i - 1].division !== p.division) && (
                <div style={{
                  padding: '7px 10px 3px',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  color: accent,
                  position: 'sticky',
                  top: 0,
                  background: 'rgba(0,0,0,0.95)',
                  zIndex: 1,
                }}>{p.division}</div>
              )}
              <div
                onClick={() => { void injectPersona(p); }}
                style={{ padding: '5px 10px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = `${accent}33`; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                title={`${p.division}: click to type the persona instruction into the terminal`}
              >
                {p.emoji} {p.name}
              </div>
            </div>
          ))}
        </div>
      )}
      {busy !== 'idle' && !output && !error && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          left: 0,
          zIndex: 80,
          background: 'rgba(0,0,0,0.82)',
          color: 'rgba(255,255,255,0.85)',
          border: `1px solid ${accent}55`,
          borderRadius: 'var(--brutal-radius)',
          padding: '8px 12px',
          fontSize: 12,
          lineHeight: 1.4,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          whiteSpace: 'nowrap',
        }}>
          {spinIcon}
          {busy === 'activity' ? t('terminalAssist.summarizing') : t('terminalAssist.buildingTree')}
        </div>
      )}
      {(output || error) && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          left: 0,
          zIndex: 80,
          background: 'rgba(0,0,0,0.82)',
          color: '#fff',
          border: `1px solid ${accent}55`,
          borderRadius: 'var(--brutal-radius)',
          padding: '8px 10px',
          fontSize: 12,
          lineHeight: 1.55,
          width: 'max-content',
          maxWidth: 460,
          maxHeight: 260,
          overflowY: 'auto',
        }}>
          <button
            onClick={close}
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 20,
              height: 20,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              color: 'rgba(255,255,255,0.7)',
              cursor: 'pointer',
              padding: 0,
            }}
            title="Close"
          >
            <X size={12} />
          </button>
          <pre style={{ margin: 0, paddingRight: 18, whiteSpace: 'pre-wrap', font: 'inherit' }}>
            {error || output}
          </pre>
        </div>
      )}
    </div>
  );
}
