#!/usr/bin/env node
/**
 * 설치본 번들 리소스로 들어가는 .mjs 스크립트가 npm 패키지를 static import 하지
 * 않는지 검사한다. 설치본 Resources 에는 node_modules 가 없어서 bare specifier
 * static import 는 로드 시점에 ERR_MODULE_NOT_FOUND 로 즉사한다 — 실제로
 * tauri-dev-screen.mjs 의 `import { WebSocket } from 'ws'` 가 릴리즈에서
 * 브라우저 CLI 전 명령을 죽였다 (dev 는 repo node_modules 로 가려짐).
 * 동적 import 폴백(`globalThis.X ?? (await import('pkg'))`)은 허용한다.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tauriDir = join(repoRoot, 'src-tauri');
const builtins = new Set(builtinModules);

function collectMjsFiles(entry) {
  const starIdx = entry.indexOf('*');
  if (starIdx < 0) {
    const path = resolve(tauriDir, entry);
    return entry.endsWith('.mjs') ? [path] : [];
  }
  const baseDir = resolve(tauriDir, entry.slice(0, starIdx));
  const found = [];
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.mjs')) found.push(path);
    }
  };
  walk(baseDir);
  return found;
}

// static import / export-from 의 specifier 만 뽑는다. 동적 import() 는 실행돼야
// 터지므로(폴백 패턴 허용) 여기서 잡지 않는다.
function staticImportSpecifiers(source) {
  const specs = [];
  const pattern = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) {
    specs.push(match[1] ?? match[2]);
  }
  return specs;
}

function isBare(spec) {
  return !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:') && !builtins.has(spec);
}

const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
const resources = conf?.bundle?.resources ?? [];
const queue = resources.flatMap(collectMjsFiles);
const seen = new Set();
const problems = [];

while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    problems.push(`${file}: 번들 리소스로 선언됐지만 파일이 없음`);
    continue;
  }
  for (const spec of staticImportSpecifiers(source)) {
    if (isBare(spec)) {
      problems.push(`${file}: static import '${spec}' — 설치본에는 node_modules 가 없어 로드 즉시 실패한다`);
    } else if (spec.startsWith('.')) {
      // 상대 import 를 따라가며 간접 bare import 도 잡는다
      queue.push(resolve(dirname(file), spec));
    }
  }
}

if (problems.length) {
  console.error('bundled script import check FAILED:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('수정: node: builtin 사용 또는 globalThis 폴백 + 동적 import 로 전환');
  process.exit(1);
}
console.log(`bundled script import check OK (${seen.size} file${seen.size === 1 ? '' : 's'})`);
