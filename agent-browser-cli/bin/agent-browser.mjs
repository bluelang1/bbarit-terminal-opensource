#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import http from 'node:http';
import net from 'node:net';

const argv = process.argv.slice(2);
const commandIndex = argv.findIndex((arg) => !arg.startsWith('-'));
const command = commandIndex >= 0 ? argv[commandIndex] : 'check';
const args = argv.filter((_, index) => index !== commandIndex);

const DEFAULT_PORTS = [5173, 5174, 5175, 3000, 3001, 4173, 4200, 4321, 5000, 5176, 8000, 8080, 8081, 1420, 1421];

function usage() {
  return `Usage:
  agent-browser check [url] [--headless|--headed] [--out .agent-browser]
  agent-browser open [url] [--keep-open-ms 30000]
  agent-browser screenshot [url] --file shot.png
  agent-browser text [url]
  agent-browser eval [url] --code "document.title"
  agent-browser servers
  agent-browser doctor
  agent-browser smoke

Options:
  --out <dir>              Artifact directory (default: .agent-browser)
  --file <path>            Output file for screenshot/text/html
  --timeout-ms <number>    Navigation timeout (default: 30000)
  --wait-ms <number>       Extra wait after load (default: 500)
  --viewport <WxH>         Browser viewport (default: 1440x980)
  --headless               Run without a visible window
  --headed                 Show a real browser window
  --fail-on-console        Exit non-zero if console errors are present
  --json                   Print machine-readable JSON only`;
}

function readArg(name, fallback = '') {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

function positional(index = 0) {
  return args.filter((arg) => !arg.startsWith('-'))[index] || '';
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function normalizeUrl(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';
  if (/^(https?:|file:|data:|about:)/i.test(input)) return input;
  return `http://${input}`;
}

function viewportFromArg(value) {
  const match = String(value || '').match(/^(\d+)x(\d+)$/i);
  if (!match) return { width: 1440, height: 980 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

function writeJson(path, data) {
  writeText(path, JSON.stringify(data, null, 2));
}

function print(data, jsonOnly = hasFlag('--json')) {
  if (jsonOnly || typeof data !== 'string') {
    console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

function canConnect(port, host = '127.0.0.1', timeoutMs = 350) {
  return new Promise((resolveConnect) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveConnect(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function detectDevServers() {
  const ports = String(readArg('--ports', DEFAULT_PORTS.join(',')))
    .split(',')
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port) && port > 0);
  const servers = [];
  for (const port of ports) {
    if (!(await canConnect(port))) continue;
    const url = `http://127.0.0.1:${port}`;
    let title = '';
    let status = 0;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      status = response.status;
      const html = await response.text();
      title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || '';
    } catch {
      // A listening TCP port is still useful to report.
    }
    servers.push({ url, port, status, title });
  }
  return servers;
}

async function resolveTargetUrl(explicitUrl) {
  const url = normalizeUrl(explicitUrl || positional(0));
  if (url) return url;
  const servers = await detectDevServers();
  if (servers[0]) return servers[0].url;
  throw new Error('No URL provided and no local dev server was detected. Pass a URL, for example: agent-browser check http://127.0.0.1:5175');
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    throw new Error(`Playwright is not installed. Run: npm install\n${error instanceof Error ? error.message : String(error)}`);
  }
}

function browserLaunchHint(error) {
  const text = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|browserType.launch/i.test(text)) {
    return `${text}\nRun: npx playwright install chromium`;
  }
  return text;
}

async function withPage(options, task) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    headless: options.headless,
    slowMo: options.slowMo,
  }).catch((error) => {
    throw new Error(browserLaunchHint(error));
  });
  const context = await browser.newContext({
    viewport: options.viewport,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  try {
    return await task({ browser, context, page });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function gotoAndCollect(page, url, options) {
  const consoleLogs = [];
  const pageErrors = [];
  const requestFailures = [];

  page.on('console', (message) => {
    consoleLogs.push({
      type: message.type(),
      text: message.text(),
      location: message.location(),
    });
  });
  page.on('pageerror', (error) => {
    pageErrors.push({ message: error.message, stack: error.stack || '' });
  });
  page.on('requestfailed', (request) => {
    requestFailures.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || '',
    });
  });

  const startedAt = Date.now();
  let responseStatus = null;
  let responseUrl = url;
  let navigationError = null;
  try {
    const response = await page.goto(url, {
      waitUntil: options.waitUntil,
      timeout: options.timeoutMs,
    });
    responseStatus = response?.status() ?? null;
    responseUrl = response?.url() || page.url();
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  }
  if (options.waitMs > 0) await page.waitForTimeout(options.waitMs);

  const title = await page.title().catch(() => '');
  const text = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  const html = await page.content().catch(() => '');

  return {
    started_at: new Date(startedAt).toISOString(),
    duration_ms: Date.now() - startedAt,
    url: page.url() || responseUrl,
    requested_url: url,
    title,
    response_status: responseStatus,
    navigation_error: navigationError,
    text,
    html,
    console_logs: consoleLogs,
    console_errors: consoleLogs.filter((log) => log.type === 'error'),
    page_errors: pageErrors,
    request_failures: requestFailures,
    viewport: options.viewport,
  };
}

async function commandCheck(urlOverride = '', optionsOverride = {}) {
  const outDir = resolve(readArg('--out', process.env.AGENT_BROWSER_OUT || '.agent-browser'));
  const timeoutMs = Number(readArg('--timeout-ms', '30000'));
  const waitMs = Number(readArg('--wait-ms', '500'));
  const viewport = viewportFromArg(readArg('--viewport', '1440x980'));
  const headless = hasFlag('--headed') ? false : true;
  const url = await resolveTargetUrl(urlOverride);
  const failOnConsole = hasFlag('--fail-on-console');

  mkdirSync(outDir, { recursive: true });

  const result = await withPage({
    headless,
    viewport,
    timeoutMs,
    waitMs,
    waitUntil: readArg('--wait-until', 'domcontentloaded'),
  }, async ({ page }) => {
    const data = await gotoAndCollect(page, url, { timeoutMs, waitMs, viewport, waitUntil: readArg('--wait-until', 'domcontentloaded') });
    const screenshotPath = resolve(readArg('--file', resolve(outDir, 'screenshot.png')));
    await page.screenshot({ path: screenshotPath, fullPage: hasFlag('--full-page') }).catch((error) => {
      data.screenshot_error = error instanceof Error ? error.message : String(error);
    });
    data.screenshot = screenshotPath;
    return data;
  });

  const summary = {
    ok: !result.navigation_error && (!failOnConsole || result.console_errors.length === 0) && result.page_errors.length === 0,
    url: result.url,
    requested_url: result.requested_url,
    title: result.title,
    response_status: result.response_status,
    navigation_error: result.navigation_error,
    console_error_count: result.console_errors.length,
    page_error_count: result.page_errors.length,
    request_failure_count: result.request_failures.length,
    duration_ms: result.duration_ms,
    artifacts: {
      summary: resolve(outDir, 'summary.json'),
      screenshot: result.screenshot,
      text: resolve(outDir, 'text.txt'),
      html: resolve(outDir, 'page.html'),
      console: resolve(outDir, 'console.json'),
    },
  };

  writeJson(summary.artifacts.summary, summary);
  writeText(summary.artifacts.text, result.text);
  writeText(summary.artifacts.html, result.html);
  writeJson(summary.artifacts.console, {
    console_logs: result.console_logs,
    page_errors: result.page_errors,
    request_failures: result.request_failures,
  });

  if (!optionsOverride.silent) print(summary);
  if (!summary.ok) process.exitCode = 1;
  return summary;
}

async function commandOpen() {
  const timeoutMs = Number(readArg('--timeout-ms', '30000'));
  const waitMs = Number(readArg('--wait-ms', '500'));
  const viewport = viewportFromArg(readArg('--viewport', '1440x980'));
  const keepOpenMs = Number(readArg('--keep-open-ms', '0'));
  const url = await resolveTargetUrl();

  const { chromium } = await loadPlaywright();
  const context = await chromium.launchPersistentContext(resolve(readArg('--profile', '.agent-browser-profile')), {
    headless: false,
    viewport,
    ignoreHTTPSErrors: true,
  }).catch((error) => {
    throw new Error(browserLaunchHint(error));
  });
  const page = context.pages()[0] || await context.newPage();
  const result = await gotoAndCollect(page, url, { timeoutMs, waitMs, viewport, waitUntil: readArg('--wait-until', 'domcontentloaded') });
  print({ ok: !result.navigation_error, url: result.url, title: result.title, response_status: result.response_status, profile: resolve(readArg('--profile', '.agent-browser-profile')) });

  if (keepOpenMs > 0) {
    await sleep(keepOpenMs);
    await context.close().catch(() => {});
    return;
  }

  console.error('Browser is open. Press Ctrl+C to close this CLI while leaving the browser profile reusable.');
  await new Promise(() => {});
}

async function commandScreenshot() {
  const file = resolve(readArg('--file', 'screenshot.png'));
  const summary = await commandCheck(positional(0));
  if (summary.artifacts.screenshot !== file) {
    print(`Screenshot: ${summary.artifacts.screenshot}`, false);
  }
}

async function commandText() {
  const timeoutMs = Number(readArg('--timeout-ms', '30000'));
  const waitMs = Number(readArg('--wait-ms', '500'));
  const viewport = viewportFromArg(readArg('--viewport', '1440x980'));
  const url = await resolveTargetUrl();
  const result = await withPage({ headless: !hasFlag('--headed'), viewport, timeoutMs, waitMs, waitUntil: 'domcontentloaded' }, async ({ page }) => {
    return await gotoAndCollect(page, url, { timeoutMs, waitMs, viewport, waitUntil: readArg('--wait-until', 'domcontentloaded') });
  });
  const file = readArg('--file', '');
  if (file) writeText(resolve(file), result.text);
  print(hasFlag('--json') ? { text: result.text, url: result.url, title: result.title } : result.text);
}

async function commandEval() {
  const code = readArg('--code', args.slice(args.indexOf(command) + 1).join(' '));
  if (!code) throw new Error('Missing --code');
  const timeoutMs = Number(readArg('--timeout-ms', '30000'));
  const waitMs = Number(readArg('--wait-ms', '500'));
  const viewport = viewportFromArg(readArg('--viewport', '1440x980'));
  const url = await resolveTargetUrl();
  const data = await withPage({ headless: !hasFlag('--headed'), viewport, timeoutMs, waitMs, waitUntil: 'domcontentloaded' }, async ({ page }) => {
    await gotoAndCollect(page, url, { timeoutMs, waitMs, viewport, waitUntil: readArg('--wait-until', 'domcontentloaded') });
    return await page.evaluate(code);
  });
  print(data);
}

async function commandDoctor() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true }).catch((error) => {
    throw new Error(browserLaunchHint(error));
  });
  const version = browser.version();
  await browser.close();
  print({ ok: true, node: process.version, playwright_chromium: version });
}

function startFixtureServer() {
  const html = '<!doctype html><title>Agent Browser Smoke</title><h1>agent-browser-smoke-sentinel</h1><button id="ok">OK</button>';
  const server = http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') rejectStart(new Error('Could not allocate fixture port'));
      else resolveStart({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function commandSmoke() {
  const { server, url } = await startFixtureServer();
  try {
    const outDir = readArg('--out', '.agent-browser-smoke');
    args.push('--out', outDir, '--headless');
    const summary = await commandCheck(url, { silent: true });
    const text = await import('node:fs').then((fs) => fs.readFileSync(summary.artifacts.text, 'utf8'));
    if (!text.includes('agent-browser-smoke-sentinel')) {
      throw new Error('Smoke sentinel missing from extracted text');
    }
    print({ ok: true, fixture: url, artifacts: summary.artifacts });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function main() {
  if (hasFlag('--help') || command === 'help') {
    console.log(usage());
    return;
  }

  switch (command) {
    case 'check':
      await commandCheck();
      return;
    case 'open':
      await commandOpen();
      return;
    case 'screenshot':
      await commandScreenshot();
      return;
    case 'text':
      await commandText();
      return;
    case 'eval':
      await commandEval();
      return;
    case 'servers':
      print({ servers: await detectDevServers() });
      return;
    case 'doctor':
      await commandDoctor();
      return;
    case 'smoke':
      await commandSmoke();
      return;
    default:
      if (/^(https?:|localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)/i.test(command)) {
        args.unshift(command);
        await commandCheck(command);
        return;
      }
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
