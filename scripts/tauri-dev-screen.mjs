#!/usr/bin/env node
/**
 * Direct CLI control for the live Tauri development screen.
 *
 * This intentionally does not start or call an MCP server. It talks directly to
 * tauri-plugin-mcp-bridge's debug WebSocket endpoint (dev 9323-9422, installed
 * 9223-9322) and exposes practical terminal commands for code agents: status,
 * screenshot, snapshot, js, click, type, key, resize, and check.
 */

import { existsSync, mkdirSync, writeFileSync, openSync, closeSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
// 설치본 번들에는 node_modules 가 없어 npm 패키지 'ws' 를 import 하면 즉사한다
// (ERR_MODULE_NOT_FOUND → 릴리즈에서 브라우저 CLI 전 명령 실패). 이 파일은
// WHATWG 스타일(addEventListener/event.data)만 쓰므로 Node 22+ 내장 WebSocket 이
// drop-in 이고, 구버전 Node 에서만 'ws' 로 fallback 한다.
const WebSocket = globalThis.WebSocket ?? (await import('ws')).WebSocket;

const root = process.cwd();
const argv = process.argv.slice(2);
const knownCommands = new Set(['check', 'status', 'screenshot', 'snapshot', 'js', 'click', 'type', 'key', 'resize']);
const commandIndex = argv.findIndex((arg) => knownCommands.has(arg));
const command = commandIndex >= 0 ? argv[commandIndex] : 'check';
const args = commandIndex >= 0 ? argv.filter((_, idx) => idx !== commandIndex) : argv;

function readArg(name, fallback) {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

const shouldStart = hasFlag('--start');
const host = process.env.TAURI_DEV_HOST || process.env.TAURI_MCP_HOST || readArg('--host', '127.0.0.1');
const requestedPort = Number(process.env.TAURI_DEV_PORT || process.env.TAURI_MCP_PORT || readArg('--port', '0'));
// 개발 빌드의 mcp-bridge base_port (main.rs 의 debug_assertions 분기와 일치해야 함).
// 설치본(release)은 9223 을 쓰므로, dev:screen 은 9323 부터 스캔해 설치본과 분리한다.
const DEV_BASE_PORT = Number(process.env.TAURI_DEV_BASE_PORT || readArg('--base-port', '9323'));
// 스캔 후보는 반드시 BBARIT 앱이어야 한다. 같은 포트 대역에 다른 프로젝트의
// tauri dev 앱이 mcp-bridge 를 열고 있으면 isDebug 점수(100)만으로는 남의 앱이
// 설치본(release, 0점)을 제친다 — 실측: 스마트쿠팡 dev(9250)가 설치본(9223)을
// 가로채 브라우저 CLI 가 무한 auto-opening 루프에 빠짐(2026-07-15).
// The fork build (tauri.opensource.conf.json) is the default; the original
// author-signed app is still accepted. BBARIT_BRIDGE_APP_ID restricts to one.
const DEFAULT_APP_IDS = ['com.bbarit.terminal.source', 'com.octo.terminal'];
const EXPECTED_APP_IDS = process.env.BBARIT_BRIDGE_APP_ID ? [process.env.BBARIT_BRIDGE_APP_ID] : DEFAULT_APP_IDS;
const outputDir = resolve(readArg('--out', process.env.TAURI_DEV_SCREEN_DIR || '.octo-tmp/tauri-dev-screen'));
const timeoutMs = Number(readArg('--timeout-ms', '120000'));
const windowLabel = readArg('--window', 'main');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tauriCliJsCandidates = [
  resolve(root, 'node_modules/@tauri-apps/cli/tauri.js'),
  resolve(root, 'node_modules/.pnpm/@tauri-apps+cli@2.11.1/node_modules/@tauri-apps/cli/tauri.js'),
];
const tauriCliJs = tauriCliJsCandidates.find((candidate) => existsSync(candidate));

mkdirSync(outputDir, { recursive: true });

function usage() {
  return `Usage:
  npm run dev:screen              # check: status + screenshot + DOM snapshot
  npm run dev:screen:start        # start Tauri dev, then check
  npm run dev:screen -- status
  npm run dev:screen -- screenshot --file .octo-tmp/tauri-dev-screen/screen.png
  npm run dev:screen -- snapshot --file .octo-tmp/tauri-dev-screen/dom.txt
  npm run dev:screen -- js --code "document.title"
  npm run dev:screen -- click --selector "button[title='설정']"
  npm run dev:screen -- type --selector "input" --text "hello"
  npm run dev:screen -- key --key Enter
  npm run dev:screen -- resize --width 1440 --height 980

Options:
  --start              Start Tauri dev in the background first
  --port 9323          Target a specific bridge port (설치본 강제 제어 시 9223)
  --base-port 9323     개발 앱 mcp-bridge base_port (설치본 9223 과 분리)
  --host 127.0.0.1     Target host
  --window main        Tauri window label
  --out <dir>          Artifact directory
  --timeout-ms 120000  Wait timeout for bridge startup`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function canConnect(port, targetHost = host, waitMs = 450) {
  return new Promise((resolveConnect) => {
    const socket = net.createConnection({ host: targetHost, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveConnect(ok);
    };
    socket.setTimeout(waitMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function canConnectWebSocket(port, targetHost = host, waitMs = 800) {
  return new Promise((resolveConnect) => {
    let settled = false;
    const ws = new WebSocket(`ws://${targetHost}:${port}`);
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolveConnect(ok);
    };
    const timer = setTimeout(() => done(false), waitMs);
    ws.addEventListener('open', () => done(true), { once: true });
    ws.addEventListener('error', () => done(false), { once: true });
  });
}

async function findBridgePort() {
  if (requestedPort > 0) {
    return (await canConnect(requestedPort, host, 200)) && (await canConnectWebSocket(requestedPort))
      ? requestedPort
      : null;
  }
  const ports = Array.from({ length: 100 }, (_, index) => DEV_BASE_PORT + index);
  const openPorts = (await Promise.all(
    ports.map(async (port) => ((await canConnect(port, host, 120)) ? port : null)),
  )).filter(Boolean);
  const candidates = [];
  for (const port of openPorts) {
    const probe = await probeBridgePort(port);
    if (!probe) continue;
    // BBARIT 가 아닌 앱(identifier 불일치·확인 불가)은 제외 — 후보가 없으면
    // 호출측 재시도 루프가 다시 스캔하므로 시작 중 일시 실패는 자연 회복된다.
    if (!EXPECTED_APP_IDS.includes(probe.identifier)) continue;
    // 설치본(release, isDebug=false)에는 기본적으로 붙지 않는다 — dev:screen 은 개발 앱만 제어한다.
    // 단, 내장 에이전트가 *자기* 설치본 앱을 제어할 때는 BBARIT_BRIDGE_ALLOW_RELEASE=1 로 허용한다
    // (앱이 에이전트 실행 시 TAURI_DEV_BASE_PORT=9223 과 함께 넘긴다). 명시 제어는 --port 로도 가능.
    if (!probe.isDebug && process.env.BBARIT_BRIDGE_ALLOW_RELEASE !== '1') continue;
    candidates.push(probe);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.port - b.port);
  return candidates[0].port;
}

async function probeBridgePort(port) {
  if (!(await canConnectWebSocket(port))) return null;
  let ws;
  try {
    ws = await connectWs(port);
    const [backend, windows] = await Promise.all([
      sendWsCommand(ws, 'invoke_tauri', {
        command: 'plugin:mcp-bridge|get_backend_state',
        args: { windowLabel },
      }).catch(() => null),
      sendWsCommand(ws, 'list_windows').catch(() => null),
    ]);
    const isDebug = backend?.data?.environment?.debug === true;
    const identifier = String(backend?.data?.app?.identifier || '');
    const windowUrls = Array.isArray(windows?.data)
      ? windows.data.map((windowInfo) => String(windowInfo?.url || ''))
      : [];
    const usesDevUrl = windowUrls.some((url) => /^https?:\/\/127\.0\.0\.1:5175(?:\/|$)/.test(url));
    const score = (isDebug ? 100 : 0) + (usesDevUrl ? 50 : 0);
    return { port, score, isDebug, usesDevUrl, identifier };
  } catch {
    return { port, score: 0, isDebug: false, usesDevUrl: false, identifier: '' };
  } finally {
    try { ws?.close(); } catch {}
  }
}

function startTauriDevDetached() {
  const logPath = resolve(outputDir, 'tauri-dev.log');
  writeFileSync(logPath, '', 'utf8');
  const fd = openSync(logPath, 'a');
  const command = tauriCliJs ? process.execPath : npmCmd;
  const commandArgs = tauriCliJs
    ? [tauriCliJs, 'dev']
    : ['run', 'tauri:dev'];
  const child = spawn(command, commandArgs, {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  closeSync(fd);
  return { pid: child.pid, logPath };
}

function getProcessTable() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 3000,
    killSignal: 'SIGKILL',
  });
  if (result.status !== 0 || result.signal || result.error) return [];
  return String(result.stdout || '')
    .split('\n')
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3].trim(),
      };
    })
    .filter(Boolean);
}

function isCurrentCliProcess(proc) {
  return proc.pid === process.pid || proc.pid === process.ppid;
}

function isTauriDevCliProcess(command) {
  if (!tauriCliJs) return false;
  return command.includes(tauriCliJs) && /(?:^|\s)dev(?:\s|$)/.test(command);
}

function isOctoUiDebugProcess(command) {
  const executable = command.split(/\s+/, 1)[0] || '';
  const debugTargets = [
    resolve(root, 'src-tauri/target/debug/octo-ui'),
    resolve(root, 'target/debug/octo-ui'),
  ];
  return debugTargets.includes(executable);
}

function listProcessMatches(pattern) {
  const regex = new RegExp(pattern);
  return getProcessTable()
    .filter((proc) => !isCurrentCliProcess(proc))
    .filter((proc) => regex.test(proc.command))
    .map((proc) => `${proc.pid} ${proc.command}`);
}

function cleanupStaleTauriDevProcesses() {
  const staleProcesses = getProcessTable()
    .filter((proc) => !isCurrentCliProcess(proc))
    .filter((proc) => isTauriDevCliProcess(proc.command) || isOctoUiDebugProcess(proc.command));

  for (const proc of staleProcesses) {
    try { process.kill(proc.pid, 'SIGTERM'); } catch {}
  }
  if (staleProcesses.length) {
    spawnSync('sleep', ['0.5'], { stdio: 'ignore', timeout: 1000 });
  }
  for (const proc of staleProcesses) {
    try {
      process.kill(proc.pid, 0);
      process.kill(proc.pid, 'SIGKILL');
    } catch {}
  }
}

function checkTauriStartPreflight() {
  const checks = [
    ['cargo', ['--version']],
    ['rustc', ['--version']],
  ];
  const failures = checks.map(([cmd, cmdArgs]) => {
    const startedAt = Date.now();
    const result = spawnSync(cmd, cmdArgs, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      killSignal: 'SIGKILL',
    });
    if (result.status === 0 && !result.signal && !result.error) return null;
    return {
      command: `${cmd} ${cmdArgs.join(' ')}`,
      ms: Date.now() - startedAt,
      status: result.status,
      signal: result.signal,
      error: result.error?.message || null,
      stderr: String(result.stderr || '').trim().slice(0, 300),
    };
  }).filter(Boolean);
  if (!failures.length) return;
  throw new Error(`Cannot start Tauri dev because the Rust toolchain is not responding: ${JSON.stringify(failures, null, 2)}`);
}

async function waitForBridge() {
  if (shouldStart) checkTauriStartPreflight();
  if (shouldStart) cleanupStaleTauriDevProcesses();
  const started = shouldStart ? startTauriDevDetached() : null;
  const deadline = Date.now() + timeoutMs;
  let port = await findBridgePort();
  while (!port && Date.now() < deadline) {
    await sleep(1000);
    port = await findBridgePort();
  }
  if (!port) {
    const hint = shouldStart
      ? `Started Tauri dev but no Tauri CLI bridge appeared within ${timeoutMs}ms.`
      : 'Run npm run tauri:dev first, or rerun with npm run dev:screen:start.';
    let logTail = '';
    if (started?.logPath) {
      try {
        logTail = readFileSync(started.logPath, 'utf8').split('\n').slice(-40).join('\n').trim();
      } catch {}
    }
    if (started?.pid) {
      try {
        process.kill(-started.pid, 'SIGTERM');
      } catch {}
    }
    throw new Error(`${hint} Expected a DEBUG tauri-plugin-mcp-bridge WebSocket on ${host}:${DEV_BASE_PORT}-${DEV_BASE_PORT + 99} (개발 앱 전용; 설치본 9223 은 무시함).${logTail ? `\n\nRecent tauri-dev.log:\n${logTail}` : ''}`);
  }
  return { port, started };
}

function connectWs(port) {
  return new Promise((resolveConnect, rejectConnect) => {
    const ws = new WebSocket(`ws://${host}:${port}`);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      rejectConnect(new Error(`Timed out connecting to ws://${host}:${port}`));
    }, 5000);
    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      resolveConnect(ws);
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      rejectConnect(new Error(`Failed to connect to ws://${host}:${port}`));
    }, { once: true });
  });
}

function sendWsCommand(ws, cmd, payload = {}) {
  const id = `cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolveCommand, rejectCommand) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      rejectCommand(new Error(`Timed out waiting for ${cmd}`));
    }, Math.max(15000, timeoutMs));
    const onMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      if (msg.success === false) rejectCommand(new Error(msg.error || `${cmd} failed`));
      else resolveCommand(msg);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, command: cmd, args: payload }));
  });
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

function writeDataUrl(path, dataUrl) {
  const raw = String(dataUrl).includes(',') ? String(dataUrl).split(',', 2)[1] : String(dataUrl);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(raw, 'base64'));
}

async function getHttpStatus(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 200) };
  } catch (error) {
    return { ok: false, status: 0, body: String(error) };
  }
}

const domSnapshotScript = String.raw`
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK']);
const isVisible = (el) => {
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
};
const labelOf = (el) => {
  const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '';
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  return (aria || text).slice(0, 140);
};
const roleOf = (el) => el.getAttribute('role') || el.tagName.toLowerCase();
const nodes = [];
const walk = (el, depth = 0) => {
  if (!el || SKIP.has(el.tagName) || nodes.length > 800) return;
  if (el !== document.body && !isVisible(el)) return;
  const interesting = el === document.body
    || el.matches('button,a,input,textarea,select,[role],[tabindex],summary')
    || labelOf(el);
  if (interesting) {
    const rect = el.getBoundingClientRect();
    nodes.push({
      depth,
      role: roleOf(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      class: String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 4).join('.'),
      label: labelOf(el),
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
      selected: el.getAttribute('aria-selected') || undefined,
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]
    });
  }
  for (const child of el.children) walk(child, Math.min(depth + 1, 12));
};
walk(document.body, 0);
return {
  title: document.title,
  url: location.href,
  viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
  nodeCount: nodes.length,
  nodes
};
`;

function formatSnapshot(data) {
  const lines = [
    `title: ${data?.title || ''}`,
    `url: ${data?.url || ''}`,
    `viewport: ${data?.viewport?.width || '?'}x${data?.viewport?.height || '?'} @${data?.viewport?.devicePixelRatio || '?'}`,
    `nodes: ${data?.nodeCount || 0}`,
    '',
  ];
  for (const node of data?.nodes || []) {
    const indent = '  '.repeat(Math.min(Number(node.depth || 0), 10));
    const bits = [node.role || node.tag];
    if (node.id) bits.push(`#${node.id}`);
    if (node.class) bits.push(`.${node.class}`);
    if (node.disabled) bits.push('[disabled]');
    if (node.selected) bits.push(`[selected=${node.selected}]`);
    if (node.label) bits.push(`"${node.label}"`);
    bits.push(`[${(node.rect || []).join(',')}]`);
    lines.push(`${indent}- ${bits.join(' ')}`);
  }
  return lines.join('\n');
}

async function executeJs(ws, code) {
  const result = await sendWsCommand(ws, 'execute_js', { windowLabel, script: code });
  return result.data;
}

async function waitForWindowReady(ws) {
  const deadline = Date.now() + timeoutMs;
  let lastWindows = null;
  while (Date.now() < deadline) {
    lastWindows = await sendWsCommand(ws, 'list_windows').catch(() => null);
    const windows = Array.isArray(lastWindows?.data) ? lastWindows.data : [];
    if (windows.some((windowInfo) => windowInfo?.label === windowLabel)) return;
    await sleep(500);
  }
  const labels = Array.isArray(lastWindows?.data)
    ? lastWindows.data.map((windowInfo) => windowInfo?.label).filter(Boolean).join(', ')
    : 'none';
  throw new Error(`Window '${windowLabel}' not found after ${timeoutMs}ms. Available windows: ${labels || 'none'}`);
}

function selectorLiteral(selector) {
  return JSON.stringify(selector);
}

async function run() {
  if (hasFlag('--help') || command === 'help') {
    console.log(usage());
    return;
  }

  const { port, started } = await waitForBridge();
  const ws = await connectWs(port);
  const artifacts = {};

  try {
    if (command !== 'status') {
      await waitForWindowReady(ws);
    }

    if (command === 'status' || command === 'check') {
      const [backend, windows] = await Promise.all([
        sendWsCommand(ws, 'invoke_tauri', {
          command: 'plugin:mcp-bridge|get_backend_state',
          args: { windowLabel },
        }).catch((error) => ({ success: false, error: String(error) })),
        sendWsCommand(ws, 'list_windows').catch((error) => ({ success: false, error: String(error) })),
      ]);
      const health = await getHttpStatus('http://127.0.0.1:19980/health');
      const vite = await getHttpStatus('http://127.0.0.1:5175/');
      const processes = {
        tauriDev: listProcessMatches('/tauri.js dev|node_modules/.bin/tauri dev'),
        octoUi: listProcessMatches('target/debug/octo-ui'),
      };
      const status = { ok: true, host, port, windowLabel, startedDevServer: started, health, vite, backend, windows, processes };
      artifacts.status = resolve(outputDir, 'status.json');
      writeText(artifacts.status, JSON.stringify(status, null, 2));
      console.log(JSON.stringify(status, null, 2));
      if (command === 'status') return;
    }

    if (command === 'screenshot' || command === 'check') {
      const screenshotFile = resolve(readArg('--file', resolve(outputDir, 'screenshot.png')));
      const screenshot = await sendWsCommand(ws, 'capture_native_screenshot', {
        windowLabel,
        format: 'png',
      });
      writeDataUrl(screenshotFile, screenshot.data);
      artifacts.screenshot = screenshotFile;
      console.log(`Screenshot: ${screenshotFile}`);
      if (command === 'screenshot') return;
    }

    if (command === 'snapshot' || command === 'check') {
      const snapshotFile = resolve(readArg('--file', resolve(outputDir, 'dom-snapshot.txt')));
      const snapshot = await executeJs(ws, domSnapshotScript);
      writeText(snapshotFile, formatSnapshot(snapshot));
      artifacts.snapshot = snapshotFile;
      console.log(`DOM snapshot: ${snapshotFile}`);
      if (command === 'snapshot') return;
    }

    if (command === 'js') {
      const code = readArg('--code', args.slice(args.indexOf('js') + 1).join(' '));
      if (!code) throw new Error('Missing --code');
      console.log(JSON.stringify(await executeJs(ws, code), null, 2));
      return;
    }

    if (command === 'click') {
      const selector = readArg('--selector', '');
      if (!selector) throw new Error('Missing --selector');
      const result = await executeJs(ws, `
        const el = document.querySelector(${selectorLiteral(selector)});
        if (!el) throw new Error('selector not found: ${selector.replace(/'/g, "\\'")}');
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return { clicked: true, selector: ${selectorLiteral(selector)} };
      `);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'type') {
      const selector = readArg('--selector', '');
      const text = readArg('--text', '');
      if (!selector) throw new Error('Missing --selector');
      const result = await executeJs(ws, `
        const el = document.querySelector(${selectorLiteral(selector)});
        if (!el) throw new Error('selector not found: ${selector.replace(/'/g, "\\'")}');
        el.focus();
        const value = ${JSON.stringify(text)};
        if ('value' in el) {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.textContent = value;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
        }
        return { typed: true, selector: ${selectorLiteral(selector)}, length: value.length };
      `);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'key') {
      const key = readArg('--key', 'Enter');
      const result = await executeJs(ws, `
        const target = document.activeElement || document.body;
        for (const type of ['keydown', 'keyup']) {
          target.dispatchEvent(new KeyboardEvent(type, { key: ${JSON.stringify(key)}, bubbles: true }));
        }
        return { key: ${JSON.stringify(key)}, target: target.tagName };
      `);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'resize') {
      const width = Number(readArg('--width', '1440'));
      const height = Number(readArg('--height', '980'));
      const result = await sendWsCommand(ws, 'resize_window', {
        windowId: windowLabel,
        width,
        height,
        logical: true,
      });
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }

    if (command === 'check') {
      artifacts.summary = resolve(outputDir, 'summary.json');
      writeText(artifacts.summary, JSON.stringify({
        ok: true,
        generatedAt: new Date().toISOString(),
        root,
        host,
        port,
        windowLabel,
        artifacts,
      }, null, 2));
      console.log(`Summary: ${artifacts.summary}`);
      return;
    }

    throw new Error(`Unknown command: ${command}\n${usage()}`);
  } finally {
    try { ws.close(); } catch {}
  }
}

run().catch((error) => {
  const summaryPath = resolve(outputDir, 'summary.json');
  writeText(summaryPath, JSON.stringify({
    ok: false,
    generatedAt: new Date().toISOString(),
    root,
    command,
    error: String(error?.stack || error),
  }, null, 2));
  console.error(String(error?.message || error));
  console.error(`Summary: ${summaryPath}`);
  process.exit(1);
});
