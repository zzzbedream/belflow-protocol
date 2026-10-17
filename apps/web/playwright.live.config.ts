import { defineConfig, devices } from '@playwright/test';

/**
 * Runs the E2E suite against a deployed demo (no local server):
 *   BELFLOW_E2E_BASE_URL=https://belflow-protocol.vercel.app pnpm --filter @belflow/web e2e:live
 * Note: it writes to that demo's mock devnet. "deploys bUSD" and the faucet
 * claim only pass on a fresh database, so run it right after a reset.
 */
const baseURL = process.env.BELFLOW_E2E_BASE_URL;
if (!baseURL) throw new Error('Set BELFLOW_E2E_BASE_URL to the deployed demo URL.');

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
});
