// Accessibility (WCAG) auditor for the current page.
//
// The AI browser can already audit SEO and reverse-engineer a page; accessibility is
// the missing axis. This module takes accessibility SIGNALS collected in-page (image
// alts, form-control labels, heading levels, landmarks, language, link text, tab
// order hints) and produces a prioritized, WCAG-referenced report. The collection is
// a thin in-page script; the scoring/prioritization is pure and tested here.
//
// D1: Rule-based, DOM-signal audit — not a full ACT-rules engine.
//     Reason: it must run instantly on any page from a single snapshot, with no extra
//     dependencies. Cost: it catches the common, high-impact failures (the ones that
//     block real users), not every SC. Escape hatch: the agent can dig deeper with
//     browser_eval for a specific element.

export interface A11ySignals {
  imagesTotal?: number;
  imagesNoAlt?: number;
  inputsTotal?: number;
  inputsNoLabel?: number;
  buttonsNoName?: number;
  linksTotal?: number;
  linksGeneric?: number;     // "click here", "read more", empty
  headingLevels?: number[];  // in document order, e.g. [1,2,2,4]
  h1Count?: number;
  hasMainLandmark?: boolean;
  htmlLang?: string;
  hasSkipLink?: boolean;
  positiveTabindex?: number;  // count of tabindex > 0 (anti-pattern)
  hasViewportZoomLock?: boolean; // user-scalable=no / maximum-scale<=1
  ariaRefsBroken?: number;    // aria-labelledby/controls pointing at missing ids
}

export type A11ySeverity = 'critical' | 'serious' | 'moderate' | 'minor';

export interface A11yFinding {
  id: string;
  severity: A11ySeverity;
  wcag: string;      // e.g. "1.1.1"
  count?: number;
  message: string;
  fix: string;
}

export interface A11yReport {
  score: number;             // 0-100
  findings: A11yFinding[];
  summary: string;
}

const SEVERITY_WEIGHT: Record<A11ySeverity, number> = { critical: 25, serious: 12, moderate: 6, minor: 2 };

// True if heading levels ever jump by more than one going down (e.g. h2 -> h4).
export function hasHeadingSkip(levels: number[]): boolean {
  let prev = 0;
  for (const lvl of levels) {
    if (!Number.isFinite(lvl) || lvl < 1 || lvl > 6) continue;
    if (prev && lvl > prev + 1) return true;
    prev = lvl;
  }
  return false;
}

export function auditA11y(signals: A11ySignals): A11yReport {
  const s = signals || {};
  const findings: A11yFinding[] = [];
  const add = (f: A11yFinding) => findings.push(f);

  const imagesNoAlt = Math.max(0, s.imagesNoAlt ?? 0);
  if (imagesNoAlt > 0) add({ id: 'img-alt', severity: 'critical', wcag: '1.1.1', count: imagesNoAlt,
    message: `${imagesNoAlt} image(s) missing alt text`, fix: 'Add descriptive alt="" (or alt="" for decorative images).' });

  const inputsNoLabel = Math.max(0, s.inputsNoLabel ?? 0);
  if (inputsNoLabel > 0) add({ id: 'input-label', severity: 'critical', wcag: '1.3.1 / 4.1.2', count: inputsNoLabel,
    message: `${inputsNoLabel} form control(s) without an associated label`, fix: 'Add a <label for>, aria-label, or aria-labelledby.' });

  const buttonsNoName = Math.max(0, s.buttonsNoName ?? 0);
  if (buttonsNoName > 0) add({ id: 'button-name', severity: 'serious', wcag: '4.1.2', count: buttonsNoName,
    message: `${buttonsNoName} button(s) with no accessible name`, fix: 'Give the button text content or an aria-label.' });

  if ((s.h1Count ?? 0) === 0) add({ id: 'no-h1', severity: 'moderate', wcag: '1.3.1 / 2.4.6',
    message: 'Page has no <h1>', fix: 'Add a single top-level <h1> describing the page.' });
  else if ((s.h1Count ?? 0) > 1) add({ id: 'multi-h1', severity: 'minor', wcag: '1.3.1', count: s.h1Count,
    message: `Page has ${s.h1Count} <h1> elements`, fix: 'Prefer a single <h1>; use <h2>+ for sections.' });

  if (hasHeadingSkip(s.headingLevels || [])) add({ id: 'heading-order', severity: 'moderate', wcag: '1.3.1',
    message: 'Heading levels skip (e.g. h2 → h4)', fix: 'Do not skip heading levels; nest them in order.' });

  const linksGeneric = Math.max(0, s.linksGeneric ?? 0);
  if (linksGeneric > 0) add({ id: 'link-text', severity: 'moderate', wcag: '2.4.4', count: linksGeneric,
    message: `${linksGeneric} link(s) with generic/empty text ("click here")`, fix: 'Use link text that describes the destination.' });

  if (s.hasMainLandmark === false) add({ id: 'no-main', severity: 'moderate', wcag: '1.3.1',
    message: 'No <main> landmark', fix: 'Wrap the primary content in <main>.' });

  if (!String(s.htmlLang || '').trim()) add({ id: 'html-lang', severity: 'serious', wcag: '3.1.1',
    message: '<html> has no lang attribute', fix: 'Set <html lang="…"> to the page language.' });

  if ((s.positiveTabindex ?? 0) > 0) add({ id: 'tabindex', severity: 'moderate', wcag: '2.4.3', count: s.positiveTabindex,
    message: `${s.positiveTabindex} element(s) use a positive tabindex`, fix: 'Avoid tabindex > 0; keep DOM order meaningful.' });

  if (s.hasViewportZoomLock) add({ id: 'zoom-lock', severity: 'serious', wcag: '1.4.4',
    message: 'Viewport disables zoom (user-scalable=no / maximum-scale)', fix: 'Remove user-scalable=no; allow pinch-zoom.' });

  const ariaRefsBroken = Math.max(0, s.ariaRefsBroken ?? 0);
  if (ariaRefsBroken > 0) add({ id: 'aria-refs', severity: 'serious', wcag: '1.3.1 / 4.1.2', count: ariaRefsBroken,
    message: `${ariaRefsBroken} ARIA reference(s) point to missing element ids`, fix: 'Fix aria-labelledby/controls/describedby id targets.' });

  const penalty = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const worst = findings.slice().sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);
  const summary = findings.length
    ? `A11y score ${score}/100 — ${findings.length} issue(s); top: ${worst[0].message}.`
    : 'A11y score 100/100 — no common WCAG issues detected in the sampled signals.';
  return { score, findings: worst, summary };
}

// Compact markdown for the agent tool output.
export function formatA11yReport(report: A11yReport): string {
  const lines = [`# Accessibility audit — score ${report.score}/100`, '', report.summary];
  if (report.findings.length) {
    lines.push('', '| Severity | WCAG | Issue | Fix |', '| --- | --- | --- | --- |');
    for (const f of report.findings) lines.push(`| ${f.severity} | ${f.wcag} | ${f.message} | ${f.fix} |`);
  }
  return lines.join('\n');
}
