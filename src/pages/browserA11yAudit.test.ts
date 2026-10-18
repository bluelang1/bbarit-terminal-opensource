import { describe, expect, it } from 'vitest';
import { auditA11y, formatA11yReport, hasHeadingSkip, type A11ySignals } from './browserA11yAudit';

describe('hasHeadingSkip', () => {
  // 정상 + 매핑: proper nesting is fine; a jump is flagged.
  it('detects skipped heading levels', () => {
    expect(hasHeadingSkip([1, 2, 2, 3])).toBe(false);
    expect(hasHeadingSkip([1, 2, 4])).toBe(true);   // h2 -> h4
    expect(hasHeadingSkip([1, 3])).toBe(true);      // h1 -> h3
  });
  // None/변조: empty and out-of-range levels don't false-positive.
  it('ignores empty and invalid levels', () => {
    expect(hasHeadingSkip([])).toBe(false);
    expect(hasHeadingSkip([2, 3])).toBe(false);     // starting deep is not a "skip"
    expect(hasHeadingSkip([1, NaN as unknown as number, 2])).toBe(false);
  });
});

describe('auditA11y', () => {
  // None: a clean page scores 100 with no findings.
  it('scores a clean page 100', () => {
    const clean: A11ySignals = {
      imagesNoAlt: 0, inputsNoLabel: 0, buttonsNoName: 0, linksGeneric: 0,
      h1Count: 1, headingLevels: [1, 2, 2, 3], hasMainLandmark: true, htmlLang: 'en',
      positiveTabindex: 0, hasViewportZoomLock: false, ariaRefsBroken: 0,
    };
    const r = auditA11y(clean);
    expect(r.score).toBe(100);
    expect(r.findings).toEqual([]);
    expect(r.summary).toContain('no common WCAG issues');
  });

  // 정상: each signal yields the right finding.
  it('flags missing alts, labels, and lang with correct severities', () => {
    const r = auditA11y({ imagesNoAlt: 3, inputsNoLabel: 2, htmlLang: '', h1Count: 1, hasMainLandmark: true });
    const ids = r.findings.map((f) => f.id);
    expect(ids).toContain('img-alt');
    expect(ids).toContain('input-label');
    expect(ids).toContain('html-lang');
    expect(r.findings.find((f) => f.id === 'img-alt')?.severity).toBe('critical');
    expect(r.score).toBeLessThan(100);
  });

  // 매핑: findings are sorted worst-first and score reflects severity weight.
  it('sorts findings worst-first and lowers the score by weight', () => {
    const r = auditA11y({ imagesNoAlt: 1, h1Count: 1, hasMainLandmark: true, htmlLang: 'en', linksGeneric: 4 });
    expect(r.findings[0].severity).toBe('critical'); // img-alt outranks the moderate link-text
    // critical(25) + moderate(6) = 31 penalty
    expect(r.score).toBe(69);
  });

  it('handles h1 count edge cases', () => {
    expect(auditA11y({ h1Count: 0, hasMainLandmark: true, htmlLang: 'en' }).findings.some((f) => f.id === 'no-h1')).toBe(true);
    expect(auditA11y({ h1Count: 3, hasMainLandmark: true, htmlLang: 'en' }).findings.some((f) => f.id === 'multi-h1')).toBe(true);
  });

  it('flags zoom lock and positive tabindex', () => {
    const r = auditA11y({ h1Count: 1, hasMainLandmark: true, htmlLang: 'en', hasViewportZoomLock: true, positiveTabindex: 2 });
    expect(r.findings.map((f) => f.id)).toEqual(expect.arrayContaining(['zoom-lock', 'tabindex']));
  });

  // 변조: empty/negative inputs never throw and never invent findings.
  it('tolerates empty and malformed signals', () => {
    const r = auditA11y({});
    // Empty signals: only checks with a definite "absent" value fire. hasMainLandmark
    // is undefined (not measured) so 'no-main' is correctly NOT asserted; h1Count and
    // htmlLang default to "missing" so those two do fire.
    expect(r.findings.map((f) => f.id).sort()).toEqual(['html-lang', 'no-h1']);
    expect(auditA11y({ imagesNoAlt: -5 } as A11ySignals).findings.some((f) => f.id === 'img-alt')).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});

describe('formatA11yReport', () => {
  it('renders a markdown table with findings', () => {
    const md = formatA11yReport(auditA11y({ imagesNoAlt: 2, h1Count: 1, hasMainLandmark: true, htmlLang: 'en' }));
    expect(md).toContain('# Accessibility audit — score');
    expect(md).toContain('| Severity | WCAG | Issue | Fix |');
    expect(md).toContain('1.1.1');
  });
  it('renders cleanly with no findings', () => {
    const md = formatA11yReport(auditA11y({ h1Count: 1, hasMainLandmark: true, htmlLang: 'en' }));
    expect(md).toContain('score 100/100');
    expect(md).not.toContain('| Severity |');
  });
});
