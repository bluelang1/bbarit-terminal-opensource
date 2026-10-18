import { describe, expect, it } from 'vitest';
import type { Slide } from './types';
import { PPTX_DESIGN_THEMES } from './pptxDesignThemes';
import {
  analyzePresentationRehearsal,
  applyRehearsalTiming,
  buildPresentationAgendaSlide,
  buildPresentationAudienceDrillSlide,
  buildPresentationBoardPackSlides,
  buildPresentationHandoutSlides,
  buildPresentationInvestorPackSlides,
  buildPresentationQAPackSlides,
  buildPresentationRunOfShowSlide,
  buildPresentationScriptPackSlides,
  buildSpeakerNotesForSlide,
  enrichDeckSpeakerNotes,
  estimateSpeakingSeconds,
  formatRehearsalDuration,
  insertPresentationAgenda,
  insertPresentationAudienceDrill,
  insertPresentationBoardPack,
  insertPresentationHandout,
  insertPresentationInvestorPack,
  insertPresentationQAPack,
  insertPresentationRunOfShow,
  insertPresentationScriptPack,
  isPresentationAgendaSlide,
  isPresentationAudienceDrillSlide,
  isPresentationBoardPackSlide,
  isPresentationHandoutSlide,
  isPresentationInvestorPackSlide,
  isPresentationQAPackSlide,
  isPresentationRunOfShowSlide,
  isPresentationScriptPackSlide,
} from './pptxRehearsal';

const slides: Slide[] = [
  {
    id: 'cover',
    title: 'Launch Review',
    bgColor: '#ffffff',
    elements: [
      { id: 'title', type: 'text', x: 8, y: 8, w: 80, h: 10, text: 'Launch Review', fontSize: 32 },
      { id: 'body', type: 'text', x: 8, y: 28, w: 70, h: 20, text: 'Revenue grew and activation is improving.', fontSize: 18 },
    ],
  },
  {
    id: 'dense',
    bgColor: '#ffffff',
    elements: [
      {
        id: 'dense-text',
        type: 'text',
        x: 8,
        y: 8,
        w: 80,
        h: 70,
        text: Array.from({ length: 80 }, (_, idx) => `point${idx}`).join(' '),
        fontSize: 16,
      },
    ],
  },
];

describe('pptx rehearsal helpers', () => {
  it('estimates and formats speaking time', () => {
    expect(estimateSpeakingSeconds('one two three')).toBeGreaterThanOrEqual(10);
    expect(formatRehearsalDuration(125)).toBe('2:05');
  });

  it('analyzes presentation readiness', () => {
    const report = analyzePresentationRehearsal(slides, (slide) => slide.title || 'Untitled');

    expect(report.visibleSlides).toBe(2);
    expect(report.score).toBeLessThan(100);
    expect(report.issues.some((issue) => issue.includes('Speaker notes missing'))).toBe(true);
    expect(report.issues.some((issue) => issue.includes('too dense'))).toBe(true);
    expect(report.slideReports[0].issues.includes('No clear title')).toBe(false);
  });

  it('builds and enriches speaker notes without overwriting good notes', () => {
    const notes = buildSpeakerNotesForSlide(slides[0], 0, slides.length, 'Launch Review');
    const existingNotes = 'Existing detailed speaker notes already cover the story clearly.';
    const enriched = enrichDeckSpeakerNotes([{ ...slides[0], notes: existingNotes }, slides[1]]);

    expect(notes).toContain('Open:');
    expect(enriched[0].notes).toBe(existingNotes);
    expect(enriched[1].notes).toContain('Close');
  });

  it('applies rehearsal timing to visible slides', () => {
    const timed = applyRehearsalTiming(slides);

    expect(timed[0].transition?.type).toBe('fade');
    expect(timed[0].transition?.advanceAfterSec).toBeGreaterThanOrEqual(10);
    expect(timed[1].transition?.advanceAfterSec).toBeGreaterThan(timed[0].transition?.advanceAfterSec || 0);
  });

  it('builds and inserts a run-of-show presenter cue sheet idempotently', () => {
    const theme = PPTX_DESIGN_THEMES[0];
    const runSheet = buildPresentationRunOfShowSlide(slides, theme, (slide, idx) => slide.title || `Slide ${idx + 1}`);
    const withRunSheet = insertPresentationRunOfShow(slides, theme);
    const repeated = insertPresentationRunOfShow(withRunSheet, theme);

    expect(runSheet.title).toBe('Run of Show');
    expect(isPresentationRunOfShowSlide(runSheet)).toBe(true);
    expect(runSheet.elements.some((element) => element.text === 'Presenter Cue Sheet')).toBe(true);
    expect(runSheet.elements.some((element) => element.text === 'Launch Review')).toBe(true);
    expect(withRunSheet).toHaveLength(slides.length + 1);
    expect(withRunSheet[0].title).toBe('Run of Show');
    expect(repeated.filter(isPresentationRunOfShowSlide)).toHaveLength(1);
    expect(repeated).toHaveLength(slides.length + 1);
  });

  it('builds and inserts an audience agenda slide after the run-of-show sheet', () => {
    const theme = PPTX_DESIGN_THEMES[0];
    const withRunSheet = insertPresentationRunOfShow(slides, theme);
    const agenda = buildPresentationAgendaSlide(withRunSheet, theme, (slide, idx) => slide.title || `Slide ${idx + 1}`);
    const withAgenda = insertPresentationAgenda(withRunSheet, theme);
    const repeated = insertPresentationAgenda(withAgenda, theme);

    expect(agenda.title).toBe('Audience Agenda');
    expect(isPresentationAgendaSlide(agenda)).toBe(true);
    expect(agenda.elements.some((element) => element.text === 'Audience Flow')).toBe(true);
    expect(agenda.elements.some((element) => element.text === 'Launch Review')).toBe(true);
    expect(withAgenda[0].title).toBe('Run of Show');
    expect(withAgenda[1].title).toBe('Audience Agenda');
    expect(analyzePresentationRehearsal(withAgenda).visibleSlides).toBe(slides.length);
    expect(repeated.filter(isPresentationAgendaSlide)).toHaveLength(1);
    expect(repeated).toHaveLength(slides.length + 2);
  });

  it('builds and inserts a board decision pack idempotently', () => {
    const theme = PPTX_DESIGN_THEMES[0];
    const boardPack = buildPresentationBoardPackSlides(slides, theme, (slide, idx) => slide.title || `Slide ${idx + 1}`);
    const withBoardPack = insertPresentationBoardPack(slides, theme);
    const repeated = insertPresentationBoardPack(withBoardPack, theme);

    expect(boardPack).toHaveLength(2);
    expect(boardPack[0].title).toBe('Board Decision Pack');
    expect(boardPack[1].title).toBe('Board Risk Register');
    expect(boardPack.every(isPresentationBoardPackSlide)).toBe(true);
    expect(boardPack[0].elements.some((element) => element.text === 'Decision Queue')).toBe(true);
    expect(boardPack[1].elements.some((element) => element.text === 'Quality Risks')).toBe(true);
    expect(withBoardPack).toHaveLength(slides.length + 2);
    expect(withBoardPack.at(-2)?.title).toBe('Board Decision Pack');
    expect(withBoardPack.at(-1)?.title).toBe('Board Risk Register');
    expect(analyzePresentationRehearsal(withBoardPack).visibleSlides).toBe(slides.length);
    expect(repeated.filter(isPresentationBoardPackSlide)).toHaveLength(2);
    expect(repeated).toHaveLength(slides.length + 2);
  });

  it('builds and inserts a Q&A defense pack idempotently', () => {
    const theme = PPTX_DESIGN_THEMES[0];
    const qaPack = buildPresentationQAPackSlides(slides, theme, (slide, idx) => slide.title || `Slide ${idx + 1}`);
    const withQAPack = insertPresentationQAPack(slides, theme);
    const repeated = insertPresentationQAPack(withQAPack, theme);

    expect(qaPack).toHaveLength(2);
    expect(qaPack[0].title).toBe('Q&A Defense Map');
    expect(qaPack[1].title).toBe('Answer Bank');
    expect(qaPack.every(isPresentationQAPackSlide)).toBe(true);
    expect(qaPack[0].elements.some((element) => element.text === 'Likely Questions')).toBe(true);
    expect(qaPack[1].elements.some((element) => element.text === 'Answer Bank')).toBe(true);
    expect(withQAPack).toHaveLength(slides.length + 2);
    expect(withQAPack.at(-2)?.title).toBe('Q&A Defense Map');
    expect(withQAPack.at(-1)?.title).toBe('Answer Bank');
    expect(analyzePresentationRehearsal(withQAPack).visibleSlides).toBe(slides.length);
    expect(repeated.filter(isPresentationQAPackSlide)).toHaveLength(2);
    expect(repeated).toHaveLength(slides.length + 2);
  });

  it('builds and inserts an audience drill room idempotently', () => {
    const theme = PPTX_DESIGN_THEMES[0];
    const drill = buildPresentationAudienceDrillSlide(slides, theme, (slide, idx) => slide.title || `Slide ${idx + 1}`);
    const withDrill = insertPresentationAudienceDrill(slides, theme);
    const repeated = insertPresentationAudienceDrill(withDrill, theme);

    expect(drill.title).toBe('Audience Drill Room');
    expect(isPresentationAudienceDrillSlide(drill)).toBe(true);
    expect(drill.elements.some((element) => element.text === 'Hot Seat Question')).toBe(true);
    expect(drill.elements.some((element) => element.text === 'Answer Formula')).toBe(true);
    expect(drill.elements.some((element) => element.text === '20-sec Answer')).toBe(true);
    expect(withDrill).toHaveLength(slides.length + 1);
    expect(withDrill.at(-1)?.title).toBe('Audience Drill Room');
    expect(analyzePresentationRehearsal(withDrill).visibleSlides).toBe(slides.length);
    expect(repeated.filter(isPresentationAudienceDrillSlide)).toHaveLength(1);
    expect(repeated).toHaveLength(slides.length + 1);
  });

  it('builds and inserts a presenter script pack idempotently', () => {
    const theme = PPTX_DESIGN_THEMES[0];
    const scriptPack = buildPresentationScriptPackSlides(slides, theme, (slide, idx) => slide.title || `Slide ${idx + 1}`);
    const withScriptPack = insertPresentationScriptPack(slides, theme);
    const repeated = insertPresentationScriptPack(withScriptPack, theme);

    expect(scriptPack).toHaveLength(2);
    expect(scriptPack[0].title).toBe('Presenter Script');
    expect(scriptPack[1].title).toBe('Segment Timing Plan');
    expect(scriptPack.every(isPresentationScriptPackSlide)).toBe(true);
    expect(scriptPack[0].elements.some((element) => element.text === 'Slide Talk Track')).toBe(true);
    expect(scriptPack[0].elements.some((element) => element.text === 'Presenter Rule')).toBe(true);
    expect(scriptPack[1].elements.some((element) => element.text === 'Segment Timing Plan')).toBe(true);
    expect(withScriptPack).toHaveLength(slides.length + 2);
    expect(withScriptPack.at(-2)?.title).toBe('Presenter Script');
    expect(withScriptPack.at(-1)?.title).toBe('Segment Timing Plan');
    expect(analyzePresentationRehearsal(withScriptPack).visibleSlides).toBe(slides.length);
    expect(repeated.filter(isPresentationScriptPackSlide)).toHaveLength(2);
    expect(repeated).toHaveLength(slides.length + 2);
  });

  it('builds and inserts a leave-behind handout idempotently', () => {
    const theme = PPTX_DESIGN_THEMES[0];
    const handout = buildPresentationHandoutSlides(slides, theme, (slide, idx) => slide.title || `Slide ${idx + 1}`);
    const withHandout = insertPresentationHandout(slides, theme);
    const repeated = insertPresentationHandout(withHandout, theme);

    expect(handout).toHaveLength(2);
    expect(handout[0].title).toBe('Executive Handout');
    expect(handout[1].title).toBe('Speaker Notes Digest');
    expect(handout.every(isPresentationHandoutSlide)).toBe(true);
    expect(handout[0].elements.some((element) => element.text === 'Takeaway Flow')).toBe(true);
    expect(handout[1].elements.some((element) => element.text === 'Speaker Notes Digest')).toBe(true);
    expect(withHandout).toHaveLength(slides.length + 2);
    expect(withHandout.at(-2)?.title).toBe('Executive Handout');
    expect(withHandout.at(-1)?.title).toBe('Speaker Notes Digest');
    expect(analyzePresentationRehearsal(withHandout).visibleSlides).toBe(slides.length);
    expect(repeated.filter(isPresentationHandoutSlide)).toHaveLength(2);
    expect(repeated).toHaveLength(slides.length + 2);
  });

  it('builds and inserts an investor pitch pack idempotently', () => {
    const theme = PPTX_DESIGN_THEMES[0];
    const pitchSlides: Slide[] = [
      {
        id: 'market',
        title: 'Customer Market Problem',
        bgColor: '#ffffff',
        elements: [
          { id: 'm1', type: 'text', x: 8, y: 8, w: 80, h: 10, text: 'Customer market pain is urgent and growing.', fontSize: 26 },
        ],
        notes: 'Open with the customer pain, market size, and urgency.',
      },
      {
        id: 'traction',
        title: 'Revenue Traction',
        bgColor: '#ffffff',
        elements: [
          { id: 't1', type: 'text', x: 8, y: 8, w: 80, h: 10, text: 'Revenue growth, activation, and retention are improving.', fontSize: 26 },
        ],
        notes: 'Show the source metric, customer proof, and repeatability.',
      },
      {
        id: 'ask',
        title: 'Investment Ask',
        bgColor: '#ffffff',
        elements: [
          { id: 'a1', type: 'text', x: 8, y: 8, w: 80, h: 10, text: 'The ask is approval for investment and next step owner.', fontSize: 26 },
        ],
        notes: 'Close with the exact ask, owner, and next decision date.',
      },
    ];

    const investorPack = buildPresentationInvestorPackSlides(pitchSlides, theme, (slide, idx) => slide.title || `Slide ${idx + 1}`);
    const withInvestorPack = insertPresentationInvestorPack(pitchSlides, theme);
    const repeated = insertPresentationInvestorPack(withInvestorPack, theme);

    expect(investorPack).toHaveLength(2);
    expect(investorPack[0].title).toBe('Investor Pitch Scorecard');
    expect(investorPack[1].title).toBe('Investor Objection Ledger');
    expect(investorPack.every(isPresentationInvestorPackSlide)).toBe(true);
    expect(investorPack[0].elements.some((element) => element.text === 'Fundraising Story Arc')).toBe(true);
    expect(investorPack[0].elements.some((element) => element.text === 'Partner Memo')).toBe(true);
    expect(investorPack[1].elements.some((element) => element.text === 'Investor Objection Ledger')).toBe(true);
    expect(investorPack[1].elements.some((element) => String(element.text || '').includes('Partner meeting rule'))).toBe(true);
    expect(withInvestorPack).toHaveLength(pitchSlides.length + 2);
    expect(withInvestorPack.at(-2)?.title).toBe('Investor Pitch Scorecard');
    expect(withInvestorPack.at(-1)?.title).toBe('Investor Objection Ledger');
    expect(analyzePresentationRehearsal(withInvestorPack).visibleSlides).toBe(pitchSlides.length);
    expect(repeated.filter(isPresentationInvestorPackSlide)).toHaveLength(2);
    expect(repeated).toHaveLength(pitchSlides.length + 2);
  });
});
