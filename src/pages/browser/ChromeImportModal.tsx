/**
 * ChromeImportModal — Chrome/Chromium 데이터 가져오기 마법사.
 *
 * 흐름: 열리면 설치된 브라우저 프로필을 훑어 목록을 보여준다 → 사용자가 프로필과
 * 항목(비밀번호/북마크/방문기록/자동완성/검색엔진/쿠키)을 고른다 → 가져오기를 누르면
 * 백엔드가 복호화해 넘겨준 payload를 onImported로 넘긴다. 실제 저장·병합·쿠키 주입은
 * 호출부(BrowserPage)가 브라우저의 기존 저장소에 맞춰 처리한다.
 *
 * macOS에서 비밀번호/쿠키를 고르면 OS Keychain 승인 다이얼로그가 뜬다 — 그게 동의 관문.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bookmark, Check, Clock, Cookie, KeyRound, Loader2, RefreshCw, Search, Type, X } from 'lucide-react';
import {
  importChromeData,
  listChromeProfiles,
  type ChromeProfile,
  type ImportItem,
  type ImportPayload,
} from './chromeImport';

interface Props {
  locale: string;
  onClose: () => void;
  onImported: (payload: ImportPayload, items: ImportItem[], profile: ChromeProfile) => void;
}

const ITEM_META: Array<{ key: ImportItem; icon: typeof KeyRound; ko: string; en: string; countKey: keyof ChromeProfile }> = [
  { key: 'passwords', icon: KeyRound, ko: '비밀번호', en: 'Passwords', countKey: 'passwords' },
  { key: 'bookmarks', icon: Bookmark, ko: '북마크', en: 'Bookmarks', countKey: 'bookmarks' },
  { key: 'history', icon: Clock, ko: '방문 기록', en: 'History', countKey: 'history' },
  { key: 'cookies', icon: Cookie, ko: '로그인 세션(쿠키)', en: 'Login sessions (cookies)', countKey: 'cookies' },
  { key: 'autofill', icon: Type, ko: '자동완성', en: 'Autofill', countKey: 'autofill' },
  { key: 'search_engines', icon: Search, ko: '검색 엔진', en: 'Search engines', countKey: 'search_engines' },
];

export function ChromeImportModal({ locale, onClose, onImported }: Props) {
  const ko = locale === 'ko';
  const [profiles, setProfiles] = useState<ChromeProfile[] | null>(null);
  const [scanError, setScanError] = useState<string>('');
  const [selectedDir, setSelectedDir] = useState<string>('');
  const [items, setItems] = useState<Set<ImportItem>>(new Set(['passwords', 'bookmarks', 'history', 'cookies']));
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState('');

  const scan = useCallback(() => {
    setProfiles(null);
    setScanError('');
    listChromeProfiles()
      .then((list) => {
        setProfiles(list);
        setSelectedDir((prev) => prev || list[0]?.profile_dir || '');
      })
      .catch((e) => setScanError(String((e as Error)?.message || e)));
  }, []);

  useEffect(() => { scan(); }, [scan]);

  const selected = useMemo(
    () => profiles?.find((p) => p.profile_dir === selectedDir) || null,
    [profiles, selectedDir],
  );

  const toggleItem = (key: ImportItem) => {
    setItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // 선택 프로필에 실제로 데이터가 있는 항목만 활성화한다.
  const itemCount = (p: ChromeProfile | null, key: keyof ChromeProfile): number =>
    p ? (p[key] as number) || 0 : 0;

  const anySelected = selected && [...items].some((k) => itemCount(selected, ITEM_META.find((m) => m.key === k)!.countKey) > 0);

  const runImport = async () => {
    if (!selected || busy) return;
    const chosen = ITEM_META
      .map((m) => m.key)
      .filter((k) => items.has(k) && itemCount(selected, ITEM_META.find((m) => m.key === k)!.countKey) > 0);
    if (!chosen.length) return;
    setBusy(true);
    setImportError('');
    try {
      const payload = await importChromeData(selected, chosen);
      onImported(payload, chosen, selected);
    } catch (e) {
      setImportError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="browser-import-overlay" role="dialog" aria-modal="true" aria-label={ko ? 'Chrome 가져오기' : 'Import from Chrome'}>
      <div className="browser-import-card">
        <div className="browser-import-head">
          <strong>{ko ? '다른 브라우저에서 가져오기' : 'Import from another browser'}</strong>
          <button type="button" onClick={onClose} title={ko ? '닫기' : 'Close'}><X size={16} /></button>
        </div>

        <p className="browser-import-lead">
          {ko
            ? 'Chrome·Edge·Brave·Whale 등에 저장된 비밀번호, 북마크, 방문 기록, 로그인 세션을 빠릿 브라우저로 가져옵니다.'
            : 'Bring your passwords, bookmarks, history, and login sessions from Chrome, Edge, Brave, Whale, and more.'}
        </p>

        {profiles === null && !scanError && (
          <div className="browser-import-status"><Loader2 size={16} className="spin" /> {ko ? '설치된 브라우저를 확인하는 중…' : 'Looking for installed browsers…'}</div>
        )}

        {scanError && (
          <div className="browser-import-status error">
            {ko ? '브라우저 목록을 읽지 못했습니다: ' : 'Could not read browser list: '}{scanError}
            <button type="button" className="browser-import-retry" onClick={scan}><RefreshCw size={13} /> {ko ? '다시 시도' : 'Retry'}</button>
          </div>
        )}

        {profiles && profiles.length === 0 && (
          <div className="browser-import-status">{ko ? '가져올 수 있는 브라우저 프로필을 찾지 못했습니다.' : 'No importable browser profiles found.'}</div>
        )}

        {profiles && profiles.length > 0 && (
          <>
            <label className="browser-import-label">{ko ? '프로필' : 'Profile'}</label>
            <select
              className="browser-import-profile"
              value={selectedDir}
              onChange={(e) => setSelectedDir(e.target.value)}
              disabled={busy}
            >
              {profiles.map((p) => (
                <option key={p.profile_dir} value={p.profile_dir}>
                  {p.browser_name} — {p.display_name}
                  {` · ${p.passwords}${ko ? '개 비번' : ' pw'}, ${p.history}${ko ? '개 기록' : ' hist'}`}
                </option>
              ))}
            </select>

            <label className="browser-import-label">{ko ? '가져올 항목' : 'What to import'}</label>
            <div className="browser-import-items">
              {ITEM_META.map((m) => {
                const count = itemCount(selected, m.countKey);
                const disabled = count === 0 || busy;
                const on = items.has(m.key);
                const Icon = m.icon;
                return (
                  <button
                    key={m.key}
                    type="button"
                    className={`browser-import-item${on && !disabled ? ' on' : ''}${disabled ? ' disabled' : ''}`}
                    onClick={() => !disabled && toggleItem(m.key)}
                    disabled={disabled}
                  >
                    <span className="browser-import-item-check">{on && !disabled ? <Check size={13} /> : null}</span>
                    <Icon size={15} />
                    <span className="browser-import-item-name">{ko ? m.ko : m.en}</span>
                    <span className="browser-import-item-count">{count}</span>
                  </button>
                );
              })}
            </div>

            {(items.has('passwords') || items.has('cookies')) && (
              <div className="browser-import-note">
                {ko
                  ? '비밀번호·쿠키를 가져오려면 macOS 키체인 접근을 허용해야 합니다(승인 창이 뜹니다).'
                  : 'Importing passwords or cookies asks for macOS Keychain access (an approval dialog appears).'}
              </div>
            )}

            {importError && <div className="browser-import-status error">{importError}</div>}

            <div className="browser-import-actions">
              <button type="button" onClick={onClose} disabled={busy}>{ko ? '취소' : 'Cancel'}</button>
              <button
                type="button"
                className="primary"
                onClick={runImport}
                disabled={busy || !anySelected}
              >
                {busy
                  ? <><Loader2 size={14} className="spin" /> {ko ? '가져오는 중…' : 'Importing…'}</>
                  : (ko ? '가져오기' : 'Import')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
