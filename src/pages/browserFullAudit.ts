// Unified page health audit: combine the accessibility and performance audits (and
// an optional SEO score) into one health card with an overall grade and the top
// issues across every axis.
//
// Each axis already has its own scored report; this aggregator is the "integrated"
// view — one number and one prioritized action list instead of three separate runs.
// Pure so the weighting/grading is deterministic and tested.
//
// D1: The overall score is a WEIGHTED average of the axis scores, not a min or sum.
//     Reason: a page weak on one axis but strong elsewhere should not read as fully
//     broken, yet each axis should meaningfully move the grade. Missing axes are
//     dropped from the average (never counted as 0) so a partial audit is fair.

import type { A11yReport, A11yFinding } from './browserA11yAudit';
import type { PerfReport, PerfFinding } from './browserPerfAudit';

export interface AuditInputs {
  a11y?: A11yReport | null;
  perf?: PerfReport | null;
  seoScore?: number | null;   // 0-100 if an SEO score is available
}

export interface AxisScore { axis: string; score: number; grade: LetterGrade }
export type LetterGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface FullAuditReport {
  overall: number;
  grade: LetterGrade;
  axes: AxisScore[];
  topIssues: Array<{ axis: string; severity: string; issue: string; fix: string }>;
  summary: string;
}

// Relative weight of each axis in the overall score.
const AXIS_WEIGHT: Record<string, number> = { accessibility: 1, performance: 1, seo: 1 };

export function letterGrade(score: number): LetterGrade {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  if (s >= 90) return 'A';
  if (s >= 80) return 'B';
  if (s >= 70) return 'C';
  if (s >= 60) return 'D';
  return 'F';
}

// Rank findings so the most severe across all axes surface first.
const SEVERITY_RANK: Record<string, number> = { critical: 3, serious: 3, warning: 2, moderate: 2, minor: 1, info: 1 };

export function combineAudits(inputs: AuditInputs): FullAuditReport {
  const axes: AxisScore[] = [];
  const weighted: Array<{ score: number; weight: number }> = [];
  const topIssues: FullAuditReport['topIssues'] = [];

  const addAxis = (axis: string, score: number | null | undefined) => {
    if (score === null || score === undefined || !Number.isFinite(score)) return;
    const clamped = Math.max(0, Math.min(100, score));
    axes.push({ axis, score: Math.round(clamped), grade: letterGrade(clamped) });
    weighted.push({ score: clamped, weight: AXIS_WEIGHT[axis] ?? 1 });
  };

  addAxis('accessibility', inputs.a11y ? inputs.a11y.score : null);
  addAxis('performance', inputs.perf ? inputs.perf.score : null);
  addAxis('seo', inputs.seoScore ?? null);

  for (const f of (inputs.a11y?.findings || []) as A11yFinding[]) topIssues.push({ axis: 'accessibility', severity: f.severity, issue: f.message, fix: f.fix });
  for (const f of (inputs.perf?.findings || []) as PerfFinding[]) topIssues.push({ axis: 'performance', severity: f.severity, issue: f.issue, fix: f.fix });
  topIssues.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));

  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  const overall = totalWeight > 0
    ? Math.round(weighted.reduce((sum, w) => sum + w.score * w.weight, 0) / totalWeight)
    : 0;
  const grade = letterGrade(overall);

  const axisText = axes.length ? axes.map((a) => `${a.axis} ${a.score}(${a.grade})`).join(', ') : 'no axes measured';
  return {
    overall, grade, axes,
    topIssues: topIssues.slice(0, 8),
    summary: `Overall page health ${overall}/100 (${grade}) — ${axisText}.`,
  };
}

export function formatFullAudit(r: FullAuditReport): string {
  const lines = [`# Page health — ${r.overall}/100 (grade ${r.grade})`, '', r.summary];
  if (r.axes.length) { lines.push('', '## By axis'); for (const a of r.axes) lines.push(`- ${a.axis}: ${a.score}/100 (${a.grade})`); }
  if (r.topIssues.length) { lines.push('', '## Top issues (all axes)'); for (const t of r.topIssues) lines.push(`- [${t.axis}/${t.severity}] ${t.issue} → ${t.fix}`); }
  return lines.join('\n');
}
