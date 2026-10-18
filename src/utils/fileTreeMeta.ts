const TEXT_LIKE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'go', 'h', 'hpp', 'html', 'htm', 'java', 'js', 'json', 'jsx',
  'kt', 'less', 'log', 'lua', 'markdown', 'md', 'mdx', 'mermaid', 'mjs', 'py', 'rb', 'rs', 'scss',
  'sh', 'sql', 'svg', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh',
]);

const TEXT_LIKE_BASENAMES = new Set([
  'dockerfile',
  'license',
  'makefile',
  'readme',
]);

export function countTextLines(content: string): number {
  if (!content) return 0;
  return content.split(/\r\n|\r|\n/).length;
}

export function countUtf8Bytes(content: string): number {
  if (!content) return 0;
  return new TextEncoder().encode(content).length;
}

export function isLineCountEligiblePath(pathOrName: string): boolean {
  const raw = String(pathOrName || '').trim();
  if (!raw) return false;
  const base = raw.split(/[/\\]/).pop()?.toLowerCase() || '';
  if (!base) return false;
  if (TEXT_LIKE_BASENAMES.has(base)) return true;
  const ext = base.includes('.') ? base.split('.').pop() || '' : '';
  return TEXT_LIKE_EXTENSIONS.has(ext);
}

export function formatFileSize(sizeBytes: number | null | undefined): string | null {
  if (!Number.isFinite(sizeBytes as number) || (sizeBytes as number) < 0) return null;
  const value = Number(sizeBytes);
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)}KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)}MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function normalizeFileUriPath(uri: string): string | null {
  const raw = String(uri || '').trim();
  if (!raw.toLowerCase().startsWith('file://')) return null;
  try {
    let decoded = decodeURIComponent(raw.replace(/^file:\/\/localhost/i, 'file://'));
    decoded = decoded.replace(/^file:\/\//i, '');
    if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
    return decoded.trim() || null;
  } catch {
    return null;
  }
}

function normalizePossibleExternalPath(value: string | null | undefined): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const fromFileUri = normalizeFileUriPath(raw);
  if (fromFileUri) return fromFileUri;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return raw;
  if (raw.startsWith('/') || raw.startsWith('\\')) return raw;
  return null;
}

export function extractExternalDropPathsFromDataTransfer(dataTransfer: {
  files?: ArrayLike<File | { path?: string | null }>;
  items?: ArrayLike<DataTransferItem | { kind?: string; getAsFile?: () => (File & { path?: string | null }) | null }>;
  getData?: (type: string) => string;
} | null | undefined): string[] {
  if (!dataTransfer) return [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    const next = String(value || '').trim();
    if (!next || seen.has(next)) return;
    seen.add(next);
  };

  const files = Array.from(dataTransfer.files || []);
  for (const file of files) {
    const nativePath = (file as File & { path?: string | null })?.path;
    if (typeof nativePath === 'string' && nativePath.trim()) {
      push(nativePath);
    }
  }

  const items = Array.from(dataTransfer.items || []);
  for (const item of items) {
    if ((item as DataTransferItem).kind && (item as DataTransferItem).kind !== 'file') continue;
    const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
    const nativePath = (file as File & { path?: string | null })?.path;
    if (typeof nativePath === 'string' && nativePath.trim()) {
      push(nativePath);
    }
  }

  if (seen.size > 0) return Array.from(seen);

  const uriList = typeof dataTransfer.getData === 'function'
    ? String(dataTransfer.getData('text/uri-list') || '')
    : '';
  if (uriList.trim()) {
    for (const line of uriList.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      push(normalizeFileUriPath(trimmed));
    }
  }

  const plainText = typeof dataTransfer.getData === 'function'
    ? String(dataTransfer.getData('text/plain') || '')
    : '';
  if (plainText.trim()) {
    for (const line of plainText.split(/\r?\n/)) {
      push(normalizePossibleExternalPath(line));
    }
  }

  return Array.from(seen);
}
