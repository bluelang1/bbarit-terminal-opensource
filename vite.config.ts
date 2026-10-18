import { defineConfig } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Absolute path to the BBARIT browser-control CLI, baked in at build time so agents
// in ANY project's terminal can drive the BBARIT browser (not just octo-terminal-src).
const bbaritBrowserCli = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'agent-browser-cli/bin/bbarit-browser-control.mjs',
)

function rawDevHtmlFallback(): Plugin {
  const preamble = `<script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script>
<script type="module" src="/@vite/client"></script>`;

  return {
    name: 'bbarit-raw-dev-html-fallback',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
        const pathname = (req.url || '').split('?', 1)[0];
        if (req.method !== 'GET' || !['/', '/harness', '/index.html'].includes(pathname)) {
          next();
          return;
        }
        try {
          const html = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8')
            .replace('</head>', `${preamble}\n  </head>`);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(html);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

const repoRoot = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  define: {
    __BBARIT_BROWSER_CLI__: JSON.stringify(bbaritBrowserCli),
    // dev 전용 기본 프로젝트 경로(repo 루트). 릴리즈 번들에는 개발 머신 경로를
    // 박지 않도록 build에서는 빈 문자열로 둔다 — 소비처(App.tsx)가 DEV 가드로 사용.
    __DEV_REPO_ROOT__: JSON.stringify(command === 'serve' ? repoRoot : ''),
  },
  // Tauri serves the bundled frontend from a custom protocol. Absolute asset
  // URLs such as /assets/foo.js resolve through the app fallback and return
  // HTML, which breaks lazy-loaded editor chunks.
  base: './',
  plugins: [rawDevHtmlFallback(), react()],
  resolve: {
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  server: {
    // Tauri WebView can be picky about localhost resolution (IPv4 vs IPv6).
    // Pin to IPv4 and a stable port that matches `src-tauri/tauri.conf.json`.
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    watch: {
      // Tauri의 Rust 빌드 산출물(src-tauri/target)을 Vite가 감시하면, cargo가
      // .exe를 쓰는 도중 Windows에서 EBUSY로 watcher가 죽어 dev 서버가 종료된다.
      // src-tauri 전체를 워치에서 제외한다 (Tauri 권장 설정).
      // bbarit-agent(내장 에이전트 소스 크레이트)도 같은 이유로 제외 — 빌드 시
      // target/이 갱신되며 Windows에서 watcher가 EBUSY로 죽는다.
      // .octo-tmp(벤치마크 데이터셋/스크린샷 등 런타임 산출물)를 감시하면 저장소
      // 통째 clone이 들어올 때 수천 개 watcher + 무작위 full page reload가 발생해
      // 앱 전체가 느려지고 제멋대로 리로드된다.
      ignored: ['**/src-tauri/**', '**/bbarit-agent/**', '**/.octo-tmp/**'],
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 함수형 manualChunks: 배열형은 각 패키지를 루트 기준 엔트리로 재해석해
        // pnpm 엄격 레이아웃(전이 의존성 비노출)에서 "Could not resolve entry
        // module" 빌드 실패를 낸다. 모듈 경로 매칭은 해석이 필요 없어 안전.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('monaco-editor')) return 'monaco'
          if (id.includes('prosemirror-')) return 'prosemirror'
          if (id.includes('@tiptap/') || id.includes('tiptap-markdown')) return 'tiptap'
          return undefined
        },
      },
    },
  },
  optimizeDeps: {
    // Force pre-bundle packages that use 'export *' patterns to avoid
    // WebKit SyntaxError: "Importing binding name 'default' cannot be resolved by star export entries"
    // @tiptap/pm/* subpath exports are the main culprit — each does `export * from 'prosemirror-*'`
    include: [
      'pdf-lib',
      'react-pdf',
      'pdfjs-dist',
      'tiptap-markdown',
      '@tiptap/react',
      '@tiptap/starter-kit',
      '@tiptap/core',
      '@tiptap/pm/commands',
      '@tiptap/pm/dropcursor',
      '@tiptap/pm/gapcursor',
      '@tiptap/pm/history',
      '@tiptap/pm/keymap',
      '@tiptap/pm/model',
      '@tiptap/pm/schema-list',
      '@tiptap/pm/state',
      '@tiptap/pm/tables',
      '@tiptap/pm/transform',
      '@tiptap/pm/view',
      'mermaid',
      // 오피스 에디터가 lazy `import()`로만 끌어오는 파서/저장 라이브러리 —
      // 서버 기동 시 발견되지 않으면 첫 docx/pptx/xlsx 오픈에서 Vite 의존성
      // 재최적화(esbuild CPU 급등) 후 웹뷰 강제 풀 리로드가 발생한다. 미리 프리번들.
      'jszip',
      'pptxgenjs',
      'mammoth',
      'docx',
      'xlsx-js-style',
      // UMD 패키지 — dev에서 named export(WebglAddon) interop을 위해 프리번들 강제
      'xterm-addon-webgl',
    ],
  },
}))
