import { describe, expect, it } from 'vitest';
import { applyReportedClaudeSession, applyReportedClaudeSessionToProjects, isDedicatedClaudeTab } from './claudeSessionReport';

const A = '0f4b2c1e-7d3a-4c5b-9e8f-1a2b3c4d5e6f';
const B = '11111111-2222-4333-8444-555555555555';

describe('applyReportedClaudeSession', () => {
  const terminals = [
    { id: 't1', name: 'Claude 1', cliType: 'claude' },
    { id: 't2', name: 'Shell 1', cliType: 'shell' },
    { id: 't3', name: 'Claude new', cliType: 'claude', claudeSessionId: A, claudeSessionSource: 'app' as const },
  ];

  it('should_store_the_reported_id_on_a_plain_claude_tab', () => {
    const next = applyReportedClaudeSession(terminals, { terminalId: 't1', sessionId: A, source: 'startup' });
    expect(next).not.toBe(terminals);
    expect(next[0]).toEqual({ id: 't1', name: 'Claude 1', cliType: 'claude', claudeSessionId: A, claudeSessionSource: 'hook' });
    expect(next[1]).toBe(terminals[1]);
    expect(terminals[0]).not.toHaveProperty('claudeSessionId'); // no mutation
  });

  it('should_replace_the_id_after_clear_and_keep_an_app_tab_dedicated', () => {
    const next = applyReportedClaudeSession(terminals, { terminalId: 't3', sessionId: B, source: 'clear' });
    expect(next[2].claudeSessionId).toBe(B);
    expect(next[2].claudeSessionSource).toBe('app');
    // legacy app id without a source is also kept as 'app'
    const legacy: { id: string; cliType: string; claudeSessionId: string; claudeSessionSource?: 'app' | 'hook' }[] = [{ id: 'l', cliType: 'claude', claudeSessionId: A }];
    expect(applyReportedClaudeSession(legacy, { terminalId: 'l', sessionId: B })[0].claudeSessionSource).toBe('app');
    // a hook tab stays 'hook' when /clear changes its id
    const hook = applyReportedClaudeSession(terminals, { terminalId: 't1', sessionId: A });
    expect(applyReportedClaudeSession(hook, { terminalId: 't1', sessionId: B, source: 'clear' })[0]).toMatchObject({ claudeSessionId: B, claudeSessionSource: 'hook' });
  });

  it('should_tell_dedicated_tabs_from_hook_tabs', () => {
    expect(isDedicatedClaudeTab({ claudeSessionId: A, claudeSessionSource: 'app' })).toBe(true);
    expect(isDedicatedClaudeTab({ claudeSessionId: A })).toBe(true);
    expect(isDedicatedClaudeTab({ claudeSessionId: A, claudeSessionSource: 'hook' })).toBe(false);
    expect(isDedicatedClaudeTab({})).toBe(false);
  });

  it('should_return_the_same_array_when_nothing_changes', () => {
    expect(applyReportedClaudeSession(terminals, { terminalId: 't3', sessionId: A, source: 'resume' })).toBe(terminals);
    expect(applyReportedClaudeSession(terminals, { terminalId: 't3', sessionId: A.toUpperCase() })).toBe(terminals);
    expect(applyReportedClaudeSession(terminals, { terminalId: 'unknown', sessionId: A })).toBe(terminals);
    expect(applyReportedClaudeSession(terminals, { terminalId: 't2', sessionId: A })).toBe(terminals); // not a Claude tab
    expect(applyReportedClaudeSession(terminals, { terminalId: 't1', sessionId: 'not-a-uuid' })).toBe(terminals);
    expect(applyReportedClaudeSession(terminals, null)).toBe(terminals);
  });

  it('should_update_only_the_project_that_owns_the_terminal', () => {
    const projects = [
      { id: 'p1', terminals: [terminals[0]] },
      { id: 'p2', terminals: [terminals[1]] },
    ];
    const next = applyReportedClaudeSessionToProjects(projects, { terminalId: 't1', sessionId: B });
    expect(next[0].terminals[0].claudeSessionId).toBe(B);
    expect(next[1]).toBe(projects[1]);
    expect(applyReportedClaudeSessionToProjects(projects, { terminalId: 'nope', sessionId: B })).toBe(projects);
  });
});
