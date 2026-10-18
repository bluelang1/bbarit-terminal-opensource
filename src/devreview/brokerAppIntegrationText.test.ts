import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readAppBrokerBlock(): string {
  const source = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
  const start = source.indexOf('const brokerBusyRef');
  const end = source.indexOf('if (isHarnessWindow) return <div className="harness-window-root"', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('App broker integration text', () => {
  it('does not contain committed mojibake markers in broker-facing App text', () => {
    const source = readAppBrokerBlock();

    expect(source.charCodeAt(0)).not.toBe(0xfeff);
    expect(source).not.toMatch(/[\uFFFD\u0080-\u009F]/);
    expect(source).not.toMatch(/[\uC338\uBD31]/);
    for (const fragment of ['媛', '蹂', '釉', '紐', '?먯', '?섎', '?꾩', '쨌']) {
      expect(source).not.toContain(fragment);
    }
  });

  it('keeps broker harness titles and restore text readable', () => {
    const source = readAppBrokerBlock();

    expect(source).toContain('const harnessName = `${projName} · ${devRole}→${revRole}`;');
    expect(source).toContain('const restoredName = deriveBrokerHarnessName(s, `${proj.displayName} - ${devRole}->${revRole}`);');
    expect(source).toContain('name: restoredName,');
    expect(source).toContain('Merge is complete, so harness terminals were closed. Logs and branch details remain above.');
    expect(source).toContain('Saved harness record restored. Terminals are not restored after restart.');
    expect(source).toContain('저장된 하네스 기록만 복구했습니다. 재시작 후 터미널은 복구하지 않습니다.');
    expect(source).toContain('병합이 완료되어 하네스 터미널을 닫았습니다. 로그와 브랜치 정보는 위에서 확인할 수 있습니다.');
  });

  it('persists and renders the broker-managed branch and worktree for each harness', () => {
    const appSource = readAppBrokerBlock();
    const modalSource = readFileSync(join(process.cwd(), 'src/components/BrokerHarnessModal.tsx'), 'utf8');
    const handleStart = appSource.indexOf('if (handle) {');
    // Window must comfortably span the whole `if (handle) { … }` attach block; the persisted
    // record (with repoDir) sits ~1.7k chars in, so a tight 1600 window clipped it as the block
    // grew. Keep generous headroom so this distance-based assertion stays robust to edits above.
    const handleBlock = appSource.slice(handleStart, handleStart + 2400);

    expect(handleStart).toBeGreaterThanOrEqual(0);
    expect(handleBlock).toContain('branch: handle.branch, worktreeDir: handle.worktreeDir,');
    expect(handleBlock).toContain('repoDir: handle.repoDir || proj.workDir,');
    expect(handleBlock).toContain('branch: handle.branch,');
    expect(handleBlock).toContain('worktreeDir: handle.worktreeDir,');
    expect(modalSource).toContain('selected.branch && <span className="bhm-broker-branch"');
    expect(modalSource).toContain('title={selected.worktreeDir || selected.branch}');
    expect(modalSource).toContain('{selected.branch}</span>');
  });

  it('keeps broker model restart controls readable in both languages', () => {
    const source = readAppBrokerBlock();

    expect(source).toContain('Models staged — agents restart only when you apply.');
    expect(source).toContain('모델이 선택됨 — 적용을 눌러야 에이전트가 재시작됩니다.');
    expect(source).toContain("{ko ? '재시작' : 'Restart as'}");
    expect(source).toContain("roleIcon('developer')");
    expect(source).toContain("roleIcon('reviewer')");
    expect(source).toContain("{ko ? '개발 에이전트' : 'DEV AGENT'}");
    expect(source).toContain("{ko ? '검토 에이전트' : 'REVIEW AGENT'}");
  });

  it('keeps inline broker harness settings readable in Korean and English', () => {
    const source = readAppBrokerBlock();
    const settingsStart = source.indexOf('const harnessSettings = (');
    const settingsBlock = source.slice(settingsStart, settingsStart + 1800);
    const noTermsReturn = source.indexOf('if (!selTerms) {');

    expect(settingsStart).toBeGreaterThanOrEqual(0);
    expect(noTermsReturn).toBeGreaterThan(settingsStart);
    expect(source.slice(noTermsReturn, noTermsReturn + 260)).toContain('{harnessSettings}');
    expect(settingsBlock).toContain("{ko ? '언어' : 'Language'}");
    expect(settingsBlock).toContain('<option value="ko">한국어</option>');
    expect(settingsBlock).toContain('<option value="en">English</option>');
    expect(settingsBlock).toContain("{ko ? '검토 강도' : 'Review'}");
    expect(settingsBlock).toContain("{ko ? '끄기' : 'Off'}");
    expect(settingsBlock).toContain("{ko ? '대충' : 'Light'}");
    expect(settingsBlock).toContain("{ko ? '보통' : 'Normal'}");
    expect(settingsBlock).toContain("{ko ? '꼼꼼히' : 'Careful'}");
    expect(settingsBlock).toContain("{ko ? '아주 꼼꼼히' : 'Very careful'}");
    expect(settingsBlock).toContain("{ko ? '빠릿 브라우저 테스트' : 'BBARIT Browser test'}");
  });

  it('keeps developer and reviewer terminal role badges visually distinct', () => {
    const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');

    expect(css).toContain(".terminal-wrapper.broker-developer .terminal-panel-title::before { content: '⚒ DEV'; }");
    expect(css).toContain(".terminal-wrapper.broker-reviewer .terminal-panel-title::before { content: '🔍 REVIEW'; }");
    expect(css).not.toContain(".terminal-wrapper.broker-reviewer .terminal-panel-title::before { content: '🦌 REVIEW'; }");
  });

  it('keeps broker language independent from the app language after a broker preference is saved', () => {
    const appSource = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    const settingsSource = readFileSync(join(process.cwd(), 'src/components/SettingsPanel.tsx'), 'utf8');

    expect(appSource).toContain("const BROKER_LANGUAGE_KEY = 'octo-broker-language';");
    expect(appSource).toContain("localStorage.getItem(BROKER_LANGUAGE_KEY)");
    expect(appSource).toContain("void kvSet(BROKER_LANGUAGE_KEY, value);");
    expect(appSource).toContain("window.dispatchEvent(new CustomEvent('octo-broker-language-change'))");
    expect(appSource).toContain('Broker language is configurable independently.');
    expect(settingsSource).toContain("const STORAGE_KEY_BROKER_LANGUAGE = 'octo-broker-language';");
    expect(settingsSource).toContain('const brokerText = brokerSettingsText(brokerLanguage);');
    expect(settingsSource).toContain("window.dispatchEvent(new CustomEvent('octo-broker-language-change'))");
  });

  it('does not expose legacy autonomous follow-up controls after merge-close policy', () => {
    const appSource = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    const pairSource = readFileSync(join(process.cwd(), 'src/devreview/devReviewPair.ts'), 'utf8');
    const settingsSource = readFileSync(join(process.cwd(), 'src/components/SettingsPanel.tsx'), 'utf8');

    expect(appSource).not.toContain('autonomous?: boolean');
    expect(appSource).not.toContain('const autonomous =');
    expect(pairSource).not.toContain('parseNextPlan');
    expect(pairSource).not.toContain('awaitingNextPlan');
    expect(pairSource).not.toContain('NEXT TASK');
    expect(appSource).not.toContain('BROKER_AUTONOMOUS_KEY');
    expect(appSource).not.toContain('setBrokerAutonomousSetting');
    expect(appSource).not.toContain('Autonomous follow-up');
    expect(appSource).not.toContain('자동 후속 작업');

    expect(settingsSource).not.toContain('STORAGE_KEY_BROKER_AUTONOMOUS');
    expect(settingsSource).not.toContain('Autonomous mode');
    expect(settingsSource).not.toContain('자율 모드');
  });

  it('uses the shared repairable broker agent role list and does not expose Ollama as a broker agent', () => {
    const appSource = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    const settingsSource = readFileSync(join(process.cwd(), 'src/components/SettingsPanel.tsx'), 'utf8');

    expect(appSource).toContain('const BROKER_ROLES: readonly DevReviewRole[] = BROKER_AGENT_ROLES;');
    expect(appSource).toContain('normalizeBrokerAgentRole(opts?.developer');
    expect(appSource).toContain('normalizeBrokerAgentRole(opts?.reviewer');
    expect(settingsSource).toContain('const BROKER_AGENT_OPTIONS = BROKER_AGENT_ROLES.map');
    expect(settingsSource).toContain('normalizeBrokerAgentRole(raw, \'claude\')');
    expect(settingsSource).toContain('normalizeBrokerAgentRole(raw, \'codex\')');
    expect(settingsSource).not.toContain("['ollama', 'Ollama']");
  });

  it('does not reuse old broker PTYs when restoring harnesses', () => {
    const source = readAppBrokerBlock();
    const restoreStart = source.indexOf('Do not restore broker harness terminals after app restart');
    const restoreBlock = source.slice(restoreStart, restoreStart + 900);

    expect(restoreStart).toBeGreaterThanOrEqual(0);
    expect(restoreBlock).toContain('brokerResumedRef.current = true;');
    expect(restoreBlock).not.toContain('const ready: BrokerSessionRecord[] = [];');
    expect(restoreBlock).not.toContain('git_worktree_add');
    expect(restoreBlock).not.toContain('headless auto merge');
    expect(restoreBlock).not.toContain('Could not restore broker terminals');
  });

  it('restores old harness records as suspended and removes stale startup/readiness logs', () => {
    const source = readAppBrokerBlock();
    const restoreStart = source.indexOf('const restoreStartedAt = Date.now();');
    const restoreBlock = source.slice(restoreStart, restoreStart + 1800);

    expect(restoreStart).toBeGreaterThanOrEqual(0);
    expect(restoreBlock).toContain("s.lifecycle === 'complete' || s.lifecycle === 'blocked' ? s.lifecycle : 'suspended'");
    expect(restoreBlock).toContain('const restoredStartupLogPattern =');
    expect(restoreBlock).toContain('CLI|agent terminals opened|Pair opened|Karpathy Wiki');
    expect(restoreBlock).toContain('\\uC900\\uBE44');
    expect(restoreBlock).toContain('\\uD130\\uBBF8\\uB110');
    expect(restoreBlock).toContain("Restored the saved harness record only. Previous terminals are not restored.");
    expect(restoreBlock).toContain("persistBrokerSessionPatchAsync(hid, { lifecycle, log: restoredLog, lastHeartbeatAt: restoreStartedAt })");
  });

  it('does not flag fresh broker harness terminals as restored just because a broker branch exists', () => {
    const source = readAppBrokerBlock();
    const terminalRenderStart = source.indexOf('const renderTerm = (term: TerminalInstance');
    const terminalRenderBlock = source.slice(terminalRenderStart, terminalRenderStart + 1200);

    expect(terminalRenderStart).toBeGreaterThanOrEqual(0);
    expect(terminalRenderBlock).toContain('isRestored={false}');
    expect(terminalRenderBlock).not.toContain('isRestored={!!selH?.branch}');
  });

  it('does not erase the last selected harness before restore hydrates selection', () => {
    const source = readAppBrokerBlock();

    expect(source).toContain('if (!selectedHarnessId) return;');
    expect(source).toContain('void kvSet(BROKER_LAST_SELECTED_KEY, selectedHarnessId || \'\');');
  });

  it('closes harness terminals only after broker reports merged status', () => {
    const source = readAppBrokerBlock();
    const eventStart = source.indexOf('const onBrokerEvent = useCallback');
    const eventEnd = source.indexOf('const waitForBrokerTerminalsReady', eventStart);
    const eventBlock = source.slice(eventStart, eventEnd);

    expect(eventStart).toBeGreaterThanOrEqual(0);
    expect(eventEnd).toBeGreaterThan(eventStart);
    expect(eventBlock).toContain("const closeHarnessTerminals = e.kind === 'status' && e.status?.cycle === 'merged';");
    expect(eventBlock).toContain('lifecycle = lifecycleFromBrokerStatus(e.status);');
    // [D-perf-persist-debounce] Persistence is coalesced per harness; status events (the
    // transitions that must survive a crash) flush immediately, chatter events trail.
    expect(eventBlock).toContain('scheduleBrokerSessionPersist(harnessId, {');
    expect(eventBlock).toContain("}, e.kind === 'status');");
    expect(eventBlock).toContain('window.setTimeout(() => {');
    expect(eventBlock).toContain('disposeHarnessTerminals(harnessId);');
  });

  it('debounces broker session persistence with immediate status flush', () => {
    const source = readAppBrokerBlock();
    const schedStart = source.indexOf('const scheduleBrokerSessionPersist = useCallback');
    const schedEnd = source.indexOf('const onBrokerEvent = useCallback', schedStart);
    const schedBlock = source.slice(schedStart, schedEnd);

    expect(schedStart).toBeGreaterThanOrEqual(0);
    expect(schedEnd).toBeGreaterThan(schedStart);
    // Latest-wins coalescing: a newer patch replaces the pending one and resets the timer.
    expect(schedBlock).toContain('if (prev) window.clearTimeout(prev.timer);');
    // Immediate path bypasses the timer entirely (status transitions must not be delayed).
    expect(schedBlock).toContain('if (immediate) {');
    expect(schedBlock).toContain('persistBrokerSessionPatch(harnessId, patch);');
    // Trailing flush persists the LATEST patch, not the one captured at schedule time.
    expect(schedBlock).toContain('if (cur) persistBrokerSessionPatch(harnessId, cur.patch);');
    expect(schedBlock).toContain('}, 1500);');
  });

  it('renders new broker terminals before waiting for agent CLI readiness', () => {
    const source = readAppBrokerBlock();
    const showPair = source.indexOf('const showOpenedPair =');
    const openPair = source.indexOf('if (ids) showOpenedPair(ids, workDir);');
    const readinessWait = source.indexOf('waitForTerminalsReady:');

    expect(showPair).toBeGreaterThanOrEqual(0);
    expect(openPair).toBeGreaterThan(showPair);
    expect(readinessWait).toBeGreaterThan(openPair);
  });

  it('gates broker readiness on idle-debounce + agent process (not banner/repair regex)', () => {
    // The repair/banner-regex readiness path was replaced by a model/CLI-agnostic
    // idle-debounce gate (Cline P1-1). This asserts the current wiring.
    const appSource = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    const source = readAppBrokerBlock();
    const idleStart = source.indexOf('const terminalIdleMs =');
    const idleBlock = source.slice(idleStart, idleStart + 400);
    const readyStart = source.indexOf('const terminalReadyForBrokerInput =');
    const readyBlock = source.slice(readyStart, readyStart + 1400);
    const pairWaitStart = source.indexOf('const waitForBrokerTerminalsReady =');
    const pairWaitBlock = source.slice(pairWaitStart, pairWaitStart + 900);

    expect(appSource).toContain("import { XTerminal, disposeTerminal, releaseTerminalRuntime, getTerminalRecentOutput, isTerminalBusy } from './XTerminal';");
    expect(appSource).toContain("import { looksLikePlainShellPrompt, looksLikeCompiling } from './terminal/agentReadiness';");

    // idle signal from the backend, not banner matching.
    expect(idleStart).toBeGreaterThanOrEqual(0);
    expect(idleBlock).toContain("invoke<number>('pty_idle_ms', { terminalId })");

    // readiness = not-raw-shell + settled (idle, longer while compiling) + agent process.
    expect(readyStart).toBeGreaterThanOrEqual(0);
    expect(readyBlock).toContain('if (looksLikePlainShellPrompt(recentOutput)) return false;');
    expect(readyBlock).toContain('const idleThreshold = looksLikeCompiling(recentOutput) ? 15000 : 1500;');
    expect(readyBlock).toContain('if (await terminalIdleMs(terminalId) < idleThreshold) return false;');
    expect(readyBlock).toContain('return await terminalHasAgentProcess(terminalId);');

    expect(pairWaitStart).toBeGreaterThanOrEqual(0);
    expect(pairWaitBlock).toContain('terminalReadyForBrokerInput(ids.developerId, _roles.developer),');
    expect(pairWaitBlock).toContain('terminalReadyForBrokerInput(ids.reviewerId, _roles.reviewer),');
  });

  it('keeps XTerminal restored PTY handling from spawning a duplicate shell', () => {
    const source = readFileSync(join(process.cwd(), 'src/XTerminal.tsx'), 'utf8');

    expect(source).toContain("import { normalizeCliFlagLines, shellQuoteArg } from './terminal/cliCommandArgs';");
    expect(source).toContain("const argShell = effectiveShellType || (isWindows ? 'powershell' : 'posix');");
    expect(source).toContain('const normalizedFlags = normalizeCliFlagLines((extraFlags || []).map((raw) => {');
    expect(source).toContain('}), argShell);');
    expect(source).toContain('cmd += ` --model ${shellQuoteArg(modelId, argShell)}`;');
    expect(source).toContain('cmd += ` --mcp-config ${shellQuoteArg(mcpConfigPath, argShell)}`;');
    expect(source).toContain("modeFlags.push('--model', shellQuoteArg(modelId, argShell));");

    expect(source).toContain('const restoredProbe = await probeRestoredPty({');
    expect(source).toContain('isRestored: _isRestored');
    expect(source).toContain('if (restoredProbe.ptyAlreadyExists && !ptyAlreadyExists)');
    expect(source).toContain('if (restoredProbe.markCliAutoStarted) restoredState.autoStartedCliType = cliType;');
    expect(source).toContain('const backendBuffer = await invoke<string>(\'read_pty_output_buffer\', { terminalId }).catch(() => \'\');');
    expect(source).toContain('startupProbeState.recentOutputText = `${startupProbeState.recentOutputText || \'\'}${backendBuffer}`.slice(-24000);');
    // Once-gate: start the CLI at most once per terminal (fresh PTY, or a never-started
    // existing PTY, or a one-time raw-shell repair) — autoStartedCliType prevents
    // re-injecting into an already-running agent (the old banner-repair spam).
    expect(source).toContain('const existingRawShell =');
    expect(source).toContain('&& looksLikePlainShellPrompt(stateBeforeStartup.recentOutputText);');
    expect(source).toContain('const shouldRunStartupCommand =');
    expect(source).toContain("(cliType !== 'shell' && stateBeforeStartup?.autoStartedCliType !== cliType) ||");
    expect(source).toContain('existingRawShell);');
  });

  it('recognizes the current Claude Code welcome screen as ready', () => {
    const source = readFileSync(join(process.cwd(), 'src/terminal/agentReadiness.ts'), 'utf8');

    expect(source).toContain('Welcome\\s+(?:to\\s+Claude|back)');
    expect(source).toContain('Claude\\s+(?:Max|Opus|Sonnet|Haiku)');
  });

  it('keeps Windows PTY shells configured for UTF-8 broker text', () => {
    const source = readFileSync(join(process.cwd(), 'src-tauri/src/main.rs'), 'utf8');

    expect(source).toContain('fn configure_windows_pty_encoding(');
    expect(source).toContain('cmd.env("LANG", "ko_KR.UTF-8");');
    expect(source).toContain('cmd.env("LC_ALL", "ko_KR.UTF-8");');
    expect(source).toContain('cmd.env("PYTHONIOENCODING", "UTF-8");');
    expect(source).toContain('chcp 65001');
    expect(source).toContain('configure_windows_pty_encoding(&mut cmd, effective_shell_type, is_ssh_pty);');
    expect(source).toContain('[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[System.Text.UTF8Encoding]::new($false); chcp 65001 > $null;');
  });
});
