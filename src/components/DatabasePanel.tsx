import React, { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Database, X, Plus, Play, Trash2, Plug, PlugZap, ChevronRight, ChevronDown, Table2, Columns3, Key } from 'lucide-react';
import { useConfig } from '../config/ConfigContext';
import type { DatabaseConnection } from '../config/schema';
import './DatabasePanel.css';

interface DatabasePanelProps {
  isOpen: boolean;
  onClose: () => void;
  currentStyle?: { bg: string; text: string; accent: string };
}

interface QueryResult {
  columns: string[];
  rows: unknown[][];
  affected_rows: number;
  execution_time_ms: number;
}

interface ColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  is_primary_key: boolean;
}

type Tab = 'connections' | 'query' | 'schema';

// KV helpers
async function kvGet(key: string): Promise<string> {
  return invoke<string>('kv_get', { key }).catch(() => '');
}
async function kvSet(key: string, value: string): Promise<void> {
  await invoke('kv_set', { key, value }).catch(() => {});
}
async function kvDelete(key: string): Promise<void> {
  await invoke('kv_delete', { key }).catch(() => {});
}

export function DatabasePanel({ isOpen, onClose, currentStyle }: DatabasePanelProps) {
  const { config, updateConfig } = useConfig();
  const dbConnections = config.dbConnections || [];
  const onSaveConnections = useCallback((conns: DatabaseConnection[]) => {
    updateConfig(prev => ({ ...prev, dbConnections: conns }));
  }, [updateConfig]);

  const [activeTab, setActiveTab] = useState<Tab>('connections');
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set());

  // Connection form
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '', dbType: 'mysql' as 'mysql' | 'postgres', host: 'localhost', port: 3306, username: 'root', password: '', database: '',
  });
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // Query
  const [selectedConnId, setSelectedConnId] = useState<string>('');
  const [queryText, setQueryText] = useState('SELECT 1;');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState('');
  const [executing, setExecuting] = useState(false);

  // Schema
  const [schemaConnId, setSchemaConnId] = useState<string>('');
  const [tables, setTables] = useState<string[]>([]);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [tableColumns, setTableColumns] = useState<Record<string, ColumnInfo[]>>({});
  const [loadingSchema, setLoadingSchema] = useState(false);

  const overlayRef = useRef<HTMLDivElement>(null);

  // ── Connection management ──

  const resetForm = useCallback(() => {
    setFormData({ name: '', dbType: 'mysql', host: 'localhost', port: 3306, username: 'root', password: '', database: '' });
    setEditingId(null);
    setTestResult(null);
  }, []);

  const handleAddNew = useCallback(() => {
    resetForm();
    setShowForm(true);
  }, [resetForm]);

  const handleEdit = useCallback(async (conn: DatabaseConnection) => {
    const pw = await kvGet(`octo-db-pw-${conn.id}`);
    setFormData({ name: conn.name, dbType: conn.dbType, host: conn.host, port: conn.port, username: conn.username, password: pw, database: conn.database });
    setEditingId(conn.id);
    setShowForm(true);
    setTestResult(null);
  }, []);

  const handleSave = useCallback(async () => {
    const id = editingId || crypto.randomUUID();
    const conn: DatabaseConnection = {
      id, name: formData.name || `${formData.dbType}@${formData.host}`,
      dbType: formData.dbType, host: formData.host, port: formData.port, username: formData.username, database: formData.database,
    };
    await kvSet(`octo-db-pw-${id}`, formData.password);

    const updated = editingId
      ? dbConnections.map(c => c.id === editingId ? conn : c)
      : [...dbConnections, conn];
    onSaveConnections(updated);
    setShowForm(false);
    resetForm();
  }, [editingId, formData, dbConnections, onSaveConnections, resetForm]);

  const handleDelete = useCallback(async (id: string) => {
    if (connectedIds.has(id)) {
      await invoke('db_disconnect', { connectionId: id }).catch(() => {});
      setConnectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
    await kvDelete(`octo-db-pw-${id}`);
    onSaveConnections(dbConnections.filter(c => c.id !== id));
  }, [dbConnections, onSaveConnections, connectedIds]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const version = await invoke<string>('db_test_connection', {
        dbType: formData.dbType, host: formData.host, port: formData.port,
        username: formData.username, password: formData.password, database: formData.database,
      });
      setTestResult({ ok: true, msg: version });
    } catch (e: unknown) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
    }
  }, [formData]);

  const handleConnect = useCallback(async (conn: DatabaseConnection) => {
    const pw = await kvGet(`octo-db-pw-${conn.id}`);
    try {
      await invoke('db_connect', {
        connectionId: conn.id, dbType: conn.dbType, host: conn.host, port: conn.port,
        username: conn.username, password: pw, database: conn.database,
      });
      setConnectedIds(prev => new Set(prev).add(conn.id));
    } catch (e: unknown) {
      alert(`Connection failed: ${e}`);
    }
  }, []);

  const handleDisconnect = useCallback(async (id: string) => {
    await invoke('db_disconnect', { connectionId: id }).catch(() => {});
    setConnectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
  }, []);

  // ── Query ──

  const handleExecuteQuery = useCallback(async () => {
    if (!selectedConnId || !queryText.trim()) return;
    setExecuting(true);
    setQueryError('');
    setQueryResult(null);
    try {
      const result = await invoke<QueryResult>('db_execute_query', { connectionId: selectedConnId, query: queryText });
      setQueryResult(result);
    } catch (e: unknown) {
      setQueryError(String(e));
    } finally {
      setExecuting(false);
    }
  }, [selectedConnId, queryText]);

  // ── Schema ──

  const loadTables = useCallback(async (connId: string) => {
    setLoadingSchema(true);
    setTables([]);
    setExpandedTable(null);
    setTableColumns({});
    try {
      const conn = dbConnections.find(c => c.id === connId);
      const result = await invoke<string[]>('db_list_tables', { connectionId: connId, database: conn?.database || null });
      setTables(result);
    } catch (e: unknown) {
      console.error('Failed to load tables:', e);
    } finally {
      setLoadingSchema(false);
    }
  }, [dbConnections]);

  const loadColumns = useCallback(async (connId: string, tableName: string) => {
    try {
      const conn = dbConnections.find(c => c.id === connId);
      const cols = await invoke<ColumnInfo[]>('db_describe_table', { connectionId: connId, table: tableName, database: conn?.database || null });
      setTableColumns(prev => ({ ...prev, [tableName]: cols }));
    } catch (e: unknown) {
      console.error('Failed to describe table:', e);
    }
  }, [dbConnections]);

  const handleToggleTable = useCallback(async (tableName: string) => {
    if (expandedTable === tableName) {
      setExpandedTable(null);
    } else {
      setExpandedTable(tableName);
      if (!tableColumns[tableName]) {
        await loadColumns(schemaConnId, tableName);
      }
    }
  }, [expandedTable, tableColumns, schemaConnId, loadColumns]);

  useEffect(() => {
    if (schemaConnId && connectedIds.has(schemaConnId)) {
      loadTables(schemaConnId);
    }
  }, [schemaConnId, connectedIds, loadTables]);

  // ── Keyboard ──

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && activeTab === 'query') {
      e.preventDefault();
      handleExecuteQuery();
    }
  }, [onClose, activeTab, handleExecuteQuery]);

  if (!isOpen) return null;

  const bg = currentStyle?.bg || '#1a1a2e';
  const text = currentStyle?.text || '#e0e0e0';
  const accent = currentStyle?.accent || '#4db8ff';
  const connectedConns = dbConnections.filter(c => connectedIds.has(c.id));

  return (
    <div className="db-panel-overlay" ref={overlayRef} onKeyDown={handleKeyDown} tabIndex={-1}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="db-panel" style={{ background: bg, color: text, border: `1px solid ${accent}22` }}>
        {/* Header */}
        <div className="db-panel-header">
          <Database size={16} style={{ color: accent }} />
          <h3>Database</h3>
          <button className="modal-close-btn" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </div>

        {/* Tabs */}
        <div className="db-panel-tabs">
          {(['connections', 'query', 'schema'] as Tab[]).map(tab => (
            <button key={tab} className={`db-panel-tab ${activeTab === tab ? 'active' : ''}`}
              style={activeTab === tab ? { color: accent, borderBottomColor: accent } : {}}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'connections' ? 'Connections' : tab === 'query' ? 'Query' : 'Schema'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="db-panel-body">

          {/* ── Connections Tab ── */}
          {activeTab === 'connections' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: 12, opacity: 0.5 }}>{dbConnections.length} connection(s)</span>
                <button className="db-btn primary" onClick={handleAddNew}><Plus size={12} /> Add</button>
              </div>

              {showForm && (
                <div style={{ marginBottom: 16, padding: 12, borderRadius: 'var(--brutal-radius)', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div className="db-form">
                    <div className="db-form-group">
                      <label>Name</label>
                      <input value={formData.name} onChange={e => setFormData(p => ({ ...p, name: e.target.value }))} placeholder="My Database" />
                    </div>
                    <div className="db-form-group">
                      <label>Type</label>
                      <select value={formData.dbType} onChange={e => {
                        const t = e.target.value as 'mysql' | 'postgres';
                        setFormData(p => ({ ...p, dbType: t, port: t === 'mysql' ? 3306 : 5432 }));
                      }}>
                        <option value="mysql">MySQL</option>
                        <option value="postgres">PostgreSQL</option>
                      </select>
                    </div>
                    <div className="db-form-group">
                      <label>Host</label>
                      <input value={formData.host} onChange={e => setFormData(p => ({ ...p, host: e.target.value }))} />
                    </div>
                    <div className="db-form-group">
                      <label>Port</label>
                      <input type="number" value={formData.port} onChange={e => setFormData(p => ({ ...p, port: parseInt(e.target.value) || 3306 }))} />
                    </div>
                    <div className="db-form-group">
                      <label>Username</label>
                      <input value={formData.username} onChange={e => setFormData(p => ({ ...p, username: e.target.value }))} />
                    </div>
                    <div className="db-form-group">
                      <label>Password</label>
                      <input type="password" value={formData.password} onChange={e => setFormData(p => ({ ...p, password: e.target.value }))} />
                    </div>
                    <div className="db-form-group full">
                      <label>Database</label>
                      <input value={formData.database} onChange={e => setFormData(p => ({ ...p, database: e.target.value }))} placeholder="mydb" />
                    </div>
                    <div className="db-form-buttons">
                      {testResult && (
                        <span style={{ fontSize: 11, color: testResult.ok ? '#22c55e' : '#ef4444', marginRight: 'auto', alignSelf: 'center', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {testResult.ok ? `✓ ${testResult.msg}` : `✗ ${testResult.msg}`}
                        </span>
                      )}
                      <button className="db-btn" onClick={() => { setShowForm(false); resetForm(); }}>Cancel</button>
                      <button className="db-btn success" onClick={handleTest} disabled={testing}>
                        {testing ? 'Testing...' : 'Test'}
                      </button>
                      <button className="db-btn primary" onClick={handleSave}>Save</button>
                    </div>
                  </div>
                </div>
              )}

              <div className="db-conn-list">
                {dbConnections.map(conn => (
                  <div key={conn.id} className={`db-conn-item ${connectedIds.has(conn.id) ? 'connected' : ''}`}>
                    <div className="db-conn-info">
                      <div className="name">{conn.name}</div>
                      <div className="details">{conn.username}@{conn.host}:{conn.port}/{conn.database}</div>
                    </div>
                    <span className={`db-conn-badge ${conn.dbType}`}>{conn.dbType}</span>
                    <div className="db-conn-actions">
                      {connectedIds.has(conn.id) ? (
                        <button onClick={() => handleDisconnect(conn.id)} title="Disconnect"><PlugZap size={14} style={{ color: '#22c55e' }} /></button>
                      ) : (
                        <button onClick={() => handleConnect(conn)} title="Connect"><Plug size={14} /></button>
                      )}
                      <button onClick={() => handleEdit(conn)} title="Edit"><Columns3 size={14} /></button>
                      <button onClick={() => handleDelete(conn.id)} title="Delete"><Trash2 size={14} /></button>
                    </div>
                  </div>
                ))}
                {dbConnections.length === 0 && (
                  <div className="db-empty-state">
                    <Database size={32} />
                    <span>No connections yet</span>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Query Tab ── */}
          {activeTab === 'query' && (
            <div className="db-query-area">
              <div className="db-query-toolbar">
                <select value={selectedConnId} onChange={e => setSelectedConnId(e.target.value)}
                  style={{ minWidth: 180 }}>
                  <option value="">Select connection...</option>
                  {connectedConns.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.dbType})</option>
                  ))}
                </select>
                <button className="db-btn primary" onClick={handleExecuteQuery} disabled={executing || !selectedConnId}
                  style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Play size={12} /> {executing ? 'Running...' : 'Run'}
                </button>
                <span style={{ fontSize: 10, opacity: 0.4, marginLeft: 'auto' }}>⌘+Enter to run</span>
              </div>

              <textarea
                className="db-query-editor"
                value={queryText}
                onChange={e => setQueryText(e.target.value)}
                placeholder="SELECT * FROM users LIMIT 100;"
                spellCheck={false}
              />

              {queryError && (
                <div style={{ padding: 8, borderRadius: 'var(--brutal-radius)', background: 'rgba(239,68,68,0.1)', color: '#ef4444', fontSize: 12 }}>
                  {queryError}
                </div>
              )}

              {queryResult && (
                <>
                  <div className="db-query-status">
                    {queryResult.columns.length > 0 ? (
                      <span>{queryResult.rows.length} row(s) in {queryResult.execution_time_ms}ms</span>
                    ) : (
                      <span>{queryResult.affected_rows} row(s) affected in {queryResult.execution_time_ms}ms</span>
                    )}
                  </div>
                  {queryResult.columns.length > 0 && (
                    <div className="db-result-wrapper">
                      <table className="db-result-table">
                        <thead>
                          <tr>
                            {queryResult.columns.map((col, i) => <th key={i}>{col}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {queryResult.rows.map((row, ri) => (
                            <tr key={ri}>
                              {row.map((cell, ci) => (
                                <td key={ci} title={cell == null ? 'NULL' : String(cell)}>
                                  {cell == null ? <span style={{ opacity: 0.3, fontStyle: 'italic' }}>NULL</span> : String(cell)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {connectedConns.length === 0 && (
                <div className="db-empty-state">
                  <Plug size={24} />
                  <span>Connect to a database first</span>
                </div>
              )}
            </div>
          )}

          {/* ── Schema Tab ── */}
          {activeTab === 'schema' && (
            <>
              <div className="db-query-toolbar" style={{ marginBottom: 12 }}>
                <select value={schemaConnId} onChange={e => setSchemaConnId(e.target.value)} style={{ minWidth: 180 }}>
                  <option value="">Select connection...</option>
                  {connectedConns.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.dbType})</option>
                  ))}
                </select>
                {loadingSchema && <span style={{ fontSize: 11, opacity: 0.5 }}>Loading...</span>}
              </div>

              <div className="db-schema-tree">
                {tables.map(tableName => (
                  <div key={tableName}>
                    <div className="db-schema-node" onClick={() => handleToggleTable(tableName)}>
                      <span className="icon">
                        {expandedTable === tableName ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                      <Table2 size={14} style={{ color: accent, opacity: 0.7 }} />
                      <span>{tableName}</span>
                    </div>
                    {expandedTable === tableName && tableColumns[tableName] && (
                      <div className="db-schema-children">
                        {tableColumns[tableName].map(col => (
                          <div key={col.name} className="db-schema-col-info">
                            {col.is_primary_key ? <Key size={11} style={{ color: '#eab308' }} /> : <Columns3 size={11} style={{ opacity: 0.4 }} />}
                            <span>{col.name}</span>
                            <span className="col-type">{col.data_type}</span>
                            {col.is_primary_key && <span className="pk-badge">PK</span>}
                            {!col.is_nullable && <span style={{ fontSize: 9, opacity: 0.4 }}>NOT NULL</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {tables.length === 0 && schemaConnId && !loadingSchema && (
                  <div className="db-empty-state">
                    <Table2 size={24} />
                    <span>No tables found</span>
                  </div>
                )}
                {!schemaConnId && connectedConns.length === 0 && (
                  <div className="db-empty-state">
                    <Plug size={24} />
                    <span>Connect to a database first</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
