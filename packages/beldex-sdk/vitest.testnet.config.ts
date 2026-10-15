import { defineConfig } from 'vitest/config';

// Live Beldex Testnet suite. Runs only with BELDEX_TESTNET_E2E=1 and the
// endpoints described in docs/testnet-setup.md.
export default defineConfig({
  test: {
    include: ['test/testnet/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
