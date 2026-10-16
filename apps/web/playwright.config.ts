import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

/**
 * Mock-devnet end-to-end suite. A dedicated SQLite file and mock-chain state
 * are reset by e2e/global-setup.ts so every run starts from the seeded chain.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // JSON is cached for `pnpm report:qa`.
  reporter: [['list'], ['json', { outputFile: '../../.qa-results/playwright.json' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
  webServer: {
    command: `node e2e/prepare.mjs && npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/tokens`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: 'file:./e2e.db',
      BELFLOW_MOCK_STATE_FILE: '.data/e2e/mock-chain.json',
      BELFLOW_MOCK_SEED: 'belflow-e2e',
      BELFLOW_PUBLIC_ORIGIN: `http://localhost:${PORT}`,
      BELDEX_WALLET_RPC_URL: '',
      SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-00000001',
    },
  },
});
