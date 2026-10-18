/**
 * SqliteViewer.tsx — SQLite database viewer/editor
 * Opens .sqlite/.db files inline in the editor area using sql.js (WASM).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Database, Play, Table2, ChevronRight, ChevronDown, RefreshCw, Download } from 'lucide-react';
// @ts-expect-error sql.js has no type declarations
import initSqlJs from 'sql.js';
// Bundle the wasm as a same-origin asset. The public CDN fails to instantiate inside the Tauri WebView
// (cross-origin streaming + sync XHR both blocked → "both async and sync fetching of the wasm failed").
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
type SqlDatabase = { exec: (sql: string) => { columns: string[]; values: unknown[][] }[]; export: () => Uint8Array; close: () => void };
import './SqliteViewer.css';

interface SqliteViewerProps {
  filePath: string;
  style?: { bg: string; text: string; accent: string };
}

interface TableInfo {
  name: string;
  rowCount: number;
  columns: { name: string; type: string; pk: boolean }[];
}

export function SqliteViewer({ filePath, style: panelStyle }: SqliteViewerProps) {
  const [db, setDb] = useState<SqlDatabase | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<{ columns: string[]; rows: unknown[][] }>({ columns: [], rows: [] });
  const [query, setQuery] = useState('');
  const [queryResult, setQueryResult] = useState<{ columns: string[]; rows: unknown[][]; time: number; error?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<'tables' | 'query'>('tables');
  const [dataPage, setDataPage] = useState(0);
  const PAGE_SIZE = 100;
  const queryRef = useRef<HTMLTextAreaElement>(null);

  // Load database
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const base64 = await invoke<string>('read_file_base64', { path: filePath });
        const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const SQL = await initSqlJs({
          locateFile: () => sqlWasmUrl,
        });
        if (cancelled) return;
        const database = new SQL.Database(binary);
        setDb(database);
        loadTables(database);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  const loadTables = useCallback((database: SqlDatabase) => {
    try {
      const result = database.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      if (!result.length) { setTables([]); return; }
      const tableNames = result[0].values.map((r: unknown[]) => String(r[0]));
      const infos: TableInfo[] = tableNames.map((name: string) => {
        const countResult = database.exec(`SELECT COUNT(*) FROM "${name}"`);
        const rowCount = countResult.length ? Number(countResult[0].values[0][0]) : 0;
        const colResult = database.exec(`PRAGMA table_info("${name}")`);
        const columns = colResult.length
          ? colResult[0].values.map((r: unknown[]) => ({ name: String(r[1]), type: String(r[2] || 'TEXT'), pk: r[5] === 1 }))
          : [];
        return { name, rowCount, columns };
      });
      setTables(infos);
    } catch { setTables([]); }
  }, []);

  const selectTable = useCallback((name: string) => {
    if (!db) return;
    setSelectedTable(name);
    setDataPage(0);
    try {
      const result = db.exec(`SELECT * FROM "${name}" LIMIT ${PAGE_SIZE} OFFSET 0`);
      if (result.length) {
        setTableData({ columns: result[0].columns, rows: result[0].values });
      } else {
        setTableData({ columns: [], rows: [] });
      }
    } catch (err) {
      setTableData({ columns: [], rows: [] });
    }
  }, [db]);

  const loadPage = useCallback((page: number) => {
    if (!db || !selectedTable) return;
    setDataPage(page);
    try {
      const result = db.exec(`SELECT * FROM "${selectedTable}" LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`);
      if (result.length) {
        setTableData({ columns: result[0].columns, rows: result[0].values });
      } else {
        setTableData({ columns: [], rows: [] });
      }
    } catch {}
  }, [db, selectedTable]);

  const runQuery = useCallback(() => {
    if (!db || !query.trim()) return;
    const start = performance.now();
    try {
      const results = db.exec(query);
      const time = performance.now() - start;
      if (results.length) {
        setQueryResult({ columns: results[0].columns, rows: results[0].values, time });
      } else {
        setQueryResult({ columns: [], rows: [], time });
      }
    } catch (err) {
      setQueryResult({ columns: [], rows: [], time: 0, error: String(err) });
    }
  }, [db, query]);

  const saveDatabase = useCallback(async () => {
    if (!db) return;
    try {
      const data = db.export();
      const base64 = btoa(String.fromCharCode(...data));
      await invoke('write_file_base64', { path: filePath, base64Data: base64 });
    } catch (err) {
      console.error('Failed to save database:', err);
    }
  }, [db, filePath]);

  const fileName = filePath.split('/').pop() || filePath;

  if (loading) {
    return (
      <div className="sqlite-viewer" style={{ color: panelStyle?.text }}>
        <div className="sqlite-loading">
          <Database size={24} style={{ opacity: 0.4, animation: 'spin 1s linear infinite' }} />
          <span>Loading {fileName}...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="sqlite-viewer" style={{ color: panelStyle?.text }}>
        <div className="sqlite-error">
          <Database size={24} style={{ opacity: 0.4 }} />
          <span>Failed to open database</span>
          <span style={{ fontSize: 11, opacity: 0.5 }}>{error}</span>
        </div>
      </div>
    );
  }

  const currentTableInfo = tables.find(t => t.name === selectedTable);

  return (
    <div className="sqlite-viewer" style={{ color: panelStyle?.text }}>
      {/* Header */}
      <div className="sqlite-header">
        <div className="sqlite-header-left">
          <Database size={14} style={{ color: panelStyle?.accent }} />
          <span className="sqlite-filename">{fileName}</span>
          <span className="sqlite-badge">{tables.length} tables</span>
        </div>
        <div className="sqlite-header-actions">
          <button onClick={() => { if (db) loadTables(db); }} title="Refresh"><RefreshCw size={13} /></button>
          <button onClick={saveDatabase} title="Save changes"><Download size={13} /></button>
        </div>
      </div>

      {/* Tabs */}
      <div className="sqlite-tabs">
        <button className={`sqlite-tab ${tab === 'tables' ? 'active' : ''}`} onClick={() => setTab('tables')}>
          <Table2 size={12} /> Tables
        </button>
        <button className={`sqlite-tab ${tab === 'query' ? 'active' : ''}`} onClick={() => setTab('query')}>
          <Play size={12} /> Query
        </button>
      </div>

      <div className="sqlite-body">
        {tab === 'tables' && (
          <div className="sqlite-tables-layout">
            {/* Table list sidebar */}
            <div className="sqlite-table-list">
              {tables.map(t => (
                <div key={t.name}>
                  <div
                    className={`sqlite-table-item ${selectedTable === t.name ? 'active' : ''}`}
                    onClick={() => selectTable(t.name)}
                  >
                    <span
                      className="sqlite-table-chevron"
                      onClick={e => {
                        e.stopPropagation();
                        setExpandedTables(prev => {
                          const n = new Set(prev);
                          n.has(t.name) ? n.delete(t.name) : n.add(t.name);
                          return n;
                        });
                      }}
                    >
                      {expandedTables.has(t.name) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </span>
                    <Table2 size={12} style={{ opacity: 0.5 }} />
                    <span className="sqlite-table-name">{t.name}</span>
                    <span className="sqlite-row-count">{t.rowCount}</span>
                  </div>
                  {expandedTables.has(t.name) && (
                    <div className="sqlite-columns-list">
                      {t.columns.map(c => (
                        <div key={c.name} className="sqlite-column-item">
                          {c.pk && <span className="sqlite-pk">PK</span>}
                          <span className="sqlite-col-name">{c.name}</span>
                          <span className="sqlite-col-type">{c.type}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {tables.length === 0 && (
                <div style={{ padding: 12, fontSize: 11, opacity: 0.4 }}>No tables</div>
              )}
            </div>

            {/* Data view */}
            <div className="sqlite-data-area">
              {selectedTable && tableData.columns.length > 0 ? (
                <>
                  <div className="sqlite-data-header">
                    <span>{selectedTable}</span>
                    <span className="sqlite-data-info">{currentTableInfo?.rowCount} rows</span>
                  </div>
                  <div className="sqlite-data-scroll">
                    <table className="sqlite-data-table">
                      <thead>
                        <tr>
                          {tableData.columns.map(c => <th key={c}>{c}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {tableData.rows.map((row, i) => (
                          <tr key={i}>
                            {row.map((cell, j) => (
                              <td key={j}>{cell === null ? <span className="sqlite-null">NULL</span> : String(cell)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {currentTableInfo && currentTableInfo.rowCount > PAGE_SIZE && (
                    <div className="sqlite-pagination">
                      <button disabled={dataPage === 0} onClick={() => loadPage(dataPage - 1)}>Prev</button>
                      <span>{dataPage * PAGE_SIZE + 1}-{Math.min((dataPage + 1) * PAGE_SIZE, currentTableInfo.rowCount)} / {currentTableInfo.rowCount}</span>
                      <button disabled={(dataPage + 1) * PAGE_SIZE >= currentTableInfo.rowCount} onClick={() => loadPage(dataPage + 1)}>Next</button>
                    </div>
                  )}
                </>
              ) : (
                <div className="sqlite-data-empty">
                  <Table2 size={24} style={{ opacity: 0.2 }} />
                  <span>Select a table</span>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'query' && (
          <div className="sqlite-query-layout">
            <div className="sqlite-query-input">
              <textarea
                ref={queryRef}
                className="sqlite-query-textarea"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="SELECT * FROM table_name LIMIT 100;"
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); } }}
              />
              <div className="sqlite-query-actions">
                <button className="sqlite-run-btn" onClick={runQuery} disabled={!query.trim()}>
                  <Play size={12} /> Run (Cmd+Enter)
                </button>
              </div>
            </div>
            {queryResult && (
              <div className="sqlite-query-result">
                {queryResult.error ? (
                  <div className="sqlite-query-error">{queryResult.error}</div>
                ) : (
                  <>
                    <div className="sqlite-result-info">
                      {queryResult.rows.length} rows in {queryResult.time.toFixed(1)}ms
                    </div>
                    {queryResult.columns.length > 0 && (
                      <div className="sqlite-data-scroll">
                        <table className="sqlite-data-table">
                          <thead>
                            <tr>{queryResult.columns.map(c => <th key={c}>{c}</th>)}</tr>
                          </thead>
                          <tbody>
                            {queryResult.rows.map((row, i) => (
                              <tr key={i}>
                                {row.map((cell, j) => (
                                  <td key={j}>{cell === null ? <span className="sqlite-null">NULL</span> : String(cell)}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
