import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { ko } from '../i18n/ko';
import { GUIDE_STEPS, doneCount, markDone, visibleSteps, type GuideProgress } from './steps';

const CHROME_KEYS = [
  'guide.title', 'guide.progress', 'guide.tryIt', 'guide.next', 'guide.finish', 'guide.reset',
  'guide.whatsnew.title', 'guide.whatsnew.older', 'guide.whatsnew.allReleases', 'guide.whatsnew.openGuide',
  'guide.whatsnew.empty', 'guide.menu.start', 'guide.menu.whatsnew',
];

describe('GUIDE_STEPS', () => {
  it('steps in spec order', () => {
    expect(GUIDE_STEPS.map(s => s.id)).toEqual(['project', 'ai-terminal', 'status', 'keep-running', 'git-keys', 'hints', 'window-pin', 'pet']);
  });

  it('pet hidden off macOS', () => {
    expect(visibleSteps(false).map(s => s.id)).not.toContain('pet');
    expect(visibleSteps(true).map(s => s.id)).toContain('pet');
  });

  it('every key exists in en and ko', () => {
    const keys: string[] = [...CHROME_KEYS];
    for (const s of GUIDE_STEPS) {
      keys.push(s.titleKey, s.bodyKey);
      if (s.target) keys.push(s.target.captionKey, s.target.missingKey);
    }
    const enMap = en as Record<string, string>;
    const koMap = ko as Record<string, string>;
    for (const k of keys) {
      expect(enMap[k], `en ${k}`).toBeTruthy();
      expect(koMap[k], `ko ${k}`).toBeTruthy();
    }
  });

  it('targets use data-guide selectors only', () => {
    for (const s of GUIDE_STEPS) {
      if (!s.target) continue;
      expect(s.target.selector).toMatch(/^\[data-guide="[a-z-]+"\]$/);
      if (s.target.altSelector) expect(s.target.altSelector).toMatch(/^\[data-guide="[a-z-]+"\]$/);
    }
  });

  it('step wiring matches the spec', () => {
    const byId = Object.fromEntries(GUIDE_STEPS.map(s => [s.id, s]));
    expect(byId.project.target?.selector).toBe('[data-guide="project-open"]');
    expect(byId.project.target?.altSelector).toBe('[data-guide="new-project-folder"]');
    expect(byId['ai-terminal'].target?.selector).toBe('[data-guide="ai-terminal"]');
    expect(byId['git-keys'].target?.selector).toBe('[data-guide="git"]');
    expect(byId['window-pin'].target?.selector).toBe('[data-guide="window-pin"]');
    expect(byId['window-pin'].macOnly).toBeUndefined();
    expect(byId.status.target).toBeUndefined();
    expect(byId.status.action).toBeUndefined();
    expect(byId.hints.target).toBeUndefined();
    expect(byId.hints.action).toBeUndefined();
    expect(byId['keep-running'].action).toBe('open-settings-terminal');
    expect(byId.pet.action).toBe('pet-tour');
    expect(byId.pet.macOnly).toBe(true);
  });
});

describe('progress', () => {
  it('markDone keeps first time; doneCount counts visible steps', () => {
    let p: GuideProgress = {};
    p = markDone(p, 'project', 100);
    p = markDone(p, 'project', 200);
    expect(p.project).toBe(100);
    p = markDone(p, 'pet', 300);
    expect(doneCount(p, visibleSteps(true))).toBe(2);
    expect(doneCount(p, visibleSteps(false))).toBe(1);
  });

  it('markDone returns the same object when nothing changes', () => {
    const p: GuideProgress = { project: 1 };
    expect(markDone(p, 'project', 5)).toBe(p);
  });
});
