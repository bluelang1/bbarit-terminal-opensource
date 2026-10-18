/**
 * prettierFormatter.ts
 *
 * Registers Prettier as a document formatter for Monaco Editor.
 * Supports: JS, TS, JSX, TSX, CSS, SCSS, LESS, HTML, JSON, YAML, Markdown, GraphQL.
 *
 * Usage: call `registerPrettierFormatters(monaco)` once in onEditorBeforeMount or onEditorMount.
 */

import type * as Monaco from 'monaco-editor';

// Prettier language → parser mapping
const LANGUAGE_PARSER_MAP: Record<string, { parser: string; plugins: () => Promise<any[]> }> = {
  javascript: {
    parser: 'babel',
    plugins: () => Promise.all([
      import('prettier/plugins/babel'),
      import('prettier/plugins/estree'),
    ]),
  },
  typescript: {
    parser: 'typescript',
    plugins: () => Promise.all([
      import('prettier/plugins/typescript'),
      import('prettier/plugins/estree'),
    ]),
  },
  css: {
    parser: 'css',
    plugins: () => import('prettier/plugins/postcss').then(m => [m]),
  },
  scss: {
    parser: 'scss',
    plugins: () => import('prettier/plugins/postcss').then(m => [m]),
  },
  less: {
    parser: 'less',
    plugins: () => import('prettier/plugins/postcss').then(m => [m]),
  },
  html: {
    parser: 'html',
    plugins: () => import('prettier/plugins/html').then(m => [m]),
  },
  json: {
    parser: 'json',
    plugins: () => Promise.all([
      import('prettier/plugins/babel'),
      import('prettier/plugins/estree'),
    ]),
  },
  yaml: {
    parser: 'yaml',
    plugins: () => import('prettier/plugins/yaml').then(m => [m]),
  },
  markdown: {
    parser: 'markdown',
    plugins: () => import('prettier/plugins/markdown').then(m => [m]),
  },
  graphql: {
    parser: 'graphql',
    plugins: () => import('prettier/plugins/graphql').then(m => [m]),
  },
};

let registered = false;

/**
 * Register Prettier as a document formatting provider for all supported languages.
 * Safe to call multiple times — only registers once.
 */
export function registerPrettierFormatters(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  for (const [languageId, config] of Object.entries(LANGUAGE_PARSER_MAP)) {
    monaco.languages.registerDocumentFormattingEditProvider(languageId, {
      displayName: 'Prettier',
      async provideDocumentFormattingEdits(model, options) {
        try {
          const { format } = await import('prettier/standalone');
          const plugins = await config.plugins();
          const text = model.getValue();

          const formatted = await format(text, {
            parser: config.parser,
            plugins,
            tabWidth: options.tabSize,
            useTabs: !options.insertSpaces,
            singleQuote: true,
            trailingComma: 'all',
            printWidth: 100,
            semi: true,
          });

          const fullRange = model.getFullModelRange();
          return [
            {
              range: fullRange,
              text: formatted,
            },
          ];
        } catch (err) {
          console.warn(`[Prettier] Format failed for ${languageId}:`, err);
          return [];
        }
      },
    });
  }
}
