/**
 * ScrumPage: Standalone window wrapper for ScrumModal.
 * Renders ScrumModal in full-page mode by overriding the overlay styles.
 *
 * Implements a task-by-task sequential polling loop:
 * For each task: reviewer reviews → completion detected → implementer implements → completion detected
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import ScrumModal from '../components/ScrumModal';
import type { ScrumLaunchPayload, ScrumRunController } from '../components/ScrumModal';
import { getSubWindowContext } from './windowUtils';
import { STYLES, FONTS } from '../theme';
import './ScrumPage.css';

type ScrumCliAgent = ScrumLaunchPayload['roles']['reviewer'];

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_PER_TASK = 360; // 5s * 360 = 30 min max per task

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function resolveCliCommand(agent: ScrumCliAgent, ollamaModel?: string): string {
  switch (agent) {
    case 'claude':
      return 'claude --dangerously-skip-permissions';
    case 'codex':
      return 'codex --yolo --search';
    case 'kimi':
      return 'kimi --yolo';
    case 'ollama': {
      const model = (ollamaModel || '').trim() || 'llama3.1';
      return `ollama run ${shellQuote(model)}`;
    }
    default:
      return '';
  }
}

function resolveCliBinary(agent: ScrumCliAgent): string {
  switch (agent) {
    case 'claude': return 'claude';
    case 'codex': return 'codex';
    case 'kimi': return 'kimi';
    case 'ollama': return 'ollama';
    default: return '';
  }
}

export default function ScrumPage() {
  const [ctx, setCtx] = useState<Awaited<ReturnType<typeof getSubWindowContext>>>({ project: null, projects: [], style: STYLES[0], font: FONTS[0] });
  useEffect(() => { getSubWindowContext().then(setCtx).catch(() => {}); }, []);
  const { project, projects, style, font } = ctx;
  const agentWindowsRef = useRef<string[]>([]);

  const isLightBg = (hex: string) => {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 128;
  };

  const handleClose = useCallback(() => {
    for (const wLabel of agentWindowsRef.current) {
      WebviewWindow.getByLabel(wLabel).then(w => w?.close()).catch(() => {});
    }
    agentWindowsRef.current = [];
    getCurrentWindow().close();
  }, []);

  const projectsForModal = useMemo(() =>
    projects.map(p => ({
      id: p.id,
      displayName: p.name,
      workDir: p.workDir,
      icon: '',
    })),
  [projects]);

  // Create PTY + open agent window for scrum agents
  const createTerminalAndWindow = useCallback(async (
    label: string,
    cliType: ScrumCliAgent,
    workDir: string,
    windowIndex: number,
  ): Promise<string> => {
    const termId = `scrum-${label.replace(/\s+/g, '-')}-${Date.now()}`;
    await invoke('create_shell', {
      terminalId: termId,
      workDir,
      rows: 24,
      cols: 80,
      shellType: null,
    });

    const windowLabel = `scrum-agent-${termId.slice(0, 20)}`;
    const params = new URLSearchParams({
      terminalId: termId,
      label,
      cliType,
      isLeader: '0',
      projectId: project?.id || '',
    });
    const offsetX = 40 + (windowIndex % 4) * 30;
    const offsetY = 40 + Math.floor(windowIndex / 4) * 30;
    try {
      const w = new WebviewWindow(windowLabel, {
        url: `/agent-terminal?${params.toString()}`,
        title: label,
        width: 700,
        height: 500,
        x: offsetX + 300,
        y: offsetY + 100,
        resizable: true,
        decorations: true,
      });
      agentWindowsRef.current.push(windowLabel);
      w.once('tauri://error', () => {});
    } catch { /* window may exist */ }

    return termId;
  }, [project?.id]);

  const readOutputBuffer = useCallback(async (terminalId: string): Promise<string> => {
    try {
      return await invoke<string>('read_pty_output_buffer', { terminalId });
    } catch {
      return '';
    }
  }, []);

  const waitForPtyReady = useCallback(async (terminalId: string, shouldAbort: () => boolean) => {
    for (let i = 0; i < 50; i++) {
      if (shouldAbort()) throw new Error('Run cancelled by user stop.');
      const alive = await invoke<boolean>('check_pty_alive', { terminalId }).catch(() => false);
      if (alive) return;
      await sleep(100);
    }
    throw new Error(`Terminal not ready: ${terminalId}`);
  }, []);

  const ensureCliInstalled = useCallback(async (
    agent: ScrumCliAgent,
    workDir: string,
  ) => {
    const bin = resolveCliBinary(agent);
    if (!bin) throw new Error(`Unsupported agent type: ${agent}`);
    try {
      await invoke<string>('run_cli_oneshot', {
        command: (navigator.platform?.startsWith('Win') || navigator.userAgent?.includes('Windows'))
          ? `if (Get-Command ${bin} -ErrorAction SilentlyContinue) { echo OK } else { throw "${bin} not found" }`
          : `command -v ${bin} >/dev/null 2>&1 && echo OK`,
        workDir,
        timeoutSecs: 12,
      });
    } catch {
      throw new Error(`Could not find the ${bin} executable. Check the path/installation.`);
    }
  }, []);

  const startCli = useCallback(async (
    terminalId: string,
    agent: ScrumCliAgent,
    workDir: string,
    shouldAbort: () => boolean,
    ollamaModel?: string,
  ) => {
    await ensureCliInstalled(agent, workDir);
    const cmd = resolveCliCommand(agent, ollamaModel);
    if (!cmd) throw new Error(`Failed to build agent CLI command: ${agent}`);

    const before = await readOutputBuffer(terminalId);
    await invoke('write_to_pty', { terminalId, data: `${cmd}\n` });

    const beforeLen = before.length;
    for (let i = 0; i < 30; i++) {
      if (shouldAbort()) throw new Error('Run cancelled by user stop.');
      const alive = await invoke<boolean>('check_pty_alive', { terminalId }).catch(() => false);
      if (!alive) throw new Error(`${agent} CLI exited during startup.`);
      const after = await readOutputBuffer(terminalId);
      const delta = after.slice(beforeLen);
      if (/command not found|No such file|not recognized as an internal|cannot find/i.test(delta)) {
        throw new Error(`${agent} CLI start failed: ${delta.split('\n').slice(-2).join(' ').trim()}`);
      }
      if (delta.length > 0) return;
      await sleep(300);
    }
  }, [ensureCliInstalled, readOutputBuffer]);

  // Orchestra-style writeAndSubmit: write text, wait, double Enter
  const writeAndSubmit = useCallback(async (terminalId: string, text: string) => {
    try {
      await invoke('write_to_pty', { terminalId, data: text });
    } catch { /* ignore */ }
    await sleep(500);
    try {
      await invoke('write_to_pty', { terminalId, data: '\r' });
    } catch { /* ignore */ }
    await sleep(300);
    try {
      await invoke('write_to_pty', { terminalId, data: '\r' });
    } catch { /* ignore */ }
  }, []);

  // Detect CLI completion by checking PTY alive + shell prompt pattern
  const detectCliCompletion = useCallback(async (terminalId: string, baselineLen: number): Promise<boolean> => {
    // 1. Check if PTY process died
    const alive = await invoke<boolean>('check_pty_alive', { terminalId }).catch(() => false);
    if (!alive) return true;

    // 2. Check shell prompt pattern (CLI exited, returned to shell)
    const buf = await readOutputBuffer(terminalId);
    if (!buf) return false;
    const delta = buf.slice(baselineLen);
    if (delta.length < 50) return false; // Not enough output yet
    const trimmed = stripAnsi(delta).trimEnd();
    // Shell prompt at end of output: $, %, #, > with optional trailing whitespace
    const shellPrompt = /[%$#>]\s*$/.test(trimmed) && trimmed.length > 200;
    return shellPrompt;
  }, [readOutputBuffer]);

  // Poll until CLI completion or abort
  const pollUntilDone = useCallback(async (
    terminalId: string,
    shouldAbort: () => boolean,
    onPoll?: (pollCount: number) => void,
  ): Promise<void> => {
    const baseline = await readOutputBuffer(terminalId);
    const baselineLen = baseline.length;

    for (let i = 0; i < MAX_POLL_PER_TASK; i++) {
      if (shouldAbort()) throw new Error('Run cancelled by user stop.');
      await sleep(POLL_INTERVAL_MS);
      if (onPoll) onPoll(i + 1);
      const done = await detectCliCompletion(terminalId, baselineLen);
      if (done) return;
    }
    // Timeout: treat as done (CLI may still be running but we move on)
  }, [readOutputBuffer, detectCliCompletion]);

  /**
   * Main launch handler: task-by-task sequential execution with polling
   */
  const handleLaunch = useCallback(async (
    payload: ScrumLaunchPayload,
    controller: ScrumRunController,
  ) => {
    const { report, shouldAbort, setPhase, setTaskStatus } = controller;
    const createdTerminalIds: string[] = [];

    // Phase: kickoff - create terminals
    report({ type: 'info', from: 'system', subject: 'Create terminals', body: `Reviewer: ${payload.roles.reviewer}, Implementer: ${payload.roles.implementer}` });

    const reviewerTermId = await createTerminalAndWindow(
      `[Reviewer] ${payload.roles.reviewer}`,
      payload.roles.reviewer,
      payload.workDir,
      0,
    );
    createdTerminalIds.push(reviewerTermId);

    const implementerTermId = await createTerminalAndWindow(
      `[Implementer] ${payload.roles.implementer}`,
      payload.roles.implementer,
      payload.workDir,
      1,
    );
    createdTerminalIds.push(implementerTermId);

    report({ type: 'info', from: 'system', subject: 'Terminal init', body: 'Checking CLI startup...' });

    try {
      await waitForPtyReady(reviewerTermId, shouldAbort);
      await waitForPtyReady(implementerTermId, shouldAbort);
      await startCli(reviewerTermId, payload.roles.reviewer, payload.workDir, shouldAbort, payload.roles.ollamaModel);
      await startCli(implementerTermId, payload.roles.implementer, payload.workDir, shouldAbort, payload.roles.ollamaModel);
    } catch (err) {
      for (const terminalId of createdTerminalIds) {
        await invoke('destroy_pty', { terminalId }).catch(() => {});
      }
      throw err;
    }

    report({ type: 'success', from: 'system', subject: 'CLI started', body: 'Reviewer/implementer CLIs ready' });

    // Phase: task_loop - iterate through tasks
    setPhase('task_loop', 0);
    const tasks = payload.plan.tasks;

    for (let taskIdx = 0; taskIdx < tasks.length; taskIdx++) {
      if (shouldAbort()) throw new Error('Run cancelled by user stop.');

      const task = tasks[taskIdx];
      setPhase('task_loop', taskIdx);

      report({
        type: 'info', from: 'system', taskId: task.id,
        subject: `Task ${taskIdx + 1}/${tasks.length} started`,
        body: `${task.title} (${task.owner})`,
      });

      // Determine which agents to involve based on task owner
      const isReviewerTask = task.owner === 'codex' || task.owner === 'joint';
      const isImplementerTask = task.owner === 'claude' || task.owner === 'joint';

      // --- Step A: Reviewer phase ---
      if (isReviewerTask) {
        setTaskStatus(task.id, 'reviewing');
        const reviewPrompt = [
          `[TASK ${task.id}] ${task.title}`,
          `Owner: ${task.owner}`,
          `Objective: ${task.objective}`,
          `Deliverable: ${task.deliverable}`,
          `Review Gate: ${task.reviewGate}`,
          ``,
          `Project: ${payload.projectName} (${payload.workDir})`,
          `Sprint Goal: ${payload.plan.sprintGoal}`,
          ``,
          `Please review this task. Provide approval or feedback.`,
        ].join('\n');

        report({ type: 'review', from: 'reviewer', taskId: task.id, subject: 'Reviewer prompt sent', body: task.title });
        await writeAndSubmit(reviewerTermId, reviewPrompt);

        // Poll until reviewer completes
        await pollUntilDone(reviewerTermId, shouldAbort, (pollCount) => {
          if (pollCount % 6 === 0) { // Report every 30s
            report({
              type: 'review', from: 'reviewer', taskId: task.id,
              subject: 'Reviewer working',
              body: `${pollCount * POLL_INTERVAL_MS / 1000}s elapsed`,
            });
          }
        });

        report({ type: 'review', from: 'reviewer', taskId: task.id, subject: 'Reviewer completion detected', body: task.title });
      }

      // --- Step B: Implementer phase ---
      if (isImplementerTask) {
        setTaskStatus(task.id, 'implementing');

        // Get reviewer's latest output as context for implementer
        let reviewerContext = '';
        if (isReviewerTask) {
          const buf = await readOutputBuffer(reviewerTermId);
          const trimmed = stripAnsi(buf).trimEnd();
          // Take last 2000 chars of reviewer output as context
          reviewerContext = trimmed.length > 2000 ? trimmed.slice(-2000) : trimmed;
        }

        const implPrompt = [
          `[TASK ${task.id}] ${task.title}`,
          `Owner: ${task.owner}`,
          `Objective: ${task.objective}`,
          `Deliverable: ${task.deliverable}`,
          `Review Gate: ${task.reviewGate}`,
          ``,
          `Project: ${payload.projectName} (${payload.workDir})`,
          `Sprint Goal: ${payload.plan.sprintGoal}`,
          ...(reviewerContext ? [
            ``,
            `--- Reviewer Context (recent output) ---`,
            reviewerContext.slice(-800),
            `--- End Reviewer Context ---`,
          ] : []),
          ``,
          `Implement this task now. Follow the objective and meet the review gate criteria.`,
        ].join('\n');

        report({ type: 'implement', from: 'implementer', taskId: task.id, subject: 'Implementer prompt sent', body: task.title });
        await writeAndSubmit(implementerTermId, implPrompt);

        // Poll until implementer completes
        await pollUntilDone(implementerTermId, shouldAbort, (pollCount) => {
          if (pollCount % 6 === 0) {
            report({
              type: 'implement', from: 'implementer', taskId: task.id,
              subject: 'Implementer working',
              body: `${pollCount * POLL_INTERVAL_MS / 1000}s elapsed`,
            });
          }
        });

        report({ type: 'implement', from: 'implementer', taskId: task.id, subject: 'Implementer completion detected', body: task.title });
      }

      // If task is neither reviewer nor implementer specific, skip
      if (!isReviewerTask && !isImplementerTask) {
        setTaskStatus(task.id, 'skipped');
        report({ type: 'warning', from: 'system', taskId: task.id, subject: 'Task skipped', body: `${task.title} (owner: ${task.owner})` });
        continue;
      }

      // Mark task as done
      setTaskStatus(task.id, 'done');
      report({
        type: 'success', from: 'system', taskId: task.id,
        subject: `Task complete`,
        body: `${task.id}: ${task.title}`,
      });
    }

    // Phase: final_review
    setPhase('final_review');
    report({ type: 'info', from: 'system', subject: 'Final review', body: 'All tasks executed, checking final state' });

    // Check both CLIs are still alive
    const reviewerAlive = await invoke<boolean>('check_pty_alive', { terminalId: reviewerTermId }).catch(() => false);
    const implementerAlive = await invoke<boolean>('check_pty_alive', { terminalId: implementerTermId }).catch(() => false);

    report({
      type: 'success', from: 'system',
      subject: 'Scrum run complete',
      body: `Reviewer: ${reviewerAlive ? 'active' : 'exited'}, Implementer: ${implementerAlive ? 'active' : 'exited'}`,
    });
  }, [createTerminalAndWindow, startCli, waitForPtyReady, writeAndSubmit, pollUntilDone, readOutputBuffer]);

  const handleOpenFile = useCallback((path: string) => {
    void path;
  }, []);
  const handleOpenProject = useCallback(() => {
    window.location.assign('/');
  }, []);

  return (
    <div
      className={`scrum-page-wrap ${isLightBg(style.bg) ? 'light-theme' : ''}`}
      style={{
        '--bg-color': style.bg,
        '--text-color': style.text,
        '--accent-color': style.accent,
        '--font-family': font.value,
      } as React.CSSProperties}
    >
      <ScrumModal
        isOpen={true}
        onClose={handleClose}
        projects={projectsForModal}
        activeProjectId={project?.id || null}
        onLaunch={handleLaunch}
        onOpenFile={handleOpenFile}
        onOpenProject={handleOpenProject}
      />
    </div>
  );
}
