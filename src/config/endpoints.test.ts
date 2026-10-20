import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveEndpoints, toWebSocketOrigin } from './endpoints';

describe('resolveEndpoints', () => {
  it('derives every endpoint from the default base URL when nothing is set', () => {
    const e = resolveEndpoints({});
    expect(e.apiBaseUrl).toBe('https://bbarit.com');
    expect(e.productNoticesUrl).toBe('https://bbarit.com/api/products/notices');
    expect(e.loungeWsUrl).toBe('wss://bbarit.com/api/lounge/ws');
    expect(e.agentInstallUrl).toBe('https://bbarit.com/agent/install.sh');
    expect(e.agentInstallCommand).toBe('curl -fsSL https://bbarit.com/agent/install.sh | sh');
    expect(e.releaseRepoMac).toBe('bluelang1/bbarit-terminal-opensource');
    expect(e.releaseRepoWin).toBe('bluelang1/bbarit-terminal-opensource');
  });

  it('derives from a custom base URL and strips trailing slashes', () => {
    const e = resolveEndpoints({ VITE_BBARIT_API_BASE_URL: 'http://localhost:8787/' });
    expect(e.apiBaseUrl).toBe('http://localhost:8787');
    expect(e.productNoticesUrl).toBe('http://localhost:8787/api/products/notices');
    expect(e.loungeWsUrl).toBe('ws://localhost:8787/api/lounge/ws');
    expect(e.agentInstallUrl).toBe('http://localhost:8787/agent/install.sh');
  });

  it('honors explicit overrides over derived values', () => {
    const e = resolveEndpoints({
      VITE_BBARIT_API_BASE_URL: 'https://example.org',
      VITE_BBARIT_NOTICES_URL: 'https://notices.example.org/feed',
      VITE_BBARIT_LOUNGE_WS_URL: 'wss://lounge.example.org/ws',
      VITE_BBARIT_AGENT_INSTALL_URL: 'https://cdn.example.org/install.sh',
      VITE_BBARIT_RELEASE_REPO_MAC: 'acme/terminal',
      VITE_BBARIT_RELEASE_REPO_WIN: 'acme/terminal-win',
    });
    expect(e.productNoticesUrl).toBe('https://notices.example.org/feed');
    expect(e.loungeWsUrl).toBe('wss://lounge.example.org/ws');
    expect(e.agentInstallUrl).toBe('https://cdn.example.org/install.sh');
    expect(e.agentInstallCommand).toBe('curl -fsSL https://cdn.example.org/install.sh | sh');
    expect(e.releaseRepoMac).toBe('acme/terminal');
    expect(e.releaseRepoWin).toBe('acme/terminal-win');
  });

  it.each(['off', 'OFF', '', '   ', 'false', '0'])('disables notices when VITE_BBARIT_NOTICES_URL=%j', (value) => {
    expect(resolveEndpoints({ VITE_BBARIT_NOTICES_URL: value }).productNoticesUrl).toBeNull();
  });

  it('treats blank optional vars as unset', () => {
    const e = resolveEndpoints({ VITE_BBARIT_API_BASE_URL: '  ', VITE_BBARIT_RELEASE_REPO_MAC: '' });
    expect(e.apiBaseUrl).toBe('https://bbarit.com');
    expect(e.releaseRepoMac).toBe('bluelang1/bbarit-terminal-opensource');
  });
});

describe('toWebSocketOrigin', () => {
  it('maps http(s) to ws(s)', () => {
    expect(toWebSocketOrigin('https://bbarit.com')).toBe('wss://bbarit.com');
    expect(toWebSocketOrigin('http://127.0.0.1:3000/')).toBe('ws://127.0.0.1:3000');
  });
});

describe('module constants read import.meta.env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses defaults when env is empty', async () => {
    vi.resetModules();
    const m = await import('./endpoints');
    expect(m.BBARIT_API_BASE_URL).toBe('https://bbarit.com');
    expect(m.PRODUCT_NOTICES_ENABLED).toBe(true);
    expect(m.THREAD_WEB_URL).toBe('https://bbarit.com/thread');
  });

  it('reads VITE_* overrides and the notices off switch', async () => {
    vi.stubEnv('VITE_BBARIT_API_BASE_URL', 'https://fork.example.com/');
    vi.stubEnv('VITE_BBARIT_NOTICES_URL', 'off');
    vi.resetModules();
    const m = await import('./endpoints');
    expect(m.BBARIT_API_BASE_URL).toBe('https://fork.example.com');
    expect(m.LOUNGE_WS_URL).toBe('wss://fork.example.com/api/lounge/ws');
    expect(m.AGENT_INSTALL_COMMAND).toBe('curl -fsSL https://fork.example.com/agent/install.sh | sh');
    expect(m.PRODUCT_NOTICES_URL).toBeNull();
    expect(m.PRODUCT_NOTICES_ENABLED).toBe(false);
    expect(m.THREAD_WEB_URL).toBe('https://fork.example.com/thread');
  });
});
