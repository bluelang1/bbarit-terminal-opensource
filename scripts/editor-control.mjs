#!/usr/bin/env node
// Terminal agent → BBARIT Terminal editor control CLI.
//
// Talks to the local editor bridge (browser_bridge::handle_editor) over HTTP.
// The bridge turns each request into a Tauri event that the running frontend
// answers, so BBARIT Terminal must be open. Default bridge is the installed
// build (19980); the dev app listens on 19981 — set OCTO_BRIDGE_URL for that.
//
// See scripts/EDITOR-CONTROL.md for the full command reference.

import { readFile } from 'node:fs/promises';

const BRIDGE_URL = (process.env.OCTO_BRIDGE_URL || 'http://127.0.0.1:19980').replace(/\/+$/, '');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postEditor(payload) {
  let res;
  try {
    res = await fetch(`${BRIDGE_URL}/editor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, error: `cannot reach bridge at ${BRIDGE_URL} — is BBARIT Terminal running? (${String(e.message || e)})` };
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    return { ok: false, error: `bad bridge response: ${String(e.message || e)}` };
  }
  // The bridge wraps the frontend result: { success, data, error }.
  if (json && json.success === false) return { ok: false, error: json.error || 'bridge error' };
  if (json && typeof json.data === 'object' && json.data !== null) return json.data;
  return json && json.data !== undefined ? { ok: true, data: json.data } : { ok: false, error: 'empty bridge response' };
}

async function postWithWait(payload, waitSecs) {
  const deadline = Date.now() + Math.max(0, waitSecs) * 1000;
  let last;
  for (;;) {
    last = await postEditor(payload);
    if (last && last.ok) return last;
    const err = String(last?.error || '');
    const retryable = /not open|not responding|not ready|timed out|not visible|call open first/i.test(err);
    if (!retryable || Date.now() >= deadline) return last;
    await sleep(500);
  }
}

async function resolveContent(args) {
  if (typeof args.content === 'string') return args.content;
  if (typeof args['content-file'] === 'string') return await readFile(args['content-file'], 'utf8');
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  return null;
}

// Element targets: an html-outline index path like "[1,0]" or a CSS selector.
function parseTarget(raw) {
  if (raw === undefined || raw === true) return undefined;
  const s = String(raw).trim();
  if (s.startsWith('[')) {
    try { return JSON.parse(s); } catch { /* fall through to selector */ }
  }
  return s;
}

// Optional flag value: drop bare boolean flags (given with no value) so the
// app-side handlers see undefined and fall back to their defaults.
function opt(v) {
  return v !== undefined && v !== true ? v : undefined;
}

function requireFile(args) {
  const file = args.file;
  if (!file || file === true) {
    finish({ ok: false, error: '--file <absolute path> is required' });
  }
  return file;
}

function finish(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result && result.ok ? 0 : 1);
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));
  const wait = args.wait !== undefined && args.wait !== true ? Number(args.wait) : 10;

  switch (sub) {
    case 'status':
      return finish(await postEditor({ cmd: 'status' }));

    case 'open':
      return finish(await postEditor({ cmd: 'open', path: requireFile(args) }));

    case 'get-content':
      return finish(await postWithWait({ cmd: 'getContent', path: args.file && args.file !== true ? args.file : undefined }, wait));

    case 'set-content': {
      const path = requireFile(args);
      const content = await resolveContent(args);
      if (content === null) return finish({ ok: false, error: 'provide content via --content, --content-file <path>, or stdin' });
      return finish(await postWithWait({ cmd: 'setContent', path, content }, wait));
    }

    case 'save':
      return finish(await postEditor({ cmd: 'save', path: args.file && args.file !== true ? args.file : undefined }));

    case 'xlsx-sheets':
      return finish(await postWithWait({ cmd: 'xlsx.listSheets', path: requireFile(args) }, wait));

    case 'xlsx-get':
      return finish(await postWithWait({ cmd: 'xlsx.getCells', path: requireFile(args), sheet: args.sheet && args.sheet !== true ? args.sheet : undefined, range: args.range }, wait));

    case 'xlsx-set': {
      const path = requireFile(args);
      let cells;
      try {
        cells = JSON.parse(args.cells || '[]');
      } catch (e) {
        return finish({ ok: false, error: `invalid --cells JSON: ${String(e.message || e)}` });
      }
      return finish(await postWithWait({ cmd: 'xlsx.setCells', path, sheet: args.sheet && args.sheet !== true ? args.sheet : undefined, cells }, wait));
    }

    case 'xlsx-format': {
      const path = requireFile(args);
      let format;
      try {
        format = JSON.parse(args.format || '{}');
      } catch (e) {
        return finish({ ok: false, error: `invalid --format JSON: ${String(e.message || e)}` });
      }
      return finish(await postWithWait({ cmd: 'xlsx.setFormat', path, sheet: args.sheet && args.sheet !== true ? args.sheet : undefined, range: args.range, format }, wait));
    }

    case 'xlsx-add-sheet':
      return finish(await postWithWait({ cmd: 'xlsx.addSheet', path: requireFile(args), name: args.name }, wait));

    case 'xlsx-save':
      return finish(await postWithWait({ cmd: 'xlsx.save', path: requireFile(args) }, wait));

    case 'docx-get-text':
      return finish(await postWithWait({ cmd: 'docx.getText', path: requireFile(args) }, wait));

    case 'docx-get-html':
      return finish(await postWithWait({ cmd: 'docx.getHtml', path: requireFile(args) }, wait));

    case 'docx-append': {
      const path = requireFile(args);
      let bullets;
      if (args.bullets !== undefined && args.bullets !== true) {
        try {
          bullets = JSON.parse(args.bullets);
        } catch (e) {
          return finish({ ok: false, error: `invalid --bullets JSON: ${String(e.message || e)}` });
        }
      }
      const html = args.html !== undefined && args.html !== true ? args.html : await resolveContent(args);
      return finish(await postWithWait({
        cmd: 'docx.append', path,
        heading: opt(args.heading), paragraph: opt(args.paragraph), bullets,
        html: typeof html === 'string' ? html : undefined,
      }, wait));
    }

    case 'docx-save':
      return finish(await postWithWait({ cmd: 'docx.save', path: requireFile(args) }, wait));

    case 'pptx-slides':
      return finish(await postWithWait({ cmd: 'pptx.listSlides', path: requireFile(args) }, wait));

    case 'pptx-add-slide':
      return finish(await postWithWait({
        cmd: 'pptx.addSlide', path: requireFile(args),
        title: opt(args.title), body: opt(args.body), bgColor: opt(args.bgColor),
        titleColor: opt(args.titleColor), bodyColor: opt(args.bodyColor),
      }, wait));

    case 'pptx-add-text':
      return finish(await postWithWait({
        cmd: 'pptx.addText', path: requireFile(args), slide: opt(args.slide),
        text: opt(args.text), x: opt(args.x), y: opt(args.y), w: opt(args.w), h: opt(args.h),
        fontSize: opt(args.fontSize), bold: args.bold === true || undefined,
        color: opt(args.color), align: opt(args.align), listStyle: opt(args.listStyle),
      }, wait));

    case 'pptx-add-shape':
      return finish(await postWithWait({
        cmd: 'pptx.addShape', path: requireFile(args), slide: opt(args.slide),
        shape: opt(args.shape), x: opt(args.x), y: opt(args.y), w: opt(args.w), h: opt(args.h),
        fillColor: opt(args.fillColor), text: opt(args.text),
        fontSize: opt(args.fontSize), color: opt(args.color),
      }, wait));

    case 'pptx-goto':
      return finish(await postWithWait({ cmd: 'pptx.goToSlide', path: requireFile(args), slide: opt(args.slide) }, wait));

    case 'pptx-save':
      return finish(await postWithWait({ cmd: 'pptx.save', path: requireFile(args) }, wait));

    case 'html-blocks':
      return finish(await postEditor({ cmd: 'html.blocks' }));

    case 'html-outline':
      return finish(await postWithWait({ cmd: 'html.outline', path: requireFile(args) }, wait));

    case 'html-insert':
      return finish(await postWithWait({
        cmd: 'html.insertBlock', path: requireFile(args), blockId: args.block,
        target: parseTarget(args.target), position: args.position && args.position !== true ? args.position : undefined,
      }, wait));

    case 'html-insert-html': {
      const html = await resolveContent(args);
      if (html === null) return finish({ ok: false, error: 'provide html via --content, --content-file <path>, or stdin' });
      return finish(await postWithWait({
        cmd: 'html.insertHtml', path: requireFile(args), html,
        target: parseTarget(args.target), position: args.position && args.position !== true ? args.position : undefined,
      }, wait));
    }

    case 'html-set-style': {
      let style;
      try {
        style = JSON.parse(args.style || '{}');
      } catch (e) {
        return finish({ ok: false, error: `invalid --style JSON: ${String(e.message || e)}` });
      }
      return finish(await postWithWait({ cmd: 'html.setStyle', path: requireFile(args), target: parseTarget(args.target), style }, wait));
    }

    case 'html-set-text':
      return finish(await postWithWait({ cmd: 'html.setText', path: requireFile(args), target: parseTarget(args.target), text: args.text ?? '' }, wait));

    case 'html-set-attr':
      return finish(await postWithWait({ cmd: 'html.setAttr', path: requireFile(args), target: parseTarget(args.target), attr: args.attr, value: args.value }, wait));

    case 'html-remove':
      return finish(await postWithWait({ cmd: 'html.remove', path: requireFile(args), target: parseTarget(args.target) }, wait));

    case 'html-duplicate':
      return finish(await postWithWait({ cmd: 'html.duplicate', path: requireFile(args), target: parseTarget(args.target) }, wait));

    case 'html-move':
      return finish(await postWithWait({ cmd: 'html.move', path: requireFile(args), target: parseTarget(args.target), delta: Number(args.delta || 0) }, wait));

    default:
      process.stdout.write(
        [
          'BBARIT editor control CLI',
          '',
          'Usage: node scripts/editor-control.mjs <command> [options]',
          '',
          'Commands:',
          '  status',
          '  open         --file <abs path>',
          '  get-content  [--file <abs path>]',
          '  set-content  --file <abs path> (--content <str> | --content-file <path> | stdin)',
          '  save         [--file <abs path>]',
          '  xlsx-sheets  --file <abs.xlsx>',
          '  xlsx-get     --file <abs.xlsx> --range A1:C10 [--sheet <name>]',
          '  xlsx-set     --file <abs.xlsx> --cells \'[{"ref":"A1","value":"hi"}]\' [--sheet <name>]',
          '  xlsx-format  --file <abs.xlsx> --range A1:B2 --format \'{"bold":true}\' [--sheet <name>]',
          '  xlsx-add-sheet --file <abs.xlsx> --name <name>',
          '  xlsx-save    --file <abs.xlsx>',
          '',
          'Word (DOCX — file must be open in the app editor):',
          '  docx-get-text  --file <abs.docx>',
          '  docx-get-html  --file <abs.docx>',
          '  docx-append    --file <abs.docx> [--heading <str>] [--paragraph <str>] [--bullets \'["a","b"]\'] [--html <str>|stdin]',
          '  docx-save      --file <abs.docx>',
          '',
          'PowerPoint (PPTX — file must be open in the app editor):',
          '  pptx-slides    --file <abs.pptx>',
          '  pptx-add-slide --file <abs.pptx> [--title <str>] [--body <str>] [--bgColor #hex] [--titleColor #hex] [--bodyColor #hex]',
          '  pptx-add-text  --file <abs.pptx> --text <str> [--slide <n>] [--x <0-100>] [--y] [--w] [--h] [--fontSize <n>] [--bold] [--color #hex] [--align left|center|right] [--listStyle bullet|number]',
          '  pptx-add-shape --file <abs.pptx> [--shape rect|circle|triangle|star|arrow|line] [--slide <n>] [--x] [--y] [--w] [--h] [--fillColor #hex] [--text <str>]',
          '  pptx-goto      --file <abs.pptx> --slide <n>',
          '  pptx-save      --file <abs.pptx>',
          '',
          'HTML builder (terminal builder — file may be open in the app or closed on disk):',
          '  html-blocks',
          '  html-outline    --file <abs.html>',
          '  html-insert     --file <abs.html> --block <id> [--target "[0]"|<css>] [--position before|after|append]',
          '  html-insert-html --file <abs.html> (--content <html> | --content-file | stdin) [--target …] [--position …]',
          '  html-set-style  --file <abs.html> --target "[0]"|<css> --style \'{"background":"#0f172a"}\'',
          '  html-set-text   --file <abs.html> --target … --text <str>',
          '  html-set-attr   --file <abs.html> --target … --attr href --value https://…',
          '  html-remove | html-duplicate --file <abs.html> --target …',
          '  html-move       --file <abs.html> --target … --delta -1|1',
          '  (open files: changes hit the live builder canvas — run save to persist)',
          '',
          'Options: --wait <secs> (default 10) polls while the editor loads.',
          `Bridge: ${BRIDGE_URL} (override with OCTO_BRIDGE_URL; dev app uses 19981)`,
          '',
        ].join('\n'),
      );
      process.exit(sub ? 1 : 0);
  }
}

main().catch((e) => finish({ ok: false, error: String(e && e.message ? e.message : e) }));
