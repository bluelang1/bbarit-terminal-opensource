// useGuideHost with Tauri present (mocked): startup opening and early reset.
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  openGuideWindow: vi.fn(async (_opts: unknown) => true),
  version: '1.1.66',
  kvGetJSONGate: null as null | Promise<void>,
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => h.version }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ unminimize: async () => {}, setFocus: async () => {} }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: async () => {},
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => { h.listeners.set(name, cb); return () => {}; },
}));
vi.mock('./openGuide', () => ({ openGuideWindow: h.openGuideWindow }));
vi.mock('../hooks/useKV', () => ({
  kvGet: async (k: string) => h.kv.get(k) ?? null,
  kvSet: async (k: string, v: string) => { h.kv.set(k, v); },
  kvGetJSON: async (k: string, fb: unknown) => {
    if (h.kvGetJSONGate) await h.kvGetJSONGate;
    const raw = h.kv.get(k);
    return raw == null ? fb : JSON.parse(raw);
  },
  kvSetJSON: async (k: string, v: unknown) => { h.kv.set(k, JSON.stringify(v)); },
}));

import { useGuideHost, type GuideHostInput } from './useGuideHost';
import { GUIDE_FIRSTRUN_KEY, GUIDE_PROGRESS_KEY, LAST_SEEN_VERSION_KEY } from './steps';

const base: GuideHostInput = {
  enabled: true,
  debugBuild: () => false,
  t: (k) => k,
  openSettingsTerminal: () => {},
  projectCount: 0,
  agentTabCount: 0,
  statusTabCount: 0,
  gitPanelOpen: false,
};

const opened = () => h.openGuideWindow.mock.calls.map(c => c[0] as { mode: string; step?: string; from?: string | null });
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });

describe('useGuideHost runStartup', () => {
  beforeEach(() => {
    h.kv.clear();
    h.listeners.clear();
    h.openGuideWindow.mockReset();
    h.openGuideWindow.mockImplementation(async () => true);
    h.kvGetJSONGate = null;
    h.version = '1.1.66';
    document.body.innerHTML = '<div data-guide="new-project-folder"></div>';
  });

  it('debug build opens nothing and writes nothing', async () => {
    const { result } = renderHook(() => useGuideHost({ ...base, debugBuild: () => true }));
    act(() => result.current.runStartup(0));
    await settle();
    expect(h.openGuideWindow).not.toHaveBeenCalled();
    expect(h.kv.has(GUIDE_FIRSTRUN_KEY)).toBe(false);
    expect(h.kv.has(LAST_SEEN_VERSION_KEY)).toBe(false);
  });

  it('fresh install opens only the guide, then records first run and version', async () => {
    const { result } = renderHook(() => useGuideHost(base));
    act(() => result.current.runStartup(0));
    await waitFor(() => expect(h.kv.get(LAST_SEEN_VERSION_KEY)).toBe('1.1.66'));
    expect(opened().map(o => o.mode)).toEqual(['start']);
    expect(opened()[0].step).toBe('project');
    expect(h.kv.get(GUIDE_FIRSTRUN_KEY)).toBe('1');
  });

  it('update opens only What\'s new from the last seen version', async () => {
    h.kv.set(LAST_SEEN_VERSION_KEY, '1.1.64');
    const { result } = renderHook(() => useGuideHost(base));
    act(() => result.current.runStartup(3));
    await waitFor(() => expect(h.kv.get(LAST_SEEN_VERSION_KEY)).toBe('1.1.66'));
    expect(opened()).toEqual([expect.objectContaining({ mode: 'whatsnew', from: '1.1.64' })]);
    expect(h.kv.has(GUIDE_FIRSTRUN_KEY)).toBe(false);
  });

  it('nothing new: no window, but the version is recorded', async () => {
    h.kv.set(LAST_SEEN_VERSION_KEY, '1.1.66');
    const { result } = renderHook(() => useGuideHost(base));
    act(() => result.current.runStartup(3));
    await settle();
    expect(h.openGuideWindow).not.toHaveBeenCalled();
    expect(h.kv.get(LAST_SEEN_VERSION_KEY)).toBe('1.1.66');
  });

  it('a failed open records nothing, so the next start retries', async () => {
    h.openGuideWindow.mockImplementation(async () => false);
    const { result } = renderHook(() => useGuideHost(base));
    act(() => result.current.runStartup(0));
    await settle();
    expect(h.openGuideWindow).toHaveBeenCalledTimes(1);
    expect(h.kv.has(GUIDE_FIRSTRUN_KEY)).toBe(false);
    expect(h.kv.has(LAST_SEEN_VERSION_KEY)).toBe(false);
  });

  it('runs once per session', async () => {
    const { result } = renderHook(() => useGuideHost(base));
    act(() => { result.current.runStartup(0); result.current.runStartup(0); });
    await settle();
    expect(h.openGuideWindow).toHaveBeenCalledTimes(1);
  });
});

describe('useGuideHost reset', () => {
  beforeEach(() => { h.kv.clear(); h.listeners.clear(); });

  it('guide-reset before stored progress loads still clears it', async () => {
    h.kv.set(GUIDE_PROGRESS_KEY, JSON.stringify({ project: 1, pet: 2 }));
    let release!: () => void;
    h.kvGetJSONGate = new Promise<void>(r => { release = r; });
    renderHook(() => useGuideHost(base));
    await waitFor(() => expect(h.listeners.has('guide-reset')).toBe(true));
    act(() => h.listeners.get('guide-reset')!({ payload: undefined }));
    await act(async () => { release(); await new Promise(r => setTimeout(r, 10)); });
    expect(JSON.parse(h.kv.get(GUIDE_PROGRESS_KEY)!)).toEqual({});
  });
});
