// Broker Mechanic: deterministic, no-LLM routing for the dev-review harness.
//
// The broker judges only mechanical signals from the current git diff: size,
// source growth, code-graph impact, and sensitive patterns. The reviewer remains
// review-only and gives feedback through the broker review feed.

import { invoke } from '@tauri-apps/api/core';

async function sh(command: string, workDir: string, timeoutSecs = 25): Promise<string> {
  try {
    // login:false — these are git + `node .broker/code-graph.mjs` calls; both resolve on
    // PATH without a login shell. Skipping /etc/profile saves ~2.3s/call on Windows, which
    // matters because judge() fires a burst of them per review round.
    return (await invoke<string>('run_cli_oneshot', { command, workDir, timeoutSecs, login: false })) || '';
  } catch {
    return '';
  }
}

export interface SourceBaseline {
  sha: string;
  files: number;
  loc: number;
}

export interface BrokerMetrics {
  grownLoc: number;
  grownFiles: number;
  newFiles: number;
  changeIns: number;
  changeDel: number;
  changedSymbols: string[];
  riskHigh: number;
  riskMed: number;
  sensitive: string[];
  // Kept for backward-compatible status payloads. Requirement matrix management
  // is disabled, so these are always zero/empty.
  reqTotal: number;
  reqVerified: number;
  reqGaps: number;
  falseClaims: string[];
  driftSymbols: string[];
}

export type BrokerAction = 'skip' | 'batch' | 'review' | 'escalate';

export interface BrokerJudgement {
  action: BrokerAction;
  reason: string;
  directionOk: boolean;
  focus: string[];
  metrics: BrokerMetrics;
  statusMarkdown: string;
}

export async function snapshotSource(workDir: string): Promise<SourceBaseline> {
  const sha = (await sh('git rev-parse HEAD 2>/dev/null', workDir, 15)).trim();
  const files = parseInt((await sh('git ls-files 2>/dev/null | wc -l', workDir, 15)).trim(), 10) || 0;
  return { sha, files, loc: 0 };
}

function parseShortstat(s: string): { files: number; ins: number; del: number } {
  const files = parseInt((s.match(/(\d+) files? changed/) || [])[1] || '0', 10);
  const ins = parseInt((s.match(/(\d+) insertions?\(\+\)/) || [])[1] || '0', 10);
  const del = parseInt((s.match(/(\d+) deletions?\(-\)/) || [])[1] || '0', 10);
  return { files, ins, del };
}

const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(password|passwd|secret|api[_-]?key|token|credential|private[_-]?key)\b/i, 'secrets'],
  [/\b(auth|login|session|jwt|oauth|permission|rbac|authorize)\b/i, 'auth'],
  [/\b(exec|eval|child_process|spawn|system\(|os\.system|subprocess)\b/i, 'code-exec'],
  [/\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|rm\s+-rf|unlink|rmdir)\b/i, 'destructive'],
  [/\b(SELECT|INSERT|UPDATE|DELETE)\b.*(\+|\$\{|%s|f")/i, 'sql-injection-risk'],
  [/\b(payment|charge|refund|stripe|billing|price|amount)\b/i, 'payment'],
  [/(TODO|FIXME|XXX|HACK)\b/, 'unfinished-marker'],
  [/\b(console\.log|debugger|print\(|dbg!|fmt\.Println)\b/, 'debug-leftover'],
];

function scanSensitivity(diff: string): string[] {
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  const hits = new Set<string>();
  for (const [re, label] of SENSITIVE_PATTERNS) if (re.test(added)) hits.add(label);
  return [...hits];
}

async function readImpact(workDir: string): Promise<{ high: number; med: number; symbols: string[]; highSyms: string[] }> {
  const out = await sh('node .broker/code-graph.mjs impact 2>/dev/null || true', workDir, 45);
  const high = (out.match(/\[HIGH\]/g) || []).length;
  const med = (out.match(/\[medium\]/g) || []).length;
  const symbols = [...out.matchAll(/\[(?:HIGH|medium|low)\]\s+(\S+)/g)].map((m) => m[1]);
  const highSyms = [...out.matchAll(/\[HIGH\]\s+(\S+)/g)].map((m) => m[1]);
  return { high, med, symbols, highSyms };
}

const BATCH_LOC = 12;
const REVIEW_LOC = 80;

const STAGES = [
  'Onboard - read project/global wiki',
  'Build & review - develop, broker relays diffs, reviewer reviews',
  'Verify & close gaps - confirm code and tests',
  'Ready - reviewer approved; broker auto-commits/merges when clean',
];

function computeStage(m: BrokerMetrics): number {
  if (m.grownLoc === 0) return 0;
  if (m.riskHigh > 0 || m.sensitive.length > 0) return 2;
  return 1;
}

function stageTable(current: number): string {
  const rows = STAGES.map((s, i) => {
    const status = i < current ? 'done' : i === current ? 'CURRENT' : 'pending';
    return `| ${i} | ${s} | ${status} |`;
  });
  return ['| # | Stage | Status |', '| --- | --- | --- |', ...rows].join('\n');
}

export type CycleState =
  | 'developing'
  | 'dev_done'
  | 'reviewing'
  | 'review_done'
  | 'addressing'
  | 'approved'
  | 'merging'
  | 'merged'
  | 'merge_failed';

export const CYCLE_LABELS: Record<CycleState, string> = {
  developing: 'Developing',
  dev_done: 'Dev done',
  reviewing: 'Reviewing',
  review_done: 'Review done',
  addressing: 'Addressing',
  approved: 'Approved',
  merging: 'Auto merging',
  merged: 'Merged',
  merge_failed: 'Merge failed',
};

export const CYCLE_ORDER: CycleState[] = ['developing', 'dev_done', 'reviewing', 'review_done', 'addressing', 'approved', 'merging', 'merged', 'merge_failed'];

export function cycleTable(current: CycleState): string {
  const rows = CYCLE_ORDER.map((c, i) => `| ${i} | ${CYCLE_LABELS[c]} | ${c === current ? 'current' : ''} |`);
  return ['| # | Cycle stage | Current |', '| --- | --- | --- |', ...rows].join('\n');
}

export function buildStatus(goal: string, m: BrokerMetrics, j: { action: BrokerAction; reason: string; directionOk: boolean }, stamp: string): string {
  const stage = computeStage(m);
  const lines = [
    '# Broker Status (auto - mechanical)',
    `Updated: ${stamp}`,
    '',
    `Goal: ${goal || '(given live in the terminal)'}`,
    `**Current stage: [${stage}] ${STAGES[stage]}**`,
    '',
    '## Stages',
    stageTable(stage),
    '',
    '## Signals',
    `- Source growth (since start): +${m.grownLoc} net LOC - ${m.grownFiles} files - ${m.newFiles} new files`,
    `- This change: +${m.changeIns}/-${m.changeDel} - risk ${m.riskHigh} HIGH / ${m.riskMed} medium${m.sensitive.length ? ` - sensitive: ${m.sensitive.join(', ')}` : ''}`,
    `- Direction: ${j.directionOk ? 'on-track' : 'OFF-TRACK'} - ${j.reason}`,
    '',
    `## Broker decision: **${j.action.toUpperCase()}**`,
    j.reason,
  ];
  return lines.join('\n') + '\n';
}

export async function judge(
  workDir: string,
  ctx: { baseline: SourceBaseline; diff: string; goal: string; firstReview: boolean },
  stamp: string,
): Promise<BrokerJudgement> {
  const nonWs = (await sh('git diff -w HEAD 2>/dev/null || true', workDir, 20)).trim();
  const growthStat = ctx.baseline.sha
    ? parseShortstat(await sh(`git diff --shortstat ${ctx.baseline.sha} 2>/dev/null || true`, workDir, 25))
    : { files: 0, ins: 0, del: 0 };
  const changeStat = parseShortstat(await sh('git diff --shortstat HEAD 2>/dev/null || true', workDir, 20));
  const newFiles = (ctx.diff.match(/^--- \/dev\/null$/gm) || []).length;
  const impact = await readImpact(workDir);
  const sensitive = scanSensitivity(ctx.diff);

  const metrics: BrokerMetrics = {
    grownLoc: growthStat.ins - growthStat.del,
    grownFiles: growthStat.files,
    newFiles,
    changeIns: changeStat.ins,
    changeDel: changeStat.del,
    changedSymbols: impact.symbols,
    riskHigh: impact.high,
    riskMed: impact.med,
    sensitive,
    reqTotal: 0,
    reqVerified: 0,
    reqGaps: 0,
    falseClaims: [],
    driftSymbols: [],
  };

  let action: BrokerAction = 'review';
  let reason = '';
  const directionOk = true;
  const effLines = changeStat.ins + changeStat.del;

  if (!nonWs) {
    action = 'skip';
    reason = 'whitespace/format-only change';
  } else if (metrics.riskHigh > 0) {
    action = 'escalate';
    reason = `${metrics.riskHigh} HIGH-risk symbol(s) changed${sensitive.length ? ` - sensitive: ${sensitive.join(', ')}` : ''}`;
  } else if (ctx.firstReview) {
    action = 'review';
    reason = 'first substantive change - confirm the direction now';
  } else if (effLines >= REVIEW_LOC || metrics.riskMed > 0 || sensitive.includes('auth') || sensitive.includes('payment') || sensitive.includes('destructive') || sensitive.includes('secrets')) {
    action = 'review';
    reason = `meaningful change (+${changeStat.ins}/-${changeStat.del}${metrics.riskMed ? `, ${metrics.riskMed} medium-risk` : ''}${sensitive.length ? `, sensitive: ${sensitive.join(', ')}` : ''})`;
  } else if (effLines <= BATCH_LOC) {
    action = 'batch';
    reason = `small on-track change (+${changeStat.ins}/-${changeStat.del}) - deferred`;
  } else {
    action = 'review';
    reason = `change of +${changeStat.ins}/-${changeStat.del}`;
  }

  const focus = impact.highSyms;
  const statusMarkdown = buildStatus(ctx.goal, metrics, { action, reason, directionOk }, stamp);
  return { action, reason, directionOk, focus, metrics, statusMarkdown };
}
