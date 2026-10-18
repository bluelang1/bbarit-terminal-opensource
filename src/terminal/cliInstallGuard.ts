// CLI 터미널 기동 실패(미설치·깨진 설치) 감지 + 설치 안내.
// Windows에선 startup 명령이 사전 확인 없이 그대로 실행되고, npm 셔임만 남고
// 실체 exe가 사라진 경우(claude 네이티브 이전 잔재)는 사전 확인으로도 못 잡는다.
// 그래서 실행 "출력"의 실패 패턴을 감지해 재시도를 멈추고 안내 배너를 띄운다.

import { stripTerminalControls, type AgentCliKind } from './agentReadiness';

export type CliLaunchFailureKind = 'not-found' | 'broken-npm-shim';

interface CliInstallInfo {
  binName: string;
  displayName: string;
  install: string; // POSIX(macOS/Linux) install command
  installWin?: string; // Windows PowerShell install command (없으면 install 사용)
  // installWin이 npm이 아닌 네이티브 설치일 때만 true — 낡은 npm 셔임을 지워야
  // PATH가 네이티브 바이너리를 잡는다. npm 재설치는 셔임을 재생성하므로 지우면 안 됨.
  winShimCleanup?: boolean;
  bundled?: boolean; // 앱에 내장 배포 (별도 설치 없음)
}

export const CLI_INSTALL_INFO: Partial<Record<AgentCliKind, CliInstallInfo>> = {
  claude: {
    binName: 'claude',
    displayName: 'Claude Code',
    install: 'npm i -g @anthropic-ai/claude-code',
    installWin: 'irm https://claude.ai/install.ps1 | iex',
    winShimCleanup: true,
  },
  codex: { binName: 'codex', displayName: 'OpenAI Codex', install: 'npm i -g @openai/codex' },
  cursor: { binName: 'cursor-agent', displayName: 'Cursor Agent', install: 'curl https://cursor.com/install -fsS | bash' },
  opencode: { binName: 'opencode', displayName: 'OpenCode', install: 'curl -fsSL https://opencode.ai/install | bash' },
  gajae: { binName: 'gjc', displayName: 'Gajae-Code', install: 'npm i -g bun gajae-code' },
  kimi: { binName: 'kimi', displayName: 'Kimi CLI', install: 'npm i -g @moonshot-ai/kimi-cli' },
  gemini: { binName: 'gemini', displayName: 'Gemini CLI', install: 'npm i -g @google/gemini-cli' },
  qwen: { binName: 'qwen', displayName: 'Qwen Code', install: 'npm i -g @qwen-code/qwen-code' },
  pi: { binName: 'pi', displayName: 'Pi', install: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent' },
  reasonix: { binName: 'reasonix', displayName: 'Reasonix', install: 'npm i -g reasonix' },
  bbarit: { binName: 'bbarit', displayName: 'BBARIT Agent', install: '', bundled: true },
  'bbarit-oss': { binName: 'bbarit-oss', displayName: 'BBARIT OSS Agent', install: 'curl -fsSL https://bbarit.com/agent/install.sh | sh' },
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function detectCliLaunchFailure(
  cliType: AgentCliKind | undefined,
  output: string,
): CliLaunchFailureKind | null {
  if (!cliType || cliType === 'shell') return null;
  const info = CLI_INSTALL_INFO[cliType];
  if (!info) return null;
  const visible = stripTerminalControls(output || '');
  if (!visible) return null;
  const bin = escapeRe(info.binName);

  // Windows: npm 셔임(claude.ps1)은 남았는데 대상 exe가 사라진 경우.
  // 예: & : 'C:\...\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'
  //     용어가 cmdlet... / CommandNotFoundException
  const brokenShimPath = new RegExp(`node_modules[\\\\/][^'"\\n]*${bin}[^'"\\n]*\\.exe`, 'i');
  const notRecognized = /CommandNotFoundException|용어가\s+cmdlet|is not recognized as/i;
  if (brokenShimPath.test(visible) && notRecognized.test(visible)) return 'broken-npm-shim';

  // 일반 미설치: PowerShell / cmd.exe / 유닉스 셸 / wrapCliCheck 자체 에코
  const patterns = [
    // PowerShell KR/EN: '<bin>' 용어가 cmdlet... / The term '<bin>' is not recognized as...
    new RegExp(`['"‘’]?${bin}(?:\\.exe|\\.ps1|\\.cmd)?['"‘’]?[^\\n]{0,60}(?:용어가\\s+cmdlet|is not recognized as)`, 'i'),
    // cmd.exe KR: '<bin>'은(는) 내부 또는 외부 명령...
    new RegExp(`['"]?${bin}['"]?[^\\n]{0,20}내부 또는 외부 명령`),
    // Unix: zsh: command not found: <bin> / bash: <bin>: command not found
    new RegExp(`command not found[:\\s]+${bin}(?:\\s|$)`, 'im'),
    new RegExp(`(?:^|[\\s:])${bin}:\\s*command not found`, 'im'),
    // wrapCliCheck 자체 에코: "<bin> CLI not found." — 줄 시작 앵커 필수.
    // startup 명령 자체에 이 문구가 인용부호로 들어 있어(`|| echo "..."`), 앵커가
    // 없으면 프롬프트가 붙은 명령 에코 라인에도 매칭돼 설치된 CLI를 오탐한다.
    new RegExp(`(?:^|\\n)\\s*${bin} CLI not found\\.`),
  ];
  if (patterns.some((re) => re.test(visible))) return 'not-found';
  return null;
}

export interface CliInstallGuide {
  title: string;
  lines: string[];
  fixCommand: string | null;
}

export function buildCliInstallGuide(
  cliType: AgentCliKind,
  kind: CliLaunchFailureKind,
  isWindows: boolean,
): CliInstallGuide {
  const info = CLI_INSTALL_INFO[cliType];
  const name = info?.displayName || cliType;
  if (!info || info.bundled) {
    return {
      title: `${name} failed to start`,
      lines: [`${name} ships inside BBARIT Terminal. Reinstall or update the app to restore it.`],
      fixCommand: null,
    };
  }
  const install = (isWindows ? info.installWin : undefined) || info.install;
  if (kind === 'broken-npm-shim' && isWindows) {
    const shimCleanup = info.winShimCleanup
      ? `; Remove-Item "$env:APPDATA\\npm\\${info.binName}.ps1","$env:APPDATA\\npm\\${info.binName}.cmd","$env:APPDATA\\npm\\${info.binName}" -ErrorAction SilentlyContinue`
      : '';
    return {
      title: `${name} installation is broken`,
      lines: [
        `A stale npm launcher points to a missing ${info.binName} binary.`,
        'Run Fix to reinstall, then press Retry.',
      ],
      fixCommand: `${install}${shimCleanup}`,
    };
  }
  return {
    title: `${name} CLI not found`,
    lines: [`The \`${info.binName}\` command is not installed on this machine.`],
    fixCommand: install || null,
  };
}
