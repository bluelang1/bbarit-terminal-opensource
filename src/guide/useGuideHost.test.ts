import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useGuideHost, type GuideHostInput } from './useGuideHost';
import { GUIDE_PROGRESS_KEY } from './steps';

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

const stored = () => JSON.parse(localStorage.getItem(GUIDE_PROGRESS_KEY) || '{}');

describe('useGuideHost', () => {
  beforeEach(() => localStorage.clear());

  it('restored projects and agent tabs tick their steps, keeping stored progress', async () => {
    localStorage.setItem(GUIDE_PROGRESS_KEY, JSON.stringify({ pet: 5 }));
    const { rerender } = renderHook((p: GuideHostInput) => useGuideHost(p), { initialProps: base });
    rerender({ ...base, projectCount: 2, agentTabCount: 1 });
    await waitFor(() => expect(Object.keys(stored()).sort()).toEqual(['ai-terminal', 'pet', 'project']));
    expect(stored().pet).toBe(5);
  });

  it('git panel opening and the first status tick their steps', async () => {
    const { rerender } = renderHook((p: GuideHostInput) => useGuideHost(p), { initialProps: base });
    await act(async () => {});
    rerender({ ...base, gitPanelOpen: true, statusTabCount: 1 });
    await waitFor(() => expect(Object.keys(stored()).sort()).toEqual(['git-keys', 'status']));
  });

  it('a disabled host (harness window) never writes', async () => {
    const { rerender } = renderHook((p: GuideHostInput) => useGuideHost(p), { initialProps: { ...base, enabled: false } });
    rerender({ ...base, enabled: false, projectCount: 3, gitPanelOpen: true });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(localStorage.getItem(GUIDE_PROGRESS_KEY)).toBeNull();
  });

  it('mark keeps the first time', async () => {
    const { result } = renderHook(() => useGuideHost(base));
    await act(async () => {});
    act(() => result.current.mark('status'));
    const first = stored().status;
    act(() => result.current.mark('status'));
    expect(stored().status).toBe(first);
  });
});
