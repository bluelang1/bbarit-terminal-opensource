export interface DocxDesignTheme {
  id: string;
  label: string;
  description: string;
  fontFamily: string;
  textColor: string;
  headingColor: string;
  accentColor: string;
  surfaceColor: string;
  pageColor: string;
}

export interface DocxTemplate {
  id: string;
  label: string;
  description: string;
  html: string;
}

export interface DocxDesignPresetPack {
  id: string;
  label: string;
  category: string;
  description: string;
  themeId: string;
  templateId: string;
}

export interface DocxDesignPresetRecommendation {
  preset: DocxDesignPresetPack;
  score: number;
  reason: string;
}

export interface DocxQualityIssue {
  severity: 'info' | 'warning' | 'success';
  message: string;
}

export interface DocxQualityReport {
  score: number;
  words: number;
  chars: number;
  paragraphs: number;
  headings: number;
  tables: number;
  lists: number;
  links: number;
  readingMinutes: number;
  issues: DocxQualityIssue[];
}

export interface DocxOutlineItem {
  level: number;
  text: string;
}

export interface DocxActionItem {
  action: string;
  owner: string;
  due: string;
  source: string;
}

export interface DocxBrief {
  summary: string;
  outline: DocxOutlineItem[];
  actions: DocxActionItem[];
  report: DocxQualityReport;
}

export interface DocxRiskSignal {
  category: string;
  signal: string;
  recommendation: string;
  severity: 'info' | 'warning';
}

export interface DocxEvidenceSignal {
  claim: string;
  evidenceNeed: string;
  recommendedSource: string;
  severity: 'info' | 'warning';
}

export interface DocxCleanupReport {
  removedEmptyParagraphs: number;
  splitParagraphs: number;
  addedTitle: boolean;
  addedDecisionControls: boolean;
  scoreBefore: number;
  scoreAfter: number;
}

export interface DocxRedlineSuggestion {
  original: string;
  suggestion: string;
  reason: string;
  severity: 'info' | 'warning';
}

export interface DocxStrategyPack {
  objective: string;
  audience: string;
  coreMessage: string;
  recommendedPreset: DocxDesignPresetRecommendation;
  report: DocxQualityReport;
}

export interface DocxNegotiationIssue {
  issue: string;
  leverage: string;
  preferredPosition: string;
  fallbackPosition: string;
  owner: string;
  severity: 'info' | 'warning';
}

export interface DocxNegotiationPack {
  posture: string;
  issues: DocxNegotiationIssue[];
  report: DocxQualityReport;
}

export const DOCX_DESIGN_THEMES: DocxDesignTheme[] = [
  {
    id: 'executive-memo',
    label: 'Executive Memo',
    description: 'Crisp business writing with strong headings and compact tables.',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    textColor: '#111827',
    headingColor: '#0f172a',
    accentColor: '#2563eb',
    surfaceColor: '#dbeafe',
    pageColor: '#ffffff',
  },
  {
    id: 'research-paper',
    label: 'Research Paper',
    description: 'Readable serif document styling for long-form analysis.',
    fontFamily: 'Georgia, "Times New Roman", serif',
    textColor: '#1f2937',
    headingColor: '#312e81',
    accentColor: '#7c3aed',
    surfaceColor: '#ede9fe',
    pageColor: '#fffefc',
  },
  {
    id: 'proposal-modern',
    label: 'Proposal Modern',
    description: 'Modern proposal formatting with teal accents and callouts.',
    fontFamily: '"Nanum Gothic", system-ui, sans-serif',
    textColor: '#10201c',
    headingColor: '#064e3b',
    accentColor: '#0d9488',
    surfaceColor: '#ccfbf1',
    pageColor: '#f8fffd',
  },
  {
    id: 'legal-brief',
    label: 'Legal Brief',
    description: 'Dense monochrome structure for review-ready documents.',
    fontFamily: '"Times New Roman", Georgia, serif',
    textColor: '#171717',
    headingColor: '#171717',
    accentColor: '#525252',
    surfaceColor: '#e5e5e5',
    pageColor: '#ffffff',
  },
  {
    id: 'product-spec',
    label: 'Product Spec',
    description: 'Clear product requirements styling with blue callouts and scannable tables.',
    fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    textColor: '#172554',
    headingColor: '#1d4ed8',
    accentColor: '#3b82f6',
    surfaceColor: '#dbeafe',
    pageColor: '#f8fbff',
  },
  {
    id: 'editorial-release',
    label: 'Editorial Release',
    description: 'Polished press and announcement writing with warm editorial contrast.',
    fontFamily: 'Georgia, "Times New Roman", serif',
    textColor: '#292524',
    headingColor: '#7f1d1d',
    accentColor: '#dc2626',
    surfaceColor: '#fee2e2',
    pageColor: '#fff7ed',
  },
  {
    id: 'boardroom-paper',
    label: 'Boardroom Paper',
    description: 'Board-ready paper styling with restrained navy headings and decision callouts.',
    fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    textColor: '#111827',
    headingColor: '#0f2a44',
    accentColor: '#1e40af',
    surfaceColor: '#e0ecff',
    pageColor: '#fbfdff',
  },
  {
    id: 'compliance-manual',
    label: 'Compliance Manual',
    description: 'Controlled-document styling for SOPs, policies, and audit-ready process manuals.',
    fontFamily: '"Nanum Gothic", system-ui, sans-serif',
    textColor: '#1f2937',
    headingColor: '#14532d',
    accentColor: '#16a34a',
    surfaceColor: '#dcfce7',
    pageColor: '#fbfffc',
  },
  {
    id: 'customer-story',
    label: 'Customer Story',
    description: 'Narrative case-study styling with sharp proof blocks and customer outcome emphasis.',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    textColor: '#27272a',
    headingColor: '#6d28d9',
    accentColor: '#a855f7',
    surfaceColor: '#f3e8ff',
    pageColor: '#fefbff',
  },
];

export const DOCX_TEMPLATES: DocxTemplate[] = [
  {
    id: 'business-proposal',
    label: 'Business Proposal',
    description: 'Cover, executive summary, scope, timeline, and budget table.',
    html: [
      '<h1>Business Proposal</h1>',
      '<p><strong>Prepared for:</strong> Client / Team</p>',
      '<p><strong>Date:</strong> Today</p>',
      '<h2>Executive Summary</h2>',
      '<p>Summarize the opportunity, recommended direction, and expected outcome.</p>',
      '<h2>Scope</h2>',
      '<ul><li>Primary deliverable</li><li>Key constraint</li><li>Success metric</li></ul>',
      '<h2>Timeline</h2>',
      '<table><tbody><tr><th>Phase</th><th>Owner</th><th>Target</th></tr><tr><td>Discovery</td><td>Team</td><td>Week 1</td></tr><tr><td>Delivery</td><td>Team</td><td>Week 2</td></tr></tbody></table>',
      '<blockquote>Decision needed: approve the recommended path or request a revised scope.</blockquote>',
    ].join(''),
  },
  {
    id: 'meeting-brief',
    label: 'Meeting Brief',
    description: 'Agenda, decisions, action items, and follow-up notes.',
    html: [
      '<h1>Meeting Brief</h1>',
      '<p><strong>Topic:</strong> Project Review</p>',
      '<p><strong>Attendees:</strong> Name, Name, Name</p>',
      '<h2>Agenda</h2>',
      '<ol><li>Context</li><li>Discussion</li><li>Decision</li></ol>',
      '<h2>Decisions</h2>',
      '<ul><li>Decision one</li><li>Decision two</li></ul>',
      '<h2>Action Items</h2>',
      '<table><tbody><tr><th>Action</th><th>Owner</th><th>Due</th></tr><tr><td>Next step</td><td>Name</td><td>Date</td></tr></tbody></table>',
    ].join(''),
  },
  {
    id: 'technical-report',
    label: 'Technical Report',
    description: 'Problem statement, architecture, validation, and risks.',
    html: [
      '<h1>Technical Report</h1>',
      '<h2>Problem Statement</h2>',
      '<p>Describe the technical problem, user impact, and constraints.</p>',
      '<h2>Architecture</h2>',
      '<p>Outline the system design and core tradeoffs.</p>',
      '<h2>Validation</h2>',
      '<table><tbody><tr><th>Check</th><th>Result</th><th>Evidence</th></tr><tr><td>Build</td><td>Pass</td><td>Command output</td></tr></tbody></table>',
      '<h2>Risks</h2>',
      '<ul><li>Operational risk</li><li>Compatibility risk</li><li>Follow-up item</li></ul>',
    ].join(''),
  },
  {
    id: 'one-page-brief',
    label: 'One-page Brief',
    description: 'Sharp single-page decision memo.',
    html: [
      '<h1>One-page Brief</h1>',
      '<p><strong>Ask:</strong> State the decision clearly.</p>',
      '<h2>Why Now</h2>',
      '<p>Explain urgency and expected impact.</p>',
      '<h2>Options</h2>',
      '<table><tbody><tr><th>Option</th><th>Pros</th><th>Tradeoffs</th></tr><tr><td>A</td><td>Fast</td><td>Limited scope</td></tr><tr><td>B</td><td>Complete</td><td>More time</td></tr></tbody></table>',
      '<h2>Recommendation</h2>',
      '<blockquote>Recommend one path and name the next concrete action.</blockquote>',
    ].join(''),
  },
  {
    id: 'product-requirements',
    label: 'Product Requirements',
    description: 'PRD with goals, personas, user stories, acceptance criteria, and launch risks.',
    html: [
      '<h1>Product Requirements Document</h1>',
      '<p><strong>Owner:</strong> Product / Design / Engineering</p>',
      '<p><strong>Status:</strong> Draft · Review · Approved</p>',
      '<h2>Objective</h2>',
      '<p>State the customer problem, desired outcome, and measurable business result.</p>',
      '<h2>Users & Jobs</h2>',
      '<table><tbody><tr><th>Persona</th><th>Job to be done</th><th>Pain</th></tr><tr><td>Primary user</td><td>Complete workflow faster</td><td>Too many manual steps</td></tr></tbody></table>',
      '<h2>Requirements</h2>',
      '<table><tbody><tr><th>ID</th><th>Requirement</th><th>Priority</th><th>Acceptance Criteria</th></tr><tr><td>R1</td><td>Core workflow</td><td>P0</td><td>User can complete task end to end</td></tr><tr><td>R2</td><td>Reporting</td><td>P1</td><td>Export includes expected fields</td></tr></tbody></table>',
      '<h2>Risks & Open Questions</h2>',
      '<ul><li>Technical dependency</li><li>Data migration question</li><li>Launch readiness item</li></ul>',
    ].join(''),
  },
  {
    id: 'project-plan',
    label: 'Project Plan',
    description: 'Execution plan with milestones, dependencies, RACI, and status reporting.',
    html: [
      '<h1>Project Plan</h1>',
      '<p><strong>Project:</strong> Name</p>',
      '<p><strong>Timeframe:</strong> Start - End</p>',
      '<h2>Milestones</h2>',
      '<table><tbody><tr><th>Milestone</th><th>Owner</th><th>Date</th><th>Status</th></tr><tr><td>Kickoff</td><td>Lead</td><td>Week 1</td><td>Planned</td></tr><tr><td>Beta</td><td>Team</td><td>Week 4</td><td>At risk</td></tr></tbody></table>',
      '<h2>Dependencies</h2>',
      '<ul><li>Design approval</li><li>Backend API readiness</li><li>Go-to-market calendar</li></ul>',
      '<h2>RACI</h2>',
      '<table><tbody><tr><th>Area</th><th>Responsible</th><th>Accountable</th><th>Consulted</th></tr><tr><td>Delivery</td><td>Engineering</td><td>PM</td><td>Design</td></tr></tbody></table>',
    ].join(''),
  },
  {
    id: 'press-release',
    label: 'Press Release',
    description: 'Launch announcement with headline, boilerplate, quote, and media notes.',
    html: [
      '<h1>Press Release Headline</h1>',
      '<p><strong>City, Date:</strong> Announcement lead paragraph with the most newsworthy point.</p>',
      '<h2>Why It Matters</h2>',
      '<p>Explain the market context, user benefit, and company momentum.</p>',
      '<blockquote>"Customer or executive quote that makes the announcement feel concrete."</blockquote>',
      '<h2>Availability</h2>',
      '<p>State pricing, launch date, geography, and how customers can get started.</p>',
      '<h2>About</h2>',
      '<p>Short company boilerplate and media contact.</p>',
    ].join(''),
  },
  {
    id: 'contract-review',
    label: 'Contract Review',
    description: 'Structured contract review memo with issues, clauses, and negotiation posture.',
    html: [
      '<h1>Contract Review Memo</h1>',
      '<p><strong>Agreement:</strong> Name / Counterparty</p>',
      '<p><strong>Reviewer:</strong> Legal / Business Owner</p>',
      '<h2>Executive View</h2>',
      '<p>Summarize the deal posture, material risks, and recommended response.</p>',
      '<h2>Issue List</h2>',
      '<table><tbody><tr><th>Clause</th><th>Issue</th><th>Risk</th><th>Position</th></tr><tr><td>Liability</td><td>Cap too high</td><td>High</td><td>Negotiate cap</td></tr><tr><td>Termination</td><td>Notice period unclear</td><td>Medium</td><td>Clarify language</td></tr></tbody></table>',
      '<h2>Fallbacks</h2>',
      '<ul><li>Preferred position</li><li>Acceptable compromise</li><li>Walk-away condition</li></ul>',
    ].join(''),
  },
  {
    id: 'board-decision-pack',
    label: 'Board Decision Pack',
    description: 'Board paper with decision request, context, options, recommendation, risks, and approval log.',
    html: [
      '<h1>Board Decision Pack</h1>',
      '<p><strong>Decision requested:</strong> Approve, reject, or request revised plan.</p>',
      '<p><strong>Prepared by:</strong> Executive owner · <strong>Meeting:</strong> Board / Steering Committee</p>',
      '<h2>Executive Recommendation</h2>',
      '<blockquote>Recommend one decision, why it matters now, and the consequence of delay.</blockquote>',
      '<h2>Context</h2>',
      '<p>Summarize the operating context, trigger event, customer or financial impact, and constraints.</p>',
      '<h2>Options</h2>',
      '<table><tbody><tr><th>Option</th><th>Upside</th><th>Tradeoff</th><th>Decision Rule</th></tr><tr><td>Approve</td><td>Accelerates target outcome</td><td>Uses budget now</td><td>Evidence threshold met</td></tr><tr><td>Defer</td><td>Reduces near-term risk</td><td>Delays benefit</td><td>Missing key evidence</td></tr></tbody></table>',
      '<h2>Risks & Mitigations</h2>',
      '<table><tbody><tr><th>Risk</th><th>Severity</th><th>Mitigation</th><th>Owner</th></tr><tr><td>Execution dependency</td><td>Medium</td><td>Weekly checkpoint</td><td>COO</td></tr></tbody></table>',
      '<h2>Approval Log</h2>',
      '<table><tbody><tr><th>Approver</th><th>Decision</th><th>Conditions</th><th>Date</th></tr><tr><td>Name</td><td>Pending</td><td>None</td><td>Date</td></tr></tbody></table>',
    ].join(''),
  },
  {
    id: 'policy-sop-manual',
    label: 'Policy SOP Manual',
    description: 'Controlled SOP document with policy, scope, procedure, controls, exceptions, and audit trail.',
    html: [
      '<h1>Policy & SOP Manual</h1>',
      '<p><strong>Document owner:</strong> Function / Team</p>',
      '<p><strong>Version:</strong> 1.0 · <strong>Status:</strong> Draft / Approved / Retired</p>',
      '<h2>Policy Statement</h2>',
      '<p>State the required standard, business reason, and compliance expectation.</p>',
      '<h2>Scope</h2>',
      '<ul><li>Included teams, systems, processes, and regions</li><li>Excluded or exception cases</li></ul>',
      '<h2>Roles & Responsibilities</h2>',
      '<table><tbody><tr><th>Role</th><th>Responsibility</th><th>Escalation</th></tr><tr><td>Owner</td><td>Maintain procedure</td><td>Executive sponsor</td></tr><tr><td>Operator</td><td>Follow steps</td><td>Process owner</td></tr></tbody></table>',
      '<h2>Procedure</h2>',
      '<ol><li>Trigger and intake</li><li>Review required inputs</li><li>Execute approved steps</li><li>Record outcome and evidence</li></ol>',
      '<h2>Controls & Audit Trail</h2>',
      '<table><tbody><tr><th>Control</th><th>Frequency</th><th>Evidence</th><th>Reviewer</th></tr><tr><td>Access review</td><td>Monthly</td><td>Exported log</td><td>Manager</td></tr></tbody></table>',
    ].join(''),
  },
  {
    id: 'customer-case-study',
    label: 'Customer Case Study',
    description: 'Customer story with challenge, solution, outcomes, proof assets, quote, and next-use narrative.',
    html: [
      '<h1>Customer Case Study</h1>',
      '<p><strong>Customer:</strong> Company / Segment</p>',
      '<p><strong>Outcome:</strong> Measurable result and timeframe</p>',
      '<h2>Snapshot</h2>',
      '<table><tbody><tr><th>Industry</th><th>Use Case</th><th>Team</th><th>Primary Metric</th></tr><tr><td>Industry</td><td>Workflow</td><td>Team</td><td>+42%</td></tr></tbody></table>',
      '<h2>Challenge</h2>',
      '<p>Describe the operational pain, decision pressure, and why existing approaches were not enough.</p>',
      '<h2>Solution</h2>',
      '<p>Explain the implementation path, workflow change, stakeholder roles, and adoption motion.</p>',
      '<h2>Results</h2>',
      '<table><tbody><tr><th>Metric</th><th>Before</th><th>After</th><th>Impact</th></tr><tr><td>Cycle time</td><td>10 days</td><td>4 days</td><td>-60%</td></tr><tr><td>Quality</td><td>78%</td><td>94%</td><td>+16 pts</td></tr></tbody></table>',
      '<blockquote>"Customer quote that ties the product to a real business outcome."</blockquote>',
      '<h2>Proof Assets</h2>',
      '<ul><li>Screenshot or workflow evidence</li><li>Metric source</li><li>Customer approval status</li></ul>',
    ].join(''),
  },
];

export const DOCX_DESIGN_PRESET_PACKS: DocxDesignPresetPack[] = [
  {
    id: 'executive-decision-memo',
    label: 'Executive Decision Memo',
    category: 'Executive',
    description: 'One-page decision memo with the Executive Memo theme.',
    themeId: 'executive-memo',
    templateId: 'one-page-brief',
  },
  {
    id: 'modern-business-proposal',
    label: 'Modern Business Proposal',
    category: 'Proposal',
    description: 'Client proposal structure with modern teal proposal styling.',
    themeId: 'proposal-modern',
    templateId: 'business-proposal',
  },
  {
    id: 'research-analysis-paper',
    label: 'Research Analysis Paper',
    category: 'Research',
    description: 'Long-form technical or research report with readable serif styling.',
    themeId: 'research-paper',
    templateId: 'technical-report',
  },
  {
    id: 'product-prd-blueprint',
    label: 'Product PRD Blueprint',
    category: 'Product',
    description: 'Product requirements document with scannable product-spec styling.',
    themeId: 'product-spec',
    templateId: 'product-requirements',
  },
  {
    id: 'launch-press-release',
    label: 'Launch Press Release',
    category: 'Editorial',
    description: 'Press release template with warm editorial release styling.',
    themeId: 'editorial-release',
    templateId: 'press-release',
  },
  {
    id: 'legal-contract-review',
    label: 'Legal Contract Review',
    category: 'Legal',
    description: 'Contract review memo with dense legal brief styling.',
    themeId: 'legal-brief',
    templateId: 'contract-review',
  },
  {
    id: 'project-execution-plan',
    label: 'Project Execution Plan',
    category: 'Operations',
    description: 'Project plan with milestones, dependencies, and RACI controls.',
    themeId: 'executive-memo',
    templateId: 'project-plan',
  },
  {
    id: 'meeting-action-brief',
    label: 'Meeting Action Brief',
    category: 'Meeting',
    description: 'Meeting brief with agenda, decisions, and action tracking.',
    themeId: 'proposal-modern',
    templateId: 'meeting-brief',
  },
  {
    id: 'board-decision-paper',
    label: 'Board Decision Paper',
    category: 'Executive',
    description: 'Board Decision Pack with boardroom paper styling for approval-ready governance memos.',
    themeId: 'boardroom-paper',
    templateId: 'board-decision-pack',
  },
  {
    id: 'compliance-sop-manual',
    label: 'Compliance SOP Manual',
    category: 'Operations',
    description: 'Policy SOP Manual with controlled compliance styling for audit-ready procedures.',
    themeId: 'compliance-manual',
    templateId: 'policy-sop-manual',
  },
  {
    id: 'customer-proof-story',
    label: 'Customer Proof Story',
    category: 'Customer',
    description: 'Customer Case Study with proof-led storytelling and outcome blocks.',
    themeId: 'customer-story',
    templateId: 'customer-case-study',
  },
];

export function getDocxDesignTheme(themeId: string): DocxDesignTheme {
  return DOCX_DESIGN_THEMES.find((theme) => theme.id === themeId) || DOCX_DESIGN_THEMES[0];
}

export function getDocxTemplate(templateId: string): DocxTemplate {
  return DOCX_TEMPLATES.find((template) => template.id === templateId) || DOCX_TEMPLATES[0];
}

export function getDocxDesignPresetPack(presetId: string): DocxDesignPresetPack {
  return DOCX_DESIGN_PRESET_PACKS.find((preset) => preset.id === presetId) || DOCX_DESIGN_PRESET_PACKS[0];
}

export function buildDocxDesignPresetHtml(presetId: string): string {
  const preset = getDocxDesignPresetPack(presetId);
  return buildDocxTemplateHtml(preset.templateId, preset.themeId);
}

function appendStyle(attrs: string | undefined, style: string): string {
  const value = attrs || '';
  const styleMatch = value.match(/\sstyle=(["'])(.*?)\1/i);
  if (!styleMatch) return `${value} style="${style}"`;
  const quote = styleMatch[1];
  // Drop existing declarations the incoming theme style overrides, so repeated
  // Apply/Polish passes replace rather than endlessly stack duplicate rules.
  const incomingProps = new Set(
    style.split(';').map((d) => d.split(':')[0].trim().toLowerCase()).filter(Boolean),
  );
  const kept = styleMatch[2].split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => !incomingProps.has(d.split(':')[0].trim().toLowerCase()))
    .join('; ');
  const merged = kept ? `${kept.replace(/;?$/, ';')} ${style}` : style;
  return value.replace(styleMatch[0], ` style=${quote}${merged}${quote}`);
}

function styleTags(html: string, tagName: string, style: string): string {
  const pattern = new RegExp(`<${tagName}(\\s[^>]*)?>`, 'gi');
  return html.replace(pattern, (_match, attrs) => `<${tagName}${appendStyle(attrs, style)}>`);
}

export function applyDocxThemeToHtml(html: string, theme: DocxDesignTheme): string {
  const source = html.trim() || '<p></p>';
  const heading = `color:${theme.headingColor};font-family:${theme.fontFamily};`;
  const body = `color:${theme.textColor};font-family:${theme.fontFamily};`;
  const table = `border-collapse:collapse;border:1px solid ${theme.accentColor};`;
  const cell = `border:1px solid ${theme.accentColor};padding:7px 10px;`;
  const quote = `border-left:4px solid ${theme.accentColor};background:${theme.surfaceColor};padding:10px 14px;`;

  return ['h1', 'h2', 'h3'].reduce((acc, tag) => styleTags(acc, tag, heading), source)
    .replace(/<p(\s[^>]*)?>/gi, (_match, attrs) => `<p${appendStyle(attrs, body)}>`)
    .replace(/<table(\s[^>]*)?>/gi, (_match, attrs) => `<table${appendStyle(attrs, table)}>`)
    .replace(/<(td|th)(\s[^>]*)?>/gi, (_match, tag, attrs) => `<${tag}${appendStyle(attrs, cell)}>`)
    .replace(/<blockquote(\s[^>]*)?>/gi, (_match, attrs) => `<blockquote${appendStyle(attrs, quote)}>`);
}

export function buildDocxTemplateHtml(templateId: string, themeId = DOCX_DESIGN_THEMES[0].id): string {
  return applyDocxThemeToHtml(getDocxTemplate(templateId).html, getDocxDesignTheme(themeId));
}

const DOCX_PRESET_SIGNAL_KEYWORDS: Record<string, string[]> = {
  'executive-decision-memo': [
    'decision', 'approve', 'approval', 'executive', 'recommendation', 'option', 'tradeoff', 'risk', 'owner',
    '결정', '승인', '추천',
  ],
  'modern-business-proposal': [
    'proposal', 'scope', 'client', 'budget', 'timeline', 'deliverable', 'pricing', 'phase', 'contract',
    '제안', '범위', '예산',
  ],
  'research-analysis-paper': [
    'research', 'analysis', 'evidence', 'method', 'validation', 'architecture', 'technical', 'experiment',
    'study', '분석', '검증',
  ],
  'product-prd-blueprint': [
    'product', 'requirement', 'prd', 'persona', 'user story', 'acceptance criteria', 'launch', 'feature',
    '제품', '요구사항',
  ],
  'launch-press-release': [
    'press', 'release', 'announcement', 'launch', 'media', 'quote', 'availability', 'headline', 'market',
    '보도자료', '출시',
  ],
  'legal-contract-review': [
    'contract', 'clause', 'liability', 'termination', 'indemnity', 'privacy', 'compliance', 'legal',
    'agreement', '계약', '법무',
  ],
  'project-execution-plan': [
    'project', 'milestone', 'dependency', 'raci', 'status', 'delivery', 'owner', 'deadline', 'timeline',
    '프로젝트', '일정',
  ],
  'meeting-action-brief': [
    'meeting', 'agenda', 'attendee', 'decision', 'action item', 'follow-up', 'minutes', 'owner', 'due',
    '회의', '액션',
  ],
  'board-decision-paper': [
    'board', 'decision', 'approval', 'approver', 'governance', 'recommendation', 'mitigation', 'option',
    'steering committee', 'decision rule', '이사회', '승인',
  ],
  'compliance-sop-manual': [
    'policy', 'sop', 'procedure', 'compliance', 'control', 'audit', 'exception', 'version', 'standard',
    'responsibility', '정책', '감사',
  ],
  'customer-proof-story': [
    'customer', 'case study', 'challenge', 'solution', 'results', 'proof', 'quote', 'outcome', 'metric',
    'adoption', '고객', '사례',
  ],
};

export function scoreDocxDesignPresetPack(preset: DocxDesignPresetPack, html: string): number {
  const searchText = stripTags(html).toLowerCase();
  if (!searchText.trim()) return 0;
  const keywords = DOCX_PRESET_SIGNAL_KEYWORDS[preset.id] || [];
  const keywordScore = keywords.reduce((score, keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = searchText.match(new RegExp(`\\b${escaped}\\b`, 'gi'));
    return score + (matches ? Math.min(matches.length, 3) : 0);
  }, 0);
  const categoryScore = searchText.includes(preset.category.toLowerCase()) ? 2 : 0;
  const templateScore = searchText.includes(getDocxTemplate(preset.templateId).label.toLowerCase()) ? 3 : 0;
  return keywordScore + categoryScore + templateScore;
}

export function recommendDocxDesignPresetPacks(html: string, limit = 3): DocxDesignPresetRecommendation[] {
  const ranked = DOCX_DESIGN_PRESET_PACKS
    .map((preset, idx) => ({ preset, score: scoreDocxDesignPresetPack(preset, html), idx }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  return ranked.slice(0, Math.max(1, limit)).map(({ preset, score }) => ({
    preset,
    score,
    reason: score > 0 ? `${preset.category.toLowerCase()} signals matched` : 'general document starter',
  }));
}

function stripTags(html: string): string {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(html: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const text = stripTags(match[1]);
    if (text) out.push(text);
  }
  return out;
}

function normalizeText(value: string): string {
  return stripTags(value).replace(/\s+/g, ' ').trim();
}

function sentenceSummary(text: string, maxWords = 28): string {
  const firstSentence = text.split(/(?<=[.!?])\s+/).find((part) => part.trim()) || text;
  const words = firstSentence.trim().split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? firstSentence.trim() : `${words.slice(0, maxWords).join(' ')}...`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function removeDocxAssistantSections(html: string, keys: string[]): string {
  return keys.reduce((acc, key) => {
    const pattern = new RegExp(`<section\\b[^>]*data-docx-${key}=["']true["'][\\s\\S]*?<\\/section>`, 'gi');
    return acc.replace(pattern, '');
  }, String(html || ''));
}

function removeAllDocxAssistantSections(html: string): string {
  return removeDocxAssistantSections(html, ['brief', 'toc', 'actions', 'quality', 'polish', 'review-pack', 'clean', 'approval-pack', 'citation-pack', 'redline-pack', 'strategy-pack', 'negotiation-pack']);
}

export function extractDocxOutline(html: string): DocxOutlineItem[] {
  const source = removeAllDocxAssistantSections(html);
  const pattern = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const outline: DocxOutlineItem[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const text = normalizeText(match[2]);
    if (text) outline.push({ level: Number(match[1]), text });
  }
  return outline;
}

export function extractDocxActionItems(html: string): DocxActionItem[] {
  const source = removeAllDocxAssistantSections(html);
  const actions: DocxActionItem[] = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  let headers: string[] = [];
  while ((rowMatch = rowPattern.exec(source))) {
    const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => normalizeText(cell[1]));
    if (!cells.length) continue;
    const lower = cells.map((cell) => cell.toLowerCase());
    const looksLikeHeader = lower.some((cell) => /action|task|owner|due|status|risk|issue/.test(cell));
    if (looksLikeHeader && headers.length === 0) {
      headers = lower;
      continue;
    }
    const actionIdx = headers.findIndex((header) => /action|task|issue|requirement|milestone/.test(header));
    const ownerIdx = headers.findIndex((header) => /owner|responsible|accountable/.test(header));
    const dueIdx = headers.findIndex((header) => /due|date|target|timeline/.test(header));
    if (headers.length && (actionIdx >= 0 || ownerIdx >= 0 || dueIdx >= 0)) {
      const action = cells[actionIdx >= 0 ? actionIdx : 0] || '';
      if (action && !/^action|task|issue|requirement$/i.test(action)) {
        actions.push({
          action,
          owner: ownerIdx >= 0 ? cells[ownerIdx] || 'Unassigned' : 'Unassigned',
          due: dueIdx >= 0 ? cells[dueIdx] || 'TBD' : 'TBD',
          source: 'table',
        });
      }
    }
  }

  const listItems = [...source.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => normalizeText(match[1]))
    .filter((text) => /action|todo|next|owner|due|follow[- ]?up|must|should|risk|decision/i.test(text));
  listItems.forEach((item) => {
    actions.push({ action: item, owner: 'Unassigned', due: 'TBD', source: 'list' });
  });

  return actions.slice(0, 12);
}

export function buildDocxTableOfContentsHtml(html: string): string {
  const outline = extractDocxOutline(html);
  const rows = outline.map((item) => (
    `<li style="margin-left:${Math.max(0, item.level - 1) * 18}px"><strong>H${item.level}</strong> ${escapeHtml(item.text)}</li>`
  )).join('');
  return [
    '<section data-docx-toc="true">',
    '<h2>Document Map</h2>',
    outline.length
      ? `<ol>${rows}</ol>`
      : '<p><em>No headings found. Add H1/H2 sections to generate a useful map.</em></p>',
    '</section>',
  ].join('');
}

export function buildDocxActionPlanHtml(html: string): string {
  const actions = extractDocxActionItems(html);
  const rows = actions.map((item, idx) => (
    `<tr><td>${idx + 1}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.due)}</td><td>${escapeHtml(item.source)}</td></tr>`
  )).join('');
  return [
    '<section data-docx-actions="true">',
    '<h2>Action Plan</h2>',
    '<table><tbody><tr><th>#</th><th>Action</th><th>Owner</th><th>Due</th><th>Source</th></tr>',
    rows || '<tr><td>1</td><td>No explicit action items found. Add owners, due dates, or next steps.</td><td>Unassigned</td><td>TBD</td><td>scan</td></tr>',
    '</tbody></table>',
    '</section>',
  ].join('');
}

export function buildDocxBrief(html: string): DocxBrief {
  const clean = removeDocxAssistantSections(html, ['brief', 'toc', 'actions', 'quality', 'review-pack']);
  const text = stripTags(clean);
  return {
    summary: sentenceSummary(text, 34) || 'No summary available.',
    outline: extractDocxOutline(clean),
    actions: extractDocxActionItems(clean),
    report: analyzeDocxHtml(clean),
  };
}

export function buildDocxBriefPanelHtml(html: string): string {
  const brief = buildDocxBrief(html);
  const outlineText = brief.outline.slice(0, 5).map((item) => `H${item.level} ${item.text}`).join(' · ') || 'No headings';
  const actionText = brief.actions.slice(0, 3).map((item) => item.action).join(' · ') || 'No explicit actions';
  return [
    '<section data-docx-brief="true">',
    '<h2>Document Intelligence Brief</h2>',
    `<blockquote><strong>Summary:</strong> ${escapeHtml(brief.summary)}</blockquote>`,
    '<table><tbody>',
    `<tr><th>Quality</th><td>${brief.report.score}/100 · ${brief.report.words} words · ${brief.report.readingMinutes} min read</td></tr>`,
    `<tr><th>Outline</th><td>${escapeHtml(outlineText)}</td></tr>`,
    `<tr><th>Actions</th><td>${escapeHtml(actionText)}</td></tr>`,
    '</tbody></table>',
    '</section>',
  ].join('');
}

export function extractDocxRiskSignals(html: string): DocxRiskSignal[] {
  const source = removeAllDocxAssistantSections(html);
  const text = stripTags(source);
  const signals: DocxRiskSignal[] = [];
  const add = (category: string, pattern: RegExp, signal: string, recommendation: string, severity: 'info' | 'warning' = 'warning') => {
    if (pattern.test(text)) signals.push({ category, signal, recommendation, severity });
  };

  add('Schedule', /\b(delay|deadline|timeline|milestone|slip|late|blocked|at risk|일정|마감|지연)\b/i, 'Schedule pressure appears in the document.', 'Add owner, target date, dependency, and fallback path.');
  add('Financial', /\b(budget|cost|pricing|revenue|margin|invoice|payment|forecast|예산|비용|매출)\b/i, 'Financial terms are present.', 'Clarify source numbers, assumptions, approval owner, and variance threshold.');
  add('Legal', /\b(contract|liability|termination|indemnity|compliance|privacy|license|legal|clause|계약|법무|개인정보)\b/i, 'Legal or compliance language is present.', 'Add reviewed clause, risk level, fallback position, and approval status.');
  add('Data', /\b(data|metric|kpi|dashboard|report|analytics|migration|quality|데이터|지표|분석)\b/i, 'Data or metric dependency is present.', 'Name the data source, freshness, validation check, and failure mode.');
  add('Ownership', /\b(owner|responsible|accountable|raci|stakeholder|approval|decision|담당|승인|결정)\b/i, 'Ownership or approval language is present.', 'Make the accountable person explicit and separate decision owner from contributors.', 'info');

  if (!/<table\b/i.test(source) && signals.length >= 2) {
    signals.push({
      category: 'Structure',
      signal: 'Multiple review dimensions appear without a structured table.',
      recommendation: 'Insert a risk or decision table so reviewers can scan status quickly.',
      severity: 'warning',
    });
  }

  if (!signals.length) {
    signals.push({
      category: 'Readiness',
      signal: 'No obvious business risk signals detected.',
      recommendation: 'Use Review+ again after adding decisions, owners, metrics, or launch constraints.',
      severity: 'info',
    });
  }

  return signals.slice(0, 8);
}

export function buildDocxReviewPackHtml(html: string): string {
  const clean = removeAllDocxAssistantSections(html);
  const report = analyzeDocxHtml(clean);
  const outline = extractDocxOutline(clean);
  const actions = extractDocxActionItems(clean);
  const risks = extractDocxRiskSignals(clean);
  const rows = risks.map((risk, idx) => {
    const bg = risk.severity === 'warning' ? '#fef3c7' : '#dbeafe';
    return `<tr><td>${idx + 1}</td><td>${escapeHtml(risk.category)}</td><td style="background:${bg}">${escapeHtml(risk.signal)}</td><td>${escapeHtml(risk.recommendation)}</td></tr>`;
  }).join('');
  const checklist = [
    report.headings > 0 ? 'Headings present' : 'Add a primary title and section headings',
    actions.length ? `${actions.length} action item${actions.length === 1 ? '' : 's'} detected` : 'Add owners and next actions',
    report.tables > 0 ? 'Structured table present' : 'Add a table for decisions, owners, risks, or metrics',
    outline.length >= 3 ? 'Outline is scannable' : 'Add more sections for review scanning',
  ];

  return [
    '<section data-docx-review-pack="true">',
    '<h2>Review Pack</h2>',
    `<blockquote><strong>Readiness:</strong> ${report.score}/100 · ${report.words} words · ${report.readingMinutes} min read</blockquote>`,
    '<h3>Risk Register</h3>',
    '<table><tbody><tr><th>#</th><th>Area</th><th>Signal</th><th>Reviewer Move</th></tr>',
    rows,
    '</tbody></table>',
    '<h3>Editorial Checklist</h3>',
    `<ul>${checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`,
    '<h3>Decision Snapshot</h3>',
    '<table><tbody>',
    `<tr><th>Outline</th><td>${escapeHtml(outline.slice(0, 5).map((item) => item.text).join(' · ') || 'No headings found')}</td></tr>`,
    `<tr><th>Actions</th><td>${escapeHtml(actions.slice(0, 5).map((item) => item.action).join(' · ') || 'No explicit actions found')}</td></tr>`,
    '</tbody></table>',
    '</section>',
  ].join('');
}

function approvalGateStatus(label: string, ready: boolean, detail: string): string {
  return `<tr><td>${escapeHtml(label)}</td><td>${ready ? 'Ready' : 'Needs work'}</td><td>${escapeHtml(detail)}</td></tr>`;
}

export function buildDocxApprovalPackHtml(html: string): string {
  const clean = removeAllDocxAssistantSections(html);
  const report = analyzeDocxHtml(clean);
  const actions = extractDocxActionItems(clean);
  const risks = extractDocxRiskSignals(clean);
  const outline = extractDocxOutline(clean);
  const text = stripTags(clean);
  const hasDecisionLanguage = /\b(approve|approval|decision|sign[- ]?off|owner|responsible|due|deadline|risk|launch|go live|승인|결정|담당|기한|위험)\b/i.test(text);
  const hasApprovalTable = /<table\b[\s\S]*?(owner|due|decision|status|approval|담당|기한|결정|상태|승인)[\s\S]*?<\/table>/i.test(clean);
  const warningRisks = risks.filter((risk) => risk.severity === 'warning');
  const gates = [
    approvalGateStatus('Decision', hasDecisionLanguage, hasDecisionLanguage ? 'Decision or approval language found.' : 'State the decision request explicitly.'),
    approvalGateStatus('Owner', actions.some((item) => item.owner !== 'Unassigned') || /owner|담당|responsible/i.test(text), 'Name the accountable approver and delivery owner.'),
    approvalGateStatus('Date', actions.some((item) => item.due !== 'TBD') || /due|deadline|friday|monday|q[1-4]|20\d{2}|기한|마감/i.test(text), 'Add a due date, review date, or launch window.'),
    approvalGateStatus('Structure', hasApprovalTable || report.tables > 0, hasApprovalTable ? 'Approval-oriented table present.' : 'Use a table for decision, owner, due date, and status.'),
    approvalGateStatus('Risk', warningRisks.length <= 1, warningRisks.length ? `${warningRisks.length} warning signal${warningRisks.length === 1 ? '' : 's'} need closure.` : 'No major warning signals detected.'),
  ];
  const signoffRows = [
    ['Executive Sponsor', 'TBD', 'Pending'],
    ['Delivery Owner', actions.find((item) => item.owner !== 'Unassigned')?.owner || 'TBD', 'Pending'],
    ['Risk Reviewer', warningRisks[0]?.category || 'TBD', warningRisks.length ? 'Review required' : 'Optional'],
    ['Decision Date', actions.find((item) => item.due !== 'TBD')?.due || 'TBD', 'Pending'],
  ].map(([role, owner, status]) => `<tr><td>${escapeHtml(role)}</td><td>${escapeHtml(owner)}</td><td>${escapeHtml(status)}</td></tr>`).join('');
  const decisionQueue = actions.slice(0, 5).map((item, idx) => (
    `<tr><td>${idx + 1}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.due)}</td></tr>`
  )).join('') || '<tr><td>1</td><td>Add the explicit approval request.</td><td>Unassigned</td><td>TBD</td></tr>';
  const approvalScore = Math.max(0, Math.min(100, report.score - warningRisks.length * 8 + (hasApprovalTable ? 8 : 0) + (actions.length ? 6 : 0)));

  return [
    '<section data-docx-approval-pack="true">',
    '<h2>Approval Pack</h2>',
    `<blockquote><strong>Approval readiness:</strong> ${approvalScore}/100 · ${outline[0]?.text ? escapeHtml(outline[0].text) : 'Untitled decision'}</blockquote>`,
    '<h3>Approval Gates</h3>',
    '<table><tbody><tr><th>Gate</th><th>Status</th><th>Reviewer Note</th></tr>',
    gates.join(''),
    '</tbody></table>',
    '<h3>Decision Queue</h3>',
    '<table><tbody><tr><th>#</th><th>Decision / Action</th><th>Owner</th><th>Due</th></tr>',
    decisionQueue,
    '</tbody></table>',
    '<h3>Sign-off Matrix</h3>',
    '<table><tbody><tr><th>Role</th><th>Owner</th><th>Status</th></tr>',
    signoffRows,
    '</tbody></table>',
    '</section>',
  ].join('');
}

function extractDocxLinks(html: string): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const hrefMatch = match[1].match(/\shref=(["'])(.*?)\1/i);
    const href = hrefMatch?.[2]?.trim() || '';
    if (!href) continue;
    links.push({ text: normalizeText(match[2]) || href, href });
  }
  return links.slice(0, 20);
}

export function extractDocxEvidenceSignals(html: string): DocxEvidenceSignal[] {
  const clean = removeAllDocxAssistantSections(html);
  const text = stripTags(clean);
  const sentences = text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const signals: DocxEvidenceSignal[] = [];
  const addSignal = (claim: string, evidenceNeed: string, recommendedSource: string, severity: 'info' | 'warning' = 'warning') => {
    if (!claim || signals.some((signal) => signal.claim === claim)) return;
    signals.push({ claim: sentenceSummary(claim, 24), evidenceNeed, recommendedSource, severity });
  };

  sentences.forEach((sentence) => {
    if (signals.length >= 10) return;
    if (/\b(\d+(?:\.\d+)?%|\$?\d+(?:,\d{3})+(?:\.\d+)?|\b\d+x\b|q[1-4]|20\d{2})\b/i.test(sentence)) {
      addSignal(sentence, 'Quantitative claim needs a source, date, and calculation note.', 'Metric export, dashboard screenshot, finance model, or data query.');
    } else if (/\b(best|largest|fastest|first|only|all|always|never|significant|material|critical|guarantee|must)\b/i.test(sentence)) {
      addSignal(sentence, 'Strong comparative or absolute claim needs supporting evidence.', 'Benchmark, customer quote, legal review, or approved policy.');
    } else if (/\b(contract|liability|compliance|privacy|security|budget|revenue|forecast|deadline|launch|risk)\b/i.test(sentence)) {
      addSignal(sentence, 'Business-critical claim needs owner validation.', 'Contract clause, risk log, launch plan, or accountable owner sign-off.');
    }
  });

  const links = extractDocxLinks(clean);
  links.forEach((link) => {
    if (signals.length >= 12) return;
    addSignal(`Linked reference: ${link.text}`, 'Confirm the link is authoritative, accessible, and current.', link.href, 'info');
  });

  if (!signals.length) {
    signals.push({
      claim: 'No high-risk claims detected.',
      evidenceNeed: 'Add Evidence+ again after inserting metrics, legal terms, deadlines, or external claims.',
      recommendedSource: 'Source register, owner notes, or review comments.',
      severity: 'info',
    });
  }

  return signals.slice(0, 12);
}

export function buildDocxCitationPackHtml(html: string): string {
  const clean = removeAllDocxAssistantSections(html);
  const evidence = extractDocxEvidenceSignals(clean);
  const links = extractDocxLinks(clean);
  const report = analyzeDocxHtml(clean);
  const warningCount = evidence.filter((item) => item.severity === 'warning').length;
  const evidenceScore = Math.max(0, Math.min(100, report.score - warningCount * 6 + Math.min(links.length, 5) * 3));
  const evidenceRows = evidence.map((item, idx) => {
    const bg = item.severity === 'warning' ? '#fef3c7' : '#dbeafe';
    return [
      '<tr>',
      `<td>${idx + 1}</td>`,
      `<td style="background:${bg}">${escapeHtml(item.claim)}</td>`,
      `<td>${escapeHtml(item.evidenceNeed)}</td>`,
      `<td>${escapeHtml(item.recommendedSource)}</td>`,
      '<td>Open</td>',
      '</tr>',
    ].join('');
  }).join('');
  const linkRows = links.map((link, idx) => (
    `<tr><td>${idx + 1}</td><td>${escapeHtml(link.text)}</td><td>${escapeHtml(link.href)}</td><td>Verify access and freshness</td></tr>`
  )).join('') || '<tr><td>1</td><td>No links found</td><td>Add source URLs or file references for major claims.</td><td>Open</td></tr>';

  return [
    '<section data-docx-citation-pack="true">',
    '<h2>Evidence Pack</h2>',
    `<blockquote><strong>Evidence readiness:</strong> ${evidenceScore}/100 · ${warningCount} claim${warningCount === 1 ? '' : 's'} need stronger support · ${links.length} link${links.length === 1 ? '' : 's'} detected</blockquote>`,
    '<h3>Claim Evidence Matrix</h3>',
    '<table><tbody><tr><th>#</th><th>Claim / Reference</th><th>Evidence Needed</th><th>Recommended Source</th><th>Status</th></tr>',
    evidenceRows,
    '</tbody></table>',
    '<h3>Source Register</h3>',
    '<table><tbody><tr><th>#</th><th>Source Label</th><th>Reference</th><th>Verification Move</th></tr>',
    linkRows,
    '</tbody></table>',
    '<h3>Appendix Checklist</h3>',
    '<ul><li>Attach raw data or approved export for every quantitative claim.</li><li>Name the accountable owner for legal, privacy, security, or budget claims.</li><li>Record source date and review date for links or external evidence.</li></ul>',
    '</section>',
  ].join('');
}

function addUniqueRedlineSuggestion(suggestions: DocxRedlineSuggestion[], item: DocxRedlineSuggestion): void {
  if (!item.original.trim()) return;
  if (suggestions.some((existing) => existing.original === item.original && existing.reason === item.reason)) return;
  suggestions.push(item);
}

function tightenRedlineText(sentence: string): string {
  return sentence
    .replace(/\bvery\s+/gi, '')
    .replace(/\breally\s+/gi, '')
    .replace(/\bmaybe\b/gi, 'if validated')
    .replace(/\bprobably\b/gi, 'based on current evidence')
    .replace(/\bASAP\b/g, 'by the agreed deadline')
    .replace(/\bsoon\b/gi, 'by a named date')
    .replace(/\btry to\b/gi, 'will')
    .replace(/\bshould\b/gi, 'will')
    .replace(/\bcould\b/gi, 'can')
    .replace(/\bmight\b/gi, 'may')
    .replace(/\bsome\b/gi, 'specific')
    .replace(/\bseveral\b/gi, 'the listed')
    .replace(/\bmany\b/gi, 'the measured')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractDocxRedlineSuggestions(html: string): DocxRedlineSuggestion[] {
  const clean = removeAllDocxAssistantSections(html);
  const text = stripTags(clean);
  const sentences = text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const suggestions: DocxRedlineSuggestion[] = [];

  sentences.forEach((sentence) => {
    if (suggestions.length >= 12) return;
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length > 34) {
      addUniqueRedlineSuggestion(suggestions, {
        original: sentenceSummary(sentence, 34),
        suggestion: 'Split this into two sentences: one factual claim, then one decision or implication.',
        reason: 'Long sentences slow review and bury the ask.',
        severity: 'warning',
      });
    }
    if (/\b(very|really|some|many|several|stuff|things|nice|good|bad|soon|ASAP|probably|maybe)\b/i.test(sentence)) {
      addUniqueRedlineSuggestion(suggestions, {
        original: sentenceSummary(sentence, 28),
        suggestion: tightenRedlineText(sentenceSummary(sentence, 28)),
        reason: 'Vague or inflated wording should become measurable, dated, or owner-backed.',
        severity: 'warning',
      });
    }
    if (/\b(should|could|might|try to|need to)\b/i.test(sentence)) {
      addUniqueRedlineSuggestion(suggestions, {
        original: sentenceSummary(sentence, 28),
        suggestion: tightenRedlineText(sentenceSummary(sentence, 28)),
        reason: 'Decision documents read stronger when recommendations use action language.',
        severity: 'info',
      });
    }
    if (/\b(is|are|was|were|be|been|being)\s+\w+ed\b/i.test(sentence)) {
      addUniqueRedlineSuggestion(suggestions, {
        original: sentenceSummary(sentence, 28),
        suggestion: 'Name the accountable actor before the verb.',
        reason: 'Passive construction can hide ownership.',
        severity: 'info',
      });
    }
    if (/\b(decision|approve|approval|risk|launch|deadline|timeline|budget|forecast)\b/i.test(sentence)
      && !/\b(owner|due|by|date|responsible|담당|기한|마감)\b/i.test(sentence)) {
      addUniqueRedlineSuggestion(suggestions, {
        original: sentenceSummary(sentence, 28),
        suggestion: `${sentenceSummary(sentence, 20)} Owner: TBD. Due: TBD.`,
        reason: 'Business-critical statements need owner and timing metadata.',
        severity: 'warning',
      });
    }
  });

  if (!suggestions.length) {
    suggestions.push({
      original: 'No major redline candidates detected.',
      suggestion: 'Add Redline+ again after drafting recommendations, risks, metrics, or approval language.',
      reason: 'The current text is relatively clean or too short to evaluate.',
      severity: 'info',
    });
  }

  return suggestions.slice(0, 12);
}

export function buildDocxRedlinePackHtml(html: string): string {
  const clean = removeAllDocxAssistantSections(html);
  const suggestions = extractDocxRedlineSuggestions(clean);
  const report = analyzeDocxHtml(clean);
  const warningCount = suggestions.filter((item) => item.severity === 'warning').length;
  const redlineScore = Math.max(0, Math.min(100, report.score - warningCount * 5 + (suggestions.length ? 4 : 0)));
  const rows = suggestions.map((item, idx) => {
    const bg = item.severity === 'warning' ? '#fee2e2' : '#dbeafe';
    return [
      '<tr>',
      `<td>${idx + 1}</td>`,
      `<td style="background:${bg}">${escapeHtml(item.original)}</td>`,
      `<td>${escapeHtml(item.suggestion)}</td>`,
      `<td>${escapeHtml(item.reason)}</td>`,
      '</tr>',
    ].join('');
  }).join('');

  return [
    '<section data-docx-redline-pack="true">',
    '<h2>Editor Redline Pack</h2>',
    `<blockquote><strong>Editorial readiness:</strong> ${redlineScore}/100 · ${warningCount} priority edit${warningCount === 1 ? '' : 's'} · ${report.words} words</blockquote>`,
    '<h3>Redline Queue</h3>',
    '<table><tbody><tr><th>#</th><th>Original</th><th>Suggested Rewrite</th><th>Why</th></tr>',
    rows,
    '</tbody></table>',
    '<h3>Style Guardrails</h3>',
    '<ul><li>Replace vague qualifiers with numbers, owners, dates, or source references.</li><li>Use active voice for decisions, risks, and commitments.</li><li>Split long sentences so each paragraph has one job.</li></ul>',
    '</section>',
  ].join('');
}

function inferDocxAudience(text: string): string {
  if (/\b(board|executive|ceo|cfo|leadership|approval|approve|decision|승인|결정)\b/i.test(text)) return 'Executive approvers';
  if (/\b(customer|client|buyer|proposal|pricing|scope|고객|클라이언트)\b/i.test(text)) return 'Customer or commercial stakeholders';
  if (/\b(engineer|developer|architecture|technical|api|system|platform|기술|개발)\b/i.test(text)) return 'Technical reviewers';
  if (/\b(legal|contract|clause|liability|privacy|compliance|계약|법무)\b/i.test(text)) return 'Legal and risk reviewers';
  if (/\b(launch|press|media|announcement|release|출시|보도)\b/i.test(text)) return 'Market and launch stakeholders';
  return 'General reviewers';
}

function inferDocxObjective(text: string, outline: DocxOutlineItem[]): string {
  const title = outline[0]?.text;
  if (/\b(approve|approval|decision|sign[- ]?off|승인|결정)\b/i.test(text)) return title ? `Get approval for ${title}` : 'Get a clear decision or approval';
  if (/\b(proposal|scope|budget|pricing|제안|예산)\b/i.test(text)) return title ? `Win alignment on ${title}` : 'Convert scope and value into a concrete agreement';
  if (/\b(requirement|prd|feature|acceptance criteria|제품|요구사항)\b/i.test(text)) return title ? `Lock requirements for ${title}` : 'Define requirements reviewers can build and test';
  if (/\b(contract|clause|legal|계약|법무)\b/i.test(text)) return title ? `Close review issues for ${title}` : 'Resolve risk and negotiation posture';
  return title ? `Make ${title} review-ready` : 'Make the document review-ready';
}

export function buildDocxStrategyPack(html: string): DocxStrategyPack {
  const clean = removeAllDocxAssistantSections(html);
  const text = stripTags(clean);
  const outline = extractDocxOutline(clean);
  const recommendedPreset = recommendDocxDesignPresetPacks(clean, 1)[0];
  return {
    objective: inferDocxObjective(text, outline),
    audience: inferDocxAudience(text),
    coreMessage: sentenceSummary(text, 28) || 'Draft the central message before review.',
    recommendedPreset,
    report: analyzeDocxHtml(clean),
  };
}

export function buildDocxStrategyPackHtml(html: string): string {
  const clean = removeAllDocxAssistantSections(html);
  const strategy = buildDocxStrategyPack(clean);
  const outline = extractDocxOutline(clean);
  const actions = extractDocxActionItems(clean);
  const risks = extractDocxRiskSignals(clean);
  const evidence = extractDocxEvidenceSignals(clean);
  const redlines = extractDocxRedlineSuggestions(clean);
  const warningRisks = risks.filter((risk) => risk.severity === 'warning');
  const evidenceWarnings = evidence.filter((item) => item.severity === 'warning');
  const priorityRedlines = redlines.filter((item) => item.severity === 'warning');
  const strategyScore = Math.max(0, Math.min(100,
    strategy.report.score
      + (outline.length >= 3 ? 6 : -8)
      + (actions.length ? 5 : -5)
      - warningRisks.length * 4
      - evidenceWarnings.length * 3
      - priorityRedlines.length * 2
  ));

  const spineRows = [
    ['Hook', outline[0]?.text || strategy.objective, 'Open with the decision, audience, and consequence.'],
    ['Why now', risks[0]?.signal || 'No urgency signal detected.', 'Name the trigger, deadline, or cost of waiting.'],
    ['Proof', evidence[0]?.claim || 'No major evidence claim detected.', 'Attach source, owner, and freshness metadata.'],
    ['Decision', actions[0]?.action || strategy.objective, 'End with owner, due date, and next concrete move.'],
  ].map(([stage, signal, move]) => `<tr><td>${escapeHtml(stage)}</td><td>${escapeHtml(signal)}</td><td>${escapeHtml(move)}</td></tr>`).join('');

  const objectionRows = (warningRisks.length ? warningRisks : risks).slice(0, 5).map((risk, idx) => (
    `<tr><td>${idx + 1}</td><td>${escapeHtml(risk.category)}</td><td>${escapeHtml(risk.signal)}</td><td>${escapeHtml(risk.recommendation)}</td></tr>`
  )).join('');

  const rewriteRows = (priorityRedlines.length ? priorityRedlines : redlines).slice(0, 5).map((item, idx) => (
    `<tr><td>${idx + 1}</td><td>${escapeHtml(item.original)}</td><td>${escapeHtml(item.suggestion)}</td><td>${escapeHtml(item.reason)}</td></tr>`
  )).join('');

  const gates = [
    ['Structure', outline.length >= 3 ? 'Ready' : 'Needs work', outline.length >= 3 ? `${outline.length} headings found.` : 'Add H1/H2 sections for scanability.'],
    ['Evidence', evidenceWarnings.length <= 1 ? 'Ready' : 'Needs work', evidenceWarnings.length ? `${evidenceWarnings.length} claims need support.` : 'No major evidence gaps detected.'],
    ['Approval', actions.length ? 'Ready' : 'Needs work', actions.length ? `${actions.length} action item(s) detected.` : 'Add explicit owner, decision, and due date.'],
    ['Style', priorityRedlines.length <= 2 ? 'Ready' : 'Needs work', priorityRedlines.length ? `${priorityRedlines.length} priority rewrites found.` : 'No major redline warnings detected.'],
  ].map(([gate, status, detail]) => `<tr><td>${escapeHtml(gate)}</td><td>${escapeHtml(status)}</td><td>${escapeHtml(detail)}</td></tr>`).join('');

  return [
    '<section data-docx-strategy-pack="true">',
    '<h2>Document Strategy Pack</h2>',
    `<blockquote><strong>Strategy score:</strong> ${strategyScore}/100 · ${escapeHtml(strategy.objective)} · ${escapeHtml(strategy.audience)}</blockquote>`,
    '<h3>Strategic Brief</h3>',
    '<table><tbody>',
    `<tr><th>Audience</th><td>${escapeHtml(strategy.audience)}</td></tr>`,
    `<tr><th>Objective</th><td>${escapeHtml(strategy.objective)}</td></tr>`,
    `<tr><th>Core message</th><td>${escapeHtml(strategy.coreMessage)}</td></tr>`,
    `<tr><th>Design preset</th><td>${escapeHtml(strategy.recommendedPreset.preset.label)} · ${escapeHtml(strategy.recommendedPreset.reason)}</td></tr>`,
    '</tbody></table>',
    '<h3>Narrative Spine</h3>',
    '<table><tbody><tr><th>Stage</th><th>Current Signal</th><th>Upgrade Move</th></tr>',
    spineRows,
    '</tbody></table>',
    '<h3>Stakeholder Objections</h3>',
    '<table><tbody><tr><th>#</th><th>Area</th><th>Likely Concern</th><th>Prepared Response</th></tr>',
    objectionRows,
    '</tbody></table>',
    '<h3>Rewrite Sprint</h3>',
    '<table><tbody><tr><th>#</th><th>Current Text</th><th>Rewrite</th><th>Why</th></tr>',
    rewriteRows,
    '</tbody></table>',
    '<h3>Publish Gates</h3>',
    '<table><tbody><tr><th>Gate</th><th>Status</th><th>Evidence</th></tr>',
    gates,
    '</tbody></table>',
    '</section>',
  ].join('');
}

function inferDocxNegotiationPosture(text: string, risks: DocxRiskSignal[], evidence: DocxEvidenceSignal[]): string {
  const combined = [
    text,
    risks.filter((risk) => risk.severity === 'warning').map((risk) => `${risk.category} ${risk.signal}`).join(' '),
    evidence.filter((item) => item.severity === 'warning').map((item) => `${item.claim} ${item.evidenceNeed}`).join(' '),
  ].join(' ');

  if (/\b(legal|contract|clause|liability|privacy|security|compliance|audit|policy|계약|법무|보안|개인정보|준법)\b/i.test(combined)) {
    return 'Risk-first negotiation';
  }
  if (/\b(pricing|budget|payment|revenue|margin|cost|discount|forecast|commercial|예산|가격|매출|비용)\b/i.test(combined)) {
    return 'Commercial tradeoff negotiation';
  }
  if (/\b(approval|approve|decision|owner|deadline|timeline|sign[- ]?off|승인|결정|담당|마감)\b/i.test(combined)) {
    return 'Decision alignment negotiation';
  }
  return 'Clarify-and-align negotiation';
}

function getDocxNegotiationOwner(actions: DocxActionItem[]): string {
  return actions.find((item) => item.owner && item.owner !== 'Unassigned')?.owner || 'TBD';
}

function addUniqueNegotiationIssue(issues: DocxNegotiationIssue[], issue: DocxNegotiationIssue): void {
  const key = issue.issue.toLowerCase();
  if (issues.some((item) => item.issue.toLowerCase() === key)) return;
  issues.push(issue);
}

export function buildDocxNegotiationPack(html: string): DocxNegotiationPack {
  const clean = removeAllDocxAssistantSections(html);
  const text = stripTags(clean);
  const risks = extractDocxRiskSignals(clean);
  const evidence = extractDocxEvidenceSignals(clean);
  const actions = extractDocxActionItems(clean);
  const defaultOwner = getDocxNegotiationOwner(actions);
  const issues: DocxNegotiationIssue[] = [];

  risks
    .filter((risk) => risk.severity === 'warning')
    .forEach((risk) => {
      addUniqueNegotiationIssue(issues, {
        issue: `${risk.category}: ${risk.signal}`,
        leverage: risk.recommendation,
        preferredPosition: `Close ${risk.category.toLowerCase()} risk before approval.`,
        fallbackPosition: 'Accept with named owner, date, and monitoring trigger.',
        owner: defaultOwner,
        severity: risk.severity,
      });
    });

  evidence
    .filter((item) => item.severity === 'warning')
    .forEach((item) => {
      addUniqueNegotiationIssue(issues, {
        issue: `Evidence gap: ${item.claim}`,
        leverage: item.evidenceNeed,
        preferredPosition: 'Require source before final approval.',
        fallbackPosition: 'Mark as assumption and add follow-up owner.',
        owner: defaultOwner,
        severity: item.severity,
      });
    });

  actions.slice(0, 3).forEach((action) => {
    addUniqueNegotiationIssue(issues, {
      issue: `Open action: ${action.action}`,
      leverage: `Owner ${action.owner || 'TBD'} · Due ${action.due || 'TBD'}`,
      preferredPosition: 'Convert action into a signed commitment before close.',
      fallbackPosition: 'Track as a condition with weekly status review.',
      owner: action.owner && action.owner !== 'Unassigned' ? action.owner : defaultOwner,
      severity: action.owner === 'Unassigned' || action.due === 'TBD' ? 'warning' : 'info',
    });
  });

  if (!issues.length) {
    issues.push({
      issue: 'Negotiation posture not explicit',
      leverage: 'Current draft has no clear risk, evidence, or owner signal to trade against.',
      preferredPosition: 'Add issue owner, preferred outcome, fallback, and walk-away condition.',
      fallbackPosition: 'Run a clarification review before sending externally.',
      owner: defaultOwner,
      severity: 'info',
    });
  }

  return {
    posture: inferDocxNegotiationPosture(text, risks, evidence),
    issues: issues.slice(0, 8),
    report: analyzeDocxHtml(clean),
  };
}

export function buildDocxNegotiationPackHtml(html: string): string {
  const clean = removeAllDocxAssistantSections(html);
  const pack = buildDocxNegotiationPack(clean);
  const warningCount = pack.issues.filter((issue) => issue.severity === 'warning').length;
  const negotiationScore = Math.max(0, Math.min(100, pack.report.score + (pack.issues.length ? 6 : -8) - warningCount * 4));
  const primaryIssue = pack.issues[0];
  const primaryOwner = primaryIssue?.owner || 'TBD';

  const issueRows = pack.issues.map((item, idx) => {
    const bg = item.severity === 'warning' ? '#fee2e2' : '#dbeafe';
    return [
      '<tr>',
      `<td>${idx + 1}</td>`,
      `<td style="background:${bg}">${escapeHtml(item.issue)}</td>`,
      `<td>${escapeHtml(item.leverage)}</td>`,
      `<td>${escapeHtml(item.preferredPosition)}</td>`,
      `<td>${escapeHtml(item.fallbackPosition)}</td>`,
      `<td>${escapeHtml(item.owner)}</td>`,
      '</tr>',
    ].join('');
  }).join('');

  const ladderRows = [
    ['Preferred', 'Reviewer accepts the document logic and evidence.', primaryIssue?.preferredPosition || 'Close the document with named owner and date.'],
    ['Conditional', 'Counterparty or approver accepts direction but wants protection.', primaryIssue?.fallbackPosition || 'Add condition, trigger, and monitoring owner.'],
    ['Escalate', 'Material risk remains unresolved.', `Escalate to ${primaryOwner} with decision options and tradeoffs.`],
    ['Walk-away', 'Risk exceeds the value of agreement.', 'Pause signature, reset scope, or request revised terms.'],
  ].map(([position, useWhen, nextMove]) => `<tr><td>${escapeHtml(position)}</td><td>${escapeHtml(useWhen)}</td><td>${escapeHtml(nextMove)}</td></tr>`).join('');

  const scriptItems = pack.issues.slice(0, 4).map((issue) => (
    `<li><strong>${escapeHtml(issue.owner)}:</strong> Lead with "${escapeHtml(issue.issue)}", then trade against "${escapeHtml(issue.leverage)}".</li>`
  )).join('');

  return [
    '<section data-docx-negotiation-pack="true">',
    '<h2>Negotiation Pack</h2>',
    `<blockquote><strong>Negotiation score:</strong> ${negotiationScore}/100 · ${escapeHtml(pack.posture)} · ${pack.issues.length} open issue${pack.issues.length === 1 ? '' : 's'}</blockquote>`,
    '<h3>Issue Matrix</h3>',
    '<table><tbody><tr><th>#</th><th>Issue</th><th>Leverage</th><th>Preferred Position</th><th>Fallback</th><th>Owner</th></tr>',
    issueRows,
    '</tbody></table>',
    '<h3>Fallback Ladder</h3>',
    '<table><tbody><tr><th>Position</th><th>Use When</th><th>Next Move</th></tr>',
    ladderRows,
    '</tbody></table>',
    '<h3>Stakeholder Script</h3>',
    `<ul>${scriptItems}</ul>`,
    '<h3>Close Checklist</h3>',
    '<ul><li>Name the walk-away condition before external review.</li><li>Attach evidence for every quantitative or comparative claim.</li><li>Turn each fallback into an owner, due date, and monitoring trigger.</li><li>Record final decision conditions in the approval log.</li></ul>',
    '</section>',
  ].join('');
}

function splitLongDocxParagraphs(html: string): { html: string; count: number } {
  let count = 0;
  const nextHtml = html.replace(/<p(\s[^>]*)?>([\s\S]*?)<\/p>/gi, (match, attrs = '', inner) => {
    if (/<(table|ul|ol|h[1-6]|blockquote|section)\b/i.test(inner)) return match;
    const text = normalizeText(inner);
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 90) return match;
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length < 2) return match;
    const groups: string[] = [];
    let current = '';
    sentences.forEach((sentence) => {
      const candidate = `${current} ${sentence}`.trim();
      if (candidate.split(/\s+/).length > 55 && current) {
        groups.push(current);
        current = sentence;
      } else {
        current = candidate;
      }
    });
    if (current) groups.push(current);
    if (groups.length < 2) return match;
    count += 1;
    return groups.map((part) => `<p${attrs}>${escapeHtml(part)}</p>`).join('');
  });
  return { html: nextHtml, count };
}

function buildDocxCleanupPanelHtml(report: DocxCleanupReport): string {
  const rows = [
    ['Empty paragraphs removed', String(report.removedEmptyParagraphs)],
    ['Long paragraphs split', String(report.splitParagraphs)],
    ['Title added', report.addedTitle ? 'Yes' : 'No'],
    ['Decision controls added', report.addedDecisionControls ? 'Yes' : 'No'],
    ['Quality change', `${report.scoreBefore}/100 → ${report.scoreAfter}/100`],
  ];
  return [
    '<section data-docx-clean="true">',
    '<h2>Clean Room Summary</h2>',
    '<table><tbody><tr><th>Cleanup</th><th>Result</th></tr>',
    rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join(''),
    '</tbody></table>',
    '</section>',
  ].join('');
}

export function cleanDocxHtml(html: string, theme: DocxDesignTheme): string {
  const source = removeAllDocxAssistantSections(String(html || '').trim() || '<p></p>');
  const before = analyzeDocxHtml(source);
  const emptyParagraphMatches = source.match(/<p\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi) || [];
  let cleaned = source
    .replace(/<p\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const split = splitLongDocxParagraphs(cleaned);
  cleaned = split.html;
  const text = stripTags(cleaned);
  const addedTitle = !/<h1\b/i.test(cleaned) && Boolean(text);
  if (addedTitle) {
    cleaned = `<h1>${escapeHtml(sentenceSummary(text, 8) || 'Untitled Document')}</h1>${cleaned}`;
  }
  const hasDecisionControls = /<table\b[\s\S]*?(owner|due|decision|status|담당|기한|결정|상태)[\s\S]*?<\/table>/i.test(cleaned);
  const addedDecisionControls = !hasDecisionControls && /\b(decision|owner|due|timeline|risk|approval|launch|review|결정|담당|승인|일정|위험)\b/i.test(text);
  if (addedDecisionControls) {
    cleaned += [
      '<h2>Decision Controls</h2>',
      '<table><tbody><tr><th>Decision</th><th>Owner</th><th>Due</th><th>Status</th></tr>',
      '<tr><td>Confirm next decision</td><td>Unassigned</td><td>TBD</td><td>Open</td></tr>',
      '</tbody></table>',
    ].join('');
  }
  const afterBase = analyzeDocxHtml(cleaned);
  const report: DocxCleanupReport = {
    removedEmptyParagraphs: emptyParagraphMatches.length,
    splitParagraphs: split.count,
    addedTitle,
    addedDecisionControls,
    scoreBefore: before.score,
    scoreAfter: afterBase.score,
  };
  return applyDocxThemeToHtml(`${cleaned}${buildDocxCleanupPanelHtml(report)}`, theme);
}

export function analyzeDocxHtml(html: string): DocxQualityReport {
  const source = String(html || '');
  const text = stripTags(source);
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const chars = text.length;
  const paragraphs = tagText(source, 'p').filter(Boolean).length;
  const headings = (source.match(/<h[1-3]\b/gi) || []).length;
  const tables = (source.match(/<table\b/gi) || []).length;
  const lists = (source.match(/<(ul|ol)\b/gi) || []).length;
  const links = (source.match(/<a\b/gi) || []).length;
  const readingMinutes = Math.max(1, Math.ceil(words / 220));
  const issues: DocxQualityIssue[] = [];

  if (words === 0) {
    issues.push({ severity: 'warning', message: 'Document is empty' });
  } else {
    issues.push({ severity: 'success', message: `${words} words · about ${readingMinutes} min read` });
  }
  if (!/<h1\b/i.test(source)) {
    issues.push({ severity: 'warning', message: 'Missing primary title' });
  }
  if (words > 220 && headings < 2) {
    issues.push({ severity: 'warning', message: 'Long document needs more section headings' });
  }
  const longParagraphs = tagText(source, 'p').filter((paragraph) => paragraph.split(/\s+/).length > 90);
  if (longParagraphs.length) {
    issues.push({ severity: 'warning', message: `${longParagraphs.length} paragraph${longParagraphs.length === 1 ? '' : 's'} should be shortened` });
  }
  if (tables === 0 && /budget|timeline|risk|owner|decision|metric|requirement/i.test(text)) {
    issues.push({ severity: 'info', message: 'Consider a table for decisions, owners, metrics, or risks' });
  }
  if (lists === 0 && words > 120) {
    issues.push({ severity: 'info', message: 'Bullets would improve scanability' });
  }

  const penalty = issues.reduce((sum, issue) => sum + (issue.severity === 'warning' ? 18 : issue.severity === 'info' ? 7 : 0), 0);
  return {
    score: Math.max(0, Math.min(100, 100 - penalty)),
    words,
    chars,
    paragraphs,
    headings,
    tables,
    lists,
    links,
    readingMinutes,
    issues,
  };
}

export function buildDocxQualityPanelHtml(report: DocxQualityReport): string {
  const rows = report.issues.map((issue) => {
    const color = issue.severity === 'warning' ? '#92400e' : issue.severity === 'success' ? '#166534' : '#1d4ed8';
    const bg = issue.severity === 'warning' ? '#fef3c7' : issue.severity === 'success' ? '#dcfce7' : '#dbeafe';
    return `<tr><td style="border:1px solid #cbd5e1;padding:7px 10px;background:${bg};color:${color};font-weight:600">${issue.severity}</td><td style="border:1px solid #cbd5e1;padding:7px 10px">${escapeHtml(issue.message)}</td></tr>`;
  }).join('');
  return [
    '<section data-docx-quality="true">',
    '<h2>Document Quality Review</h2>',
    `<p><strong>Score:</strong> ${report.score}/100 · <strong>Length:</strong> ${report.words} words · <strong>Reading time:</strong> ${report.readingMinutes} min</p>`,
    '<table><tbody><tr><th>Signal</th><th>Recommendation</th></tr>',
    rows || '<tr><td>success</td><td>No issues found.</td></tr>',
    '</tbody></table>',
    '</section>',
  ].join('');
}

const DOCX_NAMED_COLORS: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  orange: 'FFA500',
  purple: '800080',
  gray: '808080',
  grey: '808080',
  cyan: '00FFFF',
  magenta: 'FF00FF',
  lime: '00FF00',
  pink: 'FFC0CB',
};

// px sizes used by the Home tab font-size dropdown, keyed by execCommand fontSize values.
const DOCX_FONT_SIZE_ATTR_PX: Record<string, number> = {
  '1': 10, '2': 13, '3': 16, '4': 18, '5': 24, '6': 32, '7': 48,
};

export function parseDataUrl(src: string): { mime: string; data: string } | null {
  const match = String(src || '').match(/^data:([^;,]*)(;base64)?,(.*)$/is);
  if (!match || !match[2]) return null;
  const data = (match[3] || '').trim();
  if (!data) return null;
  return { mime: (match[1] || '').toLowerCase(), data };
}

export function docxImageTypeFromMime(mime: string): 'png' | 'jpg' | 'gif' | 'bmp' {
  const value = String(mime || '').toLowerCase();
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  if (value.includes('gif')) return 'gif';
  if (value.includes('bmp')) return 'bmp';
  return 'png';
}

// ImageRun accepts only these raster types. webp/svg/emf/wmf/tiff/heic bytes
// written under a mismatched type corrupt the picture in Word, so callers must
// treat them as unsupported and drop-and-warn instead of shipping a broken image.
export function isDocxSupportedImageMime(mime: string): boolean {
  return /(png|jpe?g|gif|bmp)/.test(String(mime || '').toLowerCase());
}

export function cssColorToDocxHex(value: string): string | undefined {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'transparent' || raw === 'inherit' || raw === 'initial' || raw === 'currentcolor' || raw === 'none') {
    return undefined;
  }
  const hexMatch = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    return full.toUpperCase();
  }
  const rgbMatch = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgbMatch) {
    const toHex = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
    return `${toHex(rgbMatch[1])}${toHex(rgbMatch[2])}${toHex(rgbMatch[3])}`.toUpperCase();
  }
  return DOCX_NAMED_COLORS[raw];
}

export function cssLengthToHalfPoints(value: string): number | undefined {
  const raw = String(value || '').trim().toLowerCase();
  const match = raw.match(/^(-?\d*\.?\d+)(px|pt|em|rem)?$/);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  if (!isFinite(num) || num <= 0) return undefined;
  const unit = match[2] || 'px';
  const pt = unit === 'pt' ? num
    : unit === 'em' || unit === 'rem' ? num * 12
    : num * 72 / 96;
  return Math.round(pt * 2);
}

export function fontSizeAttrToHalfPoints(attr: string): number | undefined {
  const px = DOCX_FONT_SIZE_ATTR_PX[String(attr || '').trim()];
  return px ? cssLengthToHalfPoints(`${px}px`) : undefined;
}

// Point sizes offered by the Home tab font-size selector.
export const DOCX_FONT_SIZE_PT_PRESETS: number[] = [
  8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 54, 60, 72,
];

// System font families offered by the Home tab font selector. An empty value
// clears the override and falls back to the document theme font.
export interface DocxFontFamilyOption {
  label: string;
  value: string;
}

export const DOCX_FONT_FAMILIES: DocxFontFamilyOption[] = [
  { label: 'Theme default', value: '' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Calibri', value: 'Calibri, sans-serif' },
  { label: 'Segoe UI', value: '"Segoe UI", sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Garamond', value: 'Garamond, serif' },
  { label: 'Courier New', value: '"Courier New", monospace' },
  { label: '맑은 고딕', value: '"Malgun Gothic", sans-serif' },
  { label: '나눔고딕', value: '"Nanum Gothic", sans-serif' },
  { label: '바탕', value: 'Batang, serif' },
];

// Convert a point size to docx half-points (docx sizing unit).
export function ptToHalfPoints(pt: number): number {
  if (!isFinite(pt) || pt <= 0) return 0;
  return Math.round(pt * 2);
}

// Reduce a CSS font-family stack to the first concrete family name that Word
// can resolve, stripping quotes and generic fallbacks.
export function cssFontFamilyToDocx(value: string): string | undefined {
  const first = String(value || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  if (!first) return undefined;
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial']);
  if (generic.has(first.toLowerCase())) return undefined;
  return first;
}

// Quick style gallery entries shown on the Home ribbon. Each maps to a block tag
// applied through formatBlock, and the exporter renders them to matching docx.
export interface DocxQuickStyle {
  id: string;
  label: string;
  koLabel: string;
  block: string;
}

export const DOCX_QUICK_STYLES: DocxQuickStyle[] = [
  { id: 'body', label: 'Body', koLabel: '본문', block: 'p' },
  { id: 'h1', label: 'Heading 1', koLabel: '제목 1', block: 'h1' },
  { id: 'h2', label: 'Heading 2', koLabel: '제목 2', block: 'h2' },
  { id: 'h3', label: 'Heading 3', koLabel: '제목 3', block: 'h3' },
  { id: 'quote', label: 'Quote', koLabel: '인용', block: 'blockquote' },
  { id: 'code', label: 'Code Block', koLabel: '코드 블록', block: 'pre' },
];

// Resolve a quick-style id to the formatBlock tag it applies.
export function docxQuickStyleBlock(id: string): string {
  return DOCX_QUICK_STYLES.find((style) => style.id === id)?.block || 'p';
}

export function polishDocxHtml(html: string, theme: DocxDesignTheme): string {
  const source = String(html || '').trim() || '<p></p>';
  const withoutPreviousPanel = source.replace(/<section\b[^>]*data-docx-quality=["']true["'][\s\S]*?<\/section>/gi, '');
  const withoutPreviousPolish = withoutPreviousPanel.replace(/<blockquote\b[^>]*data-docx-polish=["']true["'][\s\S]*?<\/blockquote>/gi, '');
  const bodyText = stripTags(withoutPreviousPolish);
  const hasTitle = /<h1\b/i.test(withoutPreviousPolish);
  const title = hasTitle ? '' : `<h1>${escapeHtml(sentenceSummary(bodyText, 8) || 'Untitled Document')}</h1>`;
  const brief = bodyText
    ? `<blockquote data-docx-polish="true"><strong>Executive snapshot:</strong> ${escapeHtml(sentenceSummary(bodyText, 32))}</blockquote>`
    : '';
  const themed = applyDocxThemeToHtml(`${title}${withoutPreviousPolish}`, theme);
  const report = analyzeDocxHtml(themed);
  const panel = buildDocxQualityPanelHtml(report);
  return applyDocxThemeToHtml(`${brief}${themed}${panel}`, theme);
}
