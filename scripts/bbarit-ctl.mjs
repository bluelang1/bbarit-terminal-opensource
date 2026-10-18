#!/usr/bin/env node
/**
 * bbarit-ctl — BBARIT Terminal control CLI
 *
 * Connects to the running app's mcp-bridge WebSocket (dev app 9323–9422,
 * installed build 9223) and calls the in-app UI command bus
 * (window.__BBARIT_CTL__ — the same dispatcher the gateway secretary uses).
 * Local only; no tokens required.
 *
 *   npm run ctl -- <command> [args…] [--port 9223] [--json]   (repo)
 *   node bbarit-ctl.mjs <command> [args…]                      (standalone —
 *     download from Settings → Control CLI; auto-falls back to installed 9223)
 *
 * Full docs: docs/BBARIT_CLI.md (also in Settings → Control CLI)
 */

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const DEV_BASE_PORT = 9323;
const DEV_PORT_SPAN = 100;
const INSTALLED_PORT = 9223;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Argument parsing ─────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const flags = { port: 0, json: false, window: 'main', timeout: 20000 };
const args = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--port') flags.port = Number(rawArgs[++i]) || 0;
  else if (a === '--json') flags.json = true;
  else if (a === '--window') flags.window = String(rawArgs[++i] || 'main');
  else if (a === '--timeout') flags.timeout = Number(rawArgs[++i]) || 20000;
  else args.push(a);
}
const command = args.shift() || 'menu';

// ── WebSocket connection (mcp-bridge) ────────────────────────────────────
async function connectBridge() {
  const ports = flags.port
    ? [flags.port]
    : [...Array.from({ length: DEV_PORT_SPAN }, (_, i) => DEV_BASE_PORT + i), INSTALLED_PORT];
  for (const port of ports) {
    try {
      const ws = await new Promise((resolve, reject) => {
        const sock = new WebSocket(`ws://127.0.0.1:${port}`);
        const t = setTimeout(() => { sock.close(); reject(new Error('timeout')); }, flags.port ? 1500 : 250);
        sock.addEventListener('open', () => { clearTimeout(t); resolve(sock); });
        sock.addEventListener('error', () => { clearTimeout(t); reject(new Error('refused')); });
      });
      // 자동 스캔은 BBARIT 앱인지 확인하고 붙는다 — 같은 대역에 다른 프로젝트의
      // tauri dev 앱이 mcp-bridge 를 열고 있으면 남의 앱을 잡는다(스마트쿠팡 실측).
      // --port 명시는 사용자의 의도적 선택이므로 검사하지 않는다.
      if (!flags.port) {
        const ident = await new Promise((resolve) => {
          const id = `ctl-ident-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const t = setTimeout(() => { ws.removeEventListener('message', onMsg); resolve(''); }, 1500);
          const onMsg = (event) => {
            let msg;
            try { msg = JSON.parse(String(event.data)); } catch { return; }
            if (msg.id !== id) return;
            clearTimeout(t);
            ws.removeEventListener('message', onMsg);
            resolve(String(msg?.data?.app?.identifier || ''));
          };
          ws.addEventListener('message', onMsg);
          ws.send(JSON.stringify({ id, command: 'invoke_tauri', args: { command: 'plugin:mcp-bridge|get_backend_state', args: { windowLabel: 'main' } } }));
        });
        if (ident !== (process.env.BBARIT_BRIDGE_APP_ID || 'com.octo.terminal')) {
          try { ws.close(); } catch { /* ignore */ }
          continue;
        }
      }
      return { ws, port };
    } catch { /* try the next port */ }
  }
  throw new Error(
    flags.port
      ? `Cannot connect to port ${flags.port}. Is the app running?`
      : `Cannot reach BBARIT Terminal (dev ports 9323–9422, installed ${INSTALLED_PORT}). Is the app running?`,
  );
}

function wsCommand(ws, cmd, payload = {}) {
  const id = `ctl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error(`timeout: ${cmd}`)); }, flags.timeout);
    const onMsg = (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      if (msg.success === false) reject(new Error(msg.error || `${cmd} failed`));
      else resolve(msg);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, command: cmd, args: payload }));
  });
}

/** Dispatch to the app UI bus — awaits __BBARIT_CTL__.dispatch(request) and returns parsed JSON. */
async function dispatch(request) {
  const { ws, port } = await connectBridge();
  try {
    const script = `(async () => {
      const ctl = window.__BBARIT_CTL__;
      if (!ctl) return JSON.stringify({ ok: false, error: '__BBARIT_CTL__ not ready (app too old or still loading)' });
      try { return JSON.stringify(await ctl.dispatch(${JSON.stringify(request)})); }
      catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
    })()`;
    const res = await wsCommand(ws, 'execute_js', { windowLabel: flags.window, script });
    const raw = res?.data ?? res?.result ?? null;
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { ok: false, error: `unparseable result: ${String(text).slice(0, 200)}` }; }
    return { parsed, port };
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

// ── Output helpers ───────────────────────────────────────────────────────
function out(result) {
  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return; }
  if (result && result.ok === false) { console.error(`✗ ${result.error}`); process.exitCode = 1; return; }
  console.log(JSON.stringify(result, null, 2));
}

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (r) => cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  ');
  console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  console.log(widths.map((w) => '─'.repeat(w)).join('──'));
  for (const r of rows) console.log(line(r));
}

// ── Harness role files (edits agent config directly — no app needed) ─────
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.bbarit', 'agent');
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// ── Menu (full command overview) ─────────────────────────────────────────
const MENU = `
BBARIT Terminal Control CLI — bbarit-ctl
════════════════════════════════════════════════════════════════════════
Usage    npm run ctl -- <command> [args…] [options]      (repo)
         node bbarit-ctl.mjs <command> [args…]           (standalone download)
Options  --port <n>     target port (dev app auto-scan 9323–9422 / installed 9223)
         --json         raw JSON output
         --window <lbl> target window label (default: main)
         --timeout <ms> response timeout (default 20000)

■ Status
  status                          active project / view / open files
  commands                        full command-bus dictionary from the app
  menu                            this menu

■ Projects
  project list                    open projects
  project create <workDir> [name] open a folder as a project (switch if open)
  project switch <projectId>      switch the active project

■ Layout & view
  view <mode>                     default|terminal|editor|kanban|pm2|hub|side|project-terminal
  layout <mode>                   terminal split: tabs|horizontal|vertical|grid|mix|tiled|tiled_tb|tree|monitor
  sidebar <on|off>                show/hide the file tree sidebar

■ Terminals
  term list                       terminals of the active project
  term create [cliType] [workDir] new terminal (shell|claude|codex|bbarit…)
  term write <text…>              type into the active terminal + Enter
  term write-raw <text…>          type without Enter
  term read [lines]               last N lines of the terminal buffer (default 80)
  term use <terminalId>           focus a terminal tab
  term close <terminalId>         close a terminal
  (target a specific terminal: add --id <terminalId> to write/read)

■ Editor & files
  open <path>                     open a file in the built-in editor (xlsx/pptx/docx too)
  files                           list open editor tabs (path / modified / active)
  close <path>                    close an open editor tab (discards unsaved changes)

■ Panels
  panel <name>                    image|design|cowork|marketing|motion|browser|settings
  image <prompt…>                 open BBARIT Image and start a generation
  motion <prompt…>                open BBARIT Motion (fal.ai video/image) and start a render
  design <prompt…>                open BBARIT Design with a prompt
  cowork [--dir <workDir>] <prompt…>  open BBARIT Cowork and start a task
  marketing [--dir <workDir>] <prompt…>  open BBARIT Marketing and start a task
  lounge [open]                   open the Chat panel (global Lounge)
  lounge send <text…>             send a message to the global Lounge
  thread [open]                   open the BBARIT Thread window (text SNS)

■ Kanban
  kanban list [column]            tasks (backlog|todo|inprogress|review|done|cancelled)
  kanban add <title…> [--col <column>] [--pri <priority>] [--desc <text>]
             [--due YYYY-MM-DD] [--note <path|title>] [--gantt]
  kanban move <taskId> <column>   move a task (linked gantt bar follows)
  kanban update <taskId> [--title <t>] [--desc <d>] [--pri <p>] [--col <c>]
             [--due YYYY-MM-DD] [--note <path|title>] [--remove-note <path|title>]
  kanban delete <taskId>          delete a task (linked gantt bar removed)

■ Gantt (Planner)
  gantt list [--from d] [--to d]  planner events (id / title / dates / status / kanban link)
  gantt add <title…> [--date d] [--end d] [--status todo|in_progress|done] [--pri p] [--desc t]
  gantt update <eventId> [--title|--date|--end|--status|--pri|--desc …]
  gantt delete <eventId>          delete an event (kanban task unlinked)

■ Scheduler (스케줄링 에이전트 — natural-language terminal command scheduling)
  sched list                      scheduled jobs (id / command / schedule / next run)
  sched add <natural line…>       e.g. sched add "매일 9시에 npm run build" | "10분마다 git pull"
  sched rm <jobId>                delete a job
  sched on <jobId> / off <jobId>  resume / pause a job
  sched run <jobId>               run a job right now
  sched panel                     open the Scheduler panel UI

■ Settings
  config get [path]               read app config (e.g. agent.bbaritPersona)
  config set <path> <json>        change a setting (e.g. agent.bbaritLanguage '"en"')
  persona list [query]            list/search the BBARIT Agent persona library
  persona set <id|off>            set/clear the default persona

■ Harness (edits agent config files directly — works without the app)
  harness roles                   per-role model & persona overview
  harness model <role|all> <provider/model|clear>
  harness persona <role> <personaId|clear>
    role = planner|developer|reviewer

■ All actions (command palette — every menu & action)
  action list [query]             list/search every registered app action
  action run <id>                 run an action (e.g. action run cp.terminal.new)

■ Utility
  copy <text…>                    copy to the system clipboard
  notify <text…> [--title <t>]    show a native OS notification
  screenshot [file]               capture the app window (via dev-screen)
  snapshot [file]                 DOM snapshot (via dev-screen)
  js <code>                       run JS inside the app webview (via dev-screen)

Requires a running app. Ports: dev 9323–9422 → installed 9223 (auto fallback).
Full docs: docs/BBARIT_CLI.md (also in Settings → Control CLI).
════════════════════════════════════════════════════════════════════════`;

// ── Delegation to dev-screen ─────────────────────────────────────────────
function delegateDevScreen(subArgs) {
  const script = path.join(__dirname, 'tauri-dev-screen.mjs');
  if (!fs.existsSync(script)) {
    console.error('✗ screenshot/snapshot/js need tauri-dev-screen.mjs next to this script (repo: scripts/). All other commands work standalone.');
    process.exitCode = 1;
    return;
  }
  const extra = flags.port ? ['--port', String(flags.port)] : [];
  const r = spawnSync('node', [script, ...subArgs, ...extra], { stdio: 'inherit' });
  process.exitCode = r.status ?? 0;
}

// ── Command routing ──────────────────────────────────────────────────────
function pickIdFlag(list) {
  const i = list.indexOf('--id');
  if (i >= 0) { const id = list[i + 1]; list.splice(i, 2); return id; }
  return undefined;
}

async function main() {
  switch (command) {
    case 'menu':
    case 'help':
      console.log(MENU);
      return;

    case 'status': return out((await dispatch({ cmd: 'status' })).parsed);

    case 'commands': {
      const { parsed } = await dispatch({ cmd: 'commands.list' });
      if (flags.json || parsed.ok === false) return out(parsed);
      let group = '';
      for (const c of parsed.commands) {
        if (c.group !== group) { group = c.group; console.log(`\n■ ${group}`); }
        console.log(`  ${c.cmd.padEnd(22)} ${c.args.padEnd(34)} ${c.desc}`);
      }
      return;
    }

    case 'project': {
      const sub = args.shift();
      if (sub === 'list') {
        const { parsed } = await dispatch({ cmd: 'project.list' });
        if (flags.json || parsed.ok === false) return out(parsed);
        return table(parsed.projects, ['id', 'name', 'workDir']);
      }
      if (sub === 'create') return out((await dispatch({ cmd: 'project.create', workDir: args[0], name: args[1] })).parsed);
      if (sub === 'switch') return out((await dispatch({ cmd: 'project.switch', projectId: args[0] })).parsed);
      throw new Error('usage: project list|create <workDir> [name]|switch <projectId>');
    }

    case 'view': return out((await dispatch({ cmd: 'view.set', view: args[0] })).parsed);
    case 'layout': return out((await dispatch({ cmd: 'terminal.layout.set', layout: args[0] })).parsed);
    case 'sidebar': return out((await dispatch({ cmd: 'sidebar.set', visible: args[0] !== 'off' })).parsed);

    case 'term': {
      const sub = args.shift();
      const id = pickIdFlag(args);
      if (sub === 'list') {
        const { parsed } = await dispatch({ cmd: 'terminal.list' });
        if (flags.json || parsed.ok === false) return out(parsed);
        console.log(`splitMode: ${parsed.splitMode}`);
        return table(parsed.terminals, ['id', 'name', 'cliType', 'active']);
      }
      if (sub === 'create') return out((await dispatch({ cmd: 'terminal.create', cliType: args[0], workDir: args[1] })).parsed);
      if (sub === 'write') return out((await dispatch({ cmd: 'terminal.write', terminalId: id, text: args.join(' ') })).parsed);
      if (sub === 'write-raw') return out((await dispatch({ cmd: 'terminal.write', terminalId: id, text: args.join(' '), submit: false })).parsed);
      if (sub === 'read') {
        const { parsed } = await dispatch({ cmd: 'terminal.read', terminalId: id, lines: Number(args[0]) || 80 });
        if (flags.json || parsed.ok === false) return out(parsed);
        return console.log(parsed.text);
      }
      if (sub === 'use') return out((await dispatch({ cmd: 'terminal.activate', terminalId: args[0] })).parsed);
      if (sub === 'close') return out((await dispatch({ cmd: 'terminal.close', terminalId: args[0] })).parsed);
      throw new Error('usage: term list|create|write|write-raw|read|use|close');
    }

    case 'open': return out((await dispatch({ cmd: 'editor.open', path: args[0] })).parsed);
    case 'files': {
      const { parsed } = await dispatch({ cmd: 'editor.list' });
      if (flags.json || parsed.ok === false) return out(parsed);
      return table(parsed.files, ['path', 'kind', 'modified', 'active']);
    }
    case 'close': return out((await dispatch({ cmd: 'editor.close', path: args[0] })).parsed);

    case 'kanban': {
      const sub = args.shift();
      const pickFlag = (name) => {
        const i = args.indexOf(name);
        if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v; }
        return undefined;
      };
      if (sub === 'list') {
        const { parsed } = await dispatch({ cmd: 'kanban.list', column: args[0] });
        if (flags.json || parsed.ok === false) return out(parsed);
        if (!parsed.tasks.length) return console.log('(no tasks)');
        return table(
          parsed.tasks.map((t) => ({ ...t, due: t.dueDate || '-', notes: (t.linkedNotes || []).length || '-', gantt: t.calendarEventId ? 'y' : '-' })),
          ['id', 'title', 'column', 'priority', 'due', 'notes', 'gantt'],
        );
      }
      if (sub === 'add') {
        const column = pickFlag('--col');
        const priority = pickFlag('--pri');
        const description = pickFlag('--desc');
        const dueDate = pickFlag('--due');
        const note = pickFlag('--note');
        const gantt = args.includes('--gantt') ? (args.splice(args.indexOf('--gantt'), 1), true) : undefined;
        return out((await dispatch({ cmd: 'kanban.add', title: args.join(' '), column, priority, description, dueDate, note, gantt })).parsed);
      }
      if (sub === 'move') return out((await dispatch({ cmd: 'kanban.move', taskId: args[0], column: args[1] })).parsed);
      if (sub === 'update') {
        const title = pickFlag('--title');
        const description = pickFlag('--desc');
        const priority = pickFlag('--pri');
        const column = pickFlag('--col');
        const dueDate = pickFlag('--due');
        const note = pickFlag('--note');
        const removeNote = pickFlag('--remove-note');
        return out((await dispatch({ cmd: 'kanban.update', taskId: args[0], title, description, priority, column, dueDate, note, removeNote })).parsed);
      }
      if (sub === 'delete') return out((await dispatch({ cmd: 'kanban.delete', taskId: args[0] })).parsed);
      throw new Error('usage: kanban list [column] | add <title…> [--col c] [--pri p] [--desc d] [--due YYYY-MM-DD] [--note <path|title>] [--gantt] | move <taskId> <column> | update <taskId> [--title|--desc|--pri|--col|--due|--note|--remove-note …] | delete <taskId>');
    }

    case 'gantt': {
      const sub = args.shift();
      const pickFlag = (name) => {
        const i = args.indexOf(name);
        if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v; }
        return undefined;
      };
      if (sub === 'list') {
        const from = pickFlag('--from');
        const to = pickFlag('--to');
        const { parsed } = await dispatch({ cmd: 'gantt.list', from, to });
        if (flags.json || parsed.ok === false) return out(parsed);
        if (!parsed.events.length) return console.log('(no events)');
        return table(
          parsed.events.map((e) => ({ ...e, endDate: e.endDate || '-', status: e.status || '-', kanban: e.kanbanTaskId || '-' })),
          ['id', 'title', 'date', 'endDate', 'status', 'kanban'],
        );
      }
      if (sub === 'add') {
        const date = pickFlag('--date');
        const endDate = pickFlag('--end');
        const status = pickFlag('--status');
        const priority = pickFlag('--pri');
        const description = pickFlag('--desc');
        return out((await dispatch({ cmd: 'gantt.add', title: args.join(' '), date, endDate, status, priority, description })).parsed);
      }
      if (sub === 'update') {
        const title = pickFlag('--title');
        const date = pickFlag('--date');
        const endDate = pickFlag('--end');
        const status = pickFlag('--status');
        const priority = pickFlag('--pri');
        const description = pickFlag('--desc');
        return out((await dispatch({ cmd: 'gantt.update', eventId: args[0], title, date, endDate, status, priority, description })).parsed);
      }
      if (sub === 'delete') return out((await dispatch({ cmd: 'gantt.delete', eventId: args[0] })).parsed);
      throw new Error('usage: gantt list [--from YYYY-MM-DD] [--to YYYY-MM-DD] | add <title…> [--date d] [--end d] [--status s] [--pri p] [--desc d] | update <eventId> [--title|--date|--end|--status|--pri|--desc …] | delete <eventId>');
    }

    case 'sched': {
      const sub = args.shift();
      if (sub === 'list') {
        const { parsed } = await dispatch({ cmd: 'schedule.list' });
        if (flags.json || parsed.ok === false) return out(parsed);
        if (!parsed.jobs.length) return console.log('(no scheduled jobs)');
        return table(
          parsed.jobs.map((j) => ({ ...j, enabled: j.enabled ? 'on' : 'off', nextRun: j.nextRun ? j.nextRun.replace('T', ' ').slice(0, 16) : '-' })),
          ['id', 'command', 'schedule', 'enabled', 'nextRun'],
        );
      }
      if (sub === 'add') return out((await dispatch({ cmd: 'schedule.add', command: args.join(' ') })).parsed);
      if (sub === 'rm') return out((await dispatch({ cmd: 'schedule.delete', jobId: args[0] })).parsed);
      if (sub === 'on') return out((await dispatch({ cmd: 'schedule.toggle', jobId: args[0], enabled: true })).parsed);
      if (sub === 'off') return out((await dispatch({ cmd: 'schedule.toggle', jobId: args[0], enabled: false })).parsed);
      if (sub === 'run') return out((await dispatch({ cmd: 'schedule.run', jobId: args[0] })).parsed);
      if (sub === 'panel') return out((await dispatch({ cmd: 'schedule.panel' })).parsed);
      throw new Error('usage: sched list | add <natural line…> | rm <jobId> | on <jobId> | off <jobId> | run <jobId> | panel');
    }

    case 'panel': return out((await dispatch({ cmd: 'panel.open', panel: args[0] })).parsed);
    case 'image': return out((await dispatch({ cmd: 'image.generate', prompt: args.join(' ') })).parsed);
    case 'design': {
      if (args[0] === 'canvas') return out((await dispatch({ cmd: 'design.canvas', action: args[1] || 'status' })).parsed);
      return out((await dispatch({ cmd: 'design.open', prompt: args.join(' ') })).parsed);
    }
    case 'cowork': {
      let workDir;
      const di = args.indexOf('--dir');
      if (di >= 0) { workDir = args[di + 1]; args.splice(di, 2); }
      return out((await dispatch({ cmd: 'cowork.open', workDir, prompt: args.join(' ') })).parsed);
    }

    case 'marketing': {
      let workDir;
      const di = args.indexOf('--dir');
      if (di >= 0) { workDir = args[di + 1]; args.splice(di, 2); }
      return out((await dispatch({ cmd: 'marketing.open', workDir, prompt: args.join(' ') })).parsed);
    }

    case 'motion':
      return out((await dispatch({ cmd: 'motion.generate', prompt: args.join(' ') })).parsed);

    case 'lounge': {
      const sub = args.shift();
      if (sub === 'send') return out((await dispatch({ cmd: 'lounge.send', text: args.join(' ') })).parsed);
      if (!sub || sub === 'open') return out((await dispatch({ cmd: 'lounge.open' })).parsed);
      console.error(`Unknown lounge subcommand: ${sub} (open|send)`);
      process.exitCode = 1;
      return;
    }

    case 'thread': {
      const sub = args.shift();
      if (!sub || sub === 'open') return out((await dispatch({ cmd: 'thread.open' })).parsed);
      console.error(`Unknown thread subcommand: ${sub} (open)`);
      process.exitCode = 1;
      return;
    }

    case 'config': {
      const sub = args.shift();
      if (sub === 'get') return out((await dispatch({ cmd: 'config.get', path: args[0] || '' })).parsed);
      if (sub === 'set') {
        let value;
        try { value = JSON.parse(args.slice(1).join(' ')); } catch { value = args.slice(1).join(' '); }
        return out((await dispatch({ cmd: 'config.patch', path: args[0], value })).parsed);
      }
      throw new Error('usage: config get [path] | config set <path> <json>');
    }

    case 'persona': {
      const sub = args.shift();
      if (sub === 'list') {
        const { parsed } = await dispatch({ cmd: 'persona.list' });
        if (flags.json || parsed.ok === false) return out(parsed);
        const q = (args[0] || '').toLowerCase();
        const rows = parsed.personas.filter((p) => !q || `${p.id} ${p.name} ${p.division}`.toLowerCase().includes(q));
        table(rows, ['id', 'name', 'division']);
        return console.log(`\n${rows.length} personas${q ? ` (query: ${q})` : ''}`);
      }
      if (sub === 'set') return out((await dispatch({ cmd: 'persona.set', id: args[0] === 'off' ? '' : args[0] })).parsed);
      throw new Error('usage: persona list [query] | persona set <id|off>');
    }

    case 'harness': {
      const sub = args.shift();
      const modelsFile = path.join(AGENT_DIR, 'harness-models.json');
      const personasFile = path.join(AGENT_DIR, 'harness-personas.json');
      const ROLES = ['planner', 'developer', 'reviewer'];
      if (sub === 'roles') {
        const models = readJson(modelsFile);
        const personas = readJson(personasFile);
        return table(
          ROLES.map((r) => ({ role: r, model: models[r] || '(current model)', persona: personas[r] || '(none)' })),
          ['role', 'model', 'persona'],
        );
      }
      if (sub === 'model') {
        const role = args[0];
        const value = args[1];
        const models = readJson(modelsFile);
        const apply = (r) => { if (!value || value === 'clear') delete models[r]; else models[r] = value; };
        if (role === 'all') ROLES.forEach(apply);
        else if (ROLES.includes(role)) apply(role);
        else throw new Error(`role must be ${ROLES.join('|')}|all`);
        writeJson(modelsFile, models);
        return console.log(`✓ harness model — ${role} = ${value || 'clear'}`);
      }
      if (sub === 'persona') {
        const role = args[0];
        const value = args[1];
        if (!ROLES.includes(role)) throw new Error(`role must be ${ROLES.join('|')}`);
        const personas = readJson(personasFile);
        if (!value || value === 'clear') delete personas[role];
        else personas[role] = value;
        writeJson(personasFile, personas);
        return console.log(`✓ harness persona — ${role} = ${value || 'clear'}`);
      }
      throw new Error('usage: harness roles | harness model <role|all> <ref|clear> | harness persona <role> <id|clear>');
    }

    case 'action': {
      const sub = args.shift();
      if (sub === 'list') {
        const { parsed } = await dispatch({ cmd: 'palette.list' });
        if (flags.json || parsed.ok === false) return out(parsed);
        const q = (args[0] || '').toLowerCase();
        const rows = parsed.actions.filter((a) => !q || `${a.id} ${a.label} ${a.category}`.toLowerCase().includes(q));
        table(rows.map((a) => ({ id: a.id, label: a.label, category: a.category, shortcut: a.shortcut || '' })), ['id', 'label', 'category', 'shortcut']);
        return console.log(`\n${rows.length} actions${q ? ` (query: ${q})` : ''}`);
      }
      if (sub === 'run') return out((await dispatch({ cmd: 'palette.run', id: args[0] })).parsed);
      throw new Error('usage: action list [query] | action run <id>');
    }

    case 'copy': return out((await dispatch({ cmd: 'clipboard.copy', text: args.join(' ') })).parsed);
    case 'notify': {
      const ti = args.indexOf('--title');
      let title;
      if (ti >= 0) { title = args[ti + 1]; args.splice(ti, 2); }
      return out((await dispatch({ cmd: 'notify', text: args.join(' '), title })).parsed);
    }

    case 'screenshot': return delegateDevScreen(['screenshot', ...(args[0] ? ['--file', args[0]] : [])]);
    case 'snapshot': return delegateDevScreen(['snapshot', ...(args[0] ? ['--file', args[0]] : [])]);
    case 'js': return delegateDevScreen(['js', '--code', args.join(' ')]);

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(MENU);
      process.exitCode = 1;
  }
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
