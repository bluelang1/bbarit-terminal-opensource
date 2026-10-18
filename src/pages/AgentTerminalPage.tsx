/**
 * AgentTerminalPage: standalone window for a single agent's terminal.
 * URL params: ?terminalId=xxx&label=xxx&projectId=xxx
 */
import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import Editor from '@monaco-editor/react';
import { XTerminal } from '../XTerminal';
import { resolveTerminalClickPath } from '../terminal/openTerminalPath';
import { getSubWindowContext } from './windowUtils';
import { useRestoreFocusOnWindowFocus } from '../hooks/useRestoreFocusOnWindowFocus';
import { useTranslation } from '../i18n';
import { useConfig } from '../config/ConfigContext';
import { withBbaritAgentLanguageFlags } from '../terminal/bbaritAgentLanguage';
import { STYLES, FONTS } from '../theme';
import { OctoSquid, OctoOctopus, OctoX } from '../octoIcons';
import './AgentTerminalPage.css';

export default function AgentTerminalPage() {
  const { t, locale } = useTranslation();
  const { config } = useConfig();
  // 창 전환 후 복귀 시 터미널 입력 포커스 복원
  useRestoreFocusOnWindowFocus();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const terminalId = params.get('terminalId') || '';
  const label = params.get('label') || 'Agent';
  const cliType = (params.get('cliType') || 'shell') as any;
  const displayCli = params.get('displayCli') || cliType;
  const isLeader = params.get('isLeader') === '1';
  const autoAccept = params.get('autoAccept') === '1';
  // Detached (popped-out) terminals attach to an already-running PTY: restored=1
  // makes XTerminal probe the backend and replay its output buffer as history.
  const restored = params.get('restored') === '1';
  const workDirOverride = params.get('workDir') || '';
  const task = params.get('task') || '';
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);

  const [ctx, setCtx] = useState<Awaited<ReturnType<typeof getSubWindowContext>>>({ project: null, projects: [], style: STYLES[0], font: FONTS[0] });
  const bbaritAgentExtraFlags = useMemo(
    () => withBbaritAgentLanguageFlags(config.agent.bbaritFlags, config.agent.bbaritLanguage, config.agent.bbaritPersona),
    [config.agent.bbaritFlags, config.agent.bbaritLanguage, config.agent.bbaritPersona],
  );
  useEffect(() => { getSubWindowContext().then(setCtx).catch(() => {}); }, []);
  const { style, font, project } = ctx;

  // Cmd/Ctrl+클릭한 경로를 이 창 안에서 문서 뷰로 전환해 보여준다.
  // (octo-open-terminal-path는 창별 window 이벤트라 메인 창이 대신 받지 못한다)
  const [doc, setDoc] = useState<{ path: string; line: number } | null>(null);
  const [docContent, setDocContent] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [docModified, setDocModified] = useState(false);
  const docReqRef = useRef('');
  const docEditorRef = useRef<any>(null);

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { path?: string; line?: number; workDir?: string } | undefined;
      const target = resolveTerminalClickPath(detail?.path || '', detail?.workDir, detail?.line);
      if (!target) return;
      if (target.osOpen) {
        void invoke('plugin:shell|open', { path: target.path }).catch(() => {});
        return;
      }
      docReqRef.current = target.path;
      setDoc({ path: target.path, line: target.line });
      setDocContent(null);
      setDocError(null);
      setDocModified(false);
      invoke<string>('read_file', { path: target.path })
        .then((content) => { if (docReqRef.current === target.path) setDocContent(content); })
        .catch((e) => { if (docReqRef.current === target.path) setDocError(String(e)); });
    };
    window.addEventListener('octo-open-terminal-path', handler as EventListener);
    return () => window.removeEventListener('octo-open-terminal-path', handler as EventListener);
  }, []);

  const saveDoc = useCallback(async () => {
    if (!doc || docContent === null) return;
    try {
      await invoke('write_file', { path: doc.path, content: docContent });
      setDocModified(false);
    } catch (e) {
      setDocError(String(e));
    }
  }, [doc, docContent]);

  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveDoc();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, saveDoc]);

  // 같은 파일에서 다른 줄을 클릭해도 (리마운트 없이) 해당 줄로 이동
  useEffect(() => {
    const editor = docEditorRef.current;
    if (!editor || !doc || docContent === null) return;
    editor.revealLineInCenter(doc.line);
    editor.setPosition({ lineNumber: doc.line, column: 1 });
    editor.focus();
  }, [doc, docContent]);

  const docLanguage = useMemo(() => {
    const ext = (doc?.path || '').split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
      c: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift',
      kt: 'kotlin', scala: 'scala', sh: 'shell', bash: 'shell', zsh: 'shell',
      html: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
      json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
      md: 'markdown', sql: 'sql', dockerfile: 'dockerfile',
    };
    return langMap[ext] || 'plaintext';
  }, [doc?.path]);

  const isLightBg = (hex: string) => {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 128;
  };

  if (!terminalId) {
    const ko = locale === 'ko';
    const closeWindow = () => {
      void getCurrentWindow().close().catch(() => {
        window.close();
      });
    };
    const copyDiagnostics = () => {
      const diagnostics = {
        reason: 'missing-terminal-id',
        url: window.location.href,
        search: window.location.search,
        label,
        cliType,
        displayCli,
        isLeader,
        autoAccept,
        workDir: workDirOverride,
        projectId: params.get('projectId') || '',
      };
      void navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2)).then(() => {
        setDiagnosticsCopied(true);
      }).catch(() => {
        setDiagnosticsCopied(false);
      });
    };

    return (
      <div
        className={`agent-term-page agent-term-missing ${isLightBg(style.bg) ? 'light-theme' : ''}`}
        style={{
          '--bg-color': style.bg,
          '--text-color': style.text,
          '--accent-color': style.accent,
          '--font-family': font.value,
        } as React.CSSProperties}
      >
        <div className="agent-term-empty ui-empty-state ui-panel">
          <strong>{ko ? '터미널 ID가 없습니다.' : t('agentTerm.noTerminalId')}</strong>
          <p>
            {ko
              ? '이 창은 터미널 ID 없이 열려서 세션에 연결할 수 없습니다.'
              : 'This window was opened without a terminal ID, so it cannot attach to a session.'}
          </p>
          <div className="agent-term-empty-actions ui-action-row">
            <button type="button" className="ui-button ui-button-primary" onClick={() => window.location.assign('/')}>
              {ko ? '메인 작업공간 열기' : 'Open main workspace'}
            </button>
            <button type="button" className="ui-button" onClick={closeWindow}>
              {ko ? '창 닫기' : 'Close window'}
            </button>
            <button type="button" className="ui-button" onClick={copyDiagnostics}>
              {diagnosticsCopied ? (ko ? '진단 복사됨' : 'Diagnostics copied') : (ko ? '진단 복사' : 'Copy diagnostics')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`agent-term-page ${isLightBg(style.bg) ? 'light-theme' : ''}`}
      style={{
        '--bg-color': style.bg,
        '--text-color': style.text,
        '--accent-color': style.accent,
        '--font-family': font.value,
      } as React.CSSProperties}
    >
      <div className="agent-term-header" data-tauri-drag-region>
        <span className="agent-term-icon">
          {isLeader ? <OctoOctopus size={16} /> : <OctoSquid size={16} />}
        </span>
        <span className="agent-term-label">{label}</span>
        <span className="agent-term-cli">{displayCli}</span>
        {task && <span className="agent-term-task">{task}</span>}
        <button
          className="agent-term-close"
          onClick={() => getCurrentWindow().close()}
          title={locale === 'ko' ? '닫기' : 'Close'}
          aria-label={locale === 'ko' ? '닫기' : 'Close'}
        >
          <OctoX size={14} />
        </button>
      </div>
      <div className="agent-term-container">
        <XTerminal
          terminalId={terminalId}
          workDir={workDirOverride || project?.workDir || ''}
          isActive={true}
          isRestored={restored}
          style={style}
          fontFamily={font.value}
          fontSize={13}
          cursorBlink={true}
          cursorStyle="block"
          scrollback={5000}
          cliType={cliType}
          autoAccept={autoAccept}
          extraFlags={cliType === 'bbarit' ? bbaritAgentExtraFlags : undefined}
        />
        {doc && (
          <div className="agent-term-doc">
            <div className="agent-term-doc-bar">
              <button
                className="agent-term-doc-back"
                onClick={() => { docReqRef.current = ''; setDoc(null); }}
                title="Back to terminal"
              >
                ‹ Terminal
              </button>
              <span className="agent-term-doc-path" title={doc.path}>
                {doc.path}{docModified ? ' ●' : ''}
              </span>
              <button
                className="agent-term-doc-save"
                onClick={() => { void saveDoc(); }}
                disabled={!docModified}
              >
                Save
              </button>
            </div>
            <div className="agent-term-doc-body">
              {docError ? (
                <div className="agent-term-doc-message">{docError}</div>
              ) : docContent === null ? (
                <div className="agent-term-doc-message">Loading…</div>
              ) : (
                <Editor
                  key={doc.path}
                  height="100%"
                  language={docLanguage}
                  value={docContent}
                  theme={isLightBg(style.bg) ? 'vs' : 'vs-dark'}
                  onChange={(v) => { setDocContent(v ?? ''); setDocModified(true); }}
                  onMount={(editor) => {
                    docEditorRef.current = editor;
                    editor.revealLineInCenter(doc.line);
                    editor.setPosition({ lineNumber: doc.line, column: 1 });
                    editor.focus();
                  }}
                  options={{ fontSize: 13, minimap: { enabled: false }, wordWrap: 'on', scrollBeyondLastLine: false }}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
