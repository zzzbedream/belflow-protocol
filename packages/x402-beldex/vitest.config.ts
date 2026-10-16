import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Cached for `pnpm report:qa` (docs/QA_AND_SECURITY_AUDIT_REPORT.md).
    reporters: ['default', 'json'],
    outputFile: { json: path.resolve(import.meta.dirname, '../../.qa-results/vitest-x402.json') },
    include: ['test/**/*.test.ts'],
    exclude: ['test/audit/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
