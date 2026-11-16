import { describe, expect, it, vi } from 'vitest';
import { callerRefusalMessage, decideCaller, predatesCallerTokens, verifyAgentCaller, type CallerKeyInfo } from './agentCaller';

describe('decideCaller', () => {
  it('no caller: accepted as before, nothing to verify (also without a key)', () => {
    expect(decideCaller({ caller: '', token: '', verified: false, recovered: false })).toEqual({ ok: true, caller: '' });
    expect(decideCaller({ caller: '  ', token: 'abc', verified: false, recovered: false, keyAvailable: false })).toEqual({ ok: true, caller: '' });
  });

  it('caller + matching token: verified', () => {
    expect(decideCaller({ caller: 't1', token: 'abc', verified: true, recovered: false, keyAvailable: true })).toEqual({ ok: true, caller: 't1', verified: true });
  });

  it('caller + wrong token: refused, also for a recovered tab', () => {
    for (const recovered of [false, true]) {
      expect(decideCaller({ caller: 't1', token: 'abc', verified: false, recovered })).toEqual({
        ok: false,
        caller: 't1',
        reason: 'wrong_token',
        error: 'caller not verified: t1 (the token does not match this tab)',
      });
    }
  });

  it('caller + no token: refused with a reopen hint, unless recovered from the PTY holder', () => {
    const refused = decideCaller({ caller: 't1', token: '', verified: false, recovered: false });
    expect(refused).toMatchObject({ ok: false, reason: 'missing_token' });
    expect(refused.ok === false && refused.error).toMatch(/^caller not verified: t1 \(no caller token: .*open a new one\)$/);
    expect(decideCaller({ caller: 't1', token: '', verified: false, recovered: true })).toEqual({ ok: true, caller: 't1', verified: 'legacy' });
  });

  it('key unavailable: refused with its own message, no legacy pass and no token pass', () => {
    for (const input of [
      { token: '', verified: false, recovered: true },
      { token: 'abc', verified: true, recovered: false },
    ]) {
      const d = decideCaller({ caller: 't1', ...input, keyAvailable: false, keyFile: 'agent-relay.dev.key' });
      expect(d).toMatchObject({ ok: false, reason: 'key_unavailable' });
      expect(d.ok === false && d.error).toMatch(/^caller verification unavailable: cannot read the relay key ~\/\.config\/octo\/agent-relay\.dev\.key /);
      expect(d.ok === false && d.error).not.toContain('app update');
    }
  });

  it('refusal messages name the caller', () => {
    expect(callerRefusalMessage('x9', 'wrong_token')).toContain('x9');
    expect(callerRefusalMessage('x9', 'missing_token')).toContain('x9');
  });
});

describe('verifyAgentCaller', () => {
  const KEY: CallerKeyInfo = { available: true, sinceMs: 2_000, file: 'agent-relay.key' };
  const deps = (ok: boolean | Error, entry?: { exited?: boolean; started_at?: number }, info: CallerKeyInfo | Error = KEY) => ({
    keyInfo: vi.fn(async () => { if (info instanceof Error) throw info; return info; }),
    verify: vi.fn(async () => { if (ok instanceof Error) throw ok; return ok; }),
    recoveredEntry: vi.fn(() => entry),
  });
  const OLD_SHELL = { exited: false, started_at: 1_000 };

  it('asks Rust only when a token was sent, with the trimmed caller and token', async () => {
    const d = deps(true);
    expect(await verifyAgentCaller({ caller: ' t1 ', callerToken: ' tok ' }, d)).toEqual({ ok: true, caller: 't1', verified: true });
    expect(d.verify).toHaveBeenCalledWith('t1', 'tok');
    const none = deps(true);
    expect(await verifyAgentCaller({}, none)).toEqual({ ok: true, caller: '' });
    expect(await verifyAgentCaller(null, none)).toEqual({ ok: true, caller: '' });
    expect(none.verify).not.toHaveBeenCalled();
    expect(none.keyInfo).not.toHaveBeenCalled();
  });

  it('a wrong token, a non-string token or a failed check is refused', async () => {
    expect(await verifyAgentCaller({ caller: 't1', callerToken: 'bad' }, deps(false))).toMatchObject({ ok: false, reason: 'wrong_token' });
    expect(await verifyAgentCaller({ caller: 't1', callerToken: 'tok' }, deps(new Error('invoke failed')))).toMatchObject({ ok: false, reason: 'wrong_token' });
    // A recovered tab gets no pass for a wrong token.
    expect(await verifyAgentCaller({ caller: 't1', callerToken: 'bad' }, deps(false, OLD_SHELL))).toMatchObject({ ok: false, reason: 'wrong_token' });
    const d = deps(true);
    expect(await verifyAgentCaller({ caller: 't1', callerToken: 42 }, d)).toMatchObject({ ok: false, reason: 'missing_token' });
    expect(d.verify).not.toHaveBeenCalled();
  });

  it('no token: legacy only for a holder shell started before the key, refused otherwise', async () => {
    expect(await verifyAgentCaller({ caller: 't1' }, deps(false, OLD_SHELL))).toEqual({ ok: true, caller: 't1', verified: 'legacy' });
    expect(await verifyAgentCaller({ caller: 't1', callerToken: '' }, deps(false))).toMatchObject({ ok: false, reason: 'missing_token' });
    // Shells this app run started are listed with started_at 0 (webview reload): no pass.
    expect(await verifyAgentCaller({ caller: 't1' }, deps(false, { exited: false, started_at: 0 }))).toMatchObject({ ok: false, reason: 'missing_token' });
    expect(await verifyAgentCaller({ caller: 't1' }, deps(false, { exited: false, started_at: 5_000 }))).toMatchObject({ ok: false, reason: 'missing_token' });
  });

  it('key unavailable (or its lookup failing): refused, never legacy, token not checked', async () => {
    for (const info of [{ available: false, file: 'agent-relay.key' } as CallerKeyInfo, new Error('invoke failed')]) {
      const d = deps(true, OLD_SHELL, info);
      expect(await verifyAgentCaller({ caller: 't1' }, d)).toMatchObject({ ok: false, reason: 'key_unavailable' });
      expect(await verifyAgentCaller({ caller: 't1', callerToken: 'tok' }, d)).toMatchObject({ ok: false, reason: 'key_unavailable' });
      expect(d.verify).not.toHaveBeenCalled();
      expect(await verifyAgentCaller({}, d)).toEqual({ ok: true, caller: '' });
    }
  });

  it('caps an oversized token before it reaches Rust', async () => {
    const d = deps(false);
    await verifyAgentCaller({ caller: 't1', callerToken: 'a'.repeat(10_000) }, d);
    expect((d.verify.mock.calls[0] as unknown as [string, string])[1].length).toBe(128);
  });

  it('a failing recovery lookup counts as not recovered', async () => {
    const d = { ...deps(true), recoveredEntry: vi.fn(() => { throw new Error('x'); }) };
    expect(await verifyAgentCaller({ caller: 't1' }, d)).toMatchObject({ ok: false, reason: 'missing_token' });
  });
});

describe('predatesCallerTokens', () => {
  it('only a running holder shell with a known start before a known key time counts', () => {
    expect(predatesCallerTokens({ exited: false, started_at: 1_000 }, 2_000)).toBe(true);
    expect(predatesCallerTokens({ exited: false, started_at: 2_000 }, 2_000)).toBe(false);
    expect(predatesCallerTokens({ exited: false, started_at: 3_000 }, 2_000)).toBe(false);
    expect(predatesCallerTokens({ exited: true, started_at: 1_000 }, 2_000)).toBe(false);
    expect(predatesCallerTokens(undefined, 2_000)).toBe(false);
    // started_at 0 / missing = not known (holder client lists this run's shells that way).
    expect(predatesCallerTokens({ exited: false, started_at: 0 }, 2_000)).toBe(false);
    expect(predatesCallerTokens({ exited: false }, 2_000)).toBe(false);
    // Unknown key time (none, or a replaced malformed key with time 0): no pass.
    expect(predatesCallerTokens({ exited: false, started_at: 1_000 }, null)).toBe(false);
    expect(predatesCallerTokens({ exited: false, started_at: 1_000 }, 0)).toBe(false);
  });
});

describe('App wiring', () => {
  it('every agent.* command that reads caller goes through checkAgentCaller', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    // No raw read of the caller id is left.
    expect(app).not.toMatch(/request\?\.caller\b/);
    const caseBody = (name: string) => {
      const start = app.indexOf(`case '${name}':`);
      expect(start).toBeGreaterThan(0);
      return app.slice(start, app.indexOf('\n      case ', start + 10));
    };
    for (const name of ['agent.run', 'agent.send', 'agent.stop', 'agent.list']) {
      expect(caseBody(name)).toContain('await checkAgentCaller(request, cmd)');
    }
    // agent.status falls through to agent.list's body.
    expect(app).toMatch(/case 'agent\.status':\s*case 'agent\.list': \{/);
    const run = caseBody('agent.run');
    // The async check comes before the synchronous limit check + reservation.
    expect(run.indexOf('checkAgentCaller(')).toBeLessThan(run.indexOf('agentRunReservationsRef.current.reserve('));
    expect(app).toContain("event: 'caller_refused'");
    // The token never reaches the relay log.
    expect(app).not.toMatch(/callerToken[^\n]*logAgentRelay|logAgentRelay\([^)]*callerToken/);
  });
});
