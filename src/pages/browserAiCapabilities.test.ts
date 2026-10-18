import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AI_CAPABILITIES,
  capabilitiesByGroup,
  formatCapabilities,
} from './browserAiCapabilities';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const readSource = (...parts: string[]) => readFileSync(resolve(TEST_DIR, ...parts), 'utf8');
const ASIDE_AGENT_SOURCE = readSource('browser', 'AsideAgentPane.tsx');
const ASIDE_SKILLS_SOURCE = readSource('browser', 'AsideSkillsPane.tsx');
const BROWSER_AI_UI_SOURCE = `${ASIDE_AGENT_SOURCE}\n${ASIDE_SKILLS_SOURCE}`;

// The tool ids the agent actually registers (kept for capability descriptions).
const REAL_TOOL_IDS = new Set([
  'browser_navigate', 'browser_dom', 'browser_snapshot', 'browser_eval', 'browser_click',
  'browser_type', 'browser_console', 'browser_network', 'browser_html', 'browser_text',
  'browser_inspect', 'browser_reverse_engineer', 'browser_design_skill', 'browser_see', 'browser_scaffold_clone',
  'browser_fill_form', 'browser_select', 'browser_press_key', 'browser_batch', 'browser_history', 'browser_check_access',
  'browser_help', 'browser_a11y', 'browser_translate', 'browser_diagnose', 'browser_perf', 'browser_audit',
  'browser_extract', 'browser_watch', 'browser_consent', 'browser_find_click', 'browser_load_more',
  'browser_export', 'browser_links', 'browser_wait_for',
  'file_read', 'file_write', 'file_edit', 'search_code', 'file_list', 'run_command',
]);

describe('AI_CAPABILITIES', () => {
  // 정상: every capability is well-formed and bilingual.
  it('has complete, bilingual metadata for each capability', () => {
    for (const c of AI_CAPABILITIES) {
      expect(c.id).toBeTruthy();
      expect(c.title && c.titleKo).toBeTruthy();
      expect(c.summary && c.summaryKo).toBeTruthy();
      expect(c.example).toBeTruthy();
    }
  });

  // 변조 방지: capability ids are unique.
  it('has unique capability ids', () => {
    const ids = AI_CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // 매핑: every backing tool id is a REAL registered tool (catches drift).
  it('references only real, registered tools', () => {
    for (const c of AI_CAPABILITIES) {
      if (c.tool) expect(REAL_TOOL_IDS.has(c.tool)).toBe(true);
    }
  });

  it('documents the added AI-browser comparison, page QA, planning, forms, shopping, and research workflows', () => {
    const ids = new Set(AI_CAPABILITIES.map((c) => c.id));
    expect(ids.has('tab-compare')).toBe(true);
    expect(ids.has('research-brief')).toBe(true);
    expect(ids.has('page-qa')).toBe(true);
    expect(ids.has('action-plan')).toBe(true);
    expect(ids.has('form-helper')).toBe(true);
    expect(ids.has('shop-check')).toBe(true);
    expect(formatCapabilities(false)).toContain('Compare tabs');
    expect(formatCapabilities(false)).toContain('Research brief');
    expect(formatCapabilities(false)).toContain('Ask this page');
    expect(formatCapabilities(false)).toContain('Action planning');
    expect(formatCapabilities(false)).toContain('Form helper');
    expect(formatCapabilities(false)).toContain('Shop check');
  });
});

describe('AI browser sidebar coverage', () => {
  const visibleCoverage: Array<{ id: string; labels: string[] }> = [
    { id: 'page-qa', labels: ['Ask page', 'Ask This Page', 'Cite the section'] },
    { id: 'action-plan', labels: ['Action plan', 'Action Plan', 'Act safely', 'before taking any action'] },
    { id: 'form-helper', labels: ['Form helper', 'Form Helper', 'without submitting'] },
    { id: 'shop-check', labels: ['Shop check', 'Shop Smart', 'savvy shopper'] },
    { id: 'tab-compare', labels: ['Compare tabs', 'Compare Tabs', 'mentioned tabs'] },
    { id: 'research-brief', labels: ['Research brief', 'Research Brief', 'open questions'] },
    { id: 'links', labels: ['Link map', 'Link Map', 'navigation targets'] },
    { id: 'load-more', labels: ['Load all', 'Load Full List', 'Stop when the list no longer grows'] },
    { id: 'export', labels: ['Export CSV', 'Export Data', 'CSV or JSON export'] },
    { id: 'watch', labels: ['Watch changes', 'Watch Changes', 'change snapshot'] },
    { id: 'consent', labels: ['Dismiss cookies', 'Dismiss Consent', 'least data-sharing option'] },
  ];

  it('keeps the flagship AI capabilities visible in presets, workflows, or browser skills', () => {
    const ids = new Set(AI_CAPABILITIES.map((c) => c.id));
    for (const { id, labels } of visibleCoverage) {
      expect(ids.has(id)).toBe(true);
      for (const label of labels) expect(BROWSER_AI_UI_SOURCE).toContain(label);
    }
  });

  it('keeps safe action workflows approval-oriented instead of auto-submitting', () => {
    expect(ASIDE_AGENT_SOURCE).toContain('Do not click, type, submit, purchase, or sign in until I approve');
    expect(ASIDE_SKILLS_SOURCE).toContain('without submitting');
  });
});

describe('capabilitiesByGroup', () => {
  it('groups in stable order and drops empty groups', () => {
    const groups = capabilitiesByGroup();
    expect(groups.length).toBeGreaterThan(0);
    // Every returned group is non-empty and every capability appears exactly once.
    const flat = groups.flatMap((g) => g.items);
    expect(flat).toHaveLength(AI_CAPABILITIES.length);
    for (const g of groups) expect(g.items.length).toBeGreaterThan(0);
  });
});

describe('formatCapabilities', () => {
  // 정상 + 매핑: EN and KO help text include headings and examples.
  it('renders bilingual help text', () => {
    const en = formatCapabilities(false);
    expect(en).toContain('BBARIT AI Browser capabilities');
    expect(en).toContain('## Understand');
    expect(en).toContain('browser_see');
    expect(en).toContain('e.g.');

    const ko = formatCapabilities(true);
    expect(ko).toContain('BBARIT AI 브라우저 기능');
    expect(ko).toContain('## 이해');
    expect(ko).toContain('역공학');
  });
});
