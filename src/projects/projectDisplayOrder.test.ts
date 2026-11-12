import { describe, expect, it } from 'vitest';
import {
  isUngroupedProject,
  projectDisplayOrderIds,
  projectDisplaySections,
  projectIdAtDisplayIndex,
  projectIdByDisplayDelta,
  visibleProjectsInOrder,
  type DisplayGroup,
  type DisplayProject,
} from './projectDisplayOrder';

const projects: DisplayProject[] = [
  { id: 'a' },
  { id: 'b', groupId: 'g1' },
  { id: 'c', favorite: true },
  { id: 'd', hidden: true },
  { id: 'e', groupId: 'g2' },
  { id: 'f', groupId: 'gone' },
  { id: 'g', groupId: 'g1', favorite: true },
];
const groups: DisplayGroup[] = [{ id: 'g1' }, { id: 'g2' }];

const order = (layout: 'top-tabs' | 'left-panel' | 'flat', gs: DisplayGroup[] = groups) =>
  projectDisplayOrderIds(projectDisplaySections(visibleProjectsInOrder(projects), gs, layout));

describe('visibleProjectsInOrder', () => {
  it('drops hidden projects and floats favorites, keeping stored order otherwise', () => {
    expect(visibleProjectsInOrder(projects).map((p) => p.id)).toEqual(['c', 'g', 'a', 'b', 'e', 'f']);
  });
});

describe('isUngroupedProject', () => {
  it('treats a missing or unknown group as ungrouped', () => {
    expect(isUngroupedProject({ id: 'x' }, groups)).toBe(true);
    expect(isUngroupedProject({ id: 'x', groupId: 'gone' }, groups)).toBe(true);
    expect(isUngroupedProject({ id: 'x', groupId: 'g1' }, groups)).toBe(false);
  });
});

describe('projectDisplaySections / projectDisplayOrderIds', () => {
  it('top tabs: ungrouped first, then groups in group order', () => {
    expect(order('top-tabs')).toEqual(['c', 'a', 'f', 'g', 'b', 'e']);
  });

  it('left panel: groups first, then the ungrouped zone', () => {
    expect(order('left-panel')).toEqual(['g', 'b', 'e', 'c', 'a', 'f']);
  });

  it('flat: favorites-first visible list without grouping', () => {
    expect(order('flat')).toEqual(['c', 'g', 'a', 'b', 'e', 'f']);
  });

  it('keeps empty groups as sections', () => {
    const sections = projectDisplaySections(visibleProjectsInOrder(projects), [...groups, { id: 'empty' }], 'top-tabs');
    expect(sections.map((s) => s.group?.id ?? null)).toEqual([null, 'g1', 'g2', 'empty']);
    expect(sections[3].projects).toEqual([]);
  });

  it('leaves collapsed groups out unless asked', () => {
    const collapsed = [{ id: 'g1', collapsed: true }, { id: 'g2' }];
    expect(order('top-tabs', collapsed)).toEqual(['c', 'a', 'f', 'e']);
    const sections = projectDisplaySections(visibleProjectsInOrder(projects), collapsed, 'top-tabs');
    expect(projectDisplayOrderIds(sections, { includeCollapsed: true })).toEqual(['c', 'a', 'f', 'g', 'b', 'e']);
  });
});

describe('projectIdByDisplayDelta', () => {
  const sections = projectDisplaySections(visibleProjectsInOrder(projects), groups, 'left-panel');
  // left panel order: g b e c a f

  it('next is the project below, previous the one above', () => {
    expect(projectIdByDisplayDelta(sections, 'b', +1)).toBe('e');
    expect(projectIdByDisplayDelta(sections, 'b', -1)).toBe('g');
  });

  it('wraps around both ends', () => {
    expect(projectIdByDisplayDelta(sections, 'f', +1)).toBe('g');
    expect(projectIdByDisplayDelta(sections, 'g', -1)).toBe('f');
  });

  it('skips projects in collapsed groups', () => {
    const collapsed = projectDisplaySections(visibleProjectsInOrder(projects), [{ id: 'g1' }, { id: 'g2', collapsed: true }], 'left-panel');
    // shown: g b c a f (e hidden in collapsed g2)
    expect(projectIdByDisplayDelta(collapsed, 'b', +1)).toBe('c');
    expect(projectIdByDisplayDelta(collapsed, 'c', -1)).toBe('b');
  });

  it('moves to the neighbour when the active project sits in a collapsed group', () => {
    const collapsed = projectDisplaySections(visibleProjectsInOrder(projects), [{ id: 'g1', collapsed: true }, { id: 'g2' }], 'left-panel');
    // full: g b e c a f, shown: e c a f; active b is collapsed
    expect(projectIdByDisplayDelta(collapsed, 'b', +1)).toBe('e');
    expect(projectIdByDisplayDelta(collapsed, 'b', -1)).toBe('f');
  });

  it('starts at the top/bottom without an active project', () => {
    expect(projectIdByDisplayDelta(sections, null, +1)).toBe('g');
    expect(projectIdByDisplayDelta(sections, null, -1)).toBe('f');
    expect(projectIdByDisplayDelta(sections, 'unknown', +1)).toBe('g');
  });

  it('returns null with nothing to move to', () => {
    const one = projectDisplaySections([{ id: 'solo' }], [], 'top-tabs');
    expect(projectIdByDisplayDelta(one, 'solo', +1)).toBeNull();
    expect(projectIdByDisplayDelta(projectDisplaySections([], [], 'top-tabs'), null, +1)).toBeNull();
    expect(projectIdByDisplayDelta(sections, 'b', 0)).toBeNull();
  });
});

describe('projectIdAtDisplayIndex', () => {
  it('uses the on-screen order and skips collapsed groups', () => {
    const sections = projectDisplaySections(visibleProjectsInOrder(projects), [{ id: 'g1', collapsed: true }, { id: 'g2' }], 'top-tabs');
    // shown: c a f e
    expect(projectIdAtDisplayIndex(sections, 0)).toBe('c');
    expect(projectIdAtDisplayIndex(sections, 3)).toBe('e');
    expect(projectIdAtDisplayIndex(sections, 4)).toBeNull();
  });
});
