/**
 * mdToPdf.ts
 *
 * Converts Markdown content to PDF using markdown-it (MD -> HTML)
 * and html2pdf.js (HTML -> PDF via jsPDF + html2canvas).
 *
 * Supports: headings, bold, italic, code blocks, lists, tables, images,
 * links, blockquotes, horizontal rules, and task lists.
 */

import MarkdownIt from 'markdown-it';
import html2pdf from 'html2pdf.js';

/** Options for PDF export */
export interface MdToPdfOptions {
  /** Markdown source text */
  markdown: string;
  /** Use light theme (true) or dark theme (false) */
  isLightTheme?: boolean;
  /** Base font family */
  fontFamily?: string;
  /** PDF filename (without extension) - used as fallback */
  filename?: string;
}

/**
 * Renders markdown to styled HTML content and CSS for PDF conversion.
 * Uses a class-scoped wrapper instead of body selector so it works
 * correctly when injected into an off-screen container div.
 */
function renderMarkdownHtml(markdown: string, isLight: boolean, fontFamily: string): { css: string; html: string } {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    breaks: true,
  });

  const htmlBody = md.render(markdown);

  // Theme colors
  const bg = isLight ? '#ffffff' : '#1e1e2e';
  const text = isLight ? '#1a1a2e' : '#cdd6f4';
  const headingColor = isLight ? '#0f0f23' : '#f5e0dc';
  const linkColor = isLight ? '#1e66f5' : '#89b4fa';
  const codeBg = isLight ? '#f2f3f5' : '#313244';
  const codeBorder = isLight ? '#d9dce0' : '#45475a';
  const blockquoteBorder = isLight ? '#1e66f5' : '#89b4fa';
  const blockquoteBg = isLight ? '#f0f4ff' : '#1e1e2e';
  const tableBorder = isLight ? '#d9dce0' : '#45475a';
  const tableHeaderBg = isLight ? '#e8eaed' : '#313244';
  const tableStripeBg = isLight ? '#f8f9fa' : '#24243a';
  const hrColor = isLight ? '#d9dce0' : '#45475a';

  const W = '.md-pdf-root'; // wrapper class selector

  const css = `
  ${W} { box-sizing: border-box; margin: 0; padding: 0; }
  ${W} *, ${W} *::before, ${W} *::after { box-sizing: border-box; }

  ${W} {
    font-family: ${fontFamily}, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 11pt;
    line-height: 1.7;
    color: ${text};
    background: ${bg};
    padding: 32px 40px;
    max-width: 100%;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  ${W} h1, ${W} h2, ${W} h3, ${W} h4, ${W} h5, ${W} h6 {
    color: ${headingColor};
    margin-top: 1.4em;
    margin-bottom: 0.6em;
    line-height: 1.3;
    page-break-after: avoid;
  }

  ${W} h1 { font-size: 22pt; border-bottom: 2px solid ${hrColor}; padding-bottom: 0.3em; }
  ${W} h2 { font-size: 18pt; border-bottom: 1px solid ${hrColor}; padding-bottom: 0.2em; }
  ${W} h3 { font-size: 15pt; }
  ${W} h4 { font-size: 13pt; }
  ${W} h5 { font-size: 11pt; }
  ${W} h6 { font-size: 10pt; opacity: 0.85; }

  ${W} p {
    margin-bottom: 0.8em;
  }

  ${W} a {
    color: ${linkColor};
    text-decoration: underline;
  }

  ${W} strong { font-weight: 700; }
  ${W} em { font-style: italic; }

  ${W} code {
    font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace;
    font-size: 0.9em;
    background: ${codeBg};
    border: 1px solid ${codeBorder};
    border-radius: 4px;
    padding: 1px 5px;
  }

  ${W} pre {
    background: ${codeBg};
    border: 1px solid ${codeBorder};
    border-radius: 6px;
    padding: 12px 16px;
    margin: 0.8em 0;
    overflow-x: auto;
    page-break-inside: avoid;
  }

  ${W} pre code {
    background: none;
    border: none;
    padding: 0;
    font-size: 9.5pt;
    line-height: 1.5;
  }

  ${W} blockquote {
    border-left: 4px solid ${blockquoteBorder};
    background: ${blockquoteBg};
    padding: 8px 16px;
    margin: 0.8em 0;
    border-radius: 0 6px 6px 0;
  }

  ${W} blockquote p { margin-bottom: 0.4em; }
  ${W} blockquote p:last-child { margin-bottom: 0; }

  ${W} ul, ${W} ol {
    margin: 0.5em 0 0.8em 1.5em;
    padding: 0;
  }

  ${W} li {
    margin-bottom: 0.25em;
  }

  ${W} li > ul, ${W} li > ol {
    margin-top: 0.2em;
    margin-bottom: 0.2em;
  }

  ${W} table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.8em 0;
    font-size: 10pt;
    page-break-inside: avoid;
  }

  ${W} th, ${W} td {
    border: 1px solid ${tableBorder};
    padding: 6px 10px;
    text-align: left;
  }

  ${W} th {
    background: ${tableHeaderBg};
    font-weight: 600;
  }

  ${W} tr:nth-child(even) {
    background: ${tableStripeBg};
  }

  ${W} hr {
    border: none;
    border-top: 1px solid ${hrColor};
    margin: 1.5em 0;
  }

  ${W} img {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 0.5em 0;
  }

  ${W} ul li input[type="checkbox"] {
    margin-right: 6px;
  }`;

  return { css, html: htmlBody };
}

/**
 * Convert markdown content to a PDF ArrayBuffer.
 * The conversion happens entirely client-side using html2pdf.js.
 *
 * @returns base64-encoded PDF data
 */
export async function markdownToPdfBase64(options: MdToPdfOptions): Promise<string> {
  const {
    markdown,
    isLightTheme = true,
    fontFamily = 'system-ui',
    filename = 'document',
  } = options;

  // 1. Render markdown to styled HTML + CSS
  const { css, html: htmlBody } = renderMarkdownHtml(markdown, isLightTheme, fontFamily);

  // 2. Create an off-screen container to render the HTML
  //    NOTE: Do NOT use opacity:0 — html2canvas captures the visual state,
  //    so opacity 0 would produce a blank PDF. Off-screen position hides it.
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-99999px';
  container.style.top = '0';
  container.style.width = '210mm'; // A4 width
  container.style.zIndex = '-1';

  // Inject scoped styles
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  container.appendChild(styleEl);

  // Inject content wrapped with scoped class
  const wrapper = document.createElement('div');
  wrapper.className = 'md-pdf-root';
  wrapper.innerHTML = htmlBody;
  container.appendChild(wrapper);

  document.body.appendChild(container);

  try {
    // 3. Use html2pdf.js to convert the rendered HTML to PDF
    const worker = html2pdf()
      .set({
        margin: [10, 10, 10, 10], // mm: top, left, bottom, right
        filename: `${filename}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          letterRendering: true,
          logging: false,
        },
        jsPDF: {
          unit: 'mm',
          format: 'a4',
          orientation: 'portrait',
        },
        enableLinks: true,
      })
      .from(wrapper);

    // 4. Get raw PDF output as arraybuffer
    const pdfBlob: Blob = await worker.toPdf().output('blob');

    // 5. Convert blob to base64
    const base64 = await blobToBase64(pdfBlob);
    return base64;
  } finally {
    // Cleanup the off-screen container
    document.body.removeChild(container);
  }
}

/** Convert a Blob to a pure base64 string (no data URI prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip the "data:...;base64," prefix
      const base64 = result.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
