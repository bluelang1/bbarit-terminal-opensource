// Pure data & logic for BBARIT Marketing — brand kit, suggestion library,
// session filtering, image job requests, and email-suite context parsing.
// No React/Tauri imports so everything here is unit-testable.

import { parseCustomSize } from './bbaritImageStudio';

export type SuggestionCategory =
  | 'SEO' | 'Content' | 'Social' | 'Email' | 'Ads' | 'Analytics' | 'Brand' | 'Growth';

export const SUGGESTION_CATEGORIES: SuggestionCategory[] = [
  'SEO', 'Content', 'Social', 'Email', 'Ads', 'Analytics', 'Brand', 'Growth',
];

export interface MarketingSuggestion {
  title: string;
  prompt: string;
  category: SuggestionCategory;
}

export const MARKETING_SUGGESTIONS: MarketingSuggestion[] = [
  // SEO
  { category: 'SEO', title: 'Keyword Research', prompt: 'Research high-volume, moderate-competition keywords for this topic. Output a prioritized spreadsheet with volume, difficulty, intent, and content recommendations.' },
  { category: 'SEO', title: 'Competitor Analysis', prompt: 'Analyze the SEO strategy, content, backlinks, and social presence of 3 competitors. Deliver a SWOT-style report with our opportunity gaps and recommended actions.' },
  { category: 'SEO', title: 'On-Page SEO Audit', prompt: 'Audit the on-page SEO of this page/site: titles, meta descriptions, H1-H4 structure, keyword placement, image alt text, and internal links. Deliver prioritized fixes with impact estimates.' },
  { category: 'SEO', title: 'Technical SEO Check', prompt: 'Run a technical SEO health check: crawlability, indexing, Core Web Vitals, robots.txt, sitemap, canonicals, redirects, and mobile friendliness. Output an issue list ranked by severity with fixes.' },
  { category: 'SEO', title: 'Backlink Analysis', prompt: 'Analyze the backlink profile: referring domains, authority distribution, anchor text, and toxic links. Compare against 2 competitors and deliver a link-building action plan.' },
  // Content
  { category: 'Content', title: 'SEO Blog Post', prompt: 'Write an SEO-optimized blog post around the core keyword for this product/service. Include keyword placement, H1-H4 structure, meta description, and internal link suggestions.' },
  { category: 'Content', title: 'Content Calendar', prompt: 'Build a 4-week editorial content calendar. Include topics, target keywords, funnel stage, format (blog/video/social), and publish dates. Output as a spreadsheet.' },
  { category: 'Content', title: 'Content Gap Analysis', prompt: 'Map our content coverage against 2-3 competitors. Identify missing topics, keyword gaps, and quick-win opportunities. Prioritize into an editorial backlog.' },
  { category: 'Content', title: 'Landing Page Copy', prompt: 'Write high-converting landing page copy: hero headline (3 variants), subheadline, benefit sections, social proof blocks, objection handling, FAQ, and CTA copy. Include an SEO meta set.' },
  { category: 'Content', title: 'Content Refresh', prompt: 'Audit existing content for decay: identify declining pages, outdated info, and ranking drops. Deliver a refresh plan with update priorities and GEO-aware republishing guidance.' },
  // Social
  { category: 'Social', title: 'Social Media Plan', prompt: 'Create a 2-week social media content calendar. Include platform-specific copy (Threads, Instagram, LinkedIn, TikTok), hashtags, best posting times, and visual briefs.' },
  { category: 'Social', title: 'Short-Form Scripts', prompt: 'Write 5 short-form video scripts (TikTok/Reels/Shorts) with hook-payload-CTA structure. Include on-screen text, b-roll suggestions, sound/trend ideas, and platform-specific captions.' },
  { category: 'Social', title: 'Viral Hooks', prompt: 'Generate 20 scroll-stopping hooks for our topic across Threads/X, TikTok, and LinkedIn. Group by psychological trigger (curiosity, controversy, proof, FOMO) and rank by expected engagement.' },
  { category: 'Social', title: 'Community Playbook', prompt: 'Create a community management playbook: reply templates, tone guidelines, escalation rules, crisis response flows, and engagement rituals for our channels.' },
  // Email
  { category: 'Email', title: 'Email Campaign', prompt: 'Design a 5-email welcome/nurture sequence. Write subject lines (with A/B variants), preview text, body copy, CTAs, and a segmentation plan. Include compliance notes (CAN-SPAM/GDPR).' },
  { category: 'Email', title: 'Newsletter Plan', prompt: 'Design a weekly newsletter program: editorial format, content pillars, subject line system, growth tactics, segmentation, and KPI targets. Include outlines for 4 sample issues.' },
  { category: 'Email', title: 'Re-engagement Flow', prompt: 'Build a win-back email flow for inactive subscribers: segmentation criteria, a 4-email sequence with subject lines and copy, incentive strategy, and sunset policy.' },
  { category: 'Email', title: 'Cold Outreach', prompt: 'Write a B2B cold outreach sequence (email + LinkedIn): 5 touches with personalization variables, value-first angles, follow-up cadence, and reply-handling templates.' },
  // Ads
  { category: 'Ads', title: 'Paid Ads Plan', prompt: 'Create a paid advertising plan for Google Ads + Meta Ads. Include campaign structure, keyword/ad-set strategy, budget allocation, ad copy (3 variants each), and ROAS targets.' },
  { category: 'Ads', title: 'Ad Copy Variants', prompt: 'Write ad copy variants: Google RSA (15 headlines, 4 descriptions), Meta primary text + headline (3 angles: PAS, AIDA, social proof), and TikTok hooks. Include creative briefs.' },
  { category: 'Ads', title: 'Budget & ROAS Plan', prompt: 'Build a paid media budget plan: channel allocation, expected CAC/ROAS by channel, bid strategy, scaling rules, and a weekly optimization checklist.' },
  // Analytics
  { category: 'Analytics', title: 'Analytics Dashboard', prompt: 'Design a marketing KPI dashboard. Define metrics across acquisition, engagement, conversion, and retention. Include attribution model, target benchmarks, and reporting cadence.' },
  { category: 'Analytics', title: 'CRO Audit', prompt: 'Audit the conversion funnel of this landing page/product. Identify drop-off points, suggest A/B tests (with hypotheses), and recommend UX/copy improvements to boost conversion rate.' },
  { category: 'Analytics', title: 'Attribution Model', prompt: 'Design our marketing attribution approach: compare first-touch, last-touch, and multi-touch models. Recommend one with implementation steps, UTM conventions, and reporting views.' },
  { category: 'Analytics', title: 'Monthly Report', prompt: 'Generate a monthly marketing performance report: executive summary, channel breakdown, trend analysis, wins/losses, and next-month priorities. Output as a document plus a data spreadsheet.' },
  // Brand
  { category: 'Brand', title: 'Brand & PR', prompt: 'Develop a brand positioning document and PR outreach plan. Cover: mission, values, voice, messaging architecture, media pitch angles, and a 5-article thought leadership calendar.' },
  { category: 'Brand', title: 'Brand Voice Guide', prompt: 'Create a brand voice & messaging guide: personality traits, tone spectrum by channel, vocabulary do/don\'t lists, sample rewrites, and a one-page cheat sheet for the team.' },
  { category: 'Brand', title: 'Crisis Comms Kit', prompt: 'Prepare a crisis communication kit: risk scenarios, holding statements, response templates by severity, stakeholder map, and an escalation decision tree.' },
  // Growth
  { category: 'Growth', title: 'Marketing Strategy', prompt: 'Build a comprehensive quarterly marketing strategy. Cover: target audience, positioning, channel mix, content calendar, budget allocation, KPI framework, and risk assessment.' },
  { category: 'Growth', title: 'Growth Playbook', prompt: 'Write a growth marketing playbook. Cover: acquisition channels (organic, paid, viral), activation tactics, retention loops, referral mechanics, and a 90-day execution timeline with milestones.' },
  { category: 'Growth', title: 'Go-to-Market', prompt: 'Build a go-to-market plan for a product launch. Include: positioning, target persona, channel strategy, launch timeline (T-30 to T+30), PR/social assets, and success metrics.' },
  { category: 'Growth', title: 'Pricing & Packaging', prompt: 'Analyze pricing & packaging: competitor pricing teardown, value metric options, tier structure recommendations, and a price test plan with guardrail metrics.' },
];

// ── Brand Kit ─────────────────────────────────────────────────────────────
export interface BrandKit {
  name: string;
  website: string;
  industry: string;
  audience: string;
  tone: string;
  competitors: string;
  keywords: string;
  notes: string;
}

export const EMPTY_BRAND_KIT: BrandKit = {
  name: '', website: '', industry: '', audience: '', tone: '', competitors: '', keywords: '', notes: '',
};

export function parseBrandKit(raw: string | null): BrandKit {
  const kit = { ...EMPTY_BRAND_KIT };
  if (!raw) return kit;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return kit;
    for (const key of Object.keys(kit) as Array<keyof BrandKit>) {
      if (typeof parsed[key] === 'string') kit[key] = parsed[key];
    }
  } catch { /* corrupted storage */ }
  return kit;
}

export function brandKitFilled(kit: BrandKit): boolean {
  return Object.values(kit).some((v) => v.trim().length > 0);
}

// Format the brand kit as a prompt block injected on session prime, so the
// agent never has to re-ask for brand basics.
export function brandKitContext(kit: BrandKit): string {
  if (!brandKitFilled(kit)) return '';
  const lines: string[] = [];
  if (kit.name.trim()) lines.push(`- Brand: ${kit.name.trim()}${kit.website.trim() ? ` (${kit.website.trim()})` : ''}`);
  else if (kit.website.trim()) lines.push(`- Website: ${kit.website.trim()}`);
  if (kit.industry.trim()) lines.push(`- Industry: ${kit.industry.trim()}`);
  if (kit.audience.trim()) lines.push(`- Target audience: ${kit.audience.trim()}`);
  if (kit.tone.trim()) lines.push(`- Tone of voice: ${kit.tone.trim()}`);
  if (kit.competitors.trim()) lines.push(`- Competitors: ${kit.competitors.trim()}`);
  if (kit.keywords.trim()) lines.push(`- Core keywords: ${kit.keywords.trim()}`);
  if (kit.notes.trim()) lines.push(`- Notes: ${kit.notes.trim()}`);
  return `\n[Brand Kit — apply to all marketing work]\n${lines.join('\n')}`;
}

// ── Sessions ──────────────────────────────────────────────────────────────
export function filterSessions<T extends { title: string }>(sessions: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => s.title.toLowerCase().includes(q));
}

// ── Image job requests (.cowork/images.json) ──────────────────────────────
// The marketing agent asks for real images by writing a job file; the panel
// validates it here and runs each job through the Codex image pipeline.
export interface MarketingImageJob {
  file: string;
  outPath: string;
  prompt: string;
  w: number;
  h: number;
  refPath?: string;
}

export const MAX_IMAGE_JOBS = 6;

function sanitizeImageName(name: unknown, index: number): string {
  let base = typeof name === 'string' ? (name.split(/[\\/]/).pop() || '').trim() : '';
  base = base.replace(/[:*?"<>|]/g, '').slice(0, 60);
  if (!base || base === '.png') return `image-${index + 1}.png`;
  if (!/\.png$/i.test(base)) base = `${base.replace(/\.[a-z0-9]{1,5}$/i, '')}.png`;
  return base;
}

export function parseImageJobs(raw: string, sessionDir: string): MarketingImageJob[] {
  const dir = sessionDir.replace(/\/$/, '');
  let list: any[];
  try {
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed?.jobs) ? parsed.jobs : Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
  const jobs: MarketingImageJob[] = [];
  const used = new Set<string>();
  for (const j of list.slice(0, MAX_IMAGE_JOBS)) {
    const prompt = typeof j?.prompt === 'string' ? j.prompt.trim() : '';
    if (!prompt) continue;
    const first = sanitizeImageName(j?.file, jobs.length);
    const base = first.replace(/\.png$/i, '');
    let file = first;
    for (let n = 2; used.has(file.toLowerCase()); n++) file = `${base}-${n}.png`;
    used.add(file.toLowerCase());
    const size = typeof j?.size === 'string' ? parseCustomSize(j.size) : null;
    const ref = typeof j?.ref === 'string' ? j.ref.trim() : '';
    const refPath = ref && !ref.includes('..') && !ref.startsWith('/') ? `${dir}/${ref}` : undefined;
    jobs.push({ file, outPath: `${dir}/${file}`, prompt, w: size?.w ?? 1024, h: size?.h ?? 1024, refPath });
  }
  return jobs;
}

// ── Email marketing suite context ─────────────────────────────────────────
export interface MarketingSuiteStats {
  subscribers: number;
  active: number;
  segments: string;
  campaignsSent: number;
  opens: number;
  clicks: number;
  revenue: number;
  automationsOn: number;
  automationsTotal: number;
}

export function parseMarketingSuite(raw: string | null): MarketingSuiteStats | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const subs = Array.isArray(data.subscribers) ? data.subscribers : [];
    const camps = Array.isArray(data.campaigns) ? data.campaigns : [];
    const autos = Array.isArray(data.automations) ? data.automations : [];
    if (subs.length === 0 && camps.length === 0) return null;
    const sent = camps.filter((c: any) => c?.status === 'sent');
    return {
      subscribers: subs.length,
      active: subs.filter((s: any) => s?.status === 'subscribed').length,
      segments: [...new Set(subs.flatMap((s: any) => s?.tags || []))].join(', '),
      campaignsSent: sent.length,
      opens: sent.reduce((sum: number, c: any) => sum + (c?.opens || 0), 0),
      clicks: sent.reduce((sum: number, c: any) => sum + (c?.clicks || 0), 0),
      revenue: sent.reduce((sum: number, c: any) => sum + (c?.revenue || 0), 0),
      automationsOn: autos.filter((a: any) => a?.enabled).length,
      automationsTotal: autos.length,
    };
  } catch { return null; }
}

// Read-only context block describing the email marketing suite data, injected
// on session prime so the agent can reason about the existing audience.
export function formatMarketingContext(raw: string | null): string {
  const s = parseMarketingSuite(raw);
  if (!s) return '';
  return `\n[Email Marketing Data — read-only context]\n` +
    `- Total subscribers: ${s.subscribers} (${s.active} active, ${s.subscribers - s.active} pending/cleaned)\n` +
    (s.segments ? `- Segments: ${s.segments}\n` : '') +
    `- Campaigns sent: ${s.campaignsSent} | Total opens: ${s.opens} | Total clicks: ${s.clicks} | Attributed revenue: $${s.revenue}\n` +
    `- Active automations: ${s.automationsOn}/${s.automationsTotal}\n` +
    `You can reference this data in your analysis but cannot modify it directly.`;
}
