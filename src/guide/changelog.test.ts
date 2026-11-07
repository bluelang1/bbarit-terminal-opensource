import { describe, expect, it } from 'vitest';
import CHANGELOG from '../../CHANGELOG.md?raw';
import { compareVersions, inlineTokens, olderSections, parseChangelog, sectionsToShow } from './changelog';

const MD = `# 변경 이력\n\n## [Unreleased]\n\n## [1.1.67] - 2026-11-09\n\n### 추가\n\n- A **굵게** \`code\`\n\n### 수정\n\n- B\n\n## [1.1.66] - 2026-11-07\n\n### 수정\n\n- C\n\n## [1.1.65] - 2026-11-07\n\n## [1.1.64] - 2026-11-06\n\n### 변경\n\n- D\n\n[Unreleased]: https://x\n[1.1.67]: https://y\n`;

describe('parseChangelog', () => {
  it('parses sections and groups', () => {
    const s = parseChangelog(MD);
    expect(s.map(x => x.version)).toEqual(['1.1.67', '1.1.66', '1.1.65', '1.1.64']);
    expect(s[0].date).toBe('2026-11-09');
    expect(s[0].groups).toEqual([{ kind: '추가', items: ['A **굵게** `code`'] }, { kind: '수정', items: ['B'] }]);
    expect(s[2].groups).toEqual([]);
  });

  it('ignores Unreleased items and link references', () => {
    const md = `## [Unreleased]\n\n### 추가\n\n- not yet\n\n## [1.0.0] - 2026-01-01\n\n### 추가\n\n- shipped\n\n[1.0.0]: https://example.com\n`;
    const s = parseChangelog(md);
    expect(s).toEqual([{ version: '1.0.0', date: '2026-01-01', groups: [{ kind: '추가', items: ['shipped'] }] }]);
  });

  it('joins wrapped continuation lines into the item', () => {
    const md = `## [1.0.0] - 2026-01-01\n\n### 수정\n\n- first line\n  continues here\n- second\n`;
    expect(parseChangelog(md)[0].groups[0].items).toEqual(['first line continues here', 'second']);
  });

  it('parses the real CHANGELOG.md', () => {
    const s = parseChangelog(CHANGELOG);
    expect(s.length).toBeGreaterThanOrEqual(10);
    for (const sec of s) expect(sec.version).toMatch(/^\d+\.\d+\.\d+$/);
    // file order is newest first
    for (let i = 1; i < s.length; i++) expect(compareVersions(s[i - 1].version, s[i].version)).toBeGreaterThan(0);
  });
});

describe('compareVersions', () => {
  it('is numeric', () => {
    expect(compareVersions('1.1.10', '1.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.1.9', '1.1.10')).toBeLessThan(0);
    expect(compareVersions('1.1.6', '1.1.6')).toBe(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });
});

describe('sectionsToShow', () => {
  it('sectionsToShow skips empty and missing', () => {
    expect(sectionsToShow(parseChangelog(MD), '1.1.63', '1.1.67').map(s => s.version)).toEqual(['1.1.67', '1.1.66', '1.1.64']);
  });

  it('skipped versions come newest first', () => {
    expect(sectionsToShow(parseChangelog(MD), '1.1.64', '1.1.67').map(s => s.version)).toEqual(['1.1.67', '1.1.66']);
  });

  it('null lastSeen shows current only', () => {
    expect(sectionsToShow(parseChangelog(MD), null, '1.1.66').map(s => s.version)).toEqual(['1.1.66']);
  });

  it('same or newer lastSeen shows nothing', () => {
    expect(sectionsToShow(parseChangelog(MD), '1.1.67', '1.1.67')).toEqual([]);
    expect(sectionsToShow(parseChangelog(MD), '1.1.70', '1.1.67')).toEqual([]);
  });

  it('current version without a section shows nothing', () => {
    expect(sectionsToShow(parseChangelog(MD), null, '1.1.65')).toEqual([]);
    expect(sectionsToShow(parseChangelog(MD), null, '9.9.9')).toEqual([]);
  });
});

describe('inlineTokens', () => {
  it('splits bold and code, leaves the rest as text', () => {
    expect(inlineTokens('A **굵게** `code` end')).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'bold', text: '굵게' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'code' },
      { kind: 'text', text: ' end' },
    ]);
  });

  it('keeps markup-looking text inert (no HTML)', () => {
    expect(inlineTokens('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]);
  });

  it('leaves unmatched markers as text', () => {
    expect(inlineTokens('a ** b ` c')).toEqual([{ kind: 'text', text: 'a ** b ` c' }]);
  });

  it('does not parse bold inside code', () => {
    expect(inlineTokens('`**x**`')).toEqual([{ kind: 'code', text: '**x**' }]);
  });
});

describe('olderSections', () => {
  it('returns sections older than the shown ones, newest first, with items only', () => {
    const all = parseChangelog(MD);
    const shown = sectionsToShow(all, null, '1.1.67');
    expect(olderSections(all, shown, 5).map(s => s.version)).toEqual(['1.1.66', '1.1.64']);
    expect(olderSections(all, shown, 1).map(s => s.version)).toEqual(['1.1.66']);
  });

  it('with nothing shown, starts at current or below', () => {
    expect(olderSections(parseChangelog(MD), [], 5, '1.1.65').map(s => s.version)).toEqual(['1.1.64']);
  });
});
