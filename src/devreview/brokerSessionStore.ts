import { BROKER_AGENT_ROLES, type BrokerStatusSnapshot, type DevReviewRole } from './devReviewPair';
import { CYCLE_ORDER } from './brokerMechanic';

export interface BrokerSessionRecord {
  harnessId?: string;
  projectId?: string;
  developerId?: string;
  reviewerId?: string;
  developer?: DevReviewRole;
  reviewer?: DevReviewRole;
  branch?: string;
  worktreeDir?: string;
  repoDir?: string;
  name?: string;
  manualName?: boolean;
  lastPrompt?: string;
  createdAt?: number;
  lifecycle?: BrokerHarnessLifecycle;
  lastHeartbeatAt?: number;
  lastAttachedAt?: number;
  restoreFailureCount?: number;
  status?: BrokerStatusSnapshot;
  log?: { kind: string; message: string }[];
}

export type BrokerHarnessLifecycle =
  | 'active'
  | 'resume_pending'
  | 'reattaching'
  | 'blocked'
  | 'complete'
  | 'suspended';

const BROKER_HARNESS_LIFECYCLES: readonly BrokerHarnessLifecycle[] = [
  'active',
  'resume_pending',
  'reattaching',
  'blocked',
  'complete',
  'suspended',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function cleanRole(value: unknown): DevReviewRole | undefined {
  const trimmed = cleanString(value);
  return trimmed && (BROKER_AGENT_ROLES as readonly string[]).includes(trimmed)
    ? trimmed as DevReviewRole
    : undefined;
}

function cleanBrokerStatus(value: unknown): BrokerStatusSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const cycle = cleanString(value.cycle);
  if (!cycle || !CYCLE_ORDER.includes(cycle as BrokerStatusSnapshot['cycle'])) return undefined;
  const reason = typeof value.reason === 'string' ? value.reason : '';
  const status: BrokerStatusSnapshot = {
    cycle: cycle as BrokerStatusSnapshot['cycle'],
    cycleLabel: cleanString(value.cycleLabel) || cycle,
    reason,
  };
  if (typeof value.directionOk === 'boolean') status.directionOk = value.directionOk;
  if (typeof value.grownLoc === 'number' && Number.isFinite(value.grownLoc)) status.grownLoc = value.grownLoc;
  if (typeof value.action === 'string') status.action = value.action;
  return status;
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cleanNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function cleanLifecycle(value: unknown): BrokerHarnessLifecycle | undefined {
  const trimmed = cleanString(value);
  return trimmed && BROKER_HARNESS_LIFECYCLES.includes(trimmed as BrokerHarnessLifecycle)
    ? trimmed as BrokerHarnessLifecycle
    : undefined;
}

export function lifecycleFromBrokerStatus(
  status: BrokerStatusSnapshot | undefined,
  fallback: BrokerHarnessLifecycle = 'active',
): BrokerHarnessLifecycle {
  if (status?.cycle === 'merged') return 'complete';
  if (status?.cycle === 'merge_failed') return 'blocked';
  return fallback;
}

export function isRestorableBrokerLifecycle(_lifecycle: BrokerHarnessLifecycle | undefined): boolean {
  // Suspended records are still restorable as visible history. Explicit deletion,
  // missing branch/worktree metadata, orphaned projects, and obsolete readiness
  // blocks are the restore filters.
  return true;
}

function isObsoleteReadinessBlock(status: BrokerStatusSnapshot | undefined): boolean {
  if (status?.cycle !== 'merge_failed') return false;
  const text = `${status.reason || ''}\n${status.cycleLabel || ''}`;
  return /CLI readiness was not confirmed|Dev-agent CLI readiness|raw shell|개발 에이전트 CLI 준비가 확인되지 않았습니다|브리핑 투입을 중단/.test(text);
}

function cleanBrokerLog(value: unknown): { kind: string; message: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(isRecord)
    .map((entry) => ({
      kind: cleanString(entry.kind) || 'info',
      message: cleanString(entry.message) || '',
    }))
    .filter((entry) => entry.message)
    .slice(-200);
}

export function normalizeBrokerSessionRecords(value: unknown): BrokerSessionRecord[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, BrokerSessionRecord>();
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const harnessId = cleanString(raw.harnessId);
    if (!harnessId) continue;
    const status = cleanBrokerStatus(raw.status);
    const next: BrokerSessionRecord = {
      ...raw,
      harnessId,
      projectId: cleanString(raw.projectId),
      developerId: cleanString(raw.developerId),
      reviewerId: cleanString(raw.reviewerId),
      developer: cleanRole(raw.developer),
      reviewer: cleanRole(raw.reviewer),
      branch: cleanString(raw.branch),
      worktreeDir: cleanString(raw.worktreeDir),
      repoDir: cleanString(raw.repoDir),
      name: cleanString(raw.name),
      manualName: raw.manualName === true,
      lastPrompt: cleanString(raw.lastPrompt),
      createdAt: cleanNumber(raw.createdAt),
      lifecycle: cleanLifecycle(raw.lifecycle) || lifecycleFromBrokerStatus(status),
      lastHeartbeatAt: cleanNumber(raw.lastHeartbeatAt),
      lastAttachedAt: cleanNumber(raw.lastAttachedAt),
      restoreFailureCount: cleanNonNegativeInteger(raw.restoreFailureCount),
      status,
      log: cleanBrokerLog(raw.log),
    };
    const existing = byId.get(harnessId);
    if (!existing || (next.createdAt || 0) >= (existing.createdAt || 0)) {
      byId.set(harnessId, next);
    }
  }
  return [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export function selectRestorableBrokerSessions(
  value: unknown,
  deletedIds: Set<string>,
  hasProject: (projectId: string) => boolean,
): BrokerSessionRecord[] {
  return normalizeBrokerSessionRecords(value).filter((session) => (
    !!session.harnessId
    && !deletedIds.has(session.harnessId)
    && !!session.projectId
    && !!session.developerId
    && !!session.reviewerId
    && !!session.branch
    && !!session.worktreeDir
    && !isObsoleteReadinessBlock(session.status)
    && isRestorableBrokerLifecycle(session.lifecycle)
    && hasProject(session.projectId)
  ));
}

export function statusAfterDeveloperCommand(
  current: BrokerStatusSnapshot | undefined,
  lang: 'en' | 'ko',
): BrokerStatusSnapshot | undefined {
  if (current?.cycle !== 'merged') return current;
  return {
    cycle: 'developing',
    cycleLabel: lang === 'ko' ? '후속 작업' : 'Follow-up build',
    reason: lang === 'ko'
      ? '완료된 하네스에서 새 작업 입력을 감지했습니다.'
      : 'New work detected in a completed harness.',
    action: lang === 'ko' ? '후속 작업' : 'follow-up',
    directionOk: current.directionOk,
    grownLoc: current.grownLoc,
  };
}

export function deriveBrokerHarnessName(
  session: Pick<BrokerSessionRecord, 'manualName' | 'name' | 'lastPrompt'>,
  fallback: string,
): string {
  if (session.manualName && session.name) return session.name;
  const promptTitle = cleanString(session.lastPrompt)?.replace(/\s+/g, ' ').slice(0, 48);
  return promptTitle || session.name || fallback;
}

export function selectPreferredBrokerHarnessId(
  sessions: Pick<BrokerSessionRecord, 'harnessId' | 'createdAt'>[],
  lastSelectedHarnessId?: string | null,
): string | null {
  const selected = cleanString(lastSelectedHarnessId);
  if (selected && sessions.some((session) => session.harnessId === selected)) return selected;
  const newest = [...sessions]
    .filter((session) => !!session.harnessId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  return newest?.harnessId || null;
}
