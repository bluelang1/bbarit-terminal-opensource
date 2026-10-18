#!/usr/bin/env node
// octo-code-graph — lightweight, dependency-free code-intelligence CLI.
//
// Strengths harvested from DeusData/codebase-memory-mcp (knowledge-graph idea:
// Function/Class nodes + CALLS edges; trace_path / detect_changes / architecture),
// reimplemented as a terminal CLI over ripgrep + git so the Broker Agent's
// developer/reviewer can run structural queries WITHOUT an MCP server or binary.
//
// Usage:
//   node octo-code-graph.mjs arch                 # codebase overview (langs, symbols, hotspots)
//   node octo-code-graph.mjs defs <name>          # where a symbol is defined
//   node octo-code-graph.mjs callers <name>       # who calls this function (call graph, inbound)
//   node octo-code-graph.mjs impact               # git diff -> changed symbols + blast radius
//   node octo-code-graph.mjs impact --staged      # use staged diff
//
// No knowledge graph is persisted; queries run on demand. Approximate (regex/AST-lite)
// but token-cheap: one query replaces dozens of grep/read cycles.

import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const IGNORE = ['.git', 'node_modules', 'dist', 'build', 'target', '.next', 'out', 'vendor', 'vendored', '.venv', '__pycache__'];

// ── ripgrep wrapper (falls back to git grep is out of scope; rg is required) ──
function rg(args) {
  const base = ['--no-heading', '--line-number', '--color', 'never'];
  for (const i of IGNORE) base.push('--glob', `!${i}/**`);
  // Explicit search path '.' is REQUIRED: with a non-TTY stdin (as under spawnSync)
  // ripgrep searches stdin instead of the directory unless a path is given.
  const r = spawnSync('rg', [...base, ...args, '.'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    if (r.error.code === 'ENOENT') { console.error('ripgrep (rg) not found. Install ripgrep.'); process.exit(2); }
    return [];
  }
  if (!r.stdout) return [];
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (!m) return null;
    const file = m[1].replace(/^\.[\\/]/, '').replace(/\\/g, '/');
    return { file, line: Number(m[2]), text: m[3] };
  }).filter(Boolean);
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '') : '';
}

// Definition patterns across the common languages of this codebase universe.
const DEF_PATTERNS = (name) => {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    // JS/TS: function foo / const foo = ( / foo( ) { / class foo / foo: function / foo = async
    `\\b(function\\*?|class|interface|type|enum)\\s+${n}\\b`,
    `\\b(const|let|var)\\s+${n}\\s*[=:]`,
    `\\b${n}\\s*[=:]\\s*(async\\s*)?(\\([^)]*\\)|function)`,
    `\\b${n}\\s*\\([^)]*\\)\\s*(:[^={]+)?\\{`,
    // Rust / Go / Python / C: fn foo / func foo / def foo / type foo
    `\\b(fn|func|def|struct|impl|trait|mod)\\s+${n}\\b`,
  ];
};

function findDefs(name) {
  const out = [];
  for (const pat of DEF_PATTERNS(name)) {
    for (const hit of rg(['-e', pat])) out.push(hit);
  }
  // dedup by file:line
  const seen = new Set();
  return out.filter((h) => { const k = `${h.file}:${h.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function findCallers(name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // calls look like `name(` but not a definition of name
  const hits = rg(['-e', `\\b${n}\\s*\\(`]);
  const defLines = new Set(findDefs(name).map((d) => `${d.file}:${d.line}`));
  return hits.filter((h) => {
    if (defLines.has(`${h.file}:${h.line}`)) return false;
    // skip obvious definitions on the line
    if (/\b(function|fn|func|def|class)\b/.test(h.text) && new RegExp(`\\b(function|fn|func|def|class)\\s+${n}\\b`).test(h.text)) return false;
    return true;
  });
}

function langOf(file) {
  const ext = (file.split('.').pop() || '').toLowerCase();
  const map = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', rs: 'Rust', py: 'Python', go: 'Go', java: 'Java', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cs: 'C#', rb: 'Ruby', php: 'PHP', kt: 'Kotlin', swift: 'Swift' };
  return map[ext] || ext.toUpperCase() || 'other';
}

// ── commands ──
function cmdArch() {
  const files = git(['ls-files']).split('\n').filter(Boolean).filter((f) => !IGNORE.some((i) => f.startsWith(i + '/') || f.includes('/' + i + '/')));
  const byLang = {};
  for (const f of files) { const l = langOf(f); byLang[l] = (byLang[l] || 0) + 1; }
  // symbol counts + hotspots from a single function-def scan
  const fnHits = rg(['-e', '\\b(function|fn|func|def)\\s+\\w+']);
  const classHits = rg(['-e', '\\b(class|struct|interface|trait|impl)\\s+\\w+']);
  const perFile = {};
  for (const h of fnHits) perFile[h.file] = (perFile[h.file] || 0) + 1;
  const hotspots = Object.entries(perFile).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('# Architecture overview\n');
  console.log(`files: ${files.length}`);
  console.log('languages: ' + Object.entries(byLang).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', '));
  console.log(`approx function defs: ${fnHits.length}`);
  console.log(`approx type/class defs: ${classHits.length}`);
  // routes (HTTP) — common frameworks
  const routes = rg(['-e', `\\b(app|router|r)\\.(get|post|put|delete|patch)\\s*\\(`, '-e', `#\\[(get|post|put|delete|patch)\\(`]).slice(0, 15);
  if (routes.length) { console.log(`\nHTTP routes (sample ${routes.length}):`); for (const r of routes) console.log(`  ${r.file}:${r.line}  ${r.text.trim().slice(0, 80)}`); }
  console.log('\nHotspots (most function defs):');
  for (const [f, c] of hotspots) console.log(`  ${c.toString().padStart(4)}  ${f}`);
}

function cmdDefs(name) {
  if (!name) { console.error('usage: defs <name>'); process.exit(1); }
  const defs = findDefs(name);
  if (!defs.length) { console.log(`No definitions found for "${name}".`); return; }
  console.log(`# Definitions of "${name}" (${defs.length})\n`);
  for (const d of defs) console.log(`  ${d.file}:${d.line}  ${d.text.trim().slice(0, 100)}`);
}

function cmdCallers(name) {
  if (!name) { console.error('usage: callers <name>'); process.exit(1); }
  const callers = findCallers(name);
  if (!callers.length) { console.log(`No callers found for "${name}" (maybe dead code, or a different name).`); return; }
  const byFile = {};
  for (const c of callers) (byFile[c.file] = byFile[c.file] || []).push(c);
  console.log(`# Callers of "${name}" — ${callers.length} call site(s) in ${Object.keys(byFile).length} file(s)\n`);
  for (const [f, list] of Object.entries(byFile)) {
    console.log(`  ${f}`);
    for (const c of list.slice(0, 8)) console.log(`    :${c.line}  ${c.text.trim().slice(0, 90)}`);
  }
}

function cmdImpact(staged) {
  const diffArgs = staged ? ['diff', '--staged', '--unified=0'] : ['diff', '--unified=0'];
  let diff = git(diffArgs);
  if (!diff.trim()) { git(['add', '-N', '.']); diff = git(staged ? ['diff', '--staged', '--unified=0'] : ['diff', '--unified=0']); }
  if (!diff.trim()) { console.log('No working changes (git diff empty).'); return; }
  // collect changed files + symbol names from hunk headers `@@ ... @@ <context>` and added/removed def lines
  const files = new Set();
  const symbols = new Set();
  let curFile = null;
  for (const line of diff.split('\n')) {
    const fm = line.match(/^\+\+\+ b\/(.+)$/);
    if (fm) { curFile = fm[1]; files.add(curFile); continue; }
    // def added/removed → that symbol changed
    const dm = line.match(/^[+-].*\b(function\*?|fn|func|def|class|interface|type|enum|struct|trait|const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (dm) symbols.add(dm[2]);
    const am = line.match(/^[+-]\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(async\s*)?(\(|function)/);
    if (am) symbols.add(am[1]);
    // hunk header context often names the enclosing function
    const hm = line.match(/^@@.*@@\s*.*\b([A-Za-z_$][\w$]*)\s*\(/);
    if (hm) symbols.add(hm[1]);
  }
  console.log(`# Impact / blast radius\n`);
  console.log(`changed files (${files.size}):`);
  for (const f of files) console.log(`  ${f}`);
  const syms = [...symbols].filter((s) => s.length > 2).slice(0, 25);
  if (!syms.length) { console.log('\nNo changed symbols detected from the diff.'); return; }
  console.log(`\nchanged symbols (${syms.length}): ${syms.join(', ')}\n`);
  console.log('blast radius (who else calls each changed symbol):');
  for (const s of syms) {
    const callers = findCallers(s).filter((c) => !files.has(c.file)); // external callers
    const risk = callers.length === 0 ? 'low' : callers.length <= 3 ? 'medium' : 'HIGH';
    console.log(`  [${risk}] ${s} — ${callers.length} external call site(s)`);
    for (const c of callers.slice(0, 5)) console.log(`        ${c.file}:${c.line}`);
  }
}

// ── main ──
const [cmd, ...rest] = process.argv.slice(2);
const arg = rest.find((a) => !a.startsWith('--'));
const staged = rest.includes('--staged');
switch (cmd) {
  case 'arch': cmdArch(); break;
  case 'defs': cmdDefs(arg); break;
  case 'callers': cmdCallers(arg); break;
  case 'impact': cmdImpact(staged); break;
  default:
    console.log('octo-code-graph — structural code intelligence (CLI, no MCP)\n');
    console.log('commands:');
    console.log('  arch                codebase overview (languages, symbols, routes, hotspots)');
    console.log('  defs <name>         where a symbol is defined');
    console.log('  callers <name>      who calls this function (call graph, inbound)');
    console.log('  impact [--staged]   git diff -> changed symbols + blast radius (for reviewers)');
    process.exit(cmd ? 1 : 0);
}
