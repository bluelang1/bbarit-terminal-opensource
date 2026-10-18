import { invoke } from '@tauri-apps/api/core';
import { ATLASCLOUD_DEFAULT_BASE_URL, ATLASCLOUD_DEFAULT_MODEL, ATLASCLOUD_KV_KEYS } from './atlasCloudRuntime';

export type HarnessDoctorStatus = 'pass' | 'warn' | 'fail';

export interface HarnessDoctorCheck {
  name: string;
  status: HarnessDoctorStatus;
  message: string;
}

function statusIcon(status: HarnessDoctorStatus): string {
  if (status === 'pass') return '[OK]';
  if (status === 'warn') return '[!!]';
  return '[XX]';
}

async function kvGet(key: string): Promise<string | null> {
  try {
    const value = await invoke<string | null>('kv_get', { key });
    if (value != null) return value;
  } catch {
    // Fall back below.
  }
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

export async function runHarnessDoctor(workDir: string): Promise<HarnessDoctorCheck[]> {
  const checks: HarnessDoctorCheck[] = [];

  try {
    await invoke('read_directory', { path: workDir });
    checks.push({ name: '작업할 프로젝트', status: 'pass', message: workDir });
  } catch (error) {
    checks.push({ name: '작업할 프로젝트', status: 'fail', message: String(error) });
  }

  const [apiKey, baseUrl, model] = await Promise.all([
    kvGet(ATLASCLOUD_KV_KEYS.apiKey),
    kvGet(ATLASCLOUD_KV_KEYS.baseUrl),
    kvGet(ATLASCLOUD_KV_KEYS.model),
  ]);
  checks.push({
    name: '클라우드 연결키',
    status: apiKey?.trim() ? 'pass' : 'fail',
    message: apiKey?.trim() ? '저장됨' : '없음. 코린이모드 설정에서 클라우드 연결키를 넣어주세요.',
  });
  checks.push({
    name: '클라우드 주소',
    status: 'pass',
    message: (baseUrl || '').trim() || ATLASCLOUD_DEFAULT_BASE_URL,
  });
  checks.push({
    name: '클라우드 작업 엔진',
    status: (model || '').trim() ? 'pass' : 'warn',
    message: (model || '').trim() || `${ATLASCLOUD_DEFAULT_MODEL} (default)`,
  });

  try {
    const out = await invoke<string>('git_status_full', { repoDir: workDir });
    const branch = String(out || '')
      .split('\n')
      .find(line => line.startsWith('# branch.head '))
      ?.replace(/^# branch\.head\s+/, '')
      .trim();
    checks.push({
      name: 'Git 작업 상태',
      status: branch ? 'pass' : 'warn',
      message: branch || 'Git 저장소가 아니거나 branch 정보를 찾지 못했습니다.',
    });
  } catch (error) {
    checks.push({ name: 'Git 작업 상태', status: 'warn', message: String(error) });
  }

  try {
    const stateDir = `${workDir.replace(/\/+$/, '')}/.bbarit/coding-secretary/state`;
    await invoke('create_directory', { path: stateDir });
    checks.push({
      name: '코린이모드 저장 공간',
      status: 'pass',
      message: stateDir,
    });
  } catch (error) {
    checks.push({ name: '코린이모드 저장 공간', status: 'fail', message: String(error) });
  }

  return checks;
}

export function formatHarnessDoctorReport(checks: HarnessDoctorCheck[]): string {
  const pass = checks.filter(check => check.status === 'pass').length;
  const warn = checks.filter(check => check.status === 'warn').length;
  const fail = checks.filter(check => check.status === 'fail').length;
  return [
    '## 코린이모드 상태 점검',
    '',
    ...checks.map(check => `${statusIcon(check.status)} **${check.name}**: ${check.message}`),
    '',
    `결과: ${pass} 통과, ${warn} 경고, ${fail} 실패`,
  ].join('\n');
}
