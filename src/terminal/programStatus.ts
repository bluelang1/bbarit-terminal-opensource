// Program Status Protocol (OSC 7501) — Claude Code 2.1.295+ 가 상태를 이스케이프
// 시퀀스로 알려 준다. xterm 의 registerOscHandler(7501) 는 "7501;" 뒤 페이로드만
// 넘기므로 여기서는 그 문자열만 다룬다. 설계: docs/AGENT_STATUS_OSC7501.md

export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'clear';
export type BlockedKind = 'permission' | 'question' | 'auth';
export type AgentTabState = 'working' | 'blocked' | 'done' | 'idle';

export interface ProgramStatusReport {
  state: ProgramState;
  id?: string;
  kind?: BlockedKind;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}

export interface ProgramStatusQuery { query: true }

export const PROGRAM_STATUS_QUERY_REPLY =
  '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth';

/** 질의 응답 전체. xterm 은 질의의 종결자를 알려 주지 않으므로 기본은 ESC \ 다. */
export function programStatusQueryReply(terminator: '\x1b\\' | '\x07' = '\x1b\\'): string {
  return PROGRAM_STATUS_QUERY_REPLY + terminator;
}

const MAX_SEQUENCE_BYTES = 4096;
const MAX_ID_BYTES = 128;
const MAX_ID_DEPTH = 8;
const MAX_TITLE_BYTES = 192;
const MAX_MSG_BYTES = 2048;
export const MAX_PROGRAM_STATUS_RECORDS = 256;

const STATES: readonly ProgramState[] = ['idle', 'working', 'done', 'blocked', 'error', 'clear'];
const KINDS: readonly BlockedKind[] = ['permission', 'question', 'auth'];
const SEG_RE = /^[A-Za-z0-9_.+-]{1,32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** "?" 또는 "?:<옵션>" 이면 지원 질의다. */
export function isProgramStatusQuery(data: string): boolean {
  const t = data.trim();
  return t === '?' || t.startsWith('?:');
}

export function isValidProgramStatusId(id: string): boolean {
  if (!id || utf8Bytes(id) > MAX_ID_BYTES) return false;
  const segs = id.split('/');
  if (segs.length > MAX_ID_DEPTH) return false;
  return segs.every((s) => SEG_RE.test(s));
}

// C0, DEL, C1 제어문자는 거부한다(탭 표시·알림 본문에 그대로 들어가므로).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function decodeBase64Text(value: string, maxBytes: number): string | null {
  if (!value || value.length % 4 !== 0 || !BASE64_RE.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    if (bytes.length > maxBytes) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (CONTROL_RE.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * OSC 7501 페이로드를 해석한다. 질의면 { query: true }, 유효한 보고면 보고 객체,
 * 무시해야 하면 null. 규칙: 쌍은 ':' 로 나누고 key=value, 양쪽 공백 제거, 잘못된 쌍은
 * 건너뛰고 모르는 키는 무시, 중복 키는 마지막 값. state 는 필수.
 */
export function parseProgramStatus(data: string): ProgramStatusReport | ProgramStatusQuery | null {
  if (typeof data !== 'string') return null;
  if (utf8Bytes(data) > MAX_SEQUENCE_BYTES) return null;
  if (isProgramStatusQuery(data)) return { query: true };

  const raw = new Map<string, string>();
  for (const pair of data.split(':')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!key) continue;
    raw.set(key, value); // 마지막 값이 이긴다
  }

  const state = raw.get('state') as ProgramState | undefined;
  if (!state || !STATES.includes(state)) return null;
  const report: ProgramStatusReport = { state };

  const id = raw.get('id');
  if (id !== undefined) {
    // 잘못된 id 를 건너뛰면 자식 보고가 루트를 덮어쓴다 — 보고 전체를 버린다.
    if (!isValidProgramStatusId(id)) return null;
    report.id = id;
  }

  const kind = raw.get('kind') as BlockedKind | undefined;
  if (state === 'blocked' && kind && KINDS.includes(kind)) report.kind = kind;

  const progress = raw.get('progress');
  if ((state === 'working' || state === 'blocked') && progress !== undefined && /^\d{1,3}$/.test(progress)) {
    const n = Number(progress);
    if (n >= 0 && n <= 100) report.progress = n;
  }

  const app = raw.get('app');
  if (app !== undefined && SEG_RE.test(app)) report.app = app;

  const title = raw.get('title');
  if (title !== undefined) {
    const decoded = decodeBase64Text(title, MAX_TITLE_BYTES);
    if (decoded !== null) report.title = decoded;
  }
  const msg = raw.get('msg');
  if (msg !== undefined) {
    const decoded = decodeBase64Text(msg, MAX_MSG_BYTES);
    if (decoded !== null) report.msg = decoded;
  }

  return report;
}

// ── 레코드 저장소 ───────────────────────────────────────────────

export interface ProgramStatusRecord {
  state: Exclude<ProgramState, 'clear'>;
  kind?: BlockedKind;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}

export interface ProgramStatusStore {
  root: ProgramStatusRecord | null;
  children: Map<string, ProgramStatusRecord>;
  /** 롤업 상태가 working 에서 다른 상태로 바뀔 때마다 1 증가. */
  turn: number;
  /** 보고를 한 번이라도 받았는가(질의만으로는 true 가 되지 않는다). */
  reported: boolean;
  /** 마지막 롤업 상태(턴 계산용). */
  lastState: AgentTabState;
  /** 마지막 보고를 받은 시각(ms). 오래된 working/blocked 정리에 쓴다. */
  lastReportAt: number;
}

export function createProgramStatusStore(): ProgramStatusStore {
  return { root: null, children: new Map(), turn: 0, reported: false, lastState: 'idle', lastReportAt: 0 };
}

const toRecord = (r: ProgramStatusReport): ProgramStatusRecord => {
  const rec: ProgramStatusRecord = { state: r.state as ProgramStatusRecord['state'] };
  if (r.kind) rec.kind = r.kind;
  if (r.progress !== undefined) rec.progress = r.progress;
  if (r.app) rec.app = r.app;
  if (r.title !== undefined) rec.title = r.title;
  if (r.msg !== undefined) rec.msg = r.msg;
  return rec;
};

function updateTurn(store: ProgramStatusStore) {
  const next = rollupAgentState(store);
  if (store.lastState === 'working' && next !== 'working') store.turn += 1;
  store.lastState = next;
}

/** 보고를 저장소에 반영한다. 레코드 제한(256)을 넘는 새 id 는 버린다. */
export function applyProgramStatusReport(store: ProgramStatusStore, report: ProgramStatusReport): void {
  store.reported = true;
  if (report.state === 'clear') {
    if (!report.id) {
      store.root = null;
      store.children.clear();
    } else {
      const prefix = `${report.id}/`;
      for (const key of [...store.children.keys()]) {
        if (key === report.id || key.startsWith(prefix)) store.children.delete(key);
      }
    }
  } else if (!report.id) {
    store.root = toRecord(report);
  } else {
    const count = store.children.size + (store.root ? 1 : 0);
    if (store.children.has(report.id) || count < MAX_PROGRAM_STATUS_RECORDS) {
      store.children.set(report.id, toRecord(report));
    }
  }
  updateTurn(store);
}

/** 프로세스 종료 시: working/blocked 레코드는 버리고 done/error 는 남긴다. */
export function dropTransientProgramStatus(store: ProgramStatusStore): void {
  const transient = (r: ProgramStatusRecord) => r.state === 'working' || r.state === 'blocked';
  if (store.root && transient(store.root)) store.root = null;
  for (const [key, rec] of [...store.children]) {
    if (transient(rec)) store.children.delete(key);
  }
  updateTurn(store);
}

const TAB_PRIORITY: Record<AgentTabState, number> = { blocked: 3, working: 2, done: 1, idle: 0 };

const recordToTabState = (r: ProgramStatusRecord): AgentTabState => {
  if (r.state === 'error') return 'done'; // 끝났지만 확인이 필요한 상태 — done 과 같게 표시
  return r.state;
};

/**
 * 레코드 집합을 탭 상태 하나로 접는다. 루트가 있으면 루트를 따르고, 없을 때만
 * 자식 중 가장 급한 상태(blocked > working > done > idle)를 쓴다.
 */
export function rollupAgentState(store: Pick<ProgramStatusStore, 'root' | 'children'>): AgentTabState {
  if (store.root) return recordToTabState(store.root);
  let best: AgentTabState = 'idle';
  for (const rec of store.children.values()) {
    const s = recordToTabState(rec);
    if (TAB_PRIORITY[s] > TAB_PRIORITY[best]) best = s;
  }
  return best;
}

/** 롤업 상태를 대표하는 레코드(알림 본문의 kind/msg/app 용). */
export function rollupRecord(store: Pick<ProgramStatusStore, 'root' | 'children'>): ProgramStatusRecord | null {
  if (store.root) return store.root;
  const target = rollupAgentState(store);
  for (const rec of store.children.values()) {
    if (recordToTabState(rec) === target) return rec;
  }
  return null;
}

/** 프로젝트 행 집계 우선순위: blocked > done > working > idle. */
const PROJECT_PRIORITY: Record<AgentTabState, number> = { blocked: 3, done: 2, working: 1, idle: 0 };

export function aggregateProjectAgentState(states: Iterable<AgentTabState>): AgentTabState {
  let best: AgentTabState = 'idle';
  for (const s of states) if (PROJECT_PRIORITY[s] > PROJECT_PRIORITY[best]) best = s;
  return best;
}
