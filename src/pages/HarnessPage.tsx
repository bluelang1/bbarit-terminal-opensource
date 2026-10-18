/**
 * HarnessPage: Standalone window for Agent Harness.
 */
import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AgentHarnessPanel } from '../components/AgentHarnessPanel';
import { getSubWindowContext } from './windowUtils';
import { STYLES, FONTS } from '../theme';
import { ConfigProvider } from '../config/ConfigContext';
import { kvGet } from '../hooks/useKV';

export default function HarnessPage() {
  const [ctx, setCtx] = useState<Awaited<ReturnType<typeof getSubWindowContext>>>({
    project: null, projects: [], style: STYLES[0], font: FONTS[0],
  });
  const [terminalId, setTerminalId] = useState<string | null>(null);

  useEffect(() => { getSubWindowContext().then(setCtx).catch(() => {}); }, []);
  const { project, style, font } = ctx;

  // Find active terminal ID for the current project
  useEffect(() => {
    if (!project) return;
    (async () => {
      try {
        const raw = await kvGet('octo-terminal-projects');
        if (!raw) return;
        const data = JSON.parse(raw);
        const proj = (data.projects || []).find((p: any) => p.id === project.id || p.workDir === project.workDir);
        if (proj) {
          const tid = proj.activeTerminalId || proj.terminals?.[0]?.id;
          if (tid) setTerminalId(tid);
        }
      } catch { /* ignore */ }
    })();
  }, [project]);

  const handleClose = useCallback(() => {
    getCurrentWindow().close();
  }, []);

  const handleSendToConsole = useCallback((cmd: string) => {
    if (terminalId) {
      void invoke('write_to_pty', { terminalId, data: cmd + '\n' });
    } else {
      // Create a new shell and send command
      (async () => {
        try {
          const newId = `harness-shell-${Date.now()}`;
          await invoke('create_shell', {
            terminalId: newId,
            workDir: project?.workDir || '',
            rows: 24, cols: 80,
          });
          setTerminalId(newId);
          setTimeout(() => {
            void invoke('write_to_pty', { terminalId: newId, data: cmd + '\n' });
          }, 500);
        } catch (e) {
          console.error('[HarnessPage] Failed to create shell:', e);
        }
      })();
    }
  }, [terminalId, project]);

  return (
    <ConfigProvider>
      <div
        className="harness-page-wrap"
        style={{
          width: '100vw',
          height: '100vh',
          overflow: 'hidden',
          background: style.bg,
          color: style.text,
          fontFamily: font.value,
        }}
      >
        <AgentHarnessPanel
          onClose={handleClose}
          style={{ bg: style.bg, text: style.text, accent: style.accent }}
          workDir={project?.workDir || ''}
          projectName={project?.name}
          onSendToConsole={handleSendToConsole}
        />
      </div>
    </ConfigProvider>
  );
}
