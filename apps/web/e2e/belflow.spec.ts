import { expect, test } from '@playwright/test';

// One continuous grant-demo journey on the deterministic mock devnet.
test.describe.configure({ mode: 'serial' });

test('landing shows the architecture and launches the app', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Prove one token payment');
  await expect(page.getByTestId('architecture-map')).toBeVisible();
  await expect(page.getByTestId('proof-sequence')).toContainText('tx_out_zarcanum');
  await page.getByTestId('launch-app').click();
  await expect(page).toHaveURL(/\/treasury$/);
  await expect(page.getByRole('heading', { name: 'Confidential treasury' })).toBeVisible();
});

test('treasury shows the active capability matrix and telemetry', async ({ page }) => {
  await page.goto('/treasury');
  await expect(page.getByRole('heading', { name: 'Confidential treasury' })).toBeVisible();
  await expect(page.getByTestId('capability-matrix')).toContainText('Deterministic MockChain');
  await expect(page.getByTestId('burn-card')).toContainText('Total BDX burned');
  await expect(page.getByTestId('savings-card')).toContainText('0 bps');
});

test('deploys bUSD in Token Studio', async ({ page }) => {
  await page.goto('/tokens');
  await page.getByRole('button', { name: /Deploy bUSD/ }).click();
  await expect(page.getByText('bUSD deployed')).toBeVisible();
  await expect(page.getByTestId('token-registry')).toContainText('Beldex Confidential USD');
});

test('pays a CSV payroll and issues a selective audit proof the auditor can verify', async ({ page, context }) => {
  await page.goto('/payroll');
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('recipient-table').getByText('resolving')).toHaveCount(0);
  await expect(page.getByTestId('batch-plan')).toContainText('stealth outputs');
  await page.getByTestId('run-payroll').click();
  await expect(page.getByTestId('job-status').first()).toContainText('CONFIRMED');
  await expect(page.getByText(/tx key\(s\) encrypted/)).toBeVisible();

  await page.goto('/compliance');
  await page.getByTestId('receipt-list').getByRole('button').first().click();
  await page.getByTestId('generate-proof').click();
  const card = page.getByTestId('audit-proof-card');
  await expect(card).toContainText('CRYPTOGRAPHIC_FULL');
  const link = await page.getByTestId('proof-link').getAttribute('data-href');
  expect(link).toMatch(/\/verify\/[0-9a-f-]{36}#k=/);

  const auditor = await context.newPage();
  await auditor.goto(link as string);
  await expect(auditor.getByTestId('verified-seal')).toBeVisible();
  await expect(auditor.getByTestId('auditor-proof')).toContainText('Cryptographically verified in block');
  await expect(auditor.getByTestId('auditor-proof')).toContainText('intact');
});

test('creates an encrypted invoice and settles it at checkout with a flash payment', async ({ page }) => {
  await page.goto('/invoices');
  await page.getByTestId('invoice-form').getByRole('button', { name: /Create invoice link/ }).click();
  const link = await page.getByTestId('invoice-link').textContent();
  expect(link).toMatch(/\/pay\/[a-z0-9]+#k=/);
  await page.goto(link as string);
  await expect(page.getByTestId('invoice-memo')).toContainText('INV-2026-0142');
  await page.getByTestId('pay-invoice').click();
  await expect(page.getByText('Paid', { exact: true })).toBeVisible();
});

test('alpha-bot.bdx pays an HTTP 402 challenge and unlocks the resource', async ({ page }) => {
  await page.goto('/x402-agents');
  await page.getByRole('button', { name: 'Raw request' }).click();
  await expect(page.getByTestId('raw-402')).toContainText('HTTP 402');
  await page.getByTestId('run-agent').click();
  await expect(page.getByTestId('run-agent')).toHaveText(/Run agent/, { timeout: 60_000 });
  const trace = page.getByTestId('agent-trace');
  await expect(trace).toContainText('402 Payment Required');
  await expect(trace).toContainText('Flash payment broadcast');
  await expect(trace).toContainText('Response 200');
  await expect(trace).toContainText('latam-fx-signal');
  await expect(page.getByTestId('x402-metrics')).toContainText('Paid calls');
});
