// Spotlight with Tauri present (mocked): every way of closing it un-pins the guide window.
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  guideBox: { x: 2000, y: 0, w: 900, h: 620 },
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setFocus: async () => {},
    innerPosition: async () => ({ x: 0, y: 0 }),
    scaleFactor: async () => 1,
  }),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: {
    getByLabel: async () => ({
      setAlwaysOnTop: async (on: boolean) => { h.calls.push(`top:${on}`); },
      setFocus: async () => { h.calls.push('focus'); },
      outerPosition: async () => ({ x: h.guideBox.x, y: h.guideBox.y }),
      outerSize: async () => ({ width: h.guideBox.w, height: h.guideBox.h }),
      scaleFactor: async () => 1,
    }),
  },
}));

import { Spotlight } from './Spotlight';
import { GUIDE_STEPS } from './steps';

const git = GUIDE_STEPS.find(s => s.id === 'git-keys')!;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); });

function addTarget() {
  const el = document.createElement('button');
  el.setAttribute('data-guide', 'git');
  el.getBoundingClientRect = () => ({ x: 100, y: 10, left: 100, top: 10, width: 30, height: 20, right: 130, bottom: 30, toJSON() { return {}; } }) as DOMRect;
  document.body.appendChild(el);
}

async function mount() {
  const onClose = vi.fn();
  const view = render(<Spotlight step={git} t={(k) => k} onClose={onClose} />);
  await flush();
  return { view, onClose };
}

describe('Spotlight guide window pinning', () => {
  beforeEach(() => { h.calls = []; h.guideBox = { x: 2000, y: 0, w: 900, h: 620 }; addTarget(); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

  it('pins a guide beside the target, and Esc un-pins it', async () => {
    const { onClose } = await mount();
    expect(h.calls).toEqual(['top:true']);
    fireEvent.keyDown(window, { key: 'Escape' });
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.calls.slice(-2)).toEqual(['top:false', 'focus']);
  });

  it('a click un-pins it', async () => {
    await mount();
    fireEvent.click(document.body);
    await flush();
    expect(h.calls.slice(-2)).toEqual(['top:false', 'focus']);
  });

  it('the timeout un-pins it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { onClose } = await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6100); });
    await flush();
    expect(onClose).toHaveBeenCalled();
    expect(h.calls.slice(-2)).toEqual(['top:false', 'focus']);
  });

  it('unmounting without a close un-pins it', async () => {
    const { view, onClose } = await mount();
    view.unmount();
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(h.calls.slice(-2)).toEqual(['top:false', 'focus']);
  });

  it('never pins a guide that covers the target', async () => {
    h.guideBox = { x: 50, y: 0, w: 900, h: 620 };
    await mount();
    expect(h.calls).not.toContain('top:true');
    fireEvent.keyDown(window, { key: 'Escape' });
    await flush();
    expect(h.calls).toEqual(['top:false', 'focus']);
  });
});
