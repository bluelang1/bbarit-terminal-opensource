import type { Slide, SlideElement } from './types';
import { uid } from './types';
import type { PptxDesignTheme } from './pptxDesignThemes';

export interface PptxRehearsalSlideReport {
  slideId: string;
  slideIndex: number;
  title: string;
  wordCount: number;
  notesWordCount: number;
  estimatedSeconds: number;
  recommendedAdvanceSec: number;
  issues: string[];
}

export interface PptxRehearsalReport {
  score: number;
  totalSeconds: number;
  visibleSlides: number;
  slidesWithNotes: number;
  issues: string[];
  slideReports: PptxRehearsalSlideReport[];
}

const WORD_RE = /[A-Za-z0-9]+|[\u3131-\uD79D]+/g;
const RUN_OF_SHOW_MARKER = '[BBARIT_RUN_OF_SHOW]';
const AGENDA_MARKER = '[BBARIT_AGENDA]';
const BOARD_PACK_MARKER = '[BBARIT_BOARD_PACK]';
const QA_PACK_MARKER = '[BBARIT_QA_PACK]';
const HANDOUT_MARKER = '[BBARIT_HANDOUT]';
const AUDIENCE_DRILL_MARKER = '[BBARIT_AUDIENCE_DRILL]';
const SCRIPT_PACK_MARKER = '[BBARIT_SCRIPT_PACK]';
const INVESTOR_PACK_MARKER = '[BBARIT_INVESTOR_PACK]';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function words(value: string): string[] {
  return String(value || '').match(WORD_RE) || [];
}

function wordCount(value: string): number {
  return words(value).length;
}

function normalizeSpace(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, limit: number): string {
  const text = normalizeSpace(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}...`;
}

function elementText(el: SlideElement): string {
  return normalizeSpace(el.text || '');
}

export function extractSlideSpeakingText(slide: Slide): string {
  return slide.elements
    .filter((el) => el.type === 'text' || el.type === 'rect' || el.type === 'circle')
    .map(elementText)
    .filter(Boolean)
    .join(' ');
}

export function estimateSpeakingSeconds(text: string, wordsPerMinute = 135): number {
  const count = wordCount(text);
  if (!count) return 8;
  return clamp(Math.round((count / wordsPerMinute) * 60) + 6, 10, 90);
}

export function formatRehearsalDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function fallbackTitle(slide: Slide, slideIndex: number, getTitle?: (slide: Slide, idx: number) => string): string {
  return normalizeSpace(getTitle?.(slide, slideIndex) || slide.title || extractSlideSpeakingText(slide).split(/\s+/).slice(0, 7).join(' ')) || `Slide ${slideIndex + 1}`;
}

export function analyzePresentationRehearsal(
  slides: Slide[],
  getTitle?: (slide: Slide, idx: number) => string,
): PptxRehearsalReport {
  const visibleEntries = slides
    .map((slide, idx) => ({ slide, idx }))
    .filter(({ slide }) => !slide.hidden && !isGeneratedPresentationHelperSlide(slide));
  const fallbackEntries = slides
    .map((slide, idx) => ({ slide, idx }))
    .filter(({ slide }) => !isGeneratedPresentationHelperSlide(slide));
  const entries = visibleEntries.length ? visibleEntries : fallbackEntries;

  const slideReports = entries.map(({ slide, idx }) => {
    const title = fallbackTitle(slide, idx, getTitle);
    const bodyText = extractSlideSpeakingText(slide);
    const notes = normalizeSpace(slide.notes || '');
    const combined = notes || bodyText || title;
    const bodyWords = wordCount(bodyText);
    const notesWords = wordCount(notes);
    const issues: string[] = [];
    const hasClearTitle = Boolean(slide.title?.trim())
      || slide.elements.some((el) => (el.type === 'text') && (el.fontSize || 0) >= 24 && elementText(el))
      || !/^Slide \d+$/i.test(title);

    if (!hasClearTitle) {
      issues.push('No clear title');
    }
    if (notesWords < 8) issues.push('Speaker notes missing or too short');
    if (bodyWords > 70) issues.push('Slide text is too dense for live delivery');
    if (bodyWords < 4 && !slide.elements.some((el) => el.type === 'image')) issues.push('Slide needs a stronger talking point');
    if (!slide.transition || slide.transition.type === 'none') issues.push('No transition timing');

    const estimatedSeconds = estimateSpeakingSeconds(combined);
    return {
      slideId: slide.id,
      slideIndex: idx,
      title,
      wordCount: bodyWords,
      notesWordCount: notesWords,
      estimatedSeconds,
      recommendedAdvanceSec: clamp(estimatedSeconds + 2, 10, 95),
      issues,
    };
  });

  const allIssues = slideReports.flatMap((report) => report.issues.map((issue) => `Slide ${report.slideIndex + 1}: ${issue}`));
  const score = clamp(
    100
      - slideReports.filter((report) => report.issues.includes('Speaker notes missing or too short')).length * 10
      - slideReports.filter((report) => report.issues.includes('Slide text is too dense for live delivery')).length * 12
      - slideReports.filter((report) => report.issues.includes('No clear title')).length * 8
      - slideReports.filter((report) => report.issues.includes('No transition timing')).length * 4,
    0,
    100,
  );

  return {
    score,
    totalSeconds: slideReports.reduce((sum, report) => sum + report.estimatedSeconds, 0),
    visibleSlides: entries.length,
    slidesWithNotes: slideReports.filter((report) => report.notesWordCount >= 8).length,
    issues: allIssues,
    slideReports,
  };
}

export function buildSpeakerNotesForSlide(slide: Slide, slideIndex: number, slideCount: number, title?: string): string {
  const heading = normalizeSpace(title || slide.title || `Slide ${slideIndex + 1}`);
  const body = extractSlideSpeakingText(slide);
  const talkingPoints = body
    .split(/[.!?\n]+/)
    .map(normalizeSpace)
    .filter((value) => value && value.toLowerCase() !== heading.toLowerCase())
    .slice(0, 2);
  const pointLine = talkingPoints.length
    ? `Call out ${talkingPoints.join('; ')}.`
    : 'Call out the main evidence, decision, or user impact on this slide.';
  const bridge = slideIndex >= slideCount - 1
    ? 'Close with the decision, owner, and next action.'
    : 'Bridge to the next slide with the decision or question this sets up.';

  return [
    `Open: frame "${heading}" in one sentence.`,
    pointLine,
    bridge,
  ].join('\n');
}

export function enrichDeckSpeakerNotes(
  slides: Slide[],
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  return slides.map((slide, idx) => {
    if (wordCount(slide.notes || '') >= 8) return slide;
    return {
      ...slide,
      notes: buildSpeakerNotesForSlide(slide, idx, slides.length, fallbackTitle(slide, idx, getTitle)),
    };
  });
}

export function applyRehearsalTiming(
  slides: Slide[],
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const report = analyzePresentationRehearsal(slides, getTitle);
  const timingById = new Map(report.slideReports.map((slideReport) => [slideReport.slideId, slideReport.recommendedAdvanceSec]));
  return slides.map((slide) => ({
    ...slide,
    transition: {
      type: slide.transition?.type && slide.transition.type !== 'none' ? slide.transition.type : 'fade',
      durationMs: slide.transition?.durationMs || 450,
      advanceAfterSec: timingById.get(slide.id) || slide.transition?.advanceAfterSec || 0,
    },
  }));
}

const runText = (
  x: number,
  y: number,
  w: number,
  h: number,
  value: string,
  fontSize: number,
  extra: Partial<SlideElement> = {},
): SlideElement => ({
  id: uid(),
  type: 'text',
  x,
  y,
  w,
  h,
  text: value,
  fontSize,
  fontColor: '#111827',
  ...extra,
});

const runRect = (x: number, y: number, w: number, h: number, fillColor: string, extra: Partial<SlideElement> = {}): SlideElement => ({
  id: uid(),
  type: 'rect',
  x,
  y,
  w,
  h,
  fillColor,
  borderWidth: 0,
  ...extra,
});

export function isPresentationRunOfShowSlide(slide: Slide): boolean {
  return String(slide.notes || '').includes(RUN_OF_SHOW_MARKER);
}

export function isPresentationAgendaSlide(slide: Slide): boolean {
  return String(slide.notes || '').includes(AGENDA_MARKER);
}

export function isPresentationBoardPackSlide(slide: Slide): boolean {
  return String(slide.notes || '').includes(BOARD_PACK_MARKER);
}

export function isPresentationQAPackSlide(slide: Slide): boolean {
  return String(slide.notes || '').includes(QA_PACK_MARKER);
}

export function isPresentationHandoutSlide(slide: Slide): boolean {
  return String(slide.notes || '').includes(HANDOUT_MARKER);
}

export function isPresentationAudienceDrillSlide(slide: Slide): boolean {
  return String(slide.notes || '').includes(AUDIENCE_DRILL_MARKER);
}

export function isPresentationScriptPackSlide(slide: Slide): boolean {
  return String(slide.notes || '').includes(SCRIPT_PACK_MARKER);
}

export function isPresentationInvestorPackSlide(slide: Slide): boolean {
  return String(slide.notes || '').includes(INVESTOR_PACK_MARKER);
}

function isGeneratedPresentationHelperSlide(slide: Slide): boolean {
  return isPresentationRunOfShowSlide(slide)
    || isPresentationAgendaSlide(slide)
    || isPresentationBoardPackSlide(slide)
    || isPresentationQAPackSlide(slide)
    || isPresentationHandoutSlide(slide)
    || isPresentationAudienceDrillSlide(slide)
    || isPresentationScriptPackSlide(slide)
    || isPresentationInvestorPackSlide(slide);
}

export function buildPresentationRunOfShowSlide(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide {
  const report = analyzePresentationRehearsal(slides.filter((slide) => !isPresentationRunOfShowSlide(slide)), getTitle);
  const issueSlides = report.slideReports.filter((slideReport) => slideReport.issues.length > 0);
  const visibleReports = report.slideReports.slice(0, 6);
  const topIssue = issueSlides[0]?.issues[0] || 'Deck is ready for presenter mode.';
  const elements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runRect(0, 0, 100, 23, theme.primaryColor),
    runText(7, 6, 58, 8, 'Run of Show', 34, { bold: true, fontColor: theme.bgColor }),
    runText(68, 8, 23, 5, `Rehearsal ${report.score}/100`, 15, { bold: true, fontColor: theme.bgColor, textAlign: 'right' }),
    runRect(7, 29, 24, 16, theme.surfaceColor),
    runText(9, 33, 19, 4, 'Total Time', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(9, 38, 19, 5, formatRehearsalDuration(report.totalSeconds), 20, { bold: true, fontColor: theme.primaryColor }),
    runRect(38, 29, 24, 16, theme.surfaceAltColor),
    runText(40, 33, 19, 4, 'Speaker Notes', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(40, 38, 19, 5, `${report.slidesWithNotes}/${report.visibleSlides}`, 20, { bold: true, fontColor: theme.primaryColor }),
    runRect(69, 29, 24, 16, issueSlides.length ? '#fef3c7' : '#dcfce7'),
    runText(71, 33, 19, 4, 'Priority Fix', 12, { bold: true, fontColor: '#475569' }),
    runText(71, 38, 19, 5, issueSlides.length ? `${issueSlides.length} slide${issueSlides.length === 1 ? '' : 's'}` : 'Ready', 18, { bold: true, fontColor: theme.primaryColor }),
    runText(7, 52, 45, 5, 'Presenter Cue Sheet', 17, { bold: true, fontColor: theme.primaryColor }),
    runText(55, 52, 38, 5, 'First Fix', 17, { bold: true, fontColor: theme.primaryColor }),
    runRect(7, 58, 45, 4, theme.primaryColor),
    runText(9, 58.6, 6, 2.5, '#', 9, { bold: true, fontColor: theme.bgColor }),
    runText(16, 58.6, 24, 2.5, 'Slide', 9, { bold: true, fontColor: theme.bgColor }),
    runText(41, 58.6, 8, 2.5, 'Time', 9, { bold: true, fontColor: theme.bgColor, textAlign: 'right' }),
    runRect(55, 58, 38, 31, issueSlides.length ? '#fff7ed' : '#ecfdf5', { borderColor: theme.accentColor, borderWidth: 1 }),
    runText(58, 62, 31, 9, topIssue, 13, { bold: true, fontColor: theme.primaryColor }),
    runText(58, 75, 29, 3.5, 'Opening Cue', 10, { bold: true, fontColor: theme.mutedTextColor }),
    runText(58, 80, 29, 4, report.slideReports[0]?.title || 'Start deck', 12, { bold: true, fontColor: theme.textColor }),
    runText(58, 85, 29, 3, `${report.slidesWithNotes}/${report.visibleSlides} notes · ${formatRehearsalDuration(report.totalSeconds)}`, 9, { fontColor: theme.mutedTextColor }),
  ];

  visibleReports.forEach((slideReport, idx) => {
    const y = 63 + idx * 5.4;
    const fill = idx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor;
    elements.push(runRect(7, y, 45, 4.7, fill));
    elements.push(runText(9, y + 0.7, 5, 2.4, String(slideReport.slideIndex + 1), 8.5, { bold: true, fontColor: theme.primaryColor }));
    elements.push(runText(16, y + 0.5, 24, 2.1, slideReport.title, 8.5, { bold: true, fontColor: theme.textColor }));
    elements.push(runText(16, y + 2.6, 25, 1.7, slideReport.issues[0] || 'Ready', 6.7, { fontColor: theme.mutedTextColor }));
    elements.push(runText(41, y + 1.2, 8, 2.1, formatRehearsalDuration(slideReport.estimatedSeconds), 8, { fontColor: theme.textColor, textAlign: 'right' }));
  });

  return {
    id: uid(),
    title: 'Run of Show',
    bgColor: theme.bgColor,
    hidden: false,
    transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
    notes: `${RUN_OF_SHOW_MARKER}\nUse this as the presenter checklist before starting the show. Confirm timing, notes coverage, priority fixes, and the opening transition.`,
    elements,
  };
}

export function insertPresentationRunOfShow(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const deckWithoutPriorRunSheet = slides.filter((slide) => !isPresentationRunOfShowSlide(slide));
  const runOfShow = buildPresentationRunOfShowSlide(deckWithoutPriorRunSheet, theme, getTitle);
  return [runOfShow, ...deckWithoutPriorRunSheet];
}

export function buildPresentationAgendaSlide(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide {
  const sourceSlides = slides.filter((slide) => !isGeneratedPresentationHelperSlide(slide));
  const report = analyzePresentationRehearsal(sourceSlides, getTitle);
  const visibleReports = report.slideReports.slice(0, 7);
  const longest = [...report.slideReports].sort((a, b) => b.estimatedSeconds - a.estimatedSeconds)[0];
  const elements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runRect(0, 0, 100, 100, theme.surfaceColor, { opacity: 0.32 }),
    runRect(0, 0, 31, 100, theme.primaryColor),
    runText(6, 8, 20, 5, 'AGENDA', 12, { bold: true, fontColor: theme.bgColor }),
    runText(6, 16, 20, 18, 'What we will cover', 29, { bold: true, fontColor: theme.bgColor }),
    runText(6, 78, 18, 4, `${report.visibleSlides} slides`, 13, { bold: true, fontColor: theme.bgColor }),
    runText(6, 84, 18, 4, `${formatRehearsalDuration(report.totalSeconds)} total`, 13, { fontColor: theme.bgColor }),
    runText(38, 8, 47, 6, 'Audience Flow', 24, { bold: true, fontColor: theme.primaryColor }),
    runText(38, 16, 48, 4, 'Auto-built from slide titles, speaking time, and rehearsal checks.', 11, { fontColor: theme.mutedTextColor }),
    runText(38, 83, 47, 4, `Longest segment: ${longest?.title || 'n/a'}`, 11, { bold: true, fontColor: theme.primaryColor }),
    runText(38, 88, 47, 4, `${report.slidesWithNotes}/${report.visibleSlides} slides have presenter notes coverage.`, 10, { fontColor: theme.mutedTextColor }),
  ];

  if (!visibleReports.length) {
    elements.push(runText(38, 35, 45, 7, 'Add slides to generate an audience-ready agenda.', 18, { bold: true, fontColor: theme.textColor }));
  } else {
    visibleReports.forEach((slideReport, idx) => {
      const y = 27 + idx * 7.2;
      const duration = formatRehearsalDuration(slideReport.estimatedSeconds);
      const fill = idx % 2 === 0 ? theme.bgColor : theme.surfaceAltColor;
      elements.push(runRect(38, y, 50, 5.8, fill, { borderColor: idx === 0 ? theme.accentColor : theme.surfaceAltColor, borderWidth: 1 }));
      elements.push(runText(40, y + 1.1, 5, 2.4, String(idx + 1).padStart(2, '0'), 10, { bold: true, fontColor: theme.primaryColor }));
      elements.push(runText(47, y + 0.7, 26, 2.7, slideReport.title, 10.5, { bold: true, fontColor: theme.textColor }));
      elements.push(runText(47, y + 3.2, 28, 1.9, slideReport.issues[0] || 'Ready for live delivery', 7.2, { fontColor: theme.mutedTextColor }));
      elements.push(runText(78, y + 1.5, 8, 2.2, duration, 9, { bold: true, fontColor: theme.primaryColor, textAlign: 'right' }));
    });
  }

  return {
    id: uid(),
    title: 'Audience Agenda',
    bgColor: theme.bgColor,
    hidden: false,
    transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
    notes: `${AGENDA_MARKER}\nOpen the presentation by orienting the audience to this agenda. Keep the promise tight, then use the listed timing as a pacing guide.`,
    elements,
  };
}

export function insertPresentationAgenda(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const deckWithoutPriorAgenda = slides.filter((slide) => !isPresentationAgendaSlide(slide));
  const agenda = buildPresentationAgendaSlide(deckWithoutPriorAgenda, theme, getTitle);
  const runSheetIdx = deckWithoutPriorAgenda.findIndex(isPresentationRunOfShowSlide);
  if (runSheetIdx >= 0) {
    return [
      ...deckWithoutPriorAgenda.slice(0, runSheetIdx + 1),
      agenda,
      ...deckWithoutPriorAgenda.slice(runSheetIdx + 1),
    ];
  }
  return [agenda, ...deckWithoutPriorAgenda];
}

function firstMatchingReport(
  reports: PptxRehearsalSlideReport[],
  pattern: RegExp,
): PptxRehearsalSlideReport | undefined {
  return reports.find((report) => pattern.test(report.title));
}

export function buildPresentationBoardPackSlides(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const sourceSlides = slides.filter((slide) => !isGeneratedPresentationHelperSlide(slide));
  const report = analyzePresentationRehearsal(sourceSlides, getTitle);
  const issueReports = report.slideReports.filter((slideReport) => slideReport.issues.length > 0);
  const candidateDecisionReports = [
    firstMatchingReport(report.slideReports, /ask|decision|risk|roadmap|next|close|approval|투자|결정|승인/i),
    firstMatchingReport(report.slideReports, /financial|forecast|pipeline|traction|revenue|metric|budget|매출|예산/i),
    firstMatchingReport(report.slideReports, /customer|market|problem|solution|launch|audience|고객|시장/i),
  ].filter((item): item is PptxRehearsalSlideReport => Boolean(item));
  const decisionReports = candidateDecisionReports.filter((item, idx, arr) => (
    arr.findIndex((other) => other.slideId === item.slideId) === idx
  ));
  const decisionQueue = (decisionReports.length ? decisionReports : report.slideReports.slice(-3)).slice(0, 4);
  const issueCounts = new Map<string, number>();
  report.slideReports.forEach((slideReport) => {
    slideReport.issues.forEach((issue) => issueCounts.set(issue, (issueCounts.get(issue) || 0) + 1));
  });
  const riskRows = [...issueCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topFixes = issueReports.slice(0, 5);
  const readinessColor = report.score >= 80 ? '#dcfce7' : report.score >= 55 ? '#fef3c7' : '#fee2e2';

  const decisionElements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runRect(0, 0, 100, 22, theme.primaryColor),
    runText(7, 6, 58, 8, 'Board Decision Pack', 31, { bold: true, fontColor: theme.bgColor }),
    runText(70, 8, 21, 5, `Ready ${report.score}/100`, 15, { bold: true, fontColor: theme.bgColor, textAlign: 'right' }),
    runRect(7, 29, 24, 16, readinessColor),
    runText(9, 33, 19, 4, 'Deck Readiness', 12, { bold: true, fontColor: '#475569' }),
    runText(9, 38, 19, 5, `${report.score}/100`, 20, { bold: true, fontColor: theme.primaryColor }),
    runRect(38, 29, 24, 16, theme.surfaceColor),
    runText(40, 33, 19, 4, 'Talk Time', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(40, 38, 19, 5, formatRehearsalDuration(report.totalSeconds), 20, { bold: true, fontColor: theme.primaryColor }),
    runRect(69, 29, 24, 16, theme.surfaceAltColor),
    runText(71, 33, 19, 4, 'Notes Coverage', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(71, 38, 19, 5, `${report.slidesWithNotes}/${report.visibleSlides}`, 20, { bold: true, fontColor: theme.primaryColor }),
    runText(7, 53, 42, 5, 'Decision Queue', 18, { bold: true, fontColor: theme.primaryColor }),
    runText(55, 53, 38, 5, 'Board Lens', 18, { bold: true, fontColor: theme.primaryColor }),
    runRect(55, 60, 38, 25, theme.surfaceColor, { borderColor: theme.accentColor, borderWidth: 1 }),
    runText(58, 64, 30, 5, issueReports.length ? `${issueReports.length} slides need cleanup before the room.` : 'No critical presentation cleanup detected.', 13, { bold: true, fontColor: theme.textColor }),
    runText(58, 73, 30, 4, `Use this appendix to answer: what changed, what decision is needed, who owns the next move.`, 9.5, { fontColor: theme.mutedTextColor }),
    runText(58, 81, 30, 3.5, `Slides analyzed: ${report.visibleSlides}`, 9, { fontColor: theme.mutedTextColor }),
  ];

  if (!decisionQueue.length) {
    decisionElements.push(runText(8, 63, 38, 7, 'Add slides to generate a decision queue.', 16, { bold: true, fontColor: theme.textColor }));
  } else {
    decisionQueue.forEach((slideReport, idx) => {
      const y = 60 + idx * 6.2;
      const fill = idx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor;
      decisionElements.push(runRect(7, y, 42, 5.2, fill));
      decisionElements.push(runText(9, y + 0.9, 5, 2.2, String(slideReport.slideIndex + 1), 9, { bold: true, fontColor: theme.primaryColor }));
      decisionElements.push(runText(16, y + 0.6, 23, 2.3, slideReport.title, 9, { bold: true, fontColor: theme.textColor }));
      decisionElements.push(runText(16, y + 3.0, 25, 1.6, slideReport.issues[0] || 'Ready for executive discussion', 6.7, { fontColor: theme.mutedTextColor }));
      decisionElements.push(runText(42, y + 1.5, 5, 1.9, formatRehearsalDuration(slideReport.estimatedSeconds), 7, { fontColor: theme.primaryColor, textAlign: 'right' }));
    });
  }

  const riskElements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runText(7, 8, 70, 7, 'Board Risk Register', 29, { bold: true, fontColor: theme.primaryColor }),
    runText(7, 17, 70, 4, 'Generated from rehearsal issues, slide density, notes coverage, and pacing.', 11, { fontColor: theme.mutedTextColor }),
    runText(7, 29, 42, 5, 'Quality Risks', 18, { bold: true, fontColor: theme.primaryColor }),
    runText(55, 29, 38, 5, 'Next Fixes', 18, { bold: true, fontColor: theme.primaryColor }),
    runRect(7, 36, 42, 4, theme.primaryColor),
    runText(9, 36.8, 22, 1.8, 'Signal', 8, { bold: true, fontColor: theme.bgColor }),
    runText(36, 36.8, 9, 1.8, 'Slides', 8, { bold: true, fontColor: theme.bgColor, textAlign: 'right' }),
    runRect(55, 36, 38, 4, theme.primaryColor),
    runText(57, 36.8, 7, 1.8, '#', 8, { bold: true, fontColor: theme.bgColor }),
    runText(65, 36.8, 25, 1.8, 'Fix', 8, { bold: true, fontColor: theme.bgColor }),
  ];

  if (!riskRows.length) {
    riskElements.push(runRect(7, 42, 42, 10, '#ecfdf5'));
    riskElements.push(runText(9, 45, 36, 3.5, 'No quality risks detected.', 13, { bold: true, fontColor: theme.textColor }));
  } else {
    riskRows.forEach(([issue, count], idx) => {
      const y = 42 + idx * 6;
      const fill = idx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor;
      riskElements.push(runRect(7, y, 42, 5, fill));
      riskElements.push(runText(9, y + 0.8, 24, 2, issue, 8.2, { bold: true, fontColor: theme.textColor }));
      riskElements.push(runText(36, y + 0.9, 9, 2, String(count), 8.5, { bold: true, fontColor: theme.primaryColor, textAlign: 'right' }));
    });
  }

  if (!topFixes.length) {
    riskElements.push(runRect(55, 42, 38, 10, '#ecfdf5'));
    riskElements.push(runText(57, 45, 31, 3.5, 'Deck is ready for a board conversation.', 12, { bold: true, fontColor: theme.textColor }));
  } else {
    topFixes.forEach((slideReport, idx) => {
      const y = 42 + idx * 6;
      const fill = idx % 2 === 0 ? '#fff7ed' : '#fef3c7';
      riskElements.push(runRect(55, y, 38, 5, fill));
      riskElements.push(runText(57, y + 0.8, 6, 2, String(slideReport.slideIndex + 1), 8.5, { bold: true, fontColor: theme.primaryColor }));
      riskElements.push(runText(65, y + 0.6, 22, 1.8, slideReport.title, 8, { bold: true, fontColor: theme.textColor }));
      riskElements.push(runText(65, y + 2.8, 24, 1.6, slideReport.issues[0], 6.5, { fontColor: theme.mutedTextColor }));
    });
  }

  riskElements.push(runRect(7, 78, 86, 10, theme.surfaceColor, { borderColor: theme.accentColor, borderWidth: 1 }));
  riskElements.push(runText(9, 81, 80, 3.5, 'Board prep move: rehearse the decision queue, assign owners, and tighten any slide flagged above before exporting.', 11, { bold: true, fontColor: theme.textColor }));

  return [
    {
      id: uid(),
      title: 'Board Decision Pack',
      bgColor: theme.bgColor,
      hidden: false,
      transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
      notes: `${BOARD_PACK_MARKER}\nUse this as the executive appendix for decision framing, pacing, and board-room readiness.`,
      elements: decisionElements,
    },
    {
      id: uid(),
      title: 'Board Risk Register',
      bgColor: theme.bgColor,
      hidden: false,
      transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
      notes: `${BOARD_PACK_MARKER}\nUse this slide to resolve risk, owner, timing, and notes-quality issues before presenting.`,
      elements: riskElements,
    },
  ];
}

export function insertPresentationBoardPack(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const deckWithoutPriorBoardPack = slides.filter((slide) => !isPresentationBoardPackSlide(slide));
  const boardPack = buildPresentationBoardPackSlides(deckWithoutPriorBoardPack, theme, getTitle);
  return [...deckWithoutPriorBoardPack, ...boardPack];
}

function questionForReport(slideReport: PptxRehearsalSlideReport, idx: number): string {
  const title = slideReport.title;
  const defaults = [
    `What decision or tradeoff is hidden inside "${title}"?`,
    `What evidence would make "${title}" more defensible?`,
    `What could delay "${title}" and who owns the mitigation?`,
    `What is the executive headline if someone challenges "${title}"?`,
  ];
  if (/revenue|metric|growth|pipeline|budget|forecast|매출|예산|지표/i.test(title)) {
    return `What explains the movement in "${title}" and can we prove it?`;
  }
  if (/risk|issue|block|dependency|위험|리스크|이슈/i.test(title)) {
    return `What is the mitigation, owner, and decision needed for "${title}"?`;
  }
  if (/customer|market|launch|audience|고객|시장|출시/i.test(title)) {
    return `Why will the audience or market believe "${title}" now?`;
  }
  if (/ask|decision|approval|next|결정|승인/i.test(title)) {
    return `What exactly are we asking the room to approve in "${title}"?`;
  }
  return defaults[idx % defaults.length];
}

export function buildPresentationQAPackSlides(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const sourceSlides = slides.filter((slide) => !isGeneratedPresentationHelperSlide(slide));
  const report = analyzePresentationRehearsal(sourceSlides, getTitle);
  const issueReports = report.slideReports.filter((slideReport) => slideReport.issues.length > 0);
  const priorityReports = [
    ...issueReports,
    ...report.slideReports.filter((slideReport) => /ask|decision|risk|revenue|metric|launch|approval|결정|승인|위험|매출/i.test(slideReport.title)),
    ...report.slideReports,
  ].filter((slideReport, idx, arr) => arr.findIndex((other) => other.slideId === slideReport.slideId) === idx).slice(0, 5);
  const questions = priorityReports.map((slideReport, idx) => ({
    slideReport,
    question: questionForReport(slideReport, idx),
  }));
  const openingQuestion = questions[0]?.question || 'What is the sharpest question the audience can ask?';
  const readiness = report.score >= 80 ? 'Ready for live Q&A' : report.score >= 55 ? 'Needs answer prep' : 'High-risk Q&A';
  const readinessColor = report.score >= 80 ? '#dcfce7' : report.score >= 55 ? '#fef3c7' : '#fee2e2';

  const mapElements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runRect(0, 0, 100, 23, theme.primaryColor),
    runText(7, 6, 57, 8, 'Q&A Defense Map', 31, { bold: true, fontColor: theme.bgColor }),
    runText(68, 8, 23, 5, `Q&A ${report.score}/100`, 15, { bold: true, fontColor: theme.bgColor, textAlign: 'right' }),
    runRect(7, 29, 24, 16, readinessColor),
    runText(9, 33, 19, 4, 'Room Readiness', 12, { bold: true, fontColor: '#475569' }),
    runText(9, 38, 19, 5, readiness, 13, { bold: true, fontColor: theme.primaryColor }),
    runRect(38, 29, 24, 16, theme.surfaceColor),
    runText(40, 33, 19, 4, 'Answer Gaps', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(40, 38, 19, 5, String(issueReports.length), 22, { bold: true, fontColor: theme.primaryColor }),
    runRect(69, 29, 24, 16, theme.surfaceAltColor),
    runText(71, 33, 19, 4, 'Talk Time', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(71, 38, 19, 5, formatRehearsalDuration(report.totalSeconds), 20, { bold: true, fontColor: theme.primaryColor }),
    runText(7, 52, 52, 5, 'Likely Questions', 18, { bold: true, fontColor: theme.primaryColor }),
    runText(65, 52, 28, 5, 'Opening Defense', 18, { bold: true, fontColor: theme.primaryColor }),
    runRect(65, 60, 28, 25, theme.surfaceColor, { borderColor: theme.accentColor, borderWidth: 1 }),
    runText(68, 64, 22, 8, openingQuestion, 12, { bold: true, fontColor: theme.textColor }),
    runText(68, 77, 20, 4, 'Answer with: headline, evidence, tradeoff, owner.', 9.5, { fontColor: theme.mutedTextColor }),
  ];

  if (!questions.length) {
    mapElements.push(runText(8, 62, 49, 7, 'Add slides to generate a Q&A defense map.', 16, { bold: true, fontColor: theme.textColor }));
  } else {
    questions.forEach(({ slideReport, question }, idx) => {
      const y = 60 + idx * 6.1;
      const fill = idx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor;
      mapElements.push(runRect(7, y, 52, 5.1, fill));
      mapElements.push(runText(9, y + 0.8, 5, 2.2, String(slideReport.slideIndex + 1), 8.5, { bold: true, fontColor: theme.primaryColor }));
      mapElements.push(runText(16, y + 0.5, 37, 2.1, question, 8.1, { bold: true, fontColor: theme.textColor }));
      mapElements.push(runText(16, y + 2.8, 37, 1.6, slideReport.issues[0] || 'Use this as a backup talking point.', 6.5, { fontColor: theme.mutedTextColor }));
    });
  }

  const answerElements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runText(7, 8, 70, 7, 'Answer Bank', 29, { bold: true, fontColor: theme.primaryColor }),
    runText(7, 17, 74, 4, 'A structured response sheet for presenter mode, investor meetings, and board follow-up.', 11, { fontColor: theme.mutedTextColor }),
    runRect(7, 29, 86, 4, theme.primaryColor),
    runText(9, 29.8, 24, 1.8, 'Question', 8, { bold: true, fontColor: theme.bgColor }),
    runText(39, 29.8, 22, 1.8, 'Answer Frame', 8, { bold: true, fontColor: theme.bgColor }),
    runText(67, 29.8, 20, 1.8, 'Proof Needed', 8, { bold: true, fontColor: theme.bgColor }),
  ];

  const answerRows = questions.length ? questions.slice(0, 5) : [{
    slideReport: report.slideReports[0] || {
      slideId: 'fallback',
      slideIndex: 0,
      title: 'Deck',
      wordCount: 0,
      notesWordCount: 0,
      estimatedSeconds: 0,
      recommendedAdvanceSec: 0,
      issues: ['Add evidence'],
    },
    question: 'What decision should the audience make after this deck?',
  }];
  answerRows.forEach(({ slideReport, question }, idx) => {
    const y = 36 + idx * 8;
    const fill = idx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor;
    answerElements.push(runRect(7, y, 86, 6.8, fill, { borderColor: idx === 0 ? theme.accentColor : fill, borderWidth: 1 }));
    answerElements.push(runText(9, y + 0.8, 25, 2.2, question, 7.6, { bold: true, fontColor: theme.textColor }));
    answerElements.push(runText(39, y + 0.8, 23, 2.2, 'Headline → evidence → tradeoff → next owner', 7.2, { fontColor: theme.textColor }));
    answerElements.push(runText(67, y + 0.8, 20, 2.2, slideReport.issues[0] || 'Metric, customer proof, or owner', 7.2, { fontColor: theme.mutedTextColor }));
  });
  answerElements.push(runRect(7, 80, 86, 8, theme.surfaceColor, { borderColor: theme.accentColor, borderWidth: 1 }));
  answerElements.push(runText(9, 82.2, 78, 3.2, 'Presenter rule: answer the question asked, bridge once to the core narrative, then name the follow-up owner.', 10.5, { bold: true, fontColor: theme.textColor }));

  return [
    {
      id: uid(),
      title: 'Q&A Defense Map',
      bgColor: theme.bgColor,
      hidden: false,
      transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
      notes: `${QA_PACK_MARKER}\nUse this slide before the live Q&A. Start with the likely objections, then decide which proof or owner is missing.`,
      elements: mapElements,
    },
    {
      id: uid(),
      title: 'Answer Bank',
      bgColor: theme.bgColor,
      hidden: false,
      transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
      notes: `${QA_PACK_MARKER}\nUse this as speaker-only prep or as a follow-up appendix for unanswered questions.`,
      elements: answerElements,
    },
  ];
}

export function insertPresentationQAPack(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const deckWithoutPriorQAPack = slides.filter((slide) => !isPresentationQAPackSlide(slide));
  const qaPack = buildPresentationQAPackSlides(deckWithoutPriorQAPack, theme, getTitle);
  return [...deckWithoutPriorQAPack, ...qaPack];
}

function answerFrameForQuestion(question: string, slideReport: PptxRehearsalSlideReport): string {
  if (/prove|evidence|movement|metric|revenue|forecast|budget/i.test(question)) {
    return 'Open with the number, cite source/date, then name the assumption that could change it.';
  }
  if (/delay|risk|mitigation|owner/i.test(question)) {
    return 'Name the risk, mitigation owner, decision threshold, and fallback path.';
  }
  if (/approve|asking|decision/i.test(question)) {
    return 'State the exact ask, why now, what changes if approved, and who owns follow-up.';
  }
  if (slideReport.issues.includes('Slide text is too dense for live delivery')) {
    return 'Summarize the slide in one headline, then offer to follow up with the detail.';
  }
  return 'Answer with headline, proof, tradeoff, and next owner.';
}

export function buildPresentationAudienceDrillSlide(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide {
  const sourceSlides = slides.filter((slide) => !isGeneratedPresentationHelperSlide(slide));
  const report = analyzePresentationRehearsal(sourceSlides, getTitle);
  const priorityReports = [
    ...report.slideReports.filter((slideReport) => slideReport.issues.length > 0),
    ...report.slideReports.filter((slideReport) => /ask|decision|risk|revenue|metric|launch|approval|customer|market|결정|승인|위험|매출/i.test(slideReport.title)),
    ...report.slideReports,
  ].filter((slideReport, idx, arr) => arr.findIndex((other) => other.slideId === slideReport.slideId) === idx).slice(0, 4);
  const drills = priorityReports.map((slideReport, idx) => {
    const question = questionForReport(slideReport, idx);
    return {
      slideReport,
      question,
      answer: answerFrameForQuestion(question, slideReport),
    };
  });
  const readiness = report.score >= 80 ? 'Live-ready' : report.score >= 55 ? 'Needs drill' : 'High pressure';
  const readinessColor = report.score >= 80 ? '#dcfce7' : report.score >= 55 ? '#fef3c7' : '#fee2e2';
  const first = drills[0];
  const elements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runRect(0, 0, 100, 24, theme.primaryColor),
    runText(7, 6, 58, 8, 'Audience Drill Room', 32, { bold: true, fontColor: theme.bgColor }),
    runText(68, 8, 23, 5, `Q&A ${report.score}/100`, 15, { bold: true, fontColor: theme.bgColor, textAlign: 'right' }),
    runRect(7, 30, 24, 16, readinessColor),
    runText(9, 34, 19, 4, 'Readiness', 12, { bold: true, fontColor: '#475569' }),
    runText(9, 39, 19, 5, readiness, 18, { bold: true, fontColor: theme.primaryColor }),
    runRect(38, 30, 24, 16, theme.surfaceColor),
    runText(40, 34, 19, 4, 'Drill Cards', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(40, 39, 19, 5, String(drills.length || 1), 22, { bold: true, fontColor: theme.primaryColor }),
    runRect(69, 30, 24, 16, theme.surfaceAltColor),
    runText(71, 34, 19, 4, 'Pace Target', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(71, 39, 19, 5, '20 sec', 20, { bold: true, fontColor: theme.primaryColor }),
    runText(7, 53, 43, 5, 'Hot Seat Question', 18, { bold: true, fontColor: theme.primaryColor }),
    runText(55, 53, 38, 5, 'Answer Formula', 18, { bold: true, fontColor: theme.primaryColor }),
    runRect(7, 60, 43, 22, theme.surfaceColor, { borderColor: theme.accentColor, borderWidth: 1 }),
    runText(10, 64, 36, 8, first?.question || 'What is the hardest audience question for this deck?', 13, { bold: true, fontColor: theme.textColor }),
    runText(10, 76, 35, 3, first ? `Slide ${first.slideReport.slideIndex + 1}: ${first.slideReport.title}` : 'Add slides to generate drills.', 8.5, { fontColor: theme.mutedTextColor }),
    runRect(55, 60, 38, 22, theme.surfaceAltColor, { borderColor: theme.accentColor, borderWidth: 1 }),
    runText(58, 64, 30, 7, first?.answer || 'Headline → proof → tradeoff → owner.', 11.5, { bold: true, fontColor: theme.textColor }),
    runText(58, 75, 30, 3.5, 'Then bridge once back to the story.', 9, { fontColor: theme.mutedTextColor }),
    runRect(7, 84.5, 86, 4, theme.primaryColor),
    runText(9, 85.3, 16, 1.6, 'Question', 7.5, { bold: true, fontColor: theme.bgColor }),
    runText(33, 85.3, 18, 1.6, '20-sec Answer', 7.5, { bold: true, fontColor: theme.bgColor }),
    runText(66, 85.3, 20, 1.6, 'Follow-up Owner', 7.5, { bold: true, fontColor: theme.bgColor }),
  ];

  drills.slice(0, 3).forEach((drill, idx) => {
    const y = 89 + idx * 3.4;
    const fill = idx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor;
    elements.push(runRect(7, y, 86, 2.8, fill));
    elements.push(runText(9, y + 0.5, 20, 1.3, truncateText(drill.question, 60), 5.5, { bold: true, fontColor: theme.textColor }));
    elements.push(runText(33, y + 0.5, 28, 1.3, truncateText(drill.answer, 68), 5.5, { fontColor: theme.textColor }));
    elements.push(runText(66, y + 0.5, 20, 1.3, drill.slideReport.issues[0] ? 'Prep owner' : 'Presenter', 5.5, { bold: true, fontColor: theme.primaryColor }));
  });

  return {
    id: uid(),
    title: 'Audience Drill Room',
    bgColor: theme.bgColor,
    hidden: false,
    transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
    notes: `${AUDIENCE_DRILL_MARKER}\nUse this as a presenter-only rehearsal sheet. Practice each answer in 20 seconds: headline, proof, tradeoff, and owner.`,
    elements,
  };
}

export function insertPresentationAudienceDrill(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const deckWithoutPriorDrill = slides.filter((slide) => !isPresentationAudienceDrillSlide(slide));
  const drill = buildPresentationAudienceDrillSlide(deckWithoutPriorDrill, theme, getTitle);
  return [...deckWithoutPriorDrill, drill];
}

function talkTrackForSlide(
  slide: Slide | undefined,
  slideReport: PptxRehearsalSlideReport,
  slideCount: number,
): { opening: string; proof: string; bridge: string; fallback: string } {
  const notes = normalizeSpace(slide?.notes || '');
  const body = normalizeSpace(slide ? extractSlideSpeakingText(slide) : '');
  const source = notes || body || slideReport.title;
  const sentences = source
    .split(/(?<=[.!?])\s+|[\n]+/)
    .map(normalizeSpace)
    .filter(Boolean)
    .filter((line) => line.toLowerCase() !== slideReport.title.toLowerCase());
  const opening = truncateText(sentences[0] || `Frame "${slideReport.title}" in one sentence.`, 108);
  const proof = truncateText(sentences[1] || 'Name the metric, customer signal, artifact, or decision evidence.', 110);
  const bridge = slideReport.slideIndex >= slideCount - 1
    ? 'Close with the decision, owner, and next action.'
    : 'Bridge to the next slide with the question this sets up.';
  const fallback = slideReport.issues.includes('Slide text is too dense for live delivery')
    ? 'If behind: skip detail, state the headline and one proof point.'
    : slideReport.issues.includes('Speaker notes missing or too short')
      ? 'If challenged: use the generated opening, then ask for follow-up owner.'
      : 'If behind: compress to headline, proof, implication.';
  return { opening, proof, bridge, fallback };
}

export function buildPresentationScriptPackSlides(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const sourceSlides = slides.filter((slide) => !isGeneratedPresentationHelperSlide(slide));
  const report = analyzePresentationRehearsal(sourceSlides, getTitle);
  const slideByIndex = new Map(sourceSlides.map((slide, idx) => [idx, slide]));
  const visibleReports = report.slideReports.slice(0, 7);
  const issueReports = report.slideReports.filter((slideReport) => slideReport.issues.length > 0);
  const longest = [...report.slideReports].sort((a, b) => b.estimatedSeconds - a.estimatedSeconds)[0];
  const readinessColor = report.score >= 80 ? '#dcfce7' : report.score >= 55 ? '#fef3c7' : '#fee2e2';

  const scriptElements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runRect(0, 0, 100, 23, theme.primaryColor),
    runText(7, 6, 58, 8, 'Presenter Script', 32, { bold: true, fontColor: theme.bgColor }),
    runText(68, 8, 23, 5, `Talk ${formatRehearsalDuration(report.totalSeconds)}`, 15, { bold: true, fontColor: theme.bgColor, textAlign: 'right' }),
    runRect(7, 29, 24, 16, readinessColor),
    runText(9, 33, 19, 4, 'Script Readiness', 12, { bold: true, fontColor: '#475569' }),
    runText(9, 38, 19, 5, `${report.score}/100`, 20, { bold: true, fontColor: theme.primaryColor }),
    runRect(38, 29, 24, 16, theme.surfaceColor),
    runText(40, 33, 19, 4, 'Notes Coverage', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(40, 38, 19, 5, `${report.slidesWithNotes}/${report.visibleSlides}`, 20, { bold: true, fontColor: theme.primaryColor }),
    runRect(69, 29, 24, 16, theme.surfaceAltColor),
    runText(71, 33, 19, 4, 'Fix Before Live', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(71, 38, 19, 5, issueReports.length ? `${issueReports.length}` : '0', 22, { bold: true, fontColor: theme.primaryColor }),
    runText(7, 52, 41, 5, 'Slide Talk Track', 18, { bold: true, fontColor: theme.primaryColor }),
    runText(54, 52, 39, 5, 'Presenter Rule', 18, { bold: true, fontColor: theme.primaryColor }),
    runRect(54, 60, 39, 23, theme.surfaceColor, { borderColor: theme.accentColor, borderWidth: 1 }),
    runText(57, 64, 31, 5, 'One slide = one sentence, one proof, one bridge.', 13, { bold: true, fontColor: theme.textColor }),
    runText(57, 73, 30, 4, longest ? `Longest segment: ${longest.title} (${formatRehearsalDuration(longest.estimatedSeconds)})` : 'Add slides to generate script.', 9.5, { fontColor: theme.mutedTextColor }),
    runText(57, 80, 30, 3.5, 'Use presenter mode to keep this as speaker-only prep.', 9, { fontColor: theme.mutedTextColor }),
    runRect(7, 59, 41, 4, theme.primaryColor),
    runText(9, 59.8, 5, 1.8, '#', 8, { bold: true, fontColor: theme.bgColor }),
    runText(15, 59.8, 21, 1.8, 'Open / Proof', 8, { bold: true, fontColor: theme.bgColor }),
    runText(40, 59.8, 6, 1.8, 'Time', 8, { bold: true, fontColor: theme.bgColor, textAlign: 'right' }),
  ];

  if (!visibleReports.length) {
    scriptElements.push(runText(8, 66, 36, 6, 'Add slides to generate a presenter script.', 15, { bold: true, fontColor: theme.textColor }));
  } else {
    visibleReports.forEach((slideReport, idx) => {
      const y = 65 + idx * 4.2;
      const track = talkTrackForSlide(slideByIndex.get(slideReport.slideIndex), slideReport, sourceSlides.length);
      const fill = idx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor;
      scriptElements.push(runRect(7, y, 41, 3.6, fill));
      scriptElements.push(runText(9, y + 0.5, 5, 1.6, String(slideReport.slideIndex + 1), 7, { bold: true, fontColor: theme.primaryColor }));
      scriptElements.push(runText(15, y + 0.3, 21, 1.4, truncateText(track.opening, 62), 6.5, { bold: true, fontColor: theme.textColor }));
      scriptElements.push(runText(15, y + 1.8, 22, 1.2, truncateText(track.proof, 72), 5.6, { fontColor: theme.mutedTextColor }));
      scriptElements.push(runText(40, y + 0.8, 6, 1.6, formatRehearsalDuration(slideReport.estimatedSeconds), 6.5, { fontColor: theme.primaryColor, textAlign: 'right' }));
    });
  }

  const timingElements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runText(7, 8, 70, 7, 'Segment Timing Plan', 29, { bold: true, fontColor: theme.primaryColor }),
    runText(7, 17, 74, 4, 'Rehearsal timing plan with planned start, planned end, cue, and recovery line.', 11, { fontColor: theme.mutedTextColor }),
    runRect(7, 28, 86, 4, theme.primaryColor),
    runText(9, 28.8, 5, 1.8, '#', 8, { bold: true, fontColor: theme.bgColor }),
    runText(15, 28.8, 20, 1.8, 'Segment', 8, { bold: true, fontColor: theme.bgColor }),
    runText(39, 28.8, 10, 1.8, 'Window', 8, { bold: true, fontColor: theme.bgColor, textAlign: 'center' }),
    runText(54, 28.8, 19, 1.8, 'Bridge', 8, { bold: true, fontColor: theme.bgColor }),
    runText(77, 28.8, 12, 1.8, 'Recovery', 8, { bold: true, fontColor: theme.bgColor }),
  ];

  let cursor = 0;
  visibleReports.slice(0, 9).forEach((slideReport, idx) => {
    const start = cursor;
    const end = cursor + slideReport.estimatedSeconds;
    cursor = end;
    const track = talkTrackForSlide(slideByIndex.get(slideReport.slideIndex), slideReport, sourceSlides.length);
    const y = 36 + idx * 5.4;
    const fill = slideReport.issues.length ? '#fff7ed' : idx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor;
    timingElements.push(runRect(7, y, 86, 4.6, fill, { borderColor: slideReport.issues.length ? '#f59e0b' : fill, borderWidth: 1 }));
    timingElements.push(runText(9, y + 0.8, 5, 1.9, String(slideReport.slideIndex + 1), 8, { bold: true, fontColor: theme.primaryColor }));
    timingElements.push(runText(15, y + 0.5, 20, 1.8, truncateText(slideReport.title, 44), 7.4, { bold: true, fontColor: theme.textColor }));
    timingElements.push(runText(39, y + 0.7, 10, 1.7, `${formatRehearsalDuration(start)}-${formatRehearsalDuration(end)}`, 6.6, { fontColor: theme.primaryColor, textAlign: 'center' }));
    timingElements.push(runText(54, y + 0.5, 19, 1.8, truncateText(track.bridge, 54), 6.2, { fontColor: theme.textColor }));
    timingElements.push(runText(77, y + 0.5, 12, 1.8, slideReport.issues[0] ? 'Cut detail' : 'On pace', 6.2, { bold: true, fontColor: theme.primaryColor }));
  });

  timingElements.push(runRect(7, 87, 86, 6, theme.surfaceColor, { borderColor: theme.accentColor, borderWidth: 1 }));
  timingElements.push(runText(9, 89, 78, 2.3, `Total planned talk time: ${formatRehearsalDuration(report.totalSeconds)}. Start presenter mode, then keep each slide inside its timing window.`, 9, { bold: true, fontColor: theme.textColor }));

  return [
    {
      id: uid(),
      title: 'Presenter Script',
      bgColor: theme.bgColor,
      hidden: false,
      transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
      notes: `${SCRIPT_PACK_MARKER}\nUse this as the talk-track script. Rehearse each slide as opening, proof, bridge, and recovery line.`,
      elements: scriptElements,
    },
    {
      id: uid(),
      title: 'Segment Timing Plan',
      bgColor: theme.bgColor,
      hidden: false,
      transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
      notes: `${SCRIPT_PACK_MARKER}\nUse this timing plan in presenter rehearsal. If behind, follow the recovery line and move to the next segment.`,
      elements: timingElements,
    },
  ];
}

export function insertPresentationScriptPack(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const deckWithoutPriorScriptPack = slides.filter((slide) => !isPresentationScriptPackSlide(slide));
  const scriptPack = buildPresentationScriptPackSlides(deckWithoutPriorScriptPack, theme, getTitle);
  return [...deckWithoutPriorScriptPack, ...scriptPack];
}

interface InvestorPillar {
  label: string;
  pattern: RegExp;
  proofMove: string;
}

const INVESTOR_PILLARS: InvestorPillar[] = [
  {
    label: 'Problem / Market',
    pattern: /problem|market|customer|audience|segment|pain|need|고객|시장|문제/i,
    proofMove: 'Quantify the market, segment, and urgency.',
  },
  {
    label: 'Traction',
    pattern: /traction|growth|revenue|activation|retention|usage|pipeline|arr|매출|성장|전환/i,
    proofMove: 'Show metric trend, cohort, customer proof, or source.',
  },
  {
    label: 'Business Model',
    pattern: /business model|pricing|margin|cost|profit|unit economics|forecast|budget|가격|마진|수익|예산/i,
    proofMove: 'Name pricing logic, margin path, and payback risk.',
  },
  {
    label: 'Moat / Defensibility',
    pattern: /moat|defensible|advantage|competition|security|data|network|platform|차별|경쟁|보안/i,
    proofMove: 'Explain why competitors cannot copy the result quickly.',
  },
  {
    label: 'Ask / Use of Funds',
    pattern: /ask|fund|raise|investment|approval|next step|owner|decision|투자|승인|결정|요청/i,
    proofMove: 'State the ask, use of funds, owner, and next decision date.',
  },
];

function investorSlideSource(slide: Slide): string {
  return normalizeSpace([slide.title, extractSlideSpeakingText(slide), slide.notes].filter(Boolean).join(' '));
}

function findInvestorPillarReport(
  slides: Slide[],
  reports: PptxRehearsalSlideReport[],
  pillar: InvestorPillar,
): PptxRehearsalSlideReport | undefined {
  return reports.find((report) => pillar.pattern.test(investorSlideSource(slides[report.slideIndex])));
}

function investorQuestionForPillar(pillarLabel: string, slideTitle: string): string {
  if (/market|problem/i.test(pillarLabel)) return `How big is the real market behind ${slideTitle}?`;
  if (/traction/i.test(pillarLabel)) return `Which proof shows ${slideTitle} is repeatable?`;
  if (/business/i.test(pillarLabel)) return `What has to be true for the economics in ${slideTitle} to work?`;
  if (/moat|defens/i.test(pillarLabel)) return `Why can the advantage in ${slideTitle} survive competition?`;
  return `What exactly are you asking us to approve after ${slideTitle}?`;
}

function investorAnswerMove(pillar: InvestorPillar, report: PptxRehearsalSlideReport | undefined): string {
  if (!report) return `Missing: ${pillar.proofMove}`;
  if (report.issues.includes('Speaker notes missing or too short')) return `Add speaker note: ${pillar.proofMove}`;
  if (report.issues.includes('Slide text is too dense for live delivery')) return 'Cut to one metric, one customer proof, and one decision implication.';
  return `Lead with ${report.title}; then ${pillar.proofMove.toLowerCase()}`;
}

export function buildPresentationInvestorPackSlides(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const sourceSlides = slides.filter((slide) => !isGeneratedPresentationHelperSlide(slide));
  const report = analyzePresentationRehearsal(sourceSlides, getTitle);
  const pillarRows = INVESTOR_PILLARS.map((pillar) => {
    const slideReport = findInvestorPillarReport(sourceSlides, report.slideReports, pillar);
    return {
      pillar,
      slideReport,
      status: slideReport ? 'Covered' : 'Missing',
      move: investorAnswerMove(pillar, slideReport),
    };
  });
  const covered = pillarRows.filter((row) => row.slideReport).length;
  const score = clamp(Math.round((covered / INVESTOR_PILLARS.length) * 70 + report.score * 0.3), 0, 100);
  const readinessColor = score >= 80 ? '#dcfce7' : score >= 55 ? '#fef3c7' : '#fee2e2';
  const biggestGap = pillarRows.find((row) => !row.slideReport)?.pillar.label
    || report.slideReports.find((slideReport) => slideReport.issues.length)?.title
    || 'Ready for investor review';

  const scorecardElements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runRect(0, 0, 100, 23, theme.primaryColor),
    runText(7, 6, 58, 8, 'Investor Pitch Scorecard', 30, { bold: true, fontColor: theme.bgColor }),
    runText(68, 8, 23, 5, `Investor ${score}/100`, 15, { bold: true, fontColor: theme.bgColor, textAlign: 'right' }),
    runRect(7, 29, 24, 16, readinessColor),
    runText(9, 33, 19, 4, 'Pitch Coverage', 12, { bold: true, fontColor: '#475569' }),
    runText(9, 38, 19, 5, `${covered}/${INVESTOR_PILLARS.length}`, 20, { bold: true, fontColor: theme.primaryColor }),
    runRect(38, 29, 24, 16, theme.surfaceColor),
    runText(40, 33, 19, 4, 'Talk Time', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(40, 38, 19, 5, formatRehearsalDuration(report.totalSeconds), 20, { bold: true, fontColor: theme.primaryColor }),
    runRect(69, 29, 24, 16, theme.surfaceAltColor),
    runText(71, 33, 19, 4, 'Biggest Gap', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(71, 38, 19, 5, truncateText(biggestGap, 28), 14, { bold: true, fontColor: theme.primaryColor }),
    runText(7, 52, 43, 5, 'Fundraising Story Arc', 18, { bold: true, fontColor: theme.primaryColor }),
    runText(55, 52, 38, 5, 'Partner Memo', 18, { bold: true, fontColor: theme.primaryColor }),
    runRect(55, 60, 38, 23, theme.surfaceColor, { borderColor: theme.accentColor, borderWidth: 1 }),
    runText(58, 64, 30, 5, 'Investor readout must survive without you in the room.', 13, { bold: true, fontColor: theme.textColor }),
    runText(58, 73, 30, 4, `Close gap first: ${truncateText(biggestGap, 58)}`, 10, { fontColor: theme.mutedTextColor }),
    runText(58, 80, 30, 3.5, 'Every pillar needs proof, risk, owner, and next decision.', 9, { fontColor: theme.mutedTextColor }),
    runRect(7, 59, 43, 4, theme.primaryColor),
    runText(9, 59.8, 18, 1.8, 'Pillar', 8, { bold: true, fontColor: theme.bgColor }),
    runText(31, 59.8, 10, 1.8, 'Status', 8, { bold: true, fontColor: theme.bgColor }),
    runText(43, 59.8, 4, 1.8, 'S#', 8, { bold: true, fontColor: theme.bgColor, textAlign: 'right' }),
  ];

  pillarRows.forEach((row, idx) => {
    const y = 65 + idx * 5.3;
    const fill = row.slideReport ? (idx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor) : '#fff7ed';
    scorecardElements.push(runRect(7, y, 43, 4.5, fill, { borderColor: row.slideReport ? fill : '#f59e0b', borderWidth: 1 }));
    scorecardElements.push(runText(9, y + 0.6, 18, 1.8, row.pillar.label, 7.6, { bold: true, fontColor: theme.textColor }));
    scorecardElements.push(runText(9, y + 2.5, 28, 1.3, truncateText(row.move, 70), 5.8, { fontColor: theme.mutedTextColor }));
    scorecardElements.push(runText(31, y + 0.8, 9, 1.8, row.status, 6.8, { bold: true, fontColor: row.slideReport ? theme.primaryColor : '#b45309' }));
    scorecardElements.push(runText(43, y + 0.8, 4, 1.8, row.slideReport ? String(row.slideReport.slideIndex + 1) : '-', 7, { bold: true, fontColor: theme.primaryColor, textAlign: 'right' }));
  });

  const objectionElements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runText(7, 8, 70, 7, 'Investor Objection Ledger', 29, { bold: true, fontColor: theme.primaryColor }),
    runText(7, 17, 75, 4, 'Likely diligence questions, answer moves, and follow-up owners generated from the pitch.', 11, { fontColor: theme.mutedTextColor }),
    runRect(7, 29, 86, 4, theme.primaryColor),
    runText(9, 29.8, 5, 1.8, '#', 8, { bold: true, fontColor: theme.bgColor }),
    runText(16, 29.8, 22, 1.8, 'Question', 8, { bold: true, fontColor: theme.bgColor }),
    runText(42, 29.8, 30, 1.8, 'Answer Move', 8, { bold: true, fontColor: theme.bgColor }),
    runText(77, 29.8, 11, 1.8, 'Owner', 8, { bold: true, fontColor: theme.bgColor }),
  ];

  pillarRows.forEach((row, idx) => {
    const y = 36 + idx * 7.3;
    const title = row.slideReport?.title || row.pillar.label;
    const question = investorQuestionForPillar(row.pillar.label, title);
    const owner = row.slideReport?.issues.length ? 'Prep owner' : row.slideReport ? 'Presenter' : 'CEO / owner';
    const fill = row.slideReport ? (idx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor) : '#fff7ed';
    objectionElements.push(runRect(7, y, 86, 5.9, fill, { borderColor: row.slideReport ? fill : '#f59e0b', borderWidth: 1 }));
    objectionElements.push(runText(9, y + 0.8, 5, 1.9, String(idx + 1), 8, { bold: true, fontColor: theme.primaryColor }));
    objectionElements.push(runText(16, y + 0.6, 21, 2.2, truncateText(question, 64), 6.9, { bold: true, fontColor: theme.textColor }));
    objectionElements.push(runText(42, y + 0.6, 29, 2.2, truncateText(row.move, 86), 6.6, { fontColor: theme.textColor }));
    objectionElements.push(runText(77, y + 0.9, 11, 1.8, owner, 6.4, { bold: true, fontColor: theme.primaryColor, textAlign: 'right' }));
  });

  objectionElements.push(runRect(7, 80.5, 86, 8, theme.surfaceColor, { borderColor: theme.accentColor, borderWidth: 1 }));
  objectionElements.push(runText(9, 83, 79, 2.8, 'Partner meeting rule: answer with headline, proof, risk acknowledgement, and the exact next ask.', 10, { bold: true, fontColor: theme.textColor }));

  return [
    {
      id: uid(),
      title: 'Investor Pitch Scorecard',
      bgColor: theme.bgColor,
      hidden: false,
      transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
      notes: `${INVESTOR_PACK_MARKER}\nUse this slide to audit whether the pitch covers problem, traction, economics, moat, and ask before investor or executive review.`,
      elements: scorecardElements,
    },
    {
      id: uid(),
      title: 'Investor Objection Ledger',
      bgColor: theme.bgColor,
      hidden: false,
      transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
      notes: `${INVESTOR_PACK_MARKER}\nUse this as diligence prep. Practice each answer as headline, proof, risk acknowledgement, and next ask.`,
      elements: objectionElements,
    },
  ];
}

export function insertPresentationInvestorPack(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const deckWithoutPriorInvestorPack = slides.filter((slide) => !isPresentationInvestorPackSlide(slide));
  const investorPack = buildPresentationInvestorPackSlides(deckWithoutPriorInvestorPack, theme, getTitle);
  return [...deckWithoutPriorInvestorPack, ...investorPack];
}

export function buildPresentationHandoutSlides(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const sourceSlides = slides.filter((slide) => !isGeneratedPresentationHelperSlide(slide));
  const report = analyzePresentationRehearsal(sourceSlides, getTitle);
  const visibleReports = report.slideReports.slice(0, 6);
  const issueReports = report.slideReports.filter((slideReport) => slideReport.issues.length > 0).slice(0, 4);
  const sourceEntries = sourceSlides
    .map((slide, idx) => ({ slide, idx, title: fallbackTitle(slide, idx, getTitle) }))
    .filter(({ slide }) => !slide.hidden)
    .slice(0, 6);
  const firstTitle = visibleReports[0]?.title || 'Presentation';
  const closingTitle = visibleReports.at(-1)?.title || 'Next step';
  const readinessColor = report.score >= 80 ? '#dcfce7' : report.score >= 55 ? '#fef3c7' : '#fee2e2';

  const summaryElements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runRect(0, 0, 100, 23, theme.primaryColor),
    runText(7, 6, 57, 8, 'Executive Handout', 31, { bold: true, fontColor: theme.bgColor }),
    runText(68, 8, 23, 5, `Ready ${report.score}/100`, 15, { bold: true, fontColor: theme.bgColor, textAlign: 'right' }),
    runRect(7, 29, 24, 16, theme.surfaceColor),
    runText(9, 33, 19, 4, 'Deck Length', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(9, 38, 19, 5, `${report.visibleSlides} slides`, 20, { bold: true, fontColor: theme.primaryColor }),
    runRect(38, 29, 24, 16, theme.surfaceAltColor),
    runText(40, 33, 19, 4, 'Talk Time', 12, { bold: true, fontColor: theme.mutedTextColor }),
    runText(40, 38, 19, 5, formatRehearsalDuration(report.totalSeconds), 20, { bold: true, fontColor: theme.primaryColor }),
    runRect(69, 29, 24, 16, readinessColor),
    runText(71, 33, 19, 4, 'Follow-up Risk', 12, { bold: true, fontColor: '#475569' }),
    runText(71, 38, 19, 5, issueReports.length ? `${issueReports.length} fixes` : 'Ready', 18, { bold: true, fontColor: theme.primaryColor }),
    runText(7, 52, 45, 5, 'Takeaway Flow', 18, { bold: true, fontColor: theme.primaryColor }),
    runText(55, 52, 38, 5, 'Meeting Close', 18, { bold: true, fontColor: theme.primaryColor }),
    runRect(55, 60, 38, 25, theme.surfaceColor, { borderColor: theme.accentColor, borderWidth: 1 }),
    runText(58, 64, 29, 5, truncateText(firstTitle, 80), 13, { bold: true, fontColor: theme.textColor }),
    runText(58, 72, 29, 4, `Close on: ${truncateText(closingTitle, 80)}`, 10, { fontColor: theme.mutedTextColor }),
    runText(58, 80, 29, 3.5, 'Share this handout with owners, decisions, and unanswered questions after the meeting.', 9, { fontColor: theme.mutedTextColor }),
  ];

  if (!visibleReports.length) {
    summaryElements.push(runText(8, 62, 39, 7, 'Add slides to generate an executive handout.', 16, { bold: true, fontColor: theme.textColor }));
  } else {
    visibleReports.forEach((slideReport, idx) => {
      const y = 60 + idx * 5.1;
      const fill = idx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor;
      summaryElements.push(runRect(7, y, 43, 4.3, fill));
      summaryElements.push(runText(9, y + 0.7, 5, 1.9, String(slideReport.slideIndex + 1), 8, { bold: true, fontColor: theme.primaryColor }));
      summaryElements.push(runText(16, y + 0.4, 26, 1.9, truncateText(slideReport.title, 62), 8, { bold: true, fontColor: theme.textColor }));
      summaryElements.push(runText(16, y + 2.4, 27, 1.4, slideReport.issues[0] || 'Ready to share', 6.2, { fontColor: theme.mutedTextColor }));
      summaryElements.push(runText(43, y + 0.9, 5, 1.8, formatRehearsalDuration(slideReport.estimatedSeconds), 6.8, { fontColor: theme.primaryColor, textAlign: 'right' }));
    });
  }

  const digestElements: SlideElement[] = [
    runRect(0, 0, 100, 100, theme.bgColor),
    runText(7, 8, 70, 7, 'Speaker Notes Digest', 29, { bold: true, fontColor: theme.primaryColor }),
    runText(7, 17, 74, 4, 'A leave-behind appendix generated from slide titles, speaker notes, and rehearsal issues.', 11, { fontColor: theme.mutedTextColor }),
    runRect(7, 29, 86, 4, theme.primaryColor),
    runText(9, 29.8, 6, 1.8, '#', 8, { bold: true, fontColor: theme.bgColor }),
    runText(17, 29.8, 23, 1.8, 'Slide', 8, { bold: true, fontColor: theme.bgColor }),
    runText(43, 29.8, 29, 1.8, 'Presenter Note', 8, { bold: true, fontColor: theme.bgColor }),
    runText(76, 29.8, 13, 1.8, 'Action', 8, { bold: true, fontColor: theme.bgColor }),
  ];

  if (!sourceEntries.length) {
    digestElements.push(runText(8, 40, 45, 7, 'Add speaker notes to generate a useful handout digest.', 16, { bold: true, fontColor: theme.textColor }));
  } else {
    sourceEntries.forEach(({ slide, idx, title }, rowIdx) => {
      const y = 36 + rowIdx * 7;
      const fill = rowIdx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor;
      const note = truncateText(slide.notes || extractSlideSpeakingText(slide) || 'No note captured yet.', 92);
      const action = slide.notes?.trim() ? 'Send as backup' : 'Add note';
      digestElements.push(runRect(7, y, 86, 5.8, fill, { borderColor: rowIdx === 0 ? theme.accentColor : fill, borderWidth: 1 }));
      digestElements.push(runText(9, y + 0.8, 5, 2, String(idx + 1), 8, { bold: true, fontColor: theme.primaryColor }));
      digestElements.push(runText(17, y + 0.6, 21, 2.1, truncateText(title, 52), 8, { bold: true, fontColor: theme.textColor }));
      digestElements.push(runText(43, y + 0.6, 28, 2.1, note, 6.8, { fontColor: theme.textColor }));
      digestElements.push(runText(76, y + 0.8, 12, 2, action, 7.2, { bold: true, fontColor: theme.primaryColor, textAlign: 'right' }));
    });
  }

  digestElements.push(runRect(7, 82, 86, 7, theme.surfaceColor, { borderColor: theme.accentColor, borderWidth: 1 }));
  digestElements.push(runText(9, 84.1, 78, 2.8, 'Follow-up rule: every shared deck should name the decision, owner, unresolved question, and next review date.', 10, { bold: true, fontColor: theme.textColor }));

  return [
    {
      id: uid(),
      title: 'Executive Handout',
      bgColor: theme.bgColor,
      hidden: false,
      transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
      notes: `${HANDOUT_MARKER}\nUse this slide as a meeting leave-behind summary. It should survive without a live narrator.`,
      elements: summaryElements,
    },
    {
      id: uid(),
      title: 'Speaker Notes Digest',
      bgColor: theme.bgColor,
      hidden: false,
      transition: { type: 'fade', durationMs: 450, advanceAfterSec: 0 },
      notes: `${HANDOUT_MARKER}\nUse this appendix to preserve the talk track, owners, and follow-up actions after the meeting.`,
      elements: digestElements,
    },
  ];
}

export function insertPresentationHandout(
  slides: Slide[],
  theme: PptxDesignTheme,
  getTitle?: (slide: Slide, idx: number) => string,
): Slide[] {
  const deckWithoutPriorHandout = slides.filter((slide) => !isPresentationHandoutSlide(slide));
  const handout = buildPresentationHandoutSlides(deckWithoutPriorHandout, theme, getTitle);
  return [...deckWithoutPriorHandout, ...handout];
}
