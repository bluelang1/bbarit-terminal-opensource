import { describe, it, expect } from 'vitest';
import { detectCliLaunchFailure, buildCliInstallGuide } from './cliInstallGuard';

// 실제 Windows 실기에서 캡처된 깨진 npm 셔임 에러 (claude 네이티브 이전 잔재)
const BROKEN_SHIM_KR = `PS C:\\Users\\S\\Desktop\\HK-Partners-CRM> claude --dangerously-skip-permissions --continue
& : 'C:\\Users\\S\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe' 용어가 cmdlet, 함수, 스크립트 파일 또는 실행할 수 있는 프로그램 이름으로 인식되지 않습니다.
위치 C:\\Users\\S\\AppData\\Roaming\\npm\\claude.ps1:1:14
+   & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"  ...
    + CategoryInfo          : ObjectNotFound: (C:\\Users\\S\\AppD.../bin/claude.exe:String) [], CommandNotFoundException
    + FullyQualifiedErrorId : CommandNotFoundException`;

describe('detectCliLaunchFailure', () => {
  it('should_detect_broken_npm_shim_from_korean_powershell_output', () => {
    expect(detectCliLaunchFailure('claude', BROKEN_SHIM_KR)).toBe('broken-npm-shim');
  });

  it('should_detect_english_powershell_not_recognized', () => {
    const out = `The term 'claude' is not recognized as the name of a cmdlet, function, script file, or operable program.`;
    expect(detectCliLaunchFailure('claude', out)).toBe('not-found');
  });

  it('should_detect_korean_powershell_not_recognized_without_shim_path', () => {
    const out = `'codex' 용어가 cmdlet, 함수, 스크립트 파일 또는 실행할 수 있는 프로그램 이름으로 인식되지 않습니다.`;
    expect(detectCliLaunchFailure('codex', out)).toBe('not-found');
  });

  it('should_detect_cmd_exe_korean_not_recognized', () => {
    const out = `'claude'은(는) 내부 또는 외부 명령, 실행할 수 있는 프로그램, 또는 배치 파일이 아닙니다.`;
    expect(detectCliLaunchFailure('claude', out)).toBe('not-found');
  });

  it('should_detect_zsh_command_not_found', () => {
    expect(detectCliLaunchFailure('claude', 'zsh: command not found: claude')).toBe('not-found');
  });

  it('should_detect_bash_command_not_found', () => {
    expect(detectCliLaunchFailure('kimi', 'bash: kimi: command not found')).toBe('not-found');
  });

  it('should_detect_wrap_cli_check_echo', () => {
    expect(detectCliLaunchFailure('codex', 'codex CLI not found. Install: npm i -g @openai/codex')).toBe('not-found');
  });

  it('should_not_match_startup_command_echo_line', () => {
    // 프롬프트가 붙은 명령 에코엔 not-found 문구가 인용부호 안에 들어 있다 — 오탐 금지
    const echoLine = 'test-user@mac dir % command -v gjc >/dev/null 2>&1 && gjc || echo "gjc CLI not found. Install: npm i -g bun gajae-code"';
    expect(detectCliLaunchFailure('gajae', echoLine)).toBeNull();
    // 실제 실패 출력(줄 시작)은 잡아야 한다
    expect(detectCliLaunchFailure('gajae', `${echoLine}\ngjc CLI not found. Install: npm i -g bun gajae-code`)).toBe('not-found');
  });

  it('should_ignore_other_binary_not_found', () => {
    // 에이전트가 돌린 다른 명령의 not-found를 CLI 기동 실패로 오인하면 안 된다
    expect(detectCliLaunchFailure('claude', 'zsh: command not found: ffmpeg')).toBeNull();
  });

  it('should_ignore_normal_agent_output', () => {
    const out = 'Welcome to Claude Code!\n> try "claude --help" for usage';
    expect(detectCliLaunchFailure('claude', out)).toBeNull();
  });

  it('should_ignore_shell_terminals', () => {
    expect(detectCliLaunchFailure('shell', 'zsh: command not found: claude')).toBeNull();
    expect(detectCliLaunchFailure(undefined, 'command not found: claude')).toBeNull();
  });

  it('should_strip_ansi_before_matching', () => {
    const out = `\x1b[31mzsh: command not found: gemini\x1b[0m`;
    expect(detectCliLaunchFailure('gemini', out)).toBe('not-found');
  });
});

describe('buildCliInstallGuide', () => {
  it('should_use_native_installer_and_shim_cleanup_for_claude_broken_shim_on_windows', () => {
    const g = buildCliInstallGuide('claude', 'broken-npm-shim', true);
    expect(g.fixCommand).toContain('irm https://claude.ai/install.ps1 | iex');
    expect(g.fixCommand).toContain('Remove-Item');
    expect(g.fixCommand).toContain('claude.ps1');
  });

  it('should_not_remove_shims_for_npm_reinstall_fixes', () => {
    // npm 재설치는 셔임을 재생성하므로 지우면 방금 만든 셔임을 지워버린다
    const g = buildCliInstallGuide('codex', 'broken-npm-shim', true);
    expect(g.fixCommand).toBe('npm i -g @openai/codex');
  });

  it('should_return_posix_install_for_not_found_on_mac', () => {
    const g = buildCliInstallGuide('claude', 'not-found', false);
    expect(g.fixCommand).toBe('npm i -g @anthropic-ai/claude-code');
  });

  it('should_return_windows_installer_for_claude_not_found_on_windows', () => {
    const g = buildCliInstallGuide('claude', 'not-found', true);
    expect(g.fixCommand).toBe('irm https://claude.ai/install.ps1 | iex');
  });

  it('should_have_no_fix_command_for_bundled_bbarit', () => {
    const g = buildCliInstallGuide('bbarit', 'not-found', false);
    expect(g.fixCommand).toBeNull();
    expect(g.lines.join(' ')).toContain('Reinstall or update the app');
  });
});
