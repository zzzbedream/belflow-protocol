import { defineConfig } from 'vitest/config';

// Adversarial audit suite (AUD-01..AUD-05). Run with `pnpm test:audit`.
export default defineConfig({
  test: {
    include: ['test/audit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
