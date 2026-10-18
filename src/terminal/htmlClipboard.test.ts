import { describe, it, expect } from 'vitest';
import { htmlClipboardToText } from './htmlClipboard';

describe('htmlClipboardToText', () => {
  it('should_convert_table_to_markdown_pipes', () => {
    const html = '<table><tbody><tr><th>이름</th><th>역할</th></tr><tr><td>조훈상</td><td>개발</td></tr></tbody></table>';
    expect(htmlClipboardToText(html)).toBe(
      '| 이름 | 역할 |\n| --- | --- |\n| 조훈상 | 개발 |',
    );
  });

  it('should_handle_thead_tbody_and_uneven_rows', () => {
    const html = '<table><thead><tr><th>a</th><th>b</th><th>c</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
    expect(htmlClipboardToText(html)).toBe(
      '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |  |',
    );
  });

  it('should_escape_pipes_inside_cells', () => {
    const html = '<table><tr><td>a|b</td><td>c</td></tr></table>';
    expect(htmlClipboardToText(html)).toContain('| a\\|b | c |');
  });

  it('should_flatten_cell_line_breaks_to_spaces', () => {
    const html = '<table><tr><td>one<br>two</td><td>x</td></tr></table>';
    expect(htmlClipboardToText(html)).toContain('| one two | x |');
  });

  it('should_convert_paragraphs_and_br_to_newlines', () => {
    const html = '<p>첫 문단</p><p>둘째<br>셋째</p>';
    expect(htmlClipboardToText(html)).toBe('첫 문단\n\n둘째\n셋째');
  });

  it('should_convert_list_items_to_dashes', () => {
    const html = '<ul><li>하나</li><li>둘</li></ul>';
    expect(htmlClipboardToText(html)).toBe('- 하나\n- 둘');
  });

  it('should_strip_style_and_script_content', () => {
    const html = '<style>.x{color:red}</style><script>alert(1)</script><p>본문</p>';
    expect(htmlClipboardToText(html)).toBe('본문');
  });

  it('should_decode_entities', () => {
    const html = '<p>a &lt; b &amp; c</p>';
    expect(htmlClipboardToText(html)).toBe('a < b & c');
  });

  it('should_keep_text_around_a_table', () => {
    const html = '<p>before</p><table><tr><td>x</td></tr></table><p>after</p>';
    expect(htmlClipboardToText(html)).toBe('before\n\n| x |\n| --- |\n\nafter');
  });

  it('should_return_empty_for_empty_or_whitespace_html', () => {
    expect(htmlClipboardToText('')).toBe('');
    expect(htmlClipboardToText('<div>   </div>')).toBe('');
  });

  it('should_flatten_nested_table_inside_cell', () => {
    const html = '<table><tr><td><table><tr><td>in</td></tr></table></td><td>out</td></tr></table>';
    const out = htmlClipboardToText(html);
    expect(out.split('\n')[0]).toContain('out');
  });
});
