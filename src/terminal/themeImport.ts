// Warp terminal theme import — pure parser, no Tauri dependency.
// Warp themes are a small YAML subset (accent/background/foreground +
// terminal_colors.normal/bright maps).

import type { CustomTheme } from '../config/schema';

const ANSI_ORDER = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

function normalizeHex(value: string): string | null {
  let v = value.trim().replace(/^["']|["']$/g, '');
  if (!v) return null;
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  }
  return null;
}

/** Parse a Warp theme YAML (subset: scalars + terminal_colors.normal/bright maps). */
export function parseWarpTheme(text: string): {
  name?: string;
  accent?: string;
  background?: string;
  foreground?: string;
  normal: Record<string, string>;
  bright: Record<string, string>;
} {
  const out = { name: undefined as string | undefined, accent: undefined as string | undefined, background: undefined as string | undefined, foreground: undefined as string | undefined, normal: {} as Record<string, string>, bright: {} as Record<string, string> };
  let section: 'normal' | 'bright' | null = null;
  let inTerminalColors = false;
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const m = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (indent === 0) {
      inTerminalColors = key === 'terminal_colors';
      section = null;
      if (key === 'accent') out.accent = normalizeHex(value) || undefined;
      else if (key === 'background') out.background = normalizeHex(value) || undefined;
      else if (key === 'foreground') out.foreground = normalizeHex(value) || undefined;
      else if (key === 'name') out.name = value.replace(/^["']|["']$/g, '') || undefined;
    } else if (inTerminalColors && (key === 'normal' || key === 'bright') && !value) {
      section = key;
    } else if (inTerminalColors && section && (ANSI_ORDER as readonly string[]).includes(key)) {
      const hex = normalizeHex(value);
      if (hex) out[section][key] = hex;
    }
  }
  return out;
}

function makeId(source: string, name: string): string {
  return `${source}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/** Convert a Warp theme YAML into a CustomTheme. Returns null without bg+fg. */
export function warpToCustomTheme(fallbackName: string, text: string): CustomTheme | null {
  const parsed = parseWarpTheme(text);
  if (!parsed.background || !parsed.foreground) return null;
  const name = parsed.name || fallbackName;
  const normal = ANSI_ORDER.map((k) => parsed.normal[k]);
  const bright = ANSI_ORDER.map((k) => parsed.bright[k]);
  const ansi = [...normal, ...bright].every((c) => c) ? [...normal, ...bright] as string[] : undefined;
  return {
    id: makeId('warp', name),
    name,
    source: 'warp',
    bg: parsed.background,
    text: parsed.foreground,
    accent: parsed.accent || parsed.normal.blue || parsed.foreground,
    ansi,
  };
}
