/**
 * 스케줄링 에이전트 코어 — 터미널 명령 예약 실행.
 * 자연어("매일 9시에 npm run build", "10분마다 git pull")를 스케줄로 파싱하고,
 * 다음 실행 시각을 계산한다. 저장은 칸반과 같은 KV 패턴.
 */

import { kvSet, kvGet } from '../hooks/useKV';

export type ScheduleSpec =
  | { kind: 'once'; at: number }                       // epoch ms
  | { kind: 'interval'; everyMs: number }              // 반복 간격
  | { kind: 'daily'; hour: number; minute: number }    // 매일 HH:MM
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }; // 0=일요일

export interface ScheduledJob {
  id: string;
  /** 터미널에 입력할 명령 */
  command: string;
  /** 사람이 읽는 설명 (자연어 원문 등) */
  label: string;
  schedule: ScheduleSpec;
  /** 다음 실행 예정 epoch ms */
  nextRun: number;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  /** 실행 대상 터미널 (없으면 실행 시점의 활성 터미널) */
  terminalId?: string;
}

const STORAGE_KEY = 'octo-scheduler-jobs-v1';

export async function loadSchedulerJobs(): Promise<ScheduledJob[]> {
  try {
    const raw = await kvGet(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ScheduledJob[];
    return Array.isArray(parsed) ? parsed.filter((j) => j && j.id && j.command) : [];
  } catch {
    return [];
  }
}

export async function saveSchedulerJobs(jobs: ScheduledJob[]): Promise<void> {
  try { await kvSet(STORAGE_KEY, JSON.stringify(jobs)); } catch { /* KV unavailable */ }
}

export function normalizeLoadedSchedulerJobs(jobs: ScheduledJob[], now: number = Date.now()): ScheduledJob[] {
  return jobs.map((job) => {
    if (!job.enabled || job.nextRun > now) return job;
    if (job.schedule.kind === 'once') return { ...job, enabled: false };
    return { ...job, nextRun: computeNextRun(job.schedule, now) };
  });
}

/** 스케줄의 다음 실행 시각(epoch ms)을 from 이후로 계산한다. */
export function computeNextRun(schedule: ScheduleSpec, from: number = Date.now()): number {
  switch (schedule.kind) {
    case 'once':
      return schedule.at;
    case 'interval':
      return from + Math.max(schedule.everyMs, 10_000);
    case 'daily': {
      const d = new Date(from);
      d.setHours(schedule.hour, schedule.minute, 0, 0);
      if (d.getTime() <= from) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    case 'weekly': {
      const d = new Date(from);
      d.setHours(schedule.hour, schedule.minute, 0, 0);
      let delta = (schedule.weekday - d.getDay() + 7) % 7;
      if (delta === 0 && d.getTime() <= from) delta = 7;
      d.setDate(d.getDate() + delta);
      return d.getTime();
    }
  }
}

export function describeSchedule(s: ScheduleSpec): string {
  const two = (n: number) => String(n).padStart(2, '0');
  switch (s.kind) {
    case 'once': return `once at ${new Date(s.at).toLocaleString()}`;
    case 'interval': {
      const m = Math.round(s.everyMs / 60_000);
      return m >= 60 && m % 60 === 0 ? `every ${m / 60}h` : `every ${m}m`;
    }
    case 'daily': return `daily ${two(s.hour)}:${two(s.minute)}`;
    case 'weekly': {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return `${days[s.weekday]} ${two(s.hour)}:${two(s.minute)}`;
    }
  }
}

export function createJob(command: string, schedule: ScheduleSpec, label?: string, terminalId?: string): ScheduledJob {
  return {
    id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    command: command.trim(),
    label: (label || command).trim(),
    schedule,
    nextRun: computeNextRun(schedule),
    enabled: true,
    createdAt: new Date().toISOString(),
    terminalId,
  };
}

// ── 자연어 파싱 ──────────────────────────────────────────────────────────
// "매일 9시에 npm run build" / "10분마다 git pull" / "내일 14:30에 ./deploy.sh"
// / "월요일 오전 9시에 npm test" / "오후 3시에 npm run lint" (오늘/내일 1회)
// / "every day at 9:00 npm run build" / "every 10 minutes git pull"

export interface ParsedSchedule {
  schedule: ScheduleSpec;
  /** 시간 표현을 제거하고 남은 명령 부분 */
  command: string;
}

const WEEKDAYS_KO: Record<string, number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const WEEKDAYS_EN: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** "9시", "9시 30분", "14:30", "오후 3시", "am 9", "9:30pm" → {hour, minute} */
function parseTimeToken(text: string): { hour: number; minute: number; matched: string } | null {
  // 오전/오후/am/pm + H시[ M분] | H:MM
  const re = /(오전|오후|am|pm)?\s*(\d{1,2})\s*(?::\s*(\d{1,2})|시\s*(?:(\d{1,2})\s*분)?)\s*(오전|오후|am|pm)?/i;
  const m = text.match(re);
  if (!m) return null;
  let hour = parseInt(m[2], 10);
  const minute = parseInt(m[3] ?? m[4] ?? '0', 10) || 0;
  const meridiem = (m[1] || m[5] || '').toLowerCase();
  if ((meridiem === '오후' || meridiem === 'pm') && hour < 12) hour += 12;
  if ((meridiem === '오전' || meridiem === 'am') && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, matched: m[0] };
}

function stripToken(text: string, token: string): string {
  return text.replace(token, ' ').replace(/\s+에\s+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 자연어 한 줄을 {schedule, command}로 파싱한다. 시간 표현을 찾지 못하면 null.
 * 명령 부분이 비어 있으면 command는 ''로 반환된다 (호출부에서 검증).
 */
export function parseNaturalSchedule(input: string, now: number = Date.now()): ParsedSchedule | null {
  const text = input.trim();
  if (!text) return null;

  // 1) 반복 간격: "N분마다", "N시간마다", "every N minutes/hours/seconds"
  {
    const ko = text.match(/(\d+)\s*(초|분|시간)\s*마다/);
    const en = text.match(/every\s+(\d+)\s*(sec(?:ond)?s?|min(?:ute)?s?|h(?:ou)?rs?)/i);
    if (ko || en) {
      const n = parseInt((ko ?? en)![1], 10);
      const unit = ko ? ko[2] : en![2].toLowerCase();
      const ms = unit.startsWith('초') || unit.startsWith('s') ? n * 1000
        : unit.startsWith('분') || unit.startsWith('m') ? n * 60_000
        : n * 3_600_000;
      return { schedule: { kind: 'interval', everyMs: ms }, command: stripToken(text, (ko ?? en)![0]) };
    }
  }

  // 2) 요일 반복: "월요일마다 9시에", "매주 금요일 14:00", "every monday at 9"
  {
    const ko = text.match(/(?:매주\s*)?([일월화수목금토])요일(?:마다)?/);
    const en = text.match(/every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)/i);
    if (ko || en) {
      const weekday = ko ? WEEKDAYS_KO[ko[1]] : WEEKDAYS_EN[en![1].toLowerCase()];
      let rest = stripToken(text, (ko ?? en)![0]).replace(/^매주\s*/, '');
      const t = parseTimeToken(rest);
      const hour = t?.hour ?? 9;
      const minute = t?.minute ?? 0;
      if (t) rest = stripToken(rest, t.matched);
      rest = rest.replace(/^(at|에)\s+/i, '');
      return { schedule: { kind: 'weekly', weekday, hour, minute }, command: rest };
    }
  }

  // 3) 매일 반복: "매일 9시에", "every day at 9:00", "daily 9:00"
  {
    const m = text.match(/매일|every\s*day|daily/i);
    if (m) {
      let rest = stripToken(text, m[0]);
      const t = parseTimeToken(rest);
      if (!t) return null;
      rest = stripToken(rest, t.matched).replace(/^(at|에)\s+/i, '');
      return { schedule: { kind: 'daily', hour: t.hour, minute: t.minute }, command: rest };
    }
  }

  // 4) 1회 — 상대: "N분 뒤에/후에", "in N minutes"
  {
    const ko = text.match(/(\d+)\s*(초|분|시간)\s*(?:뒤|후)(?:에)?/);
    const en = text.match(/in\s+(\d+)\s*(sec(?:ond)?s?|min(?:ute)?s?|h(?:ou)?rs?)/i);
    if (ko || en) {
      const n = parseInt((ko ?? en)![1], 10);
      const unit = ko ? ko[2] : en![2].toLowerCase();
      const ms = unit.startsWith('초') || unit.startsWith('s') ? n * 1000
        : unit.startsWith('분') || unit.startsWith('m') ? n * 60_000
        : n * 3_600_000;
      return { schedule: { kind: 'once', at: now + ms }, command: stripToken(text, (ko ?? en)![0]) };
    }
  }

  // 5) 1회 — 절대: "내일 14:30에", "오늘 오후 6시에", 시간만 있으면 오늘(지났으면 내일)
  {
    const tomorrow = /내일|tomorrow/i.test(text);
    const today = /오늘|today/i.test(text);
    const cleaned = text.replace(/내일|tomorrow|오늘|today/gi, ' ');
    const t = parseTimeToken(cleaned);
    if (t && (tomorrow || today || /시|:/.test(t.matched))) {
      const d = new Date(now);
      d.setHours(t.hour, t.minute, 0, 0);
      if (tomorrow) d.setDate(d.getDate() + 1);
      else if (!today && d.getTime() <= now) d.setDate(d.getDate() + 1);
      if (d.getTime() <= now && today) return null; // 오늘인데 이미 지난 시각
      let rest = stripToken(cleaned, t.matched).replace(/^(at|에)\s+/i, '');
      rest = rest.replace(/\s+(에|at)$/i, '').trim();
      return { schedule: { kind: 'once', at: d.getTime() }, command: rest };
    }
  }

  return null;
}
