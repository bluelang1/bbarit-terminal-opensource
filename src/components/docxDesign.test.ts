import { describe, expect, it } from 'vitest';
import {
  DOCX_DESIGN_THEMES,
  DOCX_DESIGN_PRESET_PACKS,
  DOCX_TEMPLATES,
  analyzeDocxHtml,
  buildDocxActionPlanHtml,
  buildDocxApprovalPackHtml,
  buildDocxBrief,
  buildDocxBriefPanelHtml,
  buildDocxCitationPackHtml,
  buildDocxDesignPresetHtml,
  buildDocxNegotiationPack,
  buildDocxNegotiationPackHtml,
  buildDocxQualityPanelHtml,
  buildDocxRedlinePackHtml,
  buildDocxReviewPackHtml,
  buildDocxStrategyPack,
  buildDocxStrategyPackHtml,
  buildDocxTableOfContentsHtml,
  cleanDocxHtml,
  cssColorToDocxHex,
  cssLengthToHalfPoints,
  docxImageTypeFromMime,
  fontSizeAttrToHalfPoints,
  parseDataUrl,
  extractDocxActionItems,
  extractDocxEvidenceSignals,
  extractDocxRedlineSuggestions,
  extractDocxRiskSignals,
  extractDocxOutline,
  buildDocxTemplateHtml,
  getDocxDesignPresetPack,
  getDocxDesignTheme,
  getDocxTemplate,
  applyDocxThemeToHtml,
  polishDocxHtml,
  recommendDocxDesignPresetPacks,
  scoreDocxDesignPresetPack,
  DOCX_FONT_SIZE_PT_PRESETS,
  DOCX_FONT_FAMILIES,
  DOCX_QUICK_STYLES,
  ptToHalfPoints,
  cssFontFamilyToDocx,
  docxQuickStyleBlock,
} from './docxDesign';

describe('docx design helpers', () => {
  it('returns safe fallbacks for missing themes and templates', () => {
    expect(getDocxDesignTheme('missing').id).toBe(DOCX_DESIGN_THEMES[0].id);
    expect(getDocxTemplate('missing').id).toBe('business-proposal');
  });

  it('builds themed document templates', () => {
    const html = buildDocxTemplateHtml('technical-report', 'proposal-modern');

    expect(html).toContain('Technical Report');
    expect(html).toContain('Problem Statement');
    expect(html).toContain('color:#064e3b');
    expect(html).toContain('border:1px solid #0d9488');
  });

  it('includes richer professional themes and templates', () => {
    expect(DOCX_DESIGN_THEMES.length).toBeGreaterThanOrEqual(9);
    expect(DOCX_TEMPLATES.length).toBeGreaterThanOrEqual(11);
    expect(getDocxTemplate('product-requirements').html).toContain('Acceptance Criteria');
    expect(getDocxTemplate('contract-review').html).toContain('Fallbacks');
    expect(getDocxTemplate('board-decision-pack').html).toContain('Approval Log');
    expect(getDocxTemplate('policy-sop-manual').html).toContain('Controls & Audit Trail');
    expect(getDocxTemplate('customer-case-study').html).toContain('Proof Assets');
  });

  it('builds product and editorial templates with matching themes', () => {
    const prd = buildDocxTemplateHtml('product-requirements', 'product-spec');
    const release = buildDocxTemplateHtml('press-release', 'editorial-release');

    expect(prd).toContain('Product Requirements Document');
    expect(prd).toContain('color:#1d4ed8');
    expect(release).toContain('Press Release Headline');
    expect(release).toContain('color:#7f1d1d');
  });

  it('provides one-click design preset packs and smart recommendations', () => {
    expect(DOCX_DESIGN_PRESET_PACKS.length).toBeGreaterThanOrEqual(11);

    const prdPreset = getDocxDesignPresetPack('product-prd-blueprint');
    const prdHtml = buildDocxDesignPresetHtml(prdPreset.id);
    expect(prdPreset.templateId).toBe('product-requirements');
    expect(prdHtml).toContain('Product Requirements Document');
    expect(prdHtml).toContain('color:#1d4ed8');

    const productDoc = '<h1>Feature PRD</h1><p>The product requirement defines user stories, launch risk, and acceptance criteria.</p>';
    const legalDoc = '<h1>Contract Memo</h1><p>The agreement has liability, termination, privacy, and compliance clauses.</p>';
    const boardDoc = '<h1>Board approval memo</h1><p>The board must approve the recommendation, decision rule, mitigations, and governance conditions.</p>';
    const sopDoc = '<h1>SOP</h1><p>The policy defines procedure, compliance controls, audit evidence, exceptions, and responsibilities.</p>';
    const customerDoc = '<h1>Customer case study</h1><p>The customer challenge, solution, proof, quote, outcome metrics, and adoption story are ready.</p>';
    const genericDoc = '<p>Short memo.</p>';

    expect(recommendDocxDesignPresetPacks(productDoc, 1)[0].preset.id).toBe('product-prd-blueprint');
    expect(recommendDocxDesignPresetPacks(legalDoc, 1)[0].preset.id).toBe('legal-contract-review');
    expect(recommendDocxDesignPresetPacks(boardDoc, 1)[0].preset.id).toBe('board-decision-paper');
    expect(recommendDocxDesignPresetPacks(sopDoc, 1)[0].preset.id).toBe('compliance-sop-manual');
    expect(recommendDocxDesignPresetPacks(customerDoc, 1)[0].preset.id).toBe('customer-proof-story');
    expect(recommendDocxDesignPresetPacks(genericDoc, 3)).toHaveLength(3);
    expect(scoreDocxDesignPresetPack(prdPreset, productDoc)).toBeGreaterThan(0);
  });

  it('builds board, compliance, and customer proof presets with matching themes', () => {
    const boardPreset = getDocxDesignPresetPack('board-decision-paper');
    const boardHtml = buildDocxDesignPresetHtml(boardPreset.id);
    const sopPreset = getDocxDesignPresetPack('compliance-sop-manual');
    const sopHtml = buildDocxDesignPresetHtml(sopPreset.id);
    const customerPreset = getDocxDesignPresetPack('customer-proof-story');
    const customerHtml = buildDocxDesignPresetHtml(customerPreset.id);

    expect(boardPreset.templateId).toBe('board-decision-pack');
    expect(boardPreset.themeId).toBe('boardroom-paper');
    expect(boardHtml).toContain('Board Decision Pack');
    expect(boardHtml).toContain('color:#0f2a44');
    expect(sopPreset.templateId).toBe('policy-sop-manual');
    expect(sopHtml).toContain('Policy & SOP Manual');
    expect(sopHtml).toContain('color:#14532d');
    expect(customerPreset.themeId).toBe('customer-story');
    expect(customerHtml).toContain('Customer Case Study');
    expect(customerHtml).toContain('color:#6d28d9');
  });

  it('preserves existing inline styles while applying a theme', () => {
    const theme = getDocxDesignTheme('research-paper');
    const html = applyDocxThemeToHtml('<h1 style="margin-top:0">Title</h1><p>Body</p>', theme);

    expect(html).toContain('margin-top:0; color:#312e81');
    expect(html).toContain('font-family:Georgia');
    expect(html).toContain('<p style="color:#1f2937');
  });

  it('audits document structure and quality signals', () => {
    const report = analyzeDocxHtml('<p>This is a brief decision memo with owner and timeline details.</p>');

    expect(report.words).toBeGreaterThan(0);
    expect(report.score).toBeLessThan(100);
    expect(report.issues.some((issue) => issue.message === 'Missing primary title')).toBe(true);
    expect(report.issues.some((issue) => issue.message.includes('Consider a table'))).toBe(true);
  });

  it('builds a quality review panel', () => {
    const report = analyzeDocxHtml('<h1>Title</h1><p>Body copy.</p>');
    const panel = buildDocxQualityPanelHtml(report);

    expect(panel).toContain('Document Quality Review');
    expect(panel).toContain(`Score:</strong> ${report.score}/100`);
    expect(panel).toContain('data-docx-quality');
  });

  it('polishes documents with a title, executive snapshot, quality panel, and theme', () => {
    const theme = getDocxDesignTheme('executive-memo');
    const polished = polishDocxHtml('<p>Revenue is growing but the launch decision needs owner alignment and a risk table.</p>', theme);

    expect(polished).toContain('<h1');
    expect(polished).toContain('Executive snapshot');
    expect(polished).toContain('Document Quality Review');
    expect(polished).toContain('color:#0f172a');
  });

  it('keeps repeated document polish idempotent', () => {
    const theme = getDocxDesignTheme('executive-memo');
    const once = polishDocxHtml('<p>Revenue needs owner alignment and a risk table.</p>', theme);
    const twice = polishDocxHtml(once, theme);

    expect(twice.match(/data-docx-polish/g)).toHaveLength(1);
    expect(twice.match(/data-docx-quality/g)).toHaveLength(1);
  });

  it('extracts outline and builds a document map', () => {
    const html = '<h1>Launch Plan</h1><h2>Risks</h2><p>Body copy.</p><h2>Timeline</h2>';
    const outline = extractDocxOutline(html);
    const toc = buildDocxTableOfContentsHtml(html);

    expect(outline).toEqual([
      { level: 1, text: 'Launch Plan' },
      { level: 2, text: 'Risks' },
      { level: 2, text: 'Timeline' },
    ]);
    expect(toc).toContain('Document Map');
    expect(toc).toContain('data-docx-toc');
  });

  it('keeps assistant sections out of generated maps and action plans', () => {
    const html = [
      '<section data-docx-brief="true"><h2>Document Intelligence Brief</h2><p>Generated summary.</p></section>',
      '<h1>Customer Rollout</h1>',
      '<section data-docx-actions="true"><h2>Action Plan</h2><table><tbody><tr><th>Action</th><th>Owner</th></tr><tr><td>Generated action</td><td>AI</td></tr></tbody></table></section>',
      '<ul><li>Follow-up with support owner</li></ul>',
    ].join('');
    const outline = extractDocxOutline(html);
    const actions = extractDocxActionItems(html);
    const toc = buildDocxTableOfContentsHtml(html);
    const plan = buildDocxActionPlanHtml(html);

    expect(outline).toEqual([{ level: 1, text: 'Customer Rollout' }]);
    expect(actions.map((item) => item.action)).toEqual(['Follow-up with support owner']);
    expect(toc).not.toContain('Document Intelligence Brief');
    expect(toc).not.toContain('Action Plan');
    expect(plan).not.toContain('Generated action');
  });

  it('extracts action items and builds action plans', () => {
    const html = [
      '<h1>Meeting Brief</h1>',
      '<table><tbody><tr><th>Action</th><th>Owner</th><th>Due</th></tr>',
      '<tr><td>Ship forecast view</td><td>Ari</td><td>Friday</td></tr></tbody></table>',
      '<ul><li>Follow-up with design owner</li></ul>',
    ].join('');
    const actions = extractDocxActionItems(html);
    const plan = buildDocxActionPlanHtml(html);

    expect(actions[0]).toMatchObject({ action: 'Ship forecast view', owner: 'Ari', due: 'Friday', source: 'table' });
    expect(actions.some((item) => item.action === 'Follow-up with design owner')).toBe(true);
    expect(plan).toContain('Action Plan');
    expect(plan).toContain('data-docx-actions');
  });

  it('builds a document intelligence brief', () => {
    const html = '<h1>Decision Memo</h1><p>Approve the launch after owner alignment and timeline review.</p>';
    const brief = buildDocxBrief(html);
    const panel = buildDocxBriefPanelHtml(html);

    expect(brief.summary).toContain('Approve the launch');
    expect(brief.outline[0].text).toBe('Decision Memo');
    expect(panel).toContain('Document Intelligence Brief');
    expect(panel).toContain('data-docx-brief');
  });

  it('extracts risk signals and builds an idempotent review pack', () => {
    const html = [
      '<h1>Launch Decision</h1>',
      '<p>The timeline is at risk because the data migration and pricing approval are blocked.</p>',
      '<table><tbody><tr><th>Action</th><th>Owner</th><th>Due</th></tr>',
      '<tr><td>Approve launch budget</td><td>Mina</td><td>Friday</td></tr></tbody></table>',
    ].join('');

    const risks = extractDocxRiskSignals(html);
    const pack = buildDocxReviewPackHtml(html);
    const secondPack = buildDocxReviewPackHtml(`${pack}${html}`);

    expect(risks.some((risk) => risk.category === 'Schedule')).toBe(true);
    expect(risks.some((risk) => risk.category === 'Financial')).toBe(true);
    expect(risks.some((risk) => risk.category === 'Data')).toBe(true);
    expect(pack).toContain('Review Pack');
    expect(pack).toContain('Risk Register');
    expect(pack).toContain('Editorial Checklist');
    expect(pack).toContain('Approve launch budget');
    expect(secondPack.match(/data-docx-review-pack/g)).toHaveLength(1);
  });

  it('builds an approval pack with gates, decision queue, and sign-off matrix', () => {
    const html = [
      '<h1>Launch Approval</h1>',
      '<p>Approve the launch decision after risk review and owner alignment by Friday.</p>',
      '<table><tbody><tr><th>Action</th><th>Owner</th><th>Due</th><th>Status</th></tr>',
      '<tr><td>Approve launch budget</td><td>Mina</td><td>Friday</td><td>Open</td></tr></tbody></table>',
    ].join('');

    const pack = buildDocxApprovalPackHtml(html);
    const secondPack = buildDocxApprovalPackHtml(`${pack}${html}`);

    expect(pack).toContain('Approval Pack');
    expect(pack).toContain('Approval Gates');
    expect(pack).toContain('Decision Queue');
    expect(pack).toContain('Sign-off Matrix');
    expect(pack).toContain('Approve launch budget');
    expect(pack).toContain('Mina');
    expect(pack).toContain('data-docx-approval-pack');
    expect(secondPack.match(/data-docx-approval-pack/g)).toHaveLength(1);
  });

  it('builds an evidence pack with claim checks, source register, and appendix checklist', () => {
    const html = [
      '<h1>Launch Evidence Memo</h1>',
      '<p>Revenue grew 42% in Q4 and this is the fastest workflow in the market.</p>',
      '<p>The privacy and security review must be complete before the launch deadline.</p>',
      '<p>See <a href="https://example.com/dashboard">dashboard export</a> for supporting data.</p>',
    ].join('');

    const signals = extractDocxEvidenceSignals(html);
    const pack = buildDocxCitationPackHtml(html);
    const secondPack = buildDocxCitationPackHtml(`${pack}${html}`);

    expect(signals.some((signal) => signal.evidenceNeed.includes('Quantitative claim'))).toBe(true);
    expect(signals.some((signal) => signal.evidenceNeed.includes('Strong comparative'))).toBe(true);
    expect(signals.some((signal) => signal.recommendedSource.includes('https://example.com/dashboard'))).toBe(true);
    expect(pack).toContain('Evidence Pack');
    expect(pack).toContain('Claim Evidence Matrix');
    expect(pack).toContain('Source Register');
    expect(pack).toContain('Appendix Checklist');
    expect(pack).toContain('dashboard export');
    expect(pack).toContain('data-docx-citation-pack');
    expect(secondPack.match(/data-docx-citation-pack/g)).toHaveLength(1);
  });

  it('builds editorial redline suggestions and an idempotent redline pack', () => {
    const html = [
      '<h1>Launch Decision</h1>',
      '<p>The launch should probably happen very soon because the forecast is good and several teams are blocked by the approval process.</p>',
      '<p>The budget was approved, but the decision still needs review.</p>',
    ].join('');

    const suggestions = extractDocxRedlineSuggestions(html);
    const pack = buildDocxRedlinePackHtml(html);
    const secondPack = buildDocxRedlinePackHtml(`${pack}${html}`);

    expect(suggestions.some((item) => item.reason.includes('Vague'))).toBe(true);
    expect(suggestions.some((item) => item.reason.includes('action language'))).toBe(true);
    expect(suggestions.some((item) => item.reason.includes('owner and timing'))).toBe(true);
    expect(pack).toContain('Editor Redline Pack');
    expect(pack).toContain('Redline Queue');
    expect(pack).toContain('Style Guardrails');
    expect(pack).toContain('data-docx-redline-pack');
    expect(secondPack.match(/data-docx-redline-pack/g)).toHaveLength(1);
  });

  it('builds a document strategy pack with narrative, objections, rewrites, and publish gates', () => {
    const html = [
      '<h1>Launch Approval</h1>',
      '<h2>Decision</h2>',
      '<p>Approve the launch decision by Friday because revenue grew 42% and the forecast is probably very good.</p>',
      '<h2>Risks</h2>',
      '<p>The timeline is at risk because the data migration and pricing approval are blocked.</p>',
      '<table><tbody><tr><th>Action</th><th>Owner</th><th>Due</th></tr>',
      '<tr><td>Approve launch budget</td><td>Mina</td><td>Friday</td></tr></tbody></table>',
    ].join('');

    const strategy = buildDocxStrategyPack(html);
    const pack = buildDocxStrategyPackHtml(html);
    const secondPack = buildDocxStrategyPackHtml(`${pack}${html}`);

    expect(strategy.audience).toBe('Executive approvers');
    expect(strategy.objective).toContain('Launch Approval');
    expect(strategy.recommendedPreset.preset.id).toBe('executive-decision-memo');
    expect(pack).toContain('Document Strategy Pack');
    expect(pack).toContain('Strategic Brief');
    expect(pack).toContain('Narrative Spine');
    expect(pack).toContain('Stakeholder Objections');
    expect(pack).toContain('Rewrite Sprint');
    expect(pack).toContain('Publish Gates');
    expect(pack).toContain('Approve launch budget');
    expect(pack).toContain('data-docx-strategy-pack');
    expect(secondPack.match(/data-docx-strategy-pack/g)).toHaveLength(1);
  });

  it('builds a negotiation pack with issue matrix, fallback ladder, and stakeholder script', () => {
    const html = [
      '<h1>Contract Pricing Approval</h1>',
      '<p>Approve the contract by Friday. The pricing, liability, privacy, and payment terms need review because budget impact is material.</p>',
      '<p>Revenue grew 42% and this is probably the best commercial path.</p>',
      '<table><tbody><tr><th>Action</th><th>Owner</th><th>Due</th></tr>',
      '<tr><td>Negotiate liability cap</td><td>Mina</td><td>Friday</td></tr></tbody></table>',
    ].join('');

    const negotiation = buildDocxNegotiationPack(html);
    const pack = buildDocxNegotiationPackHtml(html);
    const secondPack = buildDocxNegotiationPackHtml(`${pack}${html}`);

    expect(negotiation.posture).toBe('Risk-first negotiation');
    expect(negotiation.issues.some((issue) => /Legal|Financial|Evidence gap/.test(issue.issue))).toBe(true);
    expect(pack).toContain('Negotiation Pack');
    expect(pack).toContain('Issue Matrix');
    expect(pack).toContain('Fallback Ladder');
    expect(pack).toContain('Stakeholder Script');
    expect(pack).toContain('Close Checklist');
    expect(pack).toContain('Mina');
    expect(pack).toContain('data-docx-negotiation-pack');
    expect(secondPack.match(/data-docx-negotiation-pack/g)).toHaveLength(1);
  });

  it('parses base64 image data URLs and rejects non-image or non-base64 sources', () => {
    expect(parseDataUrl('data:image/png;base64,AAAB')).toEqual({ mime: 'image/png', data: 'AAAB' });
    expect(parseDataUrl('data:image/jpeg;base64, QUJD ')).toEqual({ mime: 'image/jpeg', data: 'QUJD' });
    expect(parseDataUrl('data:image/svg+xml,<svg></svg>')).toBeNull();
    expect(parseDataUrl('https://example.com/a.png')).toBeNull();
    expect(parseDataUrl('data:image/png;base64,')).toBeNull();
  });

  it('maps image mime types to docx image types', () => {
    expect(docxImageTypeFromMime('image/png')).toBe('png');
    expect(docxImageTypeFromMime('image/jpeg')).toBe('jpg');
    expect(docxImageTypeFromMime('image/gif')).toBe('gif');
    expect(docxImageTypeFromMime('image/bmp')).toBe('bmp');
    expect(docxImageTypeFromMime('image/webp')).toBe('png');
  });

  it('converts CSS colors to docx hex', () => {
    expect(cssColorToDocxHex('#1d4ed8')).toBe('1D4ED8');
    expect(cssColorToDocxHex('#abc')).toBe('AABBCC');
    expect(cssColorToDocxHex('rgb(37, 99, 235)')).toBe('2563EB');
    expect(cssColorToDocxHex('rgba(255, 0, 0, 0.5)')).toBe('FF0000');
    expect(cssColorToDocxHex('yellow')).toBe('FFFF00');
    expect(cssColorToDocxHex('transparent')).toBeUndefined();
    expect(cssColorToDocxHex('')).toBeUndefined();
  });

  it('converts CSS font sizes and font-size attributes to half-points', () => {
    expect(cssLengthToHalfPoints('16px')).toBe(24); // 16px -> 12pt -> 24 half-points
    expect(cssLengthToHalfPoints('12pt')).toBe(24);
    expect(cssLengthToHalfPoints('1em')).toBe(24);
    expect(cssLengthToHalfPoints('0')).toBeUndefined();
    expect(cssLengthToHalfPoints('auto')).toBeUndefined();
    expect(fontSizeAttrToHalfPoints('5')).toBe(cssLengthToHalfPoints('24px'));
    expect(fontSizeAttrToHalfPoints('9')).toBeUndefined();
  });

  it('converts point sizes to docx half-points', () => {
    expect(ptToHalfPoints(12)).toBe(24);
    expect(ptToHalfPoints(10.5)).toBe(21);
    expect(ptToHalfPoints(72)).toBe(144);
    expect(ptToHalfPoints(0)).toBe(0);
    expect(ptToHalfPoints(-4)).toBe(0);
  });

  it('offers a point-size preset ladder and roundtrips through cssLengthToHalfPoints', () => {
    expect(DOCX_FONT_SIZE_PT_PRESETS).toContain(11);
    expect(DOCX_FONT_SIZE_PT_PRESETS).toContain(72);
    expect(DOCX_FONT_SIZE_PT_PRESETS.every((pt) => pt > 0)).toBe(true);
    // A 12pt preset written as a style must export to the same half-points.
    expect(cssLengthToHalfPoints('12pt')).toBe(ptToHalfPoints(12));
  });

  it('reduces CSS font-family stacks to a Word-resolvable family', () => {
    expect(cssFontFamilyToDocx('Georgia, serif')).toBe('Georgia');
    expect(cssFontFamilyToDocx('"Times New Roman", serif')).toBe('Times New Roman');
    expect(cssFontFamilyToDocx('Arial, sans-serif')).toBe('Arial');
    expect(cssFontFamilyToDocx('"Malgun Gothic", sans-serif')).toBe('Malgun Gothic');
    expect(cssFontFamilyToDocx('serif')).toBeUndefined();
    expect(cssFontFamilyToDocx('system-ui')).toBeUndefined();
    expect(cssFontFamilyToDocx('')).toBeUndefined();
  });

  it('exposes named font families including Korean fonts', () => {
    expect(DOCX_FONT_FAMILIES[0].value).toBe('');
    expect(DOCX_FONT_FAMILIES.some((font) => font.label === '맑은 고딕')).toBe(true);
    expect(DOCX_FONT_FAMILIES.some((font) => cssFontFamilyToDocx(font.value) === 'Georgia')).toBe(true);
  });

  it('maps quick styles to formatBlock tags', () => {
    expect(DOCX_QUICK_STYLES.map((style) => style.id)).toEqual(['body', 'h1', 'h2', 'h3', 'quote', 'code']);
    expect(docxQuickStyleBlock('body')).toBe('p');
    expect(docxQuickStyleBlock('h2')).toBe('h2');
    expect(docxQuickStyleBlock('quote')).toBe('blockquote');
    expect(docxQuickStyleBlock('code')).toBe('pre');
    expect(docxQuickStyleBlock('unknown')).toBe('p');
    expect(DOCX_QUICK_STYLES.every((style) => style.koLabel.length > 0)).toBe(true);
  });

  it('cleans document structure with a title, decision controls, and cleanup summary', () => {
    const theme = getDocxDesignTheme('product-spec');
    const longParagraph = [
      'The launch decision needs owner approval by Friday.',
      'The timeline has risk because data migration is still open.',
      'The team should confirm the support plan before release.',
      'The document includes enough detail for a long paragraph that should be split into readable sections.',
      'The reviewer needs a clear decision table with owner, due date, and status before sign-off.',
      'The final recommendation is to approve after the dependency review and communicate the rollout plan.',
    ].join(' ');
    const dirty = `<p>&nbsp;</p><p> ${longParagraph} ${longParagraph}</p><p><br /></p>`;

    const cleaned = cleanDocxHtml(dirty, theme);

    expect(cleaned).toContain('<h1');
    expect(cleaned).toContain('Decision Controls');
    expect(cleaned).toContain('Clean Room Summary');
    expect(cleaned).toContain('Empty paragraphs removed');
    expect(cleaned).toContain('Long paragraphs split');
    expect(cleaned).toContain('data-docx-clean');
    expect(cleaned).toContain('color:#1d4ed8');
    expect(cleaned).not.toContain('<p>&nbsp;</p>');
  });
});
