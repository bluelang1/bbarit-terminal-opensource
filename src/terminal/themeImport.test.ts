import { describe, it, expect } from 'vitest';
import { parseWarpTheme, warpToCustomTheme } from './themeImport';

const WARP_YAML = `# A sample Warp theme
accent: "#526f76"
background: "#232323"
foreground: "#d6d6d6"
details: darker
terminal_colors:
  normal:
    black: "#2f2f2f"
    red: "#ff6565"
    green: "#4caf50"
    yellow: "#ffd54f"
    blue: "#64b5f6"
    magenta: "#ba68c8"
    cyan: "#4dd0e1"
    white: "#e0e0e0"
  bright:
    black: "#535353"
    red: "#ff8a80"
    green: "#69f0ae"
    yellow: "#ffe57f"
    blue: "#82b1ff"
    magenta: "#ea80fc"
    cyan: "#84ffff"
    white: "#ffffff"
`;

describe('parseWarpTheme', () => {
  it('should_parse_scalars_and_both_color_sections', () => {
    const parsed = parseWarpTheme(WARP_YAML);
    expect(parsed.accent).toBe('#526f76');
    expect(parsed.background).toBe('#232323');
    expect(parsed.foreground).toBe('#d6d6d6');
    expect(parsed.normal.red).toBe('#ff6565');
    expect(parsed.bright.white).toBe('#ffffff');
  });

  it('should_normalize_unquoted_and_short_hex', () => {
    const parsed = parseWarpTheme('background: 232323\nforeground: "#abc"\nterminal_colors:\n  normal:\n    black: 2f2f2f\n');
    expect(parsed.background).toBe('#232323');
    expect(parsed.foreground).toBe('#aabbcc');
    expect(parsed.normal.black).toBe('#2f2f2f');
  });

  it('should_ignore_comments_and_unknown_keys', () => {
    const parsed = parseWarpTheme('# comment\ndetails: darker\nbogus_key: nope\n');
    expect(parsed.background).toBeUndefined();
    expect(Object.keys(parsed.normal)).toHaveLength(0);
  });
});

describe('warpToCustomTheme', () => {
  it('should_build_full_16_color_theme', () => {
    const theme = warpToCustomTheme('My Theme', WARP_YAML);
    expect(theme).not.toBeNull();
    expect(theme!.id).toBe('warp-my-theme');
    expect(theme!.source).toBe('warp');
    expect(theme!.bg).toBe('#232323');
    expect(theme!.text).toBe('#d6d6d6');
    expect(theme!.accent).toBe('#526f76');
    expect(theme!.ansi).toHaveLength(16);
    expect(theme!.ansi![1]).toBe('#ff6565');   // normal red
    expect(theme!.ansi![15]).toBe('#ffffff');  // bright white
  });

  it('should_use_name_field_over_fallback_name', () => {
    const theme = warpToCustomTheme('file-name', `name: Fancy\n${WARP_YAML}`);
    expect(theme!.name).toBe('Fancy');
    expect(theme!.id).toBe('warp-fancy');
  });

  it('should_return_null_without_background_or_foreground', () => {
    expect(warpToCustomTheme('x', 'accent: "#ffffff"\n')).toBeNull();
  });

  it('should_omit_ansi_when_palette_is_incomplete', () => {
    const theme = warpToCustomTheme('x', 'background: "#000000"\nforeground: "#ffffff"\nterminal_colors:\n  normal:\n    red: "#ff0000"\n');
    expect(theme).not.toBeNull();
    expect(theme!.ansi).toBeUndefined();
    expect(theme!.accent).toBe('#ffffff'); // falls back to foreground
  });
});
