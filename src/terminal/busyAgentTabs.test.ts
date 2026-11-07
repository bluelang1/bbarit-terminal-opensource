import { describe, expect, it } from 'vitest';
import { collectBusyAgentTabs, formatBusyAgentWarning, updateInterruptsTerminals } from './busyAgentTabs';

const projects = [
  { id: 'p1', name: 'Proj', terminals: [
    { id: 'a', name: 'Claude', cliType: 'claude' },
    { id: 'b', name: 'Shell', cliType: 'shell' },
    { id: 'c', name: 'Codex', cliType: 'codex' },
    { id: 'd', name: 'Idle', cliType: 'claude' },
    { id: 'e', name: 'Done', cliType: 'claude' },
  ] },
];
const states: Record<string, 'working' | 'blocked' | 'done' | 'idle'> = { a: 'working', b: 'working', c: 'blocked', d: 'idle', e: 'done' };

describe('busyAgentTabs', () => {
  it('update interrupts terminals only without the PTY holder', () => {
    expect(updateInterruptsTerminals('holder')).toBe(false);
    expect(updateInterruptsTerminals('in-process')).toBe(true);
  });
  it('collects working/blocked agent tabs only', () => {
    expect(collectBusyAgentTabs(projects, (id) => states[id])).toEqual([
      { projectName: 'Proj', terminalName: 'Claude', state: 'working' },
      { projectName: 'Proj', terminalName: 'Codex', state: 'blocked' },
    ]);
  });
  it('formats ko', () => {
    const w = formatBusyAgentWarning(collectBusyAgentTabs(projects, (id) => states[id]), 'ko');
    expect(w.title).toBe('작업 중인 에이전트 탭 2개');
    expect(w.message).toContain('• Proj · Claude — 작업 중');
    expect(w.message).toContain('• Proj · Codex — 입력 대기');
    expect(w.message).toContain('지금 업데이트하면 이 작업들이 중단됩니다. 계속할까요?');
  });
  it('formats en and caps at 5 lines', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ projectName: 'P', terminalName: `T${i}`, state: 'working' as const }));
    const w = formatBusyAgentWarning(items, 'en');
    expect(w.title).toBe('8 agent tabs still active');
    expect(w.message.split('\n').filter((l) => l.startsWith('• '))).toHaveLength(5);
    expect(w.message).toContain('+3 more');
    expect(w.message).toContain('Continue?');
  });
});
