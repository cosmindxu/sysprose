import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@text': fileURLToPath(new URL('./src/text', import.meta.url)),
      '@api': fileURLToPath(new URL('./src/api', import.meta.url)),
      '@validation': fileURLToPath(new URL('./src/validation', import.meta.url)),
      '@persistence': fileURLToPath(new URL('./src/persistence', import.meta.url)),
      '@diagram': fileURLToPath(new URL('./src/diagram', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
      '@semantics': fileURLToPath(new URL('./src/semantics', import.meta.url)),
      '@library': fileURLToPath(new URL('./src/library', import.meta.url)),
      '@collab': fileURLToPath(new URL('./src/collab', import.meta.url)),
      '@interop': fileURLToPath(new URL('./src/interop', import.meta.url)),
      '@server': fileURLToPath(new URL('./src/server', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['test/e2e/**', 'node_modules/**'],
    coverage: { reporter: ['text', 'json', 'html'], reportsDirectory: 'test-results/coverage' },
  },
});
