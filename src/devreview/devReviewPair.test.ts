import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

const isActualReviewRequestWrite = (write: Record<string, unknown>) => (
  /\[BROKER\]\s+Review requested:/.test(String(write.data || ''))
);

import {
  BROKER_AGENT_ROLES,
  buildReviewPatch,
  ensureApplyCleanPatch,
  upgradeBrokerGitignore,
  isHarnessInReviewLoop,
  classifyDoneSignalReview,
  extractBrokerReviewedDiff,
  isPrematureReviewerFeedback,
  latestDoneLineStart,
  normalizeBrokerAgentRole,
  nextCycleForWorkingWithoutDone,
  parseNumstatManifest,
  parsePathRules,
  selectActiveRules,
  relaySignature,
  reviewDecisionFromText,
  shouldResendReviewerStandby,
  shouldAcceptBrokerStatusUpdate,
  shouldReopenMergedCycleForDone,
  startDevReviewPair,
  syncHarnessGoalWithWiki,
  trimFeedForArchive,
  workflowBriefing,
} from './devReviewPair';

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue('');
});

async function waitForEvent(events: Array<{ message?: string }>, pattern: RegExp): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const found = events.find((event) => pattern.test(event.message || ''))?.message;
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`event not found: ${pattern}`);
}

describe('broker agent role selection', () => {
  it('keeps selectable roles limited to repairable autonomous CLI agents', () => {
    expect(BROKER_AGENT_ROLES).toEqual([
      'claude',
      'codex',
      'gemini',
      'kimi',
      'qwen',
      'cursor',
      'opencode',
      'pi',
      'reasonix',
      'gajae',
    ]);
    expect(normalizeBrokerAgentRole('ollama', 'claude')).toBe('claude');
    expect(normalizeBrokerAgentRole('gajae', 'claude')).toBe('gajae');
    expect(normalizeBrokerAgentRole('unknown', 'codex')).toBe('codex');
  });
});

describe('harness standing goal wiki sync', () => {
  it('writes an explicit harness goal to docs/wiki/standing-goal.md', async () => {
    const goal = await syncHarnessGoalWithWiki({
      goal: '  ship the settings polish  ',
      workDir: '/repo/app',
      projectName: 'App',
    });

    expect(goal).toBe('ship the settings polish');
    expect(invokeMock).toHaveBeenCalledWith('write_file', {
      path: '/repo/app/docs/wiki/standing-goal.md',
      content: 'ship the settings polish\n',
    });
  });

  it('uses docs/wiki/standing-goal.md when the harness starts without an explicit goal', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_file' && String(args?.path || '').endsWith('/docs/wiki/standing-goal.md')) {
        return 'wiki-backed harness goal\n';
      }
      return '';
    });

    const goal = await syncHarnessGoalWithWiki({
      goal: '   ',
      workDir: '/repo/app',
      projectName: 'App',
    });

    expect(goal).toBe('wiki-backed harness goal');
    expect(invokeMock).not.toHaveBeenCalledWith('write_file', {
      path: '/repo/app/docs/wiki/standing-goal.md',
      content: expect.any(String),
    });
  });
});

describe('upgradeBrokerGitignore — legacy broad pattern must be actively removed', () => {
  const BROAD = 'docs/wiki/decisions/broker-harness-*.md';
  const NARROW = 'docs/wiki/decisions/broker-harness-[0-9]*.md';
  const STATUS = 'docs/wiki/decisions/broker-status.md';
  // fnmatch-style check for the exact concern: does any kept ignore LINE match the durable
  // source-audit note? The legacy broad line matches it; the narrow [0-9] line does not.
  const DURABLE = 'docs/wiki/decisions/broker-harness-source-audit-2026-06-25.md';
  const lineMatches = (pattern: string, path: string): boolean => {
    const rx = new RegExp('^' + pattern
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replace(/\[0-9\]/g, '[0-9]')
      .replace(/\*/g, '[^/]*') + '$');
    return rx.test(path);
  };

  it('removes the legacy broad broker-harness-*.md line even when a repo already has it', () => {
    // A repo that received the OLD block: broad line present, no narrow / no status.
    const legacy = [
      'node_modules/',
      '',
      '# Broker Agent transient coordination files',
      'docs/wiki/decisions/broker-brief-*.md',
      BROAD,
      'docs/wiki/decisions/broker-*-feed.md',
      '',
    ].join('\n');
    const out = upgradeBrokerGitignore(legacy);
    const outLines = out.split('\n').map((l) => l.trim());
    // The broad line is GONE (not merely superseded)...
    expect(outLines).not.toContain(BROAD);
    // ...and the narrow + status lines are present.
    expect(outLines).toContain(NARROW);
    expect(outLines).toContain(STATUS);
    // The durable source-audit note is no longer matched by ANY surviving ignore line.
    const matchedBy = outLines.filter((l) => l && !l.startsWith('#') && lineMatches(l, DURABLE));
    expect(matchedBy).toEqual([]);
    // The transient timestamped harness log IS still matched (by the narrow line).
    expect(out.split('\n').some((l) => lineMatches(l.trim(), 'docs/wiki/decisions/broker-harness-2026-06-24T17-38-54-648Z.md'))).toBe(true);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const once = upgradeBrokerGitignore('node_modules/\n');
    const twice = upgradeBrokerGitignore(once);
    expect(twice).toBe(once);
  });

  it('returns the input unchanged when already correct (no legacy line, all required present)', () => {
    const already = upgradeBrokerGitignore('');
    // already-upgraded content fed back in is a no-op
    expect(upgradeBrokerGitignore(already)).toBe(already);
    expect(already.split('\n').map((l) => l.trim())).not.toContain(BROAD);
  });

  it('seeds a fresh .gitignore with the full broker block', () => {
    const out = upgradeBrokerGitignore('');
    const outLines = out.split('\n').map((l) => l.trim());
    for (const required of [NARROW, STATUS, 'docs/wiki/decisions/broker-brief-*.md', 'docs/wiki/decisions/broker-*-feed.md', '.broker/']) {
      expect(outLines).toContain(required);
    }
    expect(outLines).not.toContain(BROAD);
  });
});

describe('isHarnessInReviewLoop — guards the manual controls (incl. Restart agents teardown)', () => {
  it('is true only in the live dev↔review loop', () => {
    for (const cycle of ['developing', 'dev_done', 'reviewing', 'review_done', 'addressing']) {
      expect(isHarnessInReviewLoop(cycle, undefined)).toBe(true);
    }
  });

  it('is false during the one-way merge phase (so Restart cannot tear down agents mid-merge)', () => {
    for (const cycle of ['approved', 'merging', 'merged', 'merge_failed']) {
      expect(isHarnessInReviewLoop(cycle, undefined)).toBe(false);
    }
  });

  it('is false for a resting harness regardless of cycle', () => {
    for (const lifecycle of ['complete', 'blocked', 'suspended']) {
      expect(isHarnessInReviewLoop('reviewing', lifecycle)).toBe(false);
    }
  });

  it('handles missing cycle/lifecycle as in-loop (default-allow only when nothing says otherwise)', () => {
    expect(isHarnessInReviewLoop(undefined, undefined)).toBe(true);
    expect(isHarnessInReviewLoop(null, null)).toBe(true);
  });
});

describe('buildReviewPatch — patch file must be apply-clean', () => {
  // computeDiff()/gitWorkingDiff() return a `.trim()`-ed diff (no trailing newline). A
  // unified diff written for `git apply` MUST end with a newline or git reports
  // "corrupt patch at line N" on the final hunk — which blocked the reviewer from
  // applying/verifying the patch. buildReviewPatch guarantees the terminating newline.
  const header = '# review - developer DONE - x';
  const manifest = '## Changed files (1)\n- a.ts (+1 -0)\n\n';
  // A realistic trimmed unified diff: ends WITHOUT a trailing newline.
  const trimmedDiff = [
    'diff --git a/a.ts b/a.ts',
    'index 111..222 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1 +1,2 @@',
    ' const a = 1;',
    '+const b = 2;',
  ].join('\n');

  it('appends a trailing newline when the diff lacks one', () => {
    expect(trimmedDiff.endsWith('\n')).toBe(false);
    const patch = buildReviewPatch(header, manifest, trimmedDiff);
    expect(patch.endsWith('\n')).toBe(true);
    // The diff body is preserved verbatim (only a terminating newline is added).
    expect(patch).toContain(trimmedDiff);
    expect(patch).toBe(`${header}\n\n${manifest}${trimmedDiff}\n`);
  });

  it('does not double a newline when the diff already ends with one', () => {
    const patch = buildReviewPatch(header, manifest, `${trimmedDiff}\n`);
    expect(patch.endsWith('\n')).toBe(true);
    expect(patch.endsWith('\n\n')).toBe(false);
  });
});

describe('ensureApplyCleanPatch — single-newline guard (shared by build + verify-after-write)', () => {
  it('정상: appends exactly one terminating newline to a newline-less patch', () => {
    expect(ensureApplyCleanPatch('diff body ending in code.')).toBe('diff body ending in code.\n');
  });
  it('매핑: leaves an already-terminated patch unchanged (no double newline)', () => {
    expect(ensureApplyCleanPatch('already terminated\n')).toBe('already terminated\n');
  });
  it('None: empty / null / undefined collapse to a single newline (never a bare empty file)', () => {
    expect(ensureApplyCleanPatch('')).toBe('\n');
    // @ts-expect-error runtime guard for null
    expect(ensureApplyCleanPatch(null)).toBe('\n');
    // @ts-expect-error runtime guard for undefined
    expect(ensureApplyCleanPatch(undefined)).toBe('\n');
  });
  it('변조: a patch whose final line is the truncated context line (the live-broker bug) is repaired', () => {
    const corrupt = '@@ -1 +1,2 @@\n const a = 1;\n // Periodic feed rotation...giant doc.';
    expect(corrupt.endsWith('\n')).toBe(false);
    expect(ensureApplyCleanPatch(corrupt).endsWith('\n')).toBe(true);
    expect(ensureApplyCleanPatch(corrupt)).toBe(`${corrupt}\n`);
  });
});

describe('path-conditional rules (P3-2)', () => {
  const RULES = [
    '# Design rules',
    '',
    '## Always check error handling',
    'Every change must handle errors.',
    '',
    '## Frontend a11y',
    'paths: src/**/*.tsx, src/**/*.css',
    'Components need aria labels.',
    '',
    '## Rust safety',
    'paths: src-tauri/**/*.rs',
    'No unwrap on external input.',
  ].join('\n');

  it('정상: parses rule titles and their paths globs', () => {
    const rules = parsePathRules(RULES);
    const a11y = rules.find((r) => r.title === 'Frontend a11y');
    const rust = rules.find((r) => r.title === 'Rust safety');
    const always = rules.find((r) => r.title === 'Always check error handling');
    expect(a11y?.paths).toEqual(['src/**/*.tsx', 'src/**/*.css']);
    expect(rust?.paths).toEqual(['src-tauri/**/*.rs']);
    expect(always?.paths).toEqual([]); // unconditional
  });
  it('매핑: selects only rules whose globs match the changed files (+ unconditional)', () => {
    const rules = parsePathRules(RULES);
    const active = selectActiveRules(rules, ['src/components/Foo.tsx']).map((r) => r.title);
    expect(active).toContain('Always check error handling'); // unconditional always on
    expect(active).toContain('Frontend a11y');               // matches src/**/*.tsx
    expect(active).not.toContain('Rust safety');             // no .rs changed
  });
  it('None: empty rules / empty changed paths', () => {
    expect(parsePathRules('')).toEqual([]);
    // when nothing changed, only UNCONDITIONAL rules (no paths:) are active; the
    // path-scoped ones drop out. (The H1 header parses as an unconditional rule too.)
    const active = selectActiveRules(parsePathRules(RULES), []).map((r) => r.title);
    expect(active).toEqual(['Design rules', 'Always check error handling']);
    expect(active).not.toContain('Frontend a11y');
    expect(active).not.toContain('Rust safety');
  });
  it('변조: backslash paths normalized; ** spans segments; non-match excluded', () => {
    const rules = parsePathRules(RULES);
    const active = selectActiveRules(rules, ['src-tauri\\src\\main.rs', 'docs/readme.md']).map((r) => r.title);
    expect(active).toContain('Rust safety');       // backslashes normalized + ** match
    expect(active).not.toContain('Frontend a11y'); // no tsx/css
  });
});

describe('parseNumstatManifest (P2-5 structured diff)', () => {
  it('정상: parses adds/dels/path into manifest rows', () => {
    const r = parseNumstatManifest('3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts');
    expect(r.count).toBe(2);
    expect(r.rows[0]).toBe('- src/a.ts (+3 -1)');
    expect(r.rows[1]).toBe('- src/b.ts (+10 -0)');
  });
  it('매핑: binary files (numstat "-") are flagged and excluded', () => {
    const r = parseNumstatManifest('-\t-\tassets/logo.png\n2\t2\tsrc/c.ts');
    expect(r.count).toBe(2);
    expect(r.rows[0]).toContain('assets/logo.png');
    expect(r.rows[0]).toContain('binary');
    expect(r.rows[1]).toBe('- src/c.ts (+2 -2)');
  });
  it('None: empty/whitespace input yields no rows', () => {
    expect(parseNumstatManifest('').count).toBe(0);
    expect(parseNumstatManifest('   \n  ').count).toBe(0);
    // @ts-expect-error runtime guard
    expect(parseNumstatManifest(null).count).toBe(0);
  });
  it('변조: malformed lines (no tabs / partial) are skipped, paths with spaces kept', () => {
    const r = parseNumstatManifest('garbage line\n5\t2\tsrc/has space.ts\nalso bad');
    expect(r.count).toBe(1);
    expect(r.rows[0]).toBe('- src/has space.ts (+5 -2)');
  });
});

describe('relaySignature (P1-4 loop detection)', () => {
  it('정상: identical bodies (whitespace/case noise) produce the same signature', () => {
    const a = relaySignature('rev', 'rework', 'Fix the   NULL  check\nin parser');
    const b = relaySignature('rev', 'rework', 'fix the null check in parser');
    expect(a).toBe(b);
  });
  it('매핑: different role/decision/body produce different signatures', () => {
    expect(relaySignature('rev', 'rework', 'x')).not.toBe(relaySignature('dev', 'rework', 'x'));
    expect(relaySignature('rev', 'rework', 'x')).not.toBe(relaySignature('rev', 'approved', 'x'));
    expect(relaySignature('rev', 'rework', 'a')).not.toBe(relaySignature('rev', 'rework', 'b'));
  });
  it('None: empty/undefined body is stable and keyed by role|decision', () => {
    expect(relaySignature('rev', 'rework', '')).toBe('rev|rework|');
    // @ts-expect-error runtime guard for null body
    expect(relaySignature('dev', 'rework', null)).toBe('dev|rework|');
  });
  it('변조: very long bodies are bounded to 2000 chars so near-identical reworks still match', () => {
    const big = 'z'.repeat(5000);
    expect(relaySignature('rev', 'rework', big)).toBe(relaySignature('rev', 'rework', big + 'tail-differs'));
  });
});

describe('shouldResendReviewerStandby — standby delivery backstop', () => {
  const base = {
    hasChild: true,
    idleMs: 1500,
    sends: 1,
    maxSends: 2,
    msSinceLast: 6000,
    rebriefGapMs: 6000,
    stopped: false,
  };
  it('정상: re-sends once when the CLI is up + settled, one prior send, and the gap elapsed', () => {
    expect(shouldResendReviewerStandby(base)).toBe(true);
  });
  it('매핑: a higher idle / longer elapsed gap still re-sends', () => {
    expect(shouldResendReviewerStandby({ ...base, idleMs: 9000, msSinceLast: 30000 })).toBe(true);
  });
  it('None: never re-sends before the first send (sends === 0; ordinary path owns that)', () => {
    expect(shouldResendReviewerStandby({ ...base, sends: 0 })).toBe(false);
  });
  it('None: stops at the send cap so it can never spam', () => {
    expect(shouldResendReviewerStandby({ ...base, sends: 2 })).toBe(false);
    expect(shouldResendReviewerStandby({ ...base, sends: 5 })).toBe(false);
  });
  it('변조: a dead/booting CLI (no child) or unsettled PTY never gets the backstop', () => {
    expect(shouldResendReviewerStandby({ ...base, hasChild: false })).toBe(false);
    expect(shouldResendReviewerStandby({ ...base, idleMs: 1499 })).toBe(false);
    expect(shouldResendReviewerStandby({ ...base, idleMs: 0 })).toBe(false);
  });
  it('변조: respects spacing — does not re-send before the rebrief gap elapses', () => {
    expect(shouldResendReviewerStandby({ ...base, msSinceLast: 5999 })).toBe(false);
    expect(shouldResendReviewerStandby({ ...base, msSinceLast: 0 })).toBe(false);
  });
  it('변조: a stopped harness never re-sends', () => {
    expect(shouldResendReviewerStandby({ ...base, stopped: true })).toBe(false);
  });
});

describe('devReviewPair reviewer feedback routing', () => {
  it('parses approved review notes that explicitly say there is no rework', () => {
    expect(reviewDecisionFromText('APPROVED - no REWORK remains')).toBe('approved');
    expect(reviewDecisionFromText('REWORK none. APPROVED')).toBe('approved');
    expect(reviewDecisionFromText('REWORK is not required. APPROVED')).toBe('approved');
    expect(reviewDecisionFromText('APPROVED - no further REWORK requested')).toBe('approved');
    expect(reviewDecisionFromText('No recurring findings; no REWORK.')).toBeNull();
  });

  it('does not auto-approve negated approval language', () => {
    expect(reviewDecisionFromText('Not APPROVED yet - still checking tests')).toBeNull();
    expect(reviewDecisionFromText('APPROVED: no, the merge is not ready')).toBeNull();
    expect(reviewDecisionFromText('APPROVED? no, tests are still failing')).toBeNull();
    expect(reviewDecisionFromText('LGTM? no, the diff is stale')).toBeNull();
    expect(reviewDecisionFromText('LGTM: false until the restore bug is fixed')).toBeNull();
    expect(reviewDecisionFromText('Do not ship it yet')).toBeNull();
    expect(reviewDecisionFromText('Not APPROVED yet\nAPPROVED after the follow-up fix')).toBe('approved');
  });

  it('treats explicit rework directives as mandatory and lets the latest decision win', () => {
    expect(reviewDecisionFromText('REWORK: fix the broken persistence test')).toBe('rework');
    expect(reviewDecisionFromText('APPROVED\nREWORK: restore missing branch handling')).toBe('rework');
    expect(reviewDecisionFromText('REWORK: add coverage\nAPPROVED')).toBe('approved');
    expect(reviewDecisionFromText('LGTM, ship it')).toBe('approved');
  });

  it('treats common review-requested-change wording as mandatory rework', () => {
    expect(reviewDecisionFromText('CHANGES REQUESTED: restore missing branch handling')).toBe('rework');
    expect(reviewDecisionFromText('Request changes - add the restart regression test')).toBe('rework');
    expect(reviewDecisionFromText('Needs changes before approval: the diff is stale')).toBe('rework');
    expect(reviewDecisionFromText('Fixes required before merge')).toBe('rework');
    expect(reviewDecisionFromText('Not ready to ship: restore path is broken')).toBe('rework');
    expect(reviewDecisionFromText('No changes requested. APPROVED')).toBe('approved');
  });

  it('ignores reviewer feedback before the developer has submitted DONE', () => {
    expect(isPrematureReviewerFeedback({
      pendingRevSince: 0,
      reviewedOnce: false,
      cycle: 'developing',
    })).toBe(true);
  });

  it('accepts reviewer feedback after a broker review request is pending', () => {
    expect(isPrematureReviewerFeedback({
      pendingRevSince: Date.now(),
      reviewedOnce: false,
      cycle: 'reviewing',
    })).toBe(false);
  });

  it('accepts later reviewer feedback after at least one real review cycle', () => {
    expect(isPrematureReviewerFeedback({
      pendingRevSince: 0,
      reviewedOnce: true,
      cycle: 'addressing',
    })).toBe(false);
  });
});

describe('devReviewPair role briefings', () => {
  it('keeps the developer brief close to normal development instead of a broker ceremony', () => {
    const brief = workflowBriefing('developer', 'codex', 'claude', 'codex', 'build the feature');
    expect(brief).toContain('Work like a normal developer');
    expect(brief).toContain('Do not wait for a broker-specific planning ceremony before coding');
    expect(brief).toContain('record durable project knowledge in docs/wiki');
    expect(brief).toContain('append DONE: <what you finished>');
    expect(brief).toContain('CRITICAL DONE RULE');
    expect(brief).toContain('Saying "complete", "ready", or "done" only in chat is not enough');
    expect(brief).toContain('the broker will not move forward from chat text');
    expect(brief).not.toContain('First propose approach, design, success criteria, and rules before coding');
  });

  it('keeps the reviewer review-only and source-editing boundaries explicit', () => {
    const brief = workflowBriefing('reviewer', 'claude', 'claude', 'codex', 'build the feature');
    expect(brief).toContain('You are review-only');
    expect(brief).toContain('never edit product source, tests, config, manifests, or build files');
    expect(brief).toContain('TECHNICAL REVIEW STANDARD');
    expect(brief).toContain('regression risk');
    expect(brief).toContain('security/privacy');
    expect(brief).toContain('APPROVED: <brief evidence checked, including BBARIT Browser evidence for web-facing changes>');
    expect(brief).toContain('REWORK: <exact technical fixes>');
    expect(brief).toContain('Wait silently until the broker sends an explicit "Review requested" message');
    expect(brief).toContain('Mandatory BBARIT Browser review');
    expect(brief).toContain('FIRST run \'npm run browser:open');
    expect(brief).toContain('full command list in agent-browser-cli/CLI.md');
    expect(brief).toContain('snapshot/DOM selectors, screenshot, console, network/server requests');
    expect(brief).toContain('BBARIT Browser verification is not optional');
    expect(brief).toContain('If a real recurring lesson appears during an actual review');
    expect(brief).toContain('Do not invent learning notes when no durable lesson exists');
    expect(brief).not.toContain('BE ACTIVE');
    expect(brief).not.toContain('missed learning opportunity');
  });

  it('can disable the reviewer step in role briefings', () => {
    const devBrief = workflowBriefing('developer', 'codex', 'claude', 'codex', 'build the feature', undefined, undefined, 'en', false, 'off');
    const revBrief = workflowBriefing('reviewer', 'claude', 'claude', 'codex', 'build the feature', undefined, undefined, 'en', false, 'off');

    expect(devBrief).toContain('Review step is disabled');
    expect(devBrief).toContain('auto-merge pipeline');
    expect(revBrief).toContain('Review step is disabled for this harness');
    expect(revBrief).not.toContain('TECHNICAL REVIEW STANDARD');
  });

  it('puts the selected review intensity into reviewer briefings', () => {
    const brief = workflowBriefing('reviewer', 'claude', 'claude', 'codex', 'build the feature', undefined, undefined, 'en', true, 'very_careful');

    expect(brief).toContain('Review mode: Very careful');
    expect(brief).toContain('Review intensity: VERY CAREFUL');
    expect(brief).toContain('concurrency/race conditions');
  });

  it('can make BBARIT Browser review optional in reviewer briefings', () => {
    const brief = workflowBriefing('reviewer', 'claude', 'claude', 'codex', 'build the feature', undefined, undefined, 'en', true, 'careful', false);

    expect(brief).toContain('Optional BBARIT Browser review');
    expect(brief).toContain('BBARIT Browser verification is optional');
    expect(brief).not.toContain('Mandatory BBARIT Browser review');
    expect(brief).not.toContain('BBARIT Browser verification is not optional');
  });
});

describe('devReviewPair terminal briefing submission', () => {
  it('submits initial developer and reviewer briefing nudges with Enter', async () => {
    vi.useFakeTimers();
    const writes: Array<Record<string, unknown>> = [];
    const events: Array<{ kind: string; message?: string; status?: { cycle?: string; reason?: string } }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') writes.push(args || {});
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'start a new broker harness',
          workDir: '/repo/.octo-tmp/broker-wt-new',
          projectName: 'test-project',
          autoRelay: false,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          managed: {
            branch: 'broker/new',
            worktreeDir: '/repo/.octo-tmp/broker-wt-new',
            repoDir: '/repo',
          },
        },
      );

      await vi.advanceTimersByTimeAsync(12000);

      expect(handle).toBeTruthy();
      expect(events.some((event) => event.kind === 'status' && event.status?.cycle === 'developing' && /waiting for CLI readiness/.test(event.status.reason || ''))).toBe(true);
      expect(events.some((event) => event.kind === 'status' && event.status?.cycle === 'developing' && /waiting for developer DONE/.test(event.status.reason || ''))).toBe(true);
      expect(writes.some((write) => String(write.data || '').includes('This terminal is the REVIEW AGENT'))).toBe(true);
      expect(writes.some((write) => String(write.data || '').includes('Do not read files'))).toBe(true);
      expect(writes.some((write) => String(write.data || '').includes('Read docs/wiki/decisions/broker-brief-reviewer.md'))).toBe(false);
      expect(writes.some((write) => String(write.data || '').includes('This terminal is the DEV AGENT'))).toBe(true);
      // Submission is a bare CR ("\r") — Claude Code treats CRLF as a newline INSERT,
      // not Enter, so the relayed briefing stayed unsubmitted. (committed CR fix)
      expect(writes.filter((write) => write.data === '\r').map((write) => write.terminalId)).toEqual(
        expect.arrayContaining(['rev-term', 'dev-term']),
      );
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the dev agent even when the review agent is not ready yet', async () => {
    vi.useFakeTimers();
    const writes: Array<Record<string, unknown>> = [];
    const events: Array<{ kind: string; message?: string }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') writes.push(args || {});
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'start automatically',
          workDir: '/repo/.octo-tmp/broker-wt-auto',
          projectName: 'test-project',
          autoRelay: false,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          managed: {
            branch: 'broker/auto',
            worktreeDir: '/repo/.octo-tmp/broker-wt-auto',
            repoDir: '/repo',
          },
          waitForTerminalReady: async (_id, role) => role === 'claude',
        },
      );

      await vi.advanceTimersByTimeAsync(12000);

      expect(handle).toBeTruthy();
      expect(writes.some((write) => write.terminalId === 'dev-term' && String(write.data || '').includes('This terminal is the DEV AGENT'))).toBe(true);
      expect(writes.some((write) => write.terminalId === 'rev-term' && String(write.data || '').includes('This terminal is the REVIEW AGENT'))).toBe(false);
      expect(events.some((event) => /Review-agent CLI is not ready yet/.test(event.message || ''))).toBe(true);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends reviewer standby instructions when the review agent becomes ready late', async () => {
    vi.useFakeTimers();
    const writes: Array<Record<string, unknown>> = [];
    const events: Array<{ kind: string; message?: string }> = [];
    let reviewerChecks = 0;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') writes.push(args || {});
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'brief reviewer after late boot',
          workDir: '/repo/.octo-tmp/broker-wt-late-reviewer',
          projectName: 'test-project',
          autoRelay: false,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          managed: {
            branch: 'broker/late-reviewer',
            worktreeDir: '/repo/.octo-tmp/broker-wt-late-reviewer',
            repoDir: '/repo',
          },
          waitForTerminalReady: async (_id, role) => {
            if (role === 'claude') return true;
            reviewerChecks += 1;
            return reviewerChecks >= 2;
          },
        },
      );

      await vi.advanceTimersByTimeAsync(16000);

      expect(handle).toBeTruthy();
      expect(writes.some((write) => write.terminalId === 'dev-term' && String(write.data || '').includes('This terminal is the DEV AGENT'))).toBe(true);
      expect(writes.some((write) => write.terminalId === 'rev-term' && String(write.data || '').includes('This terminal is the REVIEW AGENT'))).toBe(true);
      expect(events.some((event) => /Review agent became ready/.test(event.message || ''))).toBe(true);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('self-heal gates the reviewer standby on isTerminalReady, never briefing into a raw shell', async () => {
    // Regression: on Windows the reviewer codex CLI could fail to launch and sit at a raw
    // PowerShell prompt. The PTY child (PowerShell) is always present, so the old self-heal
    // gate (pty_terminal_has_child + idle) read "ready" and dumped the standby briefing into
    // PowerShell, which parsed it as commands. The fix gates the self-heal on isTerminalReady,
    // the same predicate the waiters use, which refuses a raw shell prompt.
    vi.useFakeTimers();
    const writes: Array<Record<string, unknown>> = [];
    let reviewerUp = false; // the codex CLI has NOT launched yet — terminal is a raw shell
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') writes.push(args || {});
      if (command === 'pty_terminal_has_child') return true; // shell child ALWAYS present (Windows)
      if (command === 'pty_idle_ms') return 5000;            // settled — would pass the legacy gate
      return '';
    });
    const reviewerBriefWrites = () => writes.filter(
      (w) => w.terminalId === 'rev-term' && String(w.data || '').includes('This terminal is the REVIEW AGENT'),
    );

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'never brief a raw shell',
          workDir: '/repo/.octo-tmp/broker-wt-raw-shell',
          projectName: 'test-project',
          autoRelay: true,
          reviewMode: 'normal',
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        () => {},
        {
          managed: {
            branch: 'broker/raw-shell',
            worktreeDir: '/repo/.octo-tmp/broker-wt-raw-shell',
            repoDir: '/repo',
          },
          // The blocking watcher never reports the reviewer ready, so ONLY the relay-loop
          // self-heal can brief it (claude is ready so the dev briefing still proceeds).
          waitForTerminalReady: async (_id, role) => role === 'claude',
          // One-shot gate the self-heal uses: the reviewer is a RAW SHELL (false) until the
          // codex CLI finally launches (reviewerUp). pty_terminal_has_child stays true the
          // whole time — the OLD gate would have briefed into the raw shell immediately.
          isTerminalReady: async (_id, role) => (role === 'codex' ? reviewerUp : true),
        },
      );

      // While the reviewer is still a raw shell, the standby brief must NOT be sent —
      // several relay-loop iterations (~6s each) with hasChild=true and idle=5s.
      await vi.advanceTimersByTimeAsync(30000);
      expect(reviewerBriefWrites().length).toBe(0);

      // The codex CLI comes up: the self-heal now briefs it.
      reviewerUp = true;
      await vi.advanceTimersByTimeAsync(20000);
      expect(reviewerBriefWrites().length).toBeGreaterThanOrEqual(1);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not block developer startup behind a hung review-agent readiness probe', async () => {
    vi.useFakeTimers();
    const writes: Array<Record<string, unknown>> = [];
    const events: Array<{ kind: string; message?: string }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') writes.push(args || {});
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'start developer without waiting for reviewer',
          workDir: '/repo/.octo-tmp/broker-wt-hung-reviewer',
          projectName: 'test-project',
          autoRelay: false,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          managed: {
            branch: 'broker/hung-reviewer',
            worktreeDir: '/repo/.octo-tmp/broker-wt-hung-reviewer',
            repoDir: '/repo',
          },
          waitForTerminalReady: async (_id, role) => (
            role === 'claude'
              ? true
              : new Promise<boolean>(() => {})
          ),
        },
      );

      await vi.advanceTimersByTimeAsync(12000);

      expect(handle).toBeTruthy();
      expect(writes.some((write) => write.terminalId === 'dev-term' && String(write.data || '').includes('This terminal is the DEV AGENT'))).toBe(true);
      expect(writes.some((write) => write.terminalId === 'rev-term' && String(write.data || '').includes('This terminal is the REVIEW AGENT'))).toBe(false);
      expect(events.some((event) => /Review-agent CLI is not ready yet/.test(event.message || ''))).toBe(true);
      handle?.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps waiting instead of marking the harness blocked when the dev agent is still starting', async () => {
    vi.useFakeTimers();
    const events: Array<{ kind: string; message?: string; status?: { cycle?: string; reason?: string } }> = [];
    invokeMock.mockResolvedValue('');

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'start automatically',
          workDir: '/repo/.octo-tmp/broker-wt-dev-missing',
          projectName: 'test-project',
          autoRelay: false,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          managed: {
            branch: 'broker/dev-missing',
            worktreeDir: '/repo/.octo-tmp/broker-wt-dev-missing',
            repoDir: '/repo',
          },
          waitForTerminalReady: async () => false,
        },
      );

      await vi.advanceTimersByTimeAsync(123000);

      expect(handle).toBeTruthy();
      expect(events.some((event) => event.kind === 'status' && event.status?.cycle === 'developing' && /waiting for CLI readiness/.test(event.status.reason || ''))).toBe(true);
      expect(events.some((event) => event.kind === 'status' && event.status?.cycle === 'developing' && /still starting/.test(event.status.reason || ''))).toBe(true);
      expect(events.some((event) => event.kind === 'status' && event.status?.cycle === 'merge_failed' && /CLI readiness/.test(event.status.reason || ''))).toBe(false);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('devReviewPair feed trimming', () => {
  it('leaves small broker feeds unchanged', () => {
    expect(trimFeedForArchive('DONE: one\n', 100, 20)).toEqual({
      archive: '',
      live: 'DONE: one\n',
      removed: 0,
    });
  });

  it('archives old feed content while keeping the live feed on a line boundary', () => {
    const feed = Array.from({ length: 20 }, (_, i) => `line-${String(i).padStart(2, '0')} ${'x'.repeat(8)}`).join('\n') + '\n';
    const trimmed = trimFeedForArchive(feed, 120, 65);
    expect(trimmed.archive + trimmed.live).toBe(feed);
    expect(trimmed.removed).toBe(trimmed.archive.length);
    expect(trimmed.live).toMatch(/^line-\d{2} /);
    expect(trimmed.live).not.toMatch(/^x/);
  });
});

describe('devReviewPair cycle routing while developer is still working', () => {
  it('rejects DONE signals that have no diff instead of routing an empty review', () => {
    expect(classifyDoneSignalReview(false, '', '', false)).toBe('no_done');
    expect(classifyDoneSignalReview(true, '', 'previous reviewed diff', false)).toBe('empty_diff');
    expect(classifyDoneSignalReview(true, '   \n', 'previous reviewed diff', true)).toBe('empty_rework');
  });

  it('distinguishes duplicate reviewed diffs from new reviewable work', () => {
    expect(classifyDoneSignalReview(true, 'diff --git a/x b/x\n+new', 'diff --git a/x b/x\n+new', false)).toBe('duplicate_diff');
    expect(classifyDoneSignalReview(true, 'diff --git a/x b/x\n+new', 'diff --git a/x b/x\n+new', true)).toBe('duplicate_rework');
    expect(classifyDoneSignalReview(true, 'diff --git a/x b/x\n+newer', 'diff --git a/x b/x\n+old', false)).toBe('request_review');
  });

  it('finds the latest DONE line so resume can replay unfinished work', () => {
    expect(latestDoneLineStart('')).toBe(-1);
    expect(latestDoneLineStart('note\nDONE: first\nnote\nDONE: second\n')).toBe(22);
  });

  it('extracts the reviewed git diff from the broker diff handoff file', () => {
    const diff = 'diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;';
    expect(extractBrokerReviewedDiff(`# review - developer DONE\n\n${diff}`)).toBe(diff);
  });

  it('keeps mandatory REWORK visible while the developer edits without a new DONE', () => {
    expect(nextCycleForWorkingWithoutDone('addressing')).toBe('addressing');
  });

  it('does not downgrade active review or closed merge states just because a diff exists', () => {
    expect(nextCycleForWorkingWithoutDone('reviewing')).toBeNull();
    expect(nextCycleForWorkingWithoutDone('approved')).toBeNull();
    expect(nextCycleForWorkingWithoutDone('merged')).toBeNull();
    expect(nextCycleForWorkingWithoutDone('merge_failed')).toBeNull();
  });

  it('returns developing for intermediate non-closed states that need normal working display', () => {
    expect(nextCycleForWorkingWithoutDone('dev_done')).toBe('developing');
    expect(nextCycleForWorkingWithoutDone('review_done')).toBe('developing');
  });
});

describe('devReviewPair persisted status ordering', () => {
  it('does not let stale polling downgrade a merged harness', () => {
    expect(shouldAcceptBrokerStatusUpdate(
      { cycle: 'merged', cycleLabel: 'Merged', reason: 'done' },
      { cycle: 'developing', cycleLabel: 'Developing', reason: 'stale diff' },
    )).toBe(false);
  });

  it('allows a completed harness to reopen only from a fresh developer DONE signal', () => {
    expect(shouldReopenMergedCycleForDone('merged', 'reviewing', 'developer DONE - next task')).toBe(true);
    expect(shouldReopenMergedCycleForDone('merged', 'developing', 'stale diff')).toBe(false);
    expect(shouldReopenMergedCycleForDone('merge_failed', 'reviewing', 'developer DONE - retry')).toBe(false);
  });

  it('keeps user-started follow-up work from being overwritten by a stale merged event', () => {
    expect(shouldAcceptBrokerStatusUpdate(
      { cycle: 'developing', cycleLabel: 'Developing', reason: 'New work detected in a completed harness.' },
      { cycle: 'merged', cycleLabel: 'Merged', reason: 'restored closed state' },
    )).toBe(false);
    expect(shouldAcceptBrokerStatusUpdate(
      { cycle: 'developing', cycleLabel: '작업중', reason: '완료된 하네스에서 새 작업 입력을 감지했습니다.' },
      { cycle: 'merged', cycleLabel: '머지 완료', reason: '복구된 완료 상태' },
    )).toBe(false);
  });

  it('does not let stale polling downgrade a failed merge harness', () => {
    expect(shouldAcceptBrokerStatusUpdate(
      { cycle: 'merge_failed', cycleLabel: 'Merge failed', reason: 'dirty target' },
      { cycle: 'reviewing', cycleLabel: 'Reviewing', reason: 'stale feed' },
    )).toBe(false);
  });

  it('keeps approved and merging states from regressing to earlier work states', () => {
    expect(shouldAcceptBrokerStatusUpdate(
      { cycle: 'merging', cycleLabel: 'Auto merging', reason: 'merge started' },
      { cycle: 'addressing', cycleLabel: 'Addressing rework', reason: 'stale rework' },
    )).toBe(false);
    expect(shouldAcceptBrokerStatusUpdate(
      { cycle: 'approved', cycleLabel: 'Approved', reason: 'queued' },
      { cycle: 'merging', cycleLabel: 'Auto merging', reason: 'started' },
    )).toBe(true);
  });
});

describe('devReviewPair managed worktree retention', () => {
  it('does not request reviewer feedback when DONE has no git diff', async () => {
    vi.useFakeTimers();
    let devFeed = '';
    const writes: Array<Record<string, unknown>> = [];
    const events: Array<{ kind: string; message?: string }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') {
        writes.push(args || {});
        return '';
      }
      if (command === 'read_file') {
        const path = String(args?.path || '');
        if (path.endsWith('broker-dev-feed.md')) return devFeed;
        if (path.endsWith('broker-review-feed.md')) return '';
        return '';
      }
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        if (shellCommand.includes('rev-parse HEAD')) return 'abc123';
        if (shellCommand.includes('git ls-files')) return '1';
        if (shellCommand.trim() === 'git diff') return '';
        return '';
      }
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'empty done should not review',
          workDir: '/repo/.octo-tmp/broker-wt-empty',
          projectName: 'test-project',
          autoRelay: true,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          existing: { developerId: 'dev-term', reviewerId: 'rev-term' },
          managed: {
            branch: 'broker/empty',
            worktreeDir: '/repo/.octo-tmp/broker-wt-empty',
            repoDir: '/repo',
          },
          resume: true,
        },
      );

      await vi.advanceTimersByTimeAsync(100);
      devFeed = 'DONE: no code changes\n';
      await vi.advanceTimersByTimeAsync(9000);

      expect(handle).toBeTruthy();
      expect(events.some((event) => /Ignored DONE signal because there is no git diff/.test(event.message || ''))).toBe(true);
      expect(writes.some(isActualReviewRequestWrite)).toBe(false);
      expect(writes.some((write) => String(write.data || '').includes('DONE ignored: there is no git diff to review'))).toBe(true);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('[D-perf-lazydiff] idle relay ticks run no git diff; a DONE signal still triggers the full capture', async () => {
    vi.useFakeTimers();
    let devFeed = '';
    const gitCommands: string[] = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_file') {
        const path = String(args?.path || '');
        if (path.endsWith('broker-dev-feed.md')) return devFeed;
        return '';
      }
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        gitCommands.push(shellCommand);
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        if (shellCommand.includes('rev-parse HEAD')) return 'abc123';
        if (shellCommand.includes('git ls-files')) return '1';
        return '';
      }
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'idle ticks must not pay for a full diff',
          workDir: '/repo/.octo-tmp/broker-wt-lazy',
          projectName: 'test-project',
          autoRelay: true,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        () => {},
        {
          existing: { developerId: 'dev-term', reviewerId: 'rev-term' },
          managed: {
            branch: 'broker/lazy',
            worktreeDir: '/repo/.octo-tmp/broker-wt-lazy',
            repoDir: '/repo',
          },
          resume: true,
        },
      );
      expect(handle).toBeTruthy();

      // Let startup finish (the baseline snapshot may legitimately use git),
      // then measure relay ticks only (first tick at 8s, then every 6s).
      await vi.advanceTimersByTimeAsync(1000);
      const startupLen = gitCommands.length;
      await vi.advanceTimersByTimeAsync(26_000);
      const idleCommands = gitCommands.slice(startupLen);
      expect(idleCommands.filter((c) => c.includes('git add -N') || /git diff/.test(c) || c.includes('status --porcelain'))).toEqual([]);

      // A DONE signal must still trigger the authoritative full diff capture.
      devFeed = 'DONE: implemented the thing\n';
      const preDoneLen = gitCommands.length;
      await vi.advanceTimersByTimeAsync(7000);
      const afterDone = gitCommands.slice(preDoneLen);
      expect(afterDone.some((c) => c.includes('git add -N'))).toBe(true);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('[D-perf-single-loop] a newer relay loop for the same terminal supersedes the old one', async () => {
    vi.useFakeTimers();
    const eventsA: Array<{ kind: string; message?: string }> = [];
    const eventsB: Array<{ kind: string; message?: string }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        if (shellCommand.includes('rev-parse HEAD')) return 'abc123';
        if (shellCommand.includes('git ls-files')) return '1';
        return '';
      }
      return '';
    });
    const startPair = (sink: Array<{ kind: string; message?: string }>) => startDevReviewPair(
      {
        developer: 'claude',
        reviewer: 'codex',
        goal: 'single live loop per terminal',
        workDir: '/repo/.octo-tmp/broker-wt-epoch',
        projectName: 'test-project',
        autoRelay: true,
      },
      () => ({ developerId: 'dev-term-epoch', reviewerId: 'rev-term-epoch' }),
      (event) => { sink.push(event); },
      {
        existing: { developerId: 'dev-term-epoch', reviewerId: 'rev-term-epoch' },
        managed: {
          branch: 'broker/epoch',
          worktreeDir: '/repo/.octo-tmp/broker-wt-epoch',
          repoDir: '/repo',
        },
        resume: true,
      },
    );

    try {
      const handleA = await startPair(eventsA);
      const handleB = await startPair(eventsB); // same developer terminal — claims the loop
      await vi.advanceTimersByTimeAsync(15_000); // past the first tick of both loops
      expect(handleA).toBeTruthy();
      expect(handleB).toBeTruthy();
      expect(eventsA.some((e) => /superseded by a newer harness loop/i.test(e.message || ''))).toBe(true);
      expect(eventsB.some((e) => /superseded by a newer harness loop/i.test(e.message || ''))).toBe(false);
      handleB?.stop();
      handleA?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests review when DONE has staged-only git diff', async () => {
    vi.useFakeTimers();
    let devFeed = '';
    let latestDiff = '';
    const stagedPatch = [
      'diff --git a/src/feature.ts b/src/feature.ts',
      'index 1111111..2222222 100644',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n');
    const writes: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') {
        writes.push(args || {});
        return '';
      }
      if (command === 'write_file') {
        const path = String(args?.path || '');
        if (path.endsWith('latest-diff.patch')) latestDiff = String(args?.content || '');
        return '';
      }
      if (command === 'read_file') {
        const path = String(args?.path || '');
        if (path.endsWith('broker-dev-feed.md')) return devFeed;
        if (path.endsWith('broker-review-feed.md')) return '';
        return '';
      }
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        if (shellCommand.includes('rev-parse HEAD')) return 'abc123';
        if (shellCommand.includes('git ls-files')) return '1';
        if (shellCommand.trim() === 'git diff --cached') return stagedPatch;
        if (shellCommand.trim() === 'git diff') return '';
        if (shellCommand.includes('git diff -w HEAD')) return stagedPatch;
        if (shellCommand.includes('git diff --shortstat HEAD')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
        return '';
      }
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'staged change should be reviewed',
          workDir: '/repo/.octo-tmp/broker-wt-staged',
          projectName: 'test-project',
          autoRelay: true,
          reviewMode: 'very_careful',
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        () => {},
        {
          existing: { developerId: 'dev-term', reviewerId: 'rev-term' },
          managed: {
            branch: 'broker/staged',
            worktreeDir: '/repo/.octo-tmp/broker-wt-staged',
            repoDir: '/repo',
          },
          resume: true,
        },
      );

      await vi.advanceTimersByTimeAsync(100);
      devFeed = 'DONE: staged update\n';
      await vi.advanceTimersByTimeAsync(9000);

      expect(handle).toBeTruthy();
      expect(writes.some(isActualReviewRequestWrite)).toBe(true);
      const reviewRequest = writes.find(isActualReviewRequestWrite);
      expect(String(reviewRequest?.data || '')).toContain('Review mode is Very careful');
      expect(String(reviewRequest?.data || '')).toContain('Review intensity: VERY CAREFUL');
      expect(String(reviewRequest?.data || '')).toContain('npm run browser:open first');
      expect(String(reviewRequest?.data || '')).toContain('npm run browser -- snapshot');
      expect(String(reviewRequest?.data || '')).toContain('screenshot, console, network');
      expect(writes.some((write) => String(write.data || '').includes('DONE ignored'))).toBe(false);
      expect(latestDiff).toContain(stagedPatch);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // P3-3: an APPROVED is stale if the diff changed after review — the broker must NOT
  // merge un-reviewed changes; it re-requests review instead.
  it('re-requests review when the diff changed after APPROVED (stale review)', async () => {
    vi.useFakeTimers();
    let devFeed = '';
    let reviewFeed = '';
    let diffPhase = 'A';
    const patchA = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+A';
    const patchB = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+B-CHANGED-AFTER-APPROVAL';
    const writes: Array<Record<string, unknown>> = [];
    const events: Array<{ kind: string; message?: string }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') { writes.push(args || {}); return ''; }
      if (command === 'read_file') {
        const path = String(args?.path || '');
        if (path.endsWith('broker-dev-feed.md')) return devFeed;
        if (path.endsWith('broker-review-feed.md')) return reviewFeed;
        return '';
      }
      if (command === 'run_cli_oneshot') {
        const c = String(args?.command || '');
        if (c.includes('rev-parse --is-inside-work-tree')) return 'true';
        if (c.includes('rev-parse HEAD')) return 'abc123';
        if (c.trim() === 'git diff --cached') return diffPhase === 'A' ? patchA : patchB;
        if (c.trim() === 'git diff') return '';
        if (c.includes('git diff -w HEAD')) return diffPhase === 'A' ? patchA : patchB;
        if (c.includes('--shortstat')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
        return '';
      }
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        { developer: 'claude', reviewer: 'codex', goal: 'stale review guard', workDir: '/repo/.octo-tmp/broker-wt-stale', projectName: 'test-project', autoRelay: true, reviewMode: 'normal' },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (e) => { events.push(e); },
        { existing: { developerId: 'dev-term', reviewerId: 'rev-term' }, managed: { branch: 'broker/stale', worktreeDir: '/repo/.octo-tmp/broker-wt-stale', repoDir: '/repo' }, resume: true },
      );
      await vi.advanceTimersByTimeAsync(100);
      devFeed = 'DONE: first cut\n';              // → review requested, lastReviewedDiff = patchA
      await vi.advanceTimersByTimeAsync(9000);
      diffPhase = 'B';                            // dev keeps editing after review
      reviewFeed = 'APPROVED: looks good\n';      // reviewer approves the OLD diff
      await vi.advanceTimersByTimeAsync(9000);

      expect(handle).toBeTruthy();
      // Stale approval must be caught: no merge, and a stale/re-review signal surfaced.
      expect(invokeMock).not.toHaveBeenCalledWith('git_merge_branch', expect.anything());
      expect(events.some((e) => /stale|낡음/i.test(e.message || ''))).toBe(true);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // P1-5: once a terminal's CLI was alive, losing its child process (CLI exited / closed)
  // for several consecutive checks escalates instead of relaying into a dead terminal.
  it('escalates when a broker terminal CLI dies mid-session', async () => {
    vi.useFakeTimers();
    let childAlive = true;
    let childCalls = 0;
    const events: Array<{ kind: string; message?: string; status?: { cycle?: string } }> = [];
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'pty_terminal_has_child') {
        childCalls += 1;
        // alive for the first couple of probes, then the CLI dies.
        return childCalls <= 2 ? true : childAlive;
      }
      if (command === 'read_file') return '';
      return '';
    });
    childAlive = false;

    try {
      const handle = await startDevReviewPair(
        { developer: 'claude', reviewer: 'codex', goal: 'detect terminal death', workDir: '/repo/.octo-tmp/broker-wt-dead', projectName: 'test-project', autoRelay: true, reviewMode: 'normal' },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (e) => { events.push(e); },
        {
          existing: { developerId: 'dev-term', reviewerId: 'rev-term' },
          managed: { branch: 'broker/dead', worktreeDir: '/repo/.octo-tmp/broker-wt-dead', repoDir: '/repo' },
          resume: true,
        },
      );
      // Several relay-loop iterations so the dead streak (>=6, ~6s/iteration) trips.
      await vi.advanceTimersByTimeAsync(90000);

      expect(handle).toBeTruthy();
      expect(events.some((e) => e.kind === 'error' && /(exited|closed|종료|닫힘)/.test(e.message || ''))).toBe(true);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // P2-6: a git FAILURE must not be misread as an empty diff (which would falsely
  // reject the developer's DONE). The broker surfaces the git error instead.
  it('does not reject DONE as empty when git itself fails', async () => {
    vi.useFakeTimers();
    let devFeed = '';
    const writes: Array<Record<string, unknown>> = [];
    const events: Array<{ kind: string; message?: string }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') { writes.push(args || {}); return ''; }
      if (command === 'read_file') {
        const path = String(args?.path || '');
        if (path.endsWith('broker-dev-feed.md')) return devFeed;
        return '';
      }
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        // git is BROKEN here: rev-parse does not confirm a work tree.
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'fatal: not a git repository';
        return '';
      }
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'git error must not look like empty diff',
          workDir: '/repo/.octo-tmp/broker-wt-giterr',
          projectName: 'test-project',
          autoRelay: true,
          reviewMode: 'normal',
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (e) => { events.push(e); },
        {
          existing: { developerId: 'dev-term', reviewerId: 'rev-term' },
          managed: { branch: 'broker/giterr', worktreeDir: '/repo/.octo-tmp/broker-wt-giterr', repoDir: '/repo' },
          resume: true,
        },
      );

      await vi.advanceTimersByTimeAsync(100);
      devFeed = 'DONE: real work the broker cannot see\n';
      await vi.advanceTimersByTimeAsync(9000);

      expect(handle).toBeTruthy();
      // The broker must NOT tell the developer their DONE had no diff...
      expect(writes.some((w) => String(w.data || '').includes('DONE ignored'))).toBe(false);
      expect(writes.some((w) => String(w.data || '').includes('there is no git diff'))).toBe(false);
      // ...it must surface the git error instead.
      expect(events.some((e) => e.kind === 'error' && /git (error|diff)/i.test(e.message || ''))).toBe(true);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips reviewer and starts auto merge when review mode is off', async () => {
    vi.useFakeTimers();
    let devFeed = '';
    let latestDiff = '';
    const patch = [
      'diff --git a/src/feature.ts b/src/feature.ts',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n');
    const writes: Array<Record<string, unknown>> = [];
    const events: Array<{ kind: string; message?: string; status?: { cycle?: string } }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') {
        writes.push(args || {});
        return '';
      }
      if (command === 'write_file') {
        const path = String(args?.path || '');
        if (path.endsWith('latest-diff.patch')) latestDiff = String(args?.content || '');
        return '';
      }
      if (command === 'git_merge_branch') return 'merged';
      if (command === 'read_file') {
        const path = String(args?.path || '');
        if (path.endsWith('broker-dev-feed.md')) return devFeed;
        if (path.endsWith('broker-review-feed.md')) return '';
        return '';
      }
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        if (shellCommand.includes('rev-parse HEAD')) return 'abc123';
        if (shellCommand.includes('git ls-files')) return '1';
        if (shellCommand.trim() === 'git diff --cached') return '';
        if (shellCommand.trim() === 'git diff') return patch;
        if (shellCommand.includes('git diff -w HEAD')) return patch;
        if (shellCommand.includes('git diff --shortstat')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
        if (shellCommand.includes('git add -A')) return '';
        return '';
      }
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'skip manual review',
          workDir: '/repo/.octo-tmp/broker-wt-review-off',
          projectName: 'test-project',
          autoRelay: true,
          reviewMode: 'off',
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          existing: { developerId: 'dev-term', reviewerId: 'rev-term' },
          managed: {
            branch: 'broker/review-off',
            worktreeDir: '/repo/.octo-tmp/broker-wt-review-off',
            repoDir: '/repo',
          },
          resume: true,
        },
      );

      await vi.advanceTimersByTimeAsync(100);
      devFeed = 'DONE: safe update\n';
      await vi.advanceTimersByTimeAsync(9000);
      await vi.advanceTimersByTimeAsync(100);

      expect(handle).toBeTruthy();
      expect(latestDiff).toContain(patch);
      expect(writes.some(isActualReviewRequestWrite)).toBe(false);
      expect(writes.some((write) => String(write.data || '').includes('Review step is disabled. Broker mechanical checks passed'))).toBe(true);
      // Detached-HEAD worktree → merge by the worktree HEAD SHA (rev-parse HEAD mock),
      // not by the 'broker/*' label which is never created as a real ref.
      expect(invokeMock).toHaveBeenCalledWith('git_merge_branch', { repoDir: '/repo', branchName: 'abc123' });
      expect(events.some((event) => event.status?.cycle === 'merged')).toBe(true);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a merged harness closed and never starts a legacy autonomous follow-up', async () => {
    vi.useFakeTimers();
    let devFeed = '';
    const patch = [
      'diff --git a/src/feature.ts b/src/feature.ts',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n');
    const events: Array<{ kind: string; message?: string; status?: { cycle?: string; reason?: string } }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') return '';
      if (command === 'write_file') return '';
      if (command === 'git_merge_branch') return 'merged';
      if (command === 'read_file') {
        const path = String(args?.path || '');
        if (path.endsWith('broker-dev-feed.md')) return devFeed;
        if (path.endsWith('broker-review-feed.md')) return '';
        return '';
      }
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        if (shellCommand.includes('rev-parse HEAD')) return 'abc123';
        if (shellCommand.includes('git ls-files')) return '1';
        if (shellCommand.trim() === 'git diff --cached') return '';
        if (shellCommand.trim() === 'git diff') return patch;
        if (shellCommand.includes('git diff -w HEAD')) return patch;
        if (shellCommand.includes('git diff --shortstat')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
        if (shellCommand.includes('git add -A')) return '';
        return '';
      }
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'close after merge',
          workDir: '/repo/.octo-tmp/broker-wt-autonomous-close',
          projectName: 'test-project',
          autoRelay: true,
          reviewMode: 'off',
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          existing: { developerId: 'dev-term', reviewerId: 'rev-term' },
          managed: {
            branch: 'broker/autonomous-close',
            worktreeDir: '/repo/.octo-tmp/broker-wt-autonomous-close',
            repoDir: '/repo',
          },
          resume: true,
        },
      );

      await vi.advanceTimersByTimeAsync(100);
      devFeed = 'DONE: safe update\n';
      await vi.advanceTimersByTimeAsync(10000);

      expect(handle).toBeTruthy();
      expect(events.some((event) => event.status?.cycle === 'merged')).toBe(true);
      expect(events.some((event) => event.status?.cycle === 'developing' && /autonomous/i.test(event.status.reason || ''))).toBe(false);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays an existing DONE on resume when the broker had not reviewed it yet', async () => {
    vi.useFakeTimers();
    const currentDiff = [
      'diff --git a/src/feature.ts b/src/feature.ts',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n');
    const devFeed = 'DONE: finished just before reload\n';
    const writes: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') {
        writes.push(args || {});
        return '';
      }
      if (command === 'write_file') return '';
      if (command === 'read_file') {
        const path = String(args?.path || '');
        if (path.endsWith('broker-dev-feed.md')) return devFeed;
        if (path.endsWith('broker-review-feed.md')) return '';
        if (path.endsWith('latest-diff.patch')) return '';
        return '';
      }
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        if (shellCommand.includes('rev-parse HEAD')) return 'abc123';
        if (shellCommand.includes('git ls-files')) return '1';
        if (shellCommand.trim() === 'git diff --cached') return '';
        if (shellCommand.trim() === 'git diff') return currentDiff;
        if (shellCommand.includes('git diff -w HEAD')) return currentDiff;
        if (shellCommand.includes('git diff --shortstat')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
        return '';
      }
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'resume pending done',
          workDir: '/repo/.octo-tmp/broker-wt-resume-done',
          projectName: 'test-project',
          autoRelay: true,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        () => {},
        {
          existing: { developerId: 'dev-term', reviewerId: 'rev-term' },
          managed: {
            branch: 'broker/resume-done',
            worktreeDir: '/repo/.octo-tmp/broker-wt-resume-done',
            repoDir: '/repo',
          },
          resume: true,
        },
      );

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(9000);

      expect(handle).toBeTruthy();
      expect(writes.some(isActualReviewRequestWrite)).toBe(true);
      expect(writes.some((write) => String(write.data || '').includes('DONE ignored'))).toBe(false);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores pending reviewer work on resume when a diff handoff already exists', async () => {
    vi.useFakeTimers();
    const currentDiff = [
      'diff --git a/src/feature.ts b/src/feature.ts',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n');
    const devFeed = 'DONE: review was requested before reload\n';
    const writes: Array<Record<string, unknown>> = [];
    const events: Array<{ kind: string; message?: string; status?: { cycle?: string } }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') {
        writes.push(args || {});
        return '';
      }
      if (command === 'write_file') return '';
      if (command === 'read_file') {
        const path = String(args?.path || '');
        if (path.endsWith('broker-dev-feed.md')) return devFeed;
        if (path.endsWith('broker-review-feed.md')) return '';
        if (path.endsWith('latest-diff.patch')) return `# review - developer DONE\n\n${currentDiff}`;
        return '';
      }
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        if (shellCommand.includes('rev-parse HEAD')) return 'abc123';
        if (shellCommand.includes('git ls-files')) return '1';
        if (shellCommand.trim() === 'git diff --cached') return '';
        if (shellCommand.trim() === 'git diff') return currentDiff;
        if (shellCommand.includes('git diff -w HEAD')) return currentDiff;
        if (shellCommand.includes('git diff --shortstat')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
        return '';
      }
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'resume pending review',
          workDir: '/repo/.octo-tmp/broker-wt-pending-review',
          projectName: 'test-project',
          autoRelay: true,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          existing: { developerId: 'dev-term', reviewerId: 'rev-term' },
          managed: {
            branch: 'broker/pending-review',
            worktreeDir: '/repo/.octo-tmp/broker-wt-pending-review',
            repoDir: '/repo',
          },
          resume: true,
        },
      );

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(9000);

      expect(handle).toBeTruthy();
      expect(events.some((event) => event.status?.cycle === 'reviewing')).toBe(true);
      expect(writes.some((write) => String(write.data || '').includes('Review still pending after reload'))).toBe(true);
      expect(writes.some((write) => String(write.data || '').includes('DONE ignored'))).toBe(false);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores REWORK context on resume and rejects the same diff before re-review', async () => {
    vi.useFakeTimers();
    const currentDiff = [
      'diff --git a/src/feature.ts b/src/feature.ts',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n');
    const devFeed = 'DONE: old attempt before rework\n';
    const reviewFeed = 'REWORK: fix the returned value\n';
    const writes: Array<Record<string, unknown>> = [];
    const events: Array<{ kind: string; message?: string; status?: { cycle?: string } }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') {
        writes.push(args || {});
        return '';
      }
      if (command === 'write_file') return '';
      if (command === 'read_file') {
        const path = String(args?.path || '');
        if (path.endsWith('broker-dev-feed.md')) return devFeed;
        if (path.endsWith('broker-review-feed.md')) return reviewFeed;
        if (path.endsWith('latest-diff.patch')) return `# review - developer DONE\n\n${currentDiff}`;
        return '';
      }
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        if (shellCommand.includes('rev-parse HEAD')) return 'abc123';
        if (shellCommand.includes('git ls-files')) return '1';
        if (shellCommand.trim() === 'git diff --cached') return '';
        if (shellCommand.trim() === 'git diff') return currentDiff;
        if (shellCommand.includes('git diff -w HEAD')) return currentDiff;
        if (shellCommand.includes('git diff --shortstat')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
        return '';
      }
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'resume rework',
          workDir: '/repo/.octo-tmp/broker-wt-resume-rework',
          projectName: 'test-project',
          autoRelay: true,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          existing: { developerId: 'dev-term', reviewerId: 'rev-term' },
          managed: {
            branch: 'broker/resume-rework',
            worktreeDir: '/repo/.octo-tmp/broker-wt-resume-rework',
            repoDir: '/repo',
          },
          resume: true,
        },
      );

      await vi.advanceTimersByTimeAsync(100);
      expect(events.some((event) => event.status?.cycle === 'addressing')).toBe(true);
      await vi.advanceTimersByTimeAsync(9000);

      expect(handle).toBeTruthy();
      expect(writes.some((write) => String(write.data || '').includes('diff did not change'))).toBe(true);
      expect(writes.some(isActualReviewRequestWrite)).toBe(false);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the relay after auto merge so follow-up work needs a fresh harness', async () => {
    vi.useFakeTimers();
    let devFeed = '';
    let reviewFeed = '';
    let currentDiff = [
      'diff --git a/src/feature.ts b/src/feature.ts',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n');
    const followUpDiff = [
      'diff --git a/src/feature.ts b/src/feature.ts',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1 +1 @@',
      '-export const value = 2;',
      '+export const value = 3;',
    ].join('\n');
    const writes: Array<Record<string, unknown>> = [];
    const events: Array<{ kind: string; message?: string; status?: { cycle?: string } }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') {
        writes.push(args || {});
        return '';
      }
      if (command === 'write_file') return '';
      if (command === 'git_merge_branch') return 'merged';
      if (command === 'read_file') {
        const path = String(args?.path || '');
        if (path.endsWith('broker-dev-feed.md')) return devFeed;
        if (path.endsWith('broker-review-feed.md')) return reviewFeed;
        return '';
      }
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        if (shellCommand.includes('rev-parse HEAD')) return 'abc123';
        if (shellCommand.includes('git ls-files')) return '1';
        if (shellCommand.trim() === 'git diff --cached') return '';
        if (shellCommand.trim() === 'git diff') return currentDiff;
        if (shellCommand.includes('git diff -w HEAD')) return currentDiff;
        if (shellCommand.includes('git diff --shortstat')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
        if (shellCommand.includes('git add -A')) return '';
        return '';
      }
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'close after merge',
          workDir: '/repo/.octo-tmp/broker-wt-follow-up',
          projectName: 'test-project',
          autoRelay: true,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          existing: { developerId: 'dev-term', reviewerId: 'rev-term' },
          managed: {
            branch: 'broker/follow-up',
            worktreeDir: '/repo/.octo-tmp/broker-wt-follow-up',
            repoDir: '/repo',
          },
          resume: true,
        },
      );

      await vi.advanceTimersByTimeAsync(100);
      devFeed = 'DONE: first change\n';
      await vi.advanceTimersByTimeAsync(9000);
      expect(writes.filter(isActualReviewRequestWrite)).toHaveLength(1);

      reviewFeed = 'APPROVED\n';
      await vi.advanceTimersByTimeAsync(6000);
      await vi.advanceTimersByTimeAsync(100);
      expect(events.some((event) => event.status?.cycle === 'merged')).toBe(true);

      currentDiff = followUpDiff;
      devFeed += 'DONE: follow-up change\n';
      await vi.advanceTimersByTimeAsync(9000);

      expect(handle).toBeTruthy();
      expect(writes.filter(isActualReviewRequestWrite)).toHaveLength(1);
      expect(events.filter((event) => event.status?.cycle === 'merged')).toHaveLength(1);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires changed code before re-reviewing mandatory REWORK', async () => {
    vi.useFakeTimers();
    let devFeed = '';
    let reviewFeed = '';
    let currentDiff = [
      'diff --git a/src/feature.ts b/src/feature.ts',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n');
    const fixedDiff = [
      'diff --git a/src/feature.ts b/src/feature.ts',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 3;',
    ].join('\n');
    const writes: Array<Record<string, unknown>> = [];
    const events: Array<{ kind: string; message?: string; status?: { cycle?: string } }> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') {
        writes.push(args || {});
        return '';
      }
      if (command === 'write_file') return '';
      if (command === 'git_merge_branch') return 'merged';
      if (command === 'read_file') {
        const path = String(args?.path || '');
        if (path.endsWith('broker-dev-feed.md')) return devFeed;
        if (path.endsWith('broker-review-feed.md')) return reviewFeed;
        return '';
      }
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        if (shellCommand.includes('rev-parse HEAD')) return 'abc123';
        if (shellCommand.includes('git ls-files')) return '1';
        if (shellCommand.trim() === 'git diff --cached') return '';
        if (shellCommand.trim() === 'git diff') return currentDiff;
        if (shellCommand.includes('git diff -w HEAD')) return currentDiff;
        if (shellCommand.includes('git diff --shortstat')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
        if (shellCommand.includes('git add -A')) return '';
        return '';
      }
      return '';
    });

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'enforce rework loop',
          workDir: '/repo/.octo-tmp/broker-wt-rework',
          projectName: 'test-project',
          autoRelay: true,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          existing: { developerId: 'dev-term', reviewerId: 'rev-term' },
          managed: {
            branch: 'broker/rework',
            worktreeDir: '/repo/.octo-tmp/broker-wt-rework',
            repoDir: '/repo',
          },
          resume: true,
        },
      );

      await vi.advanceTimersByTimeAsync(100);
      devFeed = 'DONE: first attempt\n';
      await vi.advanceTimersByTimeAsync(9000);
      expect(writes.filter(isActualReviewRequestWrite)).toHaveLength(1);

      reviewFeed = 'REWORK: fix the returned value\n';
      await vi.advanceTimersByTimeAsync(6000);
      expect(writes.some((write) => String(write.data || '').includes('MANDATORY REWORK'))).toBe(true);
      expect(writes.some((write) => String(write.data || '').includes('Reviewer learning note'))).toBe(true);
      expect(events.some((event) => event.status?.cycle === 'addressing')).toBe(true);
      const writesAfterRework = writes.length;
      await vi.advanceTimersByTimeAsync(700000);
      expect(writes.slice(writesAfterRework).some((write) => String(write.data || '').includes('Self-improvement review'))).toBe(false);
      expect(writes.some((write) => String(write.data || '').includes('BE ACTIVE'))).toBe(false);

      devFeed += 'DONE: claimed fixed without change\n';
      await vi.advanceTimersByTimeAsync(9000);
      expect(writes.filter(isActualReviewRequestWrite)).toHaveLength(1);
      expect(writes.some((write) => String(write.data || '').includes('diff did not change'))).toBe(true);

      currentDiff = fixedDiff;
      devFeed += 'DONE: fixed with changed diff\n';
      await vi.advanceTimersByTimeAsync(9000);
      expect(writes.filter(isActualReviewRequestWrite)).toHaveLength(2);

      reviewFeed += 'APPROVED\n';
      await vi.advanceTimersByTimeAsync(6000);
      await vi.advanceTimersByTimeAsync(100);

      expect(handle).toBeTruthy();
      expect(events.some((event) => event.status?.cycle === 'merged')).toBe(true);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes a newly-created broker worktree if terminal creation fails', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        return '';
      }
      return undefined;
    });

    const events: Array<{ kind: string; message?: string }> = [];
    const handle = await startDevReviewPair(
      {
        developer: 'claude',
        reviewer: 'codex',
        goal: 'cleanup failed start',
        workDir: '/repo',
        projectName: 'test-project',
        autoRelay: false,
        isolate: true,
      },
      () => null,
      (event) => { events.push(event); },
    );

    expect(handle).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('git_worktree_remove', {
      worktreeDir: expect.stringMatching(/\/repo\/\.octo-tmp\/broker-wt-\d+-[a-z0-9]+$/),
    });
    expect(invokeMock).toHaveBeenCalledWith('git_delete_branch', {
      repoDir: '/repo',
      branchName: expect.stringMatching(/^broker\/\d+-[a-z0-9]+$/),
    });
    expect(events.some((event) => event.message === 'Could not open terminals.')).toBe(true);
  });

  it('creates distinct broker branches and worktrees for concurrent same-project starts in the same millisecond', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1782000000000);
    const openedWorkDirs: string[] = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'run_cli_oneshot') {
        const shellCommand = String(args?.command || '');
        if (shellCommand.includes('rev-parse --is-inside-work-tree')) return 'true';
        return '';
      }
      return undefined;
    });

    try {
      const baseConfig = {
        developer: 'claude' as const,
        reviewer: 'codex' as const,
        goal: 'same project multi harness',
        workDir: '/repo',
        projectName: 'test-project',
        autoRelay: false,
        isolate: true,
      };
      const openPair = (_dev: unknown, _rev: unknown, workDir?: string) => {
        openedWorkDirs.push(workDir || '');
        return {
          developerId: `dev-${openedWorkDirs.length}`,
          reviewerId: `rev-${openedWorkDirs.length}`,
        };
      };
      const h1 = await startDevReviewPair(baseConfig, openPair, () => {});
      const h2 = await startDevReviewPair(baseConfig, openPair, () => {});

      expect(h1?.branch).toMatch(/^broker\/1782000000000-[a-z0-9]+$/);
      expect(h2?.branch).toMatch(/^broker\/1782000000000-[a-z0-9]+$/);
      expect(h1?.branch).not.toBe(h2?.branch);
      expect(h1?.worktreeDir).not.toBe(h2?.worktreeDir);
      expect(openedWorkDirs).toEqual([h1?.worktreeDir, h2?.worktreeDir]);
      h1?.stop();
      h2?.stop();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('merges broker-managed work without removing the worktree', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'git_merge_branch') return 'merged';
      if (command === 'run_cli_oneshot') {
        const shellCommand = String((args as { command?: string } | undefined)?.command || '');
        if (shellCommand.includes('rev-parse HEAD')) return 'abc123';
        return '';
      }
      return undefined;
    });

    const handle = await startDevReviewPair(
      {
        developer: 'claude',
        reviewer: 'codex',
        goal: 'keep terminals open',
        workDir: '/repo/.octo-tmp/broker-wt-1',
        projectName: 'test-project',
        autoRelay: false,
      },
      () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
      () => {},
      {
        managed: {
          branch: 'broker/1',
          worktreeDir: '/repo/.octo-tmp/broker-wt-1',
          repoDir: '/repo',
        },
      },
    );

    expect(handle?.merge).toBeTypeOf('function');
    await handle!.merge!();

    // Merge by the worktree HEAD SHA (detached HEAD), not the 'broker/1' label.
    expect(invokeMock).toHaveBeenCalledWith('git_merge_branch', { repoDir: '/repo', branchName: 'abc123' });
    expect(invokeMock).not.toHaveBeenCalledWith('git_worktree_remove', expect.anything());
    handle?.stop();
  });
});

describe('devReviewPair restored completed harness messaging', () => {
  it('re-briefs restored closed harnesses when replacement terminals are opened', async () => {
    vi.useFakeTimers();
    const writes: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'write_to_pty') writes.push(args || {});
      return '';
    });
    const events: Array<{ kind: string; message?: string }> = [];

    try {
      const handle = await startDevReviewPair(
        {
          developer: 'claude',
          reviewer: 'codex',
          goal: 'continue after app restart',
          workDir: '/repo/.octo-tmp/broker-wt-closed',
          projectName: 'test-project',
          autoRelay: false,
        },
        () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
        (event) => { events.push(event); },
        {
          managed: {
            branch: 'broker/closed',
            worktreeDir: '/repo/.octo-tmp/broker-wt-closed',
            repoDir: '/repo',
          },
          restoredStatus: { cycle: 'merged', cycleLabel: 'Merged', reason: 'merged earlier' },
        },
      );

      await vi.advanceTimersByTimeAsync(11000);
      await vi.advanceTimersByTimeAsync(1000);

      expect(handle).toBeTruthy();
      expect(events.some((event) => /Restored completed broker state/.test(event.message || ''))).toBe(true);
      expect(writes.some((write) => String(write.data || '').includes('This terminal is the REVIEW AGENT'))).toBe(true);
      expect(writes.some((write) => String(write.data || '').includes('This terminal is the DEV AGENT'))).toBe(true);
      // Bare CR submission (committed CR fix), not CRLF.
      expect(writes.filter((write) => write.data === '\r').map((write) => write.terminalId)).toEqual(
        expect.arrayContaining(['rev-term', 'dev-term']),
      );
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not tell the user a restored completed harness relay is stopped', async () => {
    invokeMock.mockResolvedValue('');
    const events: Array<{ kind: string; message?: string }> = [];

    const handle = await startDevReviewPair(
      {
        developer: 'claude',
        reviewer: 'codex',
        goal: 'continue after merge',
        workDir: '/repo/.octo-tmp/broker-wt-2',
        projectName: 'test-project',
        autoRelay: false,
      },
      () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
      (event) => { events.push(event); },
      {
        managed: {
          branch: 'broker/2',
          worktreeDir: '/repo/.octo-tmp/broker-wt-2',
          repoDir: '/repo',
        },
        restoredStatus: { cycle: 'merged', cycleLabel: 'Merged', reason: 'merged earlier' },
      },
    );

    expect(handle).toBeTruthy();
    const message = await waitForEvent(events, /Restored completed broker state/);
    expect(message).toContain('terminals stay attached');
    expect(message).not.toMatch(/stopped|closed/i);
    handle?.stop();
  });

  it('labels a restored failed merge as blocked instead of completed', async () => {
    invokeMock.mockResolvedValue('');
    const events: Array<{ kind: string; message?: string }> = [];

    const handle = await startDevReviewPair(
      {
        developer: 'claude',
        reviewer: 'codex',
        goal: 'inspect failed merge',
        workDir: '/repo/.octo-tmp/broker-wt-3',
        projectName: 'test-project',
        autoRelay: false,
      },
      () => ({ developerId: 'dev-term', reviewerId: 'rev-term' }),
      (event) => { events.push(event); },
      {
        managed: {
          branch: 'broker/3',
          worktreeDir: '/repo/.octo-tmp/broker-wt-3',
          repoDir: '/repo',
        },
        restoredStatus: { cycle: 'merge_failed', cycleLabel: 'Merge failed', reason: 'dirty target' },
      },
    );

    expect(handle).toBeTruthy();
    const message = await waitForEvent(events, /Restored blocked broker state/);
    expect(message).toContain('terminals stay attached');
    expect(message).not.toMatch(/completed|stopped|closed/i);
    handle?.stop();
  });
});

describe('devReviewPair source encoding guard', () => {
  it('does not contain committed mojibake markers or a UTF-8 BOM', () => {
    const source = readFileSync(join(process.cwd(), 'src/devreview/devReviewPair.ts'), 'utf8');

    expect(source.charCodeAt(0)).not.toBe(0xfeff);
    expect(source).not.toMatch(/[\uFFFD\u0080-\u009F]/);
    expect(source).not.toMatch(/(^|\s|\/\/|\/\*)\?\?[A-Za-z]|[A-Za-z]\?\?[A-Za-z]/);
    expect(source).not.toMatch(/[\uC338\uBD31]/);
  });
});
