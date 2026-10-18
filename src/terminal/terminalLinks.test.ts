import { describe, expect, it } from 'vitest';
import { Terminal } from 'xterm';
import type { ILink } from 'xterm';
import { createTerminalLinkProvider, type TerminalLinkHandlers } from './terminalLinks';

// jsdom에는 캔버스 컨텍스트가 없다 — xterm 로드 시점 콘솔 에러만 막는 최소 스텁
(HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = () => ({
  measureText: () => ({ width: 8 }),
  font: '',
  save() {}, restore() {}, fillRect() {}, clearRect() {}, fillText() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  canvas: { width: 8, height: 16 },
});

const COLS = 20;

const makeTerm = () => new Terminal({ cols: COLS, rows: 6, scrollback: 100, allowProposedApi: true });

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

const provide = (term: Terminal, handlers: Partial<TerminalLinkHandlers>, line: number) => {
  const provider = createTerminalLinkProvider(term, {
    isModifierHeld: () => true,
    openUrl: () => {},
    openPath: () => {},
    ...handlers,
  });
  return new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(line, resolve));
};

const cmdClick = () => new MouseEvent('click', { metaKey: true });

describe('terminalLinks wrapped-line detection', () => {
  it('should_detect_path_split_across_soft_wrapped_rows', async () => {
    const term = makeTerm();
    // 37 chars > 20 cols: wraps onto a second buffer row.
    const path = '/Users/a/project/src/App.tsx:42';
    await write(term, `err ${path}`);
    expect(term.buffer.active.getLine(1)?.isWrapped).toBe(true);

    let opened: { path: string; line?: number } | null = null;
    const links = await provide(term, { openPath: (p, l) => { opened = { path: p, line: l }; } }, 1);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe(path);
    expect(links![0].range.start).toEqual({ x: 5, y: 1 });
    expect(links![0].range.end.y).toBe(2);

    links![0].activate(cmdClick(), links![0].text);
    expect(opened).toEqual({ path: '/Users/a/project/src/App.tsx', line: 42 });
  });

  it('should_detect_url_split_across_soft_wrapped_rows_without_modifier', async () => {
    const term = makeTerm();
    const url = 'https://example.com/very/long/path?q=1';
    await write(term, url);

    let openedUrl = '';
    const links = await provide(term, {
      isModifierHeld: () => false,
      openUrl: (u) => { openedUrl = u; },
    }, 1);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe(url);
    expect(links![0].range.end.y).toBe(2);

    links![0].activate(cmdClick(), links![0].text);
    expect(openedUrl).toBe(url);
  });

  it('should_return_same_link_when_hovering_continuation_row', async () => {
    const term = makeTerm();
    const path = '/Users/a/project/src/App.tsx:42';
    await write(term, `err ${path}`);

    const links = await provide(term, {}, 2);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe(path);
    expect(links![0].range.start).toEqual({ x: 5, y: 1 });
  });

  it('should_keep_single_row_links_on_their_row', async () => {
    const term = makeTerm();
    await write(term, 'a src/x.ts:3 b');

    const links = await provide(term, {}, 1);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe('src/x.ts:3');
    expect(links![0].range).toEqual({ start: { x: 3, y: 1 }, end: { x: 12, y: 1 } });
  });

  it('should_not_join_hard_newline_rows', async () => {
    const term = makeTerm();
    await write(term, 'src/a.ts\r\nsrc/b.ts');

    const links = await provide(term, {}, 1);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe('src/a.ts');
    expect(links![0].range.end.y).toBe(1);
  });
});
