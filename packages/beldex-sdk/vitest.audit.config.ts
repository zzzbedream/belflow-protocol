import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Adversarial audit suite (AUD-01..AUD-05). Run with `pnpm test:audit`.
export default defineConfig({
  test: {
    // Cached for `pnpm report:qa` (docs/QA_AND_SECURITY_AUDIT_REPORT.md).
    reporters: ['default', 'json'],
    outputFile: { json: path.resolve(import.meta.dirname, '../../.qa-results/vitest-audit-sdk.json') },
    include: ['test/audit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
