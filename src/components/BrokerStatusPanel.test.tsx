// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrokerStatusPanel, formatCycleElapsed } from './BrokerStatusPanel';

describe('BrokerStatusPanel', () => {
  it('does not contain a UTF-8 BOM or committed mojibake markers', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/BrokerStatusPanel.tsx'), 'utf8');

    expect(source.charCodeAt(0)).not.toBe(0xfeff);
    expect(source).not.toMatch(/[\uFFFD\u0080-\u009F]/);
    expect(source).not.toMatch(/(^|\s|\/\/|\/\*)\?\?[A-Za-z]|[A-Za-z]\?\?[A-Za-z]/);
    expect(source).not.toMatch(/[\uC338\uBD31]/);
  });

  it('shows the current broker cycle, reason, action, and risk signals in English', () => {
    render(
      <BrokerStatusPanel
        status={{
          cycle: 'reviewing',
          cycleLabel: 'Reviewing',
          reason: 'developer DONE - ready for review',
          action: 'review',
          directionOk: false,
          grownLoc: 12,
        }}
      />,
    );

    expect(screen.getByText('3. Reviewing').className).toContain('current');
    expect(screen.getByText('+12 LOC')).toBeTruthy();
    expect(screen.getByText('review')).toBeTruthy();
    expect(screen.getByText('off-track')).toBeTruthy();
    expect(screen.getByTitle('developer DONE - ready for review')).toBeTruthy();
  });

  it('uses Korean cycle chrome and close tooltip when requested', () => {
    const onClose = vi.fn();
    render(
      <BrokerStatusPanel
        lang="ko"
        onClose={onClose}
        status={{
          cycle: 'addressing',
          cycleLabel: '재작업 중',
          reason: '리워크 반영 대기',
          action: 'review',
          directionOk: false,
        }}
      />,
    );

    expect(screen.getByText('5. 재작업 중').className).toContain('current');
    expect(screen.getByText('방향 이탈')).toBeTruthy();
    fireEvent.click(screen.getByTitle('숨기기'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('formats the elapsed-in-state label (quiet under a minute, m, then h+m)', () => {
    expect(formatCycleElapsed(30_000, 'en')).toBe('');
    expect(formatCycleElapsed(5 * 60_000, 'en')).toBe('5m');
    expect(formatCycleElapsed(5 * 60_000, 'ko')).toBe('5분');
    expect(formatCycleElapsed(90 * 60_000, 'en')).toBe('1h 30m');
    expect(formatCycleElapsed(90 * 60_000, 'ko')).toBe('1시간 30분');
    expect(formatCycleElapsed(-5, 'en')).toBe('');
  });

  it('shows an elapsed chip for a long-running state and hides it for a fresh one', () => {
    const { unmount } = render(
      <BrokerStatusPanel
        status={{
          cycle: 'reviewing',
          cycleLabel: 'Reviewing',
          reason: 'waiting on the reviewer',
          at: Date.now() - 5 * 60_000,
        }}
      />,
    );
    expect(screen.getByTitle('Time in the current step').textContent).toContain('5m');
    unmount();

    render(
      <BrokerStatusPanel
        status={{
          cycle: 'reviewing',
          cycleLabel: 'Reviewing',
          reason: 'just started',
          at: Date.now(),
        }}
      />,
    );
    expect(screen.queryByTitle('Time in the current step')).toBeNull();
  });
});
