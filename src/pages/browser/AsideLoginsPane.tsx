/**
 * AsideLoginsPane — 어사이드 사이트 로그인(아이디/패스워드) 설정.
 *
 * 항목은 호스트가 kv(`browser-aside-logins`)로 영속한다 — 이 기기 로컬 저장.
 * 액션 두 갈래(설계 D13/D17):
 * - Fill: 현재 페이지의 로그인 폼에 값만 채운다(제출 안 함 — 사람이 버튼을 누른다).
 * - Agent sign-in: 빠릿에게 로그인 태스크로 위임 — 어사이드 승인 게이트를 지난다.
 */
import { useMemo, useState } from 'react';
import { Bot, Copy, Eye, EyeOff, KeyRound, Pencil, Plus, Trash2, Wand2 } from 'lucide-react';

export interface SiteLogin {
  id: string;
  site: string;
  username: string;
  password: string;
  note?: string;
  updatedAt: number;
}

interface Props {
  logins: SiteLogin[];
  /** 활성 탭 호스트 — 새 항목 프리필 + "이 사이트" 강조. */
  currentHost: string | null;
  pageAvailable: boolean;
  onSave: (login: SiteLogin) => void;
  onDelete: (id: string) => void;
  onAutofill: (login: SiteLogin) => void;
  onAgentLogin: (login: SiteLogin) => void;
}

const emptyDraft = (site: string): SiteLogin => ({
  id: '',
  site,
  username: '',
  password: '',
  note: '',
  updatedAt: 0,
});

function hostMatches(site: string, host: string | null): boolean {
  if (!host) return false;
  const s = site.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  const h = host.toLowerCase();
  return !!s && (h === s || h.endsWith(`.${s}`) || s.endsWith(`.${h}`));
}

export function AsideLoginsPane({ logins, currentHost, pageAvailable, onSave, onDelete, onAutofill, onAgentLogin }: Props) {
  const [draft, setDraft] = useState<SiteLogin | null>(null);
  const [revealed, setRevealed] = useState<string[]>([]);

  const sorted = useMemo(() => [...logins].sort((a, b) => {
    const am = hostMatches(a.site, currentHost) ? 0 : 1;
    const bm = hostMatches(b.site, currentHost) ? 0 : 1;
    if (am !== bm) return am - bm;
    return b.updatedAt - a.updatedAt;
  }), [logins, currentHost]);

  const copy = (value: string) => { void navigator.clipboard?.writeText(value).catch(() => {}); };

  const submitDraft = () => {
    if (!draft) return;
    const site = draft.site.trim();
    const username = draft.username.trim();
    if (!site || !username || !draft.password) return;
    onSave({
      ...draft,
      site,
      username,
      id: draft.id || Date.now().toString(36),
      updatedAt: Date.now(),
    });
    setDraft(null);
  };

  return (
    <div className="aside-logins-pane">
      <div className="aside-logins-hint">
        <KeyRound size={12} />
        Stored locally in this app's data only — used to fill sign-in forms or let BBARIT log in for you.
      </div>
      {draft ? (
        <div className="aside-login-form">
          <label>Site<input type="text" placeholder="example.com" value={draft.site} onChange={(e) => setDraft({ ...draft, site: e.target.value })} /></label>
          <label>Username / ID<input type="text" placeholder="user@example.com" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} /></label>
          <label>Password<input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} /></label>
          <label>Note (optional)<input type="text" placeholder="work account…" value={draft.note ?? ''} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></label>
          <div className="aside-login-form-actions">
            <button type="button" className="primary" disabled={!draft.site.trim() || !draft.username.trim() || !draft.password} onClick={submitDraft}>{draft.id ? 'Save changes' : 'Add login'}</button>
            <button type="button" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className="aside-logins-add" onClick={() => setDraft(emptyDraft(currentHost ?? ''))}>
          <Plus size={13} /> Add login{currentHost ? ` for ${currentHost}` : ''}
        </button>
      )}
      <div className="aside-logins-list">
        {sorted.length === 0 && !draft && (
          <div className="aside-logins-empty">No saved logins yet — add one and BBARIT can sign in for you.</div>
        )}
        {sorted.map((login) => {
          const match = hostMatches(login.site, currentHost);
          const shown = revealed.includes(login.id);
          return (
            <div key={login.id} className={`aside-login-row${match ? ' match' : ''}`}>
              <div className="aside-login-main">
                <div className="aside-login-site" title={login.note || login.site}>
                  {login.site}
                  {match && <span className="aside-login-match">this site</span>}
                </div>
                <div className="aside-login-cred">
                  <span className="aside-login-user" title="Copy username" onClick={() => copy(login.username)}>{login.username}</span>
                  <span className="aside-login-pass" title="Copy password" onClick={() => copy(login.password)}>
                    {shown ? login.password : '••••••••'}
                  </span>
                  <button
                    type="button"
                    title={shown ? 'Hide password' : 'Show password'}
                    onClick={() => setRevealed((prev) => shown ? prev.filter((id) => id !== login.id) : [...prev, login.id])}
                  >{shown ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                  <button type="button" title="Copy password" onClick={() => copy(login.password)}><Copy size={12} /></button>
                </div>
              </div>
              <div className="aside-login-actions">
                <button
                  type="button"
                  disabled={!pageAvailable}
                  title="Fill the sign-in form on the current page (does NOT submit)"
                  onClick={() => onAutofill(login)}
                ><Wand2 size={12} /> Fill</button>
                <button
                  type="button"
                  disabled={!pageAvailable}
                  title="Let BBARIT sign in on the current tab (asks for approval first)"
                  onClick={() => onAgentLogin(login)}
                ><Bot size={12} /> Sign in</button>
                <button type="button" title="Edit" onClick={() => setDraft({ ...login })}><Pencil size={12} /></button>
                <button type="button" title="Delete" onClick={() => onDelete(login.id)}><Trash2 size={12} /></button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
