// Self-diagnostics for the AI browser.
//
// When something is wrong — the page won't load, the agent can't act, a site keeps
// failing — the user (and the agent) need actionable guidance, not a blank screen.
// This module takes the browser's health SIGNALS (native browser availability, live control
// session, engine mode, last error, recent network/console failures) and produces a
// health verdict plus concrete troubleshooting steps. Pure and tested; the component
// gathers the live signals and the agent surfaces the report.
//
// D1: Ordered, first-blocking-issue-wins diagnosis.
//     Reason: a detached control session is meaningless to report if Chrome itself is
//     unavailable — fix the root first. Cost: only the top blocker is "critical", the
//     rest are advisory. Escape hatch: the full findings list is always returned.

export interface BrowserHealthSignals {
  isDesktopApp?: boolean;      // running inside Tauri (vs plain web)
  chromeAvailable?: boolean;   // the native browser backend is reachable
  liveSession?: boolean;       // CDP control socket is OPEN when a persistent socket is required
  engineMode?: string;         // 'webview' is the current built-in engine mode
  lastError?: string;          // last surfaced browser error
  recentNetworkFailures?: number;
  recentConsoleErrors?: number;
  currentUrl?: string;
}

export type HealthLevel = 'ok' | 'degraded' | 'down';

export interface Diagnosis {
  level: HealthLevel;
  headline: string;
  findings: Array<{ severity: 'critical' | 'warning' | 'info'; issue: string; fix: string }>;
}

export function diagnoseBrowser(signals: BrowserHealthSignals): Diagnosis {
  const s = signals || {};
  const findings: Diagnosis['findings'] = [];
  const isNativeWebview = s.engineMode === 'webview' || s.engineMode === 'wkwebview' || s.engineMode === 'webview2' || s.engineMode === 'webkitgtk';

  // Root blockers first (down).
  if (s.isDesktopApp === false) {
    findings.push({ severity: 'critical', issue: 'Not running in the BBARIT desktop app', fix: 'Open BBARIT Terminal (the desktop app) — the built-in browser is only available there, not in a plain web view.' });
  } else if (s.chromeAvailable === false) {
    findings.push({ severity: 'critical', issue: 'The browser backend is unavailable', fix: 'BBARIT uses the system native webview runtime: WKWebView on macOS and WebView2 on Windows. Restart BBARIT, then check whether security software is blocking the runtime.' });
  } else if (s.liveSession === false && !isNativeWebview) {
    findings.push({ severity: 'critical', issue: 'The browser control connection is detached', fix: 'Click the BBARIT Browser button to (re)start the session, then retry. Do not open new pages while detached.' });
  }

  // Degradations (warnings) — reported even when a root blocker exists.
  if (s.engineMode && !isNativeWebview && s.engineMode !== 'exact-chrome') {
    findings.push({ severity: 'warning', issue: `Engine mode is "${s.engineMode}", not the built-in BBARIT Browser`, fix: 'Open the BBARIT Browser window and retry from the active browser tab.' });
  }
  if (s.lastError && s.lastError.trim()) {
    findings.push({ severity: 'warning', issue: `Last browser error: ${s.lastError.slice(0, 160)}`, fix: 'Reload the page; if it repeats, restart the BBARIT Browser session.' });
  }
  if ((s.recentNetworkFailures ?? 0) >= 3) {
    findings.push({ severity: 'warning', issue: `${s.recentNetworkFailures} recent failed network requests`, fix: 'The site may be blocking, offline, or rate-limiting. Check browser_check_access and the network log.' });
  }
  if ((s.recentConsoleErrors ?? 0) >= 5) {
    findings.push({ severity: 'info', issue: `${s.recentConsoleErrors} recent console errors`, fix: 'The page has JS errors; they may break interactive elements. Inspect via browser_console.' });
  }

  const hasCritical = findings.some((f) => f.severity === 'critical');
  const hasWarning = findings.some((f) => f.severity === 'warning');
  const level: HealthLevel = hasCritical ? 'down' : hasWarning ? 'degraded' : 'ok';
  const headline = level === 'ok'
    ? 'Browser healthy — built-in browser connected and responsive.'
    : level === 'degraded'
      ? `Browser working with ${findings.length} issue(s) to watch.`
      : findings.find((f) => f.severity === 'critical')!.issue + '.';
  return { level, headline, findings };
}

export function formatDiagnosis(d: Diagnosis): string {
  const lines = [`# Browser diagnostics — ${d.level.toUpperCase()}`, '', d.headline];
  if (d.findings.length) {
    lines.push('', '| Severity | Issue | Fix |', '| --- | --- | --- |');
    for (const f of d.findings) lines.push(`| ${f.severity} | ${f.issue} | ${f.fix} |`);
  } else {
    lines.push('', 'No issues detected.');
  }
  return lines.join('\n');
}
