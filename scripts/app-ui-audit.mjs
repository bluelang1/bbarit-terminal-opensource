#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const args = process.argv.slice(2);
const outDir = path.resolve(readArg('--out', '.octo-tmp/ui-audit'));
const strict = hasFlag('--strict');
const requestedWindows = readArg('--windows', '').split(',').map((value) => value.trim()).filter(Boolean);
const requestedRoutes = readArg('--routes', '').split(',').map((value) => value.trim()).filter(Boolean);
const routeWindow = readArg('--route-window', 'main');
const routeSettleMs = Number(readArg('--route-settle-ms', '900'));
const screenTimeoutMs = Number(readArg('--screen-timeout-ms', '30000'));
const resizeTimeoutMs = Number(readArg('--resize-timeout-ms', String(Math.min(screenTimeoutMs, 15000))));
const captureScreenshots = hasFlag('--screenshots');
const requestedViewports = parseViewports(readArg('--viewports', ''));
const minTarget = Number(readArg('--min-target', '28'));
const runKeyboardAudit = hasFlag('--keyboard');
const keyboardSteps = Number(readArg('--keyboard-steps', '14'));

mkdirSync(outDir, { recursive: true });

function readArg(name, fallback) {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

function parseViewports(value) {
  return String(value || '').split(',').map((entry) => {
    const match = entry.trim().match(/^([a-z0-9_-]+):(\d+)x(\d+)$/i);
    if (!match) return null;
    return {
      name: match[1],
      width: Number(match[2]),
      height: Number(match[3]),
    };
  }).filter(Boolean);
}

function runScreen(commandArgs, options = {}) {
  const result = spawnSync(process.execPath, ['scripts/tauri-dev-screen.mjs', ...commandArgs], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs || screenTimeoutMs,
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`dev:screen failed: ${commandArgs.join(' ')}${detail ? `\n${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseJsonOutput(text, label) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
    }
    throw new Error(`Could not parse JSON from ${label}:\n${trimmed.slice(0, 1000)}`);
  }
}

const auditScript = String.raw`
(() => {
  if (!window.__BBARIT_UI_AUDIT_ERRORS) {
    window.__BBARIT_UI_AUDIT_ERRORS = [];
    window.addEventListener('error', (event) => {
      window.__BBARIT_UI_AUDIT_ERRORS.push({
        type: 'error',
        message: String(event.message || ''),
        source: String(event.filename || ''),
      });
    });
    window.addEventListener('unhandledrejection', (event) => {
      window.__BBARIT_UI_AUDIT_ERRORS.push({
        type: 'unhandledrejection',
        message: String(event.reason?.message || event.reason || ''),
      });
    });
  }

  const minTarget = ${JSON.stringify(minTarget)};
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0
      && rect.width > 0
      && rect.height > 0;
  };
  const labelOf = (el) => (
    el.getAttribute('aria-label')
    || el.getAttribute('title')
    || el.getAttribute('placeholder')
    || (el.innerText || el.textContent || '')
  ).replace(/\s+/g, ' ').trim();
  const selectorOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += '#' + node.id;
        parts.unshift(part);
        break;
      }
      const classes = String(node.className || '').split(/\s+/).filter(Boolean).slice(0, 3);
      if (classes.length) part += '.' + classes.join('.');
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const parseColor = (value) => {
    const text = String(value || '').trim();
    if (!text || text === 'transparent') return null;
    const match = text.match(/^rgba?\(([^)]+)\)$/i);
    if (!match) {
      const srgb = text.match(/^color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+%?))?\s*\)$/i);
      if (!srgb) return null;
      const alphaText = srgb[4] || '1';
      const alpha = alphaText.endsWith('%') ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
      return {
        r: Number(srgb[1]) * 255,
        g: Number(srgb[2]) * 255,
        b: Number(srgb[3]) * 255,
        a: Number.isFinite(alpha) ? alpha : 1,
      };
    }
    const parts = match[1].split(',').map((part) => part.trim());
    const rgb = parts.slice(0, 3).map((part) => {
      if (part.endsWith('%')) return Math.round(Number(part.slice(0, -1)) * 2.55);
      return Number(part);
    });
    if (rgb.some((value) => !Number.isFinite(value))) return null;
    const alpha = parts[3] == null ? 1 : Number(parts[3].replace('%', '')) / (parts[3].endsWith('%') ? 100 : 1);
    return { r: rgb[0], g: rgb[1], b: rgb[2], a: Number.isFinite(alpha) ? alpha : 1 };
  };
  const blend = (front, back) => {
    const alpha = front.a + back.a * (1 - front.a);
    if (alpha <= 0) return { r: 255, g: 255, b: 255, a: 1 };
    return {
      r: (front.r * front.a + back.r * back.a * (1 - front.a)) / alpha,
      g: (front.g * front.a + back.g * back.a * (1 - front.a)) / alpha,
      b: (front.b * front.a + back.b * back.a * (1 - front.a)) / alpha,
      a: alpha,
    };
  };
  const luminance = (color) => {
    const channel = (value) => {
      const next = value / 255;
      return next <= 0.03928 ? next / 12.92 : ((next + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };
  const contrastRatio = (a, b) => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  };
  const effectiveBackground = (el) => {
    const layers = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0.01) layers.push(color);
      node = node.parentElement;
    }
    return layers.reverse().reduce((back, front) => blend(front, back), { r: 255, g: 255, b: 255, a: 1 });
  };
  const isInteractive = (el) => el.matches('button,a,input,textarea,select,summary,[role="button"],[role="tab"],[role="menuitem"],[tabindex]:not([tabindex="-1"])');
  const isTextInput = (el) => el.matches('input[type="text"],input:not([type]),input[type="search"],input[type="url"],textarea');
  const isWrappedToggleInput = (el) => {
    if (!el.matches('input[type="checkbox"],input[type="radio"]')) return false;
    const label = el.closest('label');
    if (!label) return false;
    const rect = label.getBoundingClientRect();
    return rect.width >= minTarget && rect.height >= minTarget;
  };
  const isHiddenUtility = (el) => {
    const selector = selectorOf(el);
    const utilityText = (el.innerText || el.textContent || '').replace(/\s+/g, '').trim();
    return selector.includes('xterm-helper-textarea')
      || selector.includes('hidden')
      || el.getAttribute('aria-hidden') === 'true'
      || el.closest('.monaco-aria-container')
      || el.closest('.native-edit-context')
      || el.closest('.sticky-widget')
      || el.closest('.xterm-helper-textarea')
      || (!el.closest('#root') && /^[>go]+$/i.test(utilityText));
  };
  const isDenseChrome = (el) => Boolean(el.closest([
    '.project-selector-actions',
    '.terminal-filter-buttons',
    '.terminals-tabs-list',
    '.project-tabs',
    '.file-tree-header-actions',
    '.file-tree-content',
    '.file-tree-row',
    '.process-stats-bar',
  ].join(',')));
  const isInsideManagedOverflow = (el, rect) => {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const overflowX = style.overflowX;
      const overflowY = style.overflowY;
      const nodeRect = node.getBoundingClientRect();
      const managesX = (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden')
        && node.scrollWidth > node.clientWidth
        && nodeRect.left >= -2
        && nodeRect.right <= innerWidth + 2;
      const managesY = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden')
        && node.scrollHeight > node.clientHeight
        && nodeRect.top >= -2
        && nodeRect.bottom <= innerHeight + 2;
      if ((managesX && (rect.right > nodeRect.right + 2 || rect.left < nodeRect.left - 2))
        || (managesY && (rect.bottom > nodeRect.bottom + 2 || rect.top < nodeRect.top - 2))) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  };
  const interactive = [...document.querySelectorAll('button,a,input,textarea,select,summary,[role="button"],[role="tab"],[role="menuitem"],[tabindex]')]
    .filter((el) => visible(el) && !isHiddenUtility(el));
  const tooSmall = [];
  const unnamed = [];
  const lowContrast = [];
  for (const el of interactive) {
    const rect = el.getBoundingClientRect();
    const label = labelOf(el);
    const tag = el.tagName.toLowerCase();
    const critical = !isTextInput(el) && !isWrappedToggleInput(el) && !isDenseChrome(el) && !el.closest('.xterm') && !el.closest('[data-terminal-scope]');
    if (critical && (rect.width < minTarget || rect.height < minTarget)) {
      tooSmall.push({
        selector: selectorOf(el),
        label,
        tag,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
    if ((tag === 'button' || el.getAttribute('role') === 'button') && !label) {
      unnamed.push({
        selector: selectorOf(el),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
    const shouldCheckContrast = (tag === 'button' || el.getAttribute('role') === 'button' || el.matches('a,[role="tab"],[role="menuitem"]'))
      && !el.closest('.xterm')
      && !el.closest('.terminal-filter-buttons')
      && !isHiddenUtility(el);
    if (shouldCheckContrast) {
      const style = getComputedStyle(el);
      const fg = parseColor(style.color);
      const bg = effectiveBackground(el);
      if (fg && bg) {
        const contrast = contrastRatio(fg.a < 1 ? blend(fg, bg) : fg, bg);
        const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
        const minContrast = disabled ? 2.25 : 3;
        if (contrast < minContrast) {
          lowContrast.push({
            selector: selectorOf(el),
            label,
            disabled,
            contrast: Number(contrast.toFixed(2)),
            color: style.color,
            background: getComputedStyle(el).backgroundColor,
          });
        }
      }
    }
  }
  const viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
  const docOverflow = {
    x: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    y: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - innerHeight,
  };
  const overflowing = [...document.body.querySelectorAll('*')]
    .filter((el) => visible(el) && !isHiddenUtility(el))
    .filter((el) => el.closest('#root'))
    .filter((el) => !el.closest('.monaco-editor') && !el.closest('.xterm') && !el.closest('[data-terminal-scope]'))
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ rect }) => rect.right > innerWidth + 2 || rect.left < -2 || rect.bottom > innerHeight + 2 || rect.top < -2)
    .filter(({ el, rect }) => !isInsideManagedOverflow(el, rect))
    .slice(0, 30)
    .map(({ el, rect }) => ({
      selector: selectorOf(el),
      label: labelOf(el).slice(0, 80),
      rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
    }));
  const text = document.body.innerText || '';
  const mojibake = [];
  const markers = [
    { name: 'replacement-character', regex: /\uFFFD/u },
    { name: 'c1-control-byte', regex: /[\u0080-\u009F]/u },
    { name: 'question-hangul-fragment', regex: /\?[\u3130-\u318F\uAC00-\uD7A3]{2,}/u },
    { name: 'cjk-hangul-adjacent', regex: /(?:[\u4E00-\u9FFF][\u3130-\u318F\uAC00-\uD7A3]{1,5}|[\u3130-\u318F\uAC00-\uD7A3]{1,5}[\u4E00-\u9FFF])/u },
    { name: 'latin-hangul-latin-fragment', regex: /[A-Za-z][\u3130-\u318F\uAC00-\uD7A3][A-Za-z]/u },
  ];
  for (const pattern of markers) {
    const match = text.match(pattern.regex);
    if (match) mojibake.push({ pattern: pattern.name, marker: String(match[0]), index: match.index || 0, sample: text.slice(Math.max(0, (match.index || 0) - 40), (match.index || 0) + 80) });
  }
  return {
    title: document.title,
    url: location.href,
    viewport,
    counts: {
      interactive: interactive.length,
      tooSmall: tooSmall.length,
      unnamed: unnamed.length,
      lowContrast: lowContrast.length,
      overflowing: overflowing.length,
      mojibake: mojibake.length,
      consoleErrors: window.__BBARIT_UI_AUDIT_ERRORS.length,
    },
    tooSmall: tooSmall.slice(0, 50),
    unnamed: unnamed.slice(0, 50),
    lowContrast: lowContrast.slice(0, 50),
    overflow: { document: docOverflow, elements: overflowing },
    mojibake: mojibake.slice(0, 10),
    consoleErrors: window.__BBARIT_UI_AUDIT_ERRORS.slice(-20),
    bodyText: text.slice(0, 2000),
  };
})()
`;

const keyboardAuditScript = String.raw`
(() => {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0
      && rect.width > 0
      && rect.height > 0;
  };
  const labelOf = (el) => (
    el.getAttribute('aria-label')
    || el.getAttribute('title')
    || el.getAttribute('placeholder')
    || (el.innerText || el.textContent || '')
  ).replace(/\s+/g, ' ').trim();
  const selectorOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += '#' + node.id;
        parts.unshift(part);
        break;
      }
      const classes = String(node.className || '').split(/\s+/).filter(Boolean).slice(0, 3);
      if (classes.length) part += '.' + classes.join('.');
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const isDisabled = (el) => Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
  const isHiddenUtility = (el) => {
    const selector = selectorOf(el);
    return selector.includes('xterm-helper-textarea')
      || selector.includes('hidden')
      || el.getAttribute('aria-hidden') === 'true'
      || el.closest('.monaco-aria-container')
      || el.closest('.native-edit-context')
      || el.closest('.sticky-widget')
      || el.closest('.xterm-helper-textarea');
  };
  const focusables = [...document.querySelectorAll([
    'button',
    'a[href]',
    'input',
    'textarea',
    'select',
    'summary',
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))]
    .filter((el) => visible(el) && !isDisabled(el) && !isHiddenUtility(el))
    .filter((el) => el.closest('#root') || document.body.contains(el));
  const maxSteps = Math.min(${JSON.stringify(keyboardSteps)}, focusables.length);
  const visited = [];
  const failedFocus = [];
  const unnamedFocused = [];
  const hiddenFocused = [];
  for (const el of focusables.slice(0, maxSteps)) {
    const before = document.activeElement;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus({ preventScroll: true });
    } catch (error) {
      failedFocus.push({ selector: selectorOf(el), reason: String(error?.message || error) });
      continue;
    }
    const active = document.activeElement;
    const activeSelector = active && active !== document ? selectorOf(active) : '';
    const targetSelector = selectorOf(el);
    const label = labelOf(active || el);
    const activeVisible = active && active.nodeType === 1 ? visible(active) : false;
    const focusMoved = active === el || el.contains(active);
    const style = active && active.nodeType === 1 ? getComputedStyle(active) : null;
    const focusStyle = style ? {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    } : null;
    visited.push({
      selector: targetSelector,
      activeSelector,
      label,
      focusMoved,
      visible: activeVisible,
      focusStyle,
    });
    if (!focusMoved) failedFocus.push({ selector: targetSelector, activeSelector, label, reason: 'focus-did-not-move' });
    if (!activeVisible) hiddenFocused.push({ selector: activeSelector || targetSelector, label });
    if ((active?.matches?.('button,[role="button"],a,[role="tab"],[role="menuitem"]')) && !label) {
      unnamedFocused.push({ selector: activeSelector || targetSelector });
    }
    if (before && before !== active && typeof before.blur === 'function') before.blur();
  }
  return {
    focusableCount: focusables.length,
    steps: maxSteps,
    visited,
    counts: {
      failedFocus: failedFocus.length,
      unnamedFocused: unnamedFocused.length,
      hiddenFocused: hiddenFocused.length,
      uniqueVisited: new Set(visited.map((entry) => entry.activeSelector || entry.selector)).size,
    },
    failedFocus: failedFocus.slice(0, 20),
    unnamedFocused: unnamedFocused.slice(0, 20),
    hiddenFocused: hiddenFocused.slice(0, 20),
  };
})()
`;

function listWindows() {
  const status = parseJsonOutput(runScreen(['status']), 'status');
  const windows = Array.isArray(status?.windows?.data) ? status.windows.data : [];
  return windows
    .filter((windowInfo) => windowInfo?.visible !== false && windowInfo?.label)
    .map((windowInfo) => ({
      label: String(windowInfo.label),
      title: String(windowInfo.title || ''),
      url: String(windowInfo.url || ''),
      isMain: Boolean(windowInfo.isMain),
    }));
}

function auditWindow(label) {
  const output = runScreen(['js', '--window', label, '--code', auditScript]);
  return parseJsonOutput(output, `audit ${label}`);
}

function auditKeyboard(label) {
  const output = runScreen(['js', '--window', label, '--code', keyboardAuditScript]);
  return parseJsonOutput(output, `keyboard audit ${label}`);
}

function keyboardOk(keyboard) {
  if (!keyboard) return true;
  const counts = keyboard.counts || {};
  return (counts.failedFocus || 0) === 0
    && (counts.unnamedFocused || 0) === 0
    && (counts.hiddenFocused || 0) === 0
    && ((keyboard.focusableCount || 0) === 0 || (counts.uniqueVisited || 0) > 0);
}

function routeToUrl(route) {
  if (/^https?:\/\//i.test(route)) return route;
  const normalized = route.startsWith('/') ? route : `/${route}`;
  return `http://127.0.0.1:5175${normalized}`;
}

function routeSlug(route) {
  const pathPart = route.replace(/^https?:\/\/[^/]+/i, '') || '/';
  return pathPart.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'root';
}

function resizeWindow(label, viewport) {
  runScreen([
    'resize',
    '--window',
    label,
    '--width',
    String(viewport.width),
    '--height',
    String(viewport.height),
  ], { timeoutMs: resizeTimeoutMs });
  sleepSync(350);
}

function readWindowState(label) {
  const code = "({ href: location.href, pathname: location.pathname, readyState: document.readyState, hasRoot: !!document.querySelector('#root'), title: document.title })";
  return parseJsonOutput(runScreen(['js', '--window', label, '--code', code]), `window state ${label}`);
}

function navigateRoute(route) {
  const target = routeToUrl(route);
  const targetPath = new URL(target).pathname;
  runScreen(['js', '--window', routeWindow, '--code', `setTimeout(() => location.assign(${JSON.stringify(target)}), 0); ({ scheduled: true, href: location.href, pathname: location.pathname })`]);

  const deadline = Date.now() + 30000;
  let state = null;
  while (Date.now() < deadline) {
    sleepSync(250);
    state = readWindowState(routeWindow);
    if (state.pathname === targetPath && state.readyState !== 'loading' && state.hasRoot) {
      if (routeSettleMs > 0) sleepSync(routeSettleMs);
      return { target, state };
    }
  }
  throw new Error(`Timed out navigating ${routeWindow} to ${targetPath}. Last state: ${JSON.stringify(state)}`);
}

function captureRouteScreenshot(route, viewportName) {
  const viewportPart = viewportName ? `${viewportName}-` : '';
  const screenshotPath = path.join(outDir, `route-${viewportPart}${routeSlug(route)}.png`);
  runScreen(['screenshot', '--window', routeWindow, '--file', screenshotPath]);
  return screenshotPath;
}

const windows = listWindows();
const reports = [];

if (requestedRoutes.length) {
  const viewports = requestedViewports.length ? requestedViewports : [null];
  for (const viewport of viewports) {
    if (viewport) {
      try {
        resizeWindow(routeWindow, viewport);
      } catch (error) {
        for (const route of requestedRoutes) {
          reports.push({
            route,
            viewport,
            window: { label: routeWindow },
            ok: false,
            error: `Resize failed for ${viewport.name}:${viewport.width}x${viewport.height}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        continue;
      }
    }
    for (const route of requestedRoutes) {
      try {
        const navigation = navigateRoute(route);
      const audit = auditWindow(routeWindow);
      if ((audit.counts?.interactive || 0) === 0 && !audit.mojibake?.length) {
        const bodyText = String(audit.bodyText || '').trim();
        if (!bodyText) throw new Error(`Route rendered no visible interactive controls or text: ${route}`);
      }
      const keyboard = runKeyboardAudit ? auditKeyboard(routeWindow) : null;
      if (!keyboardOk(keyboard)) throw new Error(`Keyboard audit failed for ${route}: ${JSON.stringify(keyboard?.counts || {})}`);
      const screenshot = captureScreenshots ? captureRouteScreenshot(route, viewport?.name) : null;
        const windowInfo = windows.find((item) => item.label === routeWindow) || { label: routeWindow };
        reports.push({
          route,
          viewport,
          window: { ...windowInfo, url: audit.url },
          ok: true,
          audit,
          keyboard,
          navigation,
          artifacts: screenshot ? { screenshot } : {},
        });
      } catch (error) {
        reports.push({
          route,
          viewport,
          window: { label: routeWindow },
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
} else {
  const labels = requestedWindows.length
    ? requestedWindows
    : windows.map((windowInfo) => windowInfo.label);

  for (const label of labels) {
    try {
      const windowInfo = windows.find((item) => item.label === label) || { label };
      const audit = auditWindow(label);
      const keyboard = runKeyboardAudit ? auditKeyboard(label) : null;
      if (!keyboardOk(keyboard)) throw new Error(`Keyboard audit failed for ${label}: ${JSON.stringify(keyboard?.counts || {})}`);
      reports.push({ window: windowInfo, ok: true, audit, keyboard });
    } catch (error) {
      reports.push({ window: { label }, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

const summary = {
  ok: reports.every((report) => report.ok),
  generatedAt: new Date().toISOString(),
  minTarget,
  strict,
  mode: requestedRoutes.length ? 'routes' : 'windows',
  viewports: requestedViewports,
  reports,
  totals: reports.reduce((acc, report) => {
    const counts = report.audit?.counts || {};
    acc.tooSmall += counts.tooSmall || 0;
    acc.unnamed += counts.unnamed || 0;
    acc.lowContrast += counts.lowContrast || 0;
    acc.overflowing += counts.overflowing || 0;
    acc.mojibake += counts.mojibake || 0;
    acc.consoleErrors += counts.consoleErrors || 0;
    const keyboardCounts = report.keyboard?.counts || {};
    acc.keyboardFailedFocus += keyboardCounts.failedFocus || 0;
    acc.keyboardUnnamedFocused += keyboardCounts.unnamedFocused || 0;
    acc.keyboardHiddenFocused += keyboardCounts.hiddenFocused || 0;
    return acc;
  }, { tooSmall: 0, unnamed: 0, lowContrast: 0, overflowing: 0, mojibake: 0, consoleErrors: 0, keyboardFailedFocus: 0, keyboardUnnamedFocused: 0, keyboardHiddenFocused: 0 }),
};
summary.ok = summary.ok
  && summary.totals.unnamed === 0
  && summary.totals.lowContrast === 0
  && summary.totals.mojibake === 0
  && summary.totals.consoleErrors === 0
  && summary.totals.keyboardFailedFocus === 0
  && summary.totals.keyboardUnnamedFocused === 0
  && summary.totals.keyboardHiddenFocused === 0;
if (strict) {
  summary.ok = summary.ok
    && summary.totals.tooSmall === 0
    && summary.totals.overflowing === 0;
}

const reportPath = path.join(outDir, 'app-ui-audit.json');
writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

for (const report of reports) {
  const counts = report.audit?.counts;
  const viewportLabel = report.viewport ? ` ${report.viewport.name}:${report.viewport.width}x${report.viewport.height}` : '';
  const label = report.route ? `${report.window.label}${viewportLabel} ${report.route}` : `${report.window.label}${viewportLabel}`;
  if (!report.ok) {
    console.log(`[ui:audit] ${label}: ERROR ${report.error}`);
  } else {
    console.log(`[ui:audit] ${label}: ${report.audit.url}`);
    console.log(`  controls=${counts.interactive} small=${counts.tooSmall} unnamed=${counts.unnamed} contrast=${counts.lowContrast} overflow=${counts.overflowing} mojibake=${counts.mojibake} console=${counts.consoleErrors}`);
    if (report.keyboard) {
      const keyboardCounts = report.keyboard.counts || {};
      console.log(`  keyboard=focusable:${report.keyboard.focusableCount} visited:${keyboardCounts.uniqueVisited || 0} failed:${keyboardCounts.failedFocus || 0} unnamed:${keyboardCounts.unnamedFocused || 0} hidden:${keyboardCounts.hiddenFocused || 0}`);
    }
    if (report.artifacts?.screenshot) console.log(`  screenshot=${report.artifacts.screenshot}`);
  }
}
console.log(`[ui:audit] report ${reportPath}`);

if (!summary.ok) {
  process.exitCode = 1;
}
