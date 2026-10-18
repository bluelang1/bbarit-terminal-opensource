import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from '../i18n';
import { kvGet } from '../hooks/useKV';
import {
  fetchSlackMessages,
  sendSlackMessage,
  fetchGithubIssues,
  fetchGithubIssueComments,
  postGithubComment,
  fetchLinearIssues,
  postLinearComment,
} from './pm2Commands';

const openUrl = async (url: string) => {
  const u = String(url || '').trim();
  if (!u) return;
  try { await invoke('plugin:shell|open', { path: u }); } catch {
    try { window.open(u, '_blank', 'noopener,noreferrer'); } catch {}
  }
};

export interface HubActionItem {
  source: string;
  title: string;
  body: string;
  url?: string;
  group?: string;
}

interface Props {
  theme: { bg: string; text: string; border: string; accent: string };
  projectSlackChannelId?: string;
  projectGithubRepo?: string;
  /** Create a kanban task from a hub item; returns true when added */
  onAddToKanban?: (item: HubActionItem) => Promise<boolean>;
  /** Save a hub item as a vault note; returns the note path */
  onSaveAsNote?: (item: HubActionItem) => Promise<string | null>;
  /** Hand a hub item straight to the BBARIT agent terminal */
  onSendToAgent?: (item: HubActionItem) => void;
}

type Source = 'linear' | 'slack' | 'github';

interface HubItem {
  id: string;
  source: Source;
  title: string;
  body: string;
  url?: string;
  timestamp: number;
  meta?: Record<string, string>;
  group?: string;
  comments?: { user: string; body: string; timestamp: number }[];
}

const SOURCE_META: Record<Source, { label: string; color: string; abbr: string }> = {
  linear: { label: 'Linear', color: '#586eff', abbr: 'Li' },
  slack: { label: 'Slack', color: '#e01e5a', abbr: 'Sl' },
  github: { label: 'GitHub', color: '#8b949e', abbr: 'GH' },
};

const PAGE_SIZE = 8;

export const HubPanel: React.FC<Props> = ({ theme, projectSlackChannelId, projectGithubRepo, onAddToKanban, onSaveAsNote, onSendToAgent }) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<HubItem[]>([]);
  const [filter, setFilter] = useState<'all' | Source>('all');
  const [loading, setLoading] = useState(false);
  const [replyTarget, setReplyTarget] = useState<HubItem | null>(null);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedComments, setExpandedComments] = useState<Record<string, { user: string; body: string; timestamp: number }[]>>({});
  const [commentsLoading, setCommentsLoading] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const listRef = useRef<HTMLDivElement>(null);

  const projectSlackRef = useRef(projectSlackChannelId);
  projectSlackRef.current = projectSlackChannelId;
  const projectGithubRef = useRef(projectGithubRepo);
  projectGithubRef.current = projectGithubRepo;

  // Auto-register every fetched issue (GitHub/Linear — not Slack chatter) as a kanban task
  const [autoKanban, setAutoKanban] = useState(() => {
    try { return localStorage.getItem('octo-hub-auto-kanban') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('octo-hub-auto-kanban', autoKanban ? '1' : '0'); } catch { /* ignore */ }
  }, [autoKanban]);
  const autoKanbanRef = useRef(autoKanban);
  autoKanbanRef.current = autoKanban;
  const onAddToKanbanRef = useRef(onAddToKanban);
  onAddToKanbanRef.current = onAddToKanban;

  // Track hub items already pushed to kanban/notes this session
  const [pushedActions, setPushedActions] = useState<Record<string, boolean>>({});
  const markPushed = useCallback((itemId: string, kind: 'kanban' | 'note') => {
    setPushedActions(prev => ({ ...prev, [`${itemId}:${kind}`]: true }));
  }, []);
  const toActionItem = (item: HubItem): HubActionItem => ({
    source: item.source, title: item.title, body: cleanBody(item.body), url: item.url, group: item.group,
  });

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    const result: HubItem[] = [];
    const errors: string[] = [];

    const slackToken = await kvGet('octo-slack-bot-token');
    const slackChannel = projectSlackRef.current || await kvGet('octo-slack-channel-id');
    if (slackToken && slackChannel) {
      try {
        const msgs = await fetchSlackMessages(slackToken, slackChannel, 20);
        msgs.forEach((m: any, i: number) => {
          result.push({
            id: `slack-${m.ts || i}`,
            source: 'slack',
            title: m.user ? `@${m.user}` : '#channel',
            body: (m.text || '').slice(0, 300),
            timestamp: m.ts ? parseFloat(m.ts) * 1000 : Date.now(),
            meta: { channel: slackChannel, ts: m.ts },
            group: `#${slackChannel}`,
          });
        });
      } catch (e: any) { errors.push(`Slack: ${e?.message || t('hub.fetchFailed')}`); }
    }

    const ghToken = await kvGet('octo-github-token');
    const ghRepo = projectGithubRef.current || await kvGet('octo-github-repo');
    if (ghToken && ghRepo) {
      try {
        const issues = await fetchGithubIssues(ghToken, ghRepo, 20);
        issues.forEach((issue: any) => {
          result.push({
            id: `gh-${issue.id}`,
            source: 'github',
            title: `#${issue.number}: ${(issue.title || '').slice(0, 80)}`,
            body: (issue.body || '').slice(0, 500),
            url: issue.html_url,
            timestamp: new Date(issue.updated_at).getTime(),
            meta: { repo: ghRepo, issueNumber: String(issue.number), commentCount: String(issue.comments || 0) },
            group: ghRepo,
          });
        });
      } catch (e: any) { errors.push(`GitHub: ${e?.message || t('hub.fetchFailed')}`); }
    }

    const linearToken = await kvGet('octo-linear-api-token');
    if (linearToken) {
      try {
        const issues = await fetchLinearIssues(linearToken, 20);
        issues.forEach((issue: any) => {
          const teamName = issue.team?.name || issue.identifier?.split('-')[0] || '';
          result.push({
            id: `linear-${issue.id}`,
            source: 'linear',
            title: `${issue.identifier}: ${(issue.title || '').slice(0, 80)}`,
            body: (issue.description || '').slice(0, 500),
            url: issue.url,
            timestamp: new Date(issue.updatedAt).getTime(),
            meta: { issueId: issue.id },
            group: teamName ? `Team: ${teamName}` : undefined,
          });
        });
      } catch (e: any) { errors.push(`Linear: ${e?.message || t('hub.fetchFailed')}`); }
    }

    result.sort((a, b) => b.timestamp - a.timestamp);
    setItems(result);
    if (errors.length > 0) setError(errors.join(' | '));
    setLoading(false);

    // Auto-register every fetched issue as a kanban task (dedupe happens app-side).
    // Slack chatter is excluded — only GitHub/Linear issues are actionable.
    if (autoKanbanRef.current && onAddToKanbanRef.current) {
      for (const it of result) {
        if (it.source === 'slack') continue;
        void onAddToKanbanRef.current({
          source: it.source, title: it.title, body: it.body, url: it.url, group: it.group,
        }).then(ok => { if (ok) markPushed(it.id, 'kanban'); });
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchAll();
    timerRef.current = setInterval(fetchAll, 60000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchAll]);

  // Reset page when filter changes
  useEffect(() => { setPage(0); }, [filter]);

  // Refetch when project-specific settings change
  useEffect(() => { fetchAll(); }, [projectSlackChannelId, projectGithubRepo]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadComments = useCallback(async (item: HubItem) => {
    if (item.source !== 'github' || !item.meta?.repo || !item.meta?.issueNumber) return;
    const count = parseInt(item.meta.commentCount || '0');
    if (count === 0) return;
    setCommentsLoading(item.id);
    try {
      const token = await kvGet('octo-github-token') || '';
      const cmts = await fetchGithubIssueComments(token, item.meta.repo, parseInt(item.meta.issueNumber), 10);
      setExpandedComments(prev => ({
        ...prev,
        [item.id]: cmts.map((c: any) => ({ user: c.user?.login || 'unknown', body: (c.body || '').slice(0, 300), timestamp: new Date(c.created_at).getTime() })),
      }));
    } catch { /* ignore */ }
    setCommentsLoading(null);
  }, []);

  const toggleExpand = useCallback((item: HubItem) => {
    if (expandedId === item.id) {
      setExpandedId(null);
    } else {
      setExpandedId(item.id);
      if (!expandedComments[item.id] && item.source === 'github' && parseInt(item.meta?.commentCount || '0') > 0) {
        void loadComments(item);
      }
    }
  }, [expandedId, expandedComments, loadComments]);

  const handleReply = async () => {
    if (!replyTarget || !replyText.trim()) return;
    setSending(true);
    try {
      if (replyTarget.source === 'slack') {
        const token = await kvGet('octo-slack-bot-token') || '';
        const channel = replyTarget.meta?.channel || '';
        await sendSlackMessage(token, channel, replyText);
      } else if (replyTarget.source === 'github') {
        const token = await kvGet('octo-github-token') || '';
        const repo = replyTarget.meta?.repo || '';
        const num = parseInt(replyTarget.meta?.issueNumber || '0');
        if (num > 0) await postGithubComment(token, repo, num, replyText);
      } else if (replyTarget.source === 'linear') {
        const token = await kvGet('octo-linear-api-token') || '';
        const issueId = replyTarget.meta?.issueId || '';
        if (issueId) await postLinearComment(token, issueId, replyText);
      }
      setReplyTarget(null);
      setReplyText('');
      setTimeout(fetchAll, 1000);
    } catch (e: any) {
      setError(t('hub.replyFailed').replace('{error}', e?.message || t('hub.unknownError')));
    } finally {
      setSending(false);
    }
  };

  const filtered = useMemo(
    () => filter === 'all' ? items : items.filter(n => n.source === filter),
    [items, filter],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pagedItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const goPage = (p: number) => {
    setPage(p);
    listRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const formatTime = (ts: number) => {
    const diff = Date.now() - ts;
    if (diff < 60000) return t('hub.justNow');
    if (diff < 3600000) return t('hub.minutesAgo').replace('{n}', String(Math.floor(diff / 60000)));
    if (diff < 86400000) return t('hub.hoursAgo').replace('{n}', String(Math.floor(diff / 3600000)));
    const d = new Date(ts);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return `${month}/${day}`;
  };

  const cleanBody = (text: string) => {
    return text
      .replace(/!\[.*?\]\(.*?\)/g, '')   // remove images
      .replace(/\[([^\]]*)\]\(.*?\)/g, '$1') // links → text only
      .replace(/#{1,6}\s/g, '')           // headings
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1') // bold/italic
      .replace(/`([^`]+)`/g, '$1')        // inline code
      .replace(/\n+/g, ' ')              // newlines → space
      .trim();
  };

  const [hasAnyToken, setHasAnyToken] = useState(false);
  useEffect(() => {
    Promise.all([
      kvGet('octo-slack-bot-token'),
      kvGet('octo-github-token'),
      kvGet('octo-linear-api-token'),
    ]).then(([s, g, l]) => setHasAnyToken(!!(s || g || l))).catch(() => {});
  }, []);

  const sources: ('all' | Source)[] = ['all', 'linear', 'slack', 'github'];

  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    for (const item of items) counts[item.source] = (counts[item.source] || 0) + 1;
    return counts;
  }, [items]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: theme.bg, color: theme.text, overflow: 'hidden' }}>
      <style>{`
        .hub-card { transition: all 0.15s ease; border: 1px solid transparent; }
        .hub-card:hover { border-color: ${theme.border}60; background: ${theme.text}04; }
        .hub-card-actions { opacity: 0; transition: opacity 0.15s; }
        .hub-card:hover .hub-card-actions { opacity: 1; }
        .hub-btn { transition: all 0.12s ease; }
        .hub-btn:hover { opacity: 1 !important; }
        .hub-filter-btn { transition: all 0.15s ease; }
        .hub-filter-btn:hover { opacity: 1; }
        .hub-page-btn { transition: all 0.1s; }
        .hub-page-btn:hover:not(:disabled) { background: ${theme.accent}20 !important; color: ${theme.accent} !important; }
        .hub-page-btn:disabled { opacity: 0.3; cursor: default !important; }
      `}</style>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 24px', borderBottom: `1px solid ${theme.border}30`,
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: -0.3 }}>{t('hub.title')}</span>
        <span style={{
          fontSize: 10, padding: '1px 7px', borderRadius: 'var(--brutal-radius)', fontWeight: 600,
          background: `${theme.accent}15`, color: theme.accent,
        }}>
          {filtered.length}
        </span>
        <div style={{ display: 'flex', gap: 3, marginLeft: 'auto', background: `${theme.text}06`, borderRadius: 'var(--brutal-radius)', padding: 2 }}>
          {sources.map(s => {
            const active = filter === s;
            const label = s === 'all' ? t('hub.all') : SOURCE_META[s].label;
            const count = sourceCounts[s] || 0;
            return (
              <button
                key={s}
                className="hub-filter-btn"
                onClick={() => setFilter(s)}
                style={{
                  padding: '5px 12px', fontSize: 11, border: 'none',
                  borderRadius: 'var(--brutal-radius)',
                  background: active ? `${theme.accent}18` : 'transparent',
                  color: active ? theme.accent : `${theme.text}60`,
                  cursor: 'pointer', fontWeight: active ? 600 : 400,
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                {s !== 'all' && (
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%',
                    background: SOURCE_META[s].color, flexShrink: 0,
                    opacity: active ? 1 : 0.5,
                  }} />
                )}
                {label}
                {count > 0 && <span style={{ fontSize: 9, opacity: 0.5 }}>{count}</span>}
              </button>
            );
          })}
        </div>
        {onAddToKanban && (
          <button
            onClick={() => setAutoKanban(v => !v)}
            title="Automatically register every fetched GitHub/Linear issue as a kanban task"
            style={{
              padding: '5px 10px', fontSize: 11,
              border: `1px solid ${autoKanban ? theme.accent : theme.border}40`,
              borderRadius: 'var(--brutal-radius)',
              background: autoKanban ? `${theme.accent}15` : 'transparent',
              color: autoKanban ? theme.accent : `${theme.text}60`,
              cursor: 'pointer', fontWeight: autoKanban ? 600 : 400,
            }}
            className="hub-btn"
          >
            {autoKanban ? '✓ Auto → Kanban' : 'Auto → Kanban'}
          </button>
        )}
        <button
          onClick={fetchAll}
          disabled={loading}
          style={{
            padding: '5px 10px', fontSize: 11, border: `1px solid ${theme.border}30`,
            borderRadius: 'var(--brutal-radius)', background: 'transparent', color: `${theme.text}60`,
            cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.4 : 0.7,
          }}
          className="hub-btn"
        >
          {loading ? '...' : t('settings.common.refresh')}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          padding: '6px 24px', fontSize: 11, background: '#ef444418', color: '#ef4444',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={() => setError('')} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 11 }}>X</button>
        </div>
      )}

      {/* Items */}
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 16px' }}>
        {!hasAnyToken && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '100%', gap: 12, opacity: 0.35,
          }}>
            <span style={{ fontSize: 36, fontWeight: 700, letterSpacing: -1 }}>{t('hub.title')}</span>
            <span style={{ fontSize: 12 }}>{t('hub.settingsHint')}</span>
          </div>
        )}
        {filtered.length === 0 && hasAnyToken && !loading && (
          <div style={{ textAlign: 'center', padding: 60, opacity: 0.3, fontSize: 13 }}>{t('hub.noItems')}</div>
        )}

        {pagedItems.map(item => {
          const meta = SOURCE_META[item.source];
          const isExpanded = expandedId === item.id;
          const body = cleanBody(item.body);
          return (
            <div
              key={item.id}
              className="hub-card"
              onClick={() => toggleExpand(item)}
              style={{
                padding: '14px 18px', borderRadius: 'var(--brutal-radius)', marginBottom: 6,
                cursor: 'pointer', position: 'relative',
              }}
            >
              {/* Source + Title row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 28, borderRadius: 'var(--brutal-radius)', fontSize: 10, fontWeight: 700,
                  flexShrink: 0, color: '#fff', letterSpacing: -0.5,
                  background: meta.color,
                }}>
                  {meta.abbr}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontSize: 13, fontWeight: 600, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                    }}>
                      {item.title}
                    </span>
                    {item.group && (
                      <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 'var(--brutal-radius)', background: `${meta.color}18`, color: meta.color, fontWeight: 600, flexShrink: 0 }}>
                        {item.group}
                      </span>
                    )}
                    <span style={{ fontSize: 10, opacity: 0.3, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                      {formatTime(item.timestamp)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Body */}
              {body && (
                <div style={{
                  fontSize: 12, opacity: 0.5, marginLeft: 38, marginTop: 6, lineHeight: 1.6,
                  ...(isExpanded
                    ? { whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }
                    : {
                        overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
                        WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as any,
                      }
                  ),
                }}>
                  {body}
                </div>
              )}

              {/* Comments */}
              {isExpanded && commentsLoading === item.id && (
                <div style={{ marginLeft: 38, marginTop: 8, fontSize: 11, opacity: 0.4 }}>{t('hub.loadingComments')}</div>
              )}
              {isExpanded && expandedComments[item.id] && expandedComments[item.id].length > 0 && (
                <div style={{ marginLeft: 38, marginTop: 8, borderLeft: `2px solid ${theme.border}30`, paddingLeft: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, opacity: 0.4, marginBottom: 4 }}>{t('hub.comments').replace('{count}', String(expandedComments[item.id].length))}</div>
                  {expandedComments[item.id].map((c, ci) => (
                    <div key={ci} style={{ marginBottom: 6, fontSize: 11, lineHeight: 1.5 }}>
                      <span style={{ fontWeight: 600, opacity: 0.7 }}>@{c.user}</span>
                      <span style={{ opacity: 0.3, marginLeft: 6, fontSize: 9 }}>{formatTime(c.timestamp)}</span>
                      <div style={{ opacity: 0.5, marginTop: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{cleanBody(c.body)}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Actions (show on hover or expanded) */}
              <div
                className={isExpanded ? '' : 'hub-card-actions'}
                style={{
                  display: 'flex', gap: 6, marginLeft: 38, marginTop: 8,
                  ...(isExpanded ? { opacity: 1 } : {}),
                }}
              >
                <button
                  className="hub-btn"
                  onClick={e => { e.stopPropagation(); setReplyTarget(item); setReplyText(''); }}
                  style={{
                    padding: '4px 12px', fontSize: 10, fontWeight: 500,
                    border: `1px solid ${theme.border}30`, borderRadius: 'var(--brutal-radius)',
                    background: 'transparent', color: `${theme.text}70`, cursor: 'pointer',
                  }}
                >
                  {t('hub.reply')}
                </button>
                {item.url && (
                  <button
                    className="hub-btn"
                    onClick={e => { e.stopPropagation(); void openUrl(item.url!); }}
                    style={{
                      padding: '4px 12px', fontSize: 10, fontWeight: 500,
                      border: `1px solid ${theme.border}30`, borderRadius: 'var(--brutal-radius)',
                      background: 'transparent', color: `${theme.text}70`, cursor: 'pointer',
                    }}
                  >
                    {t('common.open')}
                  </button>
                )}
                {onSendToAgent && (
                  <button
                    className="hub-btn"
                    onClick={e => { e.stopPropagation(); onSendToAgent(toActionItem(item)); }}
                    title="Hand this item to the BBARIT agent terminal"
                    style={{
                      padding: '4px 12px', fontSize: 10, fontWeight: 600,
                      border: `1px solid ${theme.accent}40`, borderRadius: 'var(--brutal-radius)',
                      background: `${theme.accent}12`, color: theme.accent, cursor: 'pointer',
                    }}
                  >
                    → Agent
                  </button>
                )}
                {onAddToKanban && (() => {
                  const pushed = pushedActions[`${item.id}:kanban`];
                  return (
                    <button
                      className="hub-btn"
                      disabled={pushed}
                      onClick={e => {
                        e.stopPropagation();
                        if (pushed) return;
                        void onAddToKanban(toActionItem(item)).then(ok => { if (ok) markPushed(item.id, 'kanban'); });
                      }}
                      title="Create a kanban task from this item"
                      style={{
                        padding: '4px 12px', fontSize: 10, fontWeight: 500,
                        border: `1px solid ${pushed ? theme.accent : theme.border}30`, borderRadius: 'var(--brutal-radius)',
                        background: pushed ? `${theme.accent}12` : 'transparent',
                        color: pushed ? theme.accent : `${theme.text}70`,
                        cursor: pushed ? 'default' : 'pointer',
                      }}
                    >
                      {pushed ? '✓ Kanban' : '+ Kanban'}
                    </button>
                  );
                })()}
                {onSaveAsNote && (() => {
                  const pushed = pushedActions[`${item.id}:note`];
                  return (
                    <button
                      className="hub-btn"
                      disabled={pushed}
                      onClick={e => {
                        e.stopPropagation();
                        if (pushed) return;
                        void onSaveAsNote(toActionItem(item)).then(path => { if (path) markPushed(item.id, 'note'); });
                      }}
                      title="Save this item as a vault note"
                      style={{
                        padding: '4px 12px', fontSize: 10, fontWeight: 500,
                        border: `1px solid ${pushed ? theme.accent : theme.border}30`, borderRadius: 'var(--brutal-radius)',
                        background: pushed ? `${theme.accent}12` : 'transparent',
                        color: pushed ? theme.accent : `${theme.text}70`,
                        cursor: pushed ? 'default' : 'pointer',
                      }}
                    >
                      {pushed ? '✓ Note' : '+ Note'}
                    </button>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
          padding: '10px 24px', borderTop: `1px solid ${theme.border}20`,
        }}>
          <button
            className="hub-page-btn"
            disabled={page === 0}
            onClick={() => goPage(page - 1)}
            style={{
              padding: '4px 10px', fontSize: 11, border: 'none', borderRadius: 'var(--brutal-radius)',
              background: 'transparent', color: `${theme.text}60`, cursor: 'pointer',
            }}
          >
            {t('hub.prev')}
          </button>
          {Array.from({ length: totalPages }, (_, i) => (
            <button
              key={i}
              className="hub-page-btn"
              onClick={() => goPage(i)}
              style={{
                padding: '4px 8px', fontSize: 11, border: 'none', borderRadius: 'var(--brutal-radius)',
                minWidth: 28, cursor: 'pointer',
                background: page === i ? `${theme.accent}18` : 'transparent',
                color: page === i ? theme.accent : `${theme.text}50`,
                fontWeight: page === i ? 700 : 400,
              }}
            >
              {i + 1}
            </button>
          ))}
          <button
            className="hub-page-btn"
            disabled={page >= totalPages - 1}
            onClick={() => goPage(page + 1)}
            style={{
              padding: '4px 10px', fontSize: 11, border: 'none', borderRadius: 'var(--brutal-radius)',
              background: 'transparent', color: `${theme.text}60`, cursor: 'pointer',
            }}
          >
            {t('settings.common.next')}
          </button>
          <span style={{ fontSize: 10, opacity: 0.3, marginLeft: 8 }}>
            {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, filtered.length)} / {filtered.length}
          </span>
        </div>
      )}

      {/* Reply panel */}
      {replyTarget && (
        <div style={{ padding: '14px 24px', borderTop: `1px solid ${theme.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 20, height: 20, borderRadius: 'var(--brutal-radius)', fontSize: 8, fontWeight: 700,
              color: '#fff', background: SOURCE_META[replyTarget.source].color,
            }}>
              {SOURCE_META[replyTarget.source].abbr}
            </span>
            <span style={{ fontSize: 11, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {replyTarget.title}
            </span>
          </div>
          <textarea
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            placeholder={t('hub.replyPlaceholder')}
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleReply();
              if (e.key === 'Escape') setReplyTarget(null);
            }}
            style={{
              width: '100%', height: 60, background: `${theme.text}06`, color: theme.text,
              border: `1px solid ${theme.border}40`, borderRadius: 'var(--brutal-radius)', padding: '10px 12px',
              fontSize: 12, resize: 'none', fontFamily: 'inherit', outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button
              onClick={handleReply}
              disabled={sending || !replyText.trim()}
              style={{
                padding: '6px 16px', fontSize: 11, fontWeight: 600,
                border: 'none', borderRadius: 'var(--brutal-radius)', cursor: 'pointer',
                background: theme.accent, color: '#fff',
                opacity: sending || !replyText.trim() ? 0.4 : 1,
              }}
            >
              {sending ? t('hub.sending') : t('hub.send')}
            </button>
            <button
              onClick={() => setReplyTarget(null)}
              style={{
                padding: '6px 16px', fontSize: 11, border: `1px solid ${theme.border}30`,
                borderRadius: 'var(--brutal-radius)', background: 'transparent', color: `${theme.text}60`, cursor: 'pointer',
              }}
            >
              {t('common.cancel')}
            </button>
            <span style={{ fontSize: 10, opacity: 0.25, marginLeft: 'auto', alignSelf: 'center' }}>
              {t('hub.cmdEnterToSend')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
