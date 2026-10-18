#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const outFile = readArg('--file', '.octo-tmp/browser-ai-capability-audit.json');

function readArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function source(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function extractQuotedSet(text, startMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) return new Set();
  const open = text.indexOf('[', start);
  const close = text.indexOf(']', open);
  if (open < 0 || close < 0) return new Set();
  return new Set([...text.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

function extractCapabilities(text) {
  const bodyStart = text.indexOf('export const AI_CAPABILITIES');
  const open = text.indexOf('[', bodyStart);
  const close = text.indexOf('];', open);
  const body = text.slice(open + 1, close);
  const blocks = [];
  let depth = 0;
  let blockStart = -1;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '{') {
      if (depth === 0) blockStart = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && blockStart >= 0) blocks.push(body.slice(blockStart, i + 1));
    }
  }
  return blocks.map((block) => ({
    id: block.match(/id:\s*'([^']+)'/)?.[1] || '',
    group: block.match(/group:\s*'([^']+)'/)?.[1] || '',
    title: block.match(/title:\s*'([^']+)'/)?.[1] || '',
    tool: block.match(/tool:\s*'([^']+)'/)?.[1] || null,
    example: block.match(/example:\s*'([^']+)'/)?.[1] || '',
  })).filter((c) => c.id);
}

function includesAny(text, values) {
  return values.some((value) => text.includes(value));
}

const capabilitySource = source('src/pages/browserAiCapabilities.ts');
const guardSource = source('src/pages/browserAgentLoopGuard.ts');
const asideAgentSource = source('src/pages/browser/AsideAgentPane.tsx');
const asideSkillsSource = source('src/pages/browser/AsideSkillsPane.tsx');
const browserPageSource = source('src/pages/BrowserPage.tsx');
const packageSource = JSON.parse(source('package.json'));

const capabilities = extractCapabilities(capabilitySource);
const readOnlyTools = extractQuotedSet(guardSource, 'READ_ONLY_TOOLS');
const stateChangingTools = extractQuotedSet(guardSource, 'STATE_CHANGING');
const knownTools = new Set([...readOnlyTools, ...stateChangingTools]);

const requiredVisible = new Map([
  ['page-qa', ['Ask page', 'Ask This Page']],
  ['action-plan', ['Action plan', 'Action Plan', 'Act safely']],
  ['form-helper', ['Form helper', 'Form Helper']],
  ['shop-check', ['Shop check', 'Shop Smart']],
  ['tab-compare', ['Compare tabs', 'Compare Tabs']],
  ['research-brief', ['Research brief', 'Research Brief']],
  ['links', ['Link map', 'Link Map']],
  ['load-more', ['Load all', 'Load Full List']],
  ['export', ['Export CSV', 'Export Data']],
  ['watch', ['Watch changes', 'Watch Changes']],
  ['consent', ['Dismiss cookies', 'Dismiss Consent']],
]);
const uiSurface = `${asideAgentSource}\n${asideSkillsSource}`;

const checks = [];
const fail = (name, details = {}) => checks.push({ name, ok: false, ...details });
const pass = (name, details = {}) => checks.push({ name, ok: true, ...details });

const ids = capabilities.map((c) => c.id);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
duplicateIds.length ? fail('capability ids are unique', { duplicateIds }) : pass('capability ids are unique', { count: ids.length });

const groups = new Set(capabilities.map((c) => c.group));
const expectedGroups = ['understand', 'act', 'create', 'memory', 'resilience'];
const missingGroups = expectedGroups.filter((g) => !groups.has(g));
missingGroups.length ? fail('capability groups cover the browser lifecycle', { missingGroups }) : pass('capability groups cover the browser lifecycle', { groups: expectedGroups });

const toolBacked = capabilities.filter((c) => c.tool);
const unknownTools = toolBacked.filter((c) => !knownTools.has(c.tool));
unknownTools.length ? fail('tool-backed capabilities reference registered browser tools', { unknownTools }) : pass('tool-backed capabilities reference registered browser tools', { toolBacked: toolBacked.length });

const missingVisible = [];
for (const [id, labels] of requiredVisible) {
  if (!ids.includes(id)) missingVisible.push({ id, reason: 'missing capability id' });
  else if (!includesAny(uiSurface, labels)) missingVisible.push({ id, reason: 'missing sidebar label', labels });
}
missingVisible.length ? fail('flagship AI browser capabilities are visible in the sidebar', { missingVisible }) : pass('flagship AI browser capabilities are visible in the sidebar', { count: requiredVisible.size });

browserPageSource.includes('SENSITIVE_TASK_RE') && browserPageSource.includes('setPendingAgentTask(task)')
  ? pass('sensitive browser tasks are gated before agent execution')
  : fail('sensitive browser tasks are gated before agent execution');

asideAgentSource.includes('Do not click, type, submit, purchase, or sign in until I approve') && asideSkillsSource.includes('without submitting')
  ? pass('safe action prompts avoid silent submission')
  : fail('safe action prompts avoid silent submission');

packageSource.scripts?.['browser:verify']?.includes('browser:platform-audit') && packageSource.scripts?.['mac:browser-agent:verify'] && packageSource.scripts?.['win:browser-agent:verify']
  ? pass('macOS and Windows browser verification gates are exposed')
  : fail('macOS and Windows browser verification gates are exposed');

const report = {
  ok: checks.every((c) => c.ok),
  generatedAt: new Date().toISOString(),
  capabilities: {
    total: capabilities.length,
    toolBacked: toolBacked.length,
    groups: Object.fromEntries(expectedGroups.map((g) => [g, capabilities.filter((c) => c.group === g).length])),
  },
  tools: {
    readOnly: readOnlyTools.size,
    stateChanging: stateChangingTools.size,
    known: knownTools.size,
  },
  checks,
};

mkdirSync(dirname(resolve(root, outFile)), { recursive: true });
writeFileSync(resolve(root, outFile), JSON.stringify(report, null, 2) + '\n');
console.log(resolve(root, outFile));
if (!report.ok) {
  for (const check of checks.filter((c) => !c.ok)) console.error(`FAIL ${check.name}`);
  process.exit(1);
}
