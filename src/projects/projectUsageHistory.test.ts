import { describe, expect, it } from 'vitest';
import {
  cleanProjectUsageHistory,
  getProjectIdByUsageDelta,
  orderProjectsByUsage,
  recordProjectUsage,
} from './projectUsageHistory';

const projects = [
  { id: 'a' },
  { id: 'b' },
  { id: 'c' },
  { id: 'd', hidden: true },
];

describe('project usage history', () => {
  it('records active projects in most-recent-first order', () => {
    let history: string[] = [];
    history = recordProjectUsage(history, 'a', projects);
    history = recordProjectUsage(history, 'b', projects);
    history = recordProjectUsage(history, 'c', projects);
    history = recordProjectUsage(history, 'b', projects);

    expect(history).toEqual(['b', 'c', 'a']);
  });

  it('removes hidden, missing, and duplicate project ids', () => {
    expect(cleanProjectUsageHistory(['d', 'b', 'missing', 'b', 'a'], projects)).toEqual(['b', 'a']);
  });

  it('orders unvisited visible projects after recent projects', () => {
    expect(orderProjectsByUsage(['b'], projects)).toEqual(['b', 'a', 'c']);
  });

  it('moves to the previously used project with positive delta', () => {
    const history = ['c', 'b', 'a'];

    expect(getProjectIdByUsageDelta(history, projects, 'c', +1)).toBe('b');
    expect(getProjectIdByUsageDelta(history, projects, 'b', +1)).toBe('a');
  });

  it('moves toward newer projects with negative delta', () => {
    const history = ['c', 'b', 'a'];

    expect(getProjectIdByUsageDelta(history, projects, 'a', -1)).toBe('b');
    expect(getProjectIdByUsageDelta(history, projects, 'b', -1)).toBe('c');
  });

  it('wraps around visible projects only', () => {
    const history = ['c', 'b', 'a'];

    expect(getProjectIdByUsageDelta(history, projects, 'a', +1)).toBe('c');
    expect(getProjectIdByUsageDelta(history, projects, 'c', -1)).toBe('a');
  });
});
