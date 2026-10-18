import { describe, expect, it } from 'vitest';
import type { Slide } from './types';
import {
  formatPresentationDuration,
  getPresenterCueCard,
  getPresenterLiveCoach,
  getPresenterPacingInfo,
  getPresenterSlideInfo,
} from './pptxPresentation';

const slides: Slide[] = [
  { id: 'a', title: 'Cover', bgColor: '#fff', elements: [] },
  { id: 'b', title: 'Hidden', bgColor: '#fff', hidden: true, elements: [] },
  { id: 'c', title: 'Plan', bgColor: '#fff', notes: 'Talk about the rollout.', elements: [] },
];

describe('pptx presentation helpers', () => {
  it('formats elapsed presentation time', () => {
    expect(formatPresentationDuration(0)).toBe('0:00');
    expect(formatPresentationDuration(65_000)).toBe('1:05');
    expect(formatPresentationDuration(3_665_000)).toBe('1:01:05');
  });

  it('builds presenter state from visible slides', () => {
    const info = getPresenterSlideInfo(slides, 2, [0, 2], (slide) => slide.title || 'Untitled');

    expect(info.currentIdx).toBe(2);
    expect(info.previousIdx).toBe(0);
    expect(info.nextIdx).toBe(2);
    expect(info.currentPosition).toBe(1);
    expect(info.totalVisible).toBe(2);
    expect(info.progressPct).toBe(100);
    expect(info.currentTitle).toBe('Plan');
    expect(info.nextTitle).toBe('End of deck');
    expect(info.notes).toBe('Talk about the rollout.');
  });

  it('falls back to the first visible slide when the current slide is hidden', () => {
    const info = getPresenterSlideInfo(slides, 1, [0, 2], (slide) => slide.title || 'Untitled');

    expect(info.currentIdx).toBe(0);
    expect(info.nextIdx).toBe(2);
    expect(info.progressPct).toBe(50);
  });

  it('builds live pacing guidance from rehearsal timing', () => {
    const report = {
      score: 88,
      totalSeconds: 75,
      visibleSlides: 3,
      slidesWithNotes: 3,
      issues: [],
      slideReports: [
        { slideId: 'a', slideIndex: 0, title: 'Cover', wordCount: 8, notesWordCount: 12, estimatedSeconds: 20, recommendedAdvanceSec: 22, issues: [] },
        { slideId: 'b', slideIndex: 1, title: 'Plan', wordCount: 12, notesWordCount: 18, estimatedSeconds: 25, recommendedAdvanceSec: 27, issues: [] },
        { slideId: 'c', slideIndex: 2, title: 'Close', wordCount: 6, notesWordCount: 14, estimatedSeconds: 30, recommendedAdvanceSec: 32, issues: [] },
      ],
    };

    expect(getPresenterPacingInfo(report, 1, 25_000)).toMatchObject({
      status: 'on-track',
      plannedStartSeconds: 20,
      plannedEndSeconds: 45,
      remainingSeconds: 50,
    });
    expect(getPresenterPacingInfo(report, 1, 2_000)).toMatchObject({ status: 'ahead', deltaSeconds: -18 });
    expect(getPresenterPacingInfo(report, 1, 61_000)).toMatchObject({ status: 'behind', deltaSeconds: 16 });
  });

  it('builds steady presenter live coach guidance and show flow timing', () => {
    const report = {
      score: 96,
      totalSeconds: 60,
      visibleSlides: 3,
      slidesWithNotes: 3,
      issues: [],
      slideReports: [
        { slideId: 'a', slideIndex: 0, title: 'Open', wordCount: 10, notesWordCount: 12, estimatedSeconds: 15, recommendedAdvanceSec: 17, issues: [] },
        { slideId: 'b', slideIndex: 1, title: 'Proof', wordCount: 12, notesWordCount: 15, estimatedSeconds: 20, recommendedAdvanceSec: 22, issues: [] },
        { slideId: 'c', slideIndex: 2, title: 'Close', wordCount: 8, notesWordCount: 14, estimatedSeconds: 25, recommendedAdvanceSec: 27, issues: [] },
      ],
    };

    const coach = getPresenterLiveCoach(report, 1, 20_000, [0, 1, 2]);

    expect(coach.confidence).toBe('steady');
    expect(coach.headline).toBe('Steady pace');
    expect(coach.nextAction).toContain('cadence');
    expect(coach.flow.map((item) => item.status)).toEqual(['done', 'current', 'next']);
    expect(coach.flow[1]).toMatchObject({
      slideIndex: 1,
      plannedStartSeconds: 15,
      plannedEndSeconds: 35,
      hasNotes: true,
      issueCount: 0,
    });
  });

  it('asks the presenter to recover when pace or slide quality is risky', () => {
    const report = {
      score: 55,
      totalSeconds: 80,
      visibleSlides: 3,
      slidesWithNotes: 1,
      issues: ['Slide 2: Speaker notes missing or too short'],
      slideReports: [
        { slideId: 'a', slideIndex: 0, title: 'Open', wordCount: 10, notesWordCount: 12, estimatedSeconds: 20, recommendedAdvanceSec: 22, issues: [] },
        {
          slideId: 'b',
          slideIndex: 1,
          title: 'Dense Model',
          wordCount: 92,
          notesWordCount: 0,
          estimatedSeconds: 30,
          recommendedAdvanceSec: 32,
          issues: ['Speaker notes missing or too short', 'Slide text is too dense for live delivery'],
        },
        { slideId: 'c', slideIndex: 2, title: 'Decision', wordCount: 8, notesWordCount: 10, estimatedSeconds: 30, recommendedAdvanceSec: 32, issues: [] },
      ],
    };

    const coach = getPresenterLiveCoach(report, 1, 70_000, [0, 1, 2]);

    expect(coach.confidence).toBe('recover');
    expect(coach.headline).toBe('Recover this slide');
    expect(coach.nextAction).toContain('cut line');
    expect(coach.flow[1]).toMatchObject({
      slideIndex: 1,
      status: 'current',
      issueCount: 2,
      hasNotes: false,
    });
  });

  it('builds speaker cue cards from notes, slide content, and rehearsal issues', () => {
    const cue = getPresenterCueCard(
      {
        id: 'cue',
        title: 'Decision',
        bgColor: '#fff',
        notes: 'Open with the board ask. Show the KPI proof. Close on the owner.',
        elements: [
          { id: 'a', type: 'text', x: 0, y: 0, w: 80, h: 10, text: 'Decision' },
        ],
      },
      {
        slideId: 'cue',
        slideIndex: 0,
        title: 'Decision',
        wordCount: 12,
        notesWordCount: 11,
        estimatedSeconds: 20,
        recommendedAdvanceSec: 22,
        issues: [],
      },
      'Financial Model',
    );

    expect(cue.opening).toBe('Open with the board ask.');
    expect(cue.focus).toBe('Open with the board ask.');
    expect(cue.bridge).toContain('Financial Model');
    expect(cue.cutLine).toContain('headline');
    expect(cue.risk).toBe('Ready for live delivery.');

    const denseCue = getPresenterCueCard(
      { id: 'dense', title: 'Dense', bgColor: '#fff', elements: [] },
      {
        slideId: 'dense',
        slideIndex: 1,
        title: 'Dense',
        wordCount: 90,
        notesWordCount: 0,
        estimatedSeconds: 80,
        recommendedAdvanceSec: 82,
        issues: ['Slide text is too dense for live delivery'],
      },
      'End of deck',
    );

    expect(denseCue.opening).toContain('Dense');
    expect(denseCue.bridge).toContain('Close with the decision');
    expect(denseCue.cutLine).toContain('skip detail');
    expect(denseCue.risk).toContain('too dense');
  });
});
