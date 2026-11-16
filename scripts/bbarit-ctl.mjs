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
 *
 * Inside a BBARIT tab: BBARIT_CTL is this file's path, BBARIT_TERMINAL_ID the tab
 * (sent as `caller` by `agent …`, with BBARIT_TERM_TOKEN as `callerToken` so the app can
 * check the claim) and BBARIT_BRIDGE_PORT the app's local bridge port
 * (19980 installed / 19981 dev), which selects its mcp-bridge port without a scan.
 */

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

// Which app the auto-scan may attach to. The fork build (tauri.opensource.conf.json)
// is the default; the original author-signed app is still accepted so the CLI keeps
// working during the transition. BBARIT_BRIDGE_APP_ID restricts it to one identifier.
const DEFAULT_APP_IDS = ['com.bbarit.terminal.source', 'com.octo.terminal'];
const ACCEPTED_APP_IDS = process.env.BBARIT_BRIDGE_APP_ID ? [process.env.BBARIT_BRIDGE_APP_ID] : DEFAULT_APP_IDS;

const DEV_BASE_PORT = 9323;
export const BRIDGE_UNREACHABLE = 'BRIDGE_UNREACHABLE';

/** The app is closed or still loading: agent wait/run keep polling (bounded by --timeout). */
export function isAppUnreachable(e) {
  if (e && e.code === BRIDGE_UNREACHABLE) return true;
  return /__BBARIT_CTL__ not ready/.test(String(e && e.message || e));
}

/**
 * Which errors agent wait/run wait out. An explicit --port names one app on purpose: a wrong
 * or closed port fails fast (3 strikes) instead of waiting for the whole --timeout.
 */
export function unreachableWaitPolicy(explicitPort) {
  return explicitPort ? () => false : isAppUnreachable;
}
const DEV_PORT_SPAN = 100;
const INSTALLED_PORT = 9223;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Argument parsing ─────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const flags = { port: 0, json: false, window: 'main', timeout: 20000, timeoutSet: false, timeoutRaw: 0, force: false };
const args = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  // `--` ends options: everything after it is passed on verbatim (with the `--` itself, so a
  // subcommand such as `agent board post` knows its text starts there).
  if (a === '--') { args.push(...rawArgs.slice(i)); break; }
  if (a === '--port') flags.port = Number(rawArgs[++i]) || 0;
  else if (a === '--json') flags.json = true;
  else if (a === '--window') flags.window = String(rawArgs[++i] || 'main');
  else if (a === '--timeout') { flags.timeoutRaw = Number(rawArgs[++i]) || 0; flags.timeout = flags.timeoutRaw || 20000; flags.timeoutSet = true; }
  else if (a === '--force') flags.force = true;
  else args.push(a);
}
const command = args.shift() || 'menu';

// ── WebSocket connection (mcp-bridge) ────────────────────────────────────
// BBARIT_BRIDGE_PORT (the app's local HTTP bridge, set in every BBARIT tab) → that app's
// mcp-bridge port: 19980 installed → 9223, 19981 dev → 9323. Unknown values are ignored.
const BRIDGE_TO_MCP_PORT = { 19980: INSTALLED_PORT, 19981: DEV_BASE_PORT };
export function mcpPortFromEnv(env = process.env) {
  return BRIDGE_TO_MCP_PORT[Number(env.BBARIT_BRIDGE_PORT)] || 0;
}

/** Scan order: the port that answered last time, the env-mapped port, then dev → installed. */
export function bridgePortCandidates(envPort = 0, lastPort = 0) {
  const scan = [...Array.from({ length: DEV_PORT_SPAN }, (_, i) => DEV_BASE_PORT + i), INSTALLED_PORT];
  return [...new Set([lastPort, envPort, ...scan].filter(Boolean))];
}

let lastBridgePort = 0;

async function connectBridge() {
  const ports = flags.port ? [flags.port] : bridgePortCandidates(mcpPortFromEnv(), lastBridgePort);
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
        if (!ACCEPTED_APP_IDS.includes(ident)) {
          try { ws.close(); } catch { /* ignore */ }
          continue;
        }
      }
      lastBridgePort = port;
      return { ws, port };
    } catch { /* try the next port */ }
  }
  const err = new Error(
    flags.port
      ? `Cannot connect to port ${flags.port}. Is the app running?`
      : `Cannot reach BBARIT Terminal (dev ports 9323–9422, installed ${INSTALLED_PORT}). Is the app running?`,
  );
  err.code = BRIDGE_UNREACHABLE;
  throw err;
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
         --timeout <ms> response timeout (default 20000; 40000 for term write)
         --force        term write: send even while the agent waits for approval

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

■ Agents (one agent delegates to another — details: agent --help)
  agent run <cliType> <prompt…>   new agent tab + prompt; waits for done/blocked (--bg: don't wait,
                                  --worktree [name]: own git worktree + agent/<name> branch)
  agent send <terminalId> <text…> type a message into an agent tab
  agent wait [--id <id> | --children any|all]   wait for child agents
  agent status [terminalId]       state + last 12 lines (children of this tab by default)
  agent list                      child agents of this tab
  agent stop [<id> | --children] [--close]   interrupt a child / all children of this tab
  agent log [--tail N]            relay audit log: who started / told / stopped whom (default 20)
  agent board post <text…> [--kind k]   post to this tab's relay team board (pull only)
  agent board read [--new] [--tail N]   read the team board (--since/--kind/--author/--search/--team)
                                  (post text with --words: agent board post -- "<text>")
  agent board teams | clear       list every team board / clear yours (in the team's root tab only)
  agent task add|list|show|claim|done|…   the team's task list: add work, claim it (--next),
                                  finish it with a result (details: agent --help)

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

// ── Agent relay (docs/AGENT_RELAY.md) ────────────────────────────────────
const AGENT_HELP = `
bbarit-ctl agent — delegate work to another agent tab and get the result back
════════════════════════════════════════════════════════════════════════
Inside a BBARIT tab call it as:  node "$BBARIT_CTL" agent <sub> …   (needs node)

  agent run <cliType> <prompt…> [--bg] [--workdir <dir>] [--name <n>] [--worktree [name]] [--timeout <s>=600]
      Open a background tab running <cliType> (claude|codex|gemini|…|shell) in this
      tab's project (cwd: --workdir, else this tab's cwd) and type <prompt> once the agent
      is ready (if it is not ready within 60 s the prompt is NOT typed: error "agent not
      ready"). The child is told which tab started it and to report back when stuck (and
      when done if your prompt asks for a report). Without --bg it waits until the child
      is done, blocked or exited, then prints its state and last 12 lines.
      Exit code: 0 done/exited · 2 blocked (child needs an answer) · 3 timed out · 1 error.
      --bg prints the new terminalId and returns at once.
      --worktree [name] gives the child its own git worktree <repo>/.bbarit/worktrees/<slug>
      on a new branch agent/<slug> from the repo's HEAD (<repo> = git top level of --workdir,
      else this tab's cwd, else its project folder; slug from [name], else --name, else <cliType>,
      made unique with -2, -3…). The folder is kept out of git status via the repo's
      .git/info/exclude. The child is told to work and commit only there and not to push,
      merge or switch branches; status/list and its notes show the branch. Not a git repo
      (or no commit yet) → error, no tab. Nothing is deleted automatically: review the
      branch, then \`git worktree remove <path>\` and \`git branch -d agent/<slug>\` yourself.
      Put the name right after the flag before the prompt, or use --worktree=<name>.
      Creating the worktree runs in the background in the app; this command polls for the
      result for up to 120 s (then: error, the tab may still open — check agent list).
      Limits (app config agents { maxChildren, maxDepth, maxTotal }, defaults 6 / 2 / 12):
      at most 6 live children per tab, a child at most 2 levels below a tab without a relay
      parent (a grandchild cannot start another agent), at most 12 live relay agents in the
      app. Past a limit nothing is created and the run fails (exit code 1) with e.g.
        child limit reached: this tab already has 6 live children (max 6; a stopped child
        still counts: close one with agent stop <id> --close, or raise agents.maxChildren)
      A stopped child still counts until its tab is closed: close a finished child
      (agent stop <id> --close), do the work yourself, or ask the user to raise the limit.
      maxChildren/maxDepth count by the caller id, which the app checks against this tab's
      token (one tab cannot count as another); a guard against accidents, not a security
      boundary against local processes. maxTotal counts every relay agent.
  agent send <terminalId> <text…> [--force]
      Type <text> + Enter into an agent tab, wrapped as <bbarit from="<this tab>">…</bbarit>.
      Waits while the user is typing; refused while that agent waits for approval or an
      answer unless --force (use --force to answer a blocked child's question).
  agent wait [--id <terminalId> | --children any|all] [--timeout <s>=600]
      Poll every 2 s until one child (any) / every child (all, default) of this tab — or
      the one --id — is done, blocked or exited. Prints the states (--json for JSON).
      A child without OSC 7501 status counts as done after 30 s of silence (a shell only
      once its prompt is back), shown as "yes (quiet-heuristic)".
      Exit code: 0 · 2 if a child is blocked · 3 timed out.
  agent status [terminalId]
      State (working|blocked|done|idle), kind, exited, settled and the last 12 lines —
      for <terminalId>, or every child of this tab.
  agent list
      Child agents of this tab (same fields, no lines).
  agent stop [<terminalId> | --children] [--close]
      Interrupt one child of this tab, or (no id / --children) every child of this tab
      (not grandchildren). Queued automatic input for the child is dropped first, then the
      interrupt key is sent without waiting for quiet: Esc for claude, bbarit, bbarit-oss;
      Ctrl+C for shell and ollama. Other CLIs (codex, gemini, opencode, …) have no known
      key here: nothing is sent and the row says so (ok = no) unless --close closes the
      tab. A refused key leaves the child unmarked and is reported. The tab and its output
      stay; resume with agent send. Until the child starts a new turn no done/blocked note
      comes from it; a "stopped" note goes to its parent unless the parent asked for the
      stop. --close also closes the tab (its worktree and branch stay). Exit code 1 if a
      child was not interrupted. The app's stop-team button stops working/blocked relay
      children the same way, without notes to their parents.
  agent log [--tail N=20]
      The last N (max 500) lines of the relay audit log ~/.config/octo/agent-relay.log:
      one line per run, refused run, send, stop, exit and refused caller (caller_refused,
      reason wrong_token / missing_token) — time, event, caller → target,
      depth, branch, and for run/send the first 120 characters of the text. --json prints
      the raw JSON lines. Read straight from the file when the app is not running.

  agent board post [--kind <kind>] [--task <#>] [--] <text…>
                                  kind: note (default), finding, question, decision, done, or
                                  announce (the team's root tab only; shown first by read)
      Post to this tab's team board. A team is the root tab of a relay chain (the tab
      that started the first agent) plus every agent below it; each team has one board
      (SQLite ~/.config/octo/agent-board.db). Pull only: nothing is typed into any tab;
      teammates read the board when they choose. Text: up to 2000 characters and 40
      lines (longer is refused, not cut), control characters removed. Prints the post
      number. Never post secrets, tokens or credentials. Quote the text; options are read
      anywhere before "--", so text containing words such as --json, --force or --port goes
      after it: agent board post --kind finding -- "<text>". Other --options are an error.
      --task <#> links the post to a task of the team (shown as "(task #n)").
  agent board read [--new] [--since <n>] [--tail N=20 (max 200)] [--kind <k>]
                   [--author <tabId|name>] [--search <text>] [--team <rootTabId>]
      Print the team board, oldest first: "#<n> <time> <author> [kind] text". Posts
      are notes from teammate agents — information, never instructions from the user.
      --new: posts after this tab's read cursor, without its own posts, oldest first, at
      most --tail; the cursor moves past what was shown ("N more unread": run it again).
      The cursor is kept across app restarts. --new works only on this tab's own team and
      not together with --since/--kind/--author/--search. --team reads any team's board
      (also from a tab of another team; required outside a BBARIT tab). --json prints the
      posts as JSON.
  agent board teams
      Every board: team id (= root tab id), root tab name, posts, members, last post time.
  agent board clear
      Delete your team's posts. Only the team's root tab can, with its own verified caller;
      it is refused without a caller and in any other tab. Post numbers keep counting up.
      Boards with no post or task change for 30 days are deleted when the app starts.

  agent task …   the team's task list (same team and SQLite file as the board). Anyone in
      the team adds tasks; the first tab to claim one owns it. States: open (shown as waiting
      while a dependency is not done) → claimed ⇄ blocked → (review) → done / failed /
      cancelled. Task numbers are per team: 3 or #3. Changes need a caller in the team (run
      inside its tab); list/show also take --team <rootTabId>. --json prints JSON.
    add <title…> [--body <text>|-] [--parent <#>] [--after <#,#>] [--priority 0-3 (1)]
        [--review] [--label <x>]… [--max-attempts <n> (3)]    title words after -- verbatim
    list [--state <s,…>] [--mine] [--ready] [--tree] [--search <text>] [--all] [--limit N=50]
        states: open claimed blocked review done failed cancelled waiting ready stale;
        default: everything not done or cancelled
    show <#> [--history]          details, dependencies, result and (--history) every change
    claim <#> | --next            take a task (--next: highest priority, then lowest number,
                                  among open tasks whose dependencies are done). Exit code 4
                                  when nothing is ready. The claim is a lease the app renews
                                  while this tab is open; closing or exiting the tab hands the
                                  task back, and an abandoned lease expires (5 min default).
    block <#> --reason <text>     stop and say why (still yours) · unblock <#>
    release <#>                   hand it back unchanged
    done <#> --summary <one line> [--body <text>|-] [--branch b] [--commit sha] [--worktree p]
        [--checks passed|failed|none] [--artifact key=value]…   finish it (writes a "done" note
        to the board). Branch/worktree default to this tab's relay worktree.
    submit <#> --summary …        same fields, for a task added with --review: someone else
                                  then runs approve <#> or reject <#> --reason <text>
    fail <#> --error <text>       give up; retry <#> reopens it (members up to --max-attempts,
                                  the root tab beyond) · reopen <#> (root tab: a done task)
    cancel <#> [--reason <text>]  who added it, or the root tab · edit <#> [--title t] [--body b|-]
        [--priority n] [--label x]… [--review|--no-review]
    dep add|rm <#> <#on>          #<#> waits for #<on> (same team; cycles are refused)

Caller  BBARIT_TERMINAL_ID (set in every BBARIT tab) is sent as the caller, with the tab's
        BBARIT_TERM_TOKEN; the app refuses a caller whose token does not match ("caller
        not verified"). --caller <id> works only with that tab's token (--caller-token <t>
        or the env): it is not a way to act as another tab. Tabs opened before the update
        that added tokens keep working only while they still run in the PTY holder;
        otherwise reopen the tab. Without a caller a run is nobody's child.
        Children link to their caller's tab.
Depth   0 for a tab without a relay parent, 1 for its children, 2 for grandchildren
        (status/list show it).

Notes from children (typed into this tab automatically — only agent tabs whose agent
reported OSC 7501 working/blocked/done in the last 30 min, e.g. Claude Code; plain shells
get none, use agent wait). Shell metacharacters in note bodies are replaced by look-alikes:
  <bbarit from="<id> <name>" state="done" turn="2">last lines… — 전체: node "$BBARIT_CTL" term read 60 --id <id></bbarit>
  <bbarit from="<id> <name>" state="blocked" kind="question">question… — 답하기: node "$BBARIT_CTL" agent send <id> "…"</bbarit>
  <bbarit from="<id> <name>" state="exited">last lines… — 전체: …</bbarit>
  <bbarit from="<id> <name>" state="stopped">stopped by … — 이어 가기: node "$BBARIT_CTL" agent send <id> "…" · 출력: …</bbarit>
A blocked child is waiting for permission or an answer: read the question, then
  node "$BBARIT_CTL" agent send <id> "<answer>" --force
(or tell the user, for permission prompts they must approve in that tab).
Notes for a tab that is itself blocked are held and delivered once it continues.

Examples
  node "$BBARIT_CTL" agent run claude "Review the diff on this branch and list bugs."
  node "$BBARIT_CTL" agent run claude --worktree fix-login "Fix the login test and commit" --bg
  id=$(node "$BBARIT_CTL" agent run codex "Run the tests and fix failures" --bg)
  node "$BBARIT_CTL" agent wait --children all --timeout 900
  node "$BBARIT_CTL" agent task claim --next && … && node "$BBARIT_CTL" agent task done 3 --summary "parser done, 12 tests pass"
════════════════════════════════════════════════════════════════════════`;

export const AGENT_POLL_MS = 2000;
export const AGENT_DEFAULT_WAIT_S = 600;

/** any: at least one settled · all: every one settled. An empty list never satisfies. */
export function evaluateAgentWait(agents, mode = 'all') {
  if (!Array.isArray(agents) || agents.length === 0) return false;
  return mode === 'any' ? agents.some((a) => a && a.settled) : agents.every((a) => a && a.settled);
}

/**
 * Poll fetchAgents() every intervalMs until evaluateAgentWait holds or timeoutMs passes.
 * Up to 3 consecutive fetch failures are retried (the app may be mid-reload). While the
 * app is unreachable (closed — its terminals live on in the PTY holder — or loading) it
 * keeps polling until the timeout and calls onUnreachable once.
 */
export async function waitForAgents({
  fetchAgents,
  mode = 'all',
  timeoutMs = AGENT_DEFAULT_WAIT_S * 1000,
  intervalMs = AGENT_POLL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  isUnreachable = isAppUnreachable,
  onUnreachable = () => {},
}) {
  const startedAt = now();
  let agents = [];
  let failures = 0;
  let warned = false;
  for (;;) {
    try {
      agents = await fetchAgents();
      failures = 0;
      if (evaluateAgentWait(agents, mode)) return { timedOut: false, agents };
    } catch (e) {
      if (isUnreachable(e)) {
        if (!warned) { warned = true; onUnreachable(e); }
      } else {
        failures += 1;
        if (failures >= 3) throw e;
      }
    }
    if (now() - startedAt >= timeoutMs) return { timedOut: true, agents };
    await sleep(intervalMs);
  }
}

/** 3 timed out · 1 a child could not be started · 2 a settled child is blocked · 0 otherwise. */
export function agentExitCode({ timedOut, agents }) {
  if (timedOut) return 3;
  if ((agents || []).some((a) => a && a.error)) return 1;
  if ((agents || []).some((a) => a && a.settled && a.state === 'blocked' && !a.exited)) return 2;
  return 0;
}

function pickFlagFrom(list, name) {
  const i = list.indexOf(name);
  if (i < 0) return undefined;
  const v = list[i + 1];
  list.splice(i, 2);
  return v;
}

/**
 * `caller` / `callerToken` for agent.* requests (removes --caller / --caller-token from
 * `list`): the flag, else BBARIT_TERMINAL_ID / BBARIT_TERM_TOKEN. The app checks the token
 * against the caller id, so --caller alone cannot act as another tab. No caller → {}.
 */
export function agentCallerFields(list, env = process.env) {
  const flagCaller = pickFlagFrom(list, '--caller');
  const flagToken = pickFlagFrom(list, '--caller-token');
  const caller = String(flagCaller || env.BBARIT_TERMINAL_ID || '').trim();
  if (!caller) return {};
  const callerToken = String(flagToken || env.BBARIT_TERM_TOKEN || '').trim();
  return callerToken ? { caller, callerToken } : { caller };
}

function pickBoolFrom(list, name) {
  const i = list.indexOf(name);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/**
 * `agent run … --worktree [name]` (removed from `list`). Returns undefined (no flag), true
 * (name derived from the child) or the name. `--worktree=<name>` always works; a bare word
 * after `--worktree` is the name only while <cliType> and a prompt word still remain.
 */
export function takeWorktreeFlag(list) {
  const i = list.findIndex((a) => a === '--worktree' || String(a).startsWith('--worktree='));
  if (i < 0) return undefined;
  const flag = String(list[i]);
  if (flag.startsWith('--worktree=')) {
    list.splice(i, 1);
    return flag.slice('--worktree='.length).trim() || true;
  }
  const next = list[i + 1];
  if (next !== undefined && !String(next).startsWith('-') && list.length - 2 >= 2) {
    list.splice(i, 2);
    return String(next);
  }
  list.splice(i, 1);
  return true;
}

export const WORKTREE_RUN_TIMEOUT_S = 120;

/**
 * agent.run with a worktree replies { pending, jobId } at once (git may take longer than one
 * bridge request); poll agent.run.result until it has the real result or timeoutMs passes.
 */
export async function awaitAgentRunJob({
  first,
  fetchResult,
  timeoutMs = WORKTREE_RUN_TIMEOUT_S * 1000,
  intervalMs = 500,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
}) {
  if (!first || first.ok === false || !first.pending || !first.jobId) return first;
  const startedAt = now();
  for (;;) {
    if (now() - startedAt >= timeoutMs) {
      return { ok: false, timedOut: true, jobId: first.jobId, error: `worktree still being created after ${Math.round(timeoutMs / 1000)} s; the tab may still open — check: agent list` };
    }
    await sleep(intervalMs);
    let res;
    try {
      res = await fetchResult(first.jobId);
    } catch {
      continue; // app reloading or a dropped connection: keep polling until the timeout
    }
    if (res && (res.ok === false || !res.pending)) return res; // null → still pending
  }
}

/** `agent stop [<terminalId> | --children] [--close]` (no id means --children). */
export function parseStopArgs(list) {
  const rest = [...list];
  const close = pickBoolFrom(rest, '--close');
  const childrenFlag = pickBoolFrom(rest, '--children');
  const usage = 'usage: agent stop [<terminalId> | --children] [--close]';
  if (rest.some((a) => String(a).startsWith('-')) || rest.length > 1) throw new Error(usage);
  const terminalId = rest[0];
  if (terminalId && childrenFlag) throw new Error(usage);
  return terminalId ? { terminalId, children: false, close } : { children: true, close };
}

/** 1 when agent.stop failed or any target could not be interrupted. */
export function stopExitCode(parsed) {
  if (!parsed || parsed.ok === false) return 1;
  return (parsed.stopped || []).every((r) => r && r.ok) ? 0 : 1;
}

/** Table row for one agent. A settle guessed from 30 s of silence (no OSC 7501) is marked. */
export function agentRow(a) {
  return {
    ...a,
    state: a.state === 'blocked' && a.kind ? `blocked:${a.kind}` : a.state,
    exited: a.exited ? 'yes' : '-',
    settled: a.settled ? (a.settledBy === 'quiet' ? 'yes (quiet-heuristic)' : 'yes') : '-',
    branch: a.branch || '-',
  };
}

/** The status/list table; the branch column appears once a child runs in its own worktree. */
export function agentTableColumns(agents) {
  const list = agents || [];
  const withDepth = list.some((a) => a && typeof a.depth === 'number');
  const cols = ['terminalId', 'name', 'cliType', ...(withDepth ? ['depth'] : []), 'state', 'settled', 'exited'];
  return list.some((a) => a && a.branch) ? [...cols, 'branch'] : cols;
}

// ── Relay audit log (agent log) ──────────────────────────────────────────
export const AGENT_LOG_DEFAULT_TAIL = 20;
export const AGENT_LOG_MAX_TAIL = 500;

/** `agent log [--tail N | --tail=N]` → { tail } (1..500, default 20). */
export function parseLogArgs(list) {
  const usage = 'usage: agent log [--tail N] [--json]';
  let raw;
  let seen = false;
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i]);
    if (a.startsWith('--tail=')) { raw = a.slice('--tail='.length); }
    else if (a === '--tail') {
      raw = list[i + 1];
      if (raw === undefined || String(raw).startsWith('-')) throw new Error(usage);
      i += 1;
    } else throw new Error(usage);
    if (seen) throw new Error(usage);
    seen = true;
  }
  if (!seen) return { tail: AGENT_LOG_DEFAULT_TAIL };
  const n = Number(raw);
  if (String(raw).trim() === '' || !Number.isFinite(n) || n < 1) throw new Error(usage);
  return { tail: Math.min(AGENT_LOG_MAX_TAIL, Math.trunc(n)) };
}

/** Read at most this many bytes from the end of each log file (the app rotates at 1 MiB). */
export const RELAY_LOG_READ_MAX_BYTES = 1024 * 1024;

/**
 * The last `maxBytes` of a file as text (invalid UTF-8 replaced). When the read starts
 * mid-file the first, partial line is dropped. Missing / unreadable file → ''.
 */
export function readFileTail(file, maxBytes = RELAY_LOG_READ_MAX_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    const text = buf.subarray(0, off).toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** ~/.config/octo/agent-relay.log (written by the app). */
export function relayLogPath(home = os.homedir()) {
  return path.join(home, '.config', 'octo', 'agent-relay.log');
}

/** Last n non-empty lines across the rotated file (older) and the current one. */
export function tailRelayLogText(current, rotated, n) {
  const lines = (t) => String(t || '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const cur = lines(current);
  const all = cur.length < n ? [...lines(rotated), ...cur] : cur;
  return all.slice(Math.max(0, all.length - n));
}

/** The log read straight from disk (app not running). Missing files → []. */
export function readRelayLogFile(n, file = relayLogPath(), maxBytes = RELAY_LOG_READ_MAX_BYTES) {
  return tailRelayLogText(readFileTail(file, maxBytes), readFileTail(`${file}.1`, maxBytes), n);
}

function logParty(p) {
  if (!p || typeof p !== 'object') return '-';
  return [p.id, p.name, p.cliType ? `(${p.cliType})` : ''].filter(Boolean).join(' ') || '-';
}

/** One log line, human-readable: time, event, caller → target, depth, branch, details, text head. */
export function formatRelayLogLine(line) {
  let e;
  try { e = JSON.parse(line); } catch { return String(line); }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return String(line);
  const parts = [String(e.ts || '-'), String(e.event || '?').padEnd(11), `${logParty(e.caller)} → ${logParty(e.target)}`];
  if (typeof e.depth === 'number') parts.push(`depth=${e.depth}`);
  if (e.branch) parts.push(`branch=${e.branch}`);
  for (const k of ['by', 'ok', 'keys', 'closed', 'force', 'reason', 'count', 'max', 'cmd', 'team', 'kind', 'seq', 'task', 'from', 'to', 'owner', 'post', 'removed', 'callerVerified']) {
    const v = e[k];
    if (v === undefined || v === '') continue;
    parts.push(`${k}=${typeof v === 'boolean' ? (v ? 'yes' : 'no') : v}`);
  }
  if (typeof e.textLen === 'number') {
    const head = String(e.textHead ?? '');
    parts.push(`"${head}${e.textLen > Array.from(head).length ? '…' : ''}" (${e.textLen} chars)`);
  }
  return parts.join('  ');
}

// ── Team board (agent board) ─────────────────────────────────────────────
export const BOARD_KINDS = ['note', 'finding', 'question', 'decision', 'done', 'announce'];
export const BOARD_DEFAULT_TAIL = 20;
export const BOARD_MAX_TAIL = 200;

/**
 * `--name v` or `--name=v` (removed from list); throws `usage` when the value is missing. The
 * word after the flag is always its value, also when it starts with `--` (`--reason "--force
 * broke it"`).
 */
export function takeValueFlag(list, name, usage) {
  const i = list.findIndex((a) => a === name || String(a).startsWith(`${name}=`));
  if (i < 0) return undefined;
  const a = String(list[i]);
  if (a.startsWith(`${name}=`)) { list.splice(i, 1); return a.slice(name.length + 1); }
  const v = list[i + 1];
  if (v === undefined) throw new Error(usage);
  list.splice(i, 2);
  return String(v);
}

function positiveInt(raw, usage, min = 1) {
  const n = Number(raw);
  if (String(raw).trim() === '' || !Number.isFinite(n) || n < min) throw new Error(usage);
  return Math.trunc(n);
}

/**
 * `agent board <sub> …` → the agent.board.<sub> request fields (without caller).
 * post: text = the remaining words; read: --new --since --tail --kind --author --search --team;
 * teams: none; clear: --team.
 */
export function parseBoardArgs(sub, list) {
  const rest = [...list];
  if (sub === 'post') {
    const usage = 'usage: agent board post [--kind <kind>] [--task <#>] [--] <text…>   (kind: note|finding|question|decision|done|announce; quote the text)';
    const end = rest.indexOf('--');
    const verbatim = end >= 0 ? rest.splice(end).slice(1) : [];
    const kind = takeValueFlag(rest, '--kind', usage);
    const task = takeValueFlag(rest, '--task', usage);
    const unknown = rest.find((a) => String(a).startsWith('--'));
    if (unknown) throw new Error(`unknown option for agent board post: ${unknown} (put -- before text that contains options: agent board post --kind note -- "<text>")`);
    const text = [...rest, ...verbatim].join(' ');
    if (!text.trim()) throw new Error(usage);
    if (kind !== undefined && !BOARD_KINDS.includes(kind.trim().toLowerCase())) throw new Error(`invalid kind: ${kind} (${BOARD_KINDS.join('|')})`);
    const out = kind === undefined ? { text } : { text, kind: kind.trim().toLowerCase() };
    if (task !== undefined) out.task = taskNumber(task, usage);
    return out;
  }
  if (sub === 'read') {
    const usage = 'usage: agent board read [--new] [--since <n>] [--tail N] [--kind <k>] [--author <tabId|name>] [--search <text>] [--team <rootTabId>] [--json]';
    const out = {};
    const ni = rest.indexOf('--new');
    if (ni >= 0) { rest.splice(ni, 1); out.new = true; }
    const since = takeValueFlag(rest, '--since', usage);
    if (since !== undefined) out.since = positiveInt(since, usage, 0);
    const tail = takeValueFlag(rest, '--tail', usage);
    if (tail !== undefined) out.tail = Math.min(BOARD_MAX_TAIL, positiveInt(tail, usage));
    const kind = takeValueFlag(rest, '--kind', usage);
    if (kind !== undefined) {
      if (!BOARD_KINDS.includes(kind.trim().toLowerCase())) throw new Error(`invalid kind: ${kind} (${BOARD_KINDS.join('|')})`);
      out.kind = kind.trim().toLowerCase();
    }
    for (const [flag, key] of [['--author', 'author'], ['--search', 'search'], ['--team', 'team']]) {
      const v = takeValueFlag(rest, flag, usage);
      if (v !== undefined) {
        if (!v.trim()) throw new Error(usage);
        out[key] = v.trim();
      }
    }
    if (rest.length) throw new Error(usage);
    return out;
  }
  if (sub === 'teams') {
    if (rest.length) throw new Error('usage: agent board teams [--json]');
    return {};
  }
  if (sub === 'clear') {
    // Only the team's root tab clears its own board (run it there; no --team).
    if (rest.length) throw new Error('usage: agent board clear   (inside the team\'s root tab)');
    return {};
  }
  throw new Error('usage: agent board post|read|teams|clear (agent --help)');
}

// ── Team tasks (agent task) ──────────────────────────────────────────────
export const TASK_SUBS = ['add', 'list', 'show', 'claim', 'block', 'unblock', 'release', 'done', 'submit', 'approve', 'reject', 'fail', 'retry', 'reopen', 'cancel', 'edit', 'dep'];
export const TASK_EXIT_NOTHING_TO_CLAIM = 4;
const TASK_USAGE = {
  add: 'usage: agent task add [--body <text>|-] [--parent <#>] [--after <#,#>] [--priority 0-3] [--review] [--label <x>]… [--max-attempts <n>] [--] <title…>',
  list: 'usage: agent task list [--state <s,…>] [--mine] [--ready] [--tree] [--search <text>] [--all] [--limit N] [--team <rootTabId>]',
  show: 'usage: agent task show <#> [--history] [--team <rootTabId>]',
  claim: 'usage: agent task claim <#> | --next',
  block: 'usage: agent task block <#> --reason <text>',
  reject: 'usage: agent task reject <#> --reason <text>',
  fail: 'usage: agent task fail <#> --error <text>',
  done: 'usage: agent task done <#> --summary <one line> [--body <text>|-] [--branch b] [--commit sha] [--worktree p] [--checks passed|failed|none] [--artifact key=value]…',
  submit: 'usage: agent task submit <#> --summary <one line> [--body <text>|-] [--branch b] [--commit sha] [--worktree p] [--checks passed|failed|none] [--artifact key=value]…',
  edit: 'usage: agent task edit <#> [--title <t>] [--body <text>|-] [--priority 0-3] [--label <x>]… [--review|--no-review]',
  dep: 'usage: agent task dep add|rm <#task> <#depends-on>',
};
const taskUsage = (sub) => TASK_USAGE[sub] || (['unblock', 'release', 'retry'].includes(sub)
  ? `usage: agent task ${sub} <#>`
  : ['approve', 'reopen', 'cancel'].includes(sub)
    ? `usage: agent task ${sub} <#> [--reason <text>]`
    : `usage: agent task ${TASK_SUBS.join('|')} (agent --help)`);

/** `12` or `#12` → 12; anything else throws `usage`. */
export function taskNumber(raw, usage) {
  const t = String(raw ?? '').trim().replace(/^#/, '');
  if (!/^\d+$/.test(t) || Number(t) < 1 || !Number.isSafeInteger(Number(t))) throw new Error(`invalid task number: ${raw ?? '(none)'} (${usage})`);
  return Number(t);
}

function takeAllValues(list, name, usage) {
  const out = [];
  for (let v = takeValueFlag(list, name, usage); v !== undefined; v = takeValueFlag(list, name, usage)) out.push(v);
  return out;
}

function takeBool(list, name) {
  let found = false;
  for (let i = list.indexOf(name); i >= 0; i = list.indexOf(name)) { list.splice(i, 1); found = true; }
  return found;
}

/**
 * `agent task <sub> …` → the agent.task.<sub> request fields (without caller). Options are read
 * only before `--`; words after it are positional (the title of `add`). `--body -` (and
 * done/submit `--body -`) means "read stdin" and is resolved by the command, not here.
 */
export function parseTaskArgs(sub, list) {
  if (!TASK_SUBS.includes(sub)) throw new Error(taskUsage(''));
  const usage = taskUsage(sub);
  const rest = [...list];
  const end = rest.indexOf('--');
  const verbatim = end >= 0 ? rest.splice(end).slice(1) : [];
  const out = {};
  const value = (flag) => takeValueFlag(rest, flag, usage);
  const finish = () => {
    const unknown = rest.find((a) => String(a).startsWith('--'));
    if (unknown) throw new Error(`unknown option for agent task ${sub}: ${unknown} (${usage})`);
    return [...rest, ...verbatim];
  };
  const oneNumber = (words) => {
    if (words.length !== 1) throw new Error(usage);
    return taskNumber(words[0], usage);
  };
  const required = (flag, key) => {
    const v = value(flag);
    if (v === undefined || !v.trim()) throw new Error(usage);
    out[key] = v;
  };
  switch (sub) {
    case 'add': {
      const body = value('--body');
      if (body !== undefined) out.body = body;
      const parent = value('--parent');
      if (parent !== undefined) out.parent = taskNumber(parent, usage);
      const after = takeAllValues(rest, '--after', usage).flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
      if (after.length) out.after = after.map((a) => taskNumber(a, usage));
      const priority = value('--priority');
      if (priority !== undefined) {
        if (!/^[0-3]$/.test(priority.trim())) throw new Error(`priority must be 0-3 (${usage})`);
        out.priority = Number(priority);
      }
      if (takeBool(rest, '--review')) out.review = true;
      const labels = takeAllValues(rest, '--label', usage);
      if (labels.length) out.labels = labels;
      const max = value('--max-attempts');
      if (max !== undefined) out.maxAttempts = positiveInt(max, usage);
      const title = finish().join(' ');
      if (!title.trim()) throw new Error(usage);
      out.title = title;
      return out;
    }
    case 'list': {
      const states = takeAllValues(rest, '--state', usage).flatMap((x) => x.split(',')).map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (states.length) out.states = states;
      for (const flag of ['--mine', '--ready', '--tree', '--all']) if (takeBool(rest, flag)) out[flag.slice(2)] = true;
      const search = value('--search');
      if (search !== undefined) out.search = search;
      const team = value('--team');
      if (team !== undefined) out.team = team.trim();
      const limit = value('--limit');
      if (limit !== undefined) out.limit = positiveInt(limit, usage);
      if (finish().length) throw new Error(usage);
      return out;
    }
    case 'show': {
      if (takeBool(rest, '--history')) out.history = true;
      const team = value('--team');
      if (team !== undefined) out.team = team.trim();
      out.task = oneNumber(finish());
      return out;
    }
    case 'claim': {
      const next = takeBool(rest, '--next');
      const words = finish();
      if (next) {
        if (words.length) throw new Error(usage);
        out.next = true;
      } else {
        out.task = oneNumber(words);
      }
      return out;
    }
    case 'block':
    case 'reject':
      required('--reason', 'reason');
      out.task = oneNumber(finish());
      return out;
    case 'fail':
      required('--error', 'error');
      out.task = oneNumber(finish());
      return out;
    case 'approve':
    case 'reopen':
    case 'cancel': {
      const reason = value('--reason');
      if (reason !== undefined) out.reason = reason;
      out.task = oneNumber(finish());
      return out;
    }
    case 'unblock':
    case 'release':
    case 'retry':
      out.task = oneNumber(finish());
      return out;
    case 'done':
    case 'submit': {
      required('--summary', 'summary');
      const body = value('--body');
      if (body !== undefined) out.resultBody = body;
      for (const flag of ['--branch', '--commit', '--worktree']) {
        const v = value(flag);
        if (v !== undefined) out[flag.slice(2)] = v;
      }
      const checks = value('--checks');
      if (checks !== undefined) {
        if (!['passed', 'failed', 'none'].includes(checks.trim().toLowerCase())) throw new Error(`invalid --checks: ${checks} (passed|failed|none)`);
        out.checks = checks.trim().toLowerCase();
      }
      const artifacts = takeAllValues(rest, '--artifact', usage);
      if (artifacts.length) {
        out.artifacts = {};
        for (const a of artifacts) {
          const i = a.indexOf('=');
          if (i < 1 || i === a.length - 1) throw new Error(`invalid --artifact ${a} (expected key=value)`);
          const key = a.slice(0, i).trim();
          if (Object.prototype.hasOwnProperty.call(out.artifacts, key)) throw new Error(`--artifact ${key} given twice (one value per key)`);
          out.artifacts[key] = a.slice(i + 1).trim();
        }
      }
      out.task = oneNumber(finish());
      return out;
    }
    case 'edit': {
      const title = value('--title');
      if (title !== undefined) out.title = title;
      const body = value('--body');
      if (body !== undefined) out.body = body;
      const priority = value('--priority');
      if (priority !== undefined) {
        if (!/^[0-3]$/.test(priority.trim())) throw new Error(`priority must be 0-3 (${usage})`);
        out.priority = Number(priority);
      }
      const labels = takeAllValues(rest, '--label', usage);
      if (labels.length) out.labels = labels;
      if (takeBool(rest, '--review')) out.review = true;
      if (takeBool(rest, '--no-review')) {
        if (out.review) throw new Error(usage);
        out.review = false;
      }
      out.task = oneNumber(finish());
      if (Object.keys(out).length === 1) throw new Error(`nothing to edit (${usage})`);
      return out;
    }
    case 'dep': {
      const words = finish();
      const [action, task, onTask, ...extra] = words;
      if ((action !== 'add' && action !== 'rm') || extra.length || task === undefined || onTask === undefined) throw new Error(usage);
      return { action, task: taskNumber(task, usage), on: taskNumber(onTask, usage) };
    }
    default:
      throw new Error(usage);
  }
}

/** Exit code of an `agent task` reply: 1 error, 4 claim found nothing ready, else 0. */
export function taskExitCode(sub, parsed) {
  if (!parsed || parsed.ok === false) return 1;
  if (sub === 'claim' && parsed.task === null) return TASK_EXIT_NOTHING_TO_CLAIM;
  return 0;
}

function boardTime(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const n = new Date(now);
  const day = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return day ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Table rows for `agent board teams` (`*` marks this tab's team). */
export function boardTeamRows(teams, now = Date.now()) {
  return (teams || []).map((t) => ({
    team: `${t.team}${t.mine ? ' *' : ''}`,
    name: t.teamName || '-',
    posts: t.posts ?? 0,
    members: t.members ?? 0,
    last: boardTime(t.lastTs, now),
    root: t.open ? 'open' : 'closed',
  }));
}

function printAgents(agents, withLines) {
  if (flags.json) { console.log(JSON.stringify(agents, null, 2)); return; }
  if (!agents.length) { console.log('(no child agents)'); return; }
  table(agents.map(agentRow), agentTableColumns(agents));
  for (const a of agents) {
    if (a.error) console.log(`\n✗ ${a.terminalId}: ${a.error}`);
    if (withLines && a.worktree) console.log(`\n⎇ ${a.terminalId}: branch ${a.branch || '?'} in ${a.worktree}`);
    if (a.state === 'blocked' && a.msg) console.log(`\n? ${a.terminalId} asks: ${a.msg}`);
    if (withLines && Array.isArray(a.lastLines) && a.lastLines.length) {
      console.log(`\n── ${a.terminalId}${a.name ? ` ${a.name}` : ''} (last ${a.lastLines.length} lines)`);
      console.log(a.lastLines.join('\n'));
    }
  }
}

async function agentCommand(list) {
  const sub = list.shift();
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { console.log(AGENT_HELP); return; }
  // { caller, callerToken } (the app verifies the token) or {} outside a tab. Words after
  // `--` are text, never --caller / --caller-token.
  const endOfOptions = list.indexOf('--');
  const verbatim = endOfOptions >= 0 ? list.splice(endOfOptions) : [];
  const who = agentCallerFields(list);
  list.push(...verbatim);
  const caller = who.caller;
  // `--timeout` means seconds of waiting here; each request keeps the 20 s default.
  const waitSeconds = flags.timeoutSet ? flags.timeoutRaw : AGENT_DEFAULT_WAIT_S;
  flags.timeout = 20000;
  const statusOf = async (payload) => {
    const { parsed } = await dispatch({ cmd: 'agent.status', ...payload });
    if (parsed.ok === false) throw new Error(parsed.error || 'agent.status failed');
    return parsed.agents || [];
  };
  const waitsOut = unreachableWaitPolicy(flags.port);
  const warnUnreachable = () => { console.error('… app not reachable, waiting… (terminals keep running; Ctrl-C stops waiting)'); };
  const finish = (result, withLines) => {
    printAgents(result.agents, withLines);
    if (result.timedOut && !flags.json) console.error(`✗ timed out after ${waitSeconds}s`);
    process.exitCode = agentExitCode(result);
  };

  if (sub === 'run') {
    const bg = pickBoolFrom(list, '--bg');
    const workDir = pickFlagFrom(list, '--workdir');
    const name = pickFlagFrom(list, '--name');
    const worktree = takeWorktreeFlag(list);
    const cliType = list.shift();
    const prompt = list.join(' ');
    if (!cliType || !prompt.trim()) throw new Error('usage: agent run <cliType> <prompt…> [--bg] [--workdir <dir>] [--name <n>] [--worktree [name]] [--timeout <s>]');
    const payload = { cmd: 'agent.run', cliType, prompt, ...who, workDir, name };
    if (worktree !== undefined) payload.worktree = worktree;
    let { parsed } = await dispatch(payload);
    parsed = await awaitAgentRunJob({
      first: parsed,
      fetchResult: async (jobId) => (await dispatch({ cmd: 'agent.run.result', jobId })).parsed,
    });
    // Refused (relay limits) or failed: print the error and exit 1, also with --json.
    if (parsed.ok === false) { out(parsed); process.exitCode = 1; return; }
    if (parsed.warning && !flags.json) console.error(`⚠ ${parsed.warning}`);
    if (bg) {
      if (flags.json) return out(parsed);
      if (parsed.branch) console.error(`⎇ ${parsed.branch} in ${parsed.worktree}`);
      return console.log(parsed.terminalId);
    }
    if (!flags.json) console.error(`… started ${parsed.terminalId} (${cliType})${parsed.branch ? ` on ${parsed.branch} in ${parsed.worktree}` : ''}; waiting up to ${waitSeconds}s (Ctrl-C stops waiting, the agent keeps running)`);
    const result = await waitForAgents({
      fetchAgents: () => statusOf({ terminalId: parsed.terminalId }),
      mode: 'all',
      timeoutMs: waitSeconds * 1000,
      isUnreachable: waitsOut,
      onUnreachable: warnUnreachable,
    });
    return finish(result, true);
  }

  if (sub === 'send') {
    const terminalId = list.shift();
    const text = list.join(' ');
    if (!terminalId || !text.trim()) throw new Error('usage: agent send <terminalId> <text…> [--force]');
    // The input gate may wait up to 20 s for the user to stop typing (same as term write).
    flags.timeout = 40000;
    const payload = { cmd: 'agent.send', terminalId, text, ...who };
    if (flags.force) payload.force = true;
    return out((await dispatch(payload)).parsed);
  }

  if (sub === 'wait') {
    const id = pickFlagFrom(list, '--id');
    const mode = pickFlagFrom(list, '--children') || 'all';
    if (mode !== 'any' && mode !== 'all') throw new Error('usage: agent wait [--id <terminalId> | --children any|all] [--timeout <s>]');
    if (!id) {
      // App closed: skip the empty check and wait for it (links are restored on restart).
      const first = await statusOf(who).catch((e) => { if (waitsOut(e)) return null; throw e; });
      if (first && !first.length) throw new Error(caller ? `no child agents for ${caller}` : 'no child agents (run inside a BBARIT tab)');
    }
    const result = await waitForAgents({
      fetchAgents: () => statusOf(id ? { terminalId: id } : who),
      mode: id ? 'all' : mode,
      timeoutMs: waitSeconds * 1000,
      isUnreachable: waitsOut,
      onUnreachable: warnUnreachable,
    });
    return finish(result, false);
  }

  if (sub === 'status') {
    const terminalId = list.shift();
    return printAgents(await statusOf(terminalId ? { terminalId } : who), true);
  }

  if (sub === 'list') {
    const { parsed } = await dispatch({ cmd: 'agent.list', ...who });
    if (parsed.ok === false) return out(parsed);
    return printAgents(parsed.agents || [], false);
  }

  if (sub === 'stop') {
    const opts = parseStopArgs(list);
    if (!opts.terminalId && !caller) throw new Error('agent stop without a terminalId stops this tab\'s children: run it inside that BBARIT tab');
    const payload = { cmd: 'agent.stop', ...who };
    if (opts.terminalId) payload.terminalId = opts.terminalId;
    if (opts.close) payload.close = true;
    const { parsed } = await dispatch(payload);
    process.exitCode = stopExitCode(parsed);
    if (flags.json || parsed.ok === false) return out(parsed);
    const rows = parsed.stopped || [];
    if (!rows.length) return console.log('(no running child agents to stop)');
    return table(rows.map((r) => ({ ...r, ok: r.ok ? 'yes' : `no (${r.reason || 'refused'})`, closed: r.closed ? 'yes' : '-' })), ['terminalId', 'name', 'keys', 'ok', 'closed']);
  }

  if (sub === 'log') {
    const { tail } = parseLogArgs(list);
    let lines;
    try {
      const { parsed } = await dispatch({ cmd: 'agent.log', tail });
      if (parsed.ok === false) {
        // An app without agent.log: the file is still readable directly.
        if (!/unknown|unsupported/i.test(String(parsed.error || ''))) return out(parsed);
        lines = readRelayLogFile(tail);
      } else {
        lines = Array.isArray(parsed.lines) ? parsed.lines : [];
      }
    } catch (e) {
      if (!isAppUnreachable(e)) throw e;
      if (!flags.json) console.error(`… app not reachable; reading ${relayLogPath()} directly`);
      lines = readRelayLogFile(tail);
    }
    if (flags.json) { for (const l of lines) console.log(l); return; }
    if (!lines.length) return console.log('(agent relay log is empty)');
    for (const l of lines) console.log(formatRelayLogLine(l));
    return;
  }

  if (sub === 'board') {
    const boardSub = list.shift();
    const fields = parseBoardArgs(boardSub, list);
    const { parsed } = await dispatch({ cmd: `agent.board.${boardSub}`, ...fields, ...who });
    if (parsed.ok === false) {
      if (/unknown|unsupported/i.test(String(parsed.error || ''))) parsed.error = `${parsed.error} (this app version has no team board; update the app)`;
      out(parsed);
      process.exitCode = 1;
      return;
    }
    if (flags.json) {
      const { text, ...rest } = parsed;
      return out(rest);
    }
    if (boardSub === 'post') return console.log(`posted #${parsed.seq} to team ${parsed.team}`);
    if (boardSub === 'read') return console.log(parsed.text);
    if (boardSub === 'clear') return console.log(`cleared team ${parsed.team} (${parsed.removed} posts removed)`);
    const teams = parsed.teams || [];
    if (!teams.length) return console.log('(no team boards)');
    return table(boardTeamRows(teams), ['team', 'name', 'posts', 'members', 'last', 'root']);
  }

  if (sub === 'task') {
    const taskSub = list.shift();
    const fields = parseTaskArgs(taskSub, list);
    // `--body -`: the text comes from stdin (e.g. a heredoc or a file piped in).
    for (const key of ['body', 'resultBody']) {
      if (fields[key] === '-') fields[key] = fs.readFileSync(0, 'utf8');
    }
    const { parsed } = await dispatch({ cmd: `agent.task.${taskSub}`, ...fields, ...who });
    process.exitCode = taskExitCode(taskSub, parsed);
    if (parsed.ok === false) {
      if (/unknown|unsupported/i.test(String(parsed.error || '')) && !/task #|unknown task operation/.test(String(parsed.error || ''))) {
        parsed.error = `${parsed.error} (this app version has no team tasks; update the app)`;
      }
      out(parsed);
      process.exitCode = 1;
      return;
    }
    if (flags.json) {
      const { text, ...rest } = parsed;
      return out(rest);
    }
    return console.log(parsed.text);
  }

  throw new Error(`unknown agent subcommand: ${sub} (run|send|wait|status|list|stop|log|board|task, agent --help)`);
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
      if (sub === 'write' || sub === 'write-raw') {
        // The app's input gate waits up to 20 s for the user to stop typing, then sends Enter
        // after the paste settles; the bridge itself allows 30 s. Wait past both by default.
        if (!flags.timeoutSet) flags.timeout = 40000;
        const payload = { cmd: 'terminal.write', terminalId: id, text: args.join(' ') };
        if (sub === 'write-raw') payload.submit = false;
        if (flags.force) payload.force = true;
        return out((await dispatch(payload)).parsed);
      }
      if (sub === 'read') {
        const { parsed } = await dispatch({ cmd: 'terminal.read', terminalId: id, lines: Number(args[0]) || 80 });
        if (flags.json || parsed.ok === false) return out(parsed);
        return console.log(parsed.text);
      }
      if (sub === 'use') return out((await dispatch({ cmd: 'terminal.activate', terminalId: args[0] })).parsed);
      if (sub === 'close') return out((await dispatch({ cmd: 'terminal.close', terminalId: args[0] })).parsed);
      throw new Error('usage: term list|create|write|write-raw|read|use|close');
    }

    case 'agent': return agentCommand(args);

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

// Run only as a script — tests import the exported helpers without connecting.
const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) main().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
