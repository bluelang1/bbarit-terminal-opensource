/**
 * BBARIT Agent 페르소나 피커 모달 — 설정 패널과 에이전트 하니스 패널이 공용으로
 * 사용한다. 카드 그리드(아이콘·이름·직군·설명·스탯) → 카드 클릭 시 우측 상세
 * (큰 아이콘, 설명, 스탯 바, 원본 .md 보기) → Use this persona로 확정.
 *
 * Broker Agent와는 무관 — Broker 쪽에서는 절대 사용하지 않는다.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { X, Search, Star, FileText, ArrowLeft, Ban } from 'lucide-react';
import {
  buildBbaritPersonaProfile,
  personaIconUrl,
  type BbaritPersonaEntry,
} from '../terminal/bbaritAgentPersonaProfile';
import { useTranslation } from '../i18n';
import './BbaritPersonaPickerModal.css';

function PersonaAvatar({ id, emoji, size }: { id: string; emoji: string; size: number }) {
  const [broken, setBroken] = useState(false);
  const url = personaIconUrl(id);
  if (!url || broken) {
    return (
      <span className="bpp-avatar bpp-avatar-emoji" style={{ width: size, height: size, fontSize: size * 0.5 }}>
        {emoji || 'AI'}
      </span>
    );
  }
  return (
    <img
      className="bpp-avatar"
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      onError={() => setBroken(true)}
    />
  );
}

export interface BbaritPersonaPickerModalProps {
  personas: BbaritPersonaEntry[];
  /** 현재 선택된 페르소나 id ('' = 없음) */
  selectedId?: string;
  /** 즐겨찾기 id 목록 — 넘기면 카드에 별 토글이 생기고 즐겨찾기가 위로 정렬된다 */
  favorites?: string[];
  onToggleFavorite?: (id: string) => void;
  /** 용도에 맞는 추천 페르소나 id — 그리드 맨 앞에 "추천" 배지로 정렬된다 */
  recommendedIds?: string[];
  /** 확정 콜백 — '' 는 "페르소나 없음" 선택 */
  onSelect: (id: string) => void;
  onClose: () => void;
  title?: string;
}

export function BbaritPersonaPickerModal({
  personas,
  selectedId = '',
  favorites,
  onToggleFavorite,
  recommendedIds,
  onSelect,
  onClose,
  title,
}: BbaritPersonaPickerModalProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [division, setDivision] = useState<string>('');
  const [detailId, setDetailId] = useState<string>(selectedId);
  const [mdView, setMdView] = useState(false);
  const [mdContent, setMdContent] = useState('');
  const [mdError, setMdError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const divisions = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of personas) seen.set(p.division, (seen.get(p.division) || 0) + 1);
    return [...seen.entries()];
  }, [personas]);

  const favSet = useMemo(() => new Set(favorites || []), [favorites]);
  // 추천은 넘어온 순서가 곧 우선순위 — index를 보존해 그 순서대로 맨 앞에 깔린다.
  const recRank = useMemo(() => {
    const map = new Map<string, number>();
    (recommendedIds || []).forEach((id, index) => map.set(id, index));
    return map;
  }, [recommendedIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = personas;
    if (division) list = list.filter((p) => p.division === division);
    if (q) {
      list = list.filter(
        (p) =>
          p.id.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          (p.description || '').toLowerCase().includes(q) ||
          p.division.toLowerCase().includes(q),
      );
    }
    if (recRank.size || favSet.size) {
      const rank = (p: BbaritPersonaEntry) => {
        const rec = recRank.get(p.id);
        if (rec !== undefined) return rec;                 // 추천이 맨 앞 (지정 순서)
        return favSet.has(p.id) ? 1000 : 2000;             // 그다음 즐겨찾기 → 나머지
      };
      list = [...list].sort((a, b) => rank(a) - rank(b));
    }
    return list;
  }, [personas, query, division, favSet, recRank]);

  const detailEntry = useMemo(
    () => personas.find((p) => p.id === detailId),
    [personas, detailId],
  );
  const detailProfile = useMemo(
    () => (detailId ? buildBbaritPersonaProfile(detailEntry, detailId) : null),
    [detailEntry, detailId],
  );

  const openDetail = (id: string) => {
    setDetailId(id);
    setMdView(false);
    setMdContent('');
    setMdError('');
  };

  const showMd = async () => {
    if (!detailEntry?.path) return;
    setMdView(true);
    setMdError('');
    if (!mdContent) {
      try {
        setMdContent(await invoke<string>('read_file', { path: detailEntry.path }));
      } catch (err) {
        setMdError(String(err));
      }
    }
  };

  // Portal to <body> — callers live inside panels/panes that create their own
  // stacking contexts, which trapped the fixed overlay underneath sibling UI.
  return createPortal(
    <div className="bpp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bpp-modal" role="dialog" aria-modal="true" aria-label={title || 'Persona picker'}>
        <div className="bpp-header">
          <span className="bpp-title">{title || t('personaPicker.title' as any, 'Choose a persona')}</span>
          <div className="bpp-search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder={t('personaPicker.search' as any, 'Search personas…')}
            />
          </div>
          <button className="modal-close-btn" onClick={onClose} title={t('personaPicker.close' as any, 'Close')} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="bpp-body">
          <div className="bpp-divisions">
            <button
              className={`bpp-division ${division === '' ? 'active' : ''}`}
              onClick={() => setDivision('')}
            >
              {t('personaPicker.allDivisions' as any, 'All')} <span className="bpp-division-count">{personas.length}</span>
            </button>
            {divisions.map(([name, count]) => (
              <button
                key={name}
                className={`bpp-division ${division === name ? 'active' : ''}`}
                onClick={() => setDivision(division === name ? '' : name)}
              >
                {name} <span className="bpp-division-count">{count}</span>
              </button>
            ))}
          </div>

          <div className="bpp-grid" role="listbox" aria-label="Personas">
            <button
              className={`bpp-card bpp-card-none ${detailId === '' ? 'selected' : ''}`}
              onClick={() => openDetail('')}
              onDoubleClick={() => onSelect('')}
            >
              <span className="bpp-avatar bpp-avatar-emoji bpp-avatar-none"><Ban size={22} /></span>
              <span className="bpp-card-name">{t('personaPicker.none' as any, 'No persona')}</span>
              <span className="bpp-card-desc">{t('personaPicker.noneDesc' as any, 'Run the agent without a persona brief.')}</span>
            </button>
            {filtered.map((p) => {
              const profile = buildBbaritPersonaProfile(p);
              if (!profile) return null;
              return (
                <button
                  key={p.id}
                  className={`bpp-card ${detailId === p.id ? 'selected' : ''} ${selectedId === p.id ? 'current' : ''} ${recRank.has(p.id) ? 'recommended' : ''}`}
                  onClick={() => openDetail(p.id)}
                  onDoubleClick={() => onSelect(p.id)}
                  title={p.description || p.name}
                >
                  {recRank.has(p.id) && (
                    <span className="bpp-card-rec">{t('personaPicker.recommended' as any, '★ Recommended')}</span>
                  )}
                  {onToggleFavorite && (
                    <span
                      className={`bpp-card-fav ${favSet.has(p.id) ? 'faved' : ''}`}
                      onClick={(e) => { e.stopPropagation(); onToggleFavorite(p.id); }}
                      title={t('personaPicker.favorite' as any, 'Toggle favorite')}
                    >
                      <Star size={12} fill={favSet.has(p.id) ? 'currentColor' : 'none'} />
                    </span>
                  )}
                  <PersonaAvatar id={p.id} emoji={p.emoji} size={64} />
                  <span className="bpp-card-name">{p.emoji} {p.name}</span>
                  <span className="bpp-card-division">{p.division}</span>
                  <span className="bpp-card-desc">{p.description || profile.description}</span>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="bpp-empty">{t('personaPicker.empty' as any, 'No personas match your search.')}</div>
            )}
          </div>

          <div className="bpp-detail">
            {detailId === '' ? (
              <div className="bpp-detail-inner bpp-detail-none">
                <span className="bpp-avatar bpp-avatar-emoji bpp-avatar-none bpp-detail-avatar-emoji"><Ban size={40} /></span>
                <h3>{t('personaPicker.none' as any, 'No persona')}</h3>
                <p className="bpp-detail-desc">{t('personaPicker.noneDetail' as any, 'The agent runs with its default behavior and no persona brief.')}</p>
                <button className="bpp-use" onClick={() => onSelect('')}>
                  {t('personaPicker.useNone' as any, 'Use no persona')}
                </button>
              </div>
            ) : detailProfile ? (
              mdView ? (
                <div className="bpp-detail-inner bpp-md">
                  <div className="bpp-md-head">
                    <button className="bpp-md-back" onClick={() => setMdView(false)}>
                      <ArrowLeft size={13} /> {t('personaPicker.back' as any, 'Back')}
                    </button>
                    <span className="bpp-md-title">{detailProfile.name}.md</span>
                  </div>
                  <pre className="bpp-md-body">{mdError ? `⚠ ${mdError}` : (mdContent || t('personaPicker.loading' as any, 'Loading…'))}</pre>
                </div>
              ) : (
                <div className="bpp-detail-inner">
                  <div className="bpp-detail-avatar">
                    <PersonaAvatar id={detailProfile.id} emoji={detailProfile.face} size={128} />
                  </div>
                  <h3>{detailProfile.face} {detailProfile.name}</h3>
                  <span className="bpp-detail-job">{detailProfile.job}</span>
                  <span className="bpp-detail-division">{detailProfile.division}</span>
                  <p className="bpp-detail-desc">{detailEntry?.description || detailProfile.description}</p>
                  <div className="bpp-detail-actions">
                    <button className="bpp-use" onClick={() => onSelect(detailProfile.id)}>
                      {selectedId === detailProfile.id
                        ? t('personaPicker.inUse' as any, 'Currently selected')
                        : t('personaPicker.use' as any, 'Use this persona')}
                    </button>
                    {detailEntry?.path && (
                      <button className="bpp-view-md" onClick={() => { void showMd(); }}>
                        <FileText size={13} /> {t('personaPicker.viewMd' as any, 'View original .md')}
                      </button>
                    )}
                  </div>
                </div>
              )
            ) : (
              <div className="bpp-detail-inner bpp-detail-placeholder">
                {t('personaPicker.pick' as any, 'Pick a persona card to see details.')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
