import { useEffect, useRef, useState } from 'react';
import * as LucideIcons from 'lucide-react';
import { DASHBOARD_SANDBOX, loadDashboardUrl, normalizeDashboardUrl, saveDashboardUrl } from './dashboardUrl';

type Props = {
  onClose: () => void;
  onOpenExternal: (url: string) => void;
  accent?: string;
  bg?: string;
  text?: string;
};

/**
 * Embeds the user's local agent dashboard (any http(s) URL, usually a dev
 * server on localhost) in a large overlay. The URL bar is editable and
 * remembered. If the dashboard's server forbids framing (X-Frame-Options or a
 * CSP frame-ancestors rule) the frame stays blank; "Open in browser" is the
 * fallback.
 */
export function DashboardPanel({ onClose, onOpenExternal, accent = '#89b4fa', bg = '#0b0b0d', text = '#eee' }: Props) {
  const [url, setUrl] = useState(() => loadDashboardUrl());
  const [draft, setDraft] = useState(url);
  const [invalid, setInvalid] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // WKWebView keeps focus on the terminal behind when a toolbar button is
    // clicked; take focus so keystrokes do not reach the PTY, and swallow Esc
    // in the capture phase so it is not sent to the terminal as \x1b.
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
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

  const btn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 12,
    background: 'transparent', color: text, border: `1px solid ${text}33`, borderRadius: 6, cursor: 'pointer',
  };

  return (
    <div
      className="dashboard-overlay"
      onMouseDown={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: '96vw', height: '92vh', background: bg, color: text, borderRadius: 12, overflow: 'hidden',
          display: 'flex', flexDirection: 'column', boxShadow: '0 24px 80px rgba(0,0,0,0.55)', border: `1px solid ${text}22`,
        }}
      >
        <form
          onSubmit={(e) => { e.preventDefault(); apply(); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${text}1f` }}
        >
          <LucideIcons.LayoutDashboard size={15} style={{ color: accent, flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setInvalid(false); }}
            spellCheck={false}
            aria-label="Dashboard URL"
            title="Dashboard URL (Enter to load)"
            style={{
              flex: 1, minWidth: 0, fontSize: 12, padding: '5px 8px', borderRadius: 6, outline: 'none',
              background: `${text}0d`, color: text, border: `1px solid ${invalid ? '#f38ba8' : `${text}26`}`,
            }}
          />
          <button type="submit" style={btn} title="Load / reload"><LucideIcons.RotateCw size={13} /></button>
          <button type="button" style={btn} title="Open in browser" onClick={() => onOpenExternal(url)}><LucideIcons.ExternalLink size={13} /></button>
          <button type="button" style={btn} title="Close (Esc, when focus is outside the dashboard)" onClick={onClose}><LucideIcons.X size={13} /></button>
        </form>
        <div style={{ position: 'relative', flex: 1, background: '#fff' }}>
          {/* Links that open new windows are blocked by the sandbox; use Open in browser. */}
          {!loaded && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: bg, color: `${text}99`, fontSize: 12, textAlign: 'center', padding: 24, pointerEvents: 'none' }}>
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
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
          />
        </div>
      </div>
    </div>
  );
}
