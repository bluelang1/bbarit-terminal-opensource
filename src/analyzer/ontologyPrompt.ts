/**
 * scanToPrompt — 스캔 결과 → AI 프롬프트 변환
 *
 * 파일 목록 + 디렉토리 구조를 압축된 텍스트로 변환.
 * AI가 이 정보를 기반으로 직접 파일을 읽고 의존성/구조를 파악.
 */

import type { CodebaseScan, DirEntry, FileEntry } from './types.ts';

/** 스캔 결과를 AI 프롬프트용 텍스트로 변환 */
export function scanToPrompt(scan: CodebaseScan): string {
  const lines: string[] = [];

  lines.push(`=== CODEBASE SCAN (${scan.totalFiles} files, ${scan.totalLoc} LOC) ===`);
  lines.push('');

  // 디렉토리 구조 (트리)
  lines.push('DIRECTORY STRUCTURE:');
  for (const dir of scan.directories) {
    renderDirTree(dir, '  ', lines);
  }
  lines.push('');

  // 파일 목록 (역할별 그룹)
  const byRole = groupByRole(scan.files);
  lines.push('FILES BY ROLE:');

  for (const [role, files] of byRole) {
    lines.push(`  [${role}] ${files.length} files`);
    // LOC 기준 상위 파일
    const sorted = [...files].sort((a, b) => b.loc - a.loc);
    const shown = sorted.slice(0, 20);
    for (const f of shown) {
      const locStr = f.loc > 0 ? ` ${f.loc}L` : '';
      lines.push(`    ${f.path}${locStr}`);
    }
    if (sorted.length > 20) {
      lines.push(`    ... +${sorted.length - 20} more`);
    }
  }
  lines.push('');

  // 큰 파일 (AI가 우선 확인할 파일)
  const largeFiles = [...scan.files]
    .filter(f => f.loc > 100)
    .sort((a, b) => b.loc - a.loc)
    .slice(0, 15);

  if (largeFiles.length > 0) {
    lines.push('LARGEST FILES (check these for core logic):');
    for (const f of largeFiles) {
      lines.push(`  ${f.path} [${f.role}] ${f.loc}L`);
    }
    lines.push('');
  }

  lines.push('NOTE: This is a file listing only. Read relevant files directly to understand imports, dependencies, and code structure.');

  return lines.join('\n');
}

// === 내부 유틸 ===

function renderDirTree(dir: DirEntry, indent: string, lines: string[]): void {
  const countStr = dir.fileCount > 0 ? ` (${dir.fileCount} files)` : '';
  lines.push(`${indent}${dir.name}/${countStr}`);
  for (const child of dir.children) {
    renderDirTree(child, indent + '  ', lines);
  }
}

function groupByRole(files: FileEntry[]): [string, FileEntry[]][] {
  const groups = new Map<string, FileEntry[]>();
  for (const f of files) {
    const list = groups.get(f.role) || [];
    list.push(f);
    groups.set(f.role, list);
  }
  // 파일 수 순 정렬
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}
