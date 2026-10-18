// Cmd/Ctrl+클릭된 터미널 경로의 공통 라우팅. 메인 창(App)과 에이전트 세션 창이
// 같은 규칙을 쓴다: 바이너리/미디어는 OS 기본 앱으로, 그 외는 앱 내 에디터로.

export const OS_OPEN_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'pdf',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'm4a',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'rar', '7z', 'dmg',
  'exe', 'dll', 'so', 'dylib', 'woff', 'woff2', 'ttf', 'otf',
  'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'psd', 'sketch', 'fig',
]);

export interface TerminalClickTarget {
  path: string;
  line: number;
  osOpen: boolean;
}

export function resolveTerminalClickPath(raw: string, workDir?: string, line?: number): TerminalClickTarget | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  const wd = (workDir || '').replace(/\/+$/, '');
  const isAbsolute = trimmed.startsWith('/') || trimmed.startsWith('~') || /^[A-Za-z]:[\\/]/.test(trimmed);
  const resolved = isAbsolute ? trimmed : (wd ? `${wd}/${trimmed}` : trimmed);
  const base = resolved.split(/[\\/]/).pop() || resolved;
  const ext = base.includes('.') ? (base.split('.').pop() || '').toLowerCase() : '';
  return {
    path: resolved,
    line: Math.max(1, Number(line) || 1),
    osOpen: !!ext && OS_OPEN_EXTS.has(ext),
  };
}
