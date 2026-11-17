import { useEffect, useRef, useState } from 'react';
import * as LucideIcons from 'lucide-react';
import { DASHBOARD_SANDBOX, loadDashboardUrl, normalizeDashboardUrl, saveDashboardUrl } from './dashboardUrl';

type Props = {
  onClose: () => void;
  onOpenExternal: (url: string) => void;
  /** Move focus to the URL bar when the tab is shown (keystrokes must not reach the PTY). */
  autoFocus?: boolean;
};

/**
 * The "Dashboard" tab of the gauge overlay (src/teamStatus/TeamStatusOverlay.tsx): embeds the
 * user's local agent dashboard (any http(s) URL, usually a dev server on localhost). The URL
 * bar is editable and remembered. If the dashboard's server forbids framing (X-Frame-Options
 * or a CSP frame-ancestors rule) the frame stays blank; "Open in browser" is the fallback.
 * Esc is handled by the overlay (capture phase), as before.
 */
export function DashboardContent({ onClose, onOpenExternal, autoFocus = true }: Props) {
  const [url, setUrl] = useState(() => loadDashboardUrl());
  const [draft, setDraft] = useState(url);
  const [invalid, setInvalid] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // WKWebView keeps focus on the terminal behind when a toolbar button is clicked.
    if (autoFocus) inputRef.current?.focus();
  }, []);

  const apply = () => {
    const next = normalizeDashboardUrl(draft);
    if (!next) { setInvalid(true); inputRef.current?.focus(); return; }
    setInvalid(false);
    setDraft(next);
    if (next !== url) { setUrl(next); saveDashboardUrl(next); }
    else setReloadKey((k) => k + 1);
    setLoaded(false);
  };

  return (
    <>
      <form className="ts-dashboard-bar" onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <LucideIcons.Gauge size={15} style={{ color: 'var(--accent-color)', flexShrink: 0 }} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setInvalid(false); }}
          spellCheck={false}
          aria-label="Dashboard URL"
          aria-invalid={invalid}
          title="Dashboard URL (Enter to load)"
        />
        <button type="submit" className="ts-btn ts-icon" title="Load / reload" aria-label="Load / reload"><LucideIcons.RotateCw size={13} /></button>
        <button type="button" className="ts-btn ts-icon" title="Open in browser" aria-label="Open in browser" onClick={() => onOpenExternal(url)}><LucideIcons.ExternalLink size={13} /></button>
        <button type="button" className="ts-btn ts-icon" title="Close (Esc, when focus is outside the dashboard)" aria-label="Close" onClick={onClose}><LucideIcons.X size={13} /></button>
      </form>
      <div className="ts-dashboard-frame">
        {/* Links that open new windows are blocked by the sandbox; use Open in browser. */}
        {!loaded && (
          <div className="ts-dashboard-loading">
            Loading {url}<br />If it stays blank, check that the dashboard server is running, or use Open in browser.
          </div>
        )}
        <iframe
          key={`${url}#${reloadKey}`}
          src={url}
          title="Agent dashboard"
          onLoad={() => setLoaded(true)}
          sandbox={DASHBOARD_SANDBOX}
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </>
  );
}
