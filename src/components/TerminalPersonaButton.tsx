/**
 * Always-visible persona injection button for the active terminal.
 * Clicking opens the shared BbaritPersonaPickerModal; picking a persona types
 * the adoption instruction into the terminal (bbarit CLI: `/persona <id>`).
 */
import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { UserRound } from 'lucide-react';
import { BbaritPersonaPickerModal } from './BbaritPersonaPickerModal';
import type { BbaritPersonaEntry } from '../terminal/bbaritAgentPersonaProfile';

interface Props {
  terminalId?: string;
  cliType?: string;
  accent: string;
  remote?: boolean;
}

let personaListCache: BbaritPersonaEntry[] | null = null;

const stripFrontMatter = (raw: string): string => {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return raw;
  return raw.slice(end + 4).replace(/^[\r\n]+/, '');
};

export function TerminalPersonaButton({ terminalId, cliType, accent, remote }: Props) {
  const [open, setOpen] = useState(false);
  const [personas, setPersonas] = useState<BbaritPersonaEntry[]>([]);
  const [favs, setFavs] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('bbarit-persona-favs') || '[]');
    } catch {
      return [];
    }
  });

  const toggleFav = useCallback((id: string) => {
    setFavs((prev) => {
      const next = prev.includes(id) ? prev.filter((k) => k !== id) : [id, ...prev];
      try {
        localStorage.setItem('bbarit-persona-favs', JSON.stringify(next));
      } catch {
        // Ignore quota/storage failures.
      }
      return next;
    });
  }, []);

  const openPicker = useCallback(async () => {
    try {
      personaListCache ??= await invoke<BbaritPersonaEntry[]>('agent_personas_list');
      setPersonas(personaListCache);
    } catch (e) {
      console.error('[TerminalPersonaButton] load failed:', e);
    }
    setOpen(true);
  }, []);

  const inject = useCallback(async (id: string) => {
    setOpen(false);
    if (!terminalId) return;
    const p = id ? personaListCache?.find((entry) => entry.id === id) : undefined;
    try {
      let brief: string;
      if (cliType === 'bbarit') {
        brief = id ? `/persona ${id}` : '/persona off';
      } else if (!p) {
        return; // 페르소나 없음 — bbarit 외 CLI에는 해제 개념이 없어 그냥 닫는다.
      } else if (!remote && p.path) {
        const briefPath = p.path.replace(/\\/g, '/');
        brief = `Read the persona brief in the md file below, then fully adopt that persona from now on: its expertise, judgment, and voice shape every decision and reply. Keep your tool usage and verification principles unchanged. Persona file: ${briefPath}`;
      } else {
        if (!p.path) return;
        const raw = await invoke<string>('read_file', { path: p.path });
        brief = `Fully adopt the persona below from now on: its expertise, judgment, and voice shape every decision and reply. Keep your tool usage and verification principles unchanged.\n\n${stripFrontMatter(raw).trim()}\n`;
      }
      await invoke('write_to_pty', { terminalId, data: brief });
    } catch (e) {
      console.error('[TerminalPersonaButton] inject failed:', e);
    }
  }, [terminalId, cliType, remote]);

  return (
    <>
      <button
        type="button"
        className="btn-tab-action"
        onClick={() => { void openPicker(); }}
        title="Inject a persona"
        style={{
          border: `1px solid color-mix(in srgb, ${accent} 55%, transparent)`,
          background: open
            ? `color-mix(in srgb, ${accent} 30%, transparent)`
            : `color-mix(in srgb, ${accent} 12%, transparent)`,
        }}
      >
        <UserRound size={14} />
      </button>
      {open && (
        <BbaritPersonaPickerModal
          personas={personas}
          favorites={favs}
          onToggleFavorite={toggleFav}
          onSelect={(id) => { void inject(id); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
