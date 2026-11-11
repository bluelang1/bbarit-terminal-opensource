import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateHintTarget,
  collectHintTargets,
  findTopHintDialog,
  hintAnchor,
  hintDataKind,
  hintKindOf,
  HINT_CORNER_OFFSET_PX,
  isHintDisabled,
  isHintExcluded,
  isHintHiddenByStyle,
  isHintReachable,
  isRectInViewport,
  orderHintTargets,
  type HintTarget,
} from './hintTargets';

type Box = [left: number, top: number, width: number, height: number];

const place = (el: Element, [left, top, width, height]: Box) => {
  (el as HTMLElement).getBoundingClientRect = () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
  }) as DOMRect;
};

/** Mount HTML; every element with data-box="l,t,w,h" gets that rect. */
const mount = (html: string) => {
  document.body.innerHTML = html;
  for (const el of Array.from(document.querySelectorAll('[data-box]'))) {
    place(el, el.getAttribute('data-box')!.split(',').map(Number) as Box);
  }
};

const ids = (targets: HintTarget[]) => targets.map((t) => t.element.id);

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('kinds', () => {
  it('reads data-hint first, then the project/terminal tab ids, then terminal panes', () => {
    mount(`
      <div id="p" data-hint="project"></div>
      <div id="p2" data-project-tab-id="x"></div>
      <div id="t" data-hint="tab"></div>
      <div id="t2" data-terminal-tab-id="y"></div>
      <div id="w" data-terminal-wrap></div>
      <button id="b" data-hint="nav"></button>
      <button id="tl" data-hint="tool"></button>`);
    expect(['p', 'p2', 't', 't2', 'w', 'b', 'tl'].map((id) => hintKindOf(document.getElementById(id)!)))
      .toEqual(['project', 'project', 'tab', 'tab', 'terminal', 'nav', 'tool']);
  });

  it('maps to data-kind', () => {
    expect(hintDataKind({ kind: 'project' })).toBe('project');
    expect(hintDataKind({ kind: 'terminal' })).toBe('terminal');
    expect(hintDataKind({ kind: 'nav' })).toBe('nav');
  });
});

describe('filters', () => {
  it('excludes the xterm surface and the hint layer, not the terminal pane itself', () => {
    mount(`
      <div id="wrap" data-terminal-wrap><div class="xterm"><button id="in"></button></div><button id="gutter"></button></div>
      <div data-hint-overlay><button id="ov"></button></div>
      <button id="off" data-hint="off"></button>`);
    expect(isHintExcluded(document.getElementById('in')!)).toBe(true);
    expect(isHintExcluded(document.getElementById('ov')!)).toBe(true);
    expect(isHintExcluded(document.getElementById('off')!)).toBe(true);
    expect(isHintExcluded(document.getElementById('wrap')!)).toBe(false);
    expect(isHintExcluded(document.getElementById('gutter')!)).toBe(false);
  });

  it('detects disabled and aria-disabled elements', () => {
    mount(`
      <button id="a" disabled></button>
      <div aria-disabled="true"><span id="b" role="button"></span></div>
      <fieldset disabled><button id="c"></button></fieldset>
      <button id="d"></button>`);
    expect(['a', 'b', 'c', 'd'].map((id) => isHintDisabled(document.getElementById(id)!))).toEqual([true, true, true, false]);
  });

  it('detects hidden styles on the element or an ancestor', () => {
    mount(`
      <div style="display:none"><button id="a"></button></div>
      <div style="opacity:0"><button id="b"></button></div>
      <button id="c" style="visibility:hidden"></button>
      <button id="d" style="pointer-events:none"></button>
      <div style="opacity:0.25"><button id="e"></button></div>`);
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => isHintHiddenByStyle(document.getElementById(id)!, window)))
      .toEqual([true, true, true, true, false]);
  });

  it('checks the viewport', () => {
    const vp = { width: 800, height: 600 };
    expect(isRectInViewport({ left: 10, top: 10, width: 10, height: 10 }, vp)).toBe(true);
    expect(isRectInViewport({ left: -20, top: 10, width: 10, height: 10 }, vp)).toBe(false);
    expect(isRectInViewport({ left: 10, top: 600, width: 10, height: 10 }, vp)).toBe(false);
    expect(isRectInViewport({ left: 795, top: 595, width: 10, height: 10 }, vp)).toBe(true);
  });

  it('accepts an element only when its centre hits it or a descendant', () => {
    mount('<button id="a"><span id="inner"></span></button><div id="cover"></div>');
    const a = document.getElementById('a')!;
    const rect = { left: 0, top: 0, width: 10, height: 10 };
    expect(isHintReachable(a, rect, () => a)).toBe(true);
    expect(isHintReachable(a, rect, () => document.getElementById('inner'))).toBe(true);
    expect(isHintReachable(a, rect, () => document.getElementById('cover'))).toBe(false);
    expect(isHintReachable(a, rect, () => document.body)).toBe(false);
    expect(isHintReachable(a, rect, null)).toBe(true);
  });
});

describe('dialogs', () => {
  it('ignores non-modal role=dialog panels', () => {
    mount('<div role="dialog" style="z-index:50" data-box="0,0,400,300"></div>');
    expect(findTopHintDialog(document, window)).toBeNull();
  });

  it('finds the top-most open modal layer', () => {
    mount(`
      <div id="low" class="modal-overlay" style="z-index:10" data-box="0,0,800,600"></div>
      <div id="high" aria-modal="true" style="z-index:50" data-box="0,0,400,300"></div>
      <div id="hidden" class="confirm-overlay" style="z-index:99;display:none" data-box="0,0,800,600"></div>`);
    expect(findTopHintDialog(document, window)?.id).toBe('high');
  });

  it('returns null without an open modal', () => {
    mount('<div class="modal-overlay" data-box="0,0,0,0"></div>');
    expect(findTopHintDialog(document, window)).toBeNull();
  });
});

describe('order', () => {
  const t = (id: string, kind: HintTarget['kind'], left: number, top: number): HintTarget => {
    const element = document.createElement('div');
    element.id = id;
    return { element, kind, rect: { left, top, width: 10, height: 10 } };
  };

  it('puts toolbar tools after nav controls', () => {
    const ordered = orderHintTargets([
      t('tool-top', 'tool', 0, 0),
      t('nav-low', 'nav', 0, 500),
      t('proj', 'project', 0, 50),
    ]);
    expect(ids(ordered)).toEqual(['proj', 'nav-low', 'tool-top']);
  });

  it('puts projects, then tabs, then panes, then nav controls in reading order', () => {
    const ordered = orderHintTargets([
      t('btn-bottom', 'nav', 0, 500),
      t('pane', 'terminal', 300, 100),
      t('btn-top-right', 'nav', 700, 3),
      t('proj-2', 'project', 0, 50),
      t('tab-1', 'tab', 300, 30),
      t('btn-top-left', 'nav', 100, 0),
      t('proj-1', 'project', 0, 80),
    ]);
    // Projects/tabs keep DOM order (the on-screen list order), not their coordinates.
    expect(ids(ordered)).toEqual(['proj-2', 'proj-1', 'tab-1', 'pane', 'btn-top-left', 'btn-top-right', 'btn-bottom']);
  });
});

describe('collectHintTargets', () => {
  it('collects only tagged navigation targets that are visible, enabled and reachable', () => {
    mount(`
      <button id="hidden" data-hint="nav" style="display:none" data-box="0,0,10,10"></button>
      <button id="zero" data-hint="nav" data-box="0,0,0,0"></button>
      <button id="offscreen" data-hint="nav" data-box="-100,0,10,10"></button>
      <button id="disabled" data-hint="nav" disabled data-box="0,0,10,10"></button>
      <button id="covered" data-hint="nav" data-box="200,200,10,10"></button>
      <button id="ok" data-hint="nav" data-box="500,10,20,10"></button>
      <button id="plain" data-box="300,10,20,10"></button>
      <div id="role" role="button" data-box="300,100,20,10"></div>
      <a id="link" href="#x" data-box="10,300,20,10"></a>
      <button id="close" class="tab-close" title="Close" data-box="140,40,10,10"></button>
      <div id="tab" data-hint="tab" data-terminal-tab-id="t1" data-box="100,40,60,20"></div>
      <div id="header" data-terminal-tab-id="t2" data-box="100,470,60,20"></div>
      <div id="proj" data-hint="project" data-project-tab-id="p1" role="button" data-box="0,40,80,20"></div>
      <div id="pane" data-terminal-wrap data-box="100,60,600,400"><div class="xterm"><button id="xt" data-hint="nav" data-box="110,70,10,10"></button></div></div>
      <button id="nav2" data-hint="nav" data-box="10,550,20,10"></button>`);
    const cover = document.createElement('div');
    document.elementFromPoint = ((x: number, y: number) => {
      if (x === 205 && y === 205) return cover;
      return Array.from(document.querySelectorAll('[data-box]')).reverse().find((el) => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      }) ?? null;
    }) as typeof document.elementFromPoint;
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);

    // Plain buttons, role=button, links, close buttons and split-pane headers are not hinted.
    expect(ids(collectHintTargets(document, window))).toEqual(['proj', 'tab', 'pane', 'ok', 'nav2']);
  });

  it('only hints inside the top-most dialog when one is open', () => {
    mount(`
      <button id="behind" data-hint="nav" data-box="10,10,20,20"></button>
      <div class="modal-overlay" data-box="0,0,800,600"><div role="dialog" data-box="100,100,300,200"><button id="untagged" data-box="120,160,40,20"></button><button id="inside" data-hint="nav" data-box="120,120,40,20"></button></div></div>`);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
    document.elementFromPoint = undefined as unknown as typeof document.elementFromPoint;
    expect(ids(collectHintTargets(document, window))).toEqual(['inside']);
  });
});

describe('hintAnchor', () => {
  const vp = { width: 800, height: 600 };
  const off = HINT_CORNER_OFFSET_PX;
  it('anchors at the top-left corner, or bottom-left for terminal panes', () => {
    expect(hintAnchor({ left: 100, top: 50, width: 80, height: 20 }, 'project', vp)).toEqual({ x: 100, y: 50, placement: 'corner' });
    expect(hintAnchor({ left: 100, top: 50, width: 300, height: 200 }, 'terminal', vp)).toEqual({ x: 100, y: 250, placement: 'bottom-left' });
  });

  it('clamps so the -4px corner shift stays on screen', () => {
    expect(hintAnchor({ left: 0, top: 0, width: 10, height: 10 }, 'nav', vp)).toEqual({ x: off, y: off, placement: 'corner' });
    const right = hintAnchor({ left: 795, top: 595, width: 5, height: 5 }, 'nav', vp, 2);
    expect(right.x).toBeLessThan(795);
    expect(right.y).toBeLessThan(595);
    expect(hintAnchor({ left: 0, top: 100, width: 800, height: 500 }, 'terminal', vp)).toEqual({ x: 0, y: 600, placement: 'bottom-left' });
  });
});

describe('activateHintTarget', () => {
  it('sends mousedown, mouseup and click at the element centre', () => {
    mount('<div id="row" role="button" tabindex="0" data-box="10,20,100,40"></div>');
    const row = document.getElementById('row')!;
    const seen: string[] = [];
    for (const type of ['mousedown', 'mouseup', 'click']) {
      document.addEventListener(type, (e) => {
        const m = e as MouseEvent;
        seen.push(`${type}@${m.clientX},${m.clientY}:${m.button}:${m.bubbles}`);
      });
    }
    activateHintTarget(row, 'project');
    expect(seen).toEqual(['mousedown@60,40:0:true', 'mouseup@60,40:0:true', 'click@60,40:0:true']);
    // Project rows are not focused (the terminal of the picked project takes focus).
    expect(document.activeElement).not.toBe(row);
  });

  it('focuses focusable non-button targets but not buttons', () => {
    mount('<a id="a" href="#x" data-box="0,0,10,10"></a><button id="b" data-box="0,0,10,10"></button>');
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    a.addEventListener('click', (e) => e.preventDefault());
    activateHintTarget(a, 'nav');
    expect(document.activeElement).toBe(a);
    activateHintTarget(b, 'nav');
    expect(document.activeElement).toBe(a);
  });

  it('does nothing for a detached element', () => {
    const el = document.createElement('button');
    const onClick = vi.fn();
    el.addEventListener('click', onClick);
    activateHintTarget(el, 'nav');
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('collectHintTargets in an untagged modal', () => {
  it('returns nothing, so hint mode does not open', () => {
    mount(`
      <div data-hint="project" data-project-tab-id="p" data-box="0,0,50,20"></div>
      <div class="confirm-overlay" data-box="0,0,800,600"><button data-box="10,10,20,20">OK</button></div>`);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
    document.elementFromPoint = undefined as unknown as typeof document.elementFromPoint;
    expect(collectHintTargets(document, window)).toEqual([]);
  });
});
