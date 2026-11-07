import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CHANGELOG from '../../CHANGELOG.md?raw';
import { parseChangelog } from '../guide/changelog';

vi.mock('../i18n', async () => {
  const { getTranslation } = await vi.importActual<typeof import('../i18n')>('../i18n');
  return { useTranslation: () => ({ t: (k: string) => getTranslation('ko', k as never), locale: 'ko' }) };
});

import GuidePage from './GuidePage';

async function renderAt(search: string) {
  window.history.replaceState(null, '', `/guide${search}`);
  let view: ReturnType<typeof render> | undefined;
  await act(async () => { view = render(<GuidePage />); });
  return view!;
}

describe('GuidePage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('start mode lists the steps and walks with 다음', async () => {
    await renderAt('?mode=start');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('BBARIT 시작하기');
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toContain('1프로젝트 열기');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('프로젝트 열기');
    expect(screen.getByText('직접 해보기')).toBeTruthy();
    fireEvent.click(screen.getByText('다음'));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('AI 터미널 열기');
    expect(screen.getByText('1/' + screen.getAllByRole('listitem').length + ' 완료')).toBeTruthy();
  });

  it('status step has no try-it button and shows the hint', async () => {
    await renderAt('?mode=start&step=status');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('상태 표시와 알림');
    expect(screen.queryByText('직접 해보기')).toBeNull();
    expect(document.querySelector('.guide-hint')?.textContent).toContain('AI 탭에 일을 시켜 보면');
  });

  it('restores saved progress and opens on the first unfinished step', async () => {
    localStorage.setItem('bbarit-guide-progress', JSON.stringify({ project: 1, 'ai-terminal': 2, bogus: 3 }));
    await renderAt('?mode=start');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('상태 표시와 알림');
  });

  it('whatsnew mode renders the newest CHANGELOG section as cards', async () => {
    const newest = parseChangelog(CHANGELOG).find(s => s.groups.length > 0)!;
    await renderAt('?mode=whatsnew');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`${newest.version}에서 새로 생긴 것`);
    expect(document.querySelectorAll('.wn-card').length).toBeGreaterThan(0);
    expect(screen.getByText('이전 버전')).toBeTruthy();
    fireEvent.click(screen.getByText('시작하기 가이드 보기'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('BBARIT 시작하기');
  });
});
