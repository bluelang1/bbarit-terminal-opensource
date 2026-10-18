import type { Slide, SlideElement } from './types';
import { uid } from './types';
import type { PptxDesignTheme } from './pptxDesignThemes';
import { applyDesignThemeToSlides, getPptxDesignTheme } from './pptxDesignThemes';

export interface PptxDeckTemplate {
  id: string;
  label: string;
  category: string;
  description: string;
  slides: Array<{
    title: string;
    notes?: string;
    elements: (theme: PptxDesignTheme) => SlideElement[];
  }>;
}

export interface PptxDesignPresetPack {
  id: string;
  label: string;
  category: string;
  description: string;
  themeId: string;
  templateId: string;
}

export interface PptxDesignPresetRecommendation {
  preset: PptxDesignPresetPack;
  score: number;
  reason: string;
}

const text = (
  x: number,
  y: number,
  w: number,
  h: number,
  value: string,
  fontSize = 18,
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

const rect = (x: number, y: number, w: number, h: number, fillColor: string, extra: Partial<SlideElement> = {}): SlideElement => ({
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

const line = (x: number, y: number, w: number, color: string, borderWidth = 2): SlideElement => ({
  id: uid(),
  type: 'line',
  x,
  y,
  w,
  h: 1,
  borderColor: color,
  borderWidth,
});

const metricCard = (x: number, label: string, value: string, theme: PptxDesignTheme): SlideElement[] => [
  rect(x, 32, 24, 26, theme.surfaceColor),
  text(x + 2, 36, 20, 6, label, 12, { fontColor: theme.mutedTextColor, bold: true }),
  text(x + 2, 46, 20, 8, value, 24, { fontColor: theme.primaryColor, bold: true }),
];

export const PPTX_DECK_TEMPLATES: PptxDeckTemplate[] = [
  {
    id: 'startup-pitch',
    label: 'Startup Pitch',
    category: 'Pitch',
    description: 'Problem, solution, traction, business model, roadmap, and ask.',
    slides: [
      {
        title: 'Company Pitch',
        notes: 'Open with the single sharp outcome the company creates.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.primaryColor),
          rect(8, 13, 38, 74, theme.surfaceColor),
          text(52, 20, 36, 10, 'Company Pitch', 34, { bold: true, fontColor: theme.bgColor }),
          text(52, 35, 34, 16, 'A concise promise for the customer and the market.', 18, { fontColor: theme.bgColor }),
          line(52, 58, 28, theme.accentColor, 4),
          text(52, 64, 34, 8, 'Founder · Date', 13, { fontColor: theme.bgColor }),
        ],
      },
      {
        title: 'Problem',
        elements: (theme) => [
          text(7, 8, 84, 9, 'The Problem', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Current workflow is slow', 'Teams lose context', 'Existing tools are expensive'].flatMap((item, idx) => [
            rect(8 + idx * 30, 30, 24, 34, idx % 2 ? theme.surfaceAltColor : theme.surfaceColor),
            text(11 + idx * 30, 39, 18, 12, item, 17, { bold: true, fontColor: theme.textColor }),
          ]),
          text(8, 76, 74, 10, 'Quantify the pain with one believable customer or market signal.', 16, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Solution',
        elements: (theme) => [
          text(7, 8, 84, 9, 'Solution', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 25, 40, 48, theme.primaryColor),
          text(12, 36, 32, 16, 'Product screenshot or core workflow', 18, { bold: true, fontColor: theme.bgColor, textAlign: 'center' }),
          text(54, 28, 34, 10, 'What changes for the user', 22, { bold: true, fontColor: theme.primaryColor }),
          text(54, 43, 34, 24, '1. Faster execution\n2. Less coordination drag\n3. Better output quality', 17, { fontColor: theme.textColor }),
        ],
      },
      {
        title: 'Traction',
        elements: (theme) => [
          text(7, 8, 84, 9, 'Traction', 30, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Users', '12K', theme),
          ...metricCard(38, 'Growth', '+38%', theme),
          ...metricCard(68, 'Revenue', '$84K', theme),
          rect(10, 72, 78, 8, theme.surfaceAltColor),
          rect(10, 72, 54, 8, theme.accentColor),
          text(10, 84, 70, 6, 'Replace placeholder metrics with real funnel or cohort data.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Business Model',
        elements: (theme) => [
          text(7, 8, 84, 9, 'Business Model', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Starter', 'Team', 'Enterprise'].flatMap((plan, idx) => [
            rect(8 + idx * 30, 26, 24, 48, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 32, 18, 6, plan, 16, { bold: true, fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 45, 18, 10, idx === 0 ? '$19/mo' : idx === 1 ? '$99/mo' : 'Custom', 22, { bold: true, fontColor: idx === 1 ? theme.bgColor : theme.textColor }),
            text(11 + idx * 30, 61, 18, 8, 'Key value\nand limits', 12, { fontColor: idx === 1 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Roadmap & Ask',
        notes: 'End with a concrete ask: money, partnership, pilot, hiring, or decision.',
        elements: (theme) => [
          text(7, 8, 84, 9, 'Roadmap & Ask', 30, { bold: true, fontColor: theme.primaryColor }),
          line(10, 40, 76, theme.accentColor, 4),
          ...['Now', 'Next', 'Later'].flatMap((label, idx) => [
            rect(11 + idx * 30, 34, 12, 12, theme.primaryColor),
            text(8 + idx * 30, 54, 20, 7, label, 18, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(7 + idx * 30, 64, 22, 12, 'Milestone\nand owner', 13, { textAlign: 'center', fontColor: theme.textColor }),
          ]),
          text(8, 84, 78, 7, 'Ask: $X to reach Y milestone by Z date.', 18, { bold: true, fontColor: theme.primaryColor }),
        ],
      },
    ],
  },
  {
    id: 'data-report',
    label: 'Data Report',
    category: 'Analytics',
    description: 'Executive summary, KPI dashboard, insights, risks, and next actions.',
    slides: [
      {
        title: 'Executive Summary',
        elements: (theme) => [
          text(7, 9, 84, 10, 'Executive Summary', 32, { bold: true, fontColor: theme.primaryColor }),
          text(8, 27, 72, 13, 'One sentence that says what changed, why it matters, and what decision is needed.', 18, { fontColor: theme.textColor }),
          ...metricCard(8, 'North Star', '+18%', theme),
          ...metricCard(38, 'Efficiency', '-12%', theme),
          ...metricCard(68, 'Risk', 'Medium', theme),
        ],
      },
      {
        title: 'KPI Dashboard',
        elements: (theme) => [
          text(7, 8, 84, 8, 'KPI Dashboard', 28, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 22, 38, 52, theme.surfaceColor),
          rect(52, 22, 38, 52, theme.surfaceAltColor),
          text(12, 28, 24, 7, 'Trend Chart', 20, { bold: true, fontColor: theme.primaryColor }),
          line(14, 62, 6, theme.accentColor, 3),
          line(22, 55, 6, theme.accentColor, 3),
          line(30, 45, 6, theme.accentColor, 3),
          line(38, 35, 6, theme.accentColor, 3),
          text(56, 30, 28, 28, 'Metric table\nA  92\nB  81\nC  74', 18, { fontColor: theme.textColor }),
        ],
      },
      {
        title: 'Key Insights',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Key Insights', 28, { bold: true, fontColor: theme.primaryColor }),
          ...['What grew', 'What declined', 'What surprised'].flatMap((label, idx) => [
            rect(8, 24 + idx * 19, 8, 8, theme.accentColor),
            text(20, 22 + idx * 19, 60, 7, label, 18, { bold: true, fontColor: theme.primaryColor }),
            text(20, 31 + idx * 19, 64, 6, 'Evidence and implication in one line.', 13, { fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Risks & Actions',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Risks & Actions', 28, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 24, 38, 52, theme.surfaceColor),
          rect(54, 24, 38, 52, theme.surfaceAltColor),
          text(12, 30, 24, 7, 'Risks', 20, { bold: true, fontColor: theme.primaryColor }),
          text(58, 30, 24, 7, 'Actions', 20, { bold: true, fontColor: theme.primaryColor }),
          text(12, 43, 28, 20, 'Risk 1\nRisk 2\nRisk 3', 16, { fontColor: theme.textColor }),
          text(58, 43, 28, 20, 'Owner / date\nOwner / date\nOwner / date', 16, { fontColor: theme.textColor }),
        ],
      },
    ],
  },
  {
    id: 'product-launch',
    label: 'Product Launch',
    category: 'Go-to-market',
    description: 'Launch story, audience, positioning, channels, and timeline.',
    slides: [
      {
        title: 'Launch Brief',
        elements: (theme) => [
          rect(0, 0, 100, 30, theme.primaryColor),
          text(8, 9, 70, 9, 'Product Launch', 34, { bold: true, fontColor: theme.bgColor }),
          text(8, 42, 62, 12, 'What we are launching and why now.', 22, { bold: true, fontColor: theme.primaryColor }),
          rect(72, 38, 18, 30, theme.surfaceColor),
          text(75, 48, 12, 8, 'Logo / Product', 14, { textAlign: 'center', fontColor: theme.primaryColor }),
        ],
      },
      {
        title: 'Audience & Message',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Audience & Message', 28, { bold: true, fontColor: theme.primaryColor }),
          ...['Primary buyer', 'User pain', 'Message'].flatMap((label, idx) => [
            rect(8 + idx * 30, 28, 24, 40, idx === 2 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 36, 18, 7, label, 17, { bold: true, fontColor: idx === 2 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 50, 18, 12, 'Short, concrete placeholder.', 13, { fontColor: idx === 2 ? theme.bgColor : theme.textColor }),
          ]),
        ],
      },
      {
        title: 'Channel Plan',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Channel Plan', 28, { bold: true, fontColor: theme.primaryColor }),
          ...['Owned', 'Paid', 'Partner', 'Sales'].flatMap((label, idx) => [
            rect(8 + idx * 22, 30, 17, 34, idx % 2 ? theme.surfaceAltColor : theme.surfaceColor),
            text(10 + idx * 22, 39, 13, 7, label, 16, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(10 + idx * 22, 52, 13, 8, 'Tactic\nKPI', 12, { textAlign: 'center', fontColor: theme.textColor }),
          ]),
        ],
      },
      {
        title: 'Launch Timeline',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Launch Timeline', 28, { bold: true, fontColor: theme.primaryColor }),
          line(10, 45, 76, theme.accentColor, 4),
          ...['T-30', 'T-14', 'Launch', 'T+30'].flatMap((label, idx) => [
            rect(10 + idx * 24, 39, 10, 10, theme.primaryColor),
            text(6 + idx * 24, 56, 18, 7, label, 16, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(6 + idx * 24, 66, 18, 8, 'Deliverable', 12, { textAlign: 'center', fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
    ],
  },
  {
    id: 'board-review',
    label: 'Board Review',
    category: 'Executive',
    description: 'Decision-ready board deck with highlights, financials, pipeline, risks, and asks.',
    slides: [
      {
        title: 'Board Review',
        notes: 'Use this as the crisp framing slide: period, decision topics, and meeting outcome.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.primaryColor),
          text(8, 16, 70, 10, 'Board Review', 36, { bold: true, fontColor: theme.bgColor }),
          text(8, 32, 58, 10, 'Quarterly operating narrative and decisions needed.', 18, { fontColor: theme.bgColor }),
          rect(72, 16, 18, 54, theme.surfaceColor),
          text(75, 32, 12, 18, 'Q\n2026', 28, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          line(8, 57, 40, theme.accentColor, 4),
          text(8, 65, 48, 7, 'CEO · CFO · Leadership Team', 13, { fontColor: theme.bgColor }),
        ],
      },
      {
        title: 'Highlights',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Highlights', 30, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Revenue', '$8.4M', theme),
          ...metricCard(38, 'Gross Margin', '71%', theme),
          ...metricCard(68, 'Runway', '22 mo', theme),
          text(10, 74, 74, 8, 'Three bullets: what worked, what changed, what needs board attention.', 15, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Financial Snapshot',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Financial Snapshot', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 24, 84, 52, theme.surfaceColor),
          ...['ARR', 'Bookings', 'Burn', 'Cash'].flatMap((label, idx) => [
            text(12 + idx * 20, 33, 14, 6, label, 13, { bold: true, textAlign: 'center', fontColor: theme.mutedTextColor }),
            text(12 + idx * 20, 47, 14, 9, idx === 0 ? '$18M' : idx === 1 ? '$5.2M' : idx === 2 ? '$650K' : '$14M', 20, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            rect(12 + idx * 20, 62, 14, 5, idx === 2 ? theme.accentColor : theme.primaryColor),
          ]),
        ],
      },
      {
        title: 'Pipeline & Forecast',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Pipeline & Forecast', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 26, 38, 46, theme.surfaceAltColor),
          rect(54, 26, 38, 46, theme.surfaceColor),
          text(12, 33, 24, 7, 'Pipeline', 20, { bold: true, fontColor: theme.primaryColor }),
          text(58, 33, 24, 7, 'Forecast', 20, { bold: true, fontColor: theme.primaryColor }),
          text(12, 48, 28, 16, 'Commit\nBest case\nUpside', 16, { fontColor: theme.textColor }),
          text(58, 48, 28, 16, 'Q1  92%\nQ2  81%\nQ3  74%', 16, { fontColor: theme.textColor }),
        ],
      },
      {
        title: 'Risks & Decisions',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Risks & Decisions', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Risk', 'Impact', 'Decision'].flatMap((label, idx) => [
            rect(8 + idx * 30, 28, 24, 38, idx === 2 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 35, 18, 7, label, 18, { bold: true, fontColor: idx === 2 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 49, 18, 10, 'Replace with\nreal item', 13, { fontColor: idx === 2 ? theme.bgColor : theme.textColor }),
          ]),
          text(8, 80, 80, 7, 'Close with explicit approvals, blockers, and asks.', 16, { bold: true, fontColor: theme.primaryColor }),
        ],
      },
    ],
  },
  {
    id: 'training-workshop',
    label: 'Training Workshop',
    category: 'Education',
    description: 'Lesson-ready deck with agenda, concept, demo, exercise, recap, and assessment.',
    slides: [
      {
        title: 'Workshop Title',
        elements: (theme) => [
          rect(0, 0, 100, 24, theme.primaryColor),
          text(8, 8, 80, 8, 'Workshop Title', 32, { bold: true, fontColor: theme.bgColor }),
          text(8, 38, 60, 10, 'Learning outcome in one clear sentence.', 22, { bold: true, fontColor: theme.primaryColor }),
          rect(72, 36, 18, 28, theme.surfaceColor),
          text(75, 45, 12, 8, 'Level\nTime', 15, { textAlign: 'center', fontColor: theme.primaryColor }),
        ],
      },
      {
        title: 'Agenda',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Agenda', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Concept', 'Demo', 'Practice', 'Review'].flatMap((label, idx) => [
            rect(10, 25 + idx * 14, 8, 8, theme.accentColor),
            text(24, 23 + idx * 14, 54, 7, label, 18, { bold: true, fontColor: theme.primaryColor }),
            text(24, 31 + idx * 14, 54, 5, 'Duration and activity detail.', 12, { fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Core Concept',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Core Concept', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 26, 40, 46, theme.surfaceColor),
          text(13, 42, 30, 12, 'Principle', 28, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          text(54, 28, 34, 32, 'Explain the idea with three short points.\n\n1. What it is\n2. Why it matters\n3. How to use it', 16, { fontColor: theme.textColor }),
        ],
      },
      {
        title: 'Guided Exercise',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Guided Exercise', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Step 1', 'Step 2', 'Step 3'].flatMap((label, idx) => [
            rect(8 + idx * 30, 30, 24, 34, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 39, 18, 7, label, 18, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 52, 18, 8, 'Learner action', 13, { textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.textColor }),
          ]),
        ],
      },
      {
        title: 'Recap & Check',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Recap & Check', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 26, 38, 42, theme.surfaceColor),
          rect(54, 26, 38, 42, theme.surfaceAltColor),
          text(12, 34, 24, 7, 'Remember', 20, { bold: true, fontColor: theme.primaryColor }),
          text(58, 34, 24, 7, 'Question', 20, { bold: true, fontColor: theme.primaryColor }),
          text(12, 48, 28, 12, 'Key takeaway\nKey takeaway', 15, { fontColor: theme.textColor }),
          text(58, 48, 28, 12, 'What would you do\nin this scenario?', 15, { fontColor: theme.textColor }),
        ],
      },
    ],
  },
  {
    id: 'consulting-proposal',
    label: 'Consulting Proposal',
    category: 'Proposal',
    description: 'Client-facing proposal with context, approach, workplan, team, and investment.',
    slides: [
      {
        title: 'Proposal',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.bgColor),
          rect(0, 0, 36, 100, theme.primaryColor),
          text(8, 18, 22, 16, 'Client\nProposal', 32, { bold: true, fontColor: theme.bgColor }),
          text(44, 26, 40, 10, 'Strategic workplan for the next phase.', 22, { bold: true, fontColor: theme.primaryColor }),
          line(44, 48, 24, theme.accentColor, 4),
          text(44, 58, 32, 7, 'Prepared by · Date', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Situation',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Situation', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 25, 84, 18, theme.surfaceColor),
          rect(8, 49, 84, 18, theme.surfaceAltColor),
          text(12, 30, 72, 7, 'Observed challenge and business context', 17, { bold: true, fontColor: theme.primaryColor }),
          text(12, 54, 72, 7, 'Opportunity unlocked by the engagement', 17, { bold: true, fontColor: theme.primaryColor }),
        ],
      },
      {
        title: 'Approach',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Approach', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Diagnose', 'Design', 'Deliver'].flatMap((label, idx) => [
            rect(10 + idx * 28, 32, 20, 28, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(12 + idx * 28, 42, 16, 7, label, 17, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
          ]),
          line(18, 46, 58, theme.accentColor, 3),
        ],
      },
      {
        title: 'Workplan',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Workplan', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Week 1', 'Week 2', 'Week 3', 'Week 4'].flatMap((label, idx) => [
            rect(8 + idx * 22, 30, 17, 36, idx % 2 ? theme.surfaceAltColor : theme.surfaceColor),
            text(10 + idx * 22, 38, 13, 6, label, 15, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(10 + idx * 22, 51, 13, 8, 'Milestone', 12, { textAlign: 'center', fontColor: theme.textColor }),
          ]),
        ],
      },
      {
        title: 'Investment & Next Step',
        notes: 'Use the final slide to name scope, fee, start date, and approval path.',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Investment & Next Step', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 28, 38, 36, theme.primaryColor),
          text(12, 40, 28, 8, '$120K', 30, { bold: true, textAlign: 'center', fontColor: theme.bgColor }),
          text(12, 52, 28, 6, 'Project fee placeholder', 13, { textAlign: 'center', fontColor: theme.bgColor }),
          rect(54, 28, 38, 36, theme.surfaceColor),
          text(58, 37, 28, 8, 'Approve scope\nConfirm start date\nKick off team', 15, { fontColor: theme.textColor }),
        ],
      },
    ],
  },
  {
    id: 'enterprise-sales',
    label: 'Enterprise Sales',
    category: 'Sales',
    description: 'Enterprise sales narrative with buyer map, pain, architecture, ROI, and close plan.',
    slides: [
      {
        title: 'Enterprise Sales Story',
        notes: 'Start with the buyer outcome, not the product feature list.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.bgColor),
          rect(0, 0, 100, 28, theme.primaryColor),
          text(7, 5, 72, 16, 'Enterprise Sales Story', 34, { bold: true, fontColor: theme.bgColor }),
          text(7, 42, 52, 12, 'A board-ready buying case for the account team.', 24, { bold: true, fontColor: theme.primaryColor }),
          rect(66, 39, 24, 26, theme.surfaceAltColor),
          text(69, 48, 18, 8, 'Target\nAccount', 18, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          line(7, 62, 34, theme.accentColor, 4),
          text(7, 73, 46, 7, 'Owner · Stage · Close date', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Buyer Map',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Buyer Map', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Economic Buyer', 'Champion', 'Technical Gate'].flatMap((label, idx) => [
            rect(8 + idx * 30, 27, 24, 38, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 36, 18, 7, label, 16, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 51, 18, 9, 'Need\nconcern\nnext step', 12, { textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.textColor }),
          ]),
          text(8, 79, 80, 6, 'Add one proof point for each stakeholder.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Pain Stack',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Pain Stack', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Cost', 'Risk', 'Delay', 'Visibility'].flatMap((label, idx) => [
            rect(12 + idx * 18, 64 - idx * 10, 14, 10 + idx * 10, idx % 2 ? theme.surfaceAltColor : theme.surfaceColor),
            text(12 + idx * 18, 78, 14, 6, label, 12, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          ]),
          text(8, 24, 44, 12, 'Quantify the current-state pain in business terms.', 21, { bold: true, fontColor: theme.primaryColor }),
          text(56, 25, 30, 28, 'Replace placeholders with actual impact:\n\n- hours lost\n- dollars at risk\n- missed commitments', 15, { fontColor: theme.textColor }),
        ],
      },
      {
        title: 'Solution Architecture',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Solution Architecture', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Input', 'Platform', 'Workflow', 'Outcome'].flatMap((label, idx) => [
            rect(8 + idx * 22, 36, 16, 18, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(10 + idx * 22, 42, 12, 5, label, 13, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            idx < 3 ? line(24 + idx * 22, 45, 6, theme.accentColor, 3) : text(0, 0, 0, 0, ''),
          ]),
          text(8, 68, 78, 7, 'Use this slide to remove technical uncertainty and show integration path.', 15, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'ROI Case',
        elements: (theme) => [
          text(7, 8, 84, 8, 'ROI Case', 30, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Savings', '$1.2M', theme),
          ...metricCard(38, 'Payback', '7 mo', theme),
          ...metricCard(68, 'Risk Cut', '42%', theme),
          rect(10, 74, 78, 7, theme.surfaceColor),
          rect(10, 74, 52, 7, theme.accentColor),
          text(10, 85, 76, 5, 'Anchor every number to buyer-provided assumptions.', 12, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Close Plan',
        notes: 'End with owners, mutual commitments, and dates.',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Close Plan', 30, { bold: true, fontColor: theme.primaryColor }),
          line(10, 45, 76, theme.accentColor, 4),
          ...['Validate', 'Security', 'Legal', 'Decision'].flatMap((label, idx) => [
            rect(10 + idx * 23, 39, 9, 9, idx === 3 ? theme.primaryColor : theme.surfaceAltColor),
            text(6 + idx * 23, 56, 17, 6, label, 14, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(6 + idx * 23, 66, 17, 7, 'Owner\nDate', 12, { textAlign: 'center', fontColor: theme.textColor }),
          ]),
        ],
      },
    ],
  },
  {
    id: 'research-brief',
    label: 'Research Brief',
    category: 'Research',
    description: 'Research memo deck with question, method, evidence, interpretation, and recommendations.',
    slides: [
      {
        title: 'Research Question',
        notes: 'Frame the decision this research should change.',
        elements: (theme) => [
          text(7, 8, 84, 13, 'Research Question', 32, { bold: true, fontColor: theme.primaryColor }),
          text(9, 31, 72, 16, 'What should the audience believe or decide after seeing the evidence?', 22, { bold: true, fontColor: theme.textColor }),
          rect(9, 61, 34, 12, theme.surfaceAltColor),
          text(12, 65, 28, 5, 'Hypothesis placeholder', 13, { fontColor: theme.primaryColor }),
          line(9, 78, 54, theme.accentColor, 3),
        ],
      },
      {
        title: 'Method',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Method', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Sample', 'Data', 'Limits'].flatMap((label, idx) => [
            rect(8 + idx * 30, 28, 24, 36, theme.surfaceColor),
            text(11 + idx * 30, 37, 18, 7, label, 17, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(11 + idx * 30, 51, 18, 7, 'Describe clearly', 12, { textAlign: 'center', fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Evidence',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Evidence', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 24, 40, 48, theme.surfaceColor),
          rect(54, 24, 38, 48, theme.surfaceAltColor),
          text(13, 31, 28, 7, 'Finding A', 20, { bold: true, fontColor: theme.primaryColor }),
          line(14, 61, 7, theme.accentColor, 3),
          line(24, 52, 7, theme.accentColor, 3),
          line(34, 39, 7, theme.accentColor, 3),
          text(58, 31, 28, 25, 'Evidence table\nSignal  92\nSignal  81\nSignal  74', 16, { fontColor: theme.textColor }),
        ],
      },
      {
        title: 'Interpretation',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Interpretation', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['What is true', 'What changed', 'What remains uncertain'].flatMap((label, idx) => [
            rect(10, 26 + idx * 18, 8, 8, theme.accentColor),
            text(22, 24 + idx * 18, 58, 7, label, 18, { bold: true, fontColor: theme.primaryColor }),
            text(22, 33 + idx * 18, 62, 5, 'One precise implication.', 12, { fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Recommendations',
        notes: 'Close with a ranked recommendation and what evidence would change your mind.',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Recommendations', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Do now', 'Test next', 'Watch'].flatMap((label, idx) => [
            rect(8 + idx * 30, 28, 24, 38, idx === 0 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 36, 18, 7, label, 18, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 51, 18, 8, 'Action and owner', 12, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.textColor }),
          ]),
        ],
      },
    ],
  },
  {
    id: 'campaign-plan',
    label: 'Campaign Plan',
    category: 'Marketing',
    description: 'Campaign planning deck with brief, audience, creative routes, channel mix, and measurement.',
    slides: [
      {
        title: 'Campaign Brief',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.primaryColor),
          text(8, 12, 70, 15, 'Campaign Brief', 36, { bold: true, fontColor: theme.bgColor }),
          text(8, 33, 54, 12, 'One audience, one promise, one measurable outcome.', 20, { fontColor: theme.bgColor }),
          rect(70, 18, 18, 44, theme.surfaceAltColor),
          text(73, 34, 12, 10, 'Launch\nWindow', 18, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          line(8, 58, 38, theme.accentColor, 4),
        ],
      },
      {
        title: 'Audience',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Audience', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 26, 38, 42, theme.surfaceColor),
          rect(54, 26, 38, 42, theme.surfaceAltColor),
          text(12, 35, 26, 7, 'Primary Segment', 20, { bold: true, fontColor: theme.primaryColor }),
          text(58, 35, 26, 7, 'Tension', 20, { bold: true, fontColor: theme.primaryColor }),
          text(12, 50, 27, 8, 'Who they are\nwhere to reach them', 13, { fontColor: theme.textColor }),
          text(58, 50, 27, 8, 'Need, blocker,\nand trigger', 13, { fontColor: theme.textColor }),
        ],
      },
      {
        title: 'Creative Routes',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Creative Routes', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Proof', 'Emotion', 'Utility'].flatMap((label, idx) => [
            rect(8 + idx * 30, 28, 24, 40, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 37, 18, 7, label, 18, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 51, 18, 9, 'Headline\nvisual cue', 12, { textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.textColor }),
          ]),
        ],
      },
      {
        title: 'Channel Mix',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Channel Mix', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Owned', 'Paid', 'Partner', 'Field'].flatMap((label, idx) => [
            rect(9 + idx * 21, 30, 16, 34, idx % 2 ? theme.surfaceAltColor : theme.surfaceColor),
            text(11 + idx * 21, 40, 12, 5, label, 14, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            rect(11 + idx * 21, 54, 12, 5, idx === 1 ? theme.accentColor : theme.primaryColor),
          ]),
          text(9, 77, 76, 6, 'Balance budget, creative fit, and conversion path.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Measurement',
        notes: 'Make the measurement slide operational: owner, cadence, threshold, and action.',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Measurement', 30, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Reach', '1.8M', theme),
          ...metricCard(38, 'Pipeline', '$4.2M', theme),
          ...metricCard(68, 'CAC', '-14%', theme),
          text(9, 80, 78, 6, 'Define stop, continue, and scale thresholds before launch.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
    ],
  },
  {
    id: 'portfolio-case-study',
    label: 'Portfolio Case Study',
    category: 'Portfolio',
    description: 'Case-study deck with hero, challenge, process, artifacts, impact, and reflection.',
    slides: [
      {
        title: 'Case Study',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.bgColor),
          rect(8, 13, 44, 64, theme.surfaceColor),
          text(58, 18, 30, 15, 'Case Study', 36, { bold: true, fontColor: theme.primaryColor }),
          text(58, 39, 28, 14, 'Project name, role, timeline, and outcome.', 17, { fontColor: theme.textColor }),
          line(58, 60, 24, theme.accentColor, 4),
        ],
      },
      {
        title: 'Challenge',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Challenge', 30, { bold: true, fontColor: theme.primaryColor }),
          text(10, 28, 50, 14, 'The constraint that made the work difficult and valuable.', 24, { bold: true, fontColor: theme.primaryColor }),
          rect(66, 28, 22, 28, theme.surfaceAltColor),
          text(69, 38, 16, 7, 'Before', 18, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
        ],
      },
      {
        title: 'Process',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Process', 30, { bold: true, fontColor: theme.primaryColor }),
          line(12, 45, 72, theme.accentColor, 3),
          ...['Discover', 'Prototype', 'Validate', 'Ship'].flatMap((label, idx) => [
            rect(11 + idx * 22, 39, 10, 10, theme.primaryColor),
            text(7 + idx * 22, 57, 18, 6, label, 13, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          ]),
        ],
      },
      {
        title: 'Artifacts',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Artifacts', 30, { bold: true, fontColor: theme.primaryColor }),
          ...[0, 1, 2].flatMap((idx) => [
            rect(8 + idx * 30, 27, 24, 36, idx === 1 ? theme.surfaceAltColor : theme.surfaceColor),
            text(11 + idx * 30, 42, 18, 7, `Artifact ${idx + 1}`, 16, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          ]),
          text(8, 76, 78, 6, 'Drop screenshots or diagrams into each frame.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Impact',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Impact', 30, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Outcome', '+32%', theme),
          ...metricCard(38, 'Time', '-2 wk', theme),
          ...metricCard(68, 'Quality', 'A+', theme),
          text(10, 78, 74, 7, 'Pair each metric with a short before/after narrative.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Reflection',
        notes: 'Close with what you learned and what you would do next.',
        elements: (theme) => [
          text(7, 8, 84, 8, 'Reflection', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 28, 38, 38, theme.surfaceColor),
          rect(54, 28, 38, 38, theme.surfaceAltColor),
          text(12, 38, 24, 7, 'What worked', 20, { bold: true, fontColor: theme.primaryColor }),
          text(58, 38, 24, 7, 'Next time', 20, { bold: true, fontColor: theme.primaryColor }),
          text(12, 52, 28, 7, 'Specific practice', 13, { fontColor: theme.textColor }),
          text(58, 52, 28, 7, 'Sharper iteration', 13, { fontColor: theme.textColor }),
        ],
      },
    ],
  },
  {
    id: 'technical-architecture',
    label: 'Technical Architecture',
    category: 'Engineering',
    description: 'Executive-readable architecture deck with system map, request flow, controls, migration plan, and operating model.',
    slides: [
      {
        title: 'Architecture Thesis',
        notes: 'Open with the technical decision and business reason, not a generic system overview.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.bgColor),
          text(7, 10, 74, 20, 'Architecture Thesis', 30, { bold: true, fontColor: theme.primaryColor }),
          text(8, 33, 58, 18, 'The platform moves from fragile coordination to observable, repeatable execution.', 21, { bold: true, fontColor: theme.textColor }),
          rect(70, 28, 18, 18, theme.primaryColor),
          text(72, 34, 14, 7, 'Target', 15, { bold: true, textAlign: 'center', fontColor: theme.bgColor }),
          line(8, 62, 72, theme.accentColor, 4),
          text(8, 70, 76, 10, 'Decision needed: approve the migration path, owners, and reliability gates.', 15, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'System Map',
        elements: (theme) => [
          text(7, 8, 84, 17, 'System Map', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Client', 'Gateway', 'Services', 'Data', 'Ops'].flatMap((label, idx) => [
            rect(7 + idx * 18, 35, 13, 18, idx % 2 ? theme.surfaceAltColor : theme.surfaceColor),
            text(8 + idx * 18, 42, 11, 5, label, 12, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            ...(idx < 4 ? [line(21 + idx * 18, 44, 4, theme.accentColor, 2)] : []),
          ]),
          text(8, 72, 78, 8, 'Replace boxes with real domains and call out ownership boundaries.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Critical Request Flow',
        elements: (theme) => [
          text(7, 8, 84, 17, 'Critical Request Flow', 30, { bold: true, fontColor: theme.primaryColor }),
          line(12, 38, 70, theme.accentColor, 3),
          ...['Auth', 'Route', 'Execute', 'Persist', 'Notify'].flatMap((label, idx) => [
            rect(10 + idx * 17, 32, 10, 10, theme.primaryColor),
            text(7 + idx * 17, 49, 16, 6, label, 12, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(6 + idx * 17, 60, 18, 8, 'SLO / owner', 11, { textAlign: 'center', fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Reliability Controls',
        elements: (theme) => [
          text(7, 8, 84, 17, 'Reliability Controls', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Observability', 'Fallbacks', 'Rate limits', 'Runbooks'].flatMap((label, idx) => [
            rect(8 + (idx % 2) * 44, 26 + Math.floor(idx / 2) * 24, 36, 16, idx % 2 ? theme.surfaceAltColor : theme.surfaceColor),
            text(11 + (idx % 2) * 44, 31 + Math.floor(idx / 2) * 24, 24, 5, label, 15, { bold: true, fontColor: theme.primaryColor }),
            text(11 + (idx % 2) * 44, 38 + Math.floor(idx / 2) * 24, 28, 4, 'Current gap and owner', 10, { fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Migration Plan',
        notes: 'Make the final slide operational: sequence, rollback, and success threshold.',
        elements: (theme) => [
          text(7, 8, 84, 17, 'Migration Plan', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Stabilize', 'Parallel run', 'Cutover', 'Optimize'].flatMap((label, idx) => [
            rect(9 + idx * 21, 30, 15, 32, idx === 2 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 21, 38, 11, 7, label, 12, { bold: true, textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 21, 52, 11, 5, `W${idx + 1}`, 13, { textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.mutedTextColor }),
          ]),
          text(9, 77, 78, 6, 'Define rollback criteria before production cutover.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
    ],
  },
  {
    id: 'investor-update',
    label: 'Investor Update',
    category: 'Investor',
    description: 'Monthly or quarterly investor update with snapshot, progress, metrics, asks, and risks.',
    slides: [
      {
        title: 'Investor Update',
        notes: 'Lead with the truth: what changed and what help is needed.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.bgColor),
          text(8, 12, 72, 20, 'Investor Update', 34, { bold: true, fontColor: theme.primaryColor }),
          text(8, 29, 66, 15, 'A direct read on momentum, constraints, and the next funding or operating milestone.', 18, { fontColor: theme.textColor }),
          ...metricCard(8, 'MRR', '$148K', theme),
          ...metricCard(38, 'Runway', '15 mo', theme),
          ...metricCard(68, 'Growth', '+11%', theme),
        ],
      },
      {
        title: 'What Changed',
        elements: (theme) => [
          text(7, 8, 84, 17, 'What Changed', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Shipped', 'Learned', 'Blocked'].flatMap((label, idx) => [
            rect(8 + idx * 30, 28, 24, 38, idx === 0 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 36, 18, 6, label, 17, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 50, 18, 7, 'One precise bullet', 12, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.textColor }),
          ]),
        ],
      },
      {
        title: 'Operating Metrics',
        elements: (theme) => [
          text(7, 8, 84, 17, 'Operating Metrics', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 24, 38, 50, theme.surfaceColor),
          rect(54, 24, 36, 50, theme.surfaceAltColor),
          text(12, 31, 24, 7, 'Funnel', 20, { bold: true, fontColor: theme.primaryColor }),
          line(14, 63, 7, theme.accentColor, 3),
          line(24, 56, 7, theme.accentColor, 3),
          line(34, 47, 7, theme.accentColor, 3),
          text(58, 32, 24, 24, 'ARR\nRetention\nBurn\nPipeline', 17, { fontColor: theme.textColor }),
        ],
      },
      {
        title: 'Help Needed',
        elements: (theme) => [
          text(7, 8, 84, 17, 'Help Needed', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Intro', 'Hire', 'Decision'].flatMap((label, idx) => [
            rect(10 + idx * 28, 30, 20, 34, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(13 + idx * 28, 39, 14, 6, label, 16, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(13 + idx * 28, 53, 14, 6, 'Owner / date', 11, { textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Risks & Commitments',
        elements: (theme) => [
          text(7, 8, 84, 17, 'Risks & Commitments', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 25, 40, 48, theme.surfaceColor),
          rect(54, 25, 38, 48, theme.surfaceAltColor),
          text(12, 32, 24, 7, 'Top Risks', 20, { bold: true, fontColor: theme.primaryColor }),
          text(58, 32, 24, 7, 'Next Commitments', 20, { bold: true, fontColor: theme.primaryColor }),
          text(12, 47, 28, 16, 'Risk\nRisk\nRisk', 16, { fontColor: theme.textColor }),
          text(58, 47, 28, 16, 'By date\nBy date\nBy date', 16, { fontColor: theme.textColor }),
        ],
      },
    ],
  },
  {
    id: 'keynote-demo',
    label: 'Keynote Demo',
    category: 'Keynote',
    description: 'High-energy product keynote with opener, stakes, live demo beats, proof, and close.',
    slides: [
      {
        title: 'Keynote Opener',
        notes: 'Use this for a live talk. Keep the headline short enough to read from the back row.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.primaryColor),
          text(8, 20, 74, 18, 'The New Way To Work', 44, { bold: true, fontColor: theme.bgColor }),
          text(9, 44, 54, 10, 'One promise. One audience. One memorable phrase.', 19, { fontColor: theme.bgColor }),
          rect(70, 52, 18, 18, theme.accentColor),
          line(9, 69, 48, theme.accentColor, 5),
        ],
      },
      {
        title: 'The Stakes',
        elements: (theme) => [
          text(7, 8, 84, 20, 'The Stakes', 34, { bold: true, fontColor: theme.primaryColor }),
          text(10, 29, 66, 16, 'The old workflow cannot keep up with the speed of modern teams.', 26, { bold: true, fontColor: theme.textColor }),
          text(10, 58, 70, 8, 'Anchor the story in a pain the audience already feels.', 15, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Demo Flow',
        elements: (theme) => [
          text(7, 8, 84, 17, 'Demo Flow', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Start', 'Create', 'Review', 'Ship'].flatMap((label, idx) => [
            rect(8 + idx * 22, 32, 17, 26, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(10 + idx * 22, 41, 13, 6, label, 14, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
          ]),
          text(9, 75, 78, 6, 'Each beat should map to one visible action in the product.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Proof Moment',
        elements: (theme) => [
          text(7, 8, 84, 17, 'Proof Moment', 30, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Speed', '8x', theme),
          ...metricCard(38, 'Quality', '+41%', theme),
          ...metricCard(68, 'Adoption', '92%', theme),
          text(10, 80, 74, 6, 'Pair metrics with customer or workflow proof.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Call To Action',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.primaryColor),
          text(9, 17, 74, 17, 'Start Today', 42, { bold: true, fontColor: theme.bgColor }),
          text(10, 38, 58, 14, 'Pilot, purchase, partner, or build with us.', 21, { fontColor: theme.bgColor }),
          rect(10, 67, 28, 10, theme.accentColor),
          text(13, 70, 22, 4, 'Next step', 13, { bold: true, textAlign: 'center', fontColor: theme.bgColor }),
        ],
      },
    ],
  },
  {
    id: 'ai-strategy-roadmap',
    label: 'AI Strategy Roadmap',
    category: 'Strategy',
    description: 'Executive AI transformation narrative with ambition, use cases, operating model, risk guardrails, and roadmap.',
    slides: [
      {
        title: 'AI Ambition',
        notes: 'Open with the business outcome, not the model name.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.primaryColor),
          text(8, 17, 74, 16, 'AI Strategy Roadmap', 40, { bold: true, fontColor: theme.bgColor }),
          text(9, 39, 58, 12, 'Where automation, judgment, and customer experience will compound.', 20, { fontColor: theme.bgColor }),
          rect(73, 58, 14, 14, theme.accentColor),
          line(9, 71, 52, theme.accentColor, 4),
        ],
      },
      {
        title: 'Use Case Portfolio',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Use Case Portfolio', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Customer', 'Operations', 'Engineering', 'Knowledge'].flatMap((label, idx) => [
            rect(8 + idx * 22, 29, 17, 34, idx === 0 ? theme.primaryColor : theme.surfaceColor),
            text(10 + idx * 22, 36, 13, 6, label, 13, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(10 + idx * 22, 49, 13, 8, 'Impact\nEffort', 11, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.mutedTextColor }),
          ]),
          text(8, 77, 78, 7, 'Prioritize use cases by workflow value, data readiness, and adoption risk.', 14, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Operating Model',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Operating Model', 30, { bold: true, fontColor: theme.primaryColor }),
          rect(9, 27, 23, 39, theme.surfaceColor),
          rect(38, 27, 23, 39, theme.surfaceAltColor),
          rect(67, 27, 23, 39, theme.primaryColor),
          text(12, 35, 17, 7, 'Platform', 18, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          text(41, 35, 17, 7, 'Product', 18, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          text(70, 35, 17, 7, 'Change', 18, { bold: true, textAlign: 'center', fontColor: theme.bgColor }),
          text(12, 50, 17, 9, 'Data\nModels\nTooling', 12, { textAlign: 'center', fontColor: theme.textColor }),
          text(41, 50, 17, 9, 'Backlog\nOwners\nMetrics', 12, { textAlign: 'center', fontColor: theme.textColor }),
          text(70, 50, 17, 9, 'Training\nPolicy\nReview', 12, { textAlign: 'center', fontColor: theme.bgColor }),
        ],
      },
      {
        title: 'Risk Guardrails',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Risk Guardrails', 30, { bold: true, fontColor: theme.primaryColor }),
          ...['Security', 'Privacy', 'Accuracy', 'Governance'].flatMap((label, idx) => [
            rect(9, 25 + idx * 13, 8, 8, idx === 1 ? theme.accentColor : theme.primaryColor),
            text(21, 23 + idx * 13, 26, 6, label, 17, { bold: true, fontColor: theme.primaryColor }),
            text(50, 24 + idx * 13, 36, 5, 'Control, owner, and escalation path.', 12, { fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: '90-Day Roadmap',
        elements: (theme) => [
          text(7, 8, 84, 12, '90-Day Roadmap', 30, { bold: true, fontColor: theme.primaryColor }),
          line(10, 45, 78, theme.accentColor, 4),
          ...['Discover', 'Pilot', 'Scale'].flatMap((label, idx) => [
            rect(12 + idx * 30, 38, 11, 11, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(8 + idx * 30, 57, 20, 6, label, 17, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(7 + idx * 30, 67, 22, 10, 'Milestone\nowner', 12, { textAlign: 'center', fontColor: theme.textColor }),
          ]),
        ],
      },
    ],
  },
  {
    id: 'security-incident-review',
    label: 'Security Incident Review',
    category: 'Security',
    description: 'Post-incident executive review with timeline, blast radius, root cause, remediation, and trust communications.',
    slides: [
      {
        title: 'Incident Snapshot',
        notes: 'State what happened, customer impact, and current containment status.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Incident Snapshot', 31, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Severity', 'SEV-2', theme),
          ...metricCard(38, 'Duration', '42m', theme),
          ...metricCard(68, 'Impact', 'Limited', theme),
          text(9, 77, 78, 7, 'Use calm, factual language. Avoid speculation until root cause is confirmed.', 14, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Timeline',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Timeline', 31, { bold: true, fontColor: theme.primaryColor }),
          line(10, 48, 78, theme.accentColor, 4),
          ...['Detect', 'Contain', 'Recover', 'Notify'].flatMap((label, idx) => [
            rect(10 + idx * 22, 41, 10, 10, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(5 + idx * 22, 58, 20, 6, label, 15, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(5 + idx * 22, 67, 20, 6, 'HH:MM', 12, { textAlign: 'center', fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Blast Radius',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Blast Radius', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 26, 38, 44, theme.surfaceColor),
          rect(54, 26, 36, 44, theme.surfaceAltColor),
          text(12, 33, 24, 7, 'Affected', 20, { bold: true, fontColor: theme.primaryColor }),
          text(58, 33, 24, 7, 'Unaffected', 20, { bold: true, fontColor: theme.primaryColor }),
          text(12, 47, 28, 13, 'Systems\nAccounts\nData classes', 15, { fontColor: theme.textColor }),
          text(58, 47, 26, 13, 'Controls\nRegions\nServices', 15, { fontColor: theme.textColor }),
        ],
      },
      {
        title: 'Root Cause & Fixes',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Root Cause & Fixes', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Cause', 'Control Gap', 'Fix', 'Verification'].flatMap((label, idx) => [
            rect(8, 25 + idx * 13, 21, 8, idx === 0 ? theme.primaryColor : theme.surfaceColor),
            text(11, 27 + idx * 13, 15, 4, label, 12, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(35, 26 + idx * 13, 48, 5, 'Owner, due date, and evidence required.', 12, { fontColor: theme.textColor }),
          ]),
        ],
      },
      {
        title: 'Trust Communications',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Trust Communications', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 27, 82, 13, theme.primaryColor),
          text(11, 31, 74, 5, 'Customer message: clear impact, remediation, and next update time.', 14, { bold: true, fontColor: theme.bgColor }),
          rect(8, 48, 38, 26, theme.surfaceColor),
          rect(54, 48, 36, 26, theme.surfaceAltColor),
          text(12, 55, 24, 6, 'External', 18, { bold: true, fontColor: theme.primaryColor }),
          text(58, 55, 24, 6, 'Internal', 18, { bold: true, fontColor: theme.primaryColor }),
        ],
      },
    ],
  },
  {
    id: 'okr-operating-review',
    label: 'OKR Operating Review',
    category: 'Operations',
    description: 'Weekly or monthly operating review with scorecard, blockers, decision log, and next commitments.',
    slides: [
      {
        title: 'Operating Scorecard',
        notes: 'Use for recurring leadership reviews. Keep each metric tied to an owner.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Operating Scorecard', 31, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Objective', '72%', theme),
          ...metricCard(38, 'Health', 'Green', theme),
          ...metricCard(68, 'Decisions', '3', theme),
        ],
      },
      {
        title: 'Objective Progress',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Objective Progress', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Acquire', 'Activate', 'Retain'].flatMap((label, idx) => [
            text(9, 28 + idx * 15, 22, 5, label, 15, { bold: true, fontColor: theme.primaryColor }),
            rect(34, 28 + idx * 15, 48, 6, theme.surfaceColor),
            rect(34, 28 + idx * 15, 22 + idx * 9, 6, idx === 2 ? theme.accentColor : theme.primaryColor),
          ]),
          text(9, 78, 72, 6, 'Call out confidence, not just completion percentage.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Blockers',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Blockers', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 26, 38, 46, theme.surfaceColor),
          rect(54, 26, 36, 46, theme.surfaceAltColor),
          text(12, 33, 24, 7, 'Blocked By', 20, { bold: true, fontColor: theme.primaryColor }),
          text(58, 33, 24, 7, 'Unblock Plan', 20, { bold: true, fontColor: theme.primaryColor }),
          text(12, 47, 26, 13, 'Dependency\nDecision\nCapacity', 15, { fontColor: theme.textColor }),
          text(58, 47, 26, 13, 'Owner\nDeadline\nEscalation', 15, { fontColor: theme.textColor }),
        ],
      },
      {
        title: 'Decision Log',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Decision Log', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Decision', 'Owner', 'Due', 'Evidence'].flatMap((label, idx) => [
            rect(8 + idx * 21, 28, 18, 9, theme.primaryColor),
            text(10 + idx * 21, 31, 14, 4, label, 12, { bold: true, textAlign: 'center', fontColor: theme.bgColor }),
            rect(8 + idx * 21, 40, 18, 28, idx % 2 ? theme.surfaceAltColor : theme.surfaceColor),
          ]),
        ],
      },
      {
        title: 'Next Commitments',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Next Commitments', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['This week', 'This month', 'Escalate'].flatMap((label, idx) => [
            rect(9 + idx * 29, 30, 22, 36, idx === 0 ? theme.primaryColor : theme.surfaceColor),
            text(12 + idx * 29, 39, 16, 6, label, 15, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(12 + idx * 29, 53, 16, 6, 'Commitment', 12, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
    ],
  },
  {
    id: 'cfo-financial-review',
    label: 'CFO Financial Review',
    category: 'Finance',
    description: 'Finance leadership deck with P&L bridge, cash runway, variance drivers, forecast, and decisions.',
    slides: [
      {
        title: 'Financial Command Center',
        notes: 'Open with the decision the finance review must unlock: spend, forecast, pricing, or hiring.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.bgColor),
          rect(0, 0, 100, 25, theme.primaryColor),
          text(7, 6, 68, 12, 'Financial Command Center', 32, { bold: true, fontColor: theme.bgColor }),
          text(7, 34, 60, 12, 'What changed, why it moved, and what leadership needs to decide.', 20, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Revenue', '$12.4M', theme),
          ...metricCard(38, 'Margin', '68%', theme),
          ...metricCard(68, 'Runway', '18 mo', theme),
        ],
      },
      {
        title: 'P&L Bridge',
        elements: (theme) => [
          text(7, 8, 84, 12, 'P&L Bridge', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Plan', 'Volume', 'Price', 'Cost', 'Actual'].flatMap((label, idx) => [
            rect(8 + idx * 17, 60 - (idx % 2) * 9, 12, 14 + (idx % 2) * 9, idx === 4 ? theme.primaryColor : theme.surfaceColor),
            text(7 + idx * 17, 78, 14, 5, label, 11, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          ]),
          line(10, 57, 72, theme.accentColor, 3),
          text(9, 25, 70, 9, 'Separate controllable movement from market movement before changing the plan.', 16, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Variance Drivers',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Variance Drivers', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Revenue', 'COGS', 'OpEx', 'Cash'].flatMap((label, idx) => [
            rect(8 + idx * 22, 29, 17, 36, idx === 0 ? theme.primaryColor : theme.surfaceColor),
            text(10 + idx * 22, 37, 13, 6, label, 14, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(10 + idx * 22, 51, 13, 8, 'Delta\nowner', 11, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.mutedTextColor }),
          ]),
          text(8, 78, 80, 6, 'Each driver needs one owner and one next action.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Forecast Range',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Forecast Range', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(9, 28, 76, 42, theme.surfaceColor),
          line(14, 58, 60, theme.accentColor, 4),
          ...['Downside', 'Base', 'Upside'].flatMap((label, idx) => [
            rect(16 + idx * 24, 42 - idx * 4, 13, 16 + idx * 4, idx === 1 ? theme.primaryColor : theme.surfaceAltColor),
            text(13 + idx * 24, 75, 19, 5, label, 12, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          ]),
          text(12, 32, 56, 6, 'Show confidence bands, not a single fragile number.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Capital Decisions',
        notes: 'End with concrete options, thresholds, and owners.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Capital Decisions', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Hire', 'Spend', 'Price', 'Raise'].flatMap((label, idx) => [
            rect(8 + idx * 22, 29, 17, 34, idx === 2 ? theme.primaryColor : theme.surfaceColor),
            text(10 + idx * 22, 38, 13, 6, label, 15, { bold: true, textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.primaryColor }),
            text(10 + idx * 22, 51, 13, 7, 'Go / hold', 11, { textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.mutedTextColor }),
          ]),
          text(9, 79, 78, 6, 'Decision rule: trigger, owner, deadline, and reversal cost.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
    ],
  },
  {
    id: 'customer-qbr',
    label: 'Customer QBR',
    category: 'Customer Success',
    description: 'Quarterly business review with outcomes, adoption, value proof, risks, and renewal plan.',
    slides: [
      {
        title: 'Customer Value Review',
        notes: 'Make the customer the hero. Start with outcomes, not vendor activity.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.bgColor),
          rect(8, 13, 34, 60, theme.surfaceColor),
          text(49, 17, 38, 13, 'Customer Value Review', 33, { bold: true, fontColor: theme.primaryColor }),
          text(49, 36, 34, 12, 'Outcomes achieved, value still ahead, and commitments for next quarter.', 18, { fontColor: theme.textColor }),
          line(49, 59, 28, theme.accentColor, 4),
          text(49, 68, 30, 6, 'Account · QBR · Date', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Outcome Scorecard',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Outcome Scorecard', 31, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Adoption', '82%', theme),
          ...metricCard(38, 'Value', '$420K', theme),
          ...metricCard(68, 'Health', 'Green', theme),
          text(9, 78, 78, 6, 'Tie every score to a customer-owned goal.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Adoption Journey',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Adoption Journey', 31, { bold: true, fontColor: theme.primaryColor }),
          line(10, 46, 76, theme.accentColor, 4),
          ...['Onboard', 'Activate', 'Expand', 'Advocate'].flatMap((label, idx) => [
            rect(10 + idx * 23, 39, 10, 10, idx === 2 ? theme.primaryColor : theme.surfaceColor),
            text(5 + idx * 23, 57, 20, 6, label, 14, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(5 + idx * 23, 67, 20, 6, 'Signal', 11, { textAlign: 'center', fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Value Proof',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Value Proof', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 26, 38, 44, theme.primaryColor),
          rect(54, 26, 36, 44, theme.surfaceAltColor),
          text(12, 36, 26, 8, '$420K', 30, { bold: true, textAlign: 'center', fontColor: theme.bgColor }),
          text(12, 50, 26, 6, 'estimated impact', 12, { textAlign: 'center', fontColor: theme.bgColor }),
          text(58, 34, 24, 20, 'Evidence\nworkflow\nowner', 17, { fontColor: theme.primaryColor }),
        ],
      },
      {
        title: 'Renewal & Expansion Plan',
        notes: 'Close with shared commitments, risk owners, and expansion timing.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Renewal & Expansion Plan', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Risk', 'Commitment', 'Expansion'].flatMap((label, idx) => [
            rect(8 + idx * 30, 29, 24, 37, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 38, 18, 6, label, 16, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 52, 18, 8, 'Owner\nby date', 12, { textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
    ],
  },
  {
    id: 'product-roadmap-review',
    label: 'Product Roadmap Review',
    category: 'Product',
    description: 'Product leadership deck with strategy, customer evidence, prioritization, roadmap, launch risks, and decisions.',
    slides: [
      {
        title: 'Product Strategy Review',
        notes: 'Frame the product bet, customer evidence, and decision boundary.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.primaryColor),
          text(8, 14, 70, 16, 'Product Strategy Review', 38, { bold: true, fontColor: theme.bgColor }),
          text(9, 37, 56, 12, 'Which customer outcome we will prioritize, and what we will intentionally not build.', 19, { fontColor: theme.bgColor }),
          rect(72, 54, 15, 15, theme.accentColor),
          line(9, 70, 48, theme.accentColor, 5),
        ],
      },
      {
        title: 'Customer Evidence',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Customer Evidence', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Interview', 'Usage', 'Support', 'Revenue'].flatMap((label, idx) => [
            rect(8 + idx * 22, 29, 17, 34, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(10 + idx * 22, 38, 13, 6, label, 13, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(10 + idx * 22, 51, 13, 7, 'Signal', 11, { textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Prioritization Matrix',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Prioritization Matrix', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(15, 25, 60, 44, theme.surfaceColor),
          line(45, 28, 1, theme.accentColor, 3),
          line(18, 47, 54, theme.accentColor, 3),
          ...['Bet A', 'Bet B', 'Bet C'].flatMap((label, idx) => [
            rect(25 + idx * 14, 55 - idx * 11, 9, 9, idx === 0 ? theme.primaryColor : theme.surfaceAltColor),
            text(24 + idx * 14, 67 - idx * 11, 12, 4, label, 10, { textAlign: 'center', fontColor: theme.primaryColor }),
          ]),
          text(16, 75, 58, 6, 'Plot impact against confidence before committing capacity.', 12, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Roadmap Now Next Later',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Roadmap Now Next Later', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Now', 'Next', 'Later'].flatMap((label, idx) => [
            rect(8 + idx * 30, 27, 24, 40, idx === 0 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 35, 18, 7, label, 18, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 50, 18, 8, 'Theme\nmilestone', 12, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Launch Risks',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Launch Risks', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Adoption', 'Quality', 'GTM', 'Support'].flatMap((label, idx) => [
            rect(9, 25 + idx * 13, 21, 8, idx === 1 ? theme.accentColor : theme.surfaceColor),
            text(12, 27 + idx * 13, 15, 4, label, 12, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(36, 26 + idx * 13, 48, 5, 'Mitigation, owner, and confidence.', 12, { fontColor: theme.textColor }),
          ]),
        ],
      },
      {
        title: 'Decision Requests',
        notes: 'End with tradeoffs and the exact decisions needed from leadership.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Decision Requests', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Approve', 'Defer', 'Resource'].flatMap((label, idx) => [
            rect(8 + idx * 30, 30, 24, 34, idx === 0 ? theme.primaryColor : theme.surfaceAltColor),
            text(11 + idx * 30, 39, 18, 6, label, 16, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 52, 18, 7, 'Decision', 12, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
    ],
  },
  {
    id: 'ma-deal-room',
    label: 'M&A Deal Room',
    category: 'Finance',
    description: 'Transaction-ready M&A deck with thesis, target profile, synergy model, diligence risks, and integration decision.',
    slides: [
      {
        title: 'Deal Thesis',
        notes: 'Open with the one reason this transaction should happen, plus the decision required today.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.bgColor),
          rect(0, 0, 100, 26, theme.primaryColor),
          text(7, 7, 68, 11, 'Deal Thesis', 34, { bold: true, fontColor: theme.bgColor }),
          text(8, 35, 56, 13, 'Strategic rationale, value creation path, and approval boundary.', 21, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'EV', '$240M', theme),
          ...metricCard(38, 'Synergy', '$38M', theme),
          ...metricCard(68, 'Close', 'Q3', theme),
        ],
      },
      {
        title: 'Target Snapshot',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Target Snapshot', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 28, 34, 40, theme.surfaceColor),
          rect(48, 28, 42, 40, theme.surfaceAltColor),
          text(12, 36, 22, 7, 'Company Profile', 19, { bold: true, fontColor: theme.primaryColor }),
          text(12, 50, 24, 10, 'Market\nteam\nproduct', 14, { fontColor: theme.textColor }),
          text(53, 35, 28, 7, 'Operating Metrics', 19, { bold: true, fontColor: theme.primaryColor }),
          text(53, 49, 28, 11, 'Revenue   $82M\nMargin     31%\nRetention  89%', 14, { fontColor: theme.textColor }),
        ],
      },
      {
        title: 'Synergy Map',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Synergy Map', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Revenue', 'Cost', 'Product', 'Market'].flatMap((label, idx) => [
            rect(8 + idx * 22, 31, 17, 33, idx === 0 ? theme.primaryColor : theme.surfaceColor),
            text(10 + idx * 22, 39, 13, 6, label, 13, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(10 + idx * 22, 52, 13, 7, 'Value\nowner', 11, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.mutedTextColor }),
          ]),
          text(9, 78, 78, 6, 'Separate bankable synergy from speculative upside.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Diligence Red Flags',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Diligence Red Flags', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Financial', 'Legal', 'Technical', 'People'].flatMap((label, idx) => [
            rect(9, 25 + idx * 13, 22, 8, idx === 1 ? theme.accentColor : theme.surfaceColor),
            text(12, 27 + idx * 13, 16, 4, label, 12, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(37, 26 + idx * 13, 47, 5, 'Issue, exposure, mitigation, and owner.', 12, { fontColor: theme.textColor }),
          ]),
        ],
      },
      {
        title: 'Integration Decision',
        notes: 'Close with approve, renegotiate, pause, or reject, then state the next gate.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Integration Decision', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Approve', 'Renegotiate', 'Pause'].flatMap((label, idx) => [
            rect(8 + idx * 30, 30, 24, 34, idx === 0 ? theme.primaryColor : theme.surfaceAltColor),
            text(11 + idx * 30, 39, 18, 6, label, 15, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 52, 18, 7, 'Trigger\nowner', 11, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.mutedTextColor }),
          ]),
          text(9, 79, 78, 6, 'Name Day 1 owner, value tracking cadence, and board checkpoint.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
    ],
  },
  {
    id: 'people-hiring-plan',
    label: 'People Hiring Plan',
    category: 'People',
    description: 'Hiring strategy deck with headcount plan, role scorecards, interview funnel, calibration, and offer decision.',
    slides: [
      {
        title: 'Hiring Plan',
        notes: 'Frame hiring as capacity allocation: which company outcome each role unlocks.',
        elements: (theme) => [
          rect(0, 0, 100, 26, theme.primaryColor),
          text(7, 7, 70, 11, 'Hiring Plan', 34, { bold: true, fontColor: theme.bgColor }),
          text(8, 36, 60, 12, 'Roles, timing, bar, and budget needed to hit the operating plan.', 20, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Open Roles', '12', theme),
          ...metricCard(38, 'Critical', '5', theme),
          ...metricCard(68, 'Budget', '$1.8M', theme),
        ],
      },
      {
        title: 'Role Scorecard',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Role Scorecard', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Mission', 'Must Have', 'Evidence'].flatMap((label, idx) => [
            rect(8 + idx * 30, 29, 24, 38, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 38, 18, 6, label, 15, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 51, 18, 8, 'Criteria\nsignals', 11, { textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Interview Funnel',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Interview Funnel', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Sourced', 'Screened', 'Panel', 'Offer'].flatMap((label, idx) => [
            rect(14 + idx * 18, 30 + idx * 6, 46 - idx * 8, 10, idx === 3 ? theme.primaryColor : theme.surfaceColor),
            text(17 + idx * 18, 33 + idx * 6, 18, 4, label, 12, { bold: true, fontColor: idx === 3 ? theme.bgColor : theme.primaryColor }),
          ]),
          text(10, 79, 76, 6, 'Track conversion, cycle time, and source quality by role.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Candidate Calibration',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Candidate Calibration', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(14, 25, 58, 44, theme.surfaceColor),
          line(43, 28, 1, theme.accentColor, 3),
          line(17, 47, 52, theme.accentColor, 3),
          ...['A', 'B', 'C'].flatMap((label, idx) => [
            rect(24 + idx * 15, 56 - idx * 11, 9, 9, idx === 0 ? theme.primaryColor : theme.surfaceAltColor),
            text(24 + idx * 15, 68 - idx * 11, 9, 4, label, 10, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          ]),
          text(15, 75, 58, 6, 'Plot role fit against evidence strength before debrief.', 12, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Offer Decision',
        notes: 'Close with decision, compensation band, closing plan, and fallback candidate.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Offer Decision', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 28, 38, 38, theme.primaryColor),
          text(12, 40, 28, 8, 'Extend Offer', 27, { bold: true, textAlign: 'center', fontColor: theme.bgColor }),
          rect(54, 28, 36, 38, theme.surfaceAltColor),
          text(58, 36, 25, 16, 'Comp band\nclosing owner\nstart date', 15, { fontColor: theme.primaryColor }),
        ],
      },
    ],
  },
  {
    id: 'brand-narrative-system',
    label: 'Brand Narrative System',
    category: 'Brand',
    description: 'Brand and campaign narrative deck with audience truth, message house, creative system, and launch storyboard.',
    slides: [
      {
        title: 'Brand Narrative',
        notes: 'Start with the belief the market should carry after seeing the campaign.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.primaryColor),
          text(8, 15, 72, 14, 'Brand Narrative', 37, { bold: true, fontColor: theme.bgColor }),
          text(9, 38, 54, 12, 'The story system behind the next campaign, launch, or repositioning.', 19, { fontColor: theme.bgColor }),
          rect(72, 54, 15, 15, theme.accentColor),
          line(9, 70, 46, theme.accentColor, 5),
        ],
      },
      {
        title: 'Audience Truth',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Audience Truth', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Tension', 'Desire', 'Barrier'].flatMap((label, idx) => [
            rect(8 + idx * 30, 29, 24, 38, idx === 0 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 38, 18, 6, label, 16, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 52, 18, 7, 'Human\nsignal', 12, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Message House',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Message House', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(28, 24, 36, 10, theme.primaryColor),
          text(32, 27, 28, 4, 'Core Promise', 13, { bold: true, textAlign: 'center', fontColor: theme.bgColor }),
          ...['Proof 1', 'Proof 2', 'Proof 3'].flatMap((label, idx) => [
            rect(12 + idx * 26, 45, 20, 18, theme.surfaceColor),
            text(14 + idx * 26, 52, 16, 4, label, 12, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          ]),
          rect(10, 70, 74, 7, theme.surfaceAltColor),
          text(13, 72, 68, 3, 'Brand voice, taboo words, and proof standards', 10, { textAlign: 'center', fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Creative System',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Creative System', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Visual', 'Copy', 'Motion', 'Channel'].flatMap((label, idx) => [
            rect(8 + idx * 22, 30, 17, 34, idx === 2 ? theme.primaryColor : theme.surfaceColor),
            text(10 + idx * 22, 39, 13, 6, label, 13, { bold: true, textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.primaryColor }),
            text(10 + idx * 22, 52, 13, 7, 'Rule\nexample', 11, { textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Launch Storyboard',
        notes: 'Close with narrative beats, assets, owners, and measurement.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Launch Storyboard', 31, { bold: true, fontColor: theme.primaryColor }),
          line(10, 47, 76, theme.accentColor, 4),
          ...['Tease', 'Reveal', 'Prove', 'Sustain'].flatMap((label, idx) => [
            rect(10 + idx * 23, 40, 10, 10, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(5 + idx * 23, 58, 20, 6, label, 14, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(5 + idx * 23, 68, 20, 6, 'Asset\nKPI', 11, { textAlign: 'center', fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
    ],
  },
  {
    id: 'regulatory-compliance-brief',
    label: 'Regulatory Compliance Brief',
    category: 'Compliance',
    description: 'Compliance and audit briefing deck with obligations, controls, evidence, gaps, and remediation owners.',
    slides: [
      {
        title: 'Compliance Brief',
        notes: 'Open with the regulation, exposure, decision boundary, and date-sensitive obligation.',
        elements: (theme) => [
          rect(0, 0, 100, 26, theme.primaryColor),
          text(7, 7, 72, 11, 'Compliance Brief', 34, { bold: true, fontColor: theme.bgColor }),
          text(8, 36, 62, 12, 'Obligations, control evidence, gaps, and remediation decisions.', 20, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Controls', '42', theme),
          ...metricCard(38, 'Gaps', '7', theme),
          ...metricCard(68, 'Deadline', '30d', theme),
        ],
      },
      {
        title: 'Obligation Map',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Obligation Map', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Policy', 'Process', 'System', 'Evidence'].flatMap((label, idx) => [
            rect(8 + idx * 22, 30, 17, 34, idx === 2 ? theme.primaryColor : theme.surfaceColor),
            text(10 + idx * 22, 39, 13, 6, label, 13, { bold: true, textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.primaryColor }),
            text(10 + idx * 22, 52, 13, 7, 'Owner\nproof', 11, { textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Control Evidence',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Control Evidence', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 25, 38, 44, theme.surfaceColor),
          rect(54, 25, 36, 44, theme.surfaceAltColor),
          text(12, 33, 26, 7, 'Evidence Register', 20, { bold: true, fontColor: theme.primaryColor }),
          text(12, 47, 26, 11, 'Source\nfreshness\napprover', 15, { fontColor: theme.textColor }),
          text(58, 35, 24, 18, 'Pass\nPartial\nMissing', 17, { fontColor: theme.primaryColor }),
        ],
      },
      {
        title: 'Gap Analysis',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Gap Analysis', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['High', 'Medium', 'Low'].flatMap((label, idx) => [
            rect(10, 27 + idx * 15, 18, 9, idx === 0 ? theme.accentColor : theme.surfaceColor),
            text(13, 29 + idx * 15, 12, 4, label, 12, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(34, 28 + idx * 15, 48, 5, 'Gap, business impact, and mitigation path.', 12, { fontColor: theme.textColor }),
          ]),
        ],
      },
      {
        title: 'Remediation Plan',
        notes: 'Close with owner, deadline, control retest, and executive decision needed.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Remediation Plan', 31, { bold: true, fontColor: theme.primaryColor }),
          line(10, 47, 76, theme.accentColor, 4),
          ...['Fix', 'Validate', 'Attest', 'Monitor'].flatMap((label, idx) => [
            rect(10 + idx * 23, 40, 10, 10, idx === 0 ? theme.primaryColor : theme.surfaceColor),
            text(5 + idx * 23, 58, 20, 6, label, 14, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(5 + idx * 23, 68, 20, 6, 'Owner\nDate', 11, { textAlign: 'center', fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
    ],
  },
  {
    id: 'nonprofit-grant-proposal',
    label: 'Nonprofit Grant Proposal',
    category: 'Impact',
    description: 'Grant-ready impact deck with community need, program model, outcomes, budget, and funding ask.',
    slides: [
      {
        title: 'Impact Grant Proposal',
        notes: 'Start with the human outcome, not the organization.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.bgColor),
          rect(8, 13, 34, 60, theme.surfaceColor),
          text(49, 16, 38, 13, 'Impact Grant Proposal', 32, { bold: true, fontColor: theme.primaryColor }),
          text(49, 36, 34, 12, 'A fundable program, clear outcomes, and proof that the model can work.', 18, { fontColor: theme.textColor }),
          line(49, 60, 30, theme.accentColor, 4),
          text(49, 69, 30, 6, 'Organization · Funder · Date', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Community Need',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Community Need', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Who', 'Barrier', 'Urgency'].flatMap((label, idx) => [
            rect(8 + idx * 30, 29, 24, 38, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 38, 18, 6, label, 16, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 52, 18, 8, 'Evidence\nstory', 12, { textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Program Model',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Program Model', 31, { bold: true, fontColor: theme.primaryColor }),
          line(10, 47, 76, theme.accentColor, 4),
          ...['Inputs', 'Activities', 'Outputs', 'Outcomes'].flatMap((label, idx) => [
            rect(10 + idx * 23, 40, 10, 10, idx === 3 ? theme.primaryColor : theme.surfaceColor),
            text(5 + idx * 23, 58, 20, 6, label, 13, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(5 + idx * 23, 68, 20, 6, 'Measure', 11, { textAlign: 'center', fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Budget & Outcomes',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Budget & Outcomes', 31, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Ask', '$250K', theme),
          ...metricCard(38, 'Served', '1,200', theme),
          ...metricCard(68, 'Cost / outcome', '$208', theme),
          text(9, 78, 78, 6, 'Connect every budget line to a measurable outcome.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Funding Ask',
        notes: 'Close with exact funding amount, reporting cadence, and partner commitments.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Funding Ask', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 28, 38, 38, theme.primaryColor),
          text(12, 40, 28, 8, '$250K', 30, { bold: true, textAlign: 'center', fontColor: theme.bgColor }),
          rect(54, 28, 36, 38, theme.surfaceAltColor),
          text(58, 36, 25, 16, 'Milestone\nreporting\nrenewal path', 15, { fontColor: theme.primaryColor }),
        ],
      },
    ],
  },
  {
    id: 'pricing-packaging-strategy',
    label: 'Pricing & Packaging Strategy',
    category: 'Monetization',
    description: 'Pricing decision deck with segments, packaging architecture, scenarios, risk, and launch decision.',
    slides: [
      {
        title: 'Pricing Strategy',
        notes: 'Frame the pricing decision, customer value, and revenue impact in one sentence.',
        elements: (theme) => [
          rect(0, 0, 100, 26, theme.primaryColor),
          text(7, 7, 72, 11, 'Pricing Strategy', 34, { bold: true, fontColor: theme.bgColor }),
          text(8, 36, 61, 12, 'Segments, value metric, package shape, and decision required today.', 20, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'ARPA lift', '+18%', theme),
          ...metricCard(38, 'Churn risk', 'Low', theme),
          ...metricCard(68, 'Launch', 'Q2', theme),
        ],
      },
      {
        title: 'Segment Willingness',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Segment Willingness', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['SMB', 'Mid-Market', 'Enterprise'].flatMap((label, idx) => [
            rect(8 + idx * 30, 30, 24, 34, idx === 2 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 39, 18, 6, label, 15, { bold: true, textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 52, 18, 7, 'Value\nthreshold', 11, { textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Package Architecture',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Package Architecture', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Core', 'Growth', 'Scale'].flatMap((label, idx) => [
            rect(10 + idx * 28, 28, 22, 40, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(13 + idx * 28, 37, 16, 6, label, 16, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(13 + idx * 28, 51, 16, 8, 'Features\nlimits', 11, { textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Scenario Impact',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Scenario Impact', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(10, 28, 74, 38, theme.surfaceColor),
          line(15, 58, 58, theme.accentColor, 4),
          ...['Conservative', 'Base', 'Aggressive'].flatMap((label, idx) => [
            rect(17 + idx * 22, 44 - idx * 4, 12, 14 + idx * 4, idx === 1 ? theme.primaryColor : theme.surfaceAltColor),
            text(11 + idx * 22, 74, 24, 5, label, 11, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          ]),
        ],
      },
      {
        title: 'Decision Gate',
        notes: 'Close with recommended price move, rollout cohort, risk checks, and rollback rule.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Decision Gate', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Approve', 'Pilot', 'Hold'].flatMap((label, idx) => [
            rect(8 + idx * 30, 30, 24, 34, idx === 0 ? theme.primaryColor : theme.surfaceAltColor),
            text(11 + idx * 30, 39, 18, 6, label, 16, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 52, 18, 7, 'Trigger\nowner', 11, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.mutedTextColor }),
          ]),
          text(9, 79, 78, 6, 'Define launch cohort, success metric, rollback threshold, and comms owner.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
    ],
  },
  {
    id: 'legal-case-brief',
    label: 'Legal Case Brief',
    category: 'Legal',
    description: 'Matter-ready legal deck with claim map, evidence register, exposure model, and filing decision.',
    slides: [
      {
        title: 'Matter Snapshot',
        notes: 'Open with matter posture, decision needed, exposure, and the next legal deadline.',
        elements: (theme) => [
          rect(0, 0, 100, 26, theme.primaryColor),
          text(7, 7, 72, 11, 'Matter Snapshot', 34, { bold: true, fontColor: theme.bgColor }),
          text(8, 36, 62, 12, 'Legal posture, exposure, evidence strength, and decision boundary.', 20, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Exposure', '$4.8M', theme),
          ...metricCard(38, 'Evidence', 'Strong', theme),
          ...metricCard(68, 'Deadline', '14d', theme),
        ],
      },
      {
        title: 'Claim Map',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Claim Map', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Claim', 'Defense', 'Burden'].flatMap((label, idx) => [
            rect(8 + idx * 30, 30, 24, 34, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 39, 18, 6, label, 16, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 52, 18, 7, 'Issue\nstandard', 11, { textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Evidence Register',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Evidence Register', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 25, 84, 46, theme.surfaceColor),
          ...['Source', 'Relevance', 'Risk', 'Owner'].flatMap((label, idx) => [
            text(12 + idx * 20, 33, 15, 5, label, 12, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            rect(12 + idx * 20, 44, 14, 6, idx === 2 ? theme.accentColor : theme.surfaceAltColor),
            rect(12 + idx * 20, 56, 14, 6, theme.surfaceAltColor),
          ]),
          text(10, 80, 78, 6, 'Tie each assertion to admissible evidence and privilege status.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Exposure Model',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Exposure Model', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(10, 28, 74, 38, theme.surfaceColor),
          line(15, 58, 58, theme.accentColor, 4),
          ...['Best', 'Expected', 'Adverse'].flatMap((label, idx) => [
            rect(17 + idx * 22, 48 - idx * 6, 12, 10 + idx * 6, idx === 2 ? theme.accentColor : theme.surfaceAltColor),
            text(11 + idx * 22, 74, 24, 5, label, 11, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          ]),
        ],
      },
      {
        title: 'Decision & Next Filing',
        notes: 'Close with settle, file, negotiate, or hold, plus the approver and filing date.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Decision & Next Filing', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Settle', 'File', 'Negotiate'].flatMap((label, idx) => [
            rect(8 + idx * 30, 30, 24, 34, idx === 1 ? theme.primaryColor : theme.surfaceAltColor),
            text(11 + idx * 30, 39, 18, 6, label, 15, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 52, 18, 7, 'Trigger\nowner', 11, { textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.mutedTextColor }),
          ]),
          text(9, 79, 78, 6, 'Name decision maker, privilege boundary, and next filing owner.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
    ],
  },
  {
    id: 'clinical-trial-readout',
    label: 'Clinical Trial Readout',
    category: 'Healthcare',
    description: 'Clinical or medical research readout with cohort, endpoints, safety, interpretation, and regulatory next step.',
    slides: [
      {
        title: 'Study Readout',
        notes: 'Open with study question, patient population, primary endpoint, and decision implication.',
        elements: (theme) => [
          rect(0, 0, 100, 26, theme.primaryColor),
          text(7, 7, 72, 11, 'Study Readout', 34, { bold: true, fontColor: theme.bgColor }),
          text(8, 36, 62, 12, 'Clinical evidence, safety profile, and the next regulatory or operating decision.', 20, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'N', '428', theme),
          ...metricCard(38, 'Primary EP', 'Met', theme),
          ...metricCard(68, 'Safety', 'Watch', theme),
        ],
      },
      {
        title: 'Cohort & Method',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Cohort & Method', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Population', 'Protocol', 'Comparator'].flatMap((label, idx) => [
            rect(8 + idx * 30, 29, 24, 38, idx === 0 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 38, 18, 6, label, 15, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 51, 18, 8, 'Criteria\nlimits', 11, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Endpoint Results',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Endpoint Results', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(10, 28, 74, 38, theme.surfaceColor),
          line(15, 58, 58, theme.accentColor, 4),
          ...['Primary', 'Secondary', 'Exploratory'].flatMap((label, idx) => [
            rect(17 + idx * 22, 48 - idx * 5, 12, 10 + idx * 5, idx === 0 ? theme.primaryColor : theme.surfaceAltColor),
            text(11 + idx * 22, 74, 24, 5, label, 11, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
          ]),
        ],
      },
      {
        title: 'Safety Watch',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Safety Watch', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['AE', 'SAE', 'Discontinue', 'Monitor'].flatMap((label, idx) => [
            rect(9, 25 + idx * 13, 21, 8, idx === 1 ? theme.accentColor : theme.surfaceColor),
            text(12, 27 + idx * 13, 15, 4, label, 12, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(36, 26 + idx * 13, 48, 5, 'Signal, severity, action, and owner.', 12, { fontColor: theme.textColor }),
          ]),
        ],
      },
      {
        title: 'Regulatory Next Step',
        notes: 'Close with filing path, evidence gap, owner, and the next regulator interaction.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Regulatory Next Step', 31, { bold: true, fontColor: theme.primaryColor }),
          line(10, 47, 76, theme.accentColor, 4),
          ...['Analyze', 'Brief', 'Submit', 'Monitor'].flatMap((label, idx) => [
            rect(10 + idx * 23, 40, 10, 10, idx === 2 ? theme.primaryColor : theme.surfaceColor),
            text(5 + idx * 23, 58, 20, 6, label, 14, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(5 + idx * 23, 68, 20, 6, 'Owner\nDate', 11, { textAlign: 'center', fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
    ],
  },
  {
    id: 'all-hands-town-hall',
    label: 'All-Hands Town Hall',
    category: 'Internal Comms',
    description: 'Company town hall deck with operating scoreboard, strategy shifts, culture commitments, and live Q&A.',
    slides: [
      {
        title: 'All-Hands Narrative',
        notes: 'Start with what changed, why it matters, and what every team should do next.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.primaryColor),
          text(8, 15, 72, 14, 'All-Hands Narrative', 37, { bold: true, fontColor: theme.bgColor }),
          text(9, 38, 56, 12, 'Where we are, what changed, and what the next operating rhythm requires.', 19, { fontColor: theme.bgColor }),
          rect(72, 54, 15, 15, theme.accentColor),
          line(9, 70, 46, theme.accentColor, 5),
        ],
      },
      {
        title: 'Company Scoreboard',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Company Scoreboard', 31, { bold: true, fontColor: theme.primaryColor }),
          ...metricCard(8, 'Customers', '+18%', theme),
          ...metricCard(38, 'Quality', '92%', theme),
          ...metricCard(68, 'Focus', '3 bets', theme),
          text(9, 80, 78, 6, 'Explain the score in plain language, then name the team behavior behind it.', 13, { fontColor: theme.mutedTextColor }),
        ],
      },
      {
        title: 'Strategy Shifts',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Strategy Shifts', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Stop', 'Start', 'Scale'].flatMap((label, idx) => [
            rect(8 + idx * 30, 30, 24, 34, idx === 2 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 39, 18, 6, label, 16, { bold: true, textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 52, 18, 7, 'Behavior\nowner', 11, { textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Operating Principles',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Operating Principles', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Customer', 'Craft', 'Speed', 'Trust'].flatMap((label, idx) => [
            rect(8 + idx * 22, 30, 17, 34, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(10 + idx * 22, 39, 13, 6, label, 13, { bold: true, textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.primaryColor }),
            text(10 + idx * 22, 52, 13, 7, 'Rule\nexample', 11, { textAlign: 'center', fontColor: idx === 1 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Questions & Commitments',
        notes: 'Close with a real Q&A path, owners, and next operating commitments.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Questions & Commitments', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 28, 38, 38, theme.primaryColor),
          text(12, 40, 28, 8, 'Ask Live', 27, { bold: true, textAlign: 'center', fontColor: theme.bgColor }),
          rect(54, 28, 36, 38, theme.surfaceAltColor),
          text(58, 36, 25, 16, 'Owner\nanswer date\nfollow-up channel', 15, { fontColor: theme.primaryColor }),
        ],
      },
    ],
  },
  {
    id: 'event-sponsorship-pitch',
    label: 'Event Sponsorship Pitch',
    category: 'Events',
    description: 'Sponsor-facing event pitch with audience profile, package matrix, activation plan, and ROI reporting.',
    slides: [
      {
        title: 'Sponsorship Story',
        notes: 'Open with the audience, brand fit, and measurable sponsor outcome.',
        elements: (theme) => [
          rect(0, 0, 100, 100, theme.primaryColor),
          text(8, 15, 72, 14, 'Sponsorship Story', 38, { bold: true, fontColor: theme.bgColor }),
          text(9, 39, 55, 12, 'The right audience, the right moment, and a measurable brand lift plan.', 19, { fontColor: theme.bgColor }),
          ...metricCard(8, 'Reach', '42K', theme),
          ...metricCard(38, 'Leads', '1.8K', theme),
          ...metricCard(68, 'NPS', '71', theme),
        ],
      },
      {
        title: 'Audience Profile',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Audience Profile', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Who', 'Why Attend', 'Buying Signal'].flatMap((label, idx) => [
            rect(8 + idx * 30, 29, 24, 38, idx === 2 ? theme.primaryColor : theme.surfaceColor),
            text(11 + idx * 30, 38, 18, 6, label, 15, { bold: true, textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.primaryColor }),
            text(11 + idx * 30, 52, 18, 7, 'Proof\nsource', 11, { textAlign: 'center', fontColor: idx === 2 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Package Matrix',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Package Matrix', 31, { bold: true, fontColor: theme.primaryColor }),
          ...['Gold', 'Studio', 'Community'].flatMap((label, idx) => [
            rect(10 + idx * 28, 28, 22, 40, idx === 0 ? theme.primaryColor : theme.surfaceColor),
            text(13 + idx * 28, 37, 16, 6, label, 16, { bold: true, textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.primaryColor }),
            text(13 + idx * 28, 51, 16, 8, 'Benefits\ninventory', 11, { textAlign: 'center', fontColor: idx === 0 ? theme.bgColor : theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'Activation Plan',
        elements: (theme) => [
          text(7, 8, 84, 12, 'Activation Plan', 31, { bold: true, fontColor: theme.primaryColor }),
          line(10, 47, 76, theme.accentColor, 4),
          ...['Pre', 'Onsite', 'Digital', 'Follow-up'].flatMap((label, idx) => [
            rect(10 + idx * 23, 40, 10, 10, idx === 1 ? theme.primaryColor : theme.surfaceColor),
            text(5 + idx * 23, 58, 20, 6, label, 13, { bold: true, textAlign: 'center', fontColor: theme.primaryColor }),
            text(5 + idx * 23, 68, 20, 6, 'Asset\nKPI', 11, { textAlign: 'center', fontColor: theme.mutedTextColor }),
          ]),
        ],
      },
      {
        title: 'ROI Reporting',
        notes: 'Close with reporting cadence, attribution plan, sponsor owner, and renewal path.',
        elements: (theme) => [
          text(7, 8, 84, 12, 'ROI Reporting', 31, { bold: true, fontColor: theme.primaryColor }),
          rect(8, 25, 38, 44, theme.surfaceColor),
          rect(54, 25, 36, 44, theme.surfaceAltColor),
          text(12, 33, 26, 7, 'Sponsor Dashboard', 20, { bold: true, fontColor: theme.primaryColor }),
          text(12, 47, 26, 11, 'Reach\nengagement\npipeline', 15, { fontColor: theme.textColor }),
          text(58, 35, 24, 18, 'Report\nRenew\nExpand', 17, { fontColor: theme.primaryColor }),
        ],
      },
    ],
  },
];

export const PPTX_DESIGN_PRESET_PACKS: PptxDesignPresetPack[] = [
  {
    id: 'vc-signal-pitch',
    label: 'VC Signal Pitch',
    category: 'Pitch',
    description: 'Startup Pitch with the high-energy Startup Signal theme.',
    themeId: 'startup-signal',
    templateId: 'startup-pitch',
  },
  {
    id: 'boardroom-ink',
    label: 'Boardroom Ink',
    category: 'Executive',
    description: 'Board Review with a crisp Executive Ink boardroom treatment.',
    themeId: 'executive-ink',
    templateId: 'board-review',
  },
  {
    id: 'market-launch',
    label: 'Market Launch',
    category: 'Marketing',
    description: 'Campaign Plan with warm Market Sunrise colors.',
    themeId: 'market-sunrise',
    templateId: 'campaign-plan',
  },
  {
    id: 'research-memo',
    label: 'Research Memo',
    category: 'Research',
    description: 'Research Brief with editorial Research Paper styling.',
    themeId: 'research-paper',
    templateId: 'research-brief',
  },
  {
    id: 'sales-close-plan',
    label: 'Sales Close Plan',
    category: 'Sales',
    description: 'Enterprise Sales deck with direct Sales Contrast styling.',
    themeId: 'sales-contrast',
    templateId: 'enterprise-sales',
  },
  {
    id: 'portfolio-gallery',
    label: 'Portfolio Gallery',
    category: 'Portfolio',
    description: 'Case study portfolio deck with clean gallery styling.',
    themeId: 'portfolio-gallery',
    templateId: 'portfolio-case-study',
  },
  {
    id: 'data-lab-report',
    label: 'Data Lab Report',
    category: 'Analytics',
    description: 'Data Report with dashboard-oriented Data Lab styling.',
    themeId: 'data-lab',
    templateId: 'data-report',
  },
  {
    id: 'proposal-redline',
    label: 'Proposal Redline',
    category: 'Proposal',
    description: 'Consulting Proposal with editorial red contrast.',
    themeId: 'editorial-red',
    templateId: 'consulting-proposal',
  },
  {
    id: 'blueprint-architecture',
    label: 'Blueprint Architecture',
    category: 'Engineering',
    description: 'Technical Architecture with precise blueprint styling.',
    themeId: 'architecture-blueprint',
    templateId: 'technical-architecture',
  },
  {
    id: 'investor-copper-update',
    label: 'Investor Copper Update',
    category: 'Investor',
    description: 'Investor Update with premium copper data-room styling.',
    themeId: 'investor-copper',
    templateId: 'investor-update',
  },
  {
    id: 'stage-keynote',
    label: 'Stage Keynote',
    category: 'Keynote',
    description: 'Keynote Demo with large-stage spectrum styling.',
    themeId: 'keynote-spectrum',
    templateId: 'keynote-demo',
  },
  {
    id: 'technical-board-brief',
    label: 'Technical Board Brief',
    category: 'Executive',
    description: 'Technical Architecture with boardroom Executive Ink styling.',
    themeId: 'executive-ink',
    templateId: 'technical-architecture',
  },
  {
    id: 'ai-transformation-roadmap',
    label: 'AI Transformation Roadmap',
    category: 'Strategy',
    description: 'AI Strategy Roadmap with keynote spectrum styling for executive transformation narratives.',
    themeId: 'keynote-spectrum',
    templateId: 'ai-strategy-roadmap',
  },
  {
    id: 'security-war-room',
    label: 'Security War Room',
    category: 'Security',
    description: 'Security Incident Review with precise blueprint styling for incident briefings.',
    themeId: 'architecture-blueprint',
    templateId: 'security-incident-review',
  },
  {
    id: 'okr-ops-review',
    label: 'OKR Ops Review',
    category: 'Operations',
    description: 'OKR Operating Review with executive ink styling for recurring leadership reviews.',
    themeId: 'executive-ink',
    templateId: 'okr-operating-review',
  },
  {
    id: 'cfo-command-center',
    label: 'CFO Command Center',
    category: 'Finance',
    description: 'CFO Financial Review with finance terminal styling for variance, runway, and forecast decisions.',
    themeId: 'finance-terminal',
    templateId: 'cfo-financial-review',
  },
  {
    id: 'customer-value-qbr',
    label: 'Customer Value QBR',
    category: 'Customer Success',
    description: 'Customer QBR with customer aurora styling for renewal, adoption, and value proof.',
    themeId: 'customer-aurora',
    templateId: 'customer-qbr',
  },
  {
    id: 'product-prism-roadmap',
    label: 'Product Prism Roadmap',
    category: 'Product',
    description: 'Product Roadmap Review with product prism styling for roadmap tradeoffs and launch decisions.',
    themeId: 'product-prism',
    templateId: 'product-roadmap-review',
  },
  {
    id: 'deal-room-command',
    label: 'Deal Room Command',
    category: 'Finance',
    description: 'M&A Deal Room with premium investor copper styling for diligence and approval meetings.',
    themeId: 'investor-copper',
    templateId: 'ma-deal-room',
  },
  {
    id: 'talent-hiring-plan',
    label: 'Talent Hiring Plan',
    category: 'People',
    description: 'People Hiring Plan with portfolio gallery styling for headcount, calibration, and offers.',
    themeId: 'portfolio-gallery',
    templateId: 'people-hiring-plan',
  },
  {
    id: 'brand-narrative-studio',
    label: 'Brand Narrative Studio',
    category: 'Brand',
    description: 'Brand Narrative System with market sunrise styling for message systems and launch campaigns.',
    themeId: 'market-sunrise',
    templateId: 'brand-narrative-system',
  },
  {
    id: 'compliance-command-center',
    label: 'Compliance Command Center',
    category: 'Compliance',
    description: 'Regulatory Compliance Brief with blueprint styling for audit, control, and remediation decisions.',
    themeId: 'architecture-blueprint',
    templateId: 'regulatory-compliance-brief',
  },
  {
    id: 'impact-grant-story',
    label: 'Impact Grant Story',
    category: 'Impact',
    description: 'Nonprofit Grant Proposal with customer aurora styling for community need, outcomes, and funding asks.',
    themeId: 'customer-aurora',
    templateId: 'nonprofit-grant-proposal',
  },
  {
    id: 'pricing-monetization-lab',
    label: 'Pricing Monetization Lab',
    category: 'Monetization',
    description: 'Pricing & Packaging Strategy with sales contrast styling for package, scenario, and launch decisions.',
    themeId: 'sales-contrast',
    templateId: 'pricing-packaging-strategy',
  },
  {
    id: 'legal-matter-command',
    label: 'Legal Matter Command',
    category: 'Legal',
    description: 'Legal Case Brief with graphite styling for matter posture, evidence, exposure, and filing decisions.',
    themeId: 'legal-graphite',
    templateId: 'legal-case-brief',
  },
  {
    id: 'clinical-clear-readout',
    label: 'Clinical Clear Readout',
    category: 'Healthcare',
    description: 'Clinical Trial Readout with clean teal-blue styling for endpoints, safety, and regulatory next steps.',
    themeId: 'clinical-clear',
    templateId: 'clinical-trial-readout',
  },
  {
    id: 'town-hall-operating-update',
    label: 'Town Hall Operating Update',
    category: 'Internal Comms',
    description: 'All-Hands Town Hall with lime momentum styling for company updates, principles, and commitments.',
    themeId: 'townhall-lime',
    templateId: 'all-hands-town-hall',
  },
  {
    id: 'event-sponsor-signal',
    label: 'Event Sponsor Signal',
    category: 'Events',
    description: 'Event Sponsorship Pitch with high-contrast signal styling for sponsor value and ROI.',
    themeId: 'event-signal',
    templateId: 'event-sponsorship-pitch',
  },
];

const PRESET_SIGNAL_KEYWORDS: Record<string, string[]> = {
  'vc-signal-pitch': [
    'startup', 'pitch', 'traction', 'market', 'founder', 'funding', 'ask', 'investor', 'growth', 'revenue',
    'problem', 'solution',
  ],
  'boardroom-ink': [
    'board', 'executive', 'decision', 'kpi', 'risk', 'governance', 'quarter', 'performance', 'approval',
    'priority',
  ],
  'market-launch': [
    'campaign', 'marketing', 'launch', 'audience', 'channel', 'creative', 'brand', 'conversion', 'positioning',
    'measurement',
  ],
  'research-memo': [
    'research', 'study', 'hypothesis', 'finding', 'method', 'sample', 'evidence', 'insight', 'analysis',
    'recommendation',
  ],
  'sales-close-plan': [
    'sales', 'account', 'buyer', 'pipeline', 'roi', 'close', 'deal', 'stakeholder', 'objection', 'pricing',
    'enterprise',
  ],
  'portfolio-gallery': [
    'portfolio', 'case', 'gallery', 'artifact', 'work', 'client', 'before', 'after', 'craft', 'visual',
  ],
  'data-lab-report': [
    'data', 'dashboard', 'metric', 'analytics', 'report', 'cohort', 'trend', 'segment', 'experiment', 'kpi',
  ],
  'proposal-redline': [
    'proposal', 'scope', 'fee', 'timeline', 'client', 'consulting', 'deliverable', 'pricing', 'commercial',
    'engagement',
  ],
  'blueprint-architecture': [
    'architecture', 'system', 'api', 'reliability', 'security', 'observability', 'service', 'infra', 'platform',
    'integration',
  ],
  'investor-copper-update': [
    'investor', 'update', 'runway', 'burn', 'cash', 'arr', 'mrr', 'retention', 'milestone', 'fundraising',
  ],
  'stage-keynote': [
    'keynote', 'stage', 'demo', 'product', 'reveal', 'moment', 'story', 'vision', 'experience', 'audience',
  ],
  'technical-board-brief': [
    'technical', 'architecture', 'board', 'risk', 'reliability', 'security', 'roadmap', 'decision', 'controls',
    'platform',
  ],
  'ai-transformation-roadmap': [
    'ai', 'automation', 'model', 'llm', 'agent', 'transformation', 'strategy', 'roadmap', 'use case', 'guardrail',
    'adoption', 'governance', 'workflow',
  ],
  'security-war-room': [
    'security', 'incident', 'sev', 'breach', 'blast radius', 'root cause', 'containment', 'remediation', 'trust',
    'privacy', 'timeline', 'postmortem',
  ],
  'okr-ops-review': [
    'okr', 'objective', 'key result', 'operating', 'ops', 'scorecard', 'blocker', 'commitment', 'decision log',
    'weekly', 'monthly', 'owner',
  ],
  'cfo-command-center': [
    'cfo', 'finance', 'financial', 'p&l', 'variance', 'runway', 'cash', 'forecast', 'margin', 'burn',
    'budget', 'capital', 'revenue', 'opex',
  ],
  'customer-value-qbr': [
    'qbr', 'customer', 'renewal', 'adoption', 'health', 'expansion', 'value', 'outcome', 'account',
    'success', 'stakeholder', 'commitment',
  ],
  'product-prism-roadmap': [
    'product', 'roadmap', 'feature', 'customer evidence', 'prioritization', 'launch', 'release', 'backlog',
    'discovery', 'adoption', 'tradeoff', 'decision',
  ],
  'deal-room-command': [
    'm&a', 'merger', 'acquisition', 'deal', 'target', 'diligence', 'synergy', 'integration', 'valuation',
    'transaction', 'approval', 'red flag', 'board',
  ],
  'talent-hiring-plan': [
    'hiring', 'people', 'talent', 'role', 'scorecard', 'candidate', 'interview', 'funnel', 'offer',
    'compensation', 'calibration', 'headcount',
  ],
  'brand-narrative-studio': [
    'brand', 'narrative', 'audience', 'message', 'message house', 'creative', 'campaign', 'launch',
    'storyboard', 'positioning', 'voice', 'proof',
  ],
  'compliance-command-center': [
    'compliance', 'regulatory', 'audit', 'control', 'evidence', 'obligation', 'policy', 'gap',
    'remediation', 'attestation', 'risk', 'deadline', 'governance',
  ],
  'impact-grant-story': [
    'nonprofit', 'grant', 'impact', 'community', 'funding', 'funder', 'program', 'outcome',
    'budget', 'served', 'beneficiary', 'donor', 'mission',
  ],
  'pricing-monetization-lab': [
    'pricing', 'packaging', 'monetization', 'price', 'package', 'segment', 'willingness',
    'arpa', 'churn', 'scenario', 'tier', 'launch', 'revenue',
  ],
  'legal-matter-command': [
    'legal', 'matter', 'claim', 'defense', 'evidence', 'exposure', 'filing', 'settle', 'privilege',
    'litigation', 'counsel', 'deadline', 'risk',
  ],
  'clinical-clear-readout': [
    'clinical', 'trial', 'study', 'patient', 'cohort', 'endpoint', 'safety', 'adverse', 'regulatory',
    'protocol', 'medical', 'healthcare', 'submit',
  ],
  'town-hall-operating-update': [
    'all hands', 'town hall', 'company', 'employee', 'operating', 'scoreboard', 'strategy', 'commitment',
    'culture', 'principles', 'questions', 'team',
  ],
  'event-sponsor-signal': [
    'event', 'sponsor', 'sponsorship', 'audience', 'activation', 'package', 'booth', 'leads',
    'reach', 'nps', 'roi', 'attendee', 'renewal',
  ],
};

function collectSlideSearchText(slides: Slide[]): string {
  return slides
    .flatMap((slide) => [
      slide.title || '',
      slide.notes || '',
      ...slide.elements.map((element) => element.text || ''),
    ])
    .join(' ')
    .toLowerCase();
}

export function scorePptxDesignPresetPack(preset: PptxDesignPresetPack, slides: Slide[]): number {
  const searchText = collectSlideSearchText(slides);
  if (!searchText.trim()) return 0;

  const keywords = PRESET_SIGNAL_KEYWORDS[preset.id] || [];
  const keywordScore = keywords.reduce((score, keyword) => {
    const matches = searchText.match(new RegExp(`\\b${keyword}\\b`, 'g'));
    return score + (matches ? Math.min(matches.length, 3) : 0);
  }, 0);

  const categoryScore = searchText.includes(preset.category.toLowerCase()) ? 2 : 0;
  const templateScore = searchText.includes(preset.templateId.replace(/-/g, ' ')) ? 3 : 0;
  return keywordScore + categoryScore + templateScore;
}

export function recommendPptxDesignPresetPacks(slides: Slide[], limit = 3): PptxDesignPresetRecommendation[] {
  const ranked = PPTX_DESIGN_PRESET_PACKS
    .map((preset, idx) => ({
      preset,
      score: scorePptxDesignPresetPack(preset, slides),
      idx,
    }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));

  const fallbackReason = 'general business deck starter';
  return ranked.slice(0, Math.max(1, limit)).map(({ preset, score }) => {
    const reason = score > 0
      ? `${preset.category.toLowerCase()} signals matched`
      : fallbackReason;
    return { preset, score, reason };
  });
}

export function getPptxDeckTemplate(templateId: string): PptxDeckTemplate {
  return PPTX_DECK_TEMPLATES.find((template) => template.id === templateId) || PPTX_DECK_TEMPLATES[0];
}

export function getPptxDesignPresetPack(presetId: string): PptxDesignPresetPack {
  return PPTX_DESIGN_PRESET_PACKS.find((preset) => preset.id === presetId) || PPTX_DESIGN_PRESET_PACKS[0];
}

export function buildPptxDeckTemplate(templateId: string, theme: PptxDesignTheme): Slide[] {
  const template = getPptxDeckTemplate(templateId);
  const slides = template.slides.map((slide) => ({
    id: uid(),
    title: slide.title,
    bgColor: theme.bgColor,
    notes: slide.notes || '',
    hidden: false,
    transition: { type: 'fade' as const, durationMs: 450, advanceAfterSec: 0 },
    elements: slide.elements(theme),
  }));
  return applyDesignThemeToSlides(slides, theme);
}

export function buildPptxDesignPresetDeck(presetId: string): Slide[] {
  const preset = getPptxDesignPresetPack(presetId);
  return buildPptxDeckTemplate(preset.templateId, getPptxDesignTheme(preset.themeId));
}
