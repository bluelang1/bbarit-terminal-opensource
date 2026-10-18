/**
 * AgentPanelPage: standalone window hosting the Codex-style BBARIT agent chat
 * panel (AgentChatPanel) — the agent runs in JSON-RPC mode, not a terminal.
 * URL params: ?workDir=...&label=...&projectId=...
 */
import { useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AgentChatPanel } from '../components/AgentChatPanel';
import { getSubWindowContext } from './windowUtils';
import { STYLES, FONTS } from '../theme';

export default function AgentPanelPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const workDirOverride = params.get('workDir') || '';
  const label = params.get('label') || 'BBARIT Agent';

  const [ctx, setCtx] = useState<Awaited<ReturnType<typeof getSubWindowContext>>>({
    project: null,
    projects: [],
    style: STYLES[0],
    font: FONTS[0],
  });
  useEffect(() => {
    getSubWindowContext().then(setCtx).catch(() => {});
  }, []);
  const { style, font, project, projects } = ctx;
  const projectOptions = (projects || [])
    .map((p: any) => ({
      id: String(p.id ?? p.workDir ?? ''),
      name: String(p.displayName ?? p.name ?? p.workDir ?? ''),
      workDir: String(p.workDir ?? ''),
    }))
    .filter((p) => p.workDir);

  return (
    <div
      style={{
        height: '100vh',
        '--bg-color': style.bg,
        '--text-color': style.text,
        '--accent-color': style.accent,
        '--font-family': font.value,
      } as React.CSSProperties}
    >
      <AgentChatPanel
        workDir={workDirOverride || project?.workDir || ''}
        projects={projectOptions}
        label={label}
        onClose={() => { void getCurrentWindow().close(); }}
      />
    </div>
  );
}
