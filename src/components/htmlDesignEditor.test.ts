import { describe, expect, it } from 'vitest';
import { extractDoctype, serializeHtmlWithDoctype } from './HtmlDesignEditor';

describe('extractDoctype', () => {
  it('extracts a standard HTML5 doctype', () => {
    expect(extractDoctype('<!DOCTYPE html>\n<html></html>')).toBe('<!DOCTYPE html>');
  });

  it('is case-insensitive and tolerates leading whitespace', () => {
    expect(extractDoctype('  \n<!doctype HTML>\n<html>')).toBe('<!doctype HTML>');
  });

  it('extracts a legacy doctype with public/system ids', () => {
    const legacy = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "x.dtd">';
    expect(extractDoctype(`${legacy}<html>`)).toBe(legacy);
  });

  it('returns empty string when there is no doctype', () => {
    expect(extractDoctype('<html><body></body></html>')).toBe('');
  });
});

describe('serializeHtmlWithDoctype', () => {
  it('prepends the doctype when present', () => {
    expect(serializeHtmlWithDoctype('<!DOCTYPE html>', '<html></html>'))
      .toBe('<!DOCTYPE html>\n<html></html>');
  });

  it('leaves the html untouched when no doctype', () => {
    expect(serializeHtmlWithDoctype('', '<html></html>')).toBe('<html></html>');
  });

  it('round-trips a doctype extracted from source', () => {
    const source = '<!DOCTYPE html>\n<html><body>hi</body></html>';
    const doctype = extractDoctype(source);
    const outer = '<html><body>hi</body></html>';
    expect(serializeHtmlWithDoctype(doctype, outer)).toBe(source);
  });
});
