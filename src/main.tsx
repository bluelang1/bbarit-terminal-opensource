// Polyfill requestIdleCallback for WebKit (Tauri on macOS)
if (typeof window !== 'undefined' && typeof window.requestIdleCallback !== 'function') {
  (window as any).requestIdleCallback = (cb: IdleRequestCallback, opts?: IdleRequestOptions) => {
    const start = Date.now();
    return window.setTimeout(() => {
      cb({ didTimeout: false, timeRemaining: () => Math.max(0, 50 - (Date.now() - start)) } as IdleDeadline);
    }, opts?.timeout ? Math.min(opts.timeout, 1) : 1);
  };
  (window as any).cancelIdleCallback = (id: number) => window.clearTimeout(id);
}

import { Component, StrictMode, lazy, Suspense } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import '../public/fonts/fonts.css'
// Fontsource: Nanum Gothic Coding (CJK monospace, auto-subsetted)
import '@fontsource/nanum-gothic-coding/400.css'
import '@fontsource/nanum-gothic-coding/700.css'
import '@fontsource/source-code-pro/400.css'
import '@fontsource/source-code-pro/700.css'
import { ConfigProvider } from './config/ConfigContext'
import { AppBootstrap } from './AppBootstrap'
import { ProductNoticeGate } from './ProductNoticeGate'
import { installMenuSelectAllBridge } from './menuSelectAllBridge'

function installBrutalistControlGuard() {
  if (typeof document === 'undefined') return;
  const id = 'bbarit-brutalist-control-guard';
  const css = `
button,
[role="button"],
input,
select,
textarea,
summary,
[role="tab"],
[role="menuitem"] {
  border-radius: 0 !important;
}
`;
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    style.textContent = css;
  }
  const keepLast = () => {
    if (!style) return;
    if (style.parentNode !== document.head || style.nextSibling) {
      document.head.appendChild(style);
    }
  };
  keepLast();
  const observer = new MutationObserver(() => keepLast());
  observer.observe(document.head, { childList: true });
}

installBrutalistControlGuard();
installMenuSelectAllBridge();

// Monaco를 CDN 대신 로컬 번들로 구동 (오프라인 안전 + 버전 고정).
// 별도 청크라 첫 페인트를 막지 않고, <Editor> 첫 마운트 전에 로드가 끝난다.
void import('./editor/monacoSetup');

// Sub-pages loaded via hash routing for Tauri multi-window
const App = lazy(() => import('./App.tsx'))
const ScrumPage = lazy(() => import('./pages/ScrumPage'))
// AI Debate disabled from app routing for now.
// const DebatePage = lazy(() => import('./pages/DebatePage'))
const AgentTerminalPage = lazy(() => import('./pages/AgentTerminalPage'))
const AgentPanelPage = lazy(() => import('./pages/AgentPanelPage'))
const SkillsStudioPage = lazy(() => import('./pages/SkillsStudioPage'))
const BrowserPage = lazy(() => import('./pages/BrowserPage'))
const ChatPage = lazy(() => import('./pages/ChatPage'))
const ThreadPage = lazy(() => import('./pages/ThreadPage'))
// Planning AI disabled from app routing for now.
// const PlanningPage = lazy(() => import('./pages/PlanningPage'))

// Ignore xterm.js errors (occur when accessing renderer before initialization)
const xtermErrorPatterns = ['_renderer', 'dimensions', 'PTY not found', 'syncScrollArea', '_innerRefresh'];

// Console error filtering
const originalError = console.error;
console.error = (...args) => {
  const msg = args.map(a => String(a)).join(' ');
  if (xtermErrorPatterns.some(p => msg.includes(p))) return;
  originalError.apply(console, args);
};

// Global error handler
window.addEventListener('error', (e) => {
  const msg = e.message || '';
  if (xtermErrorPatterns.some(p => msg.includes(p))) {
    e.preventDefault();
    return false;
  }
});

// Unhandled promise rejection handler
window.addEventListener('unhandledrejection', (e) => {
  const msg = String(e.reason);
  if (xtermErrorPatterns.some(p => msg.includes(p))) {
    e.preventDefault();
    return;
  }
});

// Error Boundary: prevents unhandled React errors from crashing the entire app
class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: string }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: '' };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message || String(error) };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[AppErrorBoundary]', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', color: '#ef4444', background: '#0f0f0f', height: '100vh' }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>Something went wrong</h2>
          <pre style={{ fontSize: 12, color: '#999', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{this.state.error}</pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: '' }); }}
            style={{ marginTop: 16, padding: '6px 16px', background: '#333', color: '#fff', border: 'none', borderRadius: 'var(--brutal-radius)', cursor: 'pointer', fontSize: 12 }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Simple hash-based routing for Tauri multi-window support
function getPage(): string {
  const path = window.location.pathname;
  if (path.startsWith('/scrum')) return 'scrum';
  // if (path.startsWith('/debate')) return 'debate';
  if (path.startsWith('/agent-terminal')) return 'agent-terminal';
  if (path.startsWith('/agent-panel')) return 'agent-panel';
  if (path.startsWith('/skills-studio')) return 'skills-studio';
  if (path.startsWith('/browser')) return 'browser';
  if (path.startsWith('/chat')) return 'chat';
  if (path.startsWith('/thread')) return 'thread';
  if (path.startsWith('/harness')) return 'harness';
  // if (path.startsWith('/planning')) return 'planning';
  return 'main';
}

function RootRouter() {
  const page = getPage();
  if (page === 'main' || page === 'harness') {
    // The harness window loads the same App; App detects /harness and renders only the
    // broker harness workspace (so it can develop separately in its own window).
    return (
      <Suspense fallback={null}>
        <App />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      {page === 'scrum' && <ScrumPage />}
      {/* {page === 'debate' && <DebatePage />} */}
      {page === 'agent-terminal' && <AgentTerminalPage />}
      {page === 'agent-panel' && <AgentPanelPage />}
      {page === 'skills-studio' && <SkillsStudioPage />}
      {page === 'browser' && <BrowserPage />}
      {page === 'chat' && <ChatPage />}
      {page === 'thread' && <ThreadPage />}
      {/* {page === 'planning' && <PlanningPage />} */}
    </Suspense>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <ProductNoticeGate>
        <AppBootstrap>
          <ConfigProvider>
            <RootRouter />
          </ConfigProvider>
        </AppBootstrap>
      </ProductNoticeGate>
    </AppErrorBoundary>
  </StrictMode>,
)
