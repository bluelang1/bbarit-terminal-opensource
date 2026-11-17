import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOARD_PG,
  isProtectedConfigPath,
  isValidSchemaName,
  keepProtectedConfig,
  missingPgFields,
  normalizeBoardPg,
  readBoardMode,
  redactProtectedConfig,
} from './agentBoardStorage';

describe('readBoardMode', () => {
  it('reads mode, then the backend alias, and never guesses a server', () => {
    expect(readBoardMode(undefined)).toBe('sqlite');
    expect(readBoardMode({})).toBe('sqlite');
    expect(readBoardMode({ mode: 'sync' })).toBe('sync');
    expect(readBoardMode({ mode: ' Postgres ' })).toBe('postgres');
    expect(readBoardMode({ backend: 'postgres' })).toBe('postgres');
    expect(readBoardMode({ mode: 'sqlite', backend: 'postgres' })).toBe('sqlite');
    expect(readBoardMode({ mode: '', backend: 'postgres' })).toBe('postgres');
    expect(readBoardMode({ mode: 'mongo' })).toBe('sqlite');
    expect(readBoardMode({ backend: 'sync' })).toBe('sqlite');
    expect(readBoardMode({ mode: 3 })).toBe('sqlite');
  });
});

describe('PostgreSQL fields', () => {
  it('normalizes leniently and lists what is missing', () => {
    expect(normalizeBoardPg(undefined)).toEqual(DEFAULT_BOARD_PG);
    const pg = normalizeBoardPg({ host: ' db ', port: '6543', database: 'team', user: 'u', sslMode: 'REQUIRE', schema: '' });
    expect(pg).toEqual({ host: 'db', port: 6543, database: 'team', user: 'u', sslMode: 'require', schema: 'bbarit_board' });
    expect(normalizeBoardPg({ port: 70000, sslMode: 'maybe' })).toMatchObject({ port: 5432, sslMode: 'prefer' });
    expect(missingPgFields(DEFAULT_BOARD_PG)).toEqual(['host', 'database', 'user']);
    expect(missingPgFields(pg)).toEqual([]);
  });

  it('accepts only plain schema names', () => {
    for (const ok of ['bbarit_board', '_x', 'team1', 'a'.repeat(63)]) expect(isValidSchemaName(ok)).toBe(true);
    for (const bad of ['', '1a', 'Board', 'a-b', 'a"b', 'pg_x', 'information_schema', 'a'.repeat(64)]) expect(isValidSchemaName(bad)).toBe(false);
  });
});

describe('agents cannot reach the storage settings through config.get / config.patch', () => {
  const config = {
    terminal: { fontSize: 13 },
    agents: { maxChildren: 4, board: { leaseSeconds: 300, mode: 'postgres', backend: 'postgres', postgres: { host: 'db', user: 'u' } } },
  };

  it('refuses patches of the protected keys and anything inside them', () => {
    expect(isProtectedConfigPath('agents.board.mode')).toBe(true);
    expect(isProtectedConfigPath('agents.board.postgres.host')).toBe(true);
    expect(isProtectedConfigPath(' agents . board . backend ')).toBe(true);
    expect(isProtectedConfigPath('agents.board.leaseSeconds')).toBe(false);
    expect(isProtectedConfigPath('agents.board')).toBe(false);
    expect(isProtectedConfigPath('terminal.fontSize')).toBe(false);
  });

  it('a patch of a parent keeps the protected values', () => {
    const patched = { ...config, agents: { maxChildren: 9, board: { leaseSeconds: 60, mode: 'sqlite', postgres: { host: 'evil' } } } };
    const kept = keepProtectedConfig(config, patched);
    expect(kept.agents.board).toEqual({ leaseSeconds: 60, mode: 'postgres', backend: 'postgres', postgres: { host: 'db', user: 'u' } });
    expect(kept.agents.maxChildren).toBe(9);
    // Keys that were not set before stay unset.
    const before = { agents: { board: { leaseSeconds: 300 } } };
    const after = keepProtectedConfig<unknown>(before, { agents: { board: { leaseSeconds: 60, mode: 'postgres' } } });
    expect(after).toEqual({ agents: { board: { leaseSeconds: 60 } } });
    expect(keepProtectedConfig({}, { terminal: { fontSize: 1 } })).toEqual({ terminal: { fontSize: 1 } });
  });

  it('reads leave them out without changing the config', () => {
    const all = redactProtectedConfig(config, '') as typeof config;
    expect(all.agents.board).toEqual({ leaseSeconds: 300 });
    expect(all.terminal.fontSize).toBe(13);
    expect(config.agents.board.mode).toBe('postgres');
    expect(redactProtectedConfig(config.agents, 'agents')).toEqual({ maxChildren: 4, board: { leaseSeconds: 300 } });
    expect(redactProtectedConfig(config.agents.board, 'agents.board')).toEqual({ leaseSeconds: 300 });
    expect(redactProtectedConfig('db', 'agents.board.postgres.host')).toBeUndefined();
    expect(redactProtectedConfig(300, 'agents.board.leaseSeconds')).toBe(300);
  });
});

describe('settings results', () => {
  it('picks the next step after a connection test', async () => {
    const { nextStep, copySource, fillText } = await import('./agentBoardStorage');
    const base = { reachable: true, codeVersion: 2, canCreate: true, canReadWrite: true };
    expect(nextStep({ reachable: false, error: 'refused' })).toBe('checkConnection');
    expect(nextStep({ ...base, schemaVersion: 3 })).toBe('updateApp');
    expect(nextStep({ ...base, schemaVersion: null })).toBe('createTables');
    expect(nextStep({ ...base, schemaVersion: null, canCreate: false })).toBe('askOwner');
    expect(nextStep({ ...base, schemaVersion: 1 })).toBe('upgradeTables');
    expect(nextStep({ ...base, schemaVersion: 2, canReadWrite: false })).toBe('askPrivileges');
    expect(nextStep({ ...base, schemaVersion: 2 })).toBe('ready');
    expect(copySource('postgres')).toBe('sqlite');
    expect(copySource('sqlite')).toBe('postgres');
    expect(copySource('sync')).toBe('postgres');
    expect(fillText('{a} of {b} ({c})', { a: 1, b: 'x' })).toBe('1 of x ({c})');
  });
});

describe('review gaps', () => {
  it('keeps protected values when agents or board are not objects', async () => {
    const { keepProtectedConfig } = await import('./agentBoardStorage');
    const prev = { agents: { board: { mode: 'postgres' } } };
    expect(keepProtectedConfig<unknown>(prev, { agents: 5 })).toEqual({ agents: { board: { mode: 'postgres' } } });
    expect(keepProtectedConfig<unknown>(prev, { agents: { board: 'x' } })).toEqual({ agents: { board: { mode: 'postgres' } } });
    expect(keepProtectedConfig<unknown>({ agents: 'odd' }, { agents: { board: { mode: 'sync' } } })).toEqual({ agents: { board: {} } });
  });

  it('protects the postgres object itself and ignores empty path segments', () => {
    expect(isProtectedConfigPath('agents.board.postgres')).toBe(true);
    expect(isProtectedConfigPath('agents..board.postgres.port')).toBe(true);
    expect(isProtectedConfigPath('.agents.board.mode.')).toBe(true);
    expect(isProtectedConfigPath('')).toBe(false);
  });

  it('reads float and empty ports as the default and postgresql as postgres', () => {
    expect(normalizeBoardPg({ port: 5432.5 }).port).toBe(5432);
    expect(normalizeBoardPg({ port: '' }).port).toBe(5432);
    expect(normalizeBoardPg({ port: 6000.7 }).port).toBe(5432);
    expect(readBoardMode({ mode: 'postgresql' })).toBe('postgres');
    expect(readBoardMode({ backend: 'PostgreSQL' })).toBe('postgres');
  });

  it('a reachable server with an error still asks to check the connection; foreign tables ask for an empty schema', async () => {
    const { nextStep } = await import('./agentBoardStorage');
    expect(nextStep({ reachable: true, error: 'permission denied', codeVersion: 2, schemaVersion: 2, canReadWrite: true })).toBe('checkConnection');
    expect(nextStep({ reachable: true, codeVersion: 2, schemaVersion: null, canCreate: true, foreignTables: ['tasks'] })).toBe('emptySchema');
  });

  it('parses drafts and keeps typed text until Apply', async () => {
    const { parsePgDraft, draftFromPg, sameDraft, pgLabel } = await import('./agentBoardStorage');
    const d = draftFromPg({ ...DEFAULT_BOARD_PG, host: 'db', database: 'x', user: 'u' });
    expect(d.port).toBe('5432');
    expect(parsePgDraft(d)).toEqual({ ok: true, value: { ...DEFAULT_BOARD_PG, host: 'db', database: 'x', user: 'u' } });
    expect(parsePgDraft({ ...d, port: '' })).toEqual({ ok: false, errors: ['port'] });
    expect(parsePgDraft({ ...d, port: '1.5', schema: '' })).toEqual({ ok: false, errors: ['port', 'schema'] });
    expect(parsePgDraft({ ...d, port: '70000' })).toEqual({ ok: false, errors: ['port'] });
    expect(sameDraft(d, { ...d })).toBe(true);
    expect(sameDraft(d, { ...d, host: 'other' })).toBe(false);
    expect(pgLabel({ ...DEFAULT_BOARD_PG, host: 'db', database: 'x', user: 'u' })).toBe('u@db:5432/x');
  });
});
