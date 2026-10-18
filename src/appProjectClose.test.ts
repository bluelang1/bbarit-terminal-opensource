import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTranslation, type Locale } from './i18n';

function appSourceSection(startMarker: string, endMarker: string): string {
  const source = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('project close confirmation', () => {
  it('uses the app confirmation modal instead of the browser confirm dialog', () => {
    const section = appSourceSection('const closeProjectNow', '// New project modal component');

    expect(section).toContain('openConfirm({');
    expect(section).toContain("t('app.confirm.closeProjectMessage' as any)");
    expect(section).not.toContain('window.confirm');
  });

  it('keeps confirm labels tied to the current language function', () => {
    const section = appSourceSection('const openConfirm = useCallback', 'const closeConfirm = useCallback');

    expect(section).toContain("confirmLabel: opts.confirmLabel || t('common.confirm')");
    expect(section).toContain("cancelLabel: opts.cancelLabel || t('common.cancel')");
    expect(section).toContain('}, [t]);');
  });

  it('localizes the project close message', () => {
    expect(getTranslation('en', 'app.confirm.closeProjectMessage' as any))
      .toBe('Close "{name}"?\nTerminal sessions will stop. You can reopen it from Recent Projects.');
    expect(getTranslation('ko', 'app.confirm.closeProjectMessage' as any))
      .toBe('"{name}" 프로젝트를 닫을까요?\n터미널이 종료됩니다. 최근 목록에서 다시 열 수 있어요.');

    const locales: Locale[] = ['en', 'ko', 'ja', 'zh', 'fr', 'de', 'it', 'es'];
    for (const locale of locales) {
      expect(getTranslation(locale, 'app.confirm.closeProjectMessage' as any)).toContain('{name}');
    }
  });
});
