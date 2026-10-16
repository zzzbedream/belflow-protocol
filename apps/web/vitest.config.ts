import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      'server-only': path.resolve(import.meta.dirname, 'test/stubs/server-only.ts'),
    },
  },
  test: {
    // Cached for `pnpm report:qa` (docs/QA_AND_SECURITY_AUDIT_REPORT.md).
    reporters: ['default', 'json'],
    outputFile: { json: path.resolve(import.meta.dirname, '../../.qa-results/vitest-web.json') },
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/audit/**'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/lib/**/*.ts', 'src/server/**/*.ts'],
      exclude: ['src/lib/vault.ts', 'src/lib/wallet.ts', 'src/lib/useApi.ts', 'src/server/db.ts'],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
