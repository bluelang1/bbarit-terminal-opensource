import { describe, expect, it } from 'vitest';
import { applyTemplateVariables, buildDailyNoteContent, formatDailyDate, getDailyNotePath } from './dailyNotes';

const d = new Date(2026, 6, 10, 9, 5); // 2026-07-10 09:05 local

describe('dailyNotes', () => {
  it('formats dates as YYYY-MM-DD', () => {
    expect(formatDailyDate(d)).toBe('2026-07-10');
  });

  it('builds the daily note path under notesDir/daily', () => {
    expect(getDailyNotePath('/home/u/Documents/octo-notes', d))
      .toBe('/home/u/Documents/octo-notes/daily/2026-07-10.md');
    expect(getDailyNotePath('C:\\Users\\u\\Documents\\octo-notes', d))
      .toBe('C:\\Users\\u\\Documents\\octo-notes\\daily\\2026-07-10.md');
  });

  it('expands template variables', () => {
    const out = applyTemplateVariables(
      '# {{title}}\n{{date}} {{time}}\nprev {{yesterday}} next {{tomorrow}}',
      { title: 'My Note', date: d },
    );
    expect(out).toBe('# My Note\n2026-07-10 09:05\nprev 2026-07-09 next 2026-07-11');
  });

  it('builds default daily content with prev/next wikilinks', () => {
    const content = buildDailyNoteContent(d);
    expect(content).toContain('# 2026-07-10');
    expect(content).toContain('[[2026-07-09]]');
    expect(content).toContain('[[2026-07-11]]');
  });

  it('prefers the provided template', () => {
    expect(buildDailyNoteContent(d, 'Journal {{date}}')).toBe('Journal 2026-07-10');
  });
});
