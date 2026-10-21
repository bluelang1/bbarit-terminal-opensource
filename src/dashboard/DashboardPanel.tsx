import { useEffect, useRef, useState } from 'react';
import * as LucideIcons from 'lucide-react';
import { loadDashboardUrl, normalizeDashboardUrl, saveDashboardUrl } from './dashboardUrl';

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = () => {
    const next = normalizeDashboardUrl(draft);
    if (!next) { setInvalid(true); inputRef.current?.focus(); return; }
    setInvalid(false);
    setDraft(next);
    if (next !== url) { setUrl(next); saveDashboardUrl(next); setLoaded(false); }
    else setReloadKey((k) => k + 1);
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
          <button type="button" style={btn} title="Close (Esc)" onClick={onClose}><LucideIcons.X size={13} /></button>
        </form>
        <div style={{ position: 'relative', flex: 1, background: '#fff' }}>
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
            allow="clipboard-read; clipboard-write"
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
          />
        </div>
      </div>
    </div>
  );
}
