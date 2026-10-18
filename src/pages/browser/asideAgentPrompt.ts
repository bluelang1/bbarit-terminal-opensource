import { redact } from '../browserRedact';

export interface AsidePromptTab {
  title: string;
  url: string;
}

export interface AsidePromptContext {
  includeCtx: boolean;
  pageUrl: string | null;
  pageTitle: string | null;
  selectionText?: string | null;
  mentionedTabs: AsidePromptTab[];
  memoryOn: boolean;
  memoryLines?: string[];
}

export function hostPath(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return url;
  }
}

export function buildAsideAgentPromptPrefix(ctx: AsidePromptContext): string {
  const blocks: string[] = [];
  if (ctx.includeCtx && ctx.pageUrl) {
    const lines = ['[Page context]', `URL: ${redact(ctx.pageUrl)}`];
    if (ctx.pageTitle) lines.push(`Title: ${redact(ctx.pageTitle)}`);
    const selection = ctx.selectionText?.trim();
    if (selection) lines.push(`Selection: "${redact(selection).slice(0, 800)}"`);
    blocks.push(lines.join('\n'));
  }
  if (ctx.mentionedTabs.length > 0) {
    blocks.push([
      '[Mentioned tabs]',
      ...ctx.mentionedTabs.map((tab) => `- ${redact(tab.title || hostPath(tab.url))}: ${redact(tab.url)}`),
    ].join('\n'));
  }
  if (ctx.memoryOn) {
    const lines = (ctx.memoryLines || []).slice(0, 8).map((line) => redact(line));
    if (lines.length > 0) {
      blocks.push(['[Browsing memory — recent relevant pages]', ...lines.map((line) => `- ${line}`)].join('\n'));
    }
  }
  if (blocks.length === 0) return '';
  return `${blocks.join('\n\n')}\n---\n`;
}
