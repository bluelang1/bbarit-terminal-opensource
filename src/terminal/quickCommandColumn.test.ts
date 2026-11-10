import { describe, expect, it } from 'vitest';
import { DEFAULT_QUICK_COMMANDS } from '../config/schema';
import { quickCommandColumn, quickCommandDisplayName } from './quickCommandColumn';

const qc = (id: string, command: string, name = `cmd${id}`) => ({ id, name, command, icon: 'Zap' });

describe('quick command column', () => {
  it('default config: the !! entry is rerun, the empty one is hidden', () => {
    const { rerun, custom } = quickCommandColumn(DEFAULT_QUICK_COMMANDS);
    expect(rerun?.name).toBe('다시실행해');
    expect(custom.map((c) => c.name)).toEqual(['컴파일해']);
  });

  it('has no rerun slot without a !! entry', () => {
    const { rerun, custom } = quickCommandColumn([qc('a', 'ls'), qc('b', 'pwd')]);
    expect(rerun).toBeUndefined();
    expect(custom.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('takes the first !! entry as rerun and keeps a second one in custom', () => {
    const { rerun, custom } = quickCommandColumn([qc('a', 'ls'), qc('b', ' !! '), qc('c', '!!')]);
    expect(rerun?.id).toBe('b');
    expect(custom.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('hides whitespace-only commands', () => {
    const { rerun, custom } = quickCommandColumn([qc('a', '   '), qc('b', '\n\t'), qc('c', 'make')]);
    expect(rerun).toBeUndefined();
    expect(custom.map((c) => c.id)).toEqual(['c']);
  });

  it('preserves config order', () => {
    const { custom } = quickCommandColumn([qc('z', 'z'), qc('a', 'a'), qc('m', 'm'), qc('r', '!!')]);
    expect(custom.map((c) => c.id)).toEqual(['z', 'a', 'm']);
  });

  it('handles a missing list', () => {
    expect(quickCommandColumn(undefined)).toEqual({ rerun: undefined, custom: [] });
  });
});

describe('quick command display name', () => {
  const t = (key: never, fallback?: string) => `${key as string}|${fallback}`;
  it('translates the three default names and keeps custom ones', () => {
    expect(quickCommandDisplayName('다시실행해', t)).toBe('settings.terminal.quickCommands.rerun|Run again');
    expect(quickCommandDisplayName('컴파일해', t)).toBe('settings.terminal.quickCommands.compile|Compile');
    expect(quickCommandDisplayName('해줘', t)).toBe('settings.terminal.quickCommands.doIt|Do it');
    expect(quickCommandDisplayName('deploy', t)).toBe('deploy');
  });
});
