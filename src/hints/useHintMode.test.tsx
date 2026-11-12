// useHintMode wired to a real (jsdom) DOM: open, type, activate, cancel, focus return.
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHintMode, type HintModeApi } from './useHintMode';
import { isHintModeActive } from './hintModeFlag';

const api: { current: HintModeApi | null } = { current: null };
function Harness({ style, size }: { style?: 'raised' | 'flat' | 'dark' | 'byKind'; size?: 'small' | 'normal' }) {
  const hints = useHintMode({ style, size });
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
    <button id="nav" data-hint="nav"></button>
    <button id="plain"></button>`;
  document.body.appendChild(fixture);
  place(fixture.querySelector('#proj-a')!, 0, 40, 100, 20);
  place(fixture.querySelector('#proj-b')!, 0, 60, 100, 20);
  place(fixture.querySelector('#pane')!, 120, 40, 500, 300);
  place(fixture.querySelector('#nav')!, 700, 5, 12, 12);
  place(fixture.querySelector('#plain')!, 600, 5, 12, 12);
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
      ['4', 'nav', 'corner'],
    ]);
    expect(document.activeElement).not.toBe(input);
  });

  it('puts the style and size on the overlay root (defaults raised / small)', () => {
    const { rerender } = render(<Harness />);
    act(() => api.current!.open());
    const root = document.querySelector<HTMLElement>('.hint-overlay')!;
    expect([root.dataset.hintStyle, root.dataset.hintSize]).toEqual(['raised', 'small']);
    rerender(<Harness style="byKind" size="normal" />);
    expect([root.dataset.hintStyle, root.dataset.hintSize]).toEqual(['byKind', 'normal']);
  });

  it('does not open when nothing is tagged', () => {
    fixture.innerHTML = '<button id="only-plain"></button>';
    render(<Harness />);
    act(() => api.current!.open());
    expect(api.current!.active).toBe(false);
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

  it('closes on mouse down, wheel and resize but ignores programmatic scrolls', () => {
    render(<Harness />);
    act(() => api.current!.open());
    act(() => { fixture.dispatchEvent(new Event('scroll')); });
    act(() => { document.dispatchEvent(new Event('scroll')); });
    expect(api.current!.active).toBe(true);
    act(() => { fixture.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); });
    expect(api.current!.active).toBe(false);

    act(() => api.current!.open());
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(api.current!.active).toBe(false);

    act(() => api.current!.open());
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(api.current!.active).toBe(false);
  });

  it('does not give focus back to the old terminal after a project pick', () => {
    render(<Harness />);
    act(() => api.current!.open());
    press('Digit2', '2');
    expect(clicks).toEqual(['proj-b']);
    expect(document.activeElement).not.toBe(input);
  });

  it('after a nav pick that takes no focus, returns focus to the terminal on the next frame', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    render(<Harness />);
    act(() => api.current!.open());
    press('Digit4', '4');
    expect(clicks).toEqual(['nav']);
    expect(document.activeElement).not.toBe(input);
    frames.forEach((cb) => cb(0));
    expect(document.activeElement).toBe(input);
    vi.restoreAllMocks();
  });

  it('swallows auto-repeat keydowns and the keyup of the key that closed hint mode', () => {
    render(<Harness />);
    act(() => api.current!.open());
    const repeat = press('KeyZ', 'z', { repeat: true });
    expect(repeat.defaultPrevented).toBe(true);
    expect(api.current!.active).toBe(true);

    press('Digit1', '1');
    expect(api.current!.active).toBe(false);
    const later = vi.fn();
    window.addEventListener('keydown', later, true);
    window.addEventListener('keyup', later, true);
    const held = press('Digit1', '1', { repeat: true });
    const up = new KeyboardEvent('keyup', { code: 'Digit1', key: '1', bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(up); });
    const next = press('Digit1', '1');
    window.removeEventListener('keydown', later, true);
    window.removeEventListener('keyup', later, true);
    expect(held.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    // Only the fresh press after the release gets through.
    expect(later).toHaveBeenCalledTimes(1);
    expect(next.defaultPrevented).toBe(false);
  });

  it('narrows two-character labels and backspace widens again', () => {
    for (let i = 0; i < 40; i += 1) {
      const b = document.createElement('button');
      b.id = `extra-${i}`;
      b.setAttribute('data-hint', 'nav');
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
