// useHintMode wired to a real (jsdom) DOM: open, type, activate, cancel, focus return.
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHintMode, type HintModeApi } from './useHintMode';
import { isHintModeActive } from './hintModeFlag';

const api: { current: HintModeApi | null } = { current: null };
function Harness() {
  const hints = useHintMode();
  api.current = hints;
  return <>{hints.overlay}</>;
}

const place = (el: Element, left: number, top: number, width: number, height: number) => {
  (el as HTMLElement).getBoundingClientRect = () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
  }) as DOMRect;
};

let fixture: HTMLDivElement;
let input: HTMLTextAreaElement;
const clicks: string[] = [];

beforeEach(() => {
  clicks.length = 0;
  fixture = document.createElement('div');
  fixture.innerHTML = `
    <div id="proj-a" data-hint="project" data-project-tab-id="a" role="button"></div>
    <div id="proj-b" data-hint="project" data-project-tab-id="b" role="button"></div>
    <div id="pane" data-terminal-wrap><textarea id="term-input"></textarea></div>
    <button id="close" class="tab-close"></button>`;
  document.body.appendChild(fixture);
  place(fixture.querySelector('#proj-a')!, 0, 40, 100, 20);
  place(fixture.querySelector('#proj-b')!, 0, 60, 100, 20);
  place(fixture.querySelector('#pane')!, 120, 40, 500, 300);
  place(fixture.querySelector('#close')!, 700, 5, 12, 12);
  for (const el of Array.from(fixture.querySelectorAll('[id]'))) {
    el.addEventListener('click', () => clicks.push(el.id));
  }
  input = fixture.querySelector('#term-input')!;
  input.focus();
});

afterEach(() => {
  fixture.remove();
  api.current = null;
});

const press = (code: string, key: string, extra: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true, ...extra });
  act(() => { window.dispatchEvent(event); });
  return event;
};

const badges = () => Array.from(document.querySelectorAll<HTMLElement>('.hint-overlay .hint-badge'));
const visibleBadges = () => badges().filter((b) => b.dataset.hidden !== 'true').map((b) => b.textContent);

describe('useHintMode', () => {
  it('shows labelled badges by kind and parks focus', () => {
    render(<Harness />);
    act(() => api.current!.open());
    expect(isHintModeActive()).toBe(true);
    expect(badges().map((b) => [b.textContent, b.dataset.kind, b.dataset.placement])).toEqual([
      ['1', 'project', 'corner'],
      ['2', 'project', 'corner'],
      ['3', 'terminal', 'bottom-left'],
      ['4', 'danger', 'corner'],
    ]);
    expect(document.activeElement).not.toBe(input);
  });

  it('activates by event.code even when the IME reports Hangul, then closes', () => {
    render(<Harness />);
    act(() => api.current!.open());
    const event = press('Digit2', 'ㅂ');
    expect(event.defaultPrevented).toBe(true);
    expect(clicks).toEqual(['proj-b']);
    expect(api.current!.active).toBe(false);
    expect(isHintModeActive()).toBe(false);
    expect(badges()).toHaveLength(0);
  });

  it('swallows keys so window listeners added later never see them', () => {
    render(<Harness />);
    act(() => api.current!.open());
    const later = vi.fn();
    window.addEventListener('keydown', later, true);
    press('KeyQ', 'q');
    window.removeEventListener('keydown', later, true);
    expect(later).not.toHaveBeenCalled();
  });

  it('Esc closes without clicking and gives focus back to the terminal input', () => {
    render(<Harness />);
    act(() => api.current!.open());
    press('Escape', 'Escape');
    expect(clicks).toEqual([]);
    expect(api.current!.active).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('an unmatched key closes without clicking; modifier-only keys keep it open', () => {
    render(<Harness />);
    act(() => api.current!.open());
    press('ShiftLeft', 'Shift', { shiftKey: true });
    expect(api.current!.active).toBe(true);
    press('KeyX', 'x');
    expect(api.current!.active).toBe(false);
    expect(clicks).toEqual([]);
    expect(document.activeElement).toBe(input);
  });

  it('toggle closes an open hint mode', () => {
    render(<Harness />);
    act(() => api.current!.toggle());
    expect(api.current!.active).toBe(true);
    act(() => api.current!.toggle());
    expect(api.current!.active).toBe(false);
  });

  it('closes on mouse down, resize and page scroll but not on terminal scroll', () => {
    render(<Harness />);
    act(() => api.current!.open());
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    fixture.appendChild(xterm);
    act(() => { xterm.dispatchEvent(new Event('scroll')); });
    expect(api.current!.active).toBe(true);
    act(() => { fixture.dispatchEvent(new Event('scroll')); });
    expect(api.current!.active).toBe(false);

    act(() => api.current!.open());
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(api.current!.active).toBe(false);

    act(() => api.current!.open());
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(api.current!.active).toBe(false);
  });

  it('narrows two-character labels and backspace widens again', () => {
    for (let i = 0; i < 40; i += 1) {
      const b = document.createElement('button');
      b.id = `extra-${i}`;
      fixture.appendChild(b);
      place(b, 10 * i, 500, 8, 8);
      b.addEventListener('click', () => clicks.push(b.id));
    }
    render(<Harness />);
    act(() => api.current!.open());
    expect(badges()).toHaveLength(44);
    press('KeyZ', 'z');
    expect(visibleBadges().every((text) => text?.startsWith('z'))).toBe(true);
    expect(visibleBadges().length).toBeGreaterThan(1);
    press('Backspace', 'Backspace');
    expect(visibleBadges()).toHaveLength(44);
    press('KeyZ', 'z');
    press('Digit1', '1');
    expect(clicks).toHaveLength(1);
    expect(api.current!.active).toBe(false);
  });
});
