// 일부 앱은 표/리치 콘텐츠를 text/plain 없이 text/html로만 클립보드에 복사한다.
// 그 상태로 터미널에 붙여넣으면 텍스트 경로가 전부 비어서 이미지 폴백까지 흘러가
// 시스템 클립보드의 무관한 이미지를 붙여넣는 오동작이 났다.
// 이 모듈은 클립보드 HTML을 터미널에 붙여넣을 수 있는 텍스트로 변환한다.
// <table>은 마크다운 파이프 테이블로 복원해 표 구조를 살린다.

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE',
  'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION',
]);

const SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'META', 'TITLE', 'HEAD', 'TEMPLATE']);

function cellText(cell: Element): string {
  const raw = Array.from(cell.childNodes).map(nodeToText).join('');
  return raw
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');
}

function tableToMarkdown(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr')).filter(
    (tr) => tr.closest('table') === table,
  );
  if (rows.length === 0) return '';
  const grid = rows.map((tr) =>
    Array.from(tr.children)
      .filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
      .map((c) => cellText(c)),
  );
  const width = Math.max(...grid.map((r) => r.length));
  if (width === 0) return '';
  const norm = grid.map((r) => [...r, ...Array<string>(width - r.length).fill('')]);
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const [head, ...body] = norm;
  return [line(head), line(Array<string>(width).fill('---')), ...body.map(line)].join('\n');
}

function nodeToText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || '').replace(/\s+/g, ' ');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return '';
  if (tag === 'BR') return '\n';
  if (tag === 'TABLE') return `\n${tableToMarkdown(el)}\n`;
  const inner = Array.from(el.childNodes).map(nodeToText).join('');
  if (tag === 'LI') return `- ${inner.trim()}\n`;
  if (tag === 'TR') return `${inner.trim()}\n`;
  if (BLOCK_TAGS.has(tag)) return `\n${inner}\n`;
  return inner;
}

export function htmlClipboardToText(html: string): string {
  if (!html || typeof DOMParser === 'undefined') return '';
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return '';
  }
  if (!doc.body) return '';
  return nodeToText(doc.body)
    .split('\n')
    .map((l) => l.replace(/\s+$/g, '').replace(/^ +/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
