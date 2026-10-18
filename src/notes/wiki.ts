import type { FileEntry } from '../store/appState';

export const PROJECT_WIKI_NAME = 'Karpathy Wiki';

export interface ProjectWikiPaths {
  docsDir: string;
  rawDir: string;
  wikiDir: string;
  entitiesDir: string;
  conceptsDir: string;
  sourcesDir: string;
  decisionsDir: string;
  indexFile: string;
  logFile: string;
  overviewFile: string;
  schemaFile: string;
  rawReadmeFile: string;
}

export interface ClassifiedProjectDocsEntries {
  wikiEntry: FileEntry | null;
  rawEntry: FileEntry | null;
  otherEntries: FileEntry[];
}

export interface IngestedWikiSource {
  rawPath: string;
  rawRelativePath: string;
  sourcePath: string;
  sourceTitle: string;
}

type InvokeFn = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

function pathJoin(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

export function getProjectWikiPaths(workDir: string): ProjectWikiPaths {
  const docsDir = pathJoin(workDir, 'docs');
  return buildWikiPaths(docsDir);
}

export function getSharedWikiPaths(notesDir: string): ProjectWikiPaths {
  const docsDir = pathJoin(notesDir, PROJECT_WIKI_NAME);
  return buildWikiPaths(docsDir);
}

function buildWikiPaths(docsDir: string): ProjectWikiPaths {
  const wikiDir = pathJoin(docsDir, 'wiki');
  const rawDir = pathJoin(docsDir, 'raw');
  return {
    docsDir,
    rawDir,
    wikiDir,
    entitiesDir: pathJoin(wikiDir, 'entities'),
    conceptsDir: pathJoin(wikiDir, 'concepts'),
    sourcesDir: pathJoin(wikiDir, 'sources'),
    decisionsDir: pathJoin(wikiDir, 'decisions'),
    indexFile: pathJoin(wikiDir, 'index.md'),
    logFile: pathJoin(wikiDir, 'log.md'),
    overviewFile: pathJoin(wikiDir, 'overview.md'),
    schemaFile: pathJoin(wikiDir, 'schema.md'),
    rawReadmeFile: pathJoin(rawDir, 'README.md'),
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildWikiIndexContent(projectName: string): string {
  return `# ${projectName} ${PROJECT_WIKI_NAME} Index

This ${PROJECT_WIKI_NAME.toLowerCase()} is the structured knowledge layer for \`${projectName}\`.

## Core Loop

- ingest: move new source material into \`raw/\`, summarize it, and connect it into the wiki
- query: answer from the wiki first, then deepen or repair pages if the answer exposed gaps
- lint: clean contradictions, weak links, stale summaries, and missing source attribution

## Core Pages

- [[overview]] - High-level summary of the project, goals, and architecture.
- [[schema]] - Rules for how the wiki should be maintained.
- [[log]] - Chronological ingest/query/lint history.

## Collections

- \`entities/\` - People, modules, services, products, repos, owners.
- \`concepts/\` - Themes, systems, protocols, domain ideas.
- \`sources/\` - Processed source summaries linked back to raw inputs.
- \`decisions/\` - Key technical and product decisions.

## Maintenance Rules

- Add new raw materials to \`raw/\`.
- Summaries and synthesized notes belong in \`wiki/\`.
- Update this index whenever a new durable page is created.
- Cross-link pages with markdown links so graph view stays useful.
`;
}

export function buildWikiOverviewContent(projectName: string): string {
  return `# ${projectName} ${PROJECT_WIKI_NAME} Overview

## Purpose

- Describe what this project is and why it exists.

## Current State

- Key capabilities:
- Important constraints:
- Known risks:

## Important Areas

- Architecture
- Product behavior
- Operations / deployment
- Integrations
- Open questions

## Suggested Next Pages

- Create or update related pages in \`entities/\`, \`concepts/\`, or \`decisions/\`.
- Keep [[index]] and [[log]] current when durable knowledge changes.

## Query Discipline

- Prefer answering from existing wiki pages before re-reading every raw source.
- If the answer required fresh synthesis, write the improved understanding back into the wiki.
`;
}

export function buildWikiSchemaContent(projectName: string): string {
  return `# ${projectName} ${PROJECT_WIKI_NAME} Schema

This file defines how the ${PROJECT_WIKI_NAME.toLowerCase()} for this project should be maintained.

## Layering

- \`raw/\` contains immutable source material or lightly cleaned source captures.
- \`wiki/\` contains LLM-maintained summaries, syntheses, indexes, and decisions.
- The wiki should summarize and connect knowledge, not duplicate raw sources unnecessarily.

## Page Rules

- Prefer one topic per page.
- Use clear H1 titles.
- Add short summaries near the top.
- Link related pages with markdown links.
- When new evidence changes an older conclusion, update both the destination page and \`log.md\`.

## Recommended Workflows

1. Ingest a new source from \`raw/\`.
2. Create or update a source summary page in \`wiki/sources/\`.
3. Update \`overview.md\`, related entity/concept pages, and \`index.md\`.
4. Append a short entry to \`log.md\`.

## Query / Repair Rules

- Start from the wiki before scanning raw material again.
- If a question reveals a missing page, create it.
- If a question reveals stale or contradictory knowledge, fix the page and log the repair.
- Prefer small durable updates over one giant catch-all note.

## Quality Checks

- Orphan pages with no useful incoming links
- Contradictory claims that need reconciliation
- Missing source attribution
- Pages that should be split because they cover multiple topics
`;
}

export function buildWikiLogContent(projectName: string): string {
  return `# ${projectName} ${PROJECT_WIKI_NAME} Log

## [${todayIso()}] init | ${PROJECT_WIKI_NAME} scaffold created

- Created \`raw/\` and \`wiki/\`
- Initialized index, overview, schema, and log pages
`;
}

export function buildRawReadmeContent(projectName: string): string {
  return `# ${projectName} Raw Sources

Put original source materials here.

Examples:

- clipped web articles
- meeting notes
- transcripts
- PDFs exported as markdown
- screenshots or reference text files

Rules:

- raw sources are the source-of-truth layer
- prefer adding new materials here before summarizing them into the wiki
- avoid editing raw materials beyond light cleanup
`;
}

function basenamePath(input: string): string {
  const trimmed = input.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function relativeTo(base: string, target: string): string {
  const baseParts = base.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  const targetParts = target.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  while (baseParts.length > 0 && targetParts.length > 0 && baseParts[0] === targetParts[0]) {
    baseParts.shift();
    targetParts.shift();
  }
  return `${baseParts.map(() => '..').join('/')}${baseParts.length > 0 ? '/' : ''}${targetParts.join('/')}` || '.';
}

function slugifyPath(input: string): string {
  return input
    .replace(/\.[^.]+$/i, '')
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9가-힣_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'source';
}

function titleFromPath(input: string): string {
  const stem = basenamePath(input).replace(/\.[^.]+$/i, '');
  return stem
    .split(/[-_]+/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Source';
}

function extractSummaryBullets(rawContent: string, limit = 3): string[] {
  const lines = rawContent
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => !!line && !line.startsWith('#') && !line.startsWith('```'));

  const bullets: string[] = [];
  for (const line of lines) {
    const cleaned = line.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    bullets.push(cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned);
    if (bullets.length >= limit) break;
  }

  if (bullets.length === 0) bullets.push('Raw source imported. Review and expand this summary.');
  return bullets;
}

function extractQuote(rawContent: string): string {
  const lines = rawContent
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => !!line && !line.startsWith('```'));
  const quote = lines.find(line => !line.startsWith('#')) || lines[0] || 'No excerpt available.';
  return quote.length > 220 ? `${quote.slice(0, 217)}...` : quote;
}

function upsertManagedSection(content: string, heading: string, marker: string, lines: string[]): string {
  const startMarker = `<!-- ${marker}:START -->`;
  const endMarker = `<!-- ${marker}:END -->`;
  const block = `${heading}\n\n${startMarker}\n${lines.join('\n')}\n${endMarker}`;
  const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'm');
  if (content.includes(startMarker) && content.includes(endMarker)) {
    return content.replace(regex, `${startMarker}\n${lines.join('\n')}\n${endMarker}`);
  }
  const trimmed = content.replace(/\s+$/, '');
  return `${trimmed}\n\n${block}\n`;
}

async function collectReadableFiles(invokeFn: InvokeFn, dirPath: string): Promise<FileEntry[]> {
  let entries: FileEntry[] = [];
  try {
    entries = await invokeFn<FileEntry[]>('read_directory', { path: dirPath });
  } catch {
    return [];
  }
  const out: FileEntry[] = [];
  for (const entry of entries) {
    if (entry.is_dir) {
      const nested = await collectReadableFiles(invokeFn, entry.path);
      out.push(...nested);
    } else {
      out.push(entry);
    }
  }
  return out;
}

function buildSourceSummaryContent(params: {
  sourceTitle: string;
  projectName: string;
  rawRelativePath: string;
  rawLink: string;
  summaryBullets: string[];
  quote: string;
}): string {
  return `# ${params.sourceTitle}

## Source

- Project: ${params.projectName}
- Raw file: [${params.rawRelativePath}](${params.rawLink})

## Summary

${params.summaryBullets.map(line => `- ${line}`).join('\n')}

## Excerpt

> ${params.quote}

## Links

- [[index]]
- [[log]]
`;
}

export async function ingestWikiRawSourcesAtRoot(
  invokeFn: InvokeFn,
  paths: ProjectWikiPaths,
  projectName: string,
): Promise<{ paths: ProjectWikiPaths; ingested: IngestedWikiSource[]; updatedPaths: string[] }> {
  await ensureWikiScaffoldAtRoot(invokeFn, paths, projectName);
  const updatedPaths: string[] = [];
  const ingested: IngestedWikiSource[] = [];
  const rawFiles = (await collectReadableFiles(invokeFn, paths.rawDir))
    .filter(entry => !entry.is_dir)
    .filter(entry => basenamePath(entry.path).toLowerCase() !== 'readme.md')
    .filter(entry => /\.(md|txt|markdown)$/i.test(entry.path));

  for (const rawFile of rawFiles) {
    let rawContent = '';
    try {
      rawContent = await invokeFn<string>('read_file', { path: rawFile.path });
    } catch {
      continue;
    }
    const rawRelativePath = rawFile.path.slice(paths.rawDir.length + 1);
    const sourceTitle = titleFromPath(rawRelativePath);
    const sourceFilename = `${slugifyPath(rawRelativePath)}.md`;
    const sourcePath = pathJoin(paths.sourcesDir, sourceFilename);
    const sourceContent = buildSourceSummaryContent({
      sourceTitle,
      projectName,
      rawRelativePath,
      rawLink: relativeTo(paths.sourcesDir, rawFile.path),
      summaryBullets: extractSummaryBullets(rawContent),
      quote: extractQuote(rawContent),
    });

    let current = '';
    try {
      current = await invokeFn<string>('read_file', { path: sourcePath });
    } catch {
      current = '';
    }
    if (current !== sourceContent) {
      await invokeFn('write_file', { path: sourcePath, content: sourceContent });
      updatedPaths.push(sourcePath);
    }
    ingested.push({
      rawPath: rawFile.path,
      rawRelativePath,
      sourcePath,
      sourceTitle,
    });
  }

  if (ingested.length > 0) {
    const indexCurrent = await invokeFn<string>('read_file', { path: paths.indexFile }).catch(() => buildWikiIndexContent(projectName));
    const indexNext = upsertManagedSection(
      indexCurrent,
      '## Ingested Sources',
      'KARPATHY_INGESTED_SOURCES',
      ingested.map(item => `- [${item.sourceTitle}](./sources/${basenamePath(item.sourcePath)}) - [raw](../raw/${item.rawRelativePath.replace(/\\/g, '/')})`),
    );
    if (indexNext !== indexCurrent) {
      await invokeFn('write_file', { path: paths.indexFile, content: indexNext });
      updatedPaths.push(paths.indexFile);
    }

    const logCurrent = await invokeFn<string>('read_file', { path: paths.logFile }).catch(() => buildWikiLogContent(projectName));
    const stamp = todayIso();
    const logEntry = `## [${stamp}] ingest | ${ingested.length} raw source${ingested.length > 1 ? 's' : ''} synchronized\n\n${ingested.map(item => `- ${item.rawRelativePath} -> sources/${basenamePath(item.sourcePath)}`).join('\n')}`;
    const logNext = logCurrent.includes(logEntry)
      ? logCurrent
      : `${logCurrent.replace(/\s+$/, '')}\n\n${logEntry}\n`;
    if (logNext !== logCurrent) {
      await invokeFn('write_file', { path: paths.logFile, content: logNext });
      updatedPaths.push(paths.logFile);
    }
  }

  return { paths, ingested, updatedPaths };
}

export async function ingestSharedWikiRawSources(
  invokeFn: InvokeFn,
  notesDir: string,
  projectName: string,
): Promise<{ paths: ProjectWikiPaths; ingested: IngestedWikiSource[]; updatedPaths: string[] }> {
  return ingestWikiRawSourcesAtRoot(invokeFn, getSharedWikiPaths(notesDir), projectName);
}

export function classifyProjectDocsEntries(entries: FileEntry[]): ClassifiedProjectDocsEntries {
  let wikiEntry: FileEntry | null = null;
  let rawEntry: FileEntry | null = null;
  const otherEntries: FileEntry[] = [];

  for (const entry of entries) {
    if (entry.is_dir && entry.name === 'wiki') {
      wikiEntry = entry;
      continue;
    }
    if (entry.is_dir && entry.name === 'raw') {
      rawEntry = entry;
      continue;
    }
    otherEntries.push(entry);
  }

  return { wikiEntry, rawEntry, otherEntries };
}

async function ensureFile(invokeFn: InvokeFn, path: string, content: string): Promise<boolean> {
  try {
    await invokeFn('read_file', { path });
    return false;
  } catch {
    await invokeFn('write_file', { path, content });
    return true;
  }
}

async function rewriteLegacyWikiIndexIfNeeded(invokeFn: InvokeFn, path: string): Promise<boolean> {
  try {
    const current = await invokeFn<string>('read_file', { path });
    if (
      !current.includes('[overview](./overview.md)')
      && !current.includes('[schema](./schema.md)')
      && !current.includes('[log](./log.md)')
      && !current.includes('\\[\\[overview\\]\\]')
      && !current.includes('\\[\\[schema\\]\\]')
      && !current.includes('\\[\\[log\\]\\]')
      && !current.includes('`docs/raw/`')
      && !current.includes('`docs/wiki/`')
    ) {
      return false;
    }
    const next = current
      .replace(/\[overview\]\(\.\/overview\.md\)/g, '[[overview]]')
      .replace(/\[schema\]\(\.\/schema\.md\)/g, '[[schema]]')
      .replace(/\[log\]\(\.\/log\.md\)/g, '[[log]]')
      .replace(/\\\[\\\[overview\\\]\\\]/g, '[[overview]]')
      .replace(/\\\[\\\[schema\\\]\\\]/g, '[[schema]]')
      .replace(/\\\[\\\[log\\\]\\\]/g, '[[log]]')
      .replace(/^- \[entities\/\]\(\.\/entities\) - /m, '- `entities/` - ')
      .replace(/^- \[concepts\/\]\(\.\/concepts\) - /m, '- `concepts/` - ')
      .replace(/^- \[sources\/\]\(\.\/sources\) - /m, '- `sources/` - ')
      .replace(/^- \[decisions\/\]\(\.\/decisions\) - /m, '- `decisions/` - ');
    const normalized = next
      .replace(/`docs\/raw\/`/g, '`raw/`')
      .replace(/`docs\/wiki\/`/g, '`wiki/`');
    if (normalized === current) return false;
    await invokeFn('write_file', { path, content: normalized });
    return true;
  } catch {
    return false;
  }
}

async function rewriteLegacyWikiPageIfNeeded(
  invokeFn: InvokeFn,
  path: string,
  nextContent: string,
  requiredSnippets: string[],
): Promise<boolean> {
  try {
    const current = await invokeFn<string>('read_file', { path });
    if (requiredSnippets.every(snippet => current.includes(snippet))) return false;
    await invokeFn('write_file', { path, content: nextContent });
    return true;
  } catch {
    return false;
  }
}

export async function ensureProjectWikiScaffold(
  invokeFn: InvokeFn,
  workDir: string,
  projectName: string,
): Promise<{ paths: ProjectWikiPaths; createdPaths: string[] }> {
  return ensureWikiScaffoldAtRoot(invokeFn, getProjectWikiPaths(workDir), projectName);
}

export async function ensureSharedWikiScaffold(
  invokeFn: InvokeFn,
  notesDir: string,
  projectName: string,
): Promise<{ paths: ProjectWikiPaths; createdPaths: string[] }> {
  return ensureWikiScaffoldAtRoot(invokeFn, getSharedWikiPaths(notesDir), projectName);
}

async function ensureWikiScaffoldAtRoot(
  invokeFn: InvokeFn,
  paths: ProjectWikiPaths,
  projectName: string,
): Promise<{ paths: ProjectWikiPaths; createdPaths: string[] }> {
  const createdPaths: string[] = [];

  const dirs = [
    paths.docsDir,
    paths.rawDir,
    paths.wikiDir,
    paths.entitiesDir,
    paths.conceptsDir,
    paths.sourcesDir,
    paths.decisionsDir,
  ];
  for (const dir of dirs) {
    await invokeFn('create_directory', { path: dir }).catch(() => {});
  }

  if (await ensureFile(invokeFn, paths.indexFile, buildWikiIndexContent(projectName))) createdPaths.push(paths.indexFile);
  if (await ensureFile(invokeFn, paths.overviewFile, buildWikiOverviewContent(projectName))) createdPaths.push(paths.overviewFile);
  if (await ensureFile(invokeFn, paths.schemaFile, buildWikiSchemaContent(projectName))) createdPaths.push(paths.schemaFile);
  if (await ensureFile(invokeFn, paths.logFile, buildWikiLogContent(projectName))) createdPaths.push(paths.logFile);
  if (await ensureFile(invokeFn, paths.rawReadmeFile, buildRawReadmeContent(projectName))) createdPaths.push(paths.rawReadmeFile);
  if (await rewriteLegacyWikiIndexIfNeeded(invokeFn, paths.indexFile)) createdPaths.push(paths.indexFile);
  if (await rewriteLegacyWikiPageIfNeeded(invokeFn, paths.overviewFile, buildWikiOverviewContent(projectName), ['## Query Discipline', 'Keep [[index]] and [[log]] current'])) createdPaths.push(paths.overviewFile);
  if (await rewriteLegacyWikiPageIfNeeded(invokeFn, paths.schemaFile, buildWikiSchemaContent(projectName), ['## Query / Repair Rules', '## Recommended Workflows'])) createdPaths.push(paths.schemaFile);

  return { paths, createdPaths };
}
