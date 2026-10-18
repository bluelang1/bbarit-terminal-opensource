import { describe, expect, it } from 'vitest';
import {
  deriveBrokerHarnessName,
  lifecycleFromBrokerStatus,
  normalizeBrokerSessionRecords,
  selectPreferredBrokerHarnessId,
  selectRestorableBrokerSessions,
  statusAfterDeveloperCommand,
} from './brokerSessionStore';

describe('brokerSessionStore', () => {
  it('keeps only the latest record for each harness id', () => {
    const sessions = normalizeBrokerSessionRecords([
      { harnessId: 'h-1', projectId: 'p-1', developerId: 'dev-old', reviewerId: 'rev-old', createdAt: 1, log: Array.from({ length: 205 }, (_, i) => ({ kind: 'info', message: String(i) })) },
      { harnessId: 'h-2', projectId: 'p-1', developerId: 'dev-2', reviewerId: 'rev-2', createdAt: 2 },
      { harnessId: 'h-1', projectId: 'p-1', developerId: 'dev-new', reviewerId: 'rev-new', createdAt: 3, name: 'latest' },
      { projectId: 'missing-id' },
      null,
    ]);

    expect(sessions.map((s) => s.harnessId)).toEqual(['h-2', 'h-1']);
    expect(sessions.find((s) => s.harnessId === 'h-1')?.developerId).toBe('dev-new');
    expect(sessions.find((s) => s.harnessId === 'h-1')?.name).toBe('latest');
  });

  it('does not let an older duplicate broker session overwrite a newer one', () => {
    const sessions = normalizeBrokerSessionRecords([
      { harnessId: 'h-1', projectId: 'p-1', developerId: 'dev-new', reviewerId: 'rev-new', createdAt: 10, name: 'newer' },
      { harnessId: 'h-1', projectId: 'p-1', developerId: 'dev-old', reviewerId: 'rev-old', createdAt: 1, name: 'older stale write' },
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      harnessId: 'h-1',
      developerId: 'dev-new',
      reviewerId: 'rev-new',
      name: 'newer',
      createdAt: 10,
    });
  });

  it('normalizes restored strings and drops invalid agent roles', () => {
    const sessions = normalizeBrokerSessionRecords([
      {
        harnessId: ' h-1 ',
        projectId: ' p-1 ',
        developerId: ' dev-1 ',
        reviewerId: ' rev-1 ',
        developer: 'claude',
        reviewer: 'unknown',
        branch: ' broker/123 ',
        worktreeDir: ' C:/tmp/worktree ',
        repoDir: ' C:/repo ',
        name: ' Last prompt ',
        manualName: 'false',
        lastPrompt: ' Build the harness ',
      },
      {
        harnessId: 'h-2',
        projectId: 'p-1',
        developerId: 'dev-2',
        reviewerId: 'rev-2',
        developer: 'gajae',
        reviewer: 'ollama',
        manualName: true,
      },
    ]);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      harnessId: 'h-1',
      projectId: 'p-1',
      developerId: 'dev-1',
      reviewerId: 'rev-1',
      developer: 'claude',
      reviewer: undefined,
      branch: 'broker/123',
      worktreeDir: 'C:/tmp/worktree',
      repoDir: 'C:/repo',
      name: 'Last prompt',
      manualName: false,
      lastPrompt: 'Build the harness',
    });
    expect(sessions[1].manualName).toBe(true);
    expect(sessions[1].developer).toBe('gajae');
    expect(sessions[1].reviewer).toBeUndefined();
  });

  it('preserves valid broker status snapshots across session normalization', () => {
    const sessions = normalizeBrokerSessionRecords([
      {
        harnessId: 'h-1',
        projectId: 'p-1',
        developerId: 'dev-1',
        reviewerId: 'rev-1',
        status: {
          cycle: 'merging',
          cycleLabel: 'Auto merging',
          reason: 'reviewer approved',
          directionOk: false,
          grownLoc: 42,
          action: 'review',
        },
      },
    ]);

    expect(sessions[0].status).toEqual({
      cycle: 'merging',
      cycleLabel: 'Auto merging',
      reason: 'reviewer approved',
      directionOk: false,
      grownLoc: 42,
      action: 'review',
    });
  });

  it('drops invalid persisted status snapshots instead of restoring unknown cycles', () => {
    const sessions = normalizeBrokerSessionRecords([
      {
        harnessId: 'h-1',
        projectId: 'p-1',
        developerId: 'dev-1',
        reviewerId: 'rev-1',
        status: {
          cycle: 'stuck',
          cycleLabel: 'Stuck',
          reason: 'bad persisted data',
        },
      },
    ]);

    expect(sessions[0].status).toBeUndefined();
  });

  it('sanitizes persisted broker logs before restoring them into the UI', () => {
    const sessions = normalizeBrokerSessionRecords([
      {
        harnessId: 'h-1',
        projectId: 'p-1',
        developerId: 'dev-1',
        reviewerId: 'rev-1',
        log: [
          null,
          'legacy text',
          { kind: 'info', message: 'kept' },
          { kind: ' relay ', message: '  also kept  ' },
          { kind: 123, message: 'fallback kind' },
          { kind: 'error', message: '' },
          { kind: 'info', message: 42 },
        ],
      },
    ]);

    expect(sessions[0].log).toEqual([
      { kind: 'info', message: 'kept' },
      { kind: 'relay', message: 'also kept' },
      { kind: 'info', message: 'fallback kind' },
    ]);
  });

  it('filters deleted, incomplete, unmanaged, and orphaned sessions before restore', () => {
    const restorable = selectRestorableBrokerSessions(
      [
        { harnessId: 'deleted', projectId: 'p-1', developerId: 'dev', reviewerId: 'rev', branch: 'broker/deleted', worktreeDir: '/repo/.octo-tmp/deleted', repoDir: '/repo' },
        { harnessId: 'missing-term', projectId: 'p-1', developerId: 'dev', branch: 'broker/missing-term', worktreeDir: '/repo/.octo-tmp/missing-term', repoDir: '/repo' },
        { harnessId: 'missing-managed-branch', projectId: 'p-1', developerId: 'dev', reviewerId: 'rev', worktreeDir: '/repo/.octo-tmp/missing-managed-branch', repoDir: '/repo' },
        { harnessId: 'missing-managed-worktree', projectId: 'p-1', developerId: 'dev', reviewerId: 'rev', branch: 'broker/missing-managed-worktree', repoDir: '/repo' },
        { harnessId: 'missing-project', projectId: 'p-x', developerId: 'dev', reviewerId: 'rev', branch: 'broker/missing-project', worktreeDir: '/repo/.octo-tmp/missing-project', repoDir: '/repo' },
        { harnessId: 'ok', projectId: 'p-1', developerId: 'dev-ok', reviewerId: 'rev-ok', branch: 'broker/ok', worktreeDir: '/repo/.octo-tmp/ok', repoDir: '/repo' },
        { harnessId: 'legacy-no-repo', projectId: 'p-1', developerId: 'dev-legacy', reviewerId: 'rev-legacy', branch: 'broker/legacy', worktreeDir: '/repo/.octo-tmp/legacy' },
      ],
      new Set(['deleted']),
      (projectId) => projectId === 'p-1',
    );

    expect(restorable.map((session) => session.harnessId)).toEqual(['ok', 'legacy-no-repo']);
  });

  it('does not restore stale readiness blocks from the old fail-closed startup guard', () => {
    const restorable = selectRestorableBrokerSessions(
      [
        {
          harnessId: 'old-readiness-block',
          projectId: 'p-1',
          developerId: 'dev',
          reviewerId: 'rev',
          branch: 'broker/old-readiness-block',
          worktreeDir: '/repo/.octo-tmp/old-readiness-block',
          repoDir: '/repo',
          status: {
            cycle: 'merge_failed',
            cycleLabel: 'Merge failed',
            reason: 'Dev-agent CLI readiness was not confirmed. Broker will not inject briefing text into a raw shell.',
          },
        },
        {
          harnessId: 'real-block',
          projectId: 'p-1',
          developerId: 'dev',
          reviewerId: 'rev',
          branch: 'broker/real-block',
          worktreeDir: '/repo/.octo-tmp/real-block',
          repoDir: '/repo',
          status: {
            cycle: 'merge_failed',
            cycleLabel: 'Merge failed',
            reason: 'auto merge failed - dirty target checkout',
          },
        },
      ],
      new Set(),
      (projectId) => projectId === 'p-1',
    );

    expect(restorable.map((session) => session.harnessId)).toEqual(['real-block']);
  });

  it('moves a completed harness back to developing when the user starts new work', () => {
    expect(statusAfterDeveloperCommand(
      { cycle: 'merged', cycleLabel: 'Merged', reason: 'done', directionOk: true, grownLoc: 12 },
      'en',
    )).toEqual({
      cycle: 'developing',
      cycleLabel: 'Follow-up build',
      reason: 'New work detected in a completed harness.',
      action: 'follow-up',
      directionOk: true,
      grownLoc: 12,
    });

    expect(statusAfterDeveloperCommand(
      { cycle: 'merged', cycleLabel: '병합됨', reason: '완료', directionOk: true, grownLoc: 12 },
      'ko',
    )).toEqual({
      cycle: 'developing',
      cycleLabel: '후속 작업',
      reason: '완료된 하네스에서 새 작업 입력을 감지했습니다.',
      action: '후속 작업',
      directionOk: true,
      grownLoc: 12,
    });

    expect(statusAfterDeveloperCommand(
      { cycle: 'merge_failed', cycleLabel: 'Merge failed', reason: 'needs human' },
      'ko',
    )?.cycle).toBe('merge_failed');
  });

  it('derives restored harness titles from manual names, then last prompts, then fallback text', () => {
    expect(deriveBrokerHarnessName(
      { manualName: true, name: 'Pinned title', lastPrompt: 'new prompt should not overwrite' },
      'fallback',
    )).toBe('Pinned title');

    expect(deriveBrokerHarnessName(
      { manualName: false, name: 'Old automatic title', lastPrompt: '  implement broker restore and verify persistence  ' },
      'fallback',
    )).toBe('implement broker restore and verify persistence');

    expect(deriveBrokerHarnessName(
      { manualName: false },
      'Project - claude->codex',
    )).toBe('Project - claude->codex');
  });

  it('restores the last selected harness, or the newest harness when the saved selection is gone', () => {
    const sessions = [
      { harnessId: 'oldest', createdAt: 1 },
      { harnessId: 'newest', createdAt: 30 },
      { harnessId: 'middle', createdAt: 10 },
    ];

    expect(selectPreferredBrokerHarnessId(sessions, 'middle')).toBe('middle');
    expect(selectPreferredBrokerHarnessId(sessions, 'deleted')).toBe('newest');
    expect(selectPreferredBrokerHarnessId(sessions, '')).toBe('newest');
    expect(selectPreferredBrokerHarnessId([], 'missing')).toBeNull();
  });

  it('derives harness lifecycle from broker status', () => {
    expect(lifecycleFromBrokerStatus({ cycle: 'merged', cycleLabel: 'Merged', reason: '' })).toBe('complete');
    expect(lifecycleFromBrokerStatus({ cycle: 'merge_failed', cycleLabel: 'Failed', reason: '' })).toBe('blocked');
    expect(lifecycleFromBrokerStatus({ cycle: 'reviewing', cycleLabel: 'Review', reason: '' }, 'resume_pending')).toBe('resume_pending');
  });

  it('normalizes lifecycle and heartbeat metadata', () => {
    const [session] = normalizeBrokerSessionRecords([
      {
        harnessId: 'h1',
        projectId: 'p1',
        developerId: 'd1',
        reviewerId: 'r1',
        branch: 'broker/123',
        worktreeDir: 'C:/tmp/wt',
        lifecycle: 'reattaching',
        lastHeartbeatAt: 100,
        lastAttachedAt: 90,
        restoreFailureCount: 2.9,
      },
    ]);

    expect(session.lifecycle).toBe('reattaching');
    expect(session.lastHeartbeatAt).toBe(100);
    expect(session.lastAttachedAt).toBe(90);
    expect(session.restoreFailureCount).toBe(2);
  });

  it('restores suspended records but still hides explicitly deleted harness records', () => {
    const sessions = [
      {
        harnessId: 'active',
        projectId: 'p1',
        developerId: 'd1',
        reviewerId: 'r1',
        branch: 'broker/active',
        worktreeDir: 'C:/tmp/active',
        lifecycle: 'resume_pending',
      },
      {
        harnessId: 'suspended',
        projectId: 'p1',
        developerId: 'd2',
        reviewerId: 'r2',
        branch: 'broker/suspended',
        worktreeDir: 'C:/tmp/suspended',
        lifecycle: 'suspended',
      },
      {
        harnessId: 'deleted',
        projectId: 'p1',
        developerId: 'd3',
        reviewerId: 'r3',
        branch: 'broker/deleted',
        worktreeDir: 'C:/tmp/deleted',
      },
    ];

    const restored = selectRestorableBrokerSessions(sessions, new Set(['deleted']), (projectId) => projectId === 'p1');
    expect(restored.map((session) => session.harnessId)).toEqual(['active', 'suspended']);
  });
});
