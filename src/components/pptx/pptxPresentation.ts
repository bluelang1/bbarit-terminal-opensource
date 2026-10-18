import type { Slide } from './types';
import type { PptxRehearsalReport, PptxRehearsalSlideReport } from './pptxRehearsal';

export interface PresenterSlideInfo {
  currentIdx: number;
  previousIdx: number;
  nextIdx: number;
  currentPosition: number;
  totalVisible: number;
  progressPct: number;
  currentTitle: string;
  nextTitle: string;
  notes: string;
}

export interface PresenterPacingInfo {
  status: 'ahead' | 'on-track' | 'behind';
  label: string;
  detail: string;
  elapsedSeconds: number;
  plannedStartSeconds: number;
  plannedEndSeconds: number;
  remainingSeconds: number;
  deltaSeconds: number;
}

export interface PresenterCueCard {
  opening: string;
  focus: string;
  bridge: string;
  cutLine: string;
  risk: string;
}

export interface PresenterShowFlowItem {
  slideIndex: number;
  title: string;
  estimatedSeconds: number;
  plannedStartSeconds: number;
  plannedEndSeconds: number;
  status: 'done' | 'current' | 'next' | 'upcoming';
  issueCount: number;
  hasNotes: boolean;
}

export interface PresenterLiveCoach {
  confidence: 'steady' | 'watch' | 'recover';
  headline: string;
  detail: string;
  nextAction: string;
  flow: PresenterShowFlowItem[];
}

function compactText(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateCue(value: string, limit = 110): string {
  const text = compactText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}...`;
}

function splitCueLines(value: string): string[] {
  return compactText(value)
    .split(/(?:\n+|(?<=[.!?])\s+)/)
    .map(compactText)
    .filter(Boolean);
}

function slideText(slide: Slide): string {
  return slide.elements
    .map((element) => compactText(element.text || ''))
    .filter(Boolean)
    .join(' ');
}

export function formatPresentationDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function getPresenterCueCard(
  slide: Slide | undefined,
  slideReport: PptxRehearsalSlideReport | null | undefined,
  nextTitle: string,
): PresenterCueCard {
  const title = compactText(slideReport?.title || slide?.title || 'Current slide');
  const noteLines = splitCueLines(slide?.notes || '');
  const bodyLines = slide ? splitCueLines(slideText(slide)) : [];
  const sourceLines = noteLines.length ? noteLines : bodyLines;
  const issue = slideReport?.issues[0] || '';
  const dense = slideReport ? slideReport.wordCount > 70 : false;
  const notesWeak = slideReport ? slideReport.notesWordCount < 8 : !noteLines.length;
  const focus = sourceLines.find((line) => line.toLowerCase() !== title.toLowerCase()) || title;
  const next = nextTitle && nextTitle !== 'End of deck'
    ? `Bridge to "${nextTitle}" with the question this slide sets up.`
    : 'Close with the decision, owner, and next action.';

  return {
    opening: truncateCue(sourceLines[0] || `Frame "${title}" in one clear sentence.`),
    focus: truncateCue(focus || 'Anchor on the main evidence, decision, or user impact.'),
    bridge: truncateCue(next),
    cutLine: truncateCue(dense
      ? 'If behind, skip detail and say only the decision, proof point, and implication.'
      : 'If behind, compress to the headline and move on.'),
    risk: truncateCue(issue || (notesWeak ? 'Speaker notes are light; keep the opening line visible.' : 'Ready for live delivery.')),
  };
}

export function getPresenterSlideInfo(
  slides: Slide[],
  currentSlideIdx: number,
  visibleSlideIndexes: number[],
  getTitle: (slide: Slide, idx: number) => string,
): PresenterSlideInfo {
  const fallbackIndexes = slides.map((_, idx) => idx);
  const visible = visibleSlideIndexes.length ? visibleSlideIndexes : fallbackIndexes;
  const currentIdx = visible.includes(currentSlideIdx) ? currentSlideIdx : (visible[0] ?? 0);
  const currentPosition = Math.max(0, visible.indexOf(currentIdx));
  const previousIdx = visible[currentPosition - 1] ?? currentIdx;
  const nextIdx = visible[currentPosition + 1] ?? currentIdx;
  const currentSlide = slides[currentIdx];
  const nextSlide = slides[nextIdx];
  const totalVisible = Math.max(visible.length, 1);
  const progressPct = totalVisible <= 1 ? 100 : Math.round(((currentPosition + 1) / totalVisible) * 100);

  return {
    currentIdx,
    previousIdx,
    nextIdx,
    currentPosition,
    totalVisible,
    progressPct,
    currentTitle: currentSlide ? getTitle(currentSlide, currentIdx) : 'Slide 1',
    nextTitle: nextSlide && nextIdx !== currentIdx ? getTitle(nextSlide, nextIdx) : 'End of deck',
    notes: currentSlide?.notes?.trim() || '',
  };
}

export function getPresenterPacingInfo(
  report: PptxRehearsalReport,
  currentSlideIdx: number,
  elapsedMs: number,
): PresenterPacingInfo {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const currentReportIdx = Math.max(0, report.slideReports.findIndex((slide) => slide.slideIndex === currentSlideIdx));
  const priorReports = report.slideReports.slice(0, currentReportIdx);
  const currentReport = report.slideReports[currentReportIdx];
  const plannedStartSeconds = priorReports.reduce((sum, slide) => sum + slide.estimatedSeconds, 0);
  const plannedEndSeconds = plannedStartSeconds + (currentReport?.estimatedSeconds || 0);
  const remainingSeconds = Math.max(0, report.totalSeconds - elapsedSeconds);
  const tolerance = 12;
  const deltaSeconds = elapsedSeconds < plannedStartSeconds
    ? elapsedSeconds - plannedStartSeconds
    : elapsedSeconds > plannedEndSeconds
      ? elapsedSeconds - plannedEndSeconds
      : 0;
  const status: PresenterPacingInfo['status'] = deltaSeconds < -tolerance
    ? 'ahead'
    : deltaSeconds > tolerance
      ? 'behind'
      : 'on-track';
  const label = status === 'ahead' ? 'Ahead' : status === 'behind' ? 'Behind' : 'On track';
  const detail = status === 'on-track'
    ? `Current slide window ${formatPresentationDuration(plannedStartSeconds * 1000)}-${formatPresentationDuration(plannedEndSeconds * 1000)}`
    : `${Math.abs(deltaSeconds)}s ${status === 'ahead' ? 'ahead of planned pace' : 'behind planned pace'}`;

  return {
    status,
    label,
    detail,
    elapsedSeconds,
    plannedStartSeconds,
    plannedEndSeconds,
    remainingSeconds,
    deltaSeconds,
  };
}

function visibleReportSequence(
  report: PptxRehearsalReport,
  visibleSlideIndexes: number[],
): PptxRehearsalSlideReport[] {
  const visible = visibleSlideIndexes.length ? new Set(visibleSlideIndexes) : null;
  const filtered = visible
    ? report.slideReports.filter((slide) => visible.has(slide.slideIndex))
    : report.slideReports;
  return filtered.length ? filtered : report.slideReports;
}

function primaryIssue(report: PptxRehearsalSlideReport | undefined): string {
  return compactText(report?.issues[0] || '');
}

export function getPresenterLiveCoach(
  report: PptxRehearsalReport,
  currentSlideIdx: number,
  elapsedMs: number,
  visibleSlideIndexes: number[],
): PresenterLiveCoach {
  const reports = visibleReportSequence(report, visibleSlideIndexes);
  const currentReportPos = Math.max(0, reports.findIndex((slide) => slide.slideIndex === currentSlideIdx));
  const currentReport = reports[currentReportPos];
  const nextReport = reports[currentReportPos + 1];
  const pacing = getPresenterPacingInfo(report, currentSlideIdx, elapsedMs);
  const currentIssue = primaryIssue(currentReport);
  const nextIssue = primaryIssue(nextReport);
  const currentIssueCount = currentReport?.issues.length || 0;
  const currentNeedsRecovery = Boolean(currentReport)
    && (currentIssueCount >= 2
      || currentReport.wordCount > 70
      || currentReport.notesWordCount < 8
      || currentReport.issues.some((issue) => /dense|notes/i.test(issue)));
  const confidence: PresenterLiveCoach['confidence'] = pacing.status === 'behind' || currentNeedsRecovery
    ? 'recover'
    : pacing.status === 'ahead' || currentIssueCount > 0 || Boolean(nextIssue)
      ? 'watch'
      : 'steady';

  const headline = confidence === 'recover'
    ? 'Recover this slide'
    : confidence === 'watch'
      ? 'Watch the next handoff'
      : 'Steady pace';
  const detail = confidence === 'steady'
    ? `${pacing.detail}. Keep the audience on the headline.`
    : pacing.status !== 'on-track'
      ? pacing.detail
      : currentIssue || (nextIssue ? `Next slide: ${nextIssue}` : 'Small delivery risk detected.');
  const nextAction = pacing.status === 'behind'
    ? 'Use the cut line, land the headline, and advance.'
    : currentIssue
      ? 'State the headline, one proof point, then bridge.'
      : nextIssue
        ? 'Preview the next slide with one clean question.'
        : 'Keep the current cadence and bridge cleanly.';

  let plannedStartSeconds = 0;
  const flow: PresenterShowFlowItem[] = reports.map((slideReport, idx) => {
    const item: PresenterShowFlowItem = {
      slideIndex: slideReport.slideIndex,
      title: slideReport.title,
      estimatedSeconds: slideReport.estimatedSeconds,
      plannedStartSeconds,
      plannedEndSeconds: plannedStartSeconds + slideReport.estimatedSeconds,
      status: idx < currentReportPos
        ? 'done'
        : idx === currentReportPos
          ? 'current'
          : idx === currentReportPos + 1
            ? 'next'
            : 'upcoming',
      issueCount: slideReport.issues.length,
      hasNotes: slideReport.notesWordCount >= 8,
    };
    plannedStartSeconds += slideReport.estimatedSeconds;
    return item;
  }).slice(Math.max(0, currentReportPos - 1), currentReportPos + 5);

  return {
    confidence,
    headline,
    detail,
    nextAction,
    flow,
  };
}
