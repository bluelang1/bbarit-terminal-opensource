/**
 * embedExtension.ts
 *
 * CodeMirror 6 extension that renders ![[note]] / ![[image.png]] embeds
 * (Obsidian-style transclusion) as block widgets below the embed line.
 *
 * The extension itself is resolver-agnostic: the host supplies an async
 * resolver that turns a raw embed target into note content or an image src.
 */

import { RangeSetBuilder, StateField } from '@codemirror/state';
import type { Extension, Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

export type EmbedResolution =
  | { kind: 'note'; title: string; path: string; content: string }
  | { kind: 'image'; src: string };

export type EmbedResolver = (target: string) => Promise<EmbedResolution | null>;

const EMBED_LINE_REGEX = /!\[\[([^\]]+)\]\]/g;
const MAX_PREVIEW_LINES = 14;

/**
 * Remove a YAML frontmatter block from note content.
 */
export function stripFrontmatter(content: string): string {
  const lines = content.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') return content;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return lines.slice(i + 1).join('\n');
    }
  }
  return content;
}

/**
 * Slice the section belonging to `heading` out of note content:
 * from the heading line until the next heading of the same or higher level.
 */
export function sliceHeadingSection(content: string, heading: string): string {
  const lines = content.split('\n');
  const lower = heading.trim().toLowerCase();
  let start = -1;
  let level = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (!m) continue;
    if (start === -1) {
      if (m[2].trim().toLowerCase() === lower) {
        start = i;
        level = m[1].length;
      }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join('\n');
    }
  }
  if (start === -1) return content;
  return lines.slice(start).join('\n');
}

class EmbedWidget extends WidgetType {
  private readonly target: string;
  private readonly resolver: EmbedResolver;
  private readonly onOpen: (target: string) => void;

  constructor(
    target: string,
    resolver: EmbedResolver,
    onOpen: (target: string) => void,
  ) {
    super();
    this.target = target;
    this.resolver = resolver;
    this.onOpen = onOpen;
  }

  eq(other: EmbedWidget): boolean {
    return other.target === this.target;
  }

  toDOM(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'cm-note-embed';
    box.textContent = '…';

    void this.resolver(this.target).then((res) => {
      box.textContent = '';
      if (!res) {
        box.classList.add('cm-note-embed-missing');
        box.textContent = `Unresolved embed: ${this.target}`;
        return;
      }
      if (res.kind === 'image') {
        box.classList.add('cm-note-embed-imagebox');
        const img = document.createElement('img');
        img.className = 'cm-note-embed-image';
        img.src = res.src;
        img.alt = this.target;
        box.appendChild(img);
        return;
      }
      const header = document.createElement('div');
      header.className = 'cm-note-embed-header';
      header.textContent = res.title;
      header.title = res.path;
      header.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onOpen(this.target);
      });
      const body = document.createElement('div');
      body.className = 'cm-note-embed-body';
      const lines = res.content.split('\n');
      body.textContent = lines.slice(0, MAX_PREVIEW_LINES).join('\n')
        + (lines.length > MAX_PREVIEW_LINES ? '\n…' : '');
      box.appendChild(header);
      box.appendChild(body);
    }).catch(() => {
      box.classList.add('cm-note-embed-missing');
      box.textContent = `Unresolved embed: ${this.target}`;
    });

    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildEmbedDecorations(
  doc: Text,
  resolver: EmbedResolver,
  onOpen: (target: string) => void,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let inFence = false;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (/^\s*(```|~~~)/.test(line.text)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const regex = new RegExp(EMBED_LINE_REGEX.source, EMBED_LINE_REGEX.flags);
    let match: RegExpExecArray | null;
    const targets: string[] = [];
    while ((match = regex.exec(line.text)) !== null) {
      targets.push(match[1].trim());
    }
    for (const target of targets) {
      builder.add(
        line.to,
        line.to,
        Decoration.widget({
          widget: new EmbedWidget(target, resolver, onOpen),
          block: true,
          side: 1,
        }),
      );
    }
  }
  return builder.finish();
}

/**
 * CodeMirror extension rendering ![[target]] embeds as preview blocks.
 * Block decorations must come from a StateField (not a ViewPlugin).
 * Resolver/open callbacks are read through getters so they stay fresh
 * without recreating the extension.
 */
export function embedExtension(
  getResolver: () => EmbedResolver | undefined,
  getOnOpen: () => ((target: string) => void) | undefined,
): Extension {
  const resolver: EmbedResolver = (target) => {
    const fn = getResolver();
    return fn ? fn(target) : Promise.resolve(null);
  };
  const onOpen = (target: string) => {
    getOnOpen()?.(target);
  };

  return StateField.define<DecorationSet>({
    create(state) {
      return buildEmbedDecorations(state.doc, resolver, onOpen);
    },
    update(deco, tr) {
      if (tr.docChanged) {
        return buildEmbedDecorations(tr.state.doc, resolver, onOpen);
      }
      return deco.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
