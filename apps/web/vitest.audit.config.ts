import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Adversarial audit suite (AUD-02..AUD-05 against real routes + SQLite). `pnpm test:audit`.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      'server-only': path.resolve(import.meta.dirname, 'test/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/audit/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
