/**
 * JsonEditor.tsx
 *
 * Interactive JSON tree editor with collapsible nodes,
 * inline value editing, add/delete/copy, format/minify,
 * and JSON validation.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  ChevronRight, ChevronDown, Copy, Trash2, Plus,
  AlignLeft, Minimize2, Check, AlertTriangle, Braces,
  Hash, ToggleLeft, Type, List,
} from 'lucide-react';
import './JsonEditor.css';
import { useTranslation } from '../i18n';

export interface JsonEditorProps {
  content: string;
  onChange: (json: string) => void;
  onSave?: () => void;
  style: { bg: string; text: string; accent: string };
  fontFamily: string;
  fontSize: number;
  isLightTheme: boolean;
}

/* ── Helpers ─────────────────────────────────────── */

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function parseJsonSafe(text: string): { data: JsonValue | undefined; error: string | null } {
  try {
    const data = JSON.parse(text);
    return { data, error: null };
  } catch (e) {
    return { data: undefined, error: (e as Error).message };
  }
}

function jsonTypeLabel(v: JsonValue): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function jsonTypeIcon(v: JsonValue) {
  if (v === null) return <span className="je-type-badge je-type-null">null</span>;
  if (Array.isArray(v)) return <List size={12} className="je-type-icon je-type-arr" />;
  if (typeof v === 'object') return <Braces size={12} className="je-type-icon je-type-obj" />;
  if (typeof v === 'string') return <Type size={12} className="je-type-icon je-type-str" />;
  if (typeof v === 'number') return <Hash size={12} className="je-type-icon je-type-num" />;
  if (typeof v === 'boolean') return <ToggleLeft size={12} className="je-type-icon je-type-bool" />;
  return null;
}

/** Deep-set a value by path (array of keys/indices) — returns new root */
function setAtPath(root: JsonValue, path: (string | number)[], value: JsonValue): JsonValue {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const arr = [...root];
    arr[head as number] = rest.length === 0 ? value : setAtPath(arr[head as number], rest, value);
    return arr;
  }
  if (root !== null && typeof root === 'object') {
    return { ...root, [head as string]: rest.length === 0 ? value : setAtPath((root as any)[head as string], rest, value) };
  }
  return root;
}

/** Deep-delete by path — returns new root */
function deleteAtPath(root: JsonValue, path: (string | number)[]): JsonValue {
  if (path.length === 0) return root;
  if (path.length === 1) {
    const key = path[0];
    if (Array.isArray(root)) {
      const arr = [...root];
      arr.splice(key as number, 1);
      return arr;
    }
    if (root !== null && typeof root === 'object') {
      const obj = { ...root };
      delete obj[key as string];
      return obj;
    }
    return root;
  }
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const arr = [...root];
    arr[head as number] = deleteAtPath(arr[head as number], rest);
    return arr;
  }
  if (root !== null && typeof root === 'object') {
    return { ...root, [head as string]: deleteAtPath((root as any)[head as string], rest) };
  }
  return root;
}

/** Insert at path for array (push) or object (new key) */
function insertAtPath(root: JsonValue, path: (string | number)[], key: string | null, value: JsonValue): JsonValue {
  if (path.length === 0) {
    if (Array.isArray(root)) return [...root, value];
    if (root !== null && typeof root === 'object' && key !== null) return { ...root, [key]: value };
    return root;
  }
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const arr = [...root];
    arr[head as number] = insertAtPath(arr[head as number], rest, key, value);
    return arr;
  }
  if (root !== null && typeof root === 'object') {
    return { ...root, [head as string]: insertAtPath((root as any)[head as string], rest, key, value) };
  }
  return root;
}

/* ── Tree Node ───────────────────────────────────── */

interface TreeNodeProps {
  keyName: string | number;
  value: JsonValue;
  path: (string | number)[];
  depth: number;
  isLast: boolean;
  onUpdate: (path: (string | number)[], value: JsonValue) => void;
  onDelete: (path: (string | number)[]) => void;
  onInsert: (path: (string | number)[], key: string | null, value: JsonValue) => void;
  accent: string;
  isLight: boolean;
  defaultExpanded: boolean;
}

function TreeNode({ keyName, value, path, depth, isLast: _isLast, onUpdate, onDelete, onInsert, accent, isLight, defaultExpanded }: TreeNodeProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState('');
  const [_editKey, _setEditKey] = useState('');
  const [adding, setAdding] = useState(false);
  const [addKey, setAddKey] = useState('');
  const [addVal, setAddVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const isObj = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isArr = Array.isArray(value);
  const isContainer = isObj || isArr;
  const childEntries = isObj ? Object.entries(value) : isArr ? value.map((v, i) => [i, v] as [number, JsonValue]) : [];

  const startEdit = () => {
    if (isContainer) return;
    setEditVal(typeof value === 'string' ? value : JSON.stringify(value));
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commitEdit = () => {
    setEditing(false);
    let parsed: JsonValue;
    // Try parsing as JSON literal first
    try {
      parsed = JSON.parse(editVal);
    } catch {
      // Treat as string
      parsed = editVal;
    }
    onUpdate(path, parsed);
  };

  const handleAddChild = () => {
    if (isArr) {
      let parsed: JsonValue;
      try { parsed = JSON.parse(addVal || '""'); } catch { parsed = addVal; }
      onInsert(path, null, parsed);
    } else if (isObj && addKey.trim()) {
      let parsed: JsonValue;
      try { parsed = JSON.parse(addVal || '""'); } catch { parsed = addVal; }
      onInsert(path, addKey.trim(), parsed);
    }
    setAdding(false);
    setAddKey('');
    setAddVal('');
  };

  const renderValue = () => {
    if (editing) {
      return (
        <input
          ref={inputRef}
          className="je-edit-input"
          value={editVal}
          onChange={e => setEditVal(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitEdit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={commitEdit}
        />
      );
    }
    if (isContainer) {
      const count = childEntries.length;
      return (
        <span className="je-container-info">
          {isArr ? `[${count}]` : `{${count}}`}
        </span>
      );
    }
    if (typeof value === 'string') return <span className="je-val je-val-str" onDoubleClick={startEdit}>"{value}"</span>;
    if (typeof value === 'number') return <span className="je-val je-val-num" onDoubleClick={startEdit}>{value}</span>;
    if (typeof value === 'boolean') return <span className="je-val je-val-bool" onDoubleClick={startEdit}>{String(value)}</span>;
    if (value === null) return <span className="je-val je-val-null" onDoubleClick={startEdit}>null</span>;
    return <span className="je-val">{String(value)}</span>;
  };

  return (
    <div className="je-node" style={{ paddingLeft: depth * 16 }}>
      <div className="je-row">
        {/* Expand/collapse toggle */}
        {isContainer ? (
          <span className="je-toggle" onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        ) : (
          <span className="je-toggle je-toggle-empty" />
        )}

        {/* Type icon */}
        {jsonTypeIcon(value)}

        {/* Key */}
        <span className="je-key">
          {typeof keyName === 'number' ? <span className="je-key-idx">{keyName}</span> : <span className="je-key-name">"{keyName}"</span>}
          <span className="je-colon">:</span>
        </span>

        {/* Value */}
        {renderValue()}

        {/* Actions */}
        <span className="je-actions">
          {!isContainer && (
            <button className="je-act-btn" onClick={startEdit} title={t('editor.editValue')}>✎</button>
          )}
          {isContainer && (
            <button className="je-act-btn" onClick={() => { setAdding(true); setExpanded(true); }} title={t('editor.addItem')}>
              <Plus size={11} />
            </button>
          )}
          <button className="je-act-btn" onClick={() => navigator.clipboard.writeText(JSON.stringify(value, null, 2))} title={t('editor.copy')}>
            <Copy size={11} />
          </button>
          <button className="je-act-btn je-act-del" onClick={() => onDelete(path)} title={t('editor.delete')}>
            <Trash2 size={11} />
          </button>
        </span>
      </div>

      {/* Children */}
      {isContainer && expanded && (
        <div className="je-children">
          {childEntries.map(([k, v], i) => (
            <TreeNode
              key={`${k}-${i}`}
              keyName={k}
              value={v as JsonValue}
              path={[...path, k]}
              depth={depth + 1}
              isLast={i === childEntries.length - 1}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onInsert={onInsert}
              accent={accent}
              isLight={isLight}
              defaultExpanded={depth < 1}
            />
          ))}
          {/* Add row */}
          {adding && (
            <div className="je-add-row" style={{ paddingLeft: (depth + 1) * 16 }}>
              {isObj && (
                <input
                  className="je-add-input"
                  placeholder="key"
                  value={addKey}
                  onChange={e => setAddKey(e.target.value)}
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleAddChild();
                    if (e.key === 'Escape') setAdding(false);
                  }}
                />
              )}
              <input
                className="je-add-input je-add-val"
                placeholder={isArr ? '값 (JSON 리터럴)' : '값'}
                value={addVal}
                onChange={e => setAddVal(e.target.value)}
                autoFocus={isArr}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleAddChild();
                  if (e.key === 'Escape') setAdding(false);
                }}
              />
              <button className="je-add-ok" onClick={handleAddChild}><Check size={12} /></button>
              <button className="je-add-cancel" onClick={() => setAdding(false)}>✕</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Main Component ──────────────────────────────── */

function JsonEditor({ content, onChange, onSave, style, fontFamily, fontSize, isLightTheme }: JsonEditorProps) {
  const { t } = useTranslation();
  const { data, error } = useMemo(() => parseJsonSafe(content), [content]);
  const [filter, setFilter] = useState('');

  const handleUpdate = useCallback((path: (string | number)[], value: JsonValue) => {
    if (data === undefined) return;
    const next = path.length === 0 ? value : setAtPath(data, path, value);
    onChange(JSON.stringify(next, null, 2));
  }, [data, onChange]);

  const handleDelete = useCallback((path: (string | number)[]) => {
    if (data === undefined || path.length === 0) return;
    const next = deleteAtPath(data, path);
    onChange(JSON.stringify(next, null, 2));
  }, [data, onChange]);

  const handleInsert = useCallback((path: (string | number)[], key: string | null, value: JsonValue) => {
    if (data === undefined) return;
    const next = insertAtPath(data, path, key, value);
    onChange(JSON.stringify(next, null, 2));
  }, [data, onChange]);

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(content);
      onChange(JSON.stringify(parsed, null, 2));
    } catch { /* ignore */ }
  };

  const handleMinify = () => {
    try {
      const parsed = JSON.parse(content);
      onChange(JSON.stringify(parsed));
    } catch { /* ignore */ }
  };

  const handleCopyAll = () => {
    navigator.clipboard.writeText(content);
  };

  // Keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        onSave?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onSave]);

  const rootIsArr = Array.isArray(data);
  const rootIsObj = data !== null && typeof data === 'object' && !rootIsArr;

  return (
    <div
      className={`je-root ${isLightTheme ? 'je-light' : 'je-dark'}`}
      style={{ '--je-accent': style.accent, '--je-bg': style.bg, '--je-text': style.text, fontFamily, fontSize } as React.CSSProperties}
    >
      {/* Toolbar */}
      <div className="je-toolbar">
        <div className="je-toolbar-left">
          <span className="je-toolbar-label">
            <Braces size={13} />
            JSON
          </span>
          {error ? (
            <span className="je-error">
              <AlertTriangle size={12} />
              {error}
            </span>
          ) : (
            <span className="je-valid">
              <Check size={12} />
              Valid
            </span>
          )}
        </div>
        <div className="je-toolbar-right">
          <input
            className="je-filter"
            placeholder="필터 (키 검색)..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
          <button className="je-btn" onClick={handleFormat} title={t('editor.format')}>
            <AlignLeft size={13} />
          </button>
          <button className="je-btn" onClick={handleMinify} title={t('editor.minify')}>
            <Minimize2 size={13} />
          </button>
          <button className="je-btn" onClick={handleCopyAll} title={t('editor.copyAll')}>
            <Copy size={13} />
          </button>
          {(rootIsObj || rootIsArr) && !error && (
            <button
              className="je-btn"
              onClick={() => handleInsert([], rootIsArr ? null : 'newKey', '')}
              title={t('editor.addRootItem')}
            >
              <Plus size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Tree */}
      <div className="je-tree">
        {error ? (
          <div className="je-parse-error">
            <AlertTriangle size={20} />
            <p>JSON 파싱 오류</p>
            <code>{error}</code>
            <p style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>소스 편집 모드로 전환하여 수정하세요</p>
          </div>
        ) : data !== null && typeof data === 'object' ? (
          (Array.isArray(data) ? data.map((v, i) => [i, v] as [number, JsonValue]) : Object.entries(data))
            .filter(([k]) => !filter || String(k).toLowerCase().includes(filter.toLowerCase()))
            .map(([k, v], i, arr) => (
              <TreeNode
                key={`${k}-${i}`}
                keyName={k}
                value={v as JsonValue}
                path={[k]}
                depth={0}
                isLast={i === arr.length - 1}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
                onInsert={handleInsert}
                accent={style.accent}
                isLight={isLightTheme}
                defaultExpanded={true}
              />
            ))
        ) : (
          <div className="je-primitive">
            {jsonTypeIcon(data!)}
            <span className={`je-val je-val-${jsonTypeLabel(data!)}`}>
              {data === null ? 'null' : typeof data === 'string' ? `"${data}"` : String(data)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default JsonEditor;
