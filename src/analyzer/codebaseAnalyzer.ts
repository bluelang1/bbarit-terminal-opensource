/**
 * codebaseAnalyzer — 디렉토리 스캔 기반 코드베이스 메타데이터 수집
 *
 * 파일 목록 + LOC + 디렉토리 구조만 수집.
 * import 파싱, 심볼 추출, 의존성 분석은 AI가 직접 수행.
 * 캐시: localStorage + TTL 30분
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  AnalysisProgress,
  CodebaseScan,
  DirEntry,
  FileEntry,
  FileRole,
} from './types.ts';
import { SCAN_SCHEMA_VERSION } from './types.ts';
import { kvGet, kvSet, kvDelete } from '../hooks/useKV';

// === 상수 ===

const CACHE_TTL_MS = 30 * 60 * 1000; // 30분
const CACHE_KEY_PREFIX = 'octo-scan-';

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'target', 'build', 'coverage',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.cache',
  '.octo', '.tauri', '.svelte-kit',
  'vendor', 'Pods', '.gradle', '.idea', '.vscode',
  'bin', 'obj', 'out', '.dart_tool', '.pub-cache',
]);

const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'rs', 'py', 'go',
  'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp',
  'rb', 'php', 'vue', 'svelte', 'dart', 'scala', 'cs',
  'css', 'json', 'toml', 'yaml', 'yml',
]);

interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

// === 파일 역할 감지 (디렉토리명/파일명 기반) ===

function detectFileRole(path: string, ext: string): FileRole {
  const name = path.split('/').pop() || '';
  const dir = path.toLowerCase();

  // 테스트
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(name)) return 'test';
  if (name.startsWith('test_') || name.endsWith('_test.py') || name.endsWith('_test.go')) return 'test';
  if (name.endsWith('Test.java') || name.endsWith('Test.kt') || name.endsWith('_spec.rb')) return 'test';
  if (dir.includes('__tests__') || dir.includes('/test/') || dir.includes('/tests/') || dir.includes('/spec/')) return 'test';

  // 스타일
  if (['css', 'scss', 'less', 'sass'].includes(ext)) return 'style';

  // 설정
  if (['json', 'toml', 'yaml', 'yml', 'xml'].includes(ext)) return 'config';

  // 엔트리 포인트
  if (/^(main|index|app)\.(tsx?|jsx?|rs|py|go|java|kt|swift|rb|php)$/.test(name)) return 'entry';
  if (name === 'index.html' || name === 'manage.py') return 'entry';

  // 백엔드 언어
  if (['rs', 'go', 'java', 'kt'].includes(ext)) return 'backend';

  // 디렉토리 기반
  if (dir.includes('/components/')) return 'component';
  if (dir.includes('/hooks/') || name.startsWith('use')) return 'hook';
  if (dir.includes('/pages/') || dir.includes('/views/')) return 'page';
  if (dir.includes('/store/') || dir.includes('/state/')) return 'store';
  if (dir.includes('/utils/') || dir.includes('/helpers/') || dir.includes('/lib/')) return 'util';
  if (dir.includes('/types/') || dir.includes('/interfaces/')) return 'type';
  if (dir.includes('/config/') || dir.includes('/constants/')) return 'config';

  // 이름 기반
  if (/^[A-Z].*\.(tsx|jsx)$/.test(name)) return 'component';
  if (/^use[A-Z]/.test(name.replace(/\.\w+$/, ''))) return 'hook';
  if (name.endsWith('.d.ts')) return 'type';

  return 'other';
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// === 캐시 ===

export async function getCachedScan(projectId: string): Promise<CodebaseScan | null> {
  try {
    const raw = await kvGet(`${CACHE_KEY_PREFIX}${projectId}`);
    if (!raw) return null;
    const data = JSON.parse(raw) as CodebaseScan;
    if (Date.now() - data.analyzedAt > CACHE_TTL_MS) {
      void kvDelete(`${CACHE_KEY_PREFIX}${projectId}`);
      return null;
    }
    if (data.version !== SCAN_SCHEMA_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

export function cacheScan(scan: CodebaseScan): void {
  try {
    void kvSet(
      `${CACHE_KEY_PREFIX}${scan.projectId}`,
      JSON.stringify(scan),
    );
  } catch {
    // storage 용량 초과 시 무시
  }
}

export function clearScanCache(projectId: string): void {
  void kvDelete(`${CACHE_KEY_PREFIX}${projectId}`);
}

// === 메인 스캔 함수 ===

export async function scanCodebase(
  projectId: string,
  rootDir: string,
  onProgress?: (progress: AnalysisProgress) => void,
): Promise<CodebaseScan> {
  const startTime = Date.now();

  // Phase 1: 디렉토리 재귀 스캔
  onProgress?.({ phase: 'scanning', current: 0, total: 0, message: '파일 스캔 중...' });

  const files: FileEntry[] = [];
  const rootDirEntry: DirEntry = { name: rootDir.split('/').pop() || '', path: '', fileCount: 0, children: [] };

  await scanDirectory(rootDir, rootDir, files, rootDirEntry);

  onProgress?.({ phase: 'scanning', current: files.length, total: files.length, message: `${files.length}개 파일 발견` });

  // Phase 2: LOC 카운트 (소스 파일만, 배치 처리)
  const sourceFiles = files.filter(f => !['json', 'toml', 'yaml', 'yml', 'xml', 'css'].includes(f.extension));
  let totalLoc = 0;

  const BATCH_SIZE = 15;
  for (let i = 0; i < sourceFiles.length; i += BATCH_SIZE) {
    const batch = sourceFiles.slice(i, i + BATCH_SIZE);
    onProgress?.({
      phase: 'counting',
      current: i,
      total: sourceFiles.length,
      message: `LOC 카운트 중... (${i}/${sourceFiles.length})`,
    });

    const results = await Promise.all(
      batch.map(async (f) => {
        try {
          const source = await invoke<string>('read_file', { path: f.absPath });
          const loc = source.split('\n').length;
          f.loc = loc;
          f.size = source.length;
          return loc;
        } catch {
          return 0;
        }
      }),
    );

    for (const loc of results) totalLoc += loc;
  }

  onProgress?.({ phase: 'done', current: files.length, total: files.length, message: '스캔 완료' });

  return {
    projectId,
    analyzedAt: Date.now(),
    rootDir,
    version: SCAN_SCHEMA_VERSION,
    files,
    directories: rootDirEntry.children,
    totalFiles: files.length,
    totalLoc,
    analysisTimeMs: Date.now() - startTime,
  };
}

// === 내부 유틸 ===

async function scanDirectory(
  dir: string,
  rootDir: string,
  files: FileEntry[],
  parentDirEntry: DirEntry,
): Promise<void> {
  const maxDepth = 10;

  async function scan(currentDir: string, depth: number, parent: DirEntry) {
    if (depth > maxDepth) return;

    let entries: FsEntry[];
    try {
      entries = await invoke<FsEntry[]>('read_directory', { path: currentDir });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.is_dir) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

        const relativePath = entry.path.startsWith(rootDir)
          ? entry.path.slice(rootDir.length + 1)
          : entry.path;

        const dirEntry: DirEntry = { name: entry.name, path: relativePath, fileCount: 0, children: [] };
        parent.children.push(dirEntry);

        await scan(entry.path, depth + 1, dirEntry);

        // 하위 파일 수 집계
        dirEntry.fileCount = countFiles(dirEntry);
      } else {
        const ext = getExtension(entry.name);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;

        const relativePath = entry.path.startsWith(rootDir)
          ? entry.path.slice(rootDir.length + 1)
          : entry.path;

        files.push({
          path: relativePath,
          absPath: entry.path,
          role: detectFileRole(relativePath, ext),
          extension: ext,
          loc: 0,  // Phase 2에서 채움
          size: 0,
        });

        parent.fileCount++;
      }
    }
  }

  await scan(dir, 0, parentDirEntry);
}

function countFiles(dir: DirEntry): number {
  let count = dir.fileCount;
  for (const child of dir.children) {
    count += countFiles(child);
  }
  return count;
}
