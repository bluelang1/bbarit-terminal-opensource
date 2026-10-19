import { useEffect, useState } from 'react';
import { Star, X } from 'lucide-react';
import { RELEASE_REPO_MAC } from '../config/endpoints';

// GitHub-star beggar: appears a little while after startup once the app has
// been launched a few times, then comes back weekly — and keeps begging,
// a little more desperately each time, until the user actually stars.

const KEY = 'bbarit-star-nudge';
export const STAR_REPO_URL = `https://github.com/${RELEASE_REPO_MAC}`;
const MIN_LAUNCHES = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SHOW_DELAY_MS = 30000;

export interface StarNudgeState {
  launches: number;
  lastShown: number;
  shows: number;
  done: boolean;
}

export function readNudgeState(raw: string | null): StarNudgeState {
  try {
    const p = raw ? JSON.parse(raw) : {};
    return {
      launches: Number(p?.launches) || 0,
      lastShown: Number(p?.lastShown) || 0,
      shows: Number(p?.shows) || 0,
      done: p?.done === true,
    };
  } catch {
    return { launches: 0, lastShown: 0, shows: 0, done: false };
  }
}

export function shouldShowNudge(s: StarNudgeState, now: number): boolean {
  return !s.done && s.launches >= MIN_LAUNCHES && now - s.lastShown > WEEK_MS;
}

// Escalating begging copy — one step more desperate per appearance.
const BEG_LINES = [
  'A star on GitHub keeps new features coming — it takes two seconds.',
  "Still no star… it's fine. We're fine. (We are not fine.)",
  'Our little terminal has been kneeling here since last week.',
  'The knees are getting sore. One click ends this, you know.',
  'You again! The star button misses you. We miss you. Everyone misses you.',
];

export function pickBegLine(shows: number): string {
  return BEG_LINES[Math.min(Math.max(shows, 0), BEG_LINES.length - 1)];
}

// Original art: a tiny terminal-window creature on its knees, hands clasped,
// teary-eyed, holding a "★ PLZ" sign.
function BeggingArt() {
  return (
    <svg width="120" height="88" viewBox="0 0 120 88" aria-hidden="true" style={{ display: 'block', margin: '0 auto' }}>
      {/* sparkles */}
      <path d="M14 18 l2 5 5 2 -5 2 -2 5 -2-5 -5-2 5-2 z" fill="#e3b341" opacity="0.9" />
      <path d="M104 8 l1.5 3.5 3.5 1.5 -3.5 1.5 -1.5 3.5 -1.5-3.5 -3.5-1.5 3.5-1.5 z" fill="#e3b341" opacity="0.7" />
      {/* kneeling legs */}
      <ellipse cx="38" cy="76" rx="9" ry="5.5" fill="#a81b31" />
      <ellipse cx="60" cy="76" rx="9" ry="5.5" fill="#a81b31" />
      {/* body: little terminal window */}
      <rect x="27" y="18" width="46" height="44" rx="10" fill="#DE2A44" stroke="#8f1628" strokeWidth="2" />
      {/* title-bar dots */}
      <circle cx="36" cy="26" r="2" fill="#ffffff" opacity="0.55" />
      <circle cx="43" cy="26" r="2" fill="#ffffff" opacity="0.55" />
      <circle cx="50" cy="26" r="2" fill="#ffffff" opacity="0.55" />
      {/* pleading eyebrows */}
      <path d="M34 34 Q40 30 45 34" stroke="#8f1628" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M55 34 Q60 30 66 34" stroke="#8f1628" strokeWidth="2" fill="none" strokeLinecap="round" />
      {/* big puppy eyes */}
      <circle cx="40" cy="42" r="7" fill="#ffffff" />
      <circle cx="60" cy="42" r="7" fill="#ffffff" />
      <circle cx="41" cy="43" r="3.6" fill="#22140f" />
      <circle cx="59" cy="43" r="3.6" fill="#22140f" />
      <circle cx="42.5" cy="41.5" r="1.4" fill="#ffffff" />
      <circle cx="60.5" cy="41.5" r="1.4" fill="#ffffff" />
      {/* blush */}
      <ellipse cx="33" cy="50" rx="3.4" ry="2" fill="#ff8fa3" opacity="0.8" />
      <ellipse cx="67" cy="50" rx="3.4" ry="2" fill="#ff8fa3" opacity="0.8" />
      {/* tear */}
      <path d="M67 46 q3 4 0 6.5 q-3-2.5 0-6.5" fill="#7dd3fc" />
      {/* wobbly pleading mouth */}
      <path d="M45 54 Q48 57 51 54 Q54 57 57 54" stroke="#8f1628" strokeWidth="2" fill="none" strokeLinecap="round" />
      {/* clasped begging hands */}
      <ellipse cx="45" cy="64" rx="5" ry="8" fill="#c01f38" transform="rotate(24 45 64)" />
      <ellipse cx="55" cy="64" rx="5" ry="8" fill="#c01f38" transform="rotate(-24 55 64)" />
      <circle cx="50" cy="60" r="4.6" fill="#e8506a" />
      {/* sign: ★ PLZ */}
      <rect x="88" y="42" width="3.5" height="34" rx="1.5" fill="#8b5e34" />
      <g transform="rotate(7 90 32)">
        <rect x="74" y="20" width="33" height="24" rx="4" fill="#f2e8d5" stroke="#8b5e34" strokeWidth="2" />
        <text x="90.5" y="31" textAnchor="middle" fontSize="9" fontWeight="900" fill="#e3a012">★</text>
        <text x="90.5" y="40" textAnchor="middle" fontSize="8.5" fontWeight="900" fill="#6b4a24"
          fontFamily="ui-monospace, Menlo, monospace">PLZ</text>
      </g>
    </svg>
  );
}

export function GithubStarNudge({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  const [show, setShow] = useState(false);
  const [begLine, setBegLine] = useState(BEG_LINES[0]);

  useEffect(() => {
    const s = readNudgeState(localStorage.getItem(KEY));
    const next = { ...s, launches: s.launches + 1 };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* quota */ }
    if (!shouldShowNudge(next, Date.now())) return;
    const t = window.setTimeout(() => {
      setBegLine(pickBegLine(next.shows));
      setShow(true);
      try {
        localStorage.setItem(KEY, JSON.stringify({ ...next, lastShown: Date.now(), shows: next.shows + 1 }));
      } catch { /* quota */ }
    }, SHOW_DELAY_MS);
    return () => window.clearTimeout(t);
  }, []);

  if (!show) return null;

  const finish = (starred: boolean) => {
    setShow(false);
    const s = readNudgeState(localStorage.getItem(KEY));
    try { localStorage.setItem(KEY, JSON.stringify({ ...s, done: s.done || starred })); } catch { /* quota */ }
  };

  return (
    <div className="github-star-nudge" role="dialog" aria-label="Star BBARIT on GitHub"
      style={{ position: 'fixed', right: 16, bottom: 52, zIndex: 30000, width: 300, padding: '12px 14px 12px',
        background: '#161b22', color: '#e6edf3', border: '1px solid #30363d', borderRadius: 12,
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)', fontSize: 12.5, lineHeight: 1.5 }}>
      <button type="button" title="Later (we'll be back)" onClick={() => finish(false)}
        style={{ position: 'absolute', top: 8, right: 8, border: 0, background: 'transparent', color: '#8b949e',
          cursor: 'pointer', display: 'flex', padding: 2 }}>
        <X size={13} />
      </button>
      <BeggingArt />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontWeight: 800, fontSize: 13.5, marginTop: 4 }}>
        <Star size={15} color="#e3b341" fill="#e3b341" /> Enjoying BBARIT Terminal?
      </div>
      <div style={{ marginTop: 6, color: '#9da7b1', textAlign: 'center' }}>
        {begLine}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11 }}>
        <button type="button"
          onClick={() => { onOpenUrl(STAR_REPO_URL); finish(true); }}
          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: '7px 10px', borderRadius: 8, border: '1px solid #e3b34155', background: '#e3b34122',
            color: '#e3b341', fontWeight: 800, fontSize: 12.5, cursor: 'pointer' }}>
          <Star size={13} /> Star on GitHub
        </button>
        <button type="button" onClick={() => finish(false)}
          style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #30363d', background: 'transparent',
            color: '#8b949e', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
          Later
        </button>
      </div>
    </div>
  );
}
