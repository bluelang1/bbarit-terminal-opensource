import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ClipboardList, Link2, Rocket, ShieldCheck, Square, WandSparkles } from 'lucide-react';
import { OctoX } from '../octoIcons';
import { aiChat, getAiTagProvider } from '../notes/ollamaTagging';
import { createLinearComment, createLinearIssue, getLinearSettings, getLinearSettingsForProject, isLinearConfigured } from '../integrations/linear';
import { getCachedScan } from '../analyzer/codebaseAnalyzer.ts';
import { scanToPrompt } from '../analyzer/ontologyPrompt.ts';
import { kvGet, kvSet } from '../hooks/useKV';
import './ScrumModal.css';

// DB persistence helpers (SurrealDB via Tauri)
async function dbSaveHistory(entry: { projectId: string; projectName: string; sprintGoal: string; mode: string; planJson?: string; runLog?: string }) {
  try {
    await invoke('db_scrum_save_history', {
      projectId: entry.projectId,
      projectName: entry.projectName,
      sprintGoal: entry.sprintGoal,
      mode: entry.mode,
      planJson: entry.planJson || null,
      runLog: entry.runLog || null,
    });
  } catch { /* DB not available yet, fallback to localStorage */ }
}

async function dbSaveState(projectId: string, stateJson: string) {
  try {
    await invoke('db_scrum_save_state', { projectId, stateJson });
  } catch { /* DB not available yet */ }
}

async function dbLoadState(projectId: string): Promise<string | null> {
  try {
    return await invoke<string | null>('db_scrum_load_state', { projectId });
  } catch {
    return null;
  }
}

type ScrumMode = 'new-project' | 'feature' | 'bugfix' | 'refactor';
type ScrumOwner = 'joint' | 'codex' | 'claude' | 'kimi' | 'ollama';
export type ScrumAgent = 'codex' | 'claude' | 'kimi' | 'ollama';
export type ScrumPhase = 'idle' | 'planning' | 'preflight' | 'kickoff' | 'task_loop' | 'final_review' | 'completed' | 'error';
export type ScrumTaskStatus = 'pending' | 'reviewing' | 'implementing' | 'done' | 'skipped';

type ScrumWorkType =
  | 'new-project'
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'doc-sync'
  | 'security'
  | 'architecture'
  | 'performance';

interface ProjectInfo {
  id: string;
  displayName: string;
  workDir: string;
  icon: string;
  linearTeamId?: string;
  linearProjectId?: string;
}

interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface ScrumTask {
  id: string;
  title: string;
  owner: ScrumOwner;
  objective: string;
  deliverable: string;
  reviewGate: string;
  status: ScrumTaskStatus;
  startedAt?: number;
  completedAt?: number;
}

export interface ScrumPlan {
  sprintGoal: string;
  doneCriteria: string;
  constraints: string;
  mode: ScrumMode;
  workTypes: ScrumWorkType[];
  compact: boolean;
  tasks: ScrumTask[];
  createdAt: number;
}

export interface ScrumRoleConfig {
  reviewer: ScrumAgent;
  implementer: ScrumAgent;
  ollamaModel?: string;
}

export interface ScrumLaunchPayload {
  projectId: string;
  projectName: string;
  workDir: string;
  plan: ScrumPlan;
  roles: ScrumRoleConfig;
}

export type FeedEntry = {
  type: 'info' | 'review' | 'implement' | 'success' | 'error' | 'warning';
  from: 'reviewer' | 'implementer' | 'system';
  taskId?: string;
  subject: string;
  body: string;
  timestamp: number;
};

export type ScrumLaunchReport = {
  type: FeedEntry['type'];
  from: FeedEntry['from'];
  taskId?: string;
  subject: string;
  body: string;
};
export type ScrumLaunchReporter = (report: ScrumLaunchReport) => void;
export type ScrumShouldAbort = () => boolean;

export interface ScrumRunController {
  report: ScrumLaunchReporter;
  shouldAbort: ScrumShouldAbort;
  setPhase: (phase: ScrumPhase, taskIndex?: number) => void;
  setTaskStatus: (taskId: string, status: ScrumTaskStatus) => void;
}

interface ScrumHistoryEntry {
  projectId: string;
  projectName: string;
  sprintGoal: string;
  mode: ScrumMode;
  createdAt: number;
}

interface ScrumModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: ProjectInfo[];
  activeProjectId: string | null;
  onLaunch: (payload: ScrumLaunchPayload, controller: ScrumRunController) => void | Promise<void>;
  onOpenFile?: (path: string) => void;
  onOpenProject?: () => void;
}

type ProjectScrumState = {
  mode: ScrumMode;
  selectedWorkTypes: ScrumWorkType[];
  roles: ScrumRoleConfig;
  ollamaModel: string;
  linearSyncEnabled: boolean;
  linearIssueId: string;
  linearIssueUrl: string;
  linearLastStatus: string | null;
  sprintGoal: string;
  doneCriteria: string;
  constraints: string;
  strictAiPlan: boolean;
  plan: ScrumPlan | null;
  phase: ScrumPhase;
  currentTaskIndex: number;
  feedEntries: FeedEntry[];
  launchError: string | null;
};

const HISTORY_KEY = 'octo-scrum-history-v1';
const PROJECT_STATE_KEY = 'octo-scrum-state-v1';
const MAX_HISTORY = 12;
const MAX_RUN_ENTRIES = 220;
const FEED_VISIBLE_LIMIT = 120;

const MODE_LABEL: Record<ScrumMode, string> = {
  'new-project': 'New project',
  feature: 'Feature',
  bugfix: 'Bug fix',
  refactor: 'Refactor',
};

const AGENT_LABEL: Record<ScrumAgent, string> = {
  codex: 'Codex',
  claude: 'Claude',
  kimi: 'Kimi',
  ollama: 'Ollama',
};

const WORK_TYPE_LABEL: Record<ScrumWorkType, string> = {
  'new-project': '새프로젝트',
  feature: '기능개발',
  bugfix: '버그수정',
  refactor: '리팩토링',
  'doc-sync': '문서작업',
  security: '보안검사',
  architecture: '구조점검',
  performance: '성능검사',
};

const DEFAULT_WORK_TYPES: ScrumWorkType[] = ['feature'];
const DEFAULT_ROLE_CONFIG: ScrumRoleConfig = {
  reviewer: 'codex',
  implementer: 'claude',
};
const MODE_FROM_WORKTYPE_PRIORITY: ScrumMode[] = ['bugfix', 'refactor', 'new-project', 'feature'];

const FEED_LABEL: Record<FeedEntry['from'], string> = {
  reviewer: 'REVIEWER',
  implementer: 'IMPLEMENTER',
  system: 'SYSTEM',
};

const PHASE_LABEL: Record<ScrumPhase, string> = {
  idle: 'Idle',
  planning: 'Planning',
  preflight: 'Preflight',
  kickoff: 'Kickoff',
  task_loop: 'Task loop',
  final_review: 'Final review',
  completed: 'Done',
  error: 'Error',
};

const TASK_STATUS_ICON: Record<ScrumTaskStatus, string> = {
  pending: '○',
  reviewing: '◎',
  implementing: '◉',
  done: '●',
  skipped: '◌',
};

function isPhaseGenerating(phase: ScrumPhase): boolean {
  return phase === 'planning';
}
function isPhaseRunning(phase: ScrumPhase): boolean {
  return phase === 'preflight' || phase === 'kickoff' || phase === 'task_loop' || phase === 'final_review';
}
function isPhaseActive(phase: ScrumPhase): boolean {
  return isPhaseGenerating(phase) || isPhaseRunning(phase);
}

const STAGE_FLOW = [
  { id: 'S1', title: 'Joint planning agreement', detail: 'Both start with the same goal/constraints/done criteria' },
  { id: 'S2', title: 'Review approval gate', detail: 'No implementation before reviewer approval' },
  { id: 'S3', title: 'Implementer design/build', detail: 'Small-unit implementation + rationale + tests' },
  { id: 'S4', title: 'Reviewer review', detail: 'No nitpicking, rationale-driven feedback' },
  { id: 'S5', title: 'Disagreement round', detail: 'Run a negotiation round when the implementer disagrees' },
  { id: 'S6', title: 'Doc/security/structure/perf check', detail: 'README/CHANGELOG + security + architecture + performance checks' },
  { id: 'S7', title: 'Resume original work after agreement', detail: 'Resume the original backlog step once the conclusion is set' },
] as const;

const DISAGREEMENT_PROTOCOL = [
  'Round 1: Reviewer/implementer each list up to 3 supporting points',
  'Round 2: Validate hypotheses with tests/experiments',
  'Decision: Adopt the stronger-evidence option and return to the original work',
] as const;

const QUICK_COMPACT_PATTERN = /(버그|에러|오류|exception|crash|fix|hotfix|리팩토링|refactor|cleanup)/i;

async function loadDefaultOllamaModel(): Promise<string> {
  try {
    return String(await kvGet('octo-ollama-model') || '').trim();
  } catch {
    return '';
  }
}

function shouldUseCompactPlan(mode: ScrumMode, goal: string): boolean {
  return mode === 'bugfix' || mode === 'refactor' || QUICK_COMPACT_PATTERN.test(goal);
}

async function loadHistory(): Promise<ScrumHistoryEntry[]> {
  try {
    const raw = await kvGet(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ScrumHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: ScrumHistoryEntry[]) {
  void kvSet(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)));
  // Also persist latest entry to SurrealDB
  if (entries.length > 0) {
    const latest = entries[0];
    dbSaveHistory({
      projectId: latest.projectId,
      projectName: latest.projectName,
      sprintGoal: latest.sprintGoal,
      mode: latest.mode,
    });
  }
}

function isMode(value: unknown): value is ScrumMode {
  return value === 'new-project' || value === 'feature' || value === 'bugfix' || value === 'refactor';
}

function isOwner(value: unknown): value is ScrumOwner {
  return value === 'joint' || value === 'codex' || value === 'claude' || value === 'kimi' || value === 'ollama';
}

function isAgent(value: unknown): value is ScrumAgent {
  return value === 'codex' || value === 'claude' || value === 'kimi' || value === 'ollama';
}

function isWorkType(value: unknown): value is ScrumWorkType {
  return value === 'new-project'
    || value === 'feature'
    || value === 'bugfix'
    || value === 'refactor'
    || value === 'doc-sync'
    || value === 'security'
    || value === 'architecture'
    || value === 'performance';
}

function deriveModeFromWorkTypes(selectedWorkTypes: ScrumWorkType[], fallback: ScrumMode): ScrumMode {
  for (const mode of MODE_FROM_WORKTYPE_PRIORITY) {
    if (selectedWorkTypes.includes(mode)) return mode;
  }
  return fallback;
}

function normalizeWorkTypeList(value: unknown, fallback: ScrumWorkType[] = DEFAULT_WORK_TYPES): ScrumWorkType[] {
  const source = Array.isArray(value) ? value.filter(isWorkType) : [];
  if (source.length > 0) return [source[0]];
  return [...fallback];
}

function normalizeRoleConfig(value: unknown, fallback: ScrumRoleConfig = DEFAULT_ROLE_CONFIG): ScrumRoleConfig {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const reviewer = isAgent(raw?.reviewer) ? raw.reviewer : fallback.reviewer;
  const implementer = isAgent(raw?.implementer) ? raw.implementer : fallback.implementer;
  const ollamaModel = typeof raw?.ollamaModel === 'string' ? raw.ollamaModel.trim() : '';
  return { reviewer, implementer, ollamaModel };
}

function getOwnerLabel(owner: ScrumOwner, roles: ScrumRoleConfig): string {
  if (owner === 'joint') return `${AGENT_LABEL[roles.reviewer]} + ${AGENT_LABEL[roles.implementer]} joint`;
  if (owner === 'codex') return `${AGENT_LABEL[roles.reviewer]} review/approve`;
  if (owner === 'claude') return `${AGENT_LABEL[roles.implementer]} design/implement`;
  if (owner === 'ollama') return `${AGENT_LABEL.ollama} support`;
  return `${AGENT_LABEL.kimi} support`;
}

function makeDefaultProjectState(): ProjectScrumState {
  return {
    mode: 'feature',
    selectedWorkTypes: [...DEFAULT_WORK_TYPES],
    roles: { ...DEFAULT_ROLE_CONFIG },
    ollamaModel: '',
    linearSyncEnabled: true,
    linearIssueId: '',
    linearIssueUrl: '',
    linearLastStatus: null,
    sprintGoal: '',
    doneCriteria: '',
    constraints: '',
    strictAiPlan: false,
    plan: null,
    phase: 'idle',
    currentTaskIndex: -1,
    feedEntries: [],
    launchError: null,
  };
}

function isValidFeedType(v: unknown): v is FeedEntry['type'] {
  return v === 'info' || v === 'review' || v === 'implement' || v === 'success' || v === 'error' || v === 'warning';
}
function isValidFeedFrom(v: unknown): v is FeedEntry['from'] {
  return v === 'reviewer' || v === 'implementer' || v === 'system';
}
function isValidTaskStatus(v: unknown): v is ScrumTaskStatus {
  return v === 'pending' || v === 'reviewing' || v === 'implementing' || v === 'done' || v === 'skipped';
}

function sanitizeProjectState(input: unknown): ProjectScrumState {
  const base = makeDefaultProjectState();
  if (!input || typeof input !== 'object') return base;
  const raw = input as Record<string, unknown>;

  // Migrate old runEntries → feedEntries, or parse new feedEntries
  let feedEntries: FeedEntry[] = [];
  const feedSource = Array.isArray(raw.feedEntries) ? raw.feedEntries : Array.isArray(raw.runEntries) ? raw.runEntries : [];
  feedEntries = feedSource
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      // New FeedEntry format
      if (isValidFeedType(row.type) && isValidFeedFrom(row.from)) {
        return {
          type: row.type,
          from: row.from,
          taskId: typeof row.taskId === 'string' ? row.taskId : undefined,
          subject: typeof row.subject === 'string' ? row.subject : '',
          body: typeof row.body === 'string' ? row.body : '',
          timestamp: typeof row.timestamp === 'number' ? row.timestamp : Date.now(),
        } as FeedEntry;
      }
      // Legacy RunEntry migration
      const msg = typeof row.msg === 'string' ? row.msg : '';
      const at = typeof row.at === 'number' ? row.at : Date.now();
      if (!msg) return null;
      const legacyType = row.type;
      const mappedType: FeedEntry['type'] =
        legacyType === 'success' ? 'success' :
        legacyType === 'error' ? 'error' :
        legacyType === 'stopped' ? 'warning' : 'info';
      return { type: mappedType, from: 'system' as const, subject: msg.slice(0, 60), body: msg, timestamp: at };
    })
    .filter((v): v is FeedEntry => !!v)
    .slice(-MAX_RUN_ENTRIES);

  const planRaw = raw.plan && typeof raw.plan === 'object' ? raw.plan as Record<string, unknown> : null;
  const planTasksRaw = planRaw && Array.isArray(planRaw.tasks) ? planRaw.tasks : [];
  const planTasks: ScrumTask[] = planTasksRaw
    .map((task, idx) => {
      if (!task || typeof task !== 'object') return null;
      const row = task as Record<string, unknown>;
      return {
        id: toSafeLine(row.id, `T${idx + 1}`, 20),
        title: toSafeLine(row.title, `작업 ${idx + 1}`),
        owner: isOwner(row.owner) ? row.owner : toTaskOwner(undefined, idx),
        objective: toSafeLine(row.objective, '핵심 목표 달성'),
        deliverable: toSafeLine(row.deliverable, '코드 변경 + 점검 결과'),
        reviewGate: toSafeLine(row.reviewGate, '핵심 검증 통과'),
        status: isValidTaskStatus(row.status) ? row.status : 'pending',
        startedAt: typeof row.startedAt === 'number' ? row.startedAt : undefined,
        completedAt: typeof row.completedAt === 'number' ? row.completedAt : undefined,
      } as ScrumTask;
    })
    .filter((v): v is ScrumTask => !!v);
  const plan = planRaw && planTasks.length > 0 ? {
    sprintGoal: toSafeLine(planRaw.sprintGoal, ''),
    doneCriteria: toSafeLine(planRaw.doneCriteria, ''),
    constraints: toSafeLine(planRaw.constraints, ''),
    mode: isMode(planRaw.mode) ? planRaw.mode : base.mode,
    workTypes: normalizeWorkTypeList(planRaw.workTypes),
    compact: !!planRaw.compact,
    tasks: planTasks,
    createdAt: typeof planRaw.createdAt === 'number' ? planRaw.createdAt : Date.now(),
  } as ScrumPlan : null;

  return {
    mode: isMode(raw.mode) ? raw.mode : base.mode,
    selectedWorkTypes: normalizeWorkTypeList(raw.selectedWorkTypes),
    roles: normalizeRoleConfig(raw.roles),
    ollamaModel: typeof raw.ollamaModel === 'string' ? raw.ollamaModel.trim() : (typeof base.ollamaModel === 'string' ? base.ollamaModel : ''),
    linearSyncEnabled: typeof raw.linearSyncEnabled === 'boolean' ? raw.linearSyncEnabled : base.linearSyncEnabled,
    linearIssueId: typeof raw.linearIssueId === 'string' ? raw.linearIssueId.trim() : '',
    linearIssueUrl: typeof raw.linearIssueUrl === 'string' ? raw.linearIssueUrl.trim() : '',
    linearLastStatus: typeof raw.linearLastStatus === 'string' ? raw.linearLastStatus : null,
    sprintGoal: typeof raw.sprintGoal === 'string' ? raw.sprintGoal : base.sprintGoal,
    doneCriteria: typeof raw.doneCriteria === 'string' ? raw.doneCriteria : base.doneCriteria,
    constraints: typeof raw.constraints === 'string' ? raw.constraints : base.constraints,
    strictAiPlan: !!raw.strictAiPlan,
    plan,
    phase: 'idle',
    currentTaskIndex: -1,
    feedEntries,
    launchError: typeof raw.launchError === 'string' ? raw.launchError : null,
  };
}

async function loadProjectStateMap(): Promise<Record<string, ProjectScrumState>> {
  try {
    const raw = await kvGet(PROJECT_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    const next: Record<string, ProjectScrumState> = {};
    for (const [projectId, state] of Object.entries(parsed)) {
      next[projectId] = sanitizeProjectState(state);
    }
    return next;
  } catch {
    return {};
  }
}

function saveProjectStateMap(states: Record<string, ProjectScrumState>) {
  const serializable: Record<string, ProjectScrumState> = {};
  for (const [projectId, state] of Object.entries(states)) {
    serializable[projectId] = {
      ...state,
      phase: 'idle',
      currentTaskIndex: -1,
      feedEntries: state.feedEntries.slice(-MAX_RUN_ENTRIES),
    };
  }
  void kvSet(PROJECT_STATE_KEY, JSON.stringify(serializable));
  // Also persist each project state to SurrealDB
  for (const [projectId, state] of Object.entries(serializable)) {
    dbSaveState(projectId, JSON.stringify(state));
  }
}

function ensureProjectStateMap(
  projects: ProjectInfo[],
  prev: Record<string, ProjectScrumState>,
): Record<string, ProjectScrumState> {
  const next: Record<string, ProjectScrumState> = {};
  for (const project of projects) {
    next[project.id] = prev[project.id] || makeDefaultProjectState();
  }
  return next;
}

function buildScrumPlan(input: {
  goal: string;
  done: string;
  constraints: string;
  mode: ScrumMode;
  workTypes: ScrumWorkType[];
}): ScrumPlan {
  const sprintGoal = input.goal.trim();
  const compact = shouldUseCompactPlan(input.mode, sprintGoal);
  const pickedWorkTypes = normalizeWorkTypeList(input.workTypes);
  const doneCriteria = input.done.trim() || (compact
    ? '재현 케이스 통과 + 회귀 없음 + 변경 파일 최소화'
    : '핵심 기능 동작 + 테스트 통과 + 문서 업데이트');
  const constraints = input.constraints.trim();
  const taskPrefix = input.mode === 'new-project'
    ? '프로젝트 초기화'
    : input.mode === 'bugfix'
      ? '결함 수정'
      : input.mode === 'refactor'
        ? '구조 개선'
        : '기능 개발';

  if (compact) {
    const tasks: Omit<ScrumTask, 'status'>[] = [
      {
        id: 'B1',
        title: '증상 재현/영향 범위 확인',
        owner: 'joint',
        objective: '같은 재현 절차와 수정 범위를 한 줄로 합의합니다.',
        deliverable: 'docs/scrum/00-bugfix-brief.md',
        reviewGate: '재현 절차 확인 완료',
      },
      {
        id: 'B2',
        title: '최소 수정안 승인',
        owner: 'codex',
        objective: '수정 파일/접근 방식을 최소 범위로 고정합니다.',
        deliverable: '수정 파일 목록 + 한 줄 승인',
        reviewGate: '승인 전 구현 금지',
      },
      {
        id: 'B3',
        title: '빠른 수정 + 핵심 테스트',
        owner: 'claude',
        objective: '수정 반영 후 재현 케이스/관련 테스트만 빠르게 확인합니다.',
        deliverable: '코드 변경 + 테스트 결과',
        reviewGate: '재현 케이스 통과',
      },
      {
        id: 'B4',
        title: '최종 확인 + 문서/보안/구조/성능 점검',
        owner: 'codex',
        objective: '회귀 리스크와 보안/구조/성능 기본 항목을 짧게 점검하고 문서를 최신화합니다.',
        deliverable: 'docs/scrum/02-final-check.md + 선택한 작업종류 문서',
        reviewGate: '문제 해결 + 문서/보안/구조/성능 체크 완료 시 종료',
      },
    ];

    return {
      sprintGoal,
      doneCriteria,
      constraints,
      mode: input.mode,
      workTypes: pickedWorkTypes,
      compact,
      tasks: tasks.map(t => ({ ...t, status: 'pending' as ScrumTaskStatus })),
      createdAt: Date.now(),
    };
  }

  const tasks: Omit<ScrumTask, 'status'>[] = [
    {
      id: 'T0',
      title: '공동 킥오프 및 합의',
      owner: 'joint',
      objective: '리뷰 담당과 구현 담당이 목표/제약/완료 기준을 같은 문장으로 합의합니다.',
      deliverable: 'docs/scrum/00-kickoff.md (공동 합의 기록)',
      reviewGate: '양측 합의 완료 전 구현 금지',
    },
    {
      id: 'T1',
      title: `${taskPrefix} 스코프/우선순위 확정`,
      owner: 'codex',
      objective: '요구사항/범위/위험도를 분류하고 스프린트 목표를 고정합니다.',
      deliverable: 'docs/scrum/01-scope.md',
      reviewGate: '리뷰 담당 승인 전 구현 담당 시작 금지',
    },
    {
      id: 'T2',
      title: '기술 설계 및 구현 전략',
      owner: 'claude',
      objective: '영향 파일과 변경 전략, 테스트 전략을 설계합니다.',
      deliverable: 'docs/scrum/02-design.md + 파일 변경 계획',
      reviewGate: '리뷰 담당 설계 리뷰 통과',
    },
    {
      id: 'T3',
      title: '설계 승인 게이트',
      owner: 'codex',
      objective: '복잡도, 회귀 위험, 누락 테스트 항목을 점검하고 구현 허가 여부를 결정합니다.',
      deliverable: '리뷰 코멘트 + 승인/보류 결정',
      reviewGate: '승인 전에는 구현 커밋 금지',
    },
    {
      id: 'T4',
      title: '핵심 구현 (승인 범위 내)',
      owner: 'claude',
      objective: '리뷰 담당이 승인한 범위 내에서만 구현하고 변경 이유를 문서화합니다.',
      deliverable: '코드 변경 + 커밋 단위 진행 로그',
      reviewGate: '핵심 시나리오 동작 확인',
    },
    {
      id: 'T5',
      title: '이견 협의 라운드 (필요 시)',
      owner: 'joint',
      objective: '구현 담당이 반대 의견을 제시하면 리뷰 담당과 2라운드 합의 프로토콜을 수행합니다.',
      deliverable: 'docs/scrum/04-disagreement-rounds.md',
      reviewGate: '합의 결론 후 원 작업 단계로 복귀',
    },
    {
      id: 'T6',
      title: '중간 코드 리뷰 게이트',
      owner: 'codex',
      objective: '구현 결과를 리뷰하고 보완 요청/승인 결정을 내립니다.',
      deliverable: '중간 리뷰 리포트 + 보완 액션',
      reviewGate: '리뷰 담당 재승인 후 다음 작업 진행',
    },
    {
      id: 'T7',
      title: '보완 구현 + 테스트 + 문서 현행화',
      owner: 'claude',
      objective: '리뷰 코멘트를 반영하고 테스트와 문서(README/CHANGELOG/운영메모)를 최신화합니다.',
      deliverable: '테스트 결과 + README/CHANGELOG/운영문서 diff',
      reviewGate: 'DoD 체크리스트 충족',
    },
  ];

  if (pickedWorkTypes.includes('doc-sync')) {
    tasks.push({
      id: `T${tasks.length}`,
      title: '문서 현행화',
      owner: 'joint',
      objective: 'README/CHANGELOG/운영문서를 실제 변경사항 기준으로 최신화합니다.',
      deliverable: 'docs/scrum/06-doc-sync.md',
      reviewGate: '문서 체크리스트 완료',
    });
  }
  if (pickedWorkTypes.includes('security')) {
    tasks.push({
      id: `T${tasks.length}`,
      title: '보안 준비사항 체크',
      owner: 'joint',
      objective: '비밀정보 노출, 권한/입력 검증, 로그 민감정보 마스킹, 의존성 위험을 점검합니다.',
      deliverable: 'docs/scrum/07-security-readiness.md',
      reviewGate: '핵심 보안 체크리스트 통과',
    });
  }
  if (pickedWorkTypes.includes('architecture')) {
    tasks.push({
      id: `T${tasks.length}`,
      title: '시스템 구조 점검/정리',
      owner: 'joint',
      objective: '컴포넌트/모듈 경계, 의존성 방향, 확장성 관점의 구조 적합성을 점검합니다.',
      deliverable: 'docs/scrum/08-system-architecture.md',
      reviewGate: '구조 리스크/개선 포인트 기록 완료',
    });
  }
  if (pickedWorkTypes.includes('performance')) {
    tasks.push({
      id: `T${tasks.length}`,
      title: '성능 해결/검증',
      owner: 'joint',
      objective: '핵심 경로 성능 병목을 점검하고 개선 항목 또는 검증 결과를 기록합니다.',
      deliverable: 'docs/scrum/09-performance-readiness.md',
      reviewGate: '성능 기준/측정 결과 확인',
    });
  }
  tasks.push({
    id: `T${tasks.length}`,
    title: '최종 리뷰 및 릴리즈 결정',
    owner: 'codex',
    objective: '결과물 품질/회귀/배포 리스크를 최종 평가합니다.',
    deliverable: '최종 리뷰 리포트 + 배포/보류 결정',
    reviewGate: '승인 시 스프린트 완료',
  });

  return {
    sprintGoal,
    doneCriteria,
    constraints,
    mode: input.mode,
    workTypes: pickedWorkTypes,
    compact,
    tasks: tasks.map(t => ({ ...t, status: 'pending' as ScrumTaskStatus })),
    createdAt: Date.now(),
  };
}

function toSafeLine(value: unknown, fallback: string, max = 180): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  return text.replace(/\s+/g, ' ').slice(0, max);
}

function toTaskOwner(value: unknown, index: number): ScrumOwner {
  if (value === 'joint' || value === 'codex' || value === 'claude') return value;
  if (index % 3 === 0) return 'joint';
  if (index % 3 === 1) return 'codex';
  return 'claude';
}

async function buildScrumPlanWithAi(input: {
  goal: string;
  done: string;
  constraints: string;
  mode: ScrumMode;
  workTypes: ScrumWorkType[];
  scanPromptText?: string;
}): Promise<ScrumPlan> {
  const base = buildScrumPlan(input);
  const compactTaskHint = base.compact ? '3~4' : '7~9';
  const systemPrompt = [
    'You are an AI scrum planner for a coding project.',
    ...(input.scanPromptText ? [
      '',
      '=== CODEBASE FILES (pre-scanned file listing) ===',
      input.scanPromptText,
      '',
    ] : []),
    'Return only one JSON object with fields:',
    '{',
    '  "sprintGoal": string,',
    '  "doneCriteria": string,',
    '  "constraints": string,',
    '  "tasks": [',
    '    {',
    '      "id": string,',
    '      "title": string,',
    '      "owner": "joint" | "codex" | "claude",',
    '      "objective": string,',
    '      "deliverable": string,',
    '      "reviewGate": string',
    '    }',
    '  ]',
    '}',
    'Rules:',
    `- If compact mode, produce ${compactTaskHint} short tasks.`,
    '- Include checks only for selected work types.',
    '- For doc-sync: include README/CHANGELOG update work.',
    '- For security: include security-readiness checks (secret handling, input validation, permission scope, dependency risk).',
    '- For architecture: include system architecture review work.',
    '- For performance: include performance-readiness checks.',
    '- Keep each field concise and practical for real coding execution.',
    '- Do not include markdown, code block fences, or commentary.',
  ].join('\n');
  const userPrompt = [
    `Mode: ${input.mode}`,
    `Work types: ${input.workTypes.map((t) => WORK_TYPE_LABEL[t]).join(', ')}`,
    `Compact mode: ${base.compact ? 'yes' : 'no'}`,
    `Sprint goal: ${base.sprintGoal}`,
    `Done criteria: ${base.doneCriteria}`,
    `Constraints: ${base.constraints || 'none'}`,
    '',
    'Generate a high-quality scrum plan now.',
  ].join('\n');

  const raw = await aiChat(systemPrompt, userPrompt);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in the AI response.');
  const parsed = JSON.parse(jsonMatch[0]) as {
    sprintGoal?: unknown;
    doneCriteria?: unknown;
    constraints?: unknown;
    tasks?: Array<Record<string, unknown>>;
  };

  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const minTaskCount = base.compact ? 3 : 5;
  const maxTaskCount = base.compact ? 5 : 10;
  const trimmedTasks = rawTasks.slice(0, maxTaskCount);
  if (trimmedTasks.length < minTaskCount) {
    throw new Error(`Not enough AI tasks. (need at least ${minTaskCount})`);
  }

  const prefix = base.compact ? 'B' : 'T';
  const tasks: ScrumTask[] = trimmedTasks.map((task, idx) => ({
    id: `${prefix}${idx + 1}`,
    title: toSafeLine(task.title, `작업 ${idx + 1}`),
    owner: toTaskOwner(task.owner, idx),
    objective: toSafeLine(task.objective, '핵심 목표 달성'),
    deliverable: toSafeLine(task.deliverable, '코드 변경 + 점검 결과'),
    reviewGate: toSafeLine(task.reviewGate, '핵심 검증 통과'),
    status: 'pending' as ScrumTaskStatus,
  }));

  return {
    sprintGoal: toSafeLine(parsed.sprintGoal, base.sprintGoal),
    doneCriteria: toSafeLine(parsed.doneCriteria, base.doneCriteria),
    constraints: toSafeLine(parsed.constraints, base.constraints),
    mode: input.mode,
    workTypes: input.workTypes,
    compact: base.compact,
    tasks,
    createdAt: Date.now(),
  };
}

function buildLinearIssueDescription(project: ProjectInfo, plan: ScrumPlan, roles: ScrumRoleConfig): string {
  const lines: string[] = [
    '# OctoScrum Plan',
    '',
    `- Project: ${project.displayName}`,
    `- Workdir: ${project.workDir}`,
    `- Goal: ${plan.sprintGoal}`,
    `- Done: ${plan.doneCriteria}`,
    `- Constraints: ${plan.constraints || '-'}`,
    `- Mode: ${plan.mode}`,
    `- Work Types: ${plan.workTypes.join(', ') || '-'}`,
    `- Reviewer: ${AGENT_LABEL[roles.reviewer]}`,
    `- Implementer: ${AGENT_LABEL[roles.implementer]}`,
    ...(roles.ollamaModel ? [`- Ollama Model: ${roles.ollamaModel}`] : []),
    '',
    '## Tasks',
  ];
  for (const [idx, task] of plan.tasks.entries()) {
    lines.push(`${idx + 1}. ${task.title}`);
    lines.push(`- Owner: ${task.owner}`);
    lines.push(`- Objective: ${task.objective}`);
    lines.push(`- Deliverable: ${task.deliverable}`);
    lines.push(`- Review Gate: ${task.reviewGate}`);
  }
  return lines.join('\n');
}

function buildLinearRunComment(entries: FeedEntry[], status: 'success' | 'error' | 'stopped'): string {
  const icon = status === 'success' ? '✅' : status === 'stopped' ? '⏹️' : '❌';
  const title = status === 'success' ? 'Scrum run complete' : status === 'stopped' ? 'Scrum run stopped' : 'Scrum run failed';
  const recent = entries.slice(-40);
  const lines = [
    `## ${icon} ${title}`,
    '',
    '### Run log (latest 40)',
    ...recent.map((entry) => `- [${new Date(entry.timestamp).toISOString()}] [${entry.from}] [${entry.type}] ${entry.subject}: ${entry.body}`),
  ];
  return lines.join('\n');
}

export default function ScrumModal({
  isOpen,
  onClose,
  projects,
  activeProjectId,
  onLaunch,
  onOpenFile,
  onOpenProject,
}: ScrumModalProps) {
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectStates, setProjectStates] = useState<Record<string, ProjectScrumState>>({});
  const [, setHistory] = useState<ScrumHistoryEntry[]>([]);
  const [projectDocPaths, setProjectDocPaths] = useState<Record<string, string[]>>({});
  const [selectedDocPath, setSelectedDocPath] = useState<string | null>(null);
  const [selectedDocContent, setSelectedDocContent] = useState('');
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [showFullFeedByProject, setShowFullFeedByProject] = useState<Record<string, boolean>>({});

  const prevIsOpenRef = useRef(false);
  const launchAbortRef = useRef<Record<string, boolean>>({});
  const historyDocSignatureRef = useRef<Record<string, string>>({});
  const activityListRef = useRef<HTMLDivElement | null>(null);
  const feedAutoFollowRef = useRef(true);
  const lastRunEntryAtRef = useRef<Record<string, number>>({});

  const patchProjectState = useCallback((projectId: string, updater: (prev: ProjectScrumState) => ProjectScrumState) => {
    setProjectStates((prev) => {
      const current = prev[projectId] || makeDefaultProjectState();
      return { ...prev, [projectId]: updater(current) };
    });
  }, []);

  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      setClosing(false);
      loadHistory().then(h => setHistory(h)).catch(() => {});
      loadProjectStateMap().then(m => setProjectStates(ensureProjectStateMap(projects, m))).catch(() => {});
      setSelectedDocPath(null);
      setSelectedDocContent('');
      setDocError(null);

      if (activeProjectId && projects.some((p) => p.id === activeProjectId)) {
        setSelectedProjectId(activeProjectId);
      } else if (projects.length > 0) {
        setSelectedProjectId(projects[0].id);
      } else {
        setSelectedProjectId('');
      }
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, activeProjectId, projects]);

  // Try loading project states from SurrealDB (async supplement)
  useEffect(() => {
    if (!isOpen || projects.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const p of projects) {
        const json = await dbLoadState(p.id);
        if (cancelled || !json) continue;
        try {
          const state = sanitizeProjectState(JSON.parse(json));
          setProjectStates((prev) => ({ ...prev, [p.id]: { ...prev[p.id], ...state, phase: prev[p.id]?.phase ?? 'idle', currentTaskIndex: prev[p.id]?.currentTaskIndex ?? -1 } }));
        } catch { /* ignore malformed */ }
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, projects]);

  useEffect(() => {
    if (!isOpen) return;
    setProjectStates((prev) => ensureProjectStateMap(projects, prev));
    if (selectedProjectId && projects.some((p) => p.id === selectedProjectId)) return;
    if (activeProjectId && projects.some((p) => p.id === activeProjectId)) {
      setSelectedProjectId(activeProjectId);
      return;
    }
    setSelectedProjectId(projects[0]?.id || '');
  }, [isOpen, projects, selectedProjectId, activeProjectId]);

  useEffect(() => {
    if (!isOpen) return;
    saveProjectStateMap(projectStates);
  }, [isOpen, projectStates]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );
  const selectedState = selectedProject
    ? (projectStates[selectedProject.id] || makeDefaultProjectState())
    : makeDefaultProjectState();
  const selectedProjectDocPaths = selectedProject ? (projectDocPaths[selectedProject.id] || []) : [];

  const displayFeed = useMemo(() => selectedState.feedEntries, [selectedState.feedEntries]);
  const showFullFeed = selectedProject ? !!showFullFeedByProject[selectedProject.id] : false;
  const feedOverflowCount = Math.max(0, displayFeed.length - FEED_VISIBLE_LIMIT);
  const visibleFeedEntries = showFullFeed ? displayFeed : displayFeed.slice(-FEED_VISIBLE_LIMIT);
  const liveView = useMemo(() => {
    const latest = selectedState.feedEntries[selectedState.feedEntries.length - 1] || null;
    const phase = selectedState.phase;
    const status = selectedState.launchError && phase === 'error'
      ? 'error'
      : isPhaseGenerating(phase)
        ? 'generating'
        : isPhaseRunning(phase)
          ? 'running'
          : selectedState.plan
            ? phase === 'completed' ? 'completed' : 'ready'
            : 'idle';
    if (!selectedState.plan || selectedState.plan.tasks.length === 0) {
      return { status, phase, latest, activeIndex: -1, doneUntil: -1, activeTask: null as ScrumTask | null };
    }
    const tasks = selectedState.plan.tasks;
    const total = tasks.length;
    // Real progress: derive from task status
    let doneUntil = -1;
    let activeIndex = -1;
    for (let i = 0; i < total; i++) {
      if (tasks[i].status === 'done' || tasks[i].status === 'skipped') {
        doneUntil = i;
      } else if (tasks[i].status === 'reviewing' || tasks[i].status === 'implementing') {
        activeIndex = i;
        break;
      }
    }
    if (activeIndex === -1 && doneUntil < total - 1) {
      activeIndex = doneUntil + 1;
    }
    if (phase === 'completed') {
      doneUntil = total - 1;
      activeIndex = total - 1;
    }
    return {
      status,
      phase,
      latest,
      activeIndex,
      doneUntil,
      activeTask: activeIndex >= 0 ? tasks[activeIndex] || null : null,
    };
  }, [selectedState]);
  const anyActive = useMemo(
    () => Object.values(projectStates).some((state) => isPhaseActive(state.phase)),
    [projectStates],
  );
  const requiresOllamaModel = selectedState.roles.reviewer === 'ollama' || selectedState.roles.implementer === 'ollama';
  const [resolvedOllamaModel, setResolvedOllamaModel] = useState('llama3.1');
  useEffect(() => {
    const explicit = selectedState.ollamaModel.trim();
    if (explicit) { setResolvedOllamaModel(explicit); return; }
    loadDefaultOllamaModel().then(m => setResolvedOllamaModel(m || 'llama3.1')).catch(() => {});
  }, [selectedState.ollamaModel]);
  const [linearConfigured, setLinearConfigured] = useState(false);
  useEffect(() => {
    (async () => {
      const ls = selectedProject ? await getLinearSettingsForProject(selectedProject) : await getLinearSettings();
      setLinearConfigured(isLinearConfigured(ls));
    })();
  }, [selectedProject]);
  const scrumStats = useMemo(() => {
    const totalTasks = selectedState.plan?.tasks.length ?? 0;
    const completedTasks = totalTasks > 0
      ? selectedState.plan!.tasks.filter(t => t.status === 'done' || t.status === 'skipped').length
      : 0;
    const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    const byType: Record<FeedEntry['type'], number> = { info: 0, review: 0, implement: 0, success: 0, error: 0, warning: 0 };
    for (const row of selectedState.feedEntries) {
      byType[row.type] += 1;
    }
    const byFrom: Record<FeedEntry['from'], number> = { reviewer: 0, implementer: 0, system: 0 };
    for (const row of displayFeed) {
      byFrom[row.from] += 1;
    }
    const lastRunAt = selectedState.feedEntries.length > 0
      ? selectedState.feedEntries[selectedState.feedEntries.length - 1].timestamp
      : null;
    return {
      totalTasks,
      completedTasks,
      progressPercent,
      byType,
      byFrom,
      feedEntryCount: selectedState.feedEntries.length,
      docsCount: selectedProjectDocPaths.length,
      lastRunAt,
      hiddenLogs: feedOverflowCount,
    };
  }, [displayFeed, feedOverflowCount, selectedProjectDocPaths.length, selectedState.plan, selectedState.feedEntries]);

  const canAutoRun = selectedProject
    && selectedState.sprintGoal.trim().length >= 1
    && selectedState.roles.reviewer !== selectedState.roles.implementer
    && !isPhaseActive(selectedState.phase);

  const openExternalLink = useCallback(async (url: string) => {
    const safe = String(url || '').trim();
    if (!safe) return;
    try {
      await invoke('plugin:shell|open', { path: safe });
      return;
    } catch {
      // fallback to browser open in dev mode
    }
    try {
      window.open(safe, '_blank', 'noopener,noreferrer');
    } catch {
      // ignore open failure
    }
  }, []);

  const appendFeedEntry = useCallback((projectId: string, entry: FeedEntry) => {
    lastRunEntryAtRef.current[projectId] = entry.timestamp;
    patchProjectState(projectId, (prev) => ({
      ...prev,
      feedEntries: [...prev.feedEntries, entry].slice(-MAX_RUN_ENTRIES),
    }));
  }, [patchProjectState]);

  useEffect(() => {
    feedAutoFollowRef.current = true;
  }, [selectedProjectId]);

  const handleActivityScroll = useCallback(() => {
    const el = activityListRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    feedAutoFollowRef.current = distanceFromBottom < 36;
  }, []);

  useEffect(() => {
    const el = activityListRef.current;
    if (!el) return;
    const running = isPhaseRunning(selectedState.phase);
    if (running || feedAutoFollowRef.current) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: running ? 'auto' : 'smooth',
      });
    }
  }, [displayFeed.length, selectedState.phase, selectedProjectId]);

  const writeProjectHistoryDoc = useCallback(async (projectId: string, state: ProjectScrumState) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    if (state.feedEntries.length === 0) return;
    const docsDir = `${String(project.workDir || '').replace(/[\\/]+$/g, '')}/docs/scrum`;
    const historyPath = `${docsDir}/00-project-history-${projectId}.md`;
    const lines = [
      '# Scrum Project History',
      '',
      `- Project: ${project.displayName}`,
      `- Mode: ${MODE_LABEL[state.mode]}`,
      `- Roles: ${AGENT_LABEL[state.roles.reviewer]}(review) / ${AGENT_LABEL[state.roles.implementer]}(implement)`,
      ...(state.roles.reviewer === 'ollama' || state.roles.implementer === 'ollama'
        ? [`- Ollama model: ${state.ollamaModel || '(unset)'}`]
        : []),
      `- Last updated: ${new Date().toISOString()}`,
      '',
      '## Sprint Draft',
      `- Goal: ${state.sprintGoal || '-'}`,
      `- Done Criteria: ${state.doneCriteria || '-'}`,
      `- Constraints: ${state.constraints || '-'}`,
      '',
      '## Feed Entries',
      ...state.feedEntries.map((entry) => `- [${new Date(entry.timestamp).toISOString()}] [${entry.from}] [${entry.type}] ${entry.subject}: ${entry.body}`),
      '',
    ];
    try {
      await invoke('create_directory', { path: docsDir });
      await invoke('write_file', { path: historyPath, content: lines.join('\n') });
    } catch {
      // ignore history doc write failures to keep UI responsive
    }
  }, [projects]);

  const refreshProjectDocs = useCallback(async (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    const docsDir = `${String(project.workDir || '').replace(/[\\/]+$/g, '')}/docs/scrum`;
    const nextPaths: string[] = [];
    const projectHistoryPath = `${docsDir}/00-project-history-${projectId}.md`;
    nextPaths.push(projectHistoryPath);
    try {
      const rootItems = await invoke<FsEntry[]>('read_directory', { path: docsDir });
      const runDirs = rootItems.filter((item) => item.is_dir).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 12);
      const nested = await Promise.all(runDirs.map(async (dir) => {
        try {
          const files = await invoke<FsEntry[]>('read_directory', { path: dir.path });
          const historyFile = files.find((f) => !f.is_dir && f.name === '99-run-history.md');
          if (historyFile) return historyFile.path;
          const charterFile = files.find((f) => !f.is_dir && f.name === '00-team-charter.md');
          return charterFile?.path || null;
        } catch {
          return null;
        }
      }));
      for (const p of nested) {
        if (p) nextPaths.push(p);
      }
    } catch {
      // keep project history only when docs/scrum dir does not exist yet
    }
    setProjectDocPaths((prev) => ({ ...prev, [projectId]: nextPaths.slice(0, 14) }));
  }, [projects]);

  const loadDocPreview = useCallback(async (path: string) => {
    setDocLoading(true);
    setDocError(null);
    try {
      const content = await invoke<string>('read_file', { path });
      setSelectedDocPath(path);
      setSelectedDocContent(content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err || 'Failed to read document.');
      setDocError(msg);
      setSelectedDocPath(path);
      setSelectedDocContent('');
    } finally {
      setDocLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    for (const [projectId, state] of Object.entries(projectStates)) {
      if (!state.feedEntries.length) continue;
      const last = state.feedEntries[state.feedEntries.length - 1];
      const signature = `${state.feedEntries.length}:${last.timestamp}:${state.sprintGoal}:${state.mode}`;
      if (historyDocSignatureRef.current[projectId] === signature) continue;
      historyDocSignatureRef.current[projectId] = signature;
      void writeProjectHistoryDoc(projectId, state);
    }
  }, [isOpen, projectStates, writeProjectHistoryDoc]);

  useEffect(() => {
    if (!isOpen || !selectedProject) return;
    void refreshProjectDocs(selectedProject.id);
  }, [isOpen, selectedProject, refreshProjectDocs]);

  const handleClose = useCallback(() => {
    if (anyActive) {
      for (const [projectId, state] of Object.entries(projectStates)) {
        if (isPhaseRunning(state.phase)) launchAbortRef.current[projectId] = true;
      }
    }
    setClosing(true);
    window.setTimeout(onClose, 160);
  }, [anyActive, onClose, projectStates]);

  const handleStop = useCallback(() => {
    if (!selectedProject) return;
    const state = projectStates[selectedProject.id];
    if (!isPhaseRunning(state?.phase ?? 'idle')) return;
    launchAbortRef.current[selectedProject.id] = true;
    patchProjectState(selectedProject.id, (prev) => ({ ...prev, phase: 'idle' as ScrumPhase, currentTaskIndex: -1 }));
    appendFeedEntry(selectedProject.id, { type: 'warning', from: 'system', subject: 'Run stopped', body: 'Sent a stop signal at user request.', timestamp: Date.now() });
  }, [selectedProject, projectStates, appendFeedEntry, patchProjectState]);

  const handleAutoRun = useCallback(async () => {
    if (!canAutoRun || !selectedProject) return;
    const projectId = selectedProject.id;
    const state = projectStates[selectedProject.id] || makeDefaultProjectState();
    const feedLogBuffer: FeedEntry[] = [];
    const addFeed = (report: ScrumLaunchReport) => {
      const entry: FeedEntry = { ...report, timestamp: Date.now() };
      feedLogBuffer.push(entry);
      appendFeedEntry(projectId, entry);
    };
    const ollamaModel = state.ollamaModel.trim() || await loadDefaultOllamaModel() || 'llama3.1';
    const workTypes = state.selectedWorkTypes.length > 0 ? state.selectedWorkTypes : ['feature' as ScrumWorkType];
    const resolvedMode = deriveModeFromWorkTypes(workTypes, state.mode);
    const provider = await getAiTagProvider();

    // Phase: planning
    patchProjectState(projectId, (prev) => ({ ...prev, phase: 'planning' as ScrumPhase, launchError: null }));
    addFeed({ type: 'info', from: 'system', subject: 'Auto scrum start', body: 'Generate + run' });
    addFeed({ type: 'info', from: 'system', subject: 'AI scrum generation', body: `Using ${provider}` });

    // 캐시된 스캔 결과가 있으면 AI 플래너에 주입
    let scanText: string | undefined;
    try {
      const cachedScan = await getCachedScan(projectId);
      if (cachedScan) {
        scanText = scanToPrompt(cachedScan);
      }
    } catch { /* ignore */ }

    let next: ScrumPlan;
    let usedFallback = false;
    let linearIssueId = state.linearIssueId.trim();
    let linearIssueUrl = state.linearIssueUrl.trim();
    let finalStatus: 'success' | 'error' | 'stopped' = 'success';
    try {
      next = await buildScrumPlanWithAi({
        goal: state.sprintGoal,
        done: state.doneCriteria || '',
        constraints: state.constraints || '',
        mode: resolvedMode,
        workTypes: workTypes,
        scanPromptText: scanText,
      });
      addFeed({ type: 'success', from: 'system', subject: 'AI scrum generated', body: `${provider} - ${next.tasks.length} tasks` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err || 'AI generation failed');
      usedFallback = true;
      addFeed({ type: 'error', from: 'system', subject: 'AI generation failed', body: `Falling back to default template: ${msg}` });
      next = buildScrumPlan({
        goal: state.sprintGoal,
        done: state.doneCriteria || '',
        constraints: state.constraints || '',
        mode: resolvedMode,
        workTypes: workTypes,
      });
    }
    patchProjectState(projectId, (prev) => ({
      ...prev,
      phase: 'preflight' as ScrumPhase,
      plan: next,
      launchError: usedFallback ? 'AI generation failed, used the default template.' : null,
    }));

    const projectName = selectedProject.displayName || 'Unknown';
    const nextHistory: ScrumHistoryEntry[] = [
      { projectId: selectedProject.id, projectName, sprintGoal: next.sprintGoal, mode: resolvedMode, createdAt: Date.now() },
      ...(await loadHistory()).filter((h) => !(h.projectId === selectedProject.id && h.sprintGoal === next.sprintGoal)),
    ];
    saveHistory(nextHistory);
    setHistory(nextHistory.slice(0, MAX_HISTORY));
    addFeed({ type: 'info', from: 'system', subject: 'Generation done', body: 'Moving on to scrum run' });
    void refreshProjectDocs(projectId);

    // Phase: preflight - Linear integration
    if (state.linearSyncEnabled) {
      const linear = selectedProject ? await getLinearSettingsForProject(selectedProject) : await getLinearSettings();
      if (!isLinearConfigured(linear)) {
        addFeed({ type: 'info', from: 'system', subject: 'Linear not configured', body: 'Skipping issue creation' });
        patchProjectState(projectId, (prev) => ({ ...prev, linearLastStatus: 'Skipped due to missing Linear settings' }));
      } else {
        try {
          const issue = await createLinearIssue({
            apiToken: linear.apiToken,
            teamId: linear.teamId,
            projectId: linear.projectId || undefined,
            title: `[Scrum] ${selectedProject.displayName} - ${next.sprintGoal}`.slice(0, 180),
            description: buildLinearIssueDescription(selectedProject, next, { ...state.roles, ollamaModel: ollamaModel || undefined }),
          });
          linearIssueId = issue.id;
          linearIssueUrl = String(issue.url || '').trim();
          patchProjectState(projectId, (prev) => ({
            ...prev,
            linearIssueId: issue.id,
            linearIssueUrl: linearIssueUrl,
            linearLastStatus: `Linear issue created: ${issue.identifier}`,
          }));
          addFeed({ type: 'success', from: 'system', subject: 'Linear issue created', body: `${issue.identifier}${linearIssueUrl ? ` (${linearIssueUrl})` : ''}` });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err || 'Linear issue creation failed');
          patchProjectState(projectId, (prev) => ({ ...prev, linearLastStatus: `Linear creation failed: ${msg}` }));
          addFeed({ type: 'error', from: 'system', subject: 'Linear integration failed', body: msg });
        }
      }
    }

    // Phase: kickoff → task_loop
    launchAbortRef.current[projectId] = false;
    patchProjectState(projectId, (prev) => ({
      ...prev,
      phase: 'kickoff' as ScrumPhase,
      currentTaskIndex: 0,
      launchError: null,
    }));
    addFeed({ type: 'info', from: 'system', subject: 'Scrum run started', body: `${AGENT_LABEL[state.roles.reviewer]}(review) + ${AGENT_LABEL[state.roles.implementer]}(implement)` });

    const launchStartedAt = Date.now();
    let heartbeatTimer: number | null = window.setInterval(() => {
      if (launchAbortRef.current[projectId]) return;
      const lastAt = lastRunEntryAtRef.current[projectId] || 0;
      if (Date.now() - lastAt < 3500) return;
      const elapsedSec = Math.max(1, Math.floor((Date.now() - launchStartedAt) / 1000));
      addFeed({ type: 'info', from: 'system', subject: 'Run in progress', body: `${elapsedSec}s elapsed` });
    }, 4000);

    // Build controller for ScrumPage
    const controller: ScrumRunController = {
      report: (report) => addFeed(report),
      shouldAbort: () => !!launchAbortRef.current[projectId],
      setPhase: (phase, taskIndex) => {
        patchProjectState(projectId, (prev) => ({
          ...prev,
          phase,
          ...(taskIndex !== undefined ? { currentTaskIndex: taskIndex } : {}),
        }));
      },
      setTaskStatus: (taskId, status) => {
        patchProjectState(projectId, (prev) => {
          if (!prev.plan) return prev;
          const tasks = prev.plan.tasks.map(t =>
            t.id === taskId ? { ...t, status, ...(status === 'reviewing' || status === 'implementing' ? { startedAt: t.startedAt || Date.now() } : {}), ...(status === 'done' || status === 'skipped' ? { completedAt: Date.now() } : {}) } : t
          );
          return { ...prev, plan: { ...prev.plan, tasks } };
        });
      },
    };

    try {
      await onLaunch({
        projectId,
        projectName: selectedProject.displayName,
        workDir: selectedProject.workDir,
        plan: next,
        roles: { ...state.roles, ollamaModel: ollamaModel || undefined },
      }, controller);
      if (launchAbortRef.current[projectId]) {
        finalStatus = 'stopped';
        addFeed({ type: 'warning', from: 'system', subject: 'Run stopped', body: 'Run was stopped and terminated.' });
        patchProjectState(projectId, (prev) => ({ ...prev, phase: 'idle' as ScrumPhase }));
        return;
      }
      finalStatus = 'success';
      patchProjectState(projectId, (prev) => ({ ...prev, phase: 'completed' as ScrumPhase }));
      addFeed({
        type: 'success', from: 'system', subject: 'Run complete',
        body: `${AGENT_LABEL[state.roles.reviewer]}(review) + ${AGENT_LABEL[state.roles.implementer]}(implement) team work completed.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err || 'Unknown error');
      if (launchAbortRef.current[projectId]) {
        finalStatus = 'stopped';
        addFeed({ type: 'warning', from: 'system', subject: 'Stopped', body: 'Terminated during stop handling.' });
        patchProjectState(projectId, (prev) => ({ ...prev, phase: 'idle' as ScrumPhase }));
      } else {
        finalStatus = 'error';
        patchProjectState(projectId, (prev) => ({ ...prev, phase: 'error' as ScrumPhase, launchError: msg }));
        addFeed({ type: 'error', from: 'system', subject: 'Run error', body: msg });
      }
    } finally {
      if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (state.linearSyncEnabled && linearIssueId) {
        const linear = selectedProject ? await getLinearSettingsForProject(selectedProject) : await getLinearSettings();
        if (linear.apiToken) {
          try {
            await createLinearComment({
              apiToken: linear.apiToken,
              issueId: linearIssueId,
              body: buildLinearRunComment(feedLogBuffer, finalStatus),
            });
            patchProjectState(projectId, (prev) => ({ ...prev, linearLastStatus: 'Linear run-log comment synced' }));
            addFeed({ type: 'success', from: 'system', subject: 'Linear comment sync', body: 'Done' });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err || 'Linear comment sync failed');
            patchProjectState(projectId, (prev) => ({ ...prev, linearLastStatus: `Linear comment failed: ${msg}` }));
            addFeed({ type: 'error', from: 'system', subject: 'Linear comment sync failed', body: msg });
          }
        }
      }
      // If not already set to completed/idle/error by above, reset to idle
      patchProjectState(projectId, (prev) => {
        if (prev.phase === 'completed' || prev.phase === 'idle' || prev.phase === 'error') return prev;
        return { ...prev, phase: 'idle' as ScrumPhase };
      });
      void refreshProjectDocs(projectId);
    }
  }, [canAutoRun, onLaunch, selectedProject, projectStates, patchProjectState, appendFeedEntry, refreshProjectDocs]);

  const getProjectStatus = (projectId: string): 'idle' | 'ready' | 'running' | 'generating' | 'completed' | 'error' => {
    const state = projectStates[projectId];
    if (!state) return 'idle';
    if (isPhaseGenerating(state.phase)) return 'generating';
    if (isPhaseRunning(state.phase)) return 'running';
    if (state.phase === 'completed') return 'completed';
    if (state.phase === 'error' || state.launchError) return 'error';
    if (state.plan) return 'ready';
    return 'idle';
  };

  if (!isOpen) return null;

  return (
    <div
      className={`scrum-overlay ${closing ? 'closing' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="scrum-modal">
        <div className="scrum-header">
          <span className="scrum-header-icon"><ClipboardList size={14} /></span>
          <span className="scrum-header-title">OctoScrum</span>
          <button className="scrum-header-close" onClick={handleClose} title="Close">
            <OctoX size={14} />
          </button>
        </div>

        <div className="scrum-content">
          <div className="scrum-left">
            <label className="scrum-label">Scrum per project (1 per project)</label>
            <div className="scrum-project-grid">
              {projects.map((p) => {
                const status = getProjectStatus(p.id);
                const state = projectStates[p.id];
                const summary = state?.plan?.sprintGoal || 'No scrum generated yet';
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`scrum-project-btn ${selectedProjectId === p.id ? 'active' : ''}`}
                    onClick={() => setSelectedProjectId(p.id)}
                  >
                    <span className="scrum-project-main">
                      <span>{p.icon}</span>
                      <span>{p.displayName}</span>
                    </span>
                    <span className={`scrum-project-status ${status}`}>
                      {status === 'idle' ? 'Idle' : status === 'ready' ? 'Ready' : status === 'running' ? 'Running' : status === 'generating' ? 'Generating' : status === 'completed' ? 'Done' : 'Error'}
                    </span>
                    <span className="scrum-project-summary">{summary}</span>
                  </button>
                );
              })}
            </div>

            <label className="scrum-label">Model per role (change before start)</label>
                <div className="scrum-role-block">
                  <div className="scrum-role-line">
                    <span className="scrum-role-title">Review/approve model</span>
                    <div className="scrum-role-row">
                      {(Object.keys(AGENT_LABEL) as ScrumAgent[]).map((agent) => (
                        <button
                          key={`reviewer-${agent}`}
                          type="button"
                          className={`scrum-mode-btn ${selectedState.roles.reviewer === agent ? 'active' : ''}`}
                          onClick={() => {
                            if (!selectedProject) return;
                            patchProjectState(selectedProject.id, (prev) => ({
                              ...prev,
                              roles: { ...prev.roles, reviewer: agent },
                            }));
                          }}
                          disabled={isPhaseActive(selectedState.phase) || !selectedProject}
                        >
                          {AGENT_LABEL[agent]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="scrum-role-line">
                    <span className="scrum-role-title">Design/implement model</span>
                    <div className="scrum-role-row">
                      {(Object.keys(AGENT_LABEL) as ScrumAgent[]).map((agent) => (
                        <button
                          key={`implementer-${agent}`}
                          type="button"
                          className={`scrum-mode-btn ${selectedState.roles.implementer === agent ? 'active' : ''}`}
                          onClick={() => {
                            if (!selectedProject) return;
                            patchProjectState(selectedProject.id, (prev) => ({
                              ...prev,
                              roles: { ...prev.roles, implementer: agent },
                            }));
                          }}
                          disabled={isPhaseActive(selectedState.phase) || !selectedProject}
                        >
                          {AGENT_LABEL[agent]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="scrum-worktype-help">
                  Current role models: {AGENT_LABEL[selectedState.roles.reviewer]}(review) / {AGENT_LABEL[selectedState.roles.implementer]}(implement)
                </div>
            <label className="scrum-label">Linear integration</label>
            <div className="scrum-linear-block">
              <label className="scrum-ai-strict">
                <input
                  type="checkbox"
                  checked={selectedState.linearSyncEnabled}
                  onChange={(e) => {
                    if (!selectedProject) return;
                    patchProjectState(selectedProject.id, (prev) => ({ ...prev, linearSyncEnabled: e.target.checked }));
                  }}
                  disabled={isPhaseActive(selectedState.phase) || !selectedProject}
                />
                <span>Auto-create Linear issue on scrum start + sync run-log comments</span>
              </label>
              <div className="scrum-worktype-help">
                Status: {linearConfigured ? 'Connected' : 'Not set (Settings → Agent → Linear)'}
              </div>
              {selectedState.linearLastStatus && (
                <div className="scrum-worktype-help">
                  Last sync: {selectedState.linearLastStatus}
                </div>
              )}
              {selectedState.linearIssueUrl && (
                <button
                  type="button"
                  className="scrum-linear-open"
                  onClick={() => { void openExternalLink(selectedState.linearIssueUrl); }}
                >
                  <Link2 size={12} />
                  Open Linear issue
                </button>
              )}
            </div>

            <label className="scrum-label">Prompt</label>
            <textarea
              className="scrum-textarea"
              rows={5}
              value={selectedState.sprintGoal}
              onChange={(e) => {
                if (!selectedProject) return;
                patchProjectState(selectedProject.id, (prev) => ({ ...prev, sprintGoal: e.target.value }));
              }}
              placeholder="Describe what you want to do&#10;&#10;e.g. Add a login feature&#10;e.g. Bug fix — crash on the home screen&#10;e.g. Refactor — split the App.tsx component"
              disabled={isPhaseActive(selectedState.phase) || !selectedProject}
            />

            <div className="scrum-actions">
              {isPhaseRunning(selectedState.phase) ? (
                <button className="scrum-stop-btn" onClick={handleStop}>
                  <Square size={13} />
                  Stop
                </button>
              ) : (
                <button className="scrum-launch-btn" onClick={() => { void handleAutoRun(); }} disabled={!canAutoRun}>
                  {isPhaseGenerating(selectedState.phase) ? <WandSparkles size={14} /> : <Rocket size={14} />}
                  {isPhaseGenerating(selectedState.phase) ? 'AI generating...' : 'Start'}
                </button>
              )}
            </div>
            {!selectedProject && (
              <div className="scrum-launch-error scrum-launch-recovery">
                <span>프로젝트가 없습니다. 먼저 프로젝트를 열어 주세요.</span>
                {onOpenProject && (
                  <button type="button" className="scrum-recovery-btn" onClick={onOpenProject}>
                    프로젝트 열기
                  </button>
                )}
              </div>
            )}
            {selectedProject && selectedState.roles.reviewer === selectedState.roles.implementer && (
              <div className="scrum-launch-error">Reviewer and implementer must be different.</div>
            )}
            {selectedState.launchError && (
              <div className="scrum-launch-error">Run error: {selectedState.launchError}</div>
            )}
          </div>

          <div className="scrum-right">
            <div className="scrum-stage-flow">
              <div className="scrum-stage-title">Detailed stages</div>
              <div className="scrum-stage-list">
                {STAGE_FLOW.map((stage) => (
                  <div key={stage.id} className="scrum-stage-item">
                    <span className="scrum-stage-id">{stage.id}</span>
                    <div className="scrum-stage-text">
                      <div className="scrum-stage-head">{stage.title}</div>
                      <div className="scrum-stage-detail">{stage.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="scrum-stats-board">
              <div className="scrum-stage-title">Stats summary</div>
              <div className="scrum-stats-grid">
                <div className="scrum-stat-card">
                  <span className="scrum-stat-label">Progress</span>
                  <strong className="scrum-stat-value">{scrumStats.progressPercent}%</strong>
                  <span className="scrum-stat-meta">{scrumStats.completedTasks}/{scrumStats.totalTasks || 0} tasks done</span>
                </div>
                <div className="scrum-stat-card">
                  <span className="scrum-stat-label">Feed log</span>
                  <strong className="scrum-stat-value">{scrumStats.feedEntryCount}</strong>
                  <span className="scrum-stat-meta">Latest: {scrumStats.lastRunAt ? new Date(scrumStats.lastRunAt).toLocaleTimeString('en-US', { hour12: false }) : '-'}</span>
                </div>
                <div className="scrum-stat-card">
                  <span className="scrum-stat-label">Success events</span>
                  <strong className="scrum-stat-value success">{scrumStats.byType.success}</strong>
                  <span className="scrum-stat-meta">Info: {scrumStats.byType.info} / Review: {scrumStats.byType.review}</span>
                </div>
                <div className="scrum-stat-card">
                  <span className="scrum-stat-label">Error events</span>
                  <strong className="scrum-stat-value error">{scrumStats.byType.error}</strong>
                  <span className="scrum-stat-meta">Warnings: {scrumStats.byType.warning}</span>
                </div>
                <div className="scrum-stat-card">
                  <span className="scrum-stat-label">Docs</span>
                  <strong className="scrum-stat-value">{scrumStats.docsCount}</strong>
                  <span className="scrum-stat-meta">docs/scrum linked docs</span>
                </div>
                <div className="scrum-stat-card">
                  <span className="scrum-stat-label">Hidden logs</span>
                  <strong className="scrum-stat-value">{scrumStats.hiddenLogs}</strong>
                  <span className="scrum-stat-meta">Based on feed-saver mode</span>
                </div>
              </div>
              <div className="scrum-stats-owner-row">
                <span className="scrum-stats-owner-title">Activity distribution</span>
                <span className="scrum-stats-owner-chip reviewer">REVIEWER {scrumStats.byFrom.reviewer}</span>
                <span className="scrum-stats-owner-chip implementer">IMPLEMENTER {scrumStats.byFrom.implementer}</span>
                <span className="scrum-stats-owner-chip system">SYSTEM {scrumStats.byFrom.system}</span>
              </div>
            </div>

            <div className="scrum-live-board">
              <div className="scrum-live-head">
                <span className="scrum-stage-title">Live task board</span>
                <span className={`scrum-live-badge ${liveView.phase}`}>
                  {PHASE_LABEL[selectedState.phase]}
                </span>
                <span className={`scrum-live-badge ${liveView.status}`}>
                  {liveView.status === 'idle' ? 'Idle' :
                    liveView.status === 'ready' ? 'Ready' :
                    liveView.status === 'generating' ? 'Generating' :
                    liveView.status === 'running' ? 'Running' :
                    liveView.status === 'completed' ? 'Done' : 'Error'}
                </span>
              </div>
              <div className="scrum-live-message">
                {liveView.latest?.body || 'Not started yet. Generate and run a scrum to see live status here.'}
              </div>
              {selectedState.plan && (
                <>
                  <div className="scrum-live-track">
                    {selectedState.plan.tasks.map((task) => (
                      <div
                        key={task.id}
                        className={`scrum-live-node ${task.status === 'done' || task.status === 'skipped' ? 'done' : task.status === 'reviewing' || task.status === 'implementing' ? 'active' : 'todo'}`}
                      >
                        <span className="scrum-live-node-id">{TASK_STATUS_ICON[task.status]} {task.id}</span>
                        <span className="scrum-live-node-title">{task.title}</span>
                      </div>
                    ))}
                  </div>
                  {liveView.activeTask && (
                    <div className="scrum-live-current">
                      <div className="scrum-live-current-title">Current task</div>
                      <div className="scrum-live-current-body">
                        <strong>{liveView.activeTask.title}</strong>
                        <span>{getOwnerLabel(liveView.activeTask.owner, selectedState.roles)}</span>
                        <span>{liveView.activeTask.objective}</span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="scrum-activity">
              <div className="scrum-history-title">Activity log (live)</div>
              {displayFeed.length === 0 ? (
                <div className="scrum-history-empty">No progress logs yet.</div>
              ) : (
                <>
                  {feedOverflowCount > 0 && (
                    <div className="scrum-feed-cap">
                      {feedOverflowCount} older logs hidden
                      <button
                        type="button"
                        className="scrum-feed-cap-btn"
                        onClick={() => {
                          if (!selectedProject) return;
                          setShowFullFeedByProject((prev) => ({
                            ...prev,
                            [selectedProject.id]: !showFullFeed,
                          }));
                        }}
                      >
                        {showFullFeed ? 'Show latest only' : 'Show all logs'}
                      </button>
                    </div>
                  )}
                  <div className="scrum-activity-list" ref={activityListRef} onScroll={handleActivityScroll}>
                    {visibleFeedEntries.map((entry, idx) => (
                      <div key={`${entry.timestamp}-${idx}`} className={`scrum-activity-card ${entry.from} ${entry.type}`}>
                        <div className="scrum-activity-head">
                          <span className={`scrum-activity-owner ${entry.from}`}>{FEED_LABEL[entry.from]}</span>
                          <span className={`scrum-activity-type ${entry.type}`}>{entry.type}</span>
                          {entry.taskId && <span className="scrum-activity-task">{entry.taskId}</span>}
                          <span className="scrum-activity-time">
                            {new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false })}
                          </span>
                        </div>
                        <div className="scrum-activity-msg"><strong>{entry.subject}</strong> {entry.body !== entry.subject ? entry.body : ''}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="scrum-stage-flow">
              <div className="scrum-stage-title">Disagreement protocol</div>
              <div className="scrum-stage-list">
                {DISAGREEMENT_PROTOCOL.map((line, idx) => (
                  <div key={line} className="scrum-stage-item">
                    <span className="scrum-stage-id">R{idx + 1}</span>
                    <div className="scrum-stage-text">
                      <div className="scrum-stage-detail">{line}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {!selectedState.plan ? (
              <div className="scrum-empty">
                Enter a sprint goal, then press <strong>Auto start (generate + run)</strong> and
                the AI will build the scrum and run it right away.
              </div>
            ) : (
              <>
                <div className="scrum-plan-summary">
                  <div><strong>Project:</strong> {selectedProject?.displayName || '-'}</div>
                  <div><strong>Mode:</strong> {MODE_LABEL[selectedState.plan.mode]}</div>
                  <div><strong>Role models:</strong> {AGENT_LABEL[selectedState.roles.reviewer]}(review) / {AGENT_LABEL[selectedState.roles.implementer]}(implement)</div>
                  {requiresOllamaModel && <div><strong>Ollama model:</strong> {resolvedOllamaModel || '(not set)'}</div>}
                  <div><strong>Work types:</strong> {selectedState.plan.workTypes.map((w) => WORK_TYPE_LABEL[w]).join(', ')}</div>
                  <div><strong>Goal:</strong> {selectedState.plan.sprintGoal}</div>
                  <div><strong>Done criteria:</strong> {selectedState.plan.doneCriteria}</div>
                  {selectedState.linearIssueUrl && (
                    <div>
                      <strong>Linear:</strong>{' '}
                      <button type="button" className="scrum-linear-inline-link" onClick={() => { void openExternalLink(selectedState.linearIssueUrl); }}>
                        Open issue
                      </button>
                    </div>
                  )}
                  <div><strong>Docs path:</strong> docs/scrum/&lt;run-id&gt;/auto-generated docs for selected work types</div>
                  {selectedState.plan.compact && (
                    <div><strong>Plan type:</strong> Compact mode (quick fix/cleanup)</div>
                  )}
                </div>
                <div className="scrum-task-list">
                  {selectedState.plan.tasks.map((task, idx) => (
                    <div key={task.id} className="scrum-task-card">
                      <div className="scrum-task-head">
                        <span className="scrum-task-index">#{idx + 1}</span>
                        <span className={`scrum-owner ${task.owner}`}>{getOwnerLabel(task.owner, selectedState.roles)}</span>
                      </div>
                      <div className="scrum-task-title">{task.title}</div>
                      <div className="scrum-task-line"><ShieldCheck size={12} /> Objective: {task.objective}</div>
                      <div className="scrum-task-line">Deliverable: {task.deliverable}</div>
                      <div className="scrum-task-line">Review gate: {task.reviewGate}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="scrum-docs">
              <div className="scrum-history-title">History documents</div>
              {selectedProjectDocPaths.length === 0 ? (
                <div className="scrum-history-empty">No documents available yet.</div>
              ) : (
                <div className="scrum-doc-list">
                  {selectedProjectDocPaths.map((path) => (
                    <button
                      key={path}
                      type="button"
                      className={`scrum-doc-item ${selectedDocPath === path ? 'active' : ''}`}
                      onClick={() => { void loadDocPreview(path); }}
                    >
                      {path.split(/[\\/]/).slice(-2).join('/')}
                    </button>
                  ))}
                </div>
              )}
              <div className="scrum-doc-preview">
                {docLoading ? 'Loading document...' : docError ? `Document read error: ${docError}` : selectedDocContent || 'Select a document to view its contents here.'}
              </div>
              {selectedDocPath && onOpenFile && (
                <button
                  type="button"
                  className="scrum-doc-open-btn"
                  onClick={() => onOpenFile(selectedDocPath)}
                >
                  Open in editor
                </button>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
