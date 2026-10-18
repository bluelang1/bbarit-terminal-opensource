import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// BBARIT Browser 크롬식 리디자인(2026-07) 이후의 구조를 소스 레벨로 고정한다:
// 좌측은 실제 페이지 화면(라이브 미러/시작 화면), SEO 워크벤치는 ⋮ 메뉴의
// 오버레이, 우측 에이전트 패널은 빠릿에이전트(AgentChatPanel)이며 DeepSeek
// 경로는 존재하지 않는다.
describe('BBARIT Browser app integration', () => {
  const appSource = () => readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
  const browserSource = () => readFileSync(join(process.cwd(), 'src/pages/BrowserPage.tsx'), 'utf8');
  const browserCss = () => readFileSync(join(process.cwd(), 'src/pages/BrowserPage.css'), 'utf8');
  const appCss = () => readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');
  const browserCliSource = () => readFileSync(join(process.cwd(), 'agent-browser-cli/bin/bbarit-browser-control.mjs'), 'utf8');
  const packageSource = () => readFileSync(join(process.cwd(), 'package.json'), 'utf8');
  const windowsTauriSource = () => readFileSync(join(process.cwd(), 'src-tauri/tauri.windows.conf.json'), 'utf8');
  const reportCheckSource = () => readFileSync(join(process.cwd(), 'scripts/browser-agent-report-check.mjs'), 'utf8');
  const cssBlock = (css: string, selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`))?.[0] || '';
  };

  it('opens the standalone browser with project scope but without removed pane flags', () => {
    const source = appSource();
    expect(source).toContain("params.set('project', activeProject.workDir)");
    expect(source).toContain("params.set('chrome', 'hidden')");
    expect(source).toContain("params.set('agent', '1')");
    expect(source).not.toContain("params.set('tree', '1')");
    expect(source).not.toContain("params.set('terminal', '1')");
    expect(source).not.toContain("params.set('packets', '1')");
  });

  it('opens BBARIT Browser in its own window from the toolbar', () => {
    const source = appSource();
    expect(source).toContain("void openToolWindow('browser')");
    expect(source).toContain("browser: { title: 'BBARIT Browser', width: 1280, height: 860, path: '/browser' }");
  });

  it('renders a Chrome-like toolbar with a single always-on omnibox', () => {
    const source = browserSource();
    expect(source).toContain('browser-nav-row chrome-like');
    expect(source).toContain('browser-address-form');
    expect(source).toContain('browser-omni-star');
    // 옛 Target 폼과 툴바 프로젝트 블록은 ⋮ 메뉴/옴니박스로 흡수됐다.
    expect(source).not.toContain('browser-toolbar-target');
    expect(source).not.toContain('browser-toolbar-project');
    expect(source).not.toContain('SEO Workbench</span>');
  });

  it('exposes the SEO workbench as an overlay and as the aside Page Tools pane', () => {
    // ⋮ 메뉴는 툴바 직노출 버튼으로 리팩터링돼 사라졌고(HEAD 기준 이미 부재),
    // 워크벤치는 오버레이 + 사이드바 Page Tools 패널(renderSeoSection 재사용)로 열린다.
    const source = browserSource();
    expect(source).toContain('setShowSeoPanel');
    expect(source).toContain('browser-seo-overlay');
    expect(source).toContain('browser-seo-workflow');
    expect(source).toContain('renderSeoSection()');
    expect(browserCss()).toContain('.browser-seo-overlay');
  });

  it('shows a Chrome new-tab style start page instead of the SEO dashboard', () => {
    const source = browserSource();
    expect(source).toContain('renderStartPage');
    expect(source).toContain('browser-start-page');
    expect(source).toContain('browser-start-search');
    expect(browserCss()).toContain('.browser-start-page');
  });

  it('hosts the BBARIT agent panel via the aside (no DeepSeek anywhere)', () => {
    // 에이전트 독은 사이드바(BrowserAside)로 승격 — AgentChatPanel은
    // AsideAgentPane이 래핑해 호스팅한다 (docs/BROWSER-ASIDE-DESIGN-2026-07-06.md).
    const source = browserSource();
    expect(source).toContain('<BrowserAside');
    expect(source).toContain('<AsideAgentPane');
    expect(source).toContain('현재 BBARIT Browser URL: ${currentUrl');
    const asidePane = readFileSync(join(process.cwd(), 'src/pages/browser/AsideAgentPane.tsx'), 'utf8');
    expect(asidePane).toContain('<AgentChatPanel');
    expect(asidePane).toContain('compact');
    expect(asidePane).toContain('promptPrefix');
    expect(source).not.toContain('deepseek.com');
    expect(source).not.toContain('DEEPSEEK_');
    expect(source).not.toContain('DeepSeekBrowserAgent');
  });

  it('adds Skills and Site Logins panes to the browser aside', () => {
    const source = browserSource();
    const aside = readFileSync(join(process.cwd(), 'src/pages/browser/BrowserAside.tsx'), 'utf8');
    // Rail exposes the new panes.
    expect(aside).toContain("export type AsidePane = 'agent' | 'skills' | 'logins'");
    expect(aside).toContain("id: 'skills'");
    expect(aside).toContain("id: 'logins'");
    // BrowserPage wires both panes.
    expect(source).toContain('<AsideSkillsPane');
    expect(source).toContain('<AsideLoginsPane');
    expect(source).toContain('onRunSkill={runAsideSkill}');
    // Skills gallery merges the three known sources.
    const skills = readFileSync(join(process.cwd(), 'src/pages/browser/AsideSkillsPane.tsx'), 'utf8');
    expect(skills).toContain("loadRemoteSkillManifest('/skills-hub/famous-skills-manifest.json')");
    expect(skills).toContain('OPENJARVIS_SKILLS');
    expect(skills).toContain('BROWSER_SKILLS');
  });

  it('ships AI-browser workflows for tab comparison, page QA, planning, forms, shopping, research, and data collection', () => {
    const asidePane = readFileSync(join(process.cwd(), 'src/pages/browser/AsideAgentPane.tsx'), 'utf8');
    expect(asidePane).toContain('const WORKFLOWS');
    expect(asidePane).toContain("label: 'Understand'");
    expect(asidePane).toContain("label: 'Act safely'");
    expect(asidePane).toContain("label: 'Create output'");
    expect(asidePane).toContain("label: 'Collect data'");
    expect(asidePane).toContain('aria-label="AI browser workflows"');
    expect(asidePane).toContain("label: 'Compare tabs'");
    expect(asidePane).toContain("label: 'Research brief'");
    expect(asidePane).toContain("label: 'Ask page'");
    expect(asidePane).toContain("label: 'Action plan'");
    expect(asidePane).toContain("label: 'Link map'");
    expect(asidePane).toContain("label: 'Load all'");
    expect(asidePane).toContain("label: 'Export CSV'");
    expect(asidePane).toContain("label: 'Watch changes'");
    expect(asidePane).toContain("label: 'Dismiss cookies'");
    expect(asidePane).toContain("label: 'Form helper'");
    expect(asidePane).toContain("label: 'Shop check'");
    expect(asidePane).toContain('mentioned tabs');

    const skills = readFileSync(join(process.cwd(), 'src/pages/browser/AsideSkillsPane.tsx'), 'utf8');
    expect(skills).toContain("B('compare-tabs'");
    expect(skills).toContain("B('research-brief'");
    expect(skills).toContain("B('page-qa'");
    expect(skills).toContain("B('action-plan'");
    expect(skills).toContain("B('link-map'");
    expect(skills).toContain("B('load-all'");
    expect(skills).toContain("B('export-data'");
    expect(skills).toContain("B('watch-changes'");
    expect(skills).toContain("B('dismiss-consent'");
    expect(skills).toContain("B('form-helper'");
    expect(skills).toContain('current page and any mentioned tabs');
    expect(skills).toContain('without submitting');

    const css = browserCss();
    expect(css).toContain('.aside-agent-workflows');
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
  });

  it('bumps browser onboarding when new AI workflow surfaces ship', () => {
    const onboarding = readFileSync(join(process.cwd(), 'src/pages/browserOnboarding.ts'), 'utf8');
    expect(onboarding).toContain('export const ONBOARDING_VERSION = 3;');
  });

  it('fills logins without auto-submitting and never puts the password in the agent prompt', () => {
    const source = browserSource();
    // Autofill injects values but leaves submission to the human.
    expect(source).toContain('const autofillLogin = useCallback');
    expect(source).toContain("input[type=password]");
    expect(source).toContain('do NOT ask for or print the password');
    // Agent sign-in delegates the click, not the secret.
    expect(source).toContain('const agentLogin = useCallback');
    expect(source).toContain('runAsideTaskRef.current(task)');
    // Credentials persist locally via kv, not localStorage.
    expect(source).toContain("kvSet('browser-aside-logins'");
  });

  it('hides the CEF view while the aside persona picker modal is open', () => {
    // CEF NSView는 모든 DOM 위에 그려지므로, 패널 안 전체화면 모달(페르소나 피커)이
    // 열리면 anyOverlayOpen 경로로 네이티브 뷰를 숨겨야 모달이 가려지지 않는다.
    const source = browserSource();
    expect(source).toContain('|| asideModalOpen');
    expect(source).toContain('onModalOpenChange={setAsideModalOpen}');
    const asidePane = readFileSync(join(process.cwd(), 'src/pages/browser/AsideAgentPane.tsx'), 'utf8');
    expect(asidePane).toContain('onModalOpenChange={onModalOpenChange}');
    const chatPanel = readFileSync(join(process.cwd(), 'src/components/AgentChatPanel.tsx'), 'utf8');
    expect(chatPanel).toContain('onModalOpenChange?.(personaModalOpen)');
  });

  it('keeps the find bar out of the sidebar margin offset groups (absolute + right only)', () => {
    // 찾기바는 absolute + right(--dsa-width 반영) 앵커다. margin-right(--dsa-width)
    // 그룹에 넣으면 이중 오프셋으로 화면 밖으로 밀려 "찾기 버튼이 안 되는" 증상이 된다.
    const css = browserCss();
    expect(css).toContain('.browser-page.aside-mode .browser-find-bar { right: calc(var(--dsa-width, 36px) + 18px); }');
    const marginBlocks = css.split('}').filter((block) => block.includes('margin-right: var(--dsa-width'));
    expect(marginBlocks.length).toBeGreaterThan(0);
    for (const block of marginBlocks) expect(block).not.toContain('.browser-find-bar');
  });

  it('reserves a chrome strip below the toolbar for the find bar in webview mode', () => {
    // 네이티브 뷰 위에는 DOM이 못 뜨고(z-index 무시) 툴바(z-index 100) 뒤에도
    // 가려지므로, find-open일 때 서피스를 내려 찾기바가 보일 띠를 확보해야 한다.
    const source = browserSource();
    const css = browserCss();
    expect(source).toContain("(findOpen ? 'find-open ' : '')");
    expect(css).toContain('.browser-page.webview-mode .browser-find-bar { top: 100px; }');
    expect(css).toContain('.browser-page.webview-mode.find-open .browser-exact-surface { top: 142px; }');
  });

  it('keeps unavailable SEO commands clickable so they can explain the required desktop context', () => {
    const source = browserSource();
    const css = browserCss();
    expect(source).toContain('data-unavailable={!canStartSeoReport');
    expect(source).toContain('data-unavailable={!canDetectLocalTarget');
    expect(css).toContain('.browser-seo-controls button[data-unavailable="true"]');
    expect(source).not.toContain('disabled={!canStartSeoReport}');
  });

  it('exposes page recording on the API surface, the toolbar, and the CLI', () => {
    const source = browserSource();
    const css = browserCss();
    const cli = browserCliSource();
    // Engine: screenshot frame loop -> canvas stream -> MediaRecorder, exposed on __BBARIT_BROWSER__.
    expect(source).toContain('recordStart: async (options?: { fps?: number }) => recordStart(options)');
    expect(source).toContain('recordStop: async () => recordStop()');
    expect(source).toContain('recordStatus: () => recordStatus()');
    expect(source).toContain("MediaRecorder.isTypeSupported(m)");
    // Toolbar record toggle with a recording state.
    expect(source).toContain('browser-record-btn');
    expect(source).toContain('recordingActive');
    expect(css).toContain('.browser-record-btn.recording');
    // CLI subcommands write the encoded video to disk.
    expect(cli).toContain("command === 'record-start'");
    expect(cli).toContain("command === 'record-status'");
    expect(cli).toContain("command === 'record-stop'");
    expect(cli).toContain('return await api.recordStop();');
    // Saved recordings announce their file location with a reveal action,
    // and the path is resolved before recordStop so a failed save cannot
    // destroy a running recording.
    expect(source).toContain('browser-record-saved-banner');
    expect(source).toContain('Recording saved:');
    expect(source).toContain("invoke('reveal_in_explorer', { path: recordSavedInfo.path })");
    expect(source.indexOf('recordSave needs a file path')).toBeLessThan(source.indexOf('const result = await recordStop();'));
  });

  it('does not keep unused browser language/session helper state', () => {
    const source = browserSource();
    expect(source).not.toContain('aiAnswerLanguage');
    expect(source).not.toContain('const browserSessionText');
  });

  it('recovers native WebView tabs that are created before cefOpenTab resolves', () => {
    const source = browserSource();
    expect(source).toContain('pendingCefOpenRef');
    expect(source).toContain('claimPendingCefOpen(url)');
    expect(source).toContain('const beforeIds = new Set(cefTabsRef.current.map((t) => t.id));');
    expect(source).toContain('let id = await cefOpenTab(target, activeSessionId || undefined);');
    expect(source).toContain('id == null && i < 25');
    expect(source).toContain('normalizeUrl(t.url) === target && (!beforeIds.has(t.id) || t.id === cefActiveIdRef.current)');
    expect(source).toContain('!cefTabsRef.current.some((t) => t.id === id)');
  });

  it('inherits the active CLI session for WebView popups and target blank tabs', () => {
    const source = browserSource();
    expect(source).toContain('const activeSessionId = cefTabsRef.current.find((t) => t.id === cefActiveIdRef.current)?.sessionId;');
    expect(source).toContain('void cefOpenTab(String(p.url), activeSessionId || undefined);');
    expect(source).toContain('const inheritedSessionId = prevActive == null');
    expect(source).toContain('cefTabsRef.current.find((t) => t.id === prevActive)?.sessionId');
    expect(source).toContain('pendingOpen?.sessionId');
    expect(source).toContain('inheritedSessionId ? String(inheritedSessionId) : undefined');
  });

  it('keeps the active tab when multiple tabs share the same CLI session', () => {
    const source = browserSource();
    expect(source).toContain('t.sessionId === sid && t.id === cefActiveIdRef.current');
    expect(source).toContain('[...cefTabsRef.current].reverse().find((t) => t.sessionId === sid)');
  });

  it('preserves WebView local history entries across back and forward', () => {
    const source = browserSource();
    expect(source).toContain('pendingCefHistoryNavRef');
    expect(source).toContain('pendingCefHistoryNavRef.current.set(id, { url: target, index: nextIndex');
    expect(source).toContain("withCefHistory(t, eventUrl, 'index', pendingHistoryNav.index)");
    expect(source).toContain('pendingCefHistoryNavRef.current.delete(id)');
  });

  it('keeps CLI-created new tabs in the active browser session', () => {
    const browser = browserSource();
    const cli = browserCliSource();
    expect(browser).toContain('newTab: async (url = DEFAULT_BROWSER_URL, sessionId?: string)');
    expect(browser).toContain('const activeSessionId = sessionId || cefTabsRef.current.find((t) => t.id === cefActiveIdRef.current)?.sessionId;');
    expect(browser).toContain('cefOpenTab(target, activeSessionId || undefined)');
    expect(cli).not.toContain("'new-tab', 'switch-tab'");
    expect(cli).toContain('const tab = await api.newTab');
    expect(cli).toContain('JSON.stringify(browserSession ||');
  });

  it('reports the native browser engine by platform instead of hard-coding Windows WebView2', () => {
    const source = browserSource();
    expect(source).toContain('const nativeWebviewEngineLabel = () =>');
    expect(source).toContain("return 'webview2';");
    expect(source).toContain("return 'wkwebview';");
    expect(source).toContain("browserEngine: nativeWebviewEngineLabel()");
    expect(source).not.toContain("browserEngine: 'webview2'");
  });

  it('attaches the URL session parameter to the first auto-opened WebView tab', () => {
    const source = browserSource();
    expect(source).toContain("const initialSessionId = params.get('session') || undefined;");
    expect(source).toContain('cefOpenTab(normalizeUrl(currentUrl || address || DEFAULT_BROWSER_URL), initialSessionId)');
  });

  it('keeps browser CLI sessions explicit so terminal session ids do not create tab loops', () => {
    const source = browserCliSource();
    expect(source).toContain('const explicitBrowserSession = readArg');
    expect(source).toContain("const browserSession = explicitBrowserSession || ''");
    expect(source).not.toContain('process.env.TERM_SESSION_ID');
    expect(source).not.toContain("|| 'default'");
    expect(source).toContain('let rpcTimeoutRetries = 0');
    expect(source).toContain("message.includes('Script execution timeout')");
    expect(source).toContain("message.includes('browser not found')");
    expect(source).toContain('rpcTimedOut && rpcTimeoutRetries < 8');
  });

  it('retargets browser:open to the requested URL for both reused and newly-created windows', () => {
    const source = browserCliSource();
    expect(source).toContain('const navigateBrowserApi = async');
    expect(source).toContain('await api.navigateExisting');
    expect(source).toContain('const nav = await navigateBrowserApi(openRpcTimeoutMs);');
    expect(source).toContain('opened: false, reused: true');
    expect(source).toContain("created: { ok: true, event: 'requested' }");
    expect(source).toContain('retarget: nav || null');
  });

  it('returns browser window bootstrap before the five-second MCP execute limit', () => {
    const source = browserCliSource();
    expect(source).toContain('const openRpcTimeoutMs = 1200;');
    expect(source).not.toContain('waitForBrowserApi(12000)');
    expect(source).not.toContain('waitForBrowserApi(22000)');
  });

  it('provides a real-site browser control audit for agents', () => {
    const source = browserCliSource();
    expect(source).toContain('async function performSiteControlAudit()');
    expect(source).toContain("readArg('--url', 'https://www.naver.com')");
    expect(source).toContain("readArg('--query', '빠릿 브라우저 테스트')");
    expect(source).toContain("command === 'control-audit'");
    expect(source).toContain('directCdpHumanClickSelector');
    expect(source).toContain('directCdpHumanTypeSelector');
    expect(source).toContain('api.typeSelector-human-cdp');
    expect(source).toContain('direct-cdp-human-pointer');
    expect(source).toContain('direct-cdp-human-input');
    expect(source).toContain("nativeEvalOnSessionBody(nativeKeyScript('Enter')");
    expect(source).toContain("directCdpKeyCombo('Enter')");
    expect(source).toContain("mode: 'active-webview-enter'");
    expect(source).toContain('find-input');
    expect(source).toContain('type-input');
    expect(source).toContain('find-submit-or-enter');
    expect(source).toContain('submit-search');
    expect(source).toContain('history-back');
    expect(source).toContain('history-forward');
    expect(source).toContain('const deadline = Date.now() + 10000;');
    expect(source).toContain('currentUrl !== previousUrl');
    expect(source).toContain("readArg('--external-url', 'https://example.com/')");
    expect(source).toContain('Array.from(document.querySelectorAll(selector)).find((candidate) => eligible(candidate))');
    expect(source).toContain("return !!target && target !== '_self';");
    expect(source).toContain('data-bbarit-synthetic-external-audit');
    expect(source).toContain("'synthetic-fallback'");
    expect(source).toContain('external-link-open');
    expect(source).toContain('expectedSession: browserSession || null');
    expect(source).toContain('checkedSessionTabs: openedOrActiveTabs');
    expect(source).toContain('openedOrActiveTabs.every((tab) => tab?.sessionId === browserSession)');
    expect(source).toContain('if (!report.ok) process.exit(1)');
  });

  it('keeps AI browser capability coverage in the browser verification gate', () => {
    const pkg = JSON.parse(packageSource());
    const audit = readFileSync(join(process.cwd(), 'scripts/browser-ai-capability-audit.mjs'), 'utf8');
    expect(pkg.scripts['browser:ai-audit']).toContain('scripts/browser-ai-capability-audit.mjs');
    expect(pkg.scripts['browser:verify']).toContain('browser:ai-audit');
    expect(audit).toContain('flagship AI browser capabilities are visible in the sidebar');
    expect(audit).toContain('tool-backed capabilities reference registered browser tools');
    expect(audit).toContain('sensitive browser tasks are gated before agent execution');
  });

  it('exposes one cross-platform browser verification gate for macOS and Windows', () => {
    const pkg = JSON.parse(packageSource());
    const windowsTauri = JSON.parse(windowsTauriSource());
    const platformVerify = readFileSync(join(process.cwd(), 'scripts/platform-full-verify.mjs'), 'utf8');
    const browserAgentVerify = readFileSync(join(process.cwd(), 'scripts/browser-agent-verify.mjs'), 'utf8');
    const sourceWrapper = readFileSync(join(process.cwd(), 'scripts/tauri-opensource.mjs'), 'utf8');
    const sourceTauri = JSON.parse(readFileSync(join(process.cwd(), 'src-tauri/tauri.opensource.conf.json'), 'utf8'));
    const reportCheck = reportCheckSource();
    expect(pkg.scripts['browser:platform-audit']).toContain('scripts/browser-platform-audit.mjs');
    expect(pkg.scripts['browser:platform-audit']).toContain('--file .octo-tmp/browser-platform-audit.json');
    expect(pkg.scripts['browser-agent:verify']).toBe('node scripts/browser-agent-verify.mjs');
    expect(pkg.scripts['browser-agent:report-check']).toBe('node scripts/browser-agent-report-check.mjs');
    expect(pkg.scripts['browser-agent:report-check:self-test']).toBe('node scripts/browser-agent-report-check-selftest.mjs');
    expect(pkg.scripts['platform:verify']).toBe('node scripts/platform-full-verify.mjs');
    expect(pkg.scripts['mac:verify']).toContain('--require-platform darwin');
    expect(pkg.scripts['mac:verify']).toContain('.octo-tmp/mac-full-verify.json');
    expect(pkg.scripts['win:verify']).toContain('--require-platform win32');
    expect(pkg.scripts['win:verify']).toContain('.octo-tmp/win-full-verify.json');
    expect(pkg.scripts['browser-agent:compare-reports']).toContain('.octo-tmp/mac-browser-agent-verify.json');
    expect(pkg.scripts['browser-agent:compare-reports']).toContain('.octo-tmp/win-browser-agent-verify.json');
    expect(pkg.scripts['browser-agent:compare-reports']).toContain('--compare-platform win32');
    expect(pkg.scripts['mac:browser-agent:verify']).toContain('--require-platform darwin');
    expect(pkg.scripts['mac:browser-agent:verify']).toContain('.octo-tmp/mac-browser-agent-verify.json');
    expect(pkg.scripts['mac:browser-agent:report-check']).toContain('--platform darwin');
    expect(pkg.scripts['mac:browser-agent:report-check']).toContain('--allow-skip-build');
    expect(pkg.scripts['win:browser-agent:verify']).toContain('--require-platform win32');
    expect(pkg.scripts['win:browser-agent:verify']).toContain('.octo-tmp/win-browser-agent-verify.json');
    expect(pkg.scripts['win:browser-agent:report-check']).toContain('--platform win32');
    expect(pkg.scripts['win:browser-agent:report-check']).not.toContain('--allow-skip-build');
    expect(pkg.scripts['win:browser-agent:verify:ps1']).toContain('scripts/windows/browser-agent-verify.ps1');
    expect(pkg.scripts['browser:assert']).toContain('--file .octo-tmp/browser-assert.json');
    expect(pkg.scripts['browser:control-audit']).toContain('control-audit --url https://www.naver.com');
    expect(pkg.scripts['browser:control-audit']).toContain('--session browser-control-audit');
    expect(pkg.scripts['browser:verify']).toBe('npm run browser:ai-audit && npm run browser:platform-audit && npm run browser:assert && npm run browser:control-audit');
    expect(windowsTauri.bundle.windows.webviewInstallMode.type).toBe('downloadBootstrapper');
    expect(windowsTauri.bundle.targets).toEqual(expect.arrayContaining(['nsis', 'msi']));
    expect(platformVerify).toContain("if (process.platform === 'darwin') return 'mac:browser-agent:verify'");
    expect(platformVerify).toContain("if (process.platform === 'win32') return 'win:browser-agent:verify'");
    expect(platformVerify).toContain("runStep('browser and BBARIT agent end-to-end verification', npmCommand(), ['run', browserVerifyScriptForPlatform()])");
    expect(browserAgentVerify).toContain("resolve(repoRoot, 'scripts/browser-agent-report-check.mjs')");
    expect(browserAgentVerify).toContain("'--platform',\n    process.platform");
    expect(browserAgentVerify).toContain('checkGeneratedReport(out, skipBuild)');
    expect(pkg.scripts['tauri:dev']).toBe('node scripts/tauri-opensource.mjs dev');
    expect(pkg.scripts['tauri:build']).toBe('node scripts/tauri-opensource.mjs build');
    expect(sourceWrapper).toContain("'--config', 'src-tauri/tauri.opensource.conf.json'");
    expect(sourceWrapper).toContain('env: sourceBuildEnvironment(process.env)');
    expect(sourceTauri.identifier).toBe('com.bbarit.terminal.source');
    expect(sourceTauri.plugins.updater.endpoints).toEqual([]);
    expect(sourceTauri.bundle.createUpdaterArtifacts).toBe(false);
    expect(reportCheck).toContain("const REQUIRED_CONTROL_AUDIT_TARGET_HOST = 'www.naver.com'");
    expect(reportCheck).toContain("const REQUIRED_CONTROL_AUDIT_SESSION = 'browser-control-audit'");
    expect(reportCheck).toContain('targetOk && auditSessionOk');
  });

  it('closes other floating menus and keeps the terminal layout picker as one dropdown', () => {
    const source = appSource();
    expect(source).toContain('const closeFloatingMenus = useCallback');
    expect(source).toContain("closeFloatingMenus('editors')");
    expect(source).toContain("closeFloatingMenus('tool')");
    expect(source).toContain("closeFloatingMenus('settings')");
    // The old cramped 3-button + overflow control stays gone; the picker is a single trigger.
    expect(source).not.toContain('terminal-layout-segmented');
    expect(source).toContain('terminal-layout-trigger');
    expect(source).toContain("closeFloatingMenus('terminalLayout')");
    expect(source).toContain("closeFloatingMenus('terminalCreate')");
    expect(source).toContain("closeFloatingMenus('terminalMore')");
    expect(source).toContain("closeFloatingMenus('theme')");
    expect(source).toContain("octo:close-filetree-menus");
    expect(source).toContain("octo:close-app-floating-menus");
  });

  it('offers every terminal split layout from the header picker', () => {
    const source = appSource();
    for (const mode of ['tabs', 'horizontal', 'vertical', 'tree', 'tiled', 'tiled_tb', 'grid', 'mix', 'monitor']) {
      expect(source).toContain(`setTerminalSplitMode('${mode}')`);
    }
  });

  it('keeps compact terminal menus aligned inside the right edge of the toolbar', () => {
    const css = appCss();
    const compactMenu = cssBlock(css, '.terminal-compact-menu');
    expect(compactMenu).toContain('right: 0;');
    // The layout menu must inherit that right alignment, or it overflows the window edge.
    expect(cssBlock(css, '.terminal-layout-menu')).not.toContain('right:');
  });

  it('keeps terminal chrome compact without shrinking action click targets', () => {
    const css = appCss();
    const marker = '/* Terminal workspace density optimization';
    const start = css.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const optimizedCss = css.slice(start);
    expect(optimizedCss).toContain('height: 36px !important;');
    expect(optimizedCss).toContain('min-height: 28px !important;');
    expect(optimizedCss).toContain('margin: 3px !important;');
  });
});
