import { describe, expect, it } from 'vitest';
import type { Slide } from './types';
import { PPTX_DESIGN_THEMES } from './pptxDesignThemes';
import {
  PPTX_DECK_TEMPLATES,
  PPTX_DESIGN_PRESET_PACKS,
  buildPptxDeckTemplate,
  buildPptxDesignPresetDeck,
  getPptxDeckTemplate,
  getPptxDesignPresetPack,
  recommendPptxDesignPresetPacks,
  scorePptxDesignPresetPack,
} from './pptxDeckTemplates';

const slide = (title: string, body: string): Slide => ({
  id: title,
  title,
  bgColor: '#ffffff',
  notes: body,
  elements: [
    {
      id: `${title}-body`,
      type: 'text',
      x: 10,
      y: 10,
      w: 80,
      h: 20,
      text: body,
    },
  ],
});

describe('pptx deck templates', () => {
  it('provides multi-slide business presets', () => {
    expect(PPTX_DECK_TEMPLATES.length).toBeGreaterThanOrEqual(29);
    expect(getPptxDeckTemplate('startup-pitch').slides.length).toBeGreaterThanOrEqual(5);
    expect(getPptxDeckTemplate('board-review').category).toBe('Executive');
    expect(getPptxDeckTemplate('training-workshop').slides.map((slide) => slide.title)).toContain('Guided Exercise');
    expect(getPptxDeckTemplate('enterprise-sales').slides.map((slide) => slide.title)).toContain('ROI Case');
    expect(getPptxDeckTemplate('research-brief').category).toBe('Research');
    expect(getPptxDeckTemplate('campaign-plan').slides.map((slide) => slide.title)).toContain('Measurement');
    expect(getPptxDeckTemplate('portfolio-case-study').slides.map((slide) => slide.title)).toContain('Artifacts');
    expect(getPptxDeckTemplate('technical-architecture').slides.map((slide) => slide.title)).toContain('Reliability Controls');
    expect(getPptxDeckTemplate('investor-update').slides.map((slide) => slide.title)).toContain('Help Needed');
    expect(getPptxDeckTemplate('keynote-demo').slides.map((slide) => slide.title)).toContain('Demo Flow');
    expect(getPptxDeckTemplate('ai-strategy-roadmap').slides.map((slide) => slide.title)).toContain('Risk Guardrails');
    expect(getPptxDeckTemplate('security-incident-review').slides.map((slide) => slide.title)).toContain('Root Cause & Fixes');
    expect(getPptxDeckTemplate('okr-operating-review').slides.map((slide) => slide.title)).toContain('Decision Log');
    expect(getPptxDeckTemplate('cfo-financial-review').slides.map((slide) => slide.title)).toContain('P&L Bridge');
    expect(getPptxDeckTemplate('customer-qbr').slides.map((slide) => slide.title)).toContain('Renewal & Expansion Plan');
    expect(getPptxDeckTemplate('product-roadmap-review').slides.map((slide) => slide.title)).toContain('Prioritization Matrix');
    expect(getPptxDeckTemplate('ma-deal-room').slides.map((slide) => slide.title)).toContain('Diligence Red Flags');
    expect(getPptxDeckTemplate('people-hiring-plan').slides.map((slide) => slide.title)).toContain('Candidate Calibration');
    expect(getPptxDeckTemplate('brand-narrative-system').slides.map((slide) => slide.title)).toContain('Message House');
    expect(getPptxDeckTemplate('regulatory-compliance-brief').slides.map((slide) => slide.title)).toContain('Remediation Plan');
    expect(getPptxDeckTemplate('nonprofit-grant-proposal').slides.map((slide) => slide.title)).toContain('Budget & Outcomes');
    expect(getPptxDeckTemplate('pricing-packaging-strategy').slides.map((slide) => slide.title)).toContain('Package Architecture');
    expect(getPptxDeckTemplate('legal-case-brief').slides.map((slide) => slide.title)).toContain('Evidence Register');
    expect(getPptxDeckTemplate('clinical-trial-readout').slides.map((slide) => slide.title)).toContain('Safety Watch');
    expect(getPptxDeckTemplate('all-hands-town-hall').slides.map((slide) => slide.title)).toContain('Questions & Commitments');
    expect(getPptxDeckTemplate('event-sponsorship-pitch').slides.map((slide) => slide.title)).toContain('ROI Reporting');
  });

  it('builds themed slides with titles and speaker notes', () => {
    const theme = PPTX_DESIGN_THEMES[1];
    const slides = buildPptxDeckTemplate('startup-pitch', theme);

    expect(slides.length).toBeGreaterThanOrEqual(5);
    expect(slides[0].bgColor).toBe(theme.bgColor);
    expect(slides.map((slide) => slide.title)).toContain('Traction');
    expect(slides.some((slide) => slide.notes?.trim())).toBe(true);
    expect(slides.every((slide) => slide.elements.length > 0)).toBe(true);
  });

  it('provides one-click design preset packs that pair a deck with a theme', () => {
    expect(PPTX_DESIGN_PRESET_PACKS.length).toBeGreaterThanOrEqual(28);
    const preset = getPptxDesignPresetPack('sales-close-plan');
    const slides = buildPptxDesignPresetDeck(preset.id);
    const theme = PPTX_DESIGN_THEMES.find((item) => item.id === preset.themeId);

    expect(preset.templateId).toBe('enterprise-sales');
    expect(theme).toBeTruthy();
    expect(slides.length).toBe(getPptxDeckTemplate(preset.templateId).slides.length);
    expect(slides[0].bgColor).toBe(theme?.bgColor);
    expect(slides.map((slide) => slide.title)).toContain('Close Plan');
    expect(slides.some((slide) => slide.notes?.trim())).toBe(true);

    const architecturePreset = getPptxDesignPresetPack('blueprint-architecture');
    const architectureSlides = buildPptxDesignPresetDeck(architecturePreset.id);
    expect(architecturePreset.themeId).toBe('architecture-blueprint');
    expect(architectureSlides.map((slide) => slide.title)).toContain('System Map');
    expect(architectureSlides[0].bgColor).toBe(PPTX_DESIGN_THEMES.find((item) => item.id === 'architecture-blueprint')?.bgColor);

    const aiPreset = getPptxDesignPresetPack('ai-transformation-roadmap');
    const aiSlides = buildPptxDesignPresetDeck(aiPreset.id);
    expect(aiPreset.templateId).toBe('ai-strategy-roadmap');
    expect(aiSlides.map((slide) => slide.title)).toContain('90-Day Roadmap');
    expect(aiSlides[0].bgColor).toBe(PPTX_DESIGN_THEMES.find((item) => item.id === 'keynote-spectrum')?.bgColor);

    const financePreset = getPptxDesignPresetPack('cfo-command-center');
    const financeSlides = buildPptxDesignPresetDeck(financePreset.id);
    expect(financePreset.themeId).toBe('finance-terminal');
    expect(financeSlides.map((slide) => slide.title)).toContain('Capital Decisions');

    const qbrPreset = getPptxDesignPresetPack('customer-value-qbr');
    const qbrSlides = buildPptxDesignPresetDeck(qbrPreset.id);
    expect(qbrPreset.templateId).toBe('customer-qbr');
    expect(qbrSlides.map((slide) => slide.title)).toContain('Value Proof');

    const productPreset = getPptxDesignPresetPack('product-prism-roadmap');
    const productSlides = buildPptxDesignPresetDeck(productPreset.id);
    expect(productPreset.themeId).toBe('product-prism');
    expect(productSlides.map((slide) => slide.title)).toContain('Launch Risks');

    const dealRoomPreset = getPptxDesignPresetPack('deal-room-command');
    const dealRoomSlides = buildPptxDesignPresetDeck(dealRoomPreset.id);
    expect(dealRoomPreset.templateId).toBe('ma-deal-room');
    expect(dealRoomSlides.map((slide) => slide.title)).toContain('Synergy Map');

    const hiringPreset = getPptxDesignPresetPack('talent-hiring-plan');
    const hiringSlides = buildPptxDesignPresetDeck(hiringPreset.id);
    expect(hiringPreset.templateId).toBe('people-hiring-plan');
    expect(hiringSlides.map((slide) => slide.title)).toContain('Offer Decision');

    const brandPreset = getPptxDesignPresetPack('brand-narrative-studio');
    const brandSlides = buildPptxDesignPresetDeck(brandPreset.id);
    expect(brandPreset.themeId).toBe('market-sunrise');
    expect(brandSlides.map((slide) => slide.title)).toContain('Launch Storyboard');

    const compliancePreset = getPptxDesignPresetPack('compliance-command-center');
    const complianceSlides = buildPptxDesignPresetDeck(compliancePreset.id);
    expect(compliancePreset.templateId).toBe('regulatory-compliance-brief');
    expect(complianceSlides.map((slide) => slide.title)).toContain('Control Evidence');

    const impactPreset = getPptxDesignPresetPack('impact-grant-story');
    const impactSlides = buildPptxDesignPresetDeck(impactPreset.id);
    expect(impactPreset.themeId).toBe('customer-aurora');
    expect(impactSlides.map((slide) => slide.title)).toContain('Funding Ask');

    const pricingPreset = getPptxDesignPresetPack('pricing-monetization-lab');
    const pricingSlides = buildPptxDesignPresetDeck(pricingPreset.id);
    expect(pricingPreset.templateId).toBe('pricing-packaging-strategy');
    expect(pricingSlides.map((slide) => slide.title)).toContain('Decision Gate');

    const legalPreset = getPptxDesignPresetPack('legal-matter-command');
    const legalSlides = buildPptxDesignPresetDeck(legalPreset.id);
    expect(legalPreset.themeId).toBe('legal-graphite');
    expect(legalSlides.map((slide) => slide.title)).toContain('Decision & Next Filing');

    const clinicalPreset = getPptxDesignPresetPack('clinical-clear-readout');
    const clinicalSlides = buildPptxDesignPresetDeck(clinicalPreset.id);
    expect(clinicalPreset.templateId).toBe('clinical-trial-readout');
    expect(clinicalSlides.map((slide) => slide.title)).toContain('Endpoint Results');

    const townHallPreset = getPptxDesignPresetPack('town-hall-operating-update');
    const townHallSlides = buildPptxDesignPresetDeck(townHallPreset.id);
    expect(townHallPreset.themeId).toBe('townhall-lime');
    expect(townHallSlides.map((slide) => slide.title)).toContain('Strategy Shifts');

    const eventPreset = getPptxDesignPresetPack('event-sponsor-signal');
    const eventSlides = buildPptxDesignPresetDeck(eventPreset.id);
    expect(eventPreset.templateId).toBe('event-sponsorship-pitch');
    expect(eventSlides.map((slide) => slide.title)).toContain('Activation Plan');
  });

  it('recommends design preset packs from deck content', () => {
    const salesDeck = [
      slide('Enterprise sales close plan', 'Buyer stakeholders, pricing, ROI case, pipeline risk, and close date.'),
      slide('Account objections', 'Handle procurement objections and prove enterprise value.'),
    ];
    const architectureDeck = [
      slide('System architecture', 'API gateway, service integration, reliability controls, observability, and security.'),
      slide('Platform roadmap', 'Service topology, API boundaries, infrastructure priorities, and integration sequencing.'),
    ];
    const aiDeck = [
      slide('AI transformation roadmap', 'LLM agents, automation use cases, model governance, adoption, and guardrails.'),
      slide('Workflow strategy', 'Prioritize use case portfolio, data readiness, and risk controls.'),
    ];
    const securityDeck = [
      slide('Security incident review', 'SEV-2 timeline, containment, root cause, blast radius, and remediation owners.'),
      slide('Trust communications', 'Customer privacy impact, notification plan, and verification evidence.'),
    ];
    const okrDeck = [
      slide('Monthly OKR operating review', 'Objective scorecard, key result blockers, owner commitments, and decision log.'),
      slide('Leadership commitments', 'Weekly operating cadence with escalation and evidence review.'),
    ];
    const financeDeck = [
      slide('CFO financial review', 'P&L variance, runway, cash, margin, budget, and forecast decisions.'),
      slide('Capital planning', 'Revenue forecast and OpEx tradeoffs for leadership approval.'),
    ];
    const qbrDeck = [
      slide('Customer QBR', 'Renewal, adoption, account health, expansion, and value outcomes.'),
      slide('Customer success plan', 'Stakeholder commitments and next quarter success metrics.'),
    ];
    const productDeck = [
      slide('Product roadmap review', 'Customer evidence, prioritization, launch risk, feature tradeoffs, and release decisions.'),
      slide('Backlog strategy', 'Product discovery signals and adoption confidence.'),
    ];
    const dealRoomDeck = [
      slide('M&A deal approval', 'Acquisition target, diligence red flags, synergy model, valuation, integration, and board approval.'),
      slide('Transaction decision', 'Deal thesis with integration owners and risk mitigations.'),
    ];
    const hiringDeck = [
      slide('Hiring plan', 'Headcount, role scorecard, candidate calibration, interview funnel, offer, and compensation.'),
      slide('Talent decision', 'Hiring manager debrief and closing owner.'),
    ];
    const brandDeck = [
      slide('Brand narrative system', 'Audience truth, message house, creative system, campaign launch, and storyboard.'),
      slide('Positioning proof', 'Brand voice, proof standards, and creative rules.'),
    ];
    const complianceDeck = [
      slide('Regulatory compliance audit', 'Control evidence, obligation map, policy gaps, remediation deadline, and attestation risk.'),
      slide('Governance controls', 'Audit owners and compliance proof for regulatory review.'),
    ];
    const impactDeck = [
      slide('Nonprofit grant proposal', 'Community need, funder priorities, program outcomes, budget, and impact measurement.'),
      slide('Funding ask', 'Mission, beneficiaries served, donor reporting, and renewal path.'),
    ];
    const pricingDeck = [
      slide('Pricing and packaging strategy', 'Price tiers, monetization, ARPA lift, churn risk, segment willingness, and launch scenario.'),
      slide('Package decision', 'Packaging architecture, package limits, revenue impact, and rollback threshold.'),
    ];
    const legalDeck = [
      slide('Legal matter briefing', 'Claim map, defense posture, evidence register, exposure model, privilege, and filing deadline.'),
      slide('Counsel decision', 'Settle or litigate with matter risk and next filing owner.'),
    ];
    const clinicalDeck = [
      slide('Clinical trial readout', 'Patient cohort, protocol, primary endpoint, safety watch, adverse events, and regulatory submission.'),
      slide('Medical evidence', 'Study result interpretation and healthcare decision path.'),
    ];
    const townHallDeck = [
      slide('All hands town hall', 'Company scoreboard, employee questions, operating principles, strategy shifts, culture, and commitments.'),
      slide('Team operating update', 'Leadership commitments and next rhythm for every team.'),
    ];
    const eventDeck = [
      slide('Event sponsorship pitch', 'Sponsor audience, activation plan, package matrix, attendee leads, reach, ROI, and renewal reporting.'),
      slide('Sponsor value', 'Booth inventory, brand fit, audience profile, and NPS proof.'),
    ];
    const genericDeck = [slide('Untitled', 'A short general presentation.')];

    expect(recommendPptxDesignPresetPacks(salesDeck, 1)[0].preset.id).toBe('sales-close-plan');
    expect(recommendPptxDesignPresetPacks(architectureDeck, 1)[0].preset.id).toBe('blueprint-architecture');
    expect(recommendPptxDesignPresetPacks(aiDeck, 1)[0].preset.id).toBe('ai-transformation-roadmap');
    expect(recommendPptxDesignPresetPacks(securityDeck, 1)[0].preset.id).toBe('security-war-room');
    expect(recommendPptxDesignPresetPacks(okrDeck, 1)[0].preset.id).toBe('okr-ops-review');
    expect(recommendPptxDesignPresetPacks(financeDeck, 1)[0].preset.id).toBe('cfo-command-center');
    expect(recommendPptxDesignPresetPacks(qbrDeck, 1)[0].preset.id).toBe('customer-value-qbr');
    expect(recommendPptxDesignPresetPacks(productDeck, 1)[0].preset.id).toBe('product-prism-roadmap');
    expect(recommendPptxDesignPresetPacks(dealRoomDeck, 1)[0].preset.id).toBe('deal-room-command');
    expect(recommendPptxDesignPresetPacks(hiringDeck, 1)[0].preset.id).toBe('talent-hiring-plan');
    expect(recommendPptxDesignPresetPacks(brandDeck, 1)[0].preset.id).toBe('brand-narrative-studio');
    expect(recommendPptxDesignPresetPacks(complianceDeck, 1)[0].preset.id).toBe('compliance-command-center');
    expect(recommendPptxDesignPresetPacks(impactDeck, 1)[0].preset.id).toBe('impact-grant-story');
    expect(recommendPptxDesignPresetPacks(pricingDeck, 1)[0].preset.id).toBe('pricing-monetization-lab');
    expect(recommendPptxDesignPresetPacks(legalDeck, 1)[0].preset.id).toBe('legal-matter-command');
    expect(recommendPptxDesignPresetPacks(clinicalDeck, 1)[0].preset.id).toBe('clinical-clear-readout');
    expect(recommendPptxDesignPresetPacks(townHallDeck, 1)[0].preset.id).toBe('town-hall-operating-update');
    expect(recommendPptxDesignPresetPacks(eventDeck, 1)[0].preset.id).toBe('event-sponsor-signal');
    expect(recommendPptxDesignPresetPacks(genericDeck, 3)).toHaveLength(3);
    expect(scorePptxDesignPresetPack(getPptxDesignPresetPack('sales-close-plan'), salesDeck)).toBeGreaterThan(0);
  });
});
