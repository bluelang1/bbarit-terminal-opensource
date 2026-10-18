import { describe, it, expect } from 'vitest';
import { parseNaturalSchedule, computeNextRun, describeSchedule, normalizeLoadedSchedulerJobs } from './scheduler';

// 2026-07-08 (수) 10:00:00 로컬 기준
const NOW = new Date(2026, 6, 8, 10, 0, 0).getTime();

describe('parseNaturalSchedule', () => {
  it('parses 매일 9시에', () => {
    const r = parseNaturalSchedule('매일 9시에 npm run build', NOW)!;
    expect(r.schedule).toEqual({ kind: 'daily', hour: 9, minute: 0 });
    expect(r.command).toBe('npm run build');
  });

  it('parses 매일 오후 6시 30분', () => {
    const r = parseNaturalSchedule('매일 오후 6시 30분에 git push', NOW)!;
    expect(r.schedule).toEqual({ kind: 'daily', hour: 18, minute: 30 });
    expect(r.command).toBe('git push');
  });

  it('parses N분마다', () => {
    const r = parseNaturalSchedule('10분마다 git pull', NOW)!;
    expect(r.schedule).toEqual({ kind: 'interval', everyMs: 600_000 });
    expect(r.command).toBe('git pull');
  });

  it('parses every N minutes', () => {
    const r = parseNaturalSchedule('every 5 minutes npm test', NOW)!;
    expect(r.schedule).toEqual({ kind: 'interval', everyMs: 300_000 });
    expect(r.command).toBe('npm test');
  });

  it('parses 월요일마다 with time', () => {
    const r = parseNaturalSchedule('월요일마다 오전 9시에 npm run report', NOW)!;
    expect(r.schedule).toEqual({ kind: 'weekly', weekday: 1, hour: 9, minute: 0 });
    expect(r.command).toBe('npm run report');
  });

  it('parses N분 뒤에 (once, relative)', () => {
    const r = parseNaturalSchedule('30분 뒤에 npm run build', NOW)!;
    expect(r.schedule).toEqual({ kind: 'once', at: NOW + 30 * 60_000 });
    expect(r.command).toBe('npm run build');
  });

  it('parses 내일 14:30 (once, absolute)', () => {
    const r = parseNaturalSchedule('내일 14:30에 ./deploy.sh', NOW)!;
    const expected = new Date(2026, 6, 9, 14, 30, 0).getTime();
    expect(r.schedule).toEqual({ kind: 'once', at: expected });
    expect(r.command).toBe('./deploy.sh');
  });

  it('time-only in the past rolls to tomorrow', () => {
    const r = parseNaturalSchedule('9시에 npm run lint', NOW)!; // now is 10:00
    const expected = new Date(2026, 6, 9, 9, 0, 0).getTime();
    expect(r.schedule).toEqual({ kind: 'once', at: expected });
  });

  it('returns null without a time expression', () => {
    expect(parseNaturalSchedule('npm run build', NOW)).toBeNull();
  });
});

describe('computeNextRun', () => {
  it('daily rolls forward past times', () => {
    const next = computeNextRun({ kind: 'daily', hour: 9, minute: 0 }, NOW);
    expect(next).toBe(new Date(2026, 6, 9, 9, 0, 0).getTime());
  });
  it('weekly picks the next weekday', () => {
    const next = computeNextRun({ kind: 'weekly', weekday: 1, hour: 9, minute: 0 }, NOW);
    expect(new Date(next).getDay()).toBe(1);
    expect(next).toBeGreaterThan(NOW);
  });
  it('interval enforces a 10s floor', () => {
    expect(computeNextRun({ kind: 'interval', everyMs: 1000 }, NOW)).toBe(NOW + 10_000);
  });
});

describe('normalizeLoadedSchedulerJobs', () => {
  it('disables missed one-time jobs instead of running them on app start', () => {
    const jobs = normalizeLoadedSchedulerJobs([{
      id: 'past-once',
      command: 'npm run deploy',
      label: 'deploy',
      schedule: { kind: 'once', at: NOW - 60_000 },
      nextRun: NOW - 60_000,
      enabled: true,
      createdAt: new Date(NOW - 120_000).toISOString(),
    }], NOW);

    expect(jobs[0].enabled).toBe(false);
    expect(jobs[0].nextRun).toBe(NOW - 60_000);
  });

  it('rolls missed recurring jobs forward', () => {
    const jobs = normalizeLoadedSchedulerJobs([{
      id: 'daily',
      command: 'npm run build',
      label: 'build',
      schedule: { kind: 'daily', hour: 9, minute: 0 },
      nextRun: NOW - 60_000,
      enabled: true,
      createdAt: new Date(NOW - 120_000).toISOString(),
    }], NOW);

    expect(jobs[0].enabled).toBe(true);
    expect(jobs[0].nextRun).toBe(new Date(2026, 6, 9, 9, 0, 0).getTime());
  });
});

describe('describeSchedule', () => {
  it('formats interval hours', () => {
    expect(describeSchedule({ kind: 'interval', everyMs: 3_600_000 })).toBe('every 1h');
  });
  it('formats daily with zero padding', () => {
    expect(describeSchedule({ kind: 'daily', hour: 9, minute: 5 })).toBe('daily 09:05');
  });
});
