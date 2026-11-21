import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type OctoConfig } from '../config/schema';

const h = vi.hoisted(() => ({
  enabled: true as boolean | undefined,
  language: 'en',
  update: vi.fn(),
}));

vi.mock('../config/ConfigContext', () => ({
  useConfig: () => ({
    config: { ...DEFAULT_CONFIG, language: h.language, agents: { ...DEFAULT_CONFIG.agents, enabled: h.enabled } },
    updateConfig: h.update,
  }),
}));

import { AgentTeamSwitch } from './AgentTeamSwitch';

afterEach(() => cleanup());
beforeEach(() => { h.enabled = true; h.language = 'en'; h.update.mockReset(); });

describe('Settings → Agent team in tabs', () => {
  it('shows the switch on by default and says Claude Code subagents are not affected', () => {
    render(<AgentTeamSwitch />);
    const box = screen.getByLabelText('Agent team in tabs') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText(/team board and tasks, and the team status view/)).toBeTruthy();
    expect(screen.getByText(/does not affect Claude Code's own subagents/)).toBeTruthy();
    expect(screen.getByText(/does not stop child agents that are already running: stop them with the red stop-team button/)).toBeTruthy();
  });

  it('turning it off writes agents.enabled = false and keeps the other agents settings', () => {
    render(<AgentTeamSwitch />);
    fireEvent.click(screen.getByLabelText('Agent team in tabs'));
    expect(h.update).toHaveBeenCalledTimes(1);
    const updater = h.update.mock.calls[0][0] as (prev: OctoConfig) => OctoConfig;
    const prev = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, maxChildren: 3 } };
    const next = updater(prev);
    expect(next.agents).toEqual({ ...prev.agents, enabled: false });
  });

  it('shows off when saved off, and turning it on writes true', () => {
    h.enabled = false;
    render(<AgentTeamSwitch />);
    const box = screen.getByLabelText('Agent team in tabs') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    const updater = h.update.mock.calls[0][0] as (prev: OctoConfig) => OctoConfig;
    expect(updater(DEFAULT_CONFIG).agents.enabled).toBe(true);
  });

  it('Korean label', () => {
    h.language = 'ko';
    render(<AgentTeamSwitch />);
    expect(screen.getByLabelText('탭으로 에이전트 팀 쓰기')).toBeTruthy();
  });
});

describe('Settings → Lead agent phrase', () => {
  it('saves a valid edited phrase on Enter, normalised', () => {
    render(<AgentTeamSwitch />);
    const input = screen.getByLabelText('Lead agent phrase') as HTMLInputElement;
    expect(input.value).toBe('리드 에이전트로 진행해줘');
    fireEvent.change(input, { target: { value: '  팀장   모드로 해줘 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const updater = h.update.mock.calls[0][0] as (prev: OctoConfig) => OctoConfig;
    expect(updater(DEFAULT_CONFIG).agents.leadPhrase).toBe('팀장 모드로 해줘');
  });

  it('shows why an invalid phrase is not saved and keeps the old one', () => {
    render(<AgentTeamSwitch />);
    const input = screen.getByLabelText('Lead agent phrase');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert').textContent).toMatch(/2 to 60 characters/);
    fireEvent.change(input, { target: { value: 'zero\u200bwidth' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert').textContent).toMatch(/invisible characters/);
    expect(h.update).not.toHaveBeenCalled();
  });
});
