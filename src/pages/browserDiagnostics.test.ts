import { describe, expect, it } from 'vitest';
import { diagnoseBrowser, formatDiagnosis, type BrowserHealthSignals } from './browserDiagnostics';

const healthy: BrowserHealthSignals = {
  isDesktopApp: true, chromeAvailable: true, liveSession: true, engineMode: 'webview',
  lastError: '', recentNetworkFailures: 0, recentConsoleErrors: 0, currentUrl: 'https://a.test',
};

describe('diagnoseBrowser', () => {
  // 정상: a healthy browser reports ok with no findings.
  it('reports ok for a healthy browser', () => {
    const d = diagnoseBrowser(healthy);
    expect(d.level).toBe('ok');
    expect(d.findings).toEqual([]);
    expect(d.headline).toContain('healthy');
  });

  // 매핑: root blockers are critical and set level=down, most-root first.
  it('flags the root blocker first', () => {
    expect(diagnoseBrowser({ ...healthy, isDesktopApp: false }).findings[0].issue).toMatch(/desktop app/i);
    expect(diagnoseBrowser({ ...healthy, chromeAvailable: false }).findings[0].issue).toMatch(/backend is unavailable/i);
    expect(diagnoseBrowser({ ...healthy, engineMode: 'exact-chrome', liveSession: false }).findings[0].issue).toMatch(/detached/i);
    expect(diagnoseBrowser({ ...healthy, chromeAvailable: false }).level).toBe('down');
  });

  it('does not treat an idle WebView CDP socket as broken', () => {
    const d = diagnoseBrowser({ ...healthy, liveSession: false });
    expect(d.level).toBe('ok');
    expect(d.findings).toEqual([]);
  });

  // 매핑: only the most-root blocker is reported (not chained lesser ones).
  it('reports only the root blocker when several are false', () => {
    const d = diagnoseBrowser({ ...healthy, isDesktopApp: false, chromeAvailable: false, liveSession: false });
    const criticals = d.findings.filter((f) => f.severity === 'critical');
    expect(criticals).toHaveLength(1);
    expect(criticals[0].issue).toMatch(/desktop app/i);
  });

  // 매핑: warnings without a critical → degraded.
  it('reports degraded for warnings only', () => {
    const d = diagnoseBrowser({ ...healthy, recentNetworkFailures: 4, lastError: 'net::ERR_TIMED_OUT' });
    expect(d.level).toBe('degraded');
    expect(d.findings.some((f) => f.issue.match(/failed network/i))).toBe(true);
    expect(d.findings.some((f) => f.issue.match(/Last browser error/i))).toBe(true);
  });

  // None/변조: empty and partial signals never throw.
  it('tolerates empty and partial signals', () => {
    expect(() => diagnoseBrowser({})).not.toThrow();
    expect(diagnoseBrowser({}).level).toBe('ok'); // unknown ≠ broken (no false alarms)
    expect(diagnoseBrowser(undefined as unknown as BrowserHealthSignals).level).toBe('ok');
  });

  it('treats low failure counts as not worth flagging', () => {
    const d = diagnoseBrowser({ ...healthy, recentNetworkFailures: 2, recentConsoleErrors: 4 });
    expect(d.level).toBe('ok');
    expect(d.findings).toEqual([]);
  });
});

describe('formatDiagnosis', () => {
  it('renders a status header and findings table', () => {
    const md = formatDiagnosis(diagnoseBrowser({ ...healthy, engineMode: 'exact-chrome', liveSession: false }));
    expect(md).toContain('# Browser diagnostics — DOWN');
    expect(md).toContain('| Severity | Issue | Fix |');
    expect(md).toContain('detached');
  });
  it('renders cleanly when healthy', () => {
    const md = formatDiagnosis(diagnoseBrowser(healthy));
    expect(md).toContain('OK');
    expect(md).toContain('No issues detected');
  });
});
