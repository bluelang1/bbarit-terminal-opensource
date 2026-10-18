import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RefreshCw, X, Plus, ChevronDown, ChevronRight, Upload, Download, Tag, Archive } from 'lucide-react';
import './GitPanel.css';

/* ─── Types ─── */
interface GitFile { path: string; status: string; oldPath?: string; }
interface GitCommit { hash: string; shortHash: string; author: string; email: string; date: string; subject: string; body: string; }
interface GitBranchInfo { name: string; shortHash: string; upstream: string; isCurrent: boolean; isRemote: boolean; }
interface GitRemote { name: string; url: string; type: string; }
interface GitStash { ref: string; message: string; date: string; }
interface GitTag { name: string; hash: string; date: string; message: string; }

interface ProjectRepo {
  id: string;
  displayName: string;
  icon: string;
  workDir: string;
}

interface GitPanelProps {
  isOpen: boolean;
  onClose: () => void;
  currentStyle?: { bg: string; text: string; accent: string };
  workDir?: string;
  projects?: ProjectRepo[];
  activeProjectId?: string;
}

type TabId = 'changes' | 'history' | 'branches' | 'remotes' | 'stashes' | 'tags';

/* ─── Parsers ─── */
function parseStatus(raw: string): { staged: GitFile[]; unstaged: GitFile[]; untracked: GitFile[]; conflicted: GitFile[]; branch: string; ahead: number; behind: number } {
  const staged: GitFile[] = [], unstaged: GitFile[] = [], untracked: GitFile[] = [], conflicted: GitFile[] = [];
  let branch = '', ahead = 0, behind = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { ahead = parseInt(m[1]); behind = parseInt(m[2]); }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ');
      const xy = parts[1] || '';
      const path = line.startsWith('2 ') ? (line.split('\t')[1] || parts[parts.length - 1]) : parts[parts.length - 1];
      const cleanPath = path?.replace(/\t.*/, '') || '';
      if (xy[0] !== '.') staged.push({ path: cleanPath, status: xy[0] });
      if (xy[1] !== '.') unstaged.push({ path: cleanPath, status: xy[1] });
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ');
      conflicted.push({ path: parts[parts.length - 1], status: 'U' });
    } else if (line.startsWith('? ')) {
      untracked.push({ path: line.slice(2), status: '?' });
    }
  }
  return { staged, unstaged, untracked, conflicted, branch, ahead, behind };
}

function parseLog(raw: string): GitCommit[] {
  return raw.split('---GIT_LOG_SEP---').filter(s => s.trim()).map(block => {
    const lines = block.trim().split('\n');
    return {
      hash: lines[0] || '', shortHash: lines[1] || '', author: lines[2] || '',
      email: lines[3] || '', date: lines[4] || '', subject: lines[5] || '',
      body: lines.slice(6).join('\n').trim(),
    };
  }).filter(c => c.hash);
}

function parseBranches(raw: string): GitBranchInfo[] {
  return raw.split('\n').filter(s => s.trim()).map(line => {
    const [name, shortHash, upstream, head] = line.split('\t');
    const isRemote = (name || '').startsWith('origin/');
    return { name: name || '', shortHash: shortHash || '', upstream: upstream || '', isCurrent: head === '*', isRemote };
  });
}

function parseRemotes(raw: string): GitRemote[] {
  const out: GitRemote[] = [];
  for (const line of raw.split('\n').filter(s => s.trim())) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)/);
    if (m) out.push({ name: m[1], url: m[2], type: m[3] });
  }
  return out;
}

function parseStashes(raw: string): GitStash[] {
  return raw.split('\n').filter(s => s.trim()).map(line => {
    const [ref, message, date] = line.split('\t');
    return { ref: ref || '', message: message || '', date: date || '' };
  });
}

function parseTags(raw: string): GitTag[] {
  return raw.split('\n').filter(s => s.trim()).map(line => {
    const [name, hash, date, message] = line.split('\t');
    return { name: name || '', hash: hash || '', date: date || '', message: message || '' };
  });
}

function relativeTime(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/* ─── Component ─── */
export function GitPanel({ isOpen, onClose, currentStyle, workDir, projects, activeProjectId }: GitPanelProps) {
  const style = currentStyle || { bg: '#1e1e2e', text: '#cdd6f4', accent: '#89b4fa' };
  const [activeTab, setActiveTab] = useState<TabId>('changes');
  const [isRepo, setIsRepo] = useState(true);
  const [toast, setToast] = useState<{ msg: string; type: 'error' | 'success' } | null>(null);
  const [loading, setLoading] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showRepoDropdown, setShowRepoDropdown] = useState(false);
  const [gitProjects, setGitProjects] = useState<ProjectRepo[]>([]);

  // Changes
  const [staged, setStaged] = useState<GitFile[]>([]);
  const [unstaged, setUnstaged] = useState<GitFile[]>([]);
  const [untracked, setUntracked] = useState<GitFile[]>([]);
  const [conflicted, setConflicted] = useState<GitFile[]>([]);
  const [branch, setBranch] = useState('');
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState('');
  const [diffStaged, setDiffStaged] = useState(false);
  const [commitTitle, setCommitTitle] = useState('');
  const [commitDesc, setCommitDesc] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  // History
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<{ commit: GitCommit; stat: string; diff: string } | null>(null);
  const [historyGrep, setHistoryGrep] = useState('');

  // Branches
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [newBranchName, setNewBranchName] = useState('');

  // Remotes
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [remoteOutput, setRemoteOutput] = useState('');
  const [activityLog, setActivityLog] = useState<{ time: string; msg: string; type: 'info' | 'success' | 'error' }[]>([]);
  const addLog = useCallback((msg: string, type: 'info' | 'success' | 'error' = 'info') => {
    const time = new Date().toLocaleTimeString();
    setActivityLog(prev => [{ time, msg, type }, ...prev].slice(0, 20));
  }, []);
  const [rebasePull, setRebasePull] = useState(false);
  const [forcePush, setForcePush] = useState(false);

  // Stashes
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [stashMsg, setStashMsg] = useState('');

  // Tags
  const [tags, setTags] = useState<GitTag[]>([]);
  const [newTagName, setNewTagName] = useState('');
  const [newTagMsg, setNewTagMsg] = useState('');

  const showToast = useCallback((msg: string, type: 'error' | 'success') => {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), type === 'success' ? 3000 : 6000);
  }, []);

  // 선택된 프로젝트의 workDir 결정
  const selectedProject = useMemo(() => {
    const pid = selectedProjectId || activeProjectId;
    return gitProjects.find(p => p.id === pid) || gitProjects[0];
  }, [selectedProjectId, activeProjectId, gitProjects]);
  const repoDir = selectedProject?.workDir || workDir || '';

  // 패널 열릴 때 모든 프로젝트의 git 여부 스캔
  useEffect(() => {
    if (!isOpen || !projects?.length) return;
    (async () => {
      const results: ProjectRepo[] = [];
      for (const p of projects) {
        try {
          const isGit = await invoke<boolean>('git_is_repo', { repoDir: p.workDir });
          if (isGit) results.push(p);
        } catch { /* skip */ }
      }
      setGitProjects(results);
      if (!selectedProjectId && activeProjectId) setSelectedProjectId(activeProjectId);
    })();
  }, [isOpen, projects, activeProjectId, selectedProjectId]);

  // ── Refresh functions ──
  const refreshStatus = useCallback(async () => {
    if (!repoDir) return;
    try {
      const isGit = await invoke<boolean>('git_is_repo', { repoDir });
      setIsRepo(isGit);
      if (!isGit) return;
      const raw = await invoke<string>('git_status_full', { repoDir });
      const s = parseStatus(raw);
      setStaged(s.staged); setUnstaged(s.unstaged); setUntracked(s.untracked); setConflicted(s.conflicted);
      setBranch(s.branch); setAhead(s.ahead); setBehind(s.behind);
    } catch (e) { console.error('[GitPanel] status error:', e); }
  }, [repoDir]);

  const loadDiff = useCallback(async (path: string, isStagedFile: boolean) => {
    if (!repoDir) return;
    try {
      const raw = await invoke<string>('git_diff', { repoDir, path, staged: isStagedFile, commit: null });
      setDiffContent(raw);
      setDiffStaged(isStagedFile);
      setSelectedFile(path);
    } catch { setDiffContent(''); }
  }, [repoDir]);

  const refreshHistory = useCallback(async () => {
    if (!repoDir) return;
    try {
      const raw = await invoke<string>('git_log', { repoDir, maxCount: 100, skip: null, path: null, author: null, grep: historyGrep || null });
      setCommits(parseLog(raw));
    } catch (e) { console.error('[GitPanel] log error:', e); }
  }, [repoDir, historyGrep]);

  const refreshBranches = useCallback(async () => {
    if (!repoDir) return;
    try {
      const raw = await invoke<string>('git_branch_list', { repoDir });
      setBranches(parseBranches(raw));
    } catch (e) { console.error('[GitPanel] branches error:', e); }
  }, [repoDir]);

  const refreshRemotes = useCallback(async () => {
    if (!repoDir) return;
    try {
      const raw = await invoke<string>('git_remote_list', { repoDir });
      setRemotes(parseRemotes(raw));
    } catch (e) { console.error('[GitPanel] remotes error:', e); }
  }, [repoDir]);

  const refreshStashes = useCallback(async () => {
    if (!repoDir) return;
    try {
      const raw = await invoke<string>('git_stash_list', { repoDir });
      setStashes(parseStashes(raw));
    } catch (e) { console.error('[GitPanel] stash error:', e); }
  }, [repoDir]);

  const refreshTags = useCallback(async () => {
    if (!repoDir) return;
    try {
      const raw = await invoke<string>('git_tag_list', { repoDir });
      setTags(parseTags(raw));
    } catch (e) { console.error('[GitPanel] tags error:', e); }
  }, [repoDir]);

  const refreshTab = useCallback(async (tab: TabId) => {
    setLoading(true);
    try {
      await refreshStatus();
      if (tab === 'history') await refreshHistory();
      else if (tab === 'branches') await refreshBranches();
      else if (tab === 'remotes') await refreshRemotes();
      else if (tab === 'stashes') await refreshStashes();
      else if (tab === 'tags') await refreshTags();
    } finally { setLoading(false); }
  }, [refreshStatus, refreshHistory, refreshBranches, refreshRemotes, refreshStashes, refreshTags]);

  // ── Mount & Auto-refresh ──
  useEffect(() => {
    if (!isOpen || !repoDir) return;
    refreshTab(activeTab);
    const iv = setInterval(() => refreshStatus(), 5000);
    const onFocus = () => { if (document.visibilityState === 'visible') refreshTab(activeTab); };
    document.addEventListener('visibilitychange', onFocus);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onFocus); };
  }, [isOpen, repoDir, activeTab, refreshTab, refreshStatus]);

  // ── Actions ──
  const handleStage = useCallback(async (paths: string[]) => {
    try { await invoke('git_add', { repoDir, paths }); await refreshStatus(); addLog(`Stage: ${paths.length} file(s)`, 'success'); showToast('Staged', 'success'); } catch (e: any) { addLog(`Stage failed: ${e}`, 'error'); showToast(e, 'error'); }
  }, [repoDir, refreshStatus, showToast]);

  const handleUnstage = useCallback(async (paths: string[]) => {
    try { await invoke('git_restore', { repoDir, paths, staged: true }); await refreshStatus(); } catch (e: any) { showToast(e, 'error'); }
  }, [repoDir, refreshStatus, showToast]);

  const handleDiscard = useCallback(async (paths: string[]) => {
    if (!confirm(`Discard changes to ${paths.join(', ')}?`)) return;
    try { await invoke('git_restore', { repoDir, paths, staged: false }); await refreshStatus(); showToast('Changes discarded', 'success'); } catch (e: any) { showToast(e, 'error'); }
  }, [repoDir, refreshStatus, showToast]);

  const [commitResult, setCommitResult] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const handleCommit = useCallback(async () => {
    if (!commitTitle.trim()) return;
    setIsCommitting(true);
    setCommitResult(null);
    addLog(`Commit started: ${commitTitle.trim()}`, 'info');
    try {
      const msg = commitDesc.trim() ? `${commitTitle.trim()}\n\n${commitDesc.trim()}` : commitTitle.trim();
      const result = await invoke<string>('git_commit_changes', { repoDir, message: msg, amend: false });
      setCommitTitle(''); setCommitDesc('');
      await refreshStatus();
      setCommitResult({ type: 'success', msg: `Committed: ${commitTitle.trim()}\n${result || ''}` });
      addLog(`Commit done: ${commitTitle.trim()}`, 'success');
      showToast('Committed', 'success');
    } catch (e: any) {
      setCommitResult({ type: 'error', msg: String(e) });
      addLog(`Commit failed: ${e}`, 'error');
      showToast(String(e), 'error');
    }
    finally { setIsCommitting(false); }
  }, [repoDir, commitTitle, commitDesc, refreshStatus, showToast]);

  const handleCheckout = useCallback(async (target: string) => {
    try {
      await invoke<string>('git_checkout', { repoDir, target });
      await refreshStatus(); await refreshBranches();
      showToast(`Switched branch: ${target}`, 'success');
    } catch (e: any) { showToast(String(e), 'error'); }
  }, [repoDir, refreshStatus, refreshBranches, showToast]);

  const handleCreateBranch = useCallback(async () => {
    if (!newBranchName.trim()) return;
    try {
      await invoke<string>('git_branch_create', { repoDir, name: newBranchName.trim(), startPoint: null });
      setNewBranchName('');
      await refreshStatus(); await refreshBranches();
      showToast(`Branch created: ${newBranchName.trim()}`, 'success');
    } catch (e: any) { showToast(String(e), 'error'); }
  }, [repoDir, newBranchName, refreshStatus, refreshBranches, showToast]);

  const handleMerge = useCallback(async (branchName: string) => {
    try {
      await invoke<string>('git_merge_branch', { repoDir, branchName });
      await refreshStatus(); await refreshBranches();
      showToast(`Merged: ${branchName}`, 'success');
    } catch (e: any) { showToast(String(e), 'error'); }
  }, [repoDir, refreshStatus, refreshBranches, showToast]);

  const handleDeleteBranch = useCallback(async (name: string) => {
    if (!confirm(`Delete branch "${name}"?`)) return;
    try {
      await invoke<string>('git_delete_branch', { repoDir, branchName: name });
      await refreshBranches();
      showToast(`Branch deleted: ${name}`, 'success');
    } catch (e: any) { showToast(String(e), 'error'); }
  }, [repoDir, refreshBranches, showToast]);

  const handleFetch = useCallback(async () => {
    addLog('Fetch started...', 'info');
    setRemoteOutput('Fetching...');
    try {
      const r = await invoke<string>('git_fetch', { repoDir, remote: null, prune: true });
      setRemoteOutput(r || 'Fetch done'); await refreshStatus();
      addLog(`Fetch done: ${r || 'OK'}`, 'success');
      showToast('Fetch done', 'success');
    } catch (e: any) { setRemoteOutput(String(e)); addLog(`Fetch failed: ${e}`, 'error'); showToast(String(e), 'error'); }
  }, [repoDir, refreshStatus, showToast, addLog]);

  const handlePull = useCallback(async () => {
    addLog('Pull started...', 'info');
    setRemoteOutput('Pulling...');
    try {
      const r = await invoke<string>('git_pull', { repoDir, remote: null, branch: null, rebase: rebasePull });
      setRemoteOutput(r || 'Pull done'); await refreshStatus();
      addLog(`Pull done: ${r || 'OK'}`, 'success');
      showToast('Pull done', 'success');
    } catch (e: any) { setRemoteOutput(String(e)); addLog(`Pull failed: ${e}`, 'error'); showToast(String(e), 'error'); }
  }, [repoDir, rebasePull, refreshStatus, showToast, addLog]);

  const handlePush = useCallback(async () => {
    addLog('Push started...', 'info');
    setRemoteOutput('Pushing...');
    try {
      const r = await invoke<string>('git_push', { repoDir, remote: null, branch: null, force: forcePush, setUpstream: true });
      setRemoteOutput(r || 'Push done'); await refreshStatus();
      addLog(`Push done: ${r || 'OK'}`, 'success');
      showToast('Push done', 'success');
    } catch (e: any) { setRemoteOutput(String(e)); addLog(`Push failed: ${e}`, 'error'); showToast(String(e), 'error'); }
  }, [repoDir, forcePush, refreshStatus, showToast, addLog]);

  const handleStashSave = useCallback(async () => {
    try {
      await invoke('git_stash_save', { repoDir, message: stashMsg || 'Stash' });
      setStashMsg(''); await refreshStatus(); await refreshStashes();
      showToast('Stash saved', 'success');
    } catch (e: any) { showToast(String(e), 'error'); }
  }, [repoDir, stashMsg, refreshStatus, refreshStashes, showToast]);

  const handleStashPop = useCallback(async () => {
    try {
      await invoke('git_stash_pop', { repoDir });
      await refreshStatus(); await refreshStashes();
      showToast('Stash popped', 'success');
    } catch (e: any) { showToast(String(e), 'error'); }
  }, [repoDir, refreshStatus, refreshStashes, showToast]);

  const handleStashDrop = useCallback(async (ref: string) => {
    if (!confirm(`Delete stash "${ref}"?`)) return;
    try {
      await invoke<string>('git_stash_drop', { repoDir, stashRef: ref });
      await refreshStashes();
      showToast('Stash deleted', 'success');
    } catch (e: any) { showToast(String(e), 'error'); }
  }, [repoDir, refreshStashes, showToast]);

  const handleCreateTag = useCallback(async () => {
    if (!newTagName.trim()) return;
    try {
      await invoke<string>('git_tag_create', { repoDir, name: newTagName.trim(), message: newTagMsg || null, commit: null });
      setNewTagName(''); setNewTagMsg('');
      await refreshTags();
      showToast(`Tag created: ${newTagName.trim()}`, 'success');
    } catch (e: any) { showToast(String(e), 'error'); }
  }, [repoDir, newTagName, newTagMsg, refreshTags, showToast]);

  const handleDeleteTag = useCallback(async (name: string) => {
    if (!confirm(`Delete tag "${name}"?`)) return;
    try {
      await invoke('git_tag_delete', { repoDir, name });
      await refreshTags();
      showToast(`Tag deleted: ${name}`, 'success');
    } catch (e: any) { showToast(String(e), 'error'); }
  }, [repoDir, refreshTags, showToast]);

  const handleSelectCommit = useCallback(async (hash: string) => {
    setSelectedCommit(hash);
    try {
      const raw = await invoke<string>('git_show', { repoDir, commit: hash });
      const parts = raw.split('---GIT_SHOW_BODY---');
      const header = parts[0]?.trim().split('\n') || [];
      const stat = parts[1]?.trim() || '';
      const commit: GitCommit = {
        hash: header[0] || '', shortHash: header[1] || '', author: header[2] || '',
        email: header[3] || '', date: header[4] || '', subject: header[5] || '',
        body: header.slice(6).join('\n').trim(),
      };
      const diff = await invoke<string>('git_diff', { repoDir, path: null, staged: false, commit: hash });
      setCommitDetail({ commit, stat, diff });
    } catch { setCommitDetail(null); }
  }, [repoDir]);

  const handleInitRepo = useCallback(async () => {
    if (!repoDir) return;
    try {
      await invoke<string>('git_init_repo', { repoDir });
      await refreshStatus();
      showToast('Git repository initialized', 'success');
    } catch (e: any) { showToast(String(e), 'error'); }
  }, [repoDir, refreshStatus, showToast]);

  // ── Section toggle ──
  const toggleSection = (key: string) => setCollapsedSections(p => ({ ...p, [key]: !p[key] }));

  // ── Tabs ──
  const tabs: { id: TabId; label: string }[] = [
    { id: 'changes', label: 'Changes' }, { id: 'history', label: 'History' },
    { id: 'branches', label: 'Branches' }, { id: 'remotes', label: 'Remotes' },
    { id: 'stashes', label: 'Stashes' }, { id: 'tags', label: 'Tags' },
  ];

  const localBranches = useMemo(() => branches.filter(b => !b.isRemote), [branches]);
  const remoteBranches = useMemo(() => branches.filter(b => b.isRemote), [branches]);

  // ── Diff renderer ──
  const renderDiff = (content: string) => {
    if (!content) return <div className="git-diff-empty">Select a file</div>;
    const lines = content.split('\n');
    return (
      <pre className="git-diff-content">
        {lines.map((line, i) => {
          let cls = '';
          if (line.startsWith('+') && !line.startsWith('+++')) cls = 'added';
          else if (line.startsWith('-') && !line.startsWith('---')) cls = 'removed';
          else if (line.startsWith('@@')) cls = 'hunk';
          return <div key={i} className={`git-diff-line ${cls}`}>{line}</div>;
        })}
      </pre>
    );
  };

  // ── File section renderer ──
  const renderFileSection = (title: string, files: GitFile[], key: string, actions?: React.ReactNode) => {
    if (files.length === 0) return null;
    const collapsed = collapsedSections[key];
    return (
      <div key={key}>
        <div className="git-file-section-header" onClick={() => toggleSection(key)}>
          {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
          {title} <span className="count">{files.length}</span>
          {actions && <div className="git-file-section-actions" onClick={e => e.stopPropagation()}>{actions}</div>}
        </div>
        {!collapsed && files.map(f => (
          <div key={f.path} className={`git-file-item ${selectedFile === f.path ? 'selected' : ''}`}
            onClick={() => loadDiff(f.path, key === 'staged')}>
            <span className={`git-file-status ${f.status}`}>{f.status}</span>
            <span className="git-file-path" title={f.path}>{f.path}</span>
            <div className="git-file-actions">
              {key === 'staged' && <button title="Unstage" onClick={e => { e.stopPropagation(); handleUnstage([f.path]); }}>−</button>}
              {(key === 'unstaged' || key === 'untracked') && <button title="Stage" onClick={e => { e.stopPropagation(); handleStage([f.path]); }}>+</button>}
              {key === 'unstaged' && <button title="Discard changes" onClick={e => { e.stopPropagation(); handleDiscard([f.path]); }}>✕</button>}
            </div>
          </div>
        ))}
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="git-panel-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="git-panel" onMouseDown={e => e.stopPropagation()}
        style={{ '--git-bg': style.bg, '--git-text': style.text, '--git-accent': style.accent } as React.CSSProperties}>

        {/* Header */}
        <div className="git-panel-header">
          <svg width="16" height="16" viewBox="0 0 92 92" fill="currentColor" style={{ flexShrink: 0, color: '#f05033' }}>
            <path d="M90.156 41.965 50.036 1.848a5.913 5.913 0 0 0-8.368 0l-8.332 8.332 10.566 10.566a7.03 7.03 0 0 1 7.23 1.684 7.043 7.043 0 0 1 1.673 7.277l10.183 10.184a7.026 7.026 0 0 1 7.278 1.672 7.04 7.04 0 0 1 0 9.957 7.045 7.045 0 0 1-9.961 0 7.06 7.06 0 0 1-1.532-7.66l-9.5-9.497V59.36a7.04 7.04 0 0 1 1.86 11.29 7.04 7.04 0 0 1-9.957 0 7.04 7.04 0 0 1 0-9.958 7.034 7.034 0 0 1 2.308-1.539V33.926a7.001 7.001 0 0 1-2.308-1.535 7.049 7.049 0 0 1-1.516-7.7L29.242 14.273 1.734 41.777a5.918 5.918 0 0 0 0 8.371L41.855 90.27a5.92 5.92 0 0 0 8.368 0l39.933-39.934a5.925 5.925 0 0 0 0-8.371"/>
          </svg>
          <h3>Git</h3>
          {/* 저장소 선택기 */}
          {gitProjects.length > 1 && (
            <div style={{ position: 'relative' }}>
              <button className="git-repo-selector" onClick={() => setShowRepoDropdown(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(128,128,128,0.15)', border: 'none', borderRadius: 'var(--brutal-radius)', padding: '3px 8px', color: 'inherit', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                {selectedProject?.icon} {selectedProject?.displayName || 'Select'}
                <ChevronDown size={10} />
              </button>
              {showRepoDropdown && (
                <div className="git-repo-dropdown" style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 10,
                  background: style.bg, border: '1px solid rgba(128,128,128,0.2)', borderRadius: 'var(--brutal-radius)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.4)', minWidth: 180, padding: 4,
                }}>
                  {gitProjects.map(p => (
                    <div key={p.id} onClick={() => { setSelectedProjectId(p.id); setShowRepoDropdown(false); setSelectedFile(null); setDiffContent(''); setSelectedCommit(null); setCommitDetail(null); }}
                      style={{
                        padding: '5px 8px', borderRadius: 'var(--brutal-radius)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6,
                        background: p.id === selectedProject?.id ? 'rgba(128,128,128,0.15)' : 'transparent',
                        fontWeight: p.id === selectedProject?.id ? 600 : 400,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(128,128,128,0.12)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = p.id === selectedProject?.id ? 'rgba(128,128,128,0.15)' : 'transparent'; }}>
                      {p.icon} {p.displayName}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {gitProjects.length <= 1 && selectedProject && (
            <span style={{ fontSize: 11, opacity: 0.5 }}>{selectedProject.icon} {selectedProject.displayName}</span>
          )}
          {isRepo && <>
            <span className="git-branch-badge">{branch || 'HEAD'}</span>
            {(ahead > 0 || behind > 0) && <span className="git-ahead-behind">↑{ahead} ↓{behind}</span>}
          </>}
          <div style={{ flex: 1 }} />
          {loading && <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />}
          <button onClick={() => refreshTab(activeTab)} title="Refresh"><RefreshCw size={14} /></button>
          <button className="modal-close-btn" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </div>

        {/* Toast */}
        {toast && <div className={`git-toast ${toast.type}`}>{toast.msg}</div>}

        {!isRepo ? (
          <div className="git-not-repo">
            <div>This directory is not a Git repository</div>
            <button onClick={handleInitRepo}>Git Init</button>
          </div>
        ) : (
          <>
            {/* Quick Actions Bar — GitHub Desktop style */}
            <div className="git-quick-actions">
              <div className="git-quick-section" onClick={() => { setActiveTab('changes'); refreshTab('changes'); }} style={{ cursor: 'pointer' }}>
                <div className="git-quick-label">Changes</div>
                <div className="git-quick-value">{staged.length + unstaged.length + untracked.length + conflicted.length}</div>
              </div>
              <div className="git-quick-divider" />
              <div className="git-quick-section" onClick={() => { setActiveTab('branches'); refreshTab('branches'); }} style={{ cursor: 'pointer' }}>
                <div className="git-quick-label">Current branch</div>
                <div className="git-quick-value">{branch || 'HEAD'}</div>
              </div>
              <div className="git-quick-divider" />
              <div className="git-quick-section">
                <div className="git-quick-label">Sync</div>
                <div className="git-quick-btns">
                  <button className="git-quick-btn" onClick={handleFetch} title="Fetch"><Download size={11} /> Fetch</button>
                  <button className="git-quick-btn" onClick={handlePull} title="Pull"><Download size={11} /> Pull{behind > 0 && ` (${behind})`}</button>
                  <button className="git-quick-btn primary" onClick={handlePush} title="Push"><Upload size={11} /> Push{ahead > 0 && ` (${ahead})`}</button>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="git-panel-tabs">
              {tabs.map(t => (
                <button key={t.id} className={`git-panel-tab ${activeTab === t.id ? 'active' : ''}`}
                  onClick={() => { setActiveTab(t.id); refreshTab(t.id); }}>
                  {t.label}
                  {t.id === 'changes' && (staged.length + unstaged.length + untracked.length + conflicted.length > 0) &&
                    <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.5 }}>({staged.length + unstaged.length + untracked.length + conflicted.length})</span>}
                </button>
              ))}
            </div>

            {/* Body */}
            <div className="git-panel-body">

              {/* ── Changes Tab ── */}
              {activeTab === 'changes' && (
                <div className="git-changes-layout">
                  <div className="git-changes-sidebar">
                    <div className="git-file-sections">
                      {renderFileSection('Staged', staged, 'staged',
                        staged.length > 0 ? <button onClick={() => handleUnstage(staged.map(f => f.path))}>Unstage all</button> : undefined)}
                      {renderFileSection('Conflicts', conflicted, 'conflicted')}
                      {renderFileSection('Changes', unstaged, 'unstaged',
                        unstaged.length > 0 ? <button onClick={() => handleStage(unstaged.map(f => f.path))}>Stage all</button> : undefined)}
                      {renderFileSection('Untracked', untracked, 'untracked',
                        untracked.length > 0 ? <button onClick={() => handleStage(untracked.map(f => f.path))}>Stage all</button> : undefined)}
                      {staged.length + unstaged.length + untracked.length + conflicted.length === 0 &&
                        <div style={{ padding: 20, textAlign: 'center', opacity: 0.3, fontSize: 12 }}>No changes</div>}
                    </div>
                    <div className="git-commit-form">
                      <input placeholder="Commit message" value={commitTitle} onChange={e => setCommitTitle(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCommit(); }} />
                      <textarea placeholder="Description (optional)" rows={2} value={commitDesc} onChange={e => setCommitDesc(e.target.value)} />
                      <button className="git-commit-btn" disabled={!commitTitle.trim() || staged.length === 0 || isCommitting}
                        onClick={handleCommit}>
                        {isCommitting ? '⏳ Committing...' : `Commit to ${branch}`}
                      </button>
                      {commitResult && (
                        <div className={`git-commit-result ${commitResult.type}`} onClick={() => setCommitResult(null)}>
                          {commitResult.type === 'success' ? '✅ ' : '❌ '}{commitResult.msg}
                        </div>
                      )}
                      {activityLog.length > 0 && (
                        <div className="git-activity-log">
                          {activityLog.map((log, i) => (
                            <div key={i} className={`git-log-entry ${log.type}`}>
                              <span className="git-log-time">{log.time}</span>
                              <span>{log.msg}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="git-diff-viewer">
                    {selectedFile && <div className="git-diff-header">{selectedFile} {diffStaged && <span style={{ opacity: 0.4 }}>(staged)</span>}</div>}
                    {renderDiff(diffContent)}
                  </div>
                </div>
              )}

              {/* ── History Tab ── */}
              {activeTab === 'history' && (
                <div className="git-history-layout">
                  <div className="git-history-list">
                    <div className="git-history-search">
                      <input placeholder="Search messages..." value={historyGrep}
                        onChange={e => setHistoryGrep(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') refreshHistory(); }} />
                    </div>
                    <div className="git-history-items">
                      {commits.map(c => (
                        <div key={c.hash} className={`git-commit-item ${selectedCommit === c.hash ? 'selected' : ''}`}
                          onClick={() => handleSelectCommit(c.hash)}>
                          <div className="git-commit-subject">
                            <span className="git-commit-hash">{c.shortHash}</span>
                            {c.subject}
                          </div>
                          <div className="git-commit-meta">{c.author} · {relativeTime(c.date)}</div>
                        </div>
                      ))}
                      {commits.length === 0 && <div style={{ padding: 20, textAlign: 'center', opacity: 0.3, fontSize: 12 }}>No commits</div>}
                    </div>
                  </div>
                  <div className="git-commit-detail">
                    {commitDetail ? (
                      <>
                        <div className="git-commit-detail-header">
                          <h4>{commitDetail.commit.subject}</h4>
                          <div className="git-commit-detail-info">
                            {commitDetail.commit.author} &lt;{commitDetail.commit.email}&gt; · {commitDetail.commit.date}
                            <br />
                            <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{commitDetail.commit.hash}</span>
                          </div>
                        </div>
                        {commitDetail.commit.body && <div className="git-commit-detail-body">{commitDetail.commit.body}</div>}
                        {commitDetail.stat && <div className="git-remote-output">{commitDetail.stat}</div>}
                        <div className="git-diff-viewer" style={{ flex: 'none', maxHeight: 400 }}>{renderDiff(commitDetail.diff)}</div>
                      </>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', opacity: 0.3 }}>
                        Select a commit
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── Branches Tab ── */}
              {activeTab === 'branches' && (
                <div className="git-list-view">
                  <div className="git-list-create">
                    <input placeholder="New branch name" value={newBranchName} onChange={e => setNewBranchName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleCreateBranch(); }} />
                    <button onClick={handleCreateBranch}><Plus size={12} /> Create</button>
                  </div>
                  <div className="git-section-title">Local branches</div>
                  {localBranches.map(b => (
                    <div key={b.name} className={`git-list-item ${b.isCurrent ? 'current' : ''}`}>
                      <span className="git-list-item-name">{b.isCurrent && '● '}{b.name}</span>
                      <span className="git-list-item-meta">{b.shortHash}{b.upstream && ` → ${b.upstream}`}</span>
                      <div className="git-list-item-actions">
                        {!b.isCurrent && <>
                          <button onClick={() => handleCheckout(b.name)}>Switch</button>
                          <button onClick={() => handleMerge(b.name)}>Merge</button>
                          <button className="danger" onClick={() => handleDeleteBranch(b.name)}>Delete</button>
                        </>}
                      </div>
                    </div>
                  ))}
                  {remoteBranches.length > 0 && <>
                    <div className="git-section-title">Remote branches</div>
                    {remoteBranches.map(b => (
                      <div key={b.name} className="git-list-item">
                        <span className="git-list-item-name">{b.name}</span>
                        <span className="git-list-item-meta">{b.shortHash}</span>
                        <div className="git-list-item-actions">
                          <button onClick={() => handleCheckout(b.name.replace(/^origin\//, ''))}>Checkout</button>
                        </div>
                      </div>
                    ))}
                  </>}
                </div>
              )}

              {/* ── Remotes Tab ── */}
              {activeTab === 'remotes' && (
                <div className="git-list-view">
                  <div className="git-remote-actions">
                    <button className="git-list-btn secondary" onClick={handleFetch}><Download size={11} /> Fetch</button>
                    <button className="git-list-btn secondary" onClick={handlePull}><Download size={11} /> Pull</button>
                    <button className="git-list-btn" onClick={handlePush}><Upload size={11} /> Push</button>
                    <label><input type="checkbox" checked={rebasePull} onChange={e => setRebasePull(e.target.checked)} /> Rebase</label>
                    <label><input type="checkbox" checked={forcePush} onChange={e => setForcePush(e.target.checked)} /> Force</label>
                  </div>
                  {remoteOutput && <div className="git-remote-output">{remoteOutput}</div>}
                  <div className="git-section-title">Remotes</div>
                  {remotes.map((r, i) => (
                    <div key={`${r.name}-${r.type}-${i}`} className="git-list-item">
                      <span className="git-list-item-name">{r.name}</span>
                      <span className="git-list-item-meta">{r.url} ({r.type})</span>
                    </div>
                  ))}
                  {remotes.length === 0 && <div style={{ padding: 20, textAlign: 'center', opacity: 0.3, fontSize: 12 }}>No remotes</div>}
                </div>
              )}

              {/* ── Stashes Tab ── */}
              {activeTab === 'stashes' && (
                <div className="git-list-view">
                  <div className="git-list-create">
                    <input placeholder="Stash message" value={stashMsg} onChange={e => setStashMsg(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleStashSave(); }} />
                    <button onClick={handleStashSave}><Archive size={11} /> Save</button>
                  </div>
                  {stashes.map(s => (
                    <div key={s.ref} className="git-list-item">
                      <span className="git-list-item-name">{s.ref}: {s.message}</span>
                      <span className="git-list-item-meta">{relativeTime(s.date)}</span>
                      <div className="git-list-item-actions">
                        <button onClick={handleStashPop}>Pop</button>
                        <button className="danger" onClick={() => handleStashDrop(s.ref)}>Drop</button>
                      </div>
                    </div>
                  ))}
                  {stashes.length === 0 && <div style={{ padding: 20, textAlign: 'center', opacity: 0.3, fontSize: 12 }}>No stashes</div>}
                </div>
              )}

              {/* ── Tags Tab ── */}
              {activeTab === 'tags' && (
                <div className="git-list-view">
                  <div className="git-list-create">
                    <input placeholder="Tag name" value={newTagName} onChange={e => setNewTagName(e.target.value)} />
                    <input placeholder="Message (optional, annotated)" value={newTagMsg} onChange={e => setNewTagMsg(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleCreateTag(); }} />
                    <button onClick={handleCreateTag}><Tag size={11} /> Create</button>
                  </div>
                  {tags.map(t => (
                    <div key={t.name} className="git-list-item">
                      <span className="git-list-item-name"><Tag size={10} style={{ marginRight: 4 }} />{t.name}</span>
                      <span className="git-list-item-meta">{t.hash} · {t.message}</span>
                      <div className="git-list-item-actions">
                        <button className="danger" onClick={() => handleDeleteTag(t.name)}>Delete</button>
                      </div>
                    </div>
                  ))}
                  {tags.length === 0 && <div style={{ padding: 20, textAlign: 'center', opacity: 0.3, fontSize: 12 }}>No tags</div>}
                </div>
              )}

            </div>
          </>
        )}
      </div>
    </div>
  );
}
