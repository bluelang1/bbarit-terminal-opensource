/**
 * CssEditor.tsx
 *
 * WYSIWYG CSS visual editor with property panels, live preview,
 * and source code view. Parses CSS text into editable rules/properties
 * and generates valid CSS output.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Eye, Code2, Save, Plus, Trash2, ChevronDown, Palette,
  Type, Box, Columns3, Grid3X3, Square, Layers,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
} from 'lucide-react';
import './CssEditor.css';

/* ─────────────────── Types ─────────────────── */

export interface CssEditorProps {
  content: string;
  onChange: (css: string) => void;
  onSave?: () => void;
  style: { bg: string; text: string; accent: string };
  fontFamily: string;
  fontSize: number;
  isLightTheme: boolean;
}

interface CssProperty {
  name: string;
  value: string;
}

interface CssRule {
  selector: string;
  properties: CssProperty[];
  /** raw comment or @-rule text that we keep but don't visually edit */
  raw?: string;
}

/* ─────────────────── CSS Parser ─────────────────── */

function parseCssText(cssText: string): CssRule[] {
  const rules: CssRule[] = [];
  const text = cssText.trim();
  if (!text) return rules;

  let i = 0;
  const len = text.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && /\s/.test(text[i])) i++;
    if (i >= len) break;

    // Collect comment blocks as raw
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const commentEnd = end === -1 ? len : end + 2;
      const raw = text.slice(i, commentEnd);
      rules.push({ selector: '/* comment */', properties: [], raw });
      i = commentEnd;
      continue;
    }

    // Collect @-rules that have braces (like @media)
    if (text[i] === '@') {
      // Find the opening brace or semicolon
      let depth = 0;
      let j = i;
      let foundBrace = false;
      while (j < len) {
        if (text[j] === '{') {
          depth++;
          foundBrace = true;
        } else if (text[j] === '}') {
          depth--;
          if (depth === 0) { j++; break; }
        } else if (text[j] === ';' && !foundBrace) {
          j++;
          break;
        }
        j++;
      }
      const raw = text.slice(i, j);
      rules.push({ selector: raw.split('{')[0].trim() || '@rule', properties: [], raw });
      i = j;
      continue;
    }

    // Normal rule: selector { properties }
    const braceStart = text.indexOf('{', i);
    if (braceStart === -1) break;

    const selector = text.slice(i, braceStart).trim();

    // Find matching close brace
    let depth = 1;
    let j = braceStart + 1;
    while (j < len && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }

    const bodyText = text.slice(braceStart + 1, j - 1).trim();
    const properties: CssProperty[] = [];

    // Parse properties
    const declarations = bodyText.split(';');
    for (const decl of declarations) {
      const trimmed = decl.trim();
      if (!trimmed) continue;
      // Skip inline comments
      if (trimmed.startsWith('/*')) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const name = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      if (name) properties.push({ name, value });
    }

    if (selector) {
      rules.push({ selector, properties });
    }
    i = j;
  }

  return rules;
}

function serializeCssRules(rules: CssRule[]): string {
  const parts: string[] = [];

  for (const rule of rules) {
    if (rule.raw != null) {
      parts.push(rule.raw);
      continue;
    }
    if (rule.properties.length === 0) {
      parts.push(`${rule.selector} {\n}`);
      continue;
    }
    const body = rule.properties
      .map(p => `  ${p.name}: ${p.value};`)
      .join('\n');
    parts.push(`${rule.selector} {\n${body}\n}`);
  }

  return parts.join('\n\n') + '\n';
}

/* ─────────────────── Property categorization ─────────────────── */

type Category = 'colors' | 'typography' | 'dimensions' | 'spacing' | 'border' | 'shadow' | 'flexbox' | 'grid' | 'other';

const CATEGORY_MAP: Record<string, Category> = {
  'color': 'colors', 'background-color': 'colors', 'background': 'colors',
  'border-color': 'colors', 'outline-color': 'colors', 'opacity': 'colors',
  'font-family': 'typography', 'font-size': 'typography', 'font-weight': 'typography',
  'font-style': 'typography', 'line-height': 'typography', 'letter-spacing': 'typography',
  'word-spacing': 'typography', 'text-align': 'typography', 'text-decoration': 'typography',
  'text-transform': 'typography', 'text-indent': 'typography', 'white-space': 'typography',
  'text-overflow': 'typography', 'text-shadow': 'typography',
  'width': 'dimensions', 'height': 'dimensions', 'min-width': 'dimensions',
  'max-width': 'dimensions', 'min-height': 'dimensions', 'max-height': 'dimensions',
  'overflow': 'dimensions', 'overflow-x': 'dimensions', 'overflow-y': 'dimensions',
  'margin': 'spacing', 'margin-top': 'spacing', 'margin-right': 'spacing',
  'margin-bottom': 'spacing', 'margin-left': 'spacing',
  'padding': 'spacing', 'padding-top': 'spacing', 'padding-right': 'spacing',
  'padding-bottom': 'spacing', 'padding-left': 'spacing',
  'border': 'border', 'border-width': 'border', 'border-style': 'border',
  'border-radius': 'border', 'border-top': 'border', 'border-bottom': 'border',
  'border-left': 'border', 'border-right': 'border',
  'border-top-left-radius': 'border', 'border-top-right-radius': 'border',
  'border-bottom-left-radius': 'border', 'border-bottom-right-radius': 'border',
  'outline': 'border', 'outline-width': 'border', 'outline-style': 'border',
  'box-shadow': 'shadow',
  'display': 'flexbox', 'flex-direction': 'flexbox', 'flex-wrap': 'flexbox',
  'justify-content': 'flexbox', 'align-items': 'flexbox', 'align-content': 'flexbox',
  'align-self': 'flexbox', 'flex': 'flexbox', 'flex-grow': 'flexbox',
  'flex-shrink': 'flexbox', 'flex-basis': 'flexbox', 'order': 'flexbox', 'gap': 'flexbox',
  'row-gap': 'flexbox', 'column-gap': 'flexbox',
  'grid-template-columns': 'grid', 'grid-template-rows': 'grid',
  'grid-column': 'grid', 'grid-row': 'grid', 'grid-gap': 'grid',
  'grid-template-areas': 'grid', 'grid-area': 'grid',
  'grid-auto-flow': 'grid', 'grid-auto-columns': 'grid', 'grid-auto-rows': 'grid',
};

function categorizeProperty(name: string): Category {
  return CATEGORY_MAP[name] || 'other';
}

const CATEGORY_LABELS: Record<Category, string> = {
  colors: 'Colors',
  typography: 'Typography',
  dimensions: 'Dimensions',
  spacing: 'Spacing',
  border: 'Border & Outline',
  shadow: 'Shadow',
  flexbox: 'Flexbox / Layout',
  grid: 'Grid',
  other: 'Other',
};

const CATEGORY_ICONS: Record<Category, React.ReactNode> = {
  colors: <Palette size={12} />,
  typography: <Type size={12} />,
  dimensions: <Box size={12} />,
  spacing: <Layers size={12} />,
  border: <Square size={12} />,
  shadow: <Layers size={12} />,
  flexbox: <Columns3 size={12} />,
  grid: <Grid3X3 size={12} />,
  other: <Code2 size={12} />,
};

const CATEGORY_ORDER: Category[] = ['colors', 'typography', 'dimensions', 'spacing', 'border', 'shadow', 'flexbox', 'grid', 'other'];

/* ─────────────────── Helpers ─────────────────── */

function isColorValue(val: string): boolean {
  if (!val) return false;
  const v = val.trim().toLowerCase();
  return v.startsWith('#') || v.startsWith('rgb') || v.startsWith('hsl') ||
    ['red', 'blue', 'green', 'white', 'black', 'transparent', 'currentcolor',
     'inherit', 'initial', 'unset', 'yellow', 'orange', 'purple', 'pink',
     'gray', 'grey', 'cyan', 'magenta', 'brown', 'navy', 'teal',
     'olive', 'maroon', 'aqua', 'lime', 'silver', 'fuchsia'].includes(v);
}

function isColorProperty(name: string): boolean {
  return ['color', 'background-color', 'background', 'border-color',
    'outline-color', 'text-decoration-color', 'caret-color',
    'column-rule-color', 'fill', 'stroke'].includes(name);
}

function cssToHex(val: string): string {
  if (!val) return '#000000';
  const v = val.trim();
  if (v.startsWith('#')) {
    if (v.length === 4) {
      // #abc -> #aabbcc
      return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    }
    return v.slice(0, 7);
  }
  // Try to parse rgb()
  const rgbMatch = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
    const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
    const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return '#000000';
}

function parseValueUnit(val: string): { num: number; unit: string } {
  const match = val.trim().match(/^(-?[\d.]+)\s*(px|em|rem|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|fr|s|ms|deg)?$/);
  if (match) {
    return { num: parseFloat(match[1]), unit: match[2] || 'px' };
  }
  return { num: 0, unit: 'px' };
}

const CSS_UNITS = ['px', 'em', 'rem', '%', 'vh', 'vw', 'vmin', 'vmax', 'ch', 'auto'];

const FONT_WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900', 'normal', 'bold', 'lighter', 'bolder'];

const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'];

const DISPLAY_VALUES = ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'none', 'contents', 'table', 'flow-root'];

const FLEX_DIRECTIONS = ['row', 'row-reverse', 'column', 'column-reverse'];

const FLEX_WRAPS = ['nowrap', 'wrap', 'wrap-reverse'];

const JUSTIFY_CONTENTS = ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly', 'start', 'end'];

const ALIGN_ITEMS_VALUES = ['flex-start', 'flex-end', 'center', 'stretch', 'baseline', 'start', 'end'];

const BORDER_STYLES = ['none', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'];

const OVERFLOW_VALUES = ['visible', 'hidden', 'scroll', 'auto', 'clip'];

const TEXT_TRANSFORMS = ['none', 'uppercase', 'lowercase', 'capitalize'];

const TEXT_DECORATIONS = ['none', 'underline', 'overline', 'line-through'];

const WHITESPACE_VALUES = ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'];

const COMMON_PROPERTIES = [
  'color', 'background-color', 'background',
  'font-size', 'font-weight', 'font-family', 'line-height', 'text-align',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-radius', 'border-color', 'border-width', 'border-style',
  'box-shadow', 'text-shadow', 'opacity',
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'flex-direction', 'justify-content', 'align-items', 'gap', 'flex-wrap',
  'grid-template-columns', 'grid-template-rows',
  'overflow', 'cursor', 'transition', 'transform',
  'text-decoration', 'text-transform', 'letter-spacing', 'word-spacing',
  'white-space', 'text-overflow',
];

/* ─────────────────── Sub-components ─────────────────── */

interface PropertyEditorRowProps {
  prop: CssProperty;
  onValueChange: (value: string) => void;
  onNameChange: (name: string) => void;
  onDelete: () => void;
  isLightTheme: boolean;
}

function PropertyEditorRow({ prop, onValueChange, onNameChange: _onNameChange, onDelete, isLightTheme: _isLightTheme }: PropertyEditorRowProps) {
  const isColor = isColorProperty(prop.name) || isColorValue(prop.value);
  const { num, unit } = parseValueUnit(prop.value);
  const isNumericValue = /^-?[\d.]+\s*(px|em|rem|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|fr|s|ms|deg)?$/.test(prop.value.trim());

  // Select-type properties
  if (prop.name === 'font-weight') {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <select className="ce-prop-select" value={prop.value} onChange={(e) => onValueChange(e.target.value)}>
          {FONT_WEIGHTS.map(w => <option key={w} value={w}>{w}</option>)}
        </select>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  if (prop.name === 'text-align') {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <div className="ce-flex-row">
          {TEXT_ALIGNS.map(a => {
            const Icon = a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : a === 'right' ? AlignRight : AlignJustify;
            return (
              <button key={a} className={`ce-flex-btn ${prop.value === a ? 'active' : ''}`}
                onClick={() => onValueChange(a)} title={a}>
                <Icon size={12} />
              </button>
            );
          })}
        </div>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  if (prop.name === 'display') {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <select className="ce-prop-select" value={prop.value} onChange={(e) => onValueChange(e.target.value)}>
          {DISPLAY_VALUES.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  if (prop.name === 'flex-direction') {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <select className="ce-prop-select" value={prop.value} onChange={(e) => onValueChange(e.target.value)}>
          {FLEX_DIRECTIONS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  if (prop.name === 'flex-wrap') {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <select className="ce-prop-select" value={prop.value} onChange={(e) => onValueChange(e.target.value)}>
          {FLEX_WRAPS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  if (prop.name === 'justify-content') {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <select className="ce-prop-select" value={prop.value} onChange={(e) => onValueChange(e.target.value)}>
          {JUSTIFY_CONTENTS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  if (prop.name === 'align-items' || prop.name === 'align-self' || prop.name === 'align-content') {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <select className="ce-prop-select" value={prop.value} onChange={(e) => onValueChange(e.target.value)}>
          {ALIGN_ITEMS_VALUES.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  if (prop.name === 'border-style' || prop.name === 'outline-style') {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <select className="ce-prop-select" value={prop.value} onChange={(e) => onValueChange(e.target.value)}>
          {BORDER_STYLES.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  if (prop.name === 'overflow' || prop.name === 'overflow-x' || prop.name === 'overflow-y') {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <select className="ce-prop-select" value={prop.value} onChange={(e) => onValueChange(e.target.value)}>
          {OVERFLOW_VALUES.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  if (prop.name === 'text-transform') {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <select className="ce-prop-select" value={prop.value} onChange={(e) => onValueChange(e.target.value)}>
          {TEXT_TRANSFORMS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  if (prop.name === 'text-decoration') {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <select className="ce-prop-select" value={prop.value} onChange={(e) => onValueChange(e.target.value)}>
          {TEXT_DECORATIONS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  if (prop.name === 'white-space') {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <select className="ce-prop-select" value={prop.value} onChange={(e) => onValueChange(e.target.value)}>
          {WHITESPACE_VALUES.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  // Color properties
  if (isColor) {
    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <input
          type="color"
          className="ce-color-swatch"
          value={cssToHex(prop.value)}
          onChange={(e) => onValueChange(e.target.value)}
          title={prop.value}
        />
        <input
          className="ce-prop-input"
          value={prop.value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder="#000000"
        />
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  // Numeric properties with slider
  if (isNumericValue) {
    const maxVal = unit === '%' ? 100 :
      unit === 'em' || unit === 'rem' ? 10 :
      (prop.name.includes('opacity') ? 1 : 500);
    const step = unit === 'em' || unit === 'rem' ? 0.1 :
      prop.name === 'opacity' ? 0.01 : 1;

    return (
      <div className="ce-prop-row">
        <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
        <div className="ce-slider-wrap">
          <input
            type="range"
            min={prop.name === 'opacity' ? 0 : -100}
            max={maxVal}
            step={step}
            value={num}
            onChange={(e) => {
              const newVal = parseFloat(e.target.value);
              onValueChange(`${newVal}${unit}`);
            }}
          />
          <span className="ce-slider-val">{num}{unit}</span>
        </div>
        <select
          className="ce-unit-select"
          value={unit}
          onChange={(e) => onValueChange(`${num}${e.target.value}`)}
        >
          {CSS_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
      </div>
    );
  }

  // Fallback: plain text input
  return (
    <div className="ce-prop-row">
      <span className="ce-prop-label" title={prop.name}>{prop.name}</span>
      <input
        className="ce-prop-input"
        value={prop.value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder="value"
      />
      <button className="ce-prop-delete" onClick={onDelete} title="Remove property">&times;</button>
    </div>
  );
}

/* ─────────────────── Add Property Picker ─────────────────── */

function AddPropertyPicker({ existingNames, onAdd }: { existingNames: string[]; onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const available = useMemo(() =>
    COMMON_PROPERTIES.filter(p => !existingNames.includes(p) && p.includes(filter.toLowerCase())),
    [existingNames, filter]
  );

  if (!open) {
    return (
      <div className="ce-add-prop-row">
        <button className="ce-add-prop-btn" onClick={() => setOpen(true)}>
          <Plus size={10} /> Add property
        </button>
      </div>
    );
  }

  return (
    <div className="ce-add-prop-row" ref={ref}>
      <input
        className="ce-prop-input"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search property..."
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && filter.trim()) {
            onAdd(filter.trim());
            setFilter('');
            setOpen(false);
          }
        }}
        style={{ maxWidth: 200 }}
      />
      <div style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        zIndex: 50,
        background: 'var(--bg, #1e1e1e)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 'var(--brutal-radius)',
        maxHeight: 200,
        overflowY: 'auto',
        minWidth: 180,
        fontSize: 11,
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      }}>
        {available.slice(0, 30).map(p => (
          <div
            key={p}
            style={{ padding: '4px 8px', cursor: 'pointer', fontFamily: 'monospace' }}
            onClick={() => { onAdd(p); setFilter(''); setOpen(false); }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'rgba(100,180,255,0.15)'; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
          >
            {p}
          </div>
        ))}
        {available.length === 0 && (
          <div style={{ padding: '8px', opacity: 0.5, fontStyle: 'italic' }}>
            {filter ? 'Press Enter to add custom property' : 'No properties available'}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────── Box Model Diagram ─────────────────── */

interface BoxModelProps {
  properties: CssProperty[];
  onPropertyChange: (name: string, value: string) => void;
}

function BoxModelDiagram({ properties, onPropertyChange }: BoxModelProps) {
  const getVal = (name: string) => {
    const p = properties.find(pp => pp.name === name);
    return p ? parseValueUnit(p.value).num.toString() : '0';
  };

  const setVal = (name: string, val: string) => {
    const num = parseInt(val) || 0;
    onPropertyChange(name, `${num}px`);
  };

  return (
    <div className="ce-box-model">
      <div className="ce-box-model-diagram">
        <div className="ce-box-model-layer margin-layer">
          <span className="ce-box-label" style={{ top: 2, left: 4 }}>margin</span>
        </div>
        <div className="ce-box-model-layer border-layer">
          <span className="ce-box-label" style={{ top: 2, left: 4 }}>border</span>
        </div>
        <div className="ce-box-model-layer padding-layer">
          <span className="ce-box-label" style={{ top: 2, left: 4 }}>padding</span>
        </div>
        <div className="ce-box-model-layer content-layer">content</div>

        {/* Margin inputs */}
        <input className="ce-box-model-input" style={{ top: 2, left: '50%', transform: 'translateX(-50%)' }}
          value={getVal('margin-top')} onChange={e => setVal('margin-top', e.target.value)} title="margin-top" />
        <input className="ce-box-model-input" style={{ bottom: 2, left: '50%', transform: 'translateX(-50%)' }}
          value={getVal('margin-bottom')} onChange={e => setVal('margin-bottom', e.target.value)} title="margin-bottom" />
        <input className="ce-box-model-input" style={{ top: '50%', left: 2, transform: 'translateY(-50%)' }}
          value={getVal('margin-left')} onChange={e => setVal('margin-left', e.target.value)} title="margin-left" />
        <input className="ce-box-model-input" style={{ top: '50%', right: 2, transform: 'translateY(-50%)' }}
          value={getVal('margin-right')} onChange={e => setVal('margin-right', e.target.value)} title="margin-right" />

        {/* Padding inputs */}
        <input className="ce-box-model-input" style={{ top: 42, left: '50%', transform: 'translateX(-50%)' }}
          value={getVal('padding-top')} onChange={e => setVal('padding-top', e.target.value)} title="padding-top" />
        <input className="ce-box-model-input" style={{ bottom: 42, left: '50%', transform: 'translateX(-50%)' }}
          value={getVal('padding-bottom')} onChange={e => setVal('padding-bottom', e.target.value)} title="padding-bottom" />
        <input className="ce-box-model-input" style={{ top: '50%', left: 42, transform: 'translateY(-50%)' }}
          value={getVal('padding-left')} onChange={e => setVal('padding-left', e.target.value)} title="padding-left" />
        <input className="ce-box-model-input" style={{ top: '50%', right: 42, transform: 'translateY(-50%)' }}
          value={getVal('padding-right')} onChange={e => setVal('padding-right', e.target.value)} title="padding-right" />
      </div>
    </div>
  );
}

/* ─────────────────── Main CssEditor Component ─────────────────── */

export const CssEditor: React.FC<CssEditorProps> = React.memo(function CssEditor({
  content,
  onChange,
  onSave,
  style,
  fontFamily,
  fontSize,
  isLightTheme,
}) {
  const [mode, setMode] = useState<'visual' | 'source'>('visual');
  const [rules, setRules] = useState<CssRule[]>(() => parseCssText(content));
  const [selectedRuleIdx, setSelectedRuleIdx] = useState(0);
  const [collapsedSections, setCollapsedSections] = useState<Set<Category>>(new Set());
  const [sourceText, setSourceText] = useState(content);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const lastSerializedRef = useRef(content);
  const suppressSyncRef = useRef(false);

  // Sync from prop content -> internal state (when content changes externally)
  useEffect(() => {
    if (suppressSyncRef.current) {
      suppressSyncRef.current = false;
      return;
    }
    const newRules = parseCssText(content);
    setRules(newRules);
    setSourceText(content);
    lastSerializedRef.current = content;
    // clamp selection
    if (selectedRuleIdx >= newRules.length) {
      setSelectedRuleIdx(Math.max(0, newRules.length - 1));
    }
  }, [content]); // eslint-disable-line react-hooks/exhaustive-deps

  // Emit changes upstream
  const emitChange = useCallback((newRules: CssRule[]) => {
    const css = serializeCssRules(newRules);
    lastSerializedRef.current = css;
    suppressSyncRef.current = true;
    onChange(css);
  }, [onChange]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === 's') {
        e.preventDefault();
        onSave?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onSave]);

  // Toggle section collapse
  const toggleSection = useCallback((cat: Category) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  // Current selected rule
  const selectedRule = rules[selectedRuleIdx];
  const editableRules = rules.filter(r => r.raw == null);

  // Update a property value in the selected rule
  const updateProperty = useCallback((propIdx: number, field: 'name' | 'value', newVal: string) => {
    setRules(prev => {
      const next = prev.map((r, ri) => {
        if (ri !== selectedRuleIdx) return r;
        const newProps = r.properties.map((p, pi) => {
          if (pi !== propIdx) return p;
          return field === 'name' ? { ...p, name: newVal } : { ...p, value: newVal };
        });
        return { ...r, properties: newProps };
      });
      emitChange(next);
      return next;
    });
  }, [selectedRuleIdx, emitChange]);

  // Delete a property
  const deleteProperty = useCallback((propIdx: number) => {
    setRules(prev => {
      const next = prev.map((r, ri) => {
        if (ri !== selectedRuleIdx) return r;
        return { ...r, properties: r.properties.filter((_, pi) => pi !== propIdx) };
      });
      emitChange(next);
      return next;
    });
  }, [selectedRuleIdx, emitChange]);

  // Add a property
  const addProperty = useCallback((name: string) => {
    const defaultValues: Record<string, string> = {
      'color': '#333333', 'background-color': '#ffffff', 'background': '#ffffff',
      'font-size': '16px', 'font-weight': '400', 'line-height': '1.5',
      'width': '100%', 'height': 'auto',
      'margin': '0', 'padding': '0',
      'border': '1px solid #ccc', 'border-radius': '4px',
      'display': 'flex', 'flex-direction': 'row', 'justify-content': 'flex-start',
      'align-items': 'stretch', 'gap': '8px', 'flex-wrap': 'nowrap',
      'opacity': '1', 'box-shadow': '0 2px 4px rgba(0,0,0,0.1)',
      'text-align': 'left', 'text-decoration': 'none', 'text-transform': 'none',
      'overflow': 'visible', 'cursor': 'pointer', 'position': 'relative',
      'z-index': '1', 'transition': 'all 0.2s ease',
      'grid-template-columns': '1fr 1fr', 'grid-template-rows': 'auto',
      'letter-spacing': '0px', 'word-spacing': '0px',
      'white-space': 'normal', 'text-overflow': 'ellipsis',
      'border-style': 'solid', 'border-width': '1px', 'border-color': '#cccccc',
      'outline': 'none', 'outline-style': 'none',
      'min-width': '0', 'max-width': 'none', 'min-height': '0', 'max-height': 'none',
    };
    setRules(prev => {
      const next = prev.map((r, ri) => {
        if (ri !== selectedRuleIdx) return r;
        return { ...r, properties: [...r.properties, { name, value: defaultValues[name] || '' }] };
      });
      emitChange(next);
      return next;
    });
  }, [selectedRuleIdx, emitChange]);

  // Update property by name (for BoxModel)
  const updatePropertyByName = useCallback((propName: string, value: string) => {
    setRules(prev => {
      const next = prev.map((r, ri) => {
        if (ri !== selectedRuleIdx) return r;
        const existingIdx = r.properties.findIndex(p => p.name === propName);
        if (existingIdx >= 0) {
          const newProps = r.properties.map((p, pi) =>
            pi === existingIdx ? { ...p, value } : p
          );
          return { ...r, properties: newProps };
        }
        return { ...r, properties: [...r.properties, { name: propName, value }] };
      });
      emitChange(next);
      return next;
    });
  }, [selectedRuleIdx, emitChange]);

  // Update selector
  const updateSelector = useCallback((newSelector: string) => {
    setRules(prev => {
      const next = prev.map((r, ri) => ri === selectedRuleIdx ? { ...r, selector: newSelector } : r);
      emitChange(next);
      return next;
    });
  }, [selectedRuleIdx, emitChange]);

  // Add new rule
  const addRule = useCallback(() => {
    setRules(prev => {
      const next = [...prev, { selector: '.new-class', properties: [] }];
      emitChange(next);
      setSelectedRuleIdx(next.length - 1);
      return next;
    });
  }, [emitChange]);

  // Delete rule
  const deleteRule = useCallback((idx: number) => {
    setRules(prev => {
      const next = prev.filter((_, i) => i !== idx);
      emitChange(next);
      if (selectedRuleIdx >= next.length) setSelectedRuleIdx(Math.max(0, next.length - 1));
      return next;
    });
  }, [selectedRuleIdx, emitChange]);

  // Source mode: apply source text back to rules
  const applySourceText = useCallback((text: string) => {
    setSourceText(text);
    const newRules = parseCssText(text);
    setRules(newRules);
    suppressSyncRef.current = true;
    onChange(text);
    lastSerializedRef.current = text;
  }, [onChange]);

  // Group properties by category
  const groupedProperties = useMemo(() => {
    if (!selectedRule || selectedRule.raw != null) return new Map<Category, { prop: CssProperty; idx: number }[]>();
    const groups = new Map<Category, { prop: CssProperty; idx: number }[]>();
    selectedRule.properties.forEach((prop, idx) => {
      const cat = categorizeProperty(prop.name);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push({ prop, idx });
    });
    return groups;
  }, [selectedRule]);

  // Compute preview style from selected rule
  const previewStyle = useMemo(() => {
    if (!selectedRule || selectedRule.raw != null) return {};
    const s: Record<string, string> = {};
    for (const p of selectedRule.properties) {
      // Convert CSS property name to camelCase
      const camel = p.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      s[camel] = p.value;
    }
    return s;
  }, [selectedRule]);

  // Count stats
  const ruleCount = editableRules.length;
  const propCount = selectedRule?.properties.length ?? 0;

  return (
    <div className={`ce-root ${isLightTheme ? 'ce-light' : ''}`} style={{ color: style.text, fontFamily, fontSize }}>
      {/* Toolbar */}
      <div className="ce-toolbar">
        <div className="ce-toolbar-group">
          <button className={`ce-btn ${mode === 'visual' ? 'active' : ''}`}
            onClick={() => {
              if (mode === 'source') {
                // Switching from source to visual: parse the source text
                const newRules = parseCssText(sourceText);
                setRules(newRules);
                if (selectedRuleIdx >= newRules.length) setSelectedRuleIdx(Math.max(0, newRules.length - 1));
              }
              setMode('visual');
            }}
            title="Visual editor mode">
            <Eye size={13} /> Visual
          </button>
          <button className={`ce-btn ${mode === 'source' ? 'active' : ''}`}
            onClick={() => {
              if (mode === 'visual') {
                // Switching from visual to source: serialize current rules
                setSourceText(serializeCssRules(rules));
              }
              setMode('source');
            }}
            title="Source code mode">
            <Code2 size={13} /> Source
          </button>
        </div>
        <div className="ce-toolbar-sep" />

        <div className="ce-toolbar-group">
          <button className="ce-btn" onClick={addRule} title="Add new CSS rule">
            <Plus size={13} /> Rule
          </button>
        </div>
        <div className="ce-toolbar-sep" />

        <div className="ce-toolbar-group" style={{ marginLeft: 'auto' }}>
          <button className="ce-btn ce-btn-primary" onClick={() => onSave?.()} title="Save (Cmd+S)">
            <Save size={13} /> Save
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="ce-body">
        {mode === 'source' ? (
          /* Source Mode */
          <div className="ce-source-panel">
            <textarea
              ref={sourceRef}
              className="ce-source-textarea"
              value={sourceText}
              onChange={(e) => applySourceText(e.target.value)}
              style={{ fontFamily: `'JetBrains Mono', 'Fira Code', ${fontFamily}, monospace`, fontSize }}
              spellCheck={false}
              placeholder="/* Write your CSS here */\n\n.example {\n  color: #333;\n  font-size: 16px;\n}"
            />
          </div>
        ) : (
          <>
            {/* Rules Sidebar */}
            <div className="ce-rules-sidebar">
              <div className="ce-rules-header">
                <span>Selectors</span>
                <span>{ruleCount}</span>
              </div>
              <div className="ce-rules-list">
                {rules.map((rule, idx) => (
                  <div
                    key={idx}
                    className={`ce-rule-item ${idx === selectedRuleIdx ? 'active' : ''}`}
                    onClick={() => setSelectedRuleIdx(idx)}
                    title={rule.raw ? '(non-editable)' : rule.selector}
                  >
                    <span style={{ opacity: rule.raw != null ? 0.4 : 1 }}>
                      {rule.raw != null ? (rule.selector.length > 20 ? rule.selector.slice(0, 20) + '...' : rule.selector) : rule.selector}
                    </span>
                    <span className="ce-rule-count">{rule.raw == null ? rule.properties.length : ''}</span>
                  </div>
                ))}
                {rules.length === 0 && (
                  <div style={{ padding: 12, opacity: 0.4, fontSize: 11, textAlign: 'center' }}>
                    No rules. Click "+ Rule" to add.
                  </div>
                )}
              </div>
            </div>

            {/* Visual Property Panels */}
            <div className="ce-visual-panel">
              {selectedRule && selectedRule.raw == null ? (
                <>
                  {/* Selector editor */}
                  <div className="ce-section">
                    <div className="ce-section-header" style={{ cursor: 'default' }}>
                      <span>Selector</span>
                      <button className="ce-btn" style={{ padding: '1px 4px', fontSize: 10 }}
                        onClick={() => deleteRule(selectedRuleIdx)} title="Delete this rule">
                        <Trash2 size={10} />
                      </button>
                    </div>
                    <div className="ce-section-body">
                      <div className="ce-prop-row">
                        <input
                          className="ce-prop-input"
                          value={selectedRule.selector}
                          onChange={(e) => updateSelector(e.target.value)}
                          style={{ fontFamily: 'monospace', fontWeight: 600 }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Box Model (if spacing props exist or always show) */}
                  <div className="ce-section">
                    <div className="ce-section-header" onClick={() => toggleSection('spacing')}>
                      <span>{CATEGORY_ICONS.spacing} Box Model</span>
                      <ChevronDown size={12} className={`ce-chevron ${collapsedSections.has('spacing') ? 'collapsed' : ''}`} />
                    </div>
                    {!collapsedSections.has('spacing') && (
                      <div className="ce-section-body">
                        <BoxModelDiagram
                          properties={selectedRule.properties}
                          onPropertyChange={updatePropertyByName}
                        />
                      </div>
                    )}
                  </div>

                  {/* Property sections by category */}
                  {CATEGORY_ORDER.map(cat => {
                    const items = groupedProperties.get(cat);
                    if (!items || items.length === 0) return null;
                    const collapsed = collapsedSections.has(cat);

                    return (
                      <div key={cat} className="ce-section">
                        <div className="ce-section-header" onClick={() => toggleSection(cat)}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}
                            <span style={{ fontSize: 9, opacity: 0.5 }}>({items.length})</span>
                          </span>
                          <ChevronDown size={12} className={`ce-chevron ${collapsed ? 'collapsed' : ''}`} />
                        </div>
                        {!collapsed && (
                          <div className="ce-section-body">
                            {items.map(({ prop, idx }) => (
                              <PropertyEditorRow
                                key={`${idx}-${prop.name}`}
                                prop={prop}
                                onValueChange={(v) => updateProperty(idx, 'value', v)}
                                onNameChange={(n) => updateProperty(idx, 'name', n)}
                                onDelete={() => deleteProperty(idx)}
                                isLightTheme={isLightTheme}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Add property */}
                  <div style={{ position: 'relative' }}>
                    <AddPropertyPicker
                      existingNames={selectedRule.properties.map(p => p.name)}
                      onAdd={addProperty}
                    />
                  </div>
                </>
              ) : selectedRule?.raw != null ? (
                <div style={{ padding: 20, opacity: 0.5, fontStyle: 'italic', textAlign: 'center' }}>
                  This block ({selectedRule.selector}) is not editable in visual mode.
                  <br />Switch to Source mode to edit.
                </div>
              ) : (
                <div style={{ padding: 20, opacity: 0.5, textAlign: 'center' }}>
                  No rule selected. Add a rule to start editing.
                </div>
              )}
            </div>

            {/* Preview Panel */}
            <div className="ce-preview-panel">
              <div className="ce-preview-header">
                <span>Live Preview</span>
              </div>
              <div className="ce-preview-frame" style={{ background: isLightTheme ? '#ffffff' : '#1a1a2e' }}>
                {selectedRule && selectedRule.raw == null ? (
                  <div className="ce-preview-el" style={previewStyle}>
                    <div style={{ padding: previewStyle.padding ? undefined : '16px 24px' }}>
                      Sample Element
                      <div style={{ fontSize: '0.8em', opacity: 0.6, marginTop: 4 }}>
                        {selectedRule.selector}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ opacity: 0.4, fontSize: 11 }}>Select a rule to preview</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Status Bar */}
      <div className="ce-status-bar">
        <span>{mode === 'visual' ? 'Visual' : 'Source'}</span>
        <span className="ce-status-sep" />
        <span>{ruleCount} rule{ruleCount !== 1 ? 's' : ''}</span>
        <span className="ce-status-sep" />
        <span>{propCount} propert{propCount !== 1 ? 'ies' : 'y'}</span>
        <span style={{ marginLeft: 'auto' }}>CSS</span>
      </div>
    </div>
  );
});

export default CssEditor;
