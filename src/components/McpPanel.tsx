import { useState, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Plug, Plus, Play, Square, Trash2, X, Search } from 'lucide-react';
import { useConfig } from '../config/ConfigContext';
import type { McpServerConfig } from '../config/schema';
import { MCP_PRESETS, MCP_PRESET_CATEGORIES, type McpPresetCategory } from '../config/mcpPresets';
import './McpPanel.css';

/** Replace __HOME__ placeholders in preset args with actual home directory */
async function resolvePresetArgs(args: string): Promise<string> {
  if (!args.includes('__HOME__')) return args;
  try {
    const homeDir = await invoke<string>('get_home_dir');
    return args.replace(/__HOME__/g, homeDir);
  } catch {
    return args;
  }
}

interface McpPanelProps {
  isOpen: boolean;
  onClose: () => void;
  mcpServers: McpServerConfig[];
  runningMcpServers: Set<string>;
  onMcpServerStart: (name: string) => void;
  onMcpServerStop: (name: string) => void;
  currentStyle?: { bg: string; text: string; accent: string };
}

export function McpPanel({
  isOpen,
  onClose,
  mcpServers: mcpServersProp,
  runningMcpServers,
  onMcpServerStart,
  onMcpServerStop,
  currentStyle,
}: McpPanelProps) {
  const { config, updateConfig } = useConfig();
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(() => mcpServersProp ?? config.mcpServers ?? []);
  const [mcpNewName, setMcpNewName] = useState('');
  const [mcpNewCommand, setMcpNewCommand] = useState('');
  const [mcpNewArgs, setMcpNewArgs] = useState('');
  const [mcpNewEnv, setMcpNewEnv] = useState('');
  const [mcpNewAutoStart, setMcpNewAutoStart] = useState(false);
  const [mcpNewUseWithCli, setMcpNewUseWithCli] = useState<'claude' | 'codex' | 'both' | 'none'>('none');
  const [mcpEditingId, setMcpEditingId] = useState<string | null>(null);
  const [mcpPasteJson, setMcpPasteJson] = useState('');
  const [mcpPasteError, setMcpPasteError] = useState('');
  const [mcpAddMode, setMcpAddMode] = useState<'paste' | 'form'>('paste');
  const [mcpPresetFilter, setMcpPresetFilter] = useState<McpPresetCategory | 'all'>('all');
  const [mcpPresetSearch, setMcpPresetSearch] = useState('');

  // Sync from prop
  useState(() => { setMcpServers(mcpServersProp ?? config.mcpServers ?? []); });

  const filteredMcpPresets = useMemo(() => {
    let list = MCP_PRESETS;
    if (mcpPresetFilter !== 'all') list = list.filter(p => p.category === mcpPresetFilter);
    if (mcpPresetSearch.trim()) {
      const q = mcpPresetSearch.toLowerCase();
      list = list.filter(p => p.label.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
    }
    return list;
  }, [mcpPresetFilter, mcpPresetSearch]);

  const handleMcpPasteAdd = useCallback(() => {
    const raw = mcpPasteJson.trim();
    if (!raw) return;
    setMcpPasteError('');
    try {
      let parsed = JSON.parse(raw);
      if (parsed.mcpServers) parsed = parsed.mcpServers;
      const toAdd: McpServerConfig[] = [];
      if (parsed.command && typeof parsed.command === 'string') {
        const args = Array.isArray(parsed.args) ? parsed.args : [];
        const pkgArg = args.find((a: string) => a.startsWith('@') || (!a.startsWith('-') && a.includes('/')));
        const derivedName = pkgArg ? pkgArg.split('/').pop()?.replace(/^server-/, '') || 'mcp-server' : 'mcp-server';
        toAdd.push({ name: derivedName, command: parsed.command, args, env: parsed.env && typeof parsed.env === 'object' ? parsed.env : undefined, autoStart: parsed.autoStart || undefined });
      } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [name, cfg] of Object.entries(parsed)) {
          const c = cfg as Record<string, unknown>;
          if (c && typeof c.command === 'string') {
            toAdd.push({ name, command: c.command, args: Array.isArray(c.args) ? c.args as string[] : [], env: c.env && typeof c.env === 'object' ? c.env as Record<string, string> : undefined, autoStart: (c.autoStart as boolean) || undefined });
          }
        }
      }
      if (toAdd.length === 0) { setMcpPasteError('No valid MCP server config found.'); return; }
      const existingNames = new Set(mcpServers.map(s => s.name));
      const skipped: string[] = [];
      const added: McpServerConfig[] = [];
      for (const s of toAdd) {
        if (existingNames.has(s.name)) { skipped.push(s.name); continue; }
        existingNames.add(s.name); added.push(s);
      }
      if (added.length > 0) {
        const next = [...mcpServers, ...added];
        setMcpServers(next);
        updateConfig(prev => ({ ...prev, mcpServers: next }));
      }
      const msgs: string[] = [];
      if (added.length > 0) msgs.push(`${added.map(s => s.name).join(', ')} added`);
      if (skipped.length > 0) msgs.push(`${skipped.join(', ')} already exists`);
      setMcpPasteError(msgs.join(' / '));
      if (added.length > 0) setMcpPasteJson('');
    } catch { setMcpPasteError('JSON parse failed — check that the JSON is valid.'); }
  }, [mcpPasteJson, mcpServers, updateConfig]);

  const handleFormSubmit = useCallback(() => {
    if (!mcpNewName.trim() || !mcpNewCommand.trim()) return;
    const envObj: Record<string, string> = {};
    mcpNewEnv.split('\n').forEach(line => {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) { const k = line.substring(0, eqIdx).trim(); const v = line.substring(eqIdx + 1).trim(); if (k) envObj[k] = v; }
    });
    const newServer: McpServerConfig = {
      name: mcpNewName.trim(), command: mcpNewCommand.trim(),
      args: mcpNewArgs.trim() ? mcpNewArgs.trim().split(/\s+/) : [],
      env: Object.keys(envObj).length > 0 ? envObj : undefined,
      autoStart: mcpNewAutoStart || undefined,
      useWithCli: mcpNewUseWithCli !== 'none' ? mcpNewUseWithCli : undefined,
    };
    let next: McpServerConfig[];
    if (mcpEditingId) { next = mcpServers.map(s => s.name === mcpEditingId ? newServer : s); }
    else {
      if (mcpServers.some(s => s.name === newServer.name)) return;
      next = [...mcpServers, newServer];
    }
    setMcpServers(next);
    updateConfig(prev => ({ ...prev, mcpServers: next }));
    setMcpEditingId(null); setMcpNewName(''); setMcpNewCommand(''); setMcpNewArgs(''); setMcpNewEnv(''); setMcpNewAutoStart(false); setMcpNewUseWithCli('none');
  }, [mcpNewName, mcpNewCommand, mcpNewArgs, mcpNewEnv, mcpNewAutoStart, mcpEditingId, mcpServers, updateConfig]);

  if (!isOpen) return null;

  const style = currentStyle || { bg: '#1e1e2e', text: '#cdd6f4', accent: '#89b4fa' };

  return (
    <div className="mcp-panel-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="mcp-panel"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          '--mcp-bg': style.bg,
          '--mcp-text': style.text,
          '--mcp-accent': style.accent,
        } as React.CSSProperties}
      >
        {/* Header */}
        <div className="mcp-panel-header">
          <Plug size={16} />
          <h3>MCP Servers</h3>
          <span className="mcp-panel-count">{mcpServers.length} registered · {runningMcpServers.size} running</span>
          <div style={{ flex: 1 }} />
          <button className="modal-close-btn" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </div>

        {/* Server list */}
        <div className="mcp-panel-servers">
          {mcpServers.length === 0 && (
            <div className="mcp-panel-empty">No MCP servers registered. Add one below.</div>
          )}
          {mcpServers.map((server, idx) => {
            const isRunning = runningMcpServers.has(server.name);
            const isEditing = mcpEditingId === server.name;
            return (
              <div key={server.name + idx} className={`mcp-server-item ${isRunning ? 'running' : ''}`}>
                <span className={`mcp-server-dot ${isRunning ? 'on' : ''}`} />
                <div className="mcp-server-info">
                  <div className="mcp-server-name">{server.name}</div>
                  <div className="mcp-server-cmd">{server.command} {server.args.join(' ')}</div>
                  {server.autoStart && <span className="mcp-server-auto">auto-start</span>}
                </div>
                <select
                  className="mcp-cli-select"
                  value={server.useWithCli || 'none'}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const val = e.target.value as 'claude' | 'codex' | 'both' | 'none';
                    const next = mcpServers.map((s, i2) => i2 === idx ? { ...s, useWithCli: val } : s);
                    setMcpServers(next);
                    updateConfig(prev => ({ ...prev, mcpServers: next }));
                  }}
                  title="AI CLI integration"
                >
                  <option value="none">No CLI</option>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                  <option value="both">Both</option>
                </select>
                <div className="mcp-server-actions">
                  {isRunning ? (
                    <button className="mcp-btn-sm" title="Stop" onClick={() => onMcpServerStop(server.name)}><Square size={12} /></button>
                  ) : (
                    <button className="mcp-btn-sm" title="Start" onClick={() => onMcpServerStart(server.name)}><Play size={12} /></button>
                  )}
                  <button className="mcp-btn-sm" onClick={() => {
                    if (isEditing) {
                      setMcpEditingId(null); setMcpNewName(''); setMcpNewCommand(''); setMcpNewArgs(''); setMcpNewEnv(''); setMcpNewAutoStart(false); setMcpNewUseWithCli('none');
                    } else {
                      setMcpEditingId(server.name); setMcpNewName(server.name); setMcpNewCommand(server.command);
                      setMcpNewArgs(server.args.join(' '));
                      setMcpNewEnv(server.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : '');
                      setMcpNewAutoStart(server.autoStart ?? false);
                      setMcpNewUseWithCli(server.useWithCli || 'none');
                      setMcpAddMode('form');
                    }
                  }}>{isEditing ? 'Cancel' : 'Edit'}</button>
                  <button className="mcp-btn-sm danger" title="Delete" onClick={() => {
                    if (isRunning) onMcpServerStop(server.name);
                    const next = mcpServers.filter((_, i) => i !== idx);
                    setMcpServers(next);
                    updateConfig(prev => ({ ...prev, mcpServers: next }));
                    if (mcpEditingId === server.name) setMcpEditingId(null);
                  }}><Trash2 size={12} /></button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Add section */}
        <div className="mcp-panel-add">
          <div className="mcp-panel-add-header">
            <h4>{mcpEditingId ? 'Edit MCP Server' : 'Add MCP Server'}</h4>
            {!mcpEditingId && (
              <div className="mcp-mode-tabs">
                <button className={`mcp-mode-tab ${mcpAddMode === 'paste' ? 'active' : ''}`} onClick={() => setMcpAddMode('paste')}>Paste JSON</button>
                <button className={`mcp-mode-tab ${mcpAddMode === 'form' ? 'active' : ''}`} onClick={() => setMcpAddMode('form')}>Manual Entry</button>
              </div>
            )}
          </div>

          {/* Paste mode */}
          {mcpAddMode === 'paste' && !mcpEditingId && (
            <div className="mcp-paste-section">
              {/* Preset Gallery */}
              <div className="mcp-presets">
                <div className="mcp-presets-header">
                  <span>MCP Server Gallery</span>
                  <span className="mcp-presets-count">{MCP_PRESETS.length}</span>
                </div>
                <div className="mcp-presets-search">
                  <Search size={12} />
                  <input type="text" value={mcpPresetSearch} onChange={e => setMcpPresetSearch(e.target.value)} placeholder="Search..." />
                </div>
                <div className="mcp-presets-chips">
                  <button className={`mcp-preset-chip ${mcpPresetFilter === 'all' ? 'active' : ''}`} onClick={() => setMcpPresetFilter('all')}>All {MCP_PRESETS.length}</button>
                  {MCP_PRESET_CATEGORIES.map(cat => {
                    const cnt = MCP_PRESETS.filter(p => p.category === cat.key).length;
                    if (cnt === 0) return null;
                    return <button key={cat.key} className={`mcp-preset-chip ${mcpPresetFilter === cat.key ? 'active' : ''}`} onClick={() => setMcpPresetFilter(cat.key)}>{cat.emoji} {cat.label} {cnt}</button>;
                  })}
                </div>
                <div className="mcp-presets-grid">
                  {filteredMcpPresets.map(p => {
                    const alreadyExists = mcpServers.some(s => s.name === p.name);
                    return (
                      <button key={p.name} disabled={alreadyExists} className={`mcp-preset-card ${alreadyExists ? 'added' : ''}`}
                        onClick={async () => {
                          if (alreadyExists) return;
                          const envObj: Record<string, string> = {};
                          if (p.env) { p.env.split('\n').forEach(line => { const eqIdx = line.indexOf('='); if (eqIdx > 0) { const k = line.substring(0, eqIdx).trim(); const v = line.substring(eqIdx + 1).trim(); if (k) envObj[k] = v; } }); }
                          const resolvedArgs = await resolvePresetArgs(p.args);
                          const next = [...mcpServers, { name: p.name, command: p.command, args: resolvedArgs.trim().split(/\s+/), env: Object.keys(envObj).length > 0 ? envObj : undefined }];
                          setMcpServers(next);
                          updateConfig(prev => ({ ...prev, mcpServers: next }));
                        }}
                        title={`${p.description}\n${p.command} ${p.args}`}
                      >
                        {alreadyExists ? '✓ ' : '+ '}{p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* JSON paste */}
              <div className="mcp-json-paste">
                <span className="mcp-json-label">Paste Claude Desktop / Cursor JSON</span>
                <textarea
                  className="mcp-json-textarea"
                  value={mcpPasteJson}
                  onChange={(e) => { setMcpPasteJson(e.target.value); setMcpPasteError(''); }}
                  placeholder={`{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  }
}`}
                />
                <div className="mcp-json-actions">
                  <button className="mcp-btn-primary" disabled={!mcpPasteJson.trim()} onClick={handleMcpPasteAdd}>
                    <Plus size={12} /> Add
                  </button>
                  {mcpPasteError && (
                    <span className={`mcp-json-msg ${mcpPasteError.includes('added') ? 'success' : 'error'}`}>{mcpPasteError}</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Form mode */}
          {(mcpAddMode === 'form' || mcpEditingId) && (
            <div className="mcp-form">
              <div className="mcp-form-row">
                <input type="text" placeholder="Server name" value={mcpNewName} onChange={(e) => setMcpNewName(e.target.value)} disabled={!!mcpEditingId} className="mcp-input" style={{ flex: '0 0 180px' }} />
                <input type="text" placeholder="Command (npx, uvx, node ...)" value={mcpNewCommand} onChange={(e) => setMcpNewCommand(e.target.value)} className="mcp-input" style={{ flex: 1 }} />
              </div>
              <input type="text" placeholder="Arguments (e.g. -y @modelcontextprotocol/server-filesystem /tmp)" value={mcpNewArgs} onChange={(e) => setMcpNewArgs(e.target.value)} className="mcp-input" />
              <textarea placeholder="Environment variables (KEY=VALUE, one per line)" value={mcpNewEnv} onChange={(e) => setMcpNewEnv(e.target.value)} rows={2} className="mcp-input mcp-textarea" />
              <div className="mcp-form-footer">
                <label className="mcp-checkbox">
                  <input type="checkbox" checked={mcpNewAutoStart} onChange={(e) => setMcpNewAutoStart(e.target.checked)} />
                  Auto-start
                </label>
                <select
                  className="mcp-cli-select"
                  value={mcpNewUseWithCli}
                  onChange={(e) => setMcpNewUseWithCli(e.target.value as 'claude' | 'codex' | 'both' | 'none')}
                  title="AI CLI integration"
                >
                  <option value="none">No CLI</option>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                  <option value="both">Both</option>
                </select>
                <div style={{ flex: 1 }} />
                {mcpEditingId && (
                  <button className="mcp-btn-secondary" onClick={() => { setMcpEditingId(null); setMcpNewName(''); setMcpNewCommand(''); setMcpNewArgs(''); setMcpNewEnv(''); setMcpNewAutoStart(false); setMcpNewUseWithCli('none'); }}>Cancel</button>
                )}
                <button className="mcp-btn-primary" disabled={!mcpNewName.trim() || !mcpNewCommand.trim()} onClick={handleFormSubmit}>
                  {mcpEditingId ? 'Save' : <><Plus size={12} /> Add</>}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
