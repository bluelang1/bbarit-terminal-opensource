#!/usr/bin/env node

const BRIDGE_URL = process.env.OCTO_BRIDGE_URL || 'http://127.0.0.1:19980';

function usage(exitCode = 0) {
  const text = `
octo-code-search

Usage:
  node scripts/octo-code-search.mjs search "query" [root] [--mode hybrid|semantic|bm25] [-k 8] [--docs] [--json]
  node scripts/octo-code-search.mjs related <file_path> <line> [root] [-k 8] [--docs] [--json]
  node scripts/octo-code-search.mjs stats [root] [--docs] [--json]
  node scripts/octo-code-search.mjs savings [--json]
  node scripts/octo-code-search.mjs clear [root]

Requires BBARIT Terminal to be running so the local bridge is available at ${BRIDGE_URL}.
`;
  (exitCode === 0 ? process.stdout : process.stderr).write(text.trimStart());
  process.exit(exitCode);
}

function takeFlag(args, flag, fallback = false) {
  const idx = args.indexOf(flag);
  if (idx < 0) return fallback;
  args.splice(idx, 1);
  return true;
}

function takeValue(args, flags, fallback = undefined) {
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx >= 0) {
      const value = args[idx + 1];
      args.splice(idx, 2);
      return value ?? fallback;
    }
    const prefix = `${flag}=`;
    const eqIdx = args.findIndex((arg) => arg.startsWith(prefix));
    if (eqIdx >= 0) {
      const value = args[eqIdx].slice(prefix.length);
      args.splice(eqIdx, 1);
      return value || fallback;
    }
  }
  return fallback;
}

async function invokeOcto(command, args = {}) {
  const resp = await fetch(`${BRIDGE_URL}/api/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, args }),
  });
  if (!resp.ok) throw new Error(`Bridge HTTP ${resp.status}: ${resp.statusText}`);
  const json = await resp.json();
  if (!json.success) throw new Error(json.error || 'Unknown bridge error');
  return json.data;
}

function formatResultHeader(result, index) {
  const loc = `${result.file_path}:${result.start_line}-${result.end_line}`;
  const score = Number(result.score || 0).toFixed(3);
  const source = result.source || 'search';
  const language = result.language || 'text';
  return `## ${index}. ${loc}  [score=${score}, ${source}, ${language}]`;
}

function formatResults(title, results) {
  if (!Array.isArray(results) || results.length === 0) return `${title}\n\nNo results found.\n`;
  const lines = [title, ''];
  results.forEach((result, idx) => {
    lines.push(formatResultHeader(result, idx + 1));
    lines.push('```');
    lines.push(String(result.snippet || '').trim());
    lines.push('```');
    lines.push('');
  });
  return lines.join('\n');
}

function formatStats(stats) {
  const languages = Object.entries(stats.languages || {})
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => `${lang}: ${count}`)
    .join(', ');
  return [
    `Root: ${stats.root || ''}`,
    `Indexed files: ${stats.indexed_files}`,
    `Chunks: ${stats.total_chunks}`,
    `Files scanned: ${stats.files_scanned}`,
    `Include docs: ${stats.include_text_files ? 'yes' : 'no'}`,
    `Languages: ${languages || '(none)'}`,
  ].join('\n') + '\n';
}

function formatSavings(savings) {
  if (!savings || !savings.calls) return 'No stats yet. Run a search first.\n';
  return [
    `Calls: ${savings.calls}`,
    `Snippet chars: ${savings.snippet_chars}`,
    `File chars: ${savings.file_chars}`,
    `Saved tokens: ~${savings.saved_tokens}`,
    `Saved percent: ${savings.saved_percent}%`,
  ].join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '-h' || command === '--help') usage(0);

  const json = takeFlag(args, '--json');
  const includeTextFiles = takeFlag(args, '--docs') || takeFlag(args, '--include-text-files');
  const topKRaw = takeValue(args, ['-k', '--top-k'], '8');
  const limit = Math.max(1, Math.min(50, Number.parseInt(String(topKRaw), 10) || 8));

  try {
    if (command === 'search') {
      const mode = takeValue(args, ['-m', '--mode'], 'bm25');
      const query = args.shift();
      const root = args.shift() || process.cwd();
      if (!query) usage(1);
      const results = await invokeOcto('code_search', { root, query, limit, mode, include_text_files: includeTextFiles });
      process.stdout.write(json ? `${JSON.stringify(results, null, 2)}\n` : formatResults(`Search results for: ${JSON.stringify(query)} (mode=${mode})`, results));
      return;
    }

    if (command === 'related' || command === 'find-related') {
      const filePath = args.shift();
      const line = Number.parseInt(String(args.shift() || ''), 10);
      const root = args.shift() || process.cwd();
      if (!filePath || !Number.isFinite(line) || line < 1) usage(1);
      const results = await invokeOcto('code_find_related', { root, file_path: filePath, line, limit, include_text_files: includeTextFiles });
      process.stdout.write(json ? `${JSON.stringify(results, null, 2)}\n` : formatResults(`Chunks related to ${filePath}:${line}`, results));
      return;
    }

    if (command === 'stats') {
      const root = args.shift() || process.cwd();
      const stats = await invokeOcto('code_search_stats', { root, include_text_files: includeTextFiles });
      process.stdout.write(json ? `${JSON.stringify(stats, null, 2)}\n` : formatStats(stats));
      return;
    }

    if (command === 'savings') {
      const savings = await invokeOcto('code_search_savings');
      process.stdout.write(json ? `${JSON.stringify(savings, null, 2)}\n` : formatSavings(savings));
      return;
    }

    if (command === 'clear') {
      const root = args.shift();
      await invokeOcto('code_search_clear_cache', root ? { root } : {});
      process.stdout.write('Code-search cache cleared.\n');
      return;
    }

    usage(1);
  } catch (error) {
    process.stderr.write(`octo-code-search: ${error.message}\n`);
    process.stderr.write(`Make sure BBARIT Terminal is running and ${BRIDGE_URL}/health is reachable.\n`);
    process.exit(2);
  }
}

main();
