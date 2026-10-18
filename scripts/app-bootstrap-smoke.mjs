#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(repoRoot, '.octo-tmp'), { recursive: true });
const tempDir = mkdtempSync(path.join(repoRoot, '.octo-tmp', 'bbarit-bootstrap-'));
const modulePath = path.join(tempDir, 'AppBootstrap.mjs');

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const waitFor = async (fn, label, timeoutMs = 3000) => {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError || new Error(`Timed out waiting for ${label}`);
};

const setupDom = () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5175/',
    pretendToBeVisual: true,
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  return dom;
};

const transpileBootstrap = () => {
  const source = readFileSync(path.join(repoRoot, 'src/AppBootstrap.tsx'), 'utf8')
    .replace("import { invoke, isTauri } from '@tauri-apps/api/core';", "const invoke = globalThis.__BBARIT_BOOTSTRAP_INVOKE__;\nconst isTauri = globalThis.__BBARIT_BOOTSTRAP_IS_TAURI__;")
    .replace("import { invoke } from '@tauri-apps/api/core';", "const invoke = globalThis.__BBARIT_BOOTSTRAP_INVOKE__;")
    .replace("import { kvMigrateFromLocalStorage } from './hooks/useKV';", "const kvMigrateFromLocalStorage = globalThis.__BBARIT_BOOTSTRAP_MIGRATE__;")
    .replace('}, 8000);', '}, 120);')
    .replace('}, 12000);', '}, 120);')
    .replaceAll('setTimeout(r, 500)', 'setTimeout(r, 5)')
    .replace('timeoutMs = 700', 'timeoutMs = 20');
  const result = ts.transpileModule(source, {
    fileName: 'AppBootstrap.tsx',
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  });
  const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new Error(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')).join('\n'));
  }
  writeFileSync(modulePath, result.outputText);
};

const main = async () => {
  const dom = setupDom();
  let invokeCalls = 0;
  let migrateCalls = 0;
  globalThis.__BBARIT_BOOTSTRAP_INVOKE__ = async () => {
    invokeCalls += 1;
    throw new Error('mock database unavailable');
  };
  globalThis.__BBARIT_BOOTSTRAP_IS_TAURI__ = () => true;
  globalThis.__BBARIT_BOOTSTRAP_MIGRATE__ = async () => {
    migrateCalls += 1;
    return 0;
  };

  transpileBootstrap();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { AppBootstrap } = await import(pathToFileURL(modulePath).href);

  const root = createRoot(dom.window.document.getElementById('root'));
  root.render(React.createElement(AppBootstrap, null, React.createElement('main', { 'data-bootstrap-ready': 'true' }, 'READY')));

  await waitFor(
    () => dom.window.document.body.textContent.includes('Initializing database'),
    'bootstrap database loading state',
  );
  await waitFor(
    () => dom.window.document.querySelector('[data-bootstrap-ready="true"]'),
    'bootstrap localStorage fallback ready state',
  );
  assert(invokeCalls > 0, 'Bootstrap did not try kv_ping before fallback.');
  assert(migrateCalls === 0, 'Migration should not run when database is unavailable.');
  root.unmount();

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'starts in database loading state',
      'kv_ping failure does not block forever',
      'renders app children through localStorage fallback',
      'skips migration when database is unavailable',
    ],
    invokeCalls,
    migrateCalls,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}).finally(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
