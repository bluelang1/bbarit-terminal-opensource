// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrokerHarnessModal, type BrokerHarness } from './BrokerHarnessModal';

const baseHarness: BrokerHarness = {
  id: 'h-1',
  name: 'first task',
  projectId: 'p-1',
  projectName: 'Project One',
  developer: 'claude',
  reviewer: 'codex',
  developerId: 'dev-1',
  reviewerId: 'rev-1',
  createdAt: 1,
};

function renderModal(overrides?: Partial<Parameters<typeof BrokerHarnessModal>[0]>) {
  const harnesses: BrokerHarness[] = [
    { ...baseHarness, id: 'h-1', name: 'completed task', status: { cycle: 'merged', cycleLabel: 'Merged', reason: 'done' } },
    { ...baseHarness, id: 'h-2', name: 'active task', developerId: 'dev-2', reviewerId: 'rev-2', createdAt: 2, status: { cycle: 'developing', cycleLabel: 'Developing', reason: 'working' } },
    { ...baseHarness, id: 'h-3', name: 'review task', developerId: 'dev-3', reviewerId: 'rev-3', createdAt: 3, status: { cycle: 'reviewing', cycleLabel: 'Reviewing', reason: 'reviewing' } },
  ];

  return render(
    <BrokerHarnessModal
      open
      harnesses={harnesses}
      projects={[{ id: 'p-1', name: 'Project One' }]}
      selectedId="h-2"
      terminalArea={<div data-testid="terminal-area">terminals</div>}
      lang="en"
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onStopHarness={vi.fn()}
      onCreateHarness={vi.fn()}
      onRename={vi.fn()}
      {...overrides}
    />,
  );
}

describe('BrokerHarnessModal', () => {
  it('does not contain a UTF-8 BOM or committed mojibake markers', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/BrokerHarnessModal.tsx'), 'utf8');

    expect(source.charCodeAt(0)).not.toBe(0xfeff);
    expect(source).not.toMatch(/[\uFFFD\u0080-\u009F]/);
    expect(source).not.toMatch(/(^|\s|\/\/|\/\*)\?\?[A-Za-z]|[A-Za-z]\?\?[A-Za-z]/);
    expect(source).not.toMatch(/[\uC338\uBD31]/);
  });

  it('marks only the selected harness as live/open', () => {
    const { container } = renderModal();

    const rows = [...container.querySelectorAll('.bhm-harness')];
    expect(rows).toHaveLength(3);
    expect(container.querySelectorAll('.bhm-harness.live')).toHaveLength(1);
    expect(container.querySelector('.bhm-harness.sel.live')?.textContent).toContain('active task');
  });

  it('starts a new harness from the project plus button', () => {
    const onCreateHarness = vi.fn();
    renderModal({ onCreateHarness });

    fireEvent.click(screen.getAllByTitle('New harness on this project')[1]);

    expect(onCreateHarness).toHaveBeenCalledTimes(1);
    expect(onCreateHarness).toHaveBeenCalledWith('p-1');
  });

  it('starts a new harness from the header action', () => {
    const onCreateHarness = vi.fn();
    renderModal({ onCreateHarness });

    fireEvent.click(screen.getAllByTitle('New harness on this project')[0]);

    expect(onCreateHarness).toHaveBeenCalledTimes(1);
    expect(onCreateHarness).toHaveBeenCalledWith('p-1');
  });

  it('blocks harness start on non-Git projects and explains why', () => {
    const onCreateHarness = vi.fn();
    renderModal({
      harnesses: [],
      selectedId: null,
      projects: [{ id: 'p-1', name: 'Plain Folder', isGitRepo: false }],
      onCreateHarness,
    });

    expect(screen.getByText('A Git project is required.')).toBeTruthy();
    expect(screen.getAllByText('Git required').length).toBeGreaterThan(0);

    const startButtons = screen.getAllByTitle('Broker Harness requires a Git repository project.');
    startButtons.forEach((button) => {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    });
    expect(onCreateHarness).not.toHaveBeenCalled();
  });

  it('fires the manual rework / reset-review / restart controls for the selected active harness', () => {
    const onRequestRework = vi.fn().mockResolvedValue(true);
    const onResetReviewFeed = vi.fn().mockResolvedValue(true);
    const onRestartAgents = vi.fn().mockResolvedValue(true);
    const onCleanupProjectDevProcesses = vi.fn().mockResolvedValue(2);
    renderModal({ onRequestRework, onResetReviewFeed, onRestartAgents, onCleanupProjectDevProcesses });

    fireEvent.click(screen.getByTitle('Re-send the latest review feedback (REWORK) to the dev agent'));
    expect(onRequestRework).toHaveBeenCalledWith('h-2');

    fireEvent.click(screen.getByTitle('Clear the review feed and reset the review cycle (code/diff untouched)'));
    expect(onResetReviewFeed).toHaveBeenCalledWith('h-2');

    fireEvent.click(screen.getByTitle('Restart both agent CLIs in the same worktree (work/progress kept, re-briefed)'));
    expect(onRestartAgents).toHaveBeenCalledWith('h-2');

    fireEvent.click(screen.getByTitle('Stop orphan project dev servers started by this harness'));
    expect(onCleanupProjectDevProcesses).toHaveBeenCalledWith('h-2');
  });

  it.each(['approved', 'merging', 'merged', 'merge_failed'] as const)(
    'hides the manual rework/reset controls once the cycle is %s (merge is a one-way door)',
    (cycle) => {
      const mergePhase: BrokerHarness[] = [
        { ...baseHarness, id: 'h-mp', name: 'merging task', status: { cycle, cycleLabel: cycle, reason: cycle } },
      ];
      renderModal({ harnesses: mergePhase, selectedId: 'h-mp', onRequestRework: vi.fn(), onResetReviewFeed: vi.fn(), onRestartAgents: vi.fn() });

      expect(screen.queryByTitle('Re-send the latest review feedback (REWORK) to the dev agent')).toBeNull();
      expect(screen.queryByTitle('Clear the review feed and reset the review cycle (code/diff untouched)')).toBeNull();
      expect(screen.queryByTitle('Restart both agent CLIs in the same worktree (work/progress kept, re-briefed)')).toBeNull();
    },
  );

  it('hides the manual controls for a resting (complete/blocked/suspended) harness', () => {
    // Resting is keyed off lifecycle, not status.cycle: a 'complete' harness shows no controls.
    const resting: BrokerHarness[] = [
      { ...baseHarness, id: 'h-rest', name: 'finished task', lifecycle: 'complete', status: { cycle: 'merged', cycleLabel: 'Merged', reason: 'done' } },
    ];
    renderModal({ harnesses: resting, selectedId: 'h-rest', onRequestRework: vi.fn(), onResetReviewFeed: vi.fn() });

    expect(screen.queryByTitle('Re-send the latest review feedback (REWORK) to the dev agent')).toBeNull();
    expect(screen.queryByTitle('Clear the review feed and reset the review cycle (code/diff untouched)')).toBeNull();
  });

  it('selects a harness when its row is clicked', () => {
    const onSelect = vi.fn();
    renderModal({ onSelect });

    fireEvent.click(screen.getByText('review task'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('h-3');
  });

  it('keeps completed harnesses listed but excludes them from the running count', () => {
    renderModal();

    expect(screen.getByText(/2 running \/ 3 total/)).toBeTruthy();
    expect(screen.getByText('completed task')).toBeTruthy();
    expect(screen.getByText('active task')).toBeTruthy();
  });

  it('does not mark a selected completed harness as live/open', () => {
    const { container } = renderModal({ selectedId: 'h-1' });

    expect(container.querySelector('.bhm-harness.sel')?.textContent).toContain('completed task');
    expect(container.querySelector('.bhm-harness.sel.live')).toBeNull();
    expect(container.querySelector('.bhm-harness.sel .bhm-harness-name')?.textContent).not.toContain('open');
  });

  it('uses the selected broker branch and terminal area in the detail pane', () => {
    renderModal({
      harnesses: [
        { ...baseHarness, id: 'h-1', name: 'active task', branch: 'broker/123', worktreeDir: 'C:/repo/.octo-tmp/broker-wt-123', status: { cycle: 'developing', cycleLabel: 'Developing', reason: 'working' } },
      ],
      selectedId: 'h-1',
    });

    expect(screen.getByText('broker/123')).toBeTruthy();
    expect(screen.getByTestId('terminal-area')).toBeTruthy();
  });

  it('shows the selected harness status panel above the broker detail', () => {
    const { container } = renderModal({
      harnesses: [
        { ...baseHarness, id: 'h-1', name: 'review task', branch: 'broker/123', status: { cycle: 'reviewing', cycleLabel: 'Reviewing', reason: 'review requested', action: 'review', grownLoc: 9 } },
      ],
      selectedId: 'h-1',
    });

    const detailChildren = [...(container.querySelector('.bhm-detail')?.children || [])];
    expect(detailChildren[0].classList.contains('broker-status-panel')).toBe(true);
    expect(screen.getByText('3. Reviewing')).toBeTruthy();
    expect(within(detailChildren[0] as HTMLElement).getByText('+9 LOC')).toBeTruthy();
    expect(within(detailChildren[0] as HTMLElement).getByTitle('review requested')).toBeTruthy();
  });

  it('labels restored harness records without terminals as restored rather than starting', () => {
    renderModal({
      harnesses: [
        { ...baseHarness, id: 'h-1', name: 'restored task', branch: 'broker/123', lifecycle: 'resume_pending' },
      ],
      selectedId: 'h-1',
      lang: 'ko',
    });

    expect(screen.getAllByText('기록 복구').length).toBeGreaterThan(0);
    expect(screen.queryByText('시작 중...')).toBeNull();
  });

  it('shows restart-restored harnesses as suspended instead of live review wait', () => {
    renderModal({
      harnesses: [
        {
          ...baseHarness,
          id: 'h-1',
          name: 'old review task',
          branch: 'broker/123',
          lifecycle: 'suspended',
          status: { cycle: 'reviewing', cycleLabel: 'Reviewing', reason: 'old review request', grownLoc: 17 },
        },
      ],
      selectedId: 'h-1',
      lang: 'en',
    });

    expect(screen.getAllByText('Suspended').length).toBeGreaterThan(0);
    expect(screen.queryByText('3. Reviewing')).toBeNull();
    expect(screen.queryByText('+17 LOC')).toBeNull();
    expect(screen.queryByText('- old review request')).toBeNull();
    expect(screen.queryByText('Review has been requested. Waiting for APPROVED or REWORK in the review feed.')).toBeNull();
  });

  it('does not count restored records without terminals as running harnesses', () => {
    renderModal({
      harnesses: [
        { ...baseHarness, id: 'h-1', name: 'restored task', branch: 'broker/123', lifecycle: 'resume_pending' },
        { ...baseHarness, id: 'h-2', name: 'reattaching task', branch: 'broker/456', lifecycle: 'reattaching', createdAt: 2 },
        { ...baseHarness, id: 'h-3', name: 'active task', status: { cycle: 'developing', cycleLabel: 'Developing', reason: 'working' }, createdAt: 3 },
      ],
      selectedId: 'h-1',
      lang: 'ko',
    });

    expect(screen.getByText(/1 실행 중 \/ 3 전체/)).toBeTruthy();
  });

  it('switches visible chrome text to Korean when requested', () => {
    renderModal({ lang: 'ko' });

    expect(screen.getByText(/브로커 하네스/)).toBeTruthy();
    expect(screen.getByText(/2 실행 중 \/ 3 전체/)).toBeTruthy();
    const brokerBar = screen.getByText(/브로커 · claude→codex/).closest('.bhm-broker');
    expect(brokerBar).toBeTruthy();
    expect(within(brokerBar as HTMLElement).getByText('개발')).toBeTruthy();
  });

  it('localizes Korean control tooltips instead of leaving broker chrome in English', () => {
    renderModal({ lang: 'ko' });

    expect(screen.getByTitle('하네스 목록 숨기기')).toBeTruthy();
    expect(screen.getByTitle('닫기')).toBeTruthy();
    expect(screen.getAllByTitle('이 프로젝트에서 새 하네스 시작')).toHaveLength(2);
    expect(screen.getAllByTitle('클릭해서 열기 · 두 번 클릭해서 이름 변경')).toHaveLength(3);
    expect(screen.getAllByTitle('이름 변경')).toHaveLength(3);
    expect(screen.getAllByTitle('하네스 중지')).toHaveLength(3);
  });

  it('can hide the harness list so the terminal area gets the full modal width', () => {
    const { container } = renderModal();

    expect(container.querySelector('.bhm-tree')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Hide harness list'));

    expect(container.querySelector('.bhm-tree')).toBeNull();
    expect(screen.getByTitle('Show harness list')).toBeTruthy();
    expect(screen.getByTestId('terminal-area')).toBeTruthy();
  });

  it('can compact the harness window without closing the terminals', () => {
    const { container } = renderModal();
    const modal = container.querySelector('.bhm-modal');

    expect(modal?.classList.contains('bhm-compact')).toBe(false);
    fireEvent.click(screen.getByTitle('Compact view'));

    expect(modal?.classList.contains('bhm-compact')).toBe(true);
    expect(screen.getByTitle('Full view')).toBeTruthy();
    expect(screen.getByTestId('terminal-area')).toBeTruthy();
  });

  it('shows the project harness source map on demand', () => {
    renderModal();

    fireEvent.click(screen.getByTitle('Show harness sources'));

    expect(screen.getByText('Harness source map')).toBeTruthy();
    expect(screen.getByText('Agent Harness')).toBeTruthy();
    expect(screen.getByText('src/harness/')).toBeTruthy();
    expect(screen.getByText('src/devreview/devReviewPair.ts')).toBeTruthy();
  });

  it('can keep a harness window open when the backdrop is clicked', () => {
    const onClose = vi.fn();
    const { container } = renderModal({ closeOnBackdrop: false, onClose });

    fireEvent.click(container.querySelector('.bhm-overlay') as HTMLElement);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('terminal-area')).toBeTruthy();
  });

  it('keeps the broker log pinned to the latest event', () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 777,
    });
    try {
      const harness = {
        ...baseHarness,
        id: 'h-1',
        name: 'active task',
        status: { cycle: 'developing', cycleLabel: 'Developing', reason: 'first' },
        log: [{ kind: 'info', message: 'first event' }],
      } satisfies BrokerHarness;
      const props = {
        open: true,
        harnesses: [harness],
        projects: [{ id: 'p-1', name: 'Project One' }],
        selectedId: 'h-1',
        terminalArea: <div data-testid="terminal-area">terminals</div>,
        lang: 'en' as const,
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onStopHarness: vi.fn(),
        onCreateHarness: vi.fn(),
        onRename: vi.fn(),
      };
      const { container, rerender } = render(<BrokerHarnessModal {...props} />);
      const log = container.querySelector('.bhm-broker-log') as HTMLElement;
      log.scrollTop = 0;

      rerender(
        <BrokerHarnessModal
          {...props}
          harnesses={[{
            ...harness,
            status: { ...harness.status, reason: 'second' },
            log: [...(harness.log || []), { kind: 'info', message: 'second event' }],
          }]}
        />,
      );

      expect((container.querySelector('.bhm-broker-log') as HTMLElement).scrollTop).toBe(777);
    } finally {
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
      else delete (HTMLElement.prototype as unknown as { scrollHeight?: number }).scrollHeight;
    }
  });
});
