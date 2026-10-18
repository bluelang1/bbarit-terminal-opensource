import { useState, useEffect, useCallback, useMemo } from 'react';
import { Trash2, Star } from 'lucide-react';
import { kvGet, kvSet } from '../hooks/useKV';
import { useTranslation } from '../i18n';

export interface PromptEntry {
  id: string;
  text: string;
  favorite: boolean;
  useCount: number;
  createdAt: string;
  updatedAt: string;
  projectPath?: string;
}

interface PromptLibraryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
  projectPath?: string;
}

const KV_KEY = 'octo-prompt-library';
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function savePromptToLibrary(text: string, projectPath?: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 3) return;
  try {
    const raw = await kvGet(KV_KEY);
    let entries: PromptEntry[] = raw ? JSON.parse(raw) : [];
    const existing = entries.find(e => e.text === trimmed);
    if (existing) {
      existing.useCount += 1;
      existing.updatedAt = new Date().toISOString();
    } else {
      entries.unshift({
        id: generateId(), text: trimmed, favorite: false, useCount: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), projectPath,
      });
    }
    if (entries.length > 100) {
      const favs = entries.filter(e => e.favorite);
      const rest = entries.filter(e => !e.favorite).slice(0, 100);
      entries = [...favs, ...rest];
    }
    await kvSet(KV_KEY, JSON.stringify(entries));
    window.dispatchEvent(new Event('prompt-library-updated'));
  } catch (e) {
    console.error('[PromptLibrary] save failed:', e);
  }
}

function getPathLabel(path?: string): string {
  if (!path) return '(unknown)';
  const normalized = path.trim().replace(/[\\/]+$/g, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized || path;
}

export function PromptLibraryPanel({ isOpen, onClose, onSend, projectPath }: PromptLibraryPanelProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<PromptEntry[]>([]);
  const [filterFav, setFilterFav] = useState(false);
  const [filterScope, setFilterScope] = useState<'project' | 'all'>('project');

  const border = 'rgba(255,255,255,0.12)';

  const loadEntries = useCallback(async () => {
    try {
      const raw = await kvGet(KV_KEY);
      setEntries(raw ? JSON.parse(raw) : []);
    } catch { setEntries([]); }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void loadEntries();
  }, [isOpen, loadEntries]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = () => loadEntries();
    window.addEventListener('prompt-library-updated', handler);
    return () => window.removeEventListener('prompt-library-updated', handler);
  }, [isOpen, loadEntries]);

  const persist = useCallback(async (next: PromptEntry[]) => {
    setEntries(next);
    await kvSet(KV_KEY, JSON.stringify(next));
  }, []);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await persist(entries.filter(en => en.id !== id));
  }, [entries, persist]);

  const handleToggleFav = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await persist(entries.map(en => en.id === id ? { ...en, favorite: !en.favorite } : en));
  }, [entries, persist]);

  const handleSend = useCallback(async (entry: PromptEntry) => {
    const next = entries.map(e => e.id === entry.id ? { ...e, useCount: e.useCount + 1, updatedAt: new Date().toISOString() } : e);
    await persist(next);
    onSend(entry.text);
  }, [entries, persist, onSend]);

  const filtered = useMemo(() => {
    let list = entries;
    if (filterScope === 'project' && projectPath) list = list.filter(e => e.projectPath === projectPath);
    if (filterFav) list = list.filter(e => e.favorite);
    const sorted = [...list];
    sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    sorted.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
    return sorted.slice(0, 100);
  }, [entries, filterFav, filterScope, projectPath]);

  if (!isOpen) return null;

  return (
    <div style={{
      width: 300, minWidth: 300, height: '100%',
      background: '#000', color: '#fff',
      borderLeft: `1px solid ${border}`,
      display: 'flex', flexDirection: 'column', flexShrink: 0,
    }}>
      <div style={{ padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 4, borderBottom: `1px solid ${border}`, flexShrink: 0 }}>
        <button
          onClick={onClose}
          title={t('common.close')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: '#fff', display: 'flex', flexShrink: 0, fontSize: 20, fontWeight: 700, lineHeight: 1 }}
        >
          ›
        </button>
        {projectPath && (
          <div style={{ display: 'flex', gap: 2, marginLeft: 4 }}>
            {(['project', 'all'] as const).map(scope => {
              const active = filterScope === scope;
              return (
                <button
                  key={scope}
                  onClick={() => setFilterScope(scope)}
                  style={{
                    background: active ? 'rgba(255,255,255,0.15)' : 'none',
                    border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 'var(--brutal-radius)',
                    color: active ? '#fff' : 'rgba(255,255,255,0.4)',
                    fontSize: 10, fontWeight: active ? 600 : 400,
                  }}
                >
                  {scope === 'project' ? getPathLabel(projectPath) : t('settings.common.all')}
                </button>
              );
            })}
          </div>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setFilterFav(v => !v)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: filterFav ? '#eab308' : '#fff', opacity: filterFav ? 1 : 0.35, display: 'flex', flexShrink: 0 }}
          title={t('promptLib.favoritesOnly')}
        >
          <Star size={12} fill={filterFav ? '#eab308' : 'none'} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '3px 5px' }}>
        {filtered.map(entry => (
          <div
            key={entry.id}
            style={{
              padding: '5px 6px', borderRadius: 'var(--brutal-radius)',
              background: entry.favorite ? 'rgba(234,179,8,0.08)' : 'rgba(255,255,255,0.03)',
              cursor: 'pointer', transition: 'background 0.04s',
              borderBottom: '1px solid rgba(255,255,255,0.07)',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = entry.favorite ? 'rgba(234,179,8,0.08)' : 'rgba(255,255,255,0.03)'; }}
            onClick={() => handleSend(entry)}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {filterScope === 'all' && entry.projectPath && entry.projectPath !== projectPath && (
                  <div style={{
                    fontSize: 9, color: 'rgba(255,255,255,0.35)', marginBottom: 2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {getPathLabel(entry.projectPath)}
                  </div>
                )}
                <div style={{
                  fontSize: 11, lineHeight: '1.4', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>
                  {entry.favorite && <Star size={9} fill="#eab308" color="#eab308" style={{ verticalAlign: 'middle', marginRight: 2 }} />}
                  {entry.text}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center', marginLeft: 6 }} onClick={e => e.stopPropagation()}>
                <button onClick={(e) => handleToggleFav(entry.id, e)} title={t('promptLib.favorite')} style={{ background: entry.favorite ? '#f0c040' : '#aaa', border: 'none', cursor: 'pointer', padding: '3px 4px', borderRadius: 'var(--brutal-radius)', color: '#fff', display: 'flex', alignItems: 'center' }}>
                  <Star size={11} fill={entry.favorite ? '#fff' : 'none'} />
                </button>
                <button onClick={(e) => handleDelete(entry.id, e)} title={t('common.delete')} style={{ background: '#ff6b6b', border: 'none', cursor: 'pointer', padding: '3px 4px', borderRadius: 'var(--brutal-radius)', color: '#fff', display: 'flex', alignItems: 'center' }}>
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
