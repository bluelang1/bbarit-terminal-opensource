import { describe, expect, it } from 'vitest';
import { GATEWAY_UI_COMMAND_DOCS } from '../gatewayUiCommands';
import { enqueueNote, flushNotes, type PendingNotes } from './agentRelay';
import {
  AGENTS_DISABLED_CODE,
  AGENTS_DISABLED_ERROR,
  agentTeamEnabled,
  agentTeamRefusal,
  gaugeButtonLabel,
  isAgentTeamCommand,
  refusalAfterWorktree,
  teamGatedNoteSend,
  showStopTeamButton,
  showTeamStatusButton,
  teamBadgeCount,
} from './agentTeamSwitch';

const OFF = { enabled: false, maxChildren: 6 };
const ON = { enabled: true };

describe('agentTeamEnabled', () => {
  it('is on unless agents.enabled is exactly false (old config files stay on)', () => {
    expect(agentTeamEnabled(undefined)).toBe(true);
    expect(agentTeamEnabled(null)).toBe(true);
    expect(agentTeamEnabled({})).toBe(true);
    expect(agentTeamEnabled({ maxChildren: 3 })).toBe(true);
    expect(agentTeamEnabled(ON)).toBe(true);
    expect(agentTeamEnabled({ enabled: 'false' })).toBe(true);
    expect(agentTeamEnabled({ enabled: 0 })).toBe(true);
    expect(agentTeamEnabled([])).toBe(true);
    expect(agentTeamEnabled(OFF)).toBe(false);
  });
});

describe('refusal while the agent team is off', () => {
  const relay = ['agent.run', 'agent.send', 'agent.stop', 'agent.status', 'agent.list'];
  const board = ['agent.board.post', 'agent.board.read', 'agent.board.teams', 'agent.board.clear'];
  const task = ['agent.task.add', 'agent.task.list', 'agent.task.show', 'agent.task.claim', 'agent.task.done', 'agent.task.approve', 'agent.task.dep'];

  it.each([['relay (run/send/stop/status/list; wait polls status)', relay], ['board', board], ['task', task]])(
    'refuses every %s command with one stable code and message',
    (_family, cmds) => {
      for (const cmd of cmds) {
        expect(agentTeamRefusal(cmd, OFF)).toEqual({ ok: false, code: AGENTS_DISABLED_CODE, error: AGENTS_DISABLED_ERROR });
      }
    },
  );

  it('lets the same commands through while on', () => {
    for (const cmd of [...relay, ...board, ...task]) {
      expect(agentTeamRefusal(cmd, ON)).toBeNull();
      expect(agentTeamRefusal(cmd, undefined)).toBeNull();
    }
  });

  it('covers every agent.* command the bus documents except run.result and log', () => {
    const agentCmds = GATEWAY_UI_COMMAND_DOCS.map((d) => d.cmd).filter((c) => c.startsWith('agent.'));
    expect(agentCmds.length).toBeGreaterThan(20);
    for (const cmd of agentCmds) {
      const exempt = cmd === 'agent.run.result' || cmd === 'agent.log';
      expect(isAgentTeamCommand(cmd), cmd).toBe(!exempt);
    }
    // A future agent.* command is refused by default.
    expect(isAgentTeamCommand('agent.something.new')).toBe(true);
  });

  it('never touches other commands', () => {
    for (const cmd of ['terminal.write', 'terminal.list', 'config.get', 'config.patch', 'status', 'agents', 'agent', '']) {
      expect(isAgentTeamCommand(cmd)).toBe(false);
      expect(agentTeamRefusal(cmd, OFF)).toBeNull();
    }
  });

  it('the message tells the agent to work without child tabs', () => {
    expect(AGENTS_DISABLED_CODE).toBe('agents_disabled');
    expect(AGENTS_DISABLED_ERROR).toMatch(/agent team is turned off/);
    expect(AGENTS_DISABLED_ERROR).toMatch(/Do the work yourself in this tab/);
    expect(AGENTS_DISABLED_ERROR).toMatch(/do not retry/);
  });
});

describe('team UI in the main window while off', () => {
  it('keeps the stop-team button while relay children still work, so a person can stop them', () => {
    expect(showStopTeamButton(true, true)).toBe(true);
    expect(showStopTeamButton(false, true)).toBe(true);
    expect(showStopTeamButton(true, false)).toBe(false);
    expect(showStopTeamButton(false, false)).toBe(false);
    // Agents still cannot stop them.
    expect(agentTeamRefusal('agent.stop', OFF)?.code).toBe(AGENTS_DISABLED_CODE);
  });

  it('gauge button: no team status in the tooltip and no guide target while off', () => {
    expect(gaugeButtonLabel(true, 'en')).toEqual({ title: 'Team status · Agent Dashboard (dashboard URL in Settings > Hub)', guide: 'team-status' });
    for (const locale of ['en', 'ko']) {
      const off = gaugeButtonLabel(false, locale);
      expect(off.guide).toBeUndefined();
      expect(off.title).not.toMatch(/Team status|팀 현황/);
      expect(off.title).toMatch(/Dashboard|대시보드/);
    }
  });

  it('hides the project bar team status button', () => {
    expect(showTeamStatusButton(true, 1)).toBe(true);
    expect(showTeamStatusButton(true, 0)).toBe(false);
    expect(showTeamStatusButton(false, 2)).toBe(false);
  });

  it('shows no badge numbers (project tabs, gauge button)', () => {
    expect(teamBadgeCount(true, 3)).toBe(3);
    expect(teamBadgeCount(false, 3)).toBe(0);
    expect(teamBadgeCount(false, 0)).toBe(0);
  });
});

describe('notes and runs already under way when the team is turned off', () => {
  it('drops the rest of a flush batch once off (notes already taken out of the queue)', async () => {
    const queue: PendingNotes = new Map();
    for (const n of ['a', 'b', 'c']) enqueueNote(queue, 'p', n);
    let on = true;
    const typed: string[] = [];
    const res = await flushNotes(queue, 'p', teamGatedNoteSend(() => on, async (note) => {
      typed.push(note);
      on = false; // turned off while the first note was being typed
      return { ok: true };
    }));
    expect(typed).toEqual(['a']);
    expect(res).toEqual({ sent: 1, stoppedBy: 'disposed' });
    expect(queue.has('p')).toBe(false);
  });

  it('sends everything while on', async () => {
    const queue: PendingNotes = new Map();
    for (const n of ['a', 'b']) enqueueNote(queue, 'p', n);
    const typed: string[] = [];
    await flushNotes(queue, 'p', teamGatedNoteSend(() => true, async (note) => { typed.push(note); return { ok: true }; }));
    expect(typed).toEqual(['a', 'b']);
  });

  it('a worktree run that became ready after turn-off opens no tab and names the kept worktree', () => {
    const prepared = { path: '/repo/.bbarit/worktrees/fix', branch: 'agent/fix' };
    expect(refusalAfterWorktree(ON, prepared)).toBeNull();
    expect(refusalAfterWorktree(undefined, prepared)).toBeNull();
    const off = refusalAfterWorktree(OFF, prepared)!;
    expect(off.ok).toBe(false);
    expect(off.code).toBe(AGENTS_DISABLED_CODE);
    expect(off.worktree).toBe(prepared.path);
    expect(off.branch).toBe('agent/fix');
    expect(off.error).toContain(AGENTS_DISABLED_ERROR);
    expect(off.error).toContain('/repo/.bbarit/worktrees/fix');
  });
});

describe('lead agent phrase (agents.leadPhrase)', () => {
  it('accepts one line of 2–60 characters, trimmed and collapsed', async () => {
    const { normalizeLeadPhrase, readLeadPhrase, DEFAULT_LEAD_PHRASE } = await import('./agentTeamSwitch');
    expect(normalizeLeadPhrase('  리드  에이전트로 진행해줘 ')).toEqual({ ok: true, value: '리드 에이전트로 진행해줘' });
    expect(normalizeLeadPhrase('ab')).toEqual({ ok: true, value: 'ab' });
    expect(normalizeLeadPhrase('a')).toEqual({ ok: false, error: 'length' });
    expect(normalizeLeadPhrase('   ')).toEqual({ ok: false, error: 'length' });
    expect(normalizeLeadPhrase('가'.repeat(60)).ok).toBe(true);
    expect(normalizeLeadPhrase('가'.repeat(61))).toEqual({ ok: false, error: 'length' });
    expect(normalizeLeadPhrase('two\nlines')).toEqual({ ok: false, error: 'chars' });
    expect(normalizeLeadPhrase('zero\u200bwidth')).toEqual({ ok: false, error: 'chars' });
    expect(normalizeLeadPhrase('bidi\u202eoverride')).toEqual({ ok: false, error: 'chars' });
    expect(normalizeLeadPhrase(42)).toEqual({ ok: false, error: 'length' });
    expect(readLeadPhrase(undefined)).toBe(DEFAULT_LEAD_PHRASE);
    expect(readLeadPhrase({ leadPhrase: 'x' })).toBe(DEFAULT_LEAD_PHRASE);
    expect(readLeadPhrase({ leadPhrase: ' 팀장 모드 ' })).toBe('팀장 모드');
  });
});
