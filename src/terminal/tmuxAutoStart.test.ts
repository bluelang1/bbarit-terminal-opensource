import { describe, expect, it } from 'vitest';
import { tmuxAutoStartCommand } from './tmuxAutoStart';

describe('tmuxAutoStartCommand', () => {
  it('starts tmux without the terminal scope token on unix', () => {
    expect(tmuxAutoStartCommand('octo-abc123')).toBe('env -u BBARIT_TERM_SCOPE tmux new-session -A -s octo-abc123');
  });

  it('keeps the plain command on Windows', () => {
    expect(tmuxAutoStartCommand('octo-abc123', true)).toBe('tmux new-session -A -s octo-abc123');
  });
});
