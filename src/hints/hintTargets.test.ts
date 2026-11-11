import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateHintTarget,
  collectHintTargets,
  findTopHintDialog,
  hintAnchor,
  hintDataKind,
  hintKindOf,
  HINT_ANCHOR_MARGIN_PX,
  isDangerHintTarget,
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
      <button id="b"></button>`);
    expect(['p', 'p2', 't', 't2', 'w', 'b'].map((id) => hintKindOf(document.getElementById(id)!)))
      .toEqual(['project', 'project', 'tab', 'tab', 'terminal', 'other']);
  });

  it('tags close/delete buttons as danger by class word, aria-label or title', () => {
    mount(`
      <button id="a" class="tab-close"></button>
      <button id="b" class="ce-prop-delete"></button>
      <button id="c" aria-label="Close"></button>
      <button id="d" title="프로젝트 삭제"></button>
      <button id="e" class="recent-project-item closed"></button>
      <button id="f" title="Closer look"></button>
      <button id="g" class="project-selector-edit"></button>`);
    const danger = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => isDangerHintTarget(document.getElementById(id)!));
    expect(danger).toEqual([true, true, true, true, false, false, false]);
  });

  it('maps to data-kind', () => {
    expect(hintDataKind({ kind: 'project', danger: false })).toBe('project');
    expect(hintDataKind({ kind: 'terminal', danger: false })).toBe('terminal');
    expect(hintDataKind({ kind: 'other', danger: false })).toBe('button');
    expect(hintDataKind({ kind: 'other', danger: true })).toBe('danger');
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
  it('finds the top-most open modal layer', () => {
    mount(`
      <div id="low" class="modal-overlay" style="z-index:10" data-box="0,0,800,600"></div>
      <div id="high" role="dialog" style="z-index:50" data-box="0,0,400,300"></div>
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
    return { element, kind, danger: false, rect: { left, top, width: 10, height: 10 } };
  };

  it('puts projects, then tabs, then panes, then the rest in reading order', () => {
    const ordered = orderHintTargets([
      t('btn-bottom', 'other', 0, 500),
      t('pane', 'terminal', 300, 100),
      t('btn-top-right', 'other', 700, 3),
      t('proj-2', 'project', 0, 50),
      t('tab-1', 'tab', 300, 30),
      t('btn-top-left', 'other', 100, 0),
      t('proj-1', 'project', 0, 80),
    ]);
    // Projects/tabs keep DOM order (the on-screen list order), not their coordinates.
    expect(ids(ordered)).toEqual(['proj-2', 'proj-1', 'tab-1', 'pane', 'btn-top-left', 'btn-top-right', 'btn-bottom']);
  });
});

describe('collectHintTargets', () => {
  it('collects visible, enabled, reachable targets in hint order', () => {
    mount(`
      <button id="hidden" style="display:none" data-box="0,0,10,10"></button>
      <button id="zero" data-box="0,0,0,0"></button>
      <button id="offscreen" data-box="-100,0,10,10"></button>
      <button id="disabled" disabled data-box="0,0,10,10"></button>
      <button id="covered" data-box="200,200,10,10"></button>
      <button id="ok" data-box="500,10,20,10"></button>
      <a id="link" href="#x" data-box="10,300,20,10"></a>
      <a id="nolink" data-box="60,300,20,10"></a>
      <div id="tab" data-hint="tab" data-terminal-tab-id="t1" data-box="100,40,60,20"></div>
      <div id="proj" data-hint="project" data-project-tab-id="p1" role="button" data-box="0,40,80,20"></div>
      <div id="pane" data-terminal-wrap data-box="100,60,600,400"><div class="xterm"><button id="xt" data-box="110,70,10,10"></button></div></div>
      <button id="close" class="tab-close" data-box="140,40,10,10"></button>`);
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

    const targets = collectHintTargets(document, window);
    expect(ids(targets)).toEqual(['proj', 'tab', 'pane', 'ok', 'close', 'link']);
    expect(targets.find((x) => x.element.id === 'close')?.danger).toBe(true);
    expect(ids(collectHintTargets(document, window, { includeDanger: false }))).not.toContain('close');
  });

  it('only hints inside the top-most dialog when one is open', () => {
    mount(`
      <button id="behind" data-box="10,10,20,20"></button>
      <div class="modal-overlay" data-box="0,0,800,600"><div role="dialog" data-box="100,100,300,200"><button id="inside" data-box="120,120,40,20"></button></div></div>`);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
    document.elementFromPoint = undefined as unknown as typeof document.elementFromPoint;
    expect(ids(collectHintTargets(document, window))).toEqual(['inside']);
  });
});

describe('hintAnchor', () => {
  const vp = { width: 800, height: 600 };
  it('anchors at the top-left corner, or bottom-left for terminal panes', () => {
    expect(hintAnchor({ left: 100, top: 50, width: 80, height: 20 }, 'project', vp)).toEqual({ x: 100, y: 50, placement: 'corner' });
    expect(hintAnchor({ left: 100, top: 50, width: 300, height: 200 }, 'terminal', vp)).toEqual({ x: 100, y: 250, placement: 'bottom-left' });
  });

  it('clamps to the viewport with a margin', () => {
    const m = HINT_ANCHOR_MARGIN_PX;
    expect(hintAnchor({ left: 0, top: 0, width: 10, height: 10 }, 'other', vp)).toEqual({ x: m, y: m, placement: 'corner' });
    expect(hintAnchor({ left: 0, top: 100, width: 800, height: 500 }, 'terminal', vp)).toEqual({ x: m, y: 600 - m, placement: 'bottom-left' });
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
    activateHintTarget(a, 'other');
    expect(document.activeElement).toBe(a);
    activateHintTarget(b, 'other');
    expect(document.activeElement).toBe(a);
  });

  it('does nothing for a detached element', () => {
    const el = document.createElement('button');
    const onClick = vi.fn();
    el.addEventListener('click', onClick);
    activateHintTarget(el, 'other');
    expect(onClick).not.toHaveBeenCalled();
  });
});
