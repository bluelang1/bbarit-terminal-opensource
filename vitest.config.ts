import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    // _analysis holds cloned repos studied for feature ideas — never run their tests.
    exclude: ['**/node_modules/**', '**/_analysis/**', '**/dist/**'],
  },
});
