import { describe, expect, it } from 'vitest';
import { looksLikeAgentUiReady, looksLikePlainShellPrompt, stripTerminalControls, removeLastLineArtifacts, looksLikeCompiling, stripInjectedEcho } from './agentReadiness';

describe('agent readiness detection', () => {
  it('recognizes current Claude Code welcome screens', () => {
    expect(looksLikeAgentUiReady('claude', 'Claude Code\nWelcome back 조훈상이야!\nOpus 4.8 (1M context)\nClaude Max')).toBe(true);
    expect(looksLikeAgentUiReady('claude', 'Welcome to Claude\ncwd: C:/repo')).toBe(true);
  });

  it('recognizes Codex startup banners', () => {
    expect(looksLikeAgentUiReady('codex', 'OpenAI Codex (v0.141.0)\nmodel: gpt-5.5 high\ndirectory: C:/repo\npermissions: YOLO mode')).toBe(true);
  });

  it('does not treat an empty shell prompt as an agent UI', () => {
    expect(looksLikeAgentUiReady('claude', 'PS C:/repo>')).toBe(false);
    expect(looksLikeAgentUiReady('codex', 'PS C:/repo>')).toBe(false);
  });

  it('strips terminal control sequences before matching', () => {
    const raw = '\u001b[32mOpenAI Codex\u001b[0m\r\nmodel: gpt-5.5';
    expect(stripTerminalControls(raw)).toContain('OpenAI Codex');
    expect(looksLikeAgentUiReady('codex', raw)).toBe(true);
  });

  it('recognizes raw shell prompts without treating agent banners as shell prompts', () => {
    expect(looksLikePlainShellPrompt('PS C:\\Users\\test-user\\repo> ')).toBe(true);
    expect(looksLikePlainShellPrompt('PS C:\\Users\\test-user\\Documents\\projects\\gudae\\.octo-tmp\\broker-wt\r\n-1782152309382-1> ')).toBe(true);
    expect(looksLikePlainShellPrompt('C:\\Users\\test-user\\repo>')).toBe(true);
    expect(looksLikePlainShellPrompt('>>')).toBe(true);
    expect(looksLikePlainShellPrompt('OpenAI Codex (v0.141.0)\nmodel: gpt-5.5')).toBe(false);
  });

  // P1-2 (Cline VscodeTerminalProcess.ts:331). 경계값 4종: 정상/매핑/None/변조.
  describe('removeLastLineArtifacts', () => {
    it('정상: strips a single trailing prompt char + ws from only the last line', () => {
      expect(removeLastLineArtifacts('OpenAI Codex\nmodel: gpt-5.5\n$ ')).toBe('OpenAI Codex\nmodel: gpt-5.5');
      expect(removeLastLineArtifacts('hello% ')).toBe('hello');
      expect(removeLastLineArtifacts('done #')).toBe('done');
    });
    it('매핑: leaves earlier lines and inner prompt chars untouched', () => {
      expect(removeLastLineArtifacts('a > b\nc')).toBe('a > b\nc');
      expect(removeLastLineArtifacts('plain text')).toBe('plain text');
    });
    it('None: empty/whitespace input returns empty', () => {
      expect(removeLastLineArtifacts('')).toBe('');
      // @ts-expect-error guard against null at runtime
      expect(removeLastLineArtifacts(null)).toBe('');
      expect(removeLastLineArtifacts('   ')).toBe('');
    });
    it('변조: only one trailing char removed, not a run', () => {
      expect(removeLastLineArtifacts('x >>> ')).toBe('x >>'); // strips last `>` + ws only
    });
  });

  // P2-4 (Cline constants.ts:85). 경계값 4종.
  describe('looksLikeCompiling', () => {
    it('정상: marker without nullifier is compiling', () => {
      expect(looksLikeCompiling('vite v7 building for production...')).toBe(true);
      expect(looksLikeCompiling('Transpiling 42 files')).toBe(true);
    });
    it('매핑: a terminating nullifier cancels the hold', () => {
      expect(looksLikeCompiling('✓ compiled successfully')).toBe(false);
      expect(looksLikeCompiling('building... error TS2304')).toBe(false);
      expect(looksLikeCompiling('build complete')).toBe(false);
    });
    it('None: no marker / empty is not compiling', () => {
      expect(looksLikeCompiling('')).toBe(false);
      expect(looksLikeCompiling('just a normal prompt >')).toBe(false);
    });
    it('변조: ANSI-wrapped marker still detected', () => {
      expect(looksLikeCompiling('[36mCompiling[0m src/main.rs')).toBe(true);
    });
  });

  // P2-2 (Cline VscodeTerminalProcess.ts:159). 경계값 4종.
  describe('stripInjectedEcho', () => {
    it('정상: drops leading lines that echo the injected command', () => {
      const out = 'claude --dangerously-skip-permissions\nWelcome to Claude\ncwd: /repo';
      expect(stripInjectedEcho(out, 'claude --dangerously-skip-permissions')).toBe('Welcome to Claude\ncwd: /repo');
    });
    it('매핑: stops at the first non-echo line and keeps the rest intact', () => {
      const out = 'codex resume\nOpenAI Codex\ncodex resume'; // trailing match is NOT stripped
      expect(stripInjectedEcho(out, 'codex resume --last')).toBe('OpenAI Codex\ncodex resume');
    });
    it('None: no injected command returns the output unchanged', () => {
      expect(stripInjectedEcho('hello\nworld', '')).toBe('hello\nworld');
      expect(stripInjectedEcho('hello\nworld', undefined)).toBe('hello\nworld');
      expect(stripInjectedEcho('', 'x')).toBe('');
    });
    it('변조: output that is ALL echo collapses to empty', () => {
      expect(stripInjectedEcho('claude\nclaude', 'claude --foo')).toBe('');
    });
  });

  it('does not treat a lone `>` agent input prompt as a raw shell prompt', () => {
    // Claude Code / Codex render a single `>` input prompt. Treating it as a raw
    // shell made the broker re-inject "claude --dangerously-skip-permissions"
    // into the already-running agent on a loop.
    expect(looksLikePlainShellPrompt('>')).toBe(false);
    expect(looksLikePlainShellPrompt('> ')).toBe(false);
    expect(looksLikePlainShellPrompt('Hatching… (42s)\n>')).toBe(false);
    // PowerShell continuation (`>>`) must still be repairable.
    expect(looksLikePlainShellPrompt('>>')).toBe(true);
  });
});
