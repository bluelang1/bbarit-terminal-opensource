/**
 * 코드베이스 스캔 결과 타입 정의
 *
 * 디렉토리 스캔으로 파일 목록 + 메타데이터만 수집.
 * import 파싱, 심볼 추출, 의존성 분석은 AI가 직접 수행.
 */

// === 파일 메타데이터 ===

/** 파일 역할 (디렉토리명/파일명 기반 추정) */
export type FileRole =
  | 'component'
  | 'hook'
  | 'util'
  | 'type'
  | 'config'
  | 'style'
  | 'test'
  | 'page'
  | 'store'
  | 'backend'
  | 'entry'
  | 'other';

/** 스캔된 파일 정보 (내용은 읽지 않음) */
export interface FileEntry {
  path: string;           // 프로젝트 루트 기준 상대 경로
  absPath: string;
  role: FileRole;         // 디렉토리/파일명 기반 추정
  extension: string;      // 'ts', 'py', 'rs' 등
  loc: number;            // 줄 수 (소스 파일만, 아니면 0)
  size: number;           // 바이트 크기
}

/** 디렉토리 구조 (트리) */
export interface DirEntry {
  name: string;
  path: string;           // 상대 경로
  fileCount: number;      // 하위 소스 파일 수
  children: DirEntry[];
}

// === 분석 진행 상황 ===

export interface AnalysisProgress {
  phase: 'scanning' | 'counting' | 'done';
  current: number;
  total: number;
  message?: string;
}

// === 전체 스캔 결과 ===

export const SCAN_SCHEMA_VERSION = 2;

export interface CodebaseScan {
  projectId: string;
  analyzedAt: number;
  rootDir: string;
  version: number;

  files: FileEntry[];
  directories: DirEntry[];

  totalFiles: number;
  totalLoc: number;
  analysisTimeMs: number;
}
