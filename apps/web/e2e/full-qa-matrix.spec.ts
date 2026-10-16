import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { verifyPackageIntegrity, type AuditProofPackage } from '../../../packages/beldex-sdk/src/compliance/proof';

// Phase 6 QA matrix: faucet limits, asset-confusion attacks visible in the UI,
// the auditor tamper simulator and the signed JSON package.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  // Self-sufficient: bUSD may already exist from the main journey (409 is fine).
  const response = await request.post('/api/treasury/tokens', {
    data: { network: 'mock-devnet', token: { ticker: 'bUSD', name: 'Beldex Confidential USD', decimals: 6, totalSupply: '1000000' } },
  });
  expect([201, 409]).toContain(response.status());
});

test('faucet grants the fixed package once and enforces the 24 h limit', async ({ page }) => {
  await page.goto('/faucet');
  await page.getByLabel('Recipient').fill('valentina.bdx');
  await page.getByTestId('claim-faucet').click();
  const result = page.getByTestId('faucet-result');
  await expect(result).toContainText('SENT');
  await expect(result).toContainText('2 BDX');
  await expect(result).toContainText('250 bUSD');
  await page.getByTestId('claim-faucet').click();
  await expect(page.getByRole('alert').filter({ hasText: 'One faucet claim' })).toBeVisible();
});

test('x402 attack: paying BDX for a bUSD price is rejected with asset_mismatch', async ({ page }) => {
  await page.goto('/x402-agents');
  await page.getByTestId('attack-wrong-asset').check();
  await page.getByTestId('run-agent').click();
  await expect(page.getByTestId('asset-mismatch-alert')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('agent-trace')).toContainText('Response 402');
});

test('compliance attack, auditor tamper simulator and signed JSON package', async ({ page, context }) => {
  await page.goto('/payroll');
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('recipient-table').getByText('resolving')).toHaveCount(0);
  await page.getByTestId('run-payroll').click();
  // Wait for the vault write, not just a CONFIRMED badge (an earlier job may already show one).
  await expect(page.getByText(/tx key\(s\) encrypted/)).toBeVisible({ timeout: 60_000 });

  await page.goto('/compliance');
  await page.getByTestId('receipt-list').getByRole('button').first().click();
  await page.getByTestId('attack-claim-asset').check();
  await page.getByTestId('generate-proof').click();
  await expect(page.getByRole('alert').filter({ hasText: /did not pay asset/ })).toBeVisible();

  await page.getByTestId('attack-claim-asset').uncheck();
  await page.getByTestId('generate-proof').click();
  const link = await page.getByTestId('proof-link').getAttribute('data-href');
  const auditor = await context.newPage();
  await auditor.goto(link as string);
  await expect(auditor.getByTestId('verified-seal')).toBeVisible();

  const [download] = await Promise.all([auditor.waitForEvent('download'), auditor.getByRole('button', { name: 'JSON' }).click()]);
  const pkg = JSON.parse(await readFile((await download.path()) as string, 'utf8')) as AuditProofPackage;
  expect(pkg.declaration).toMatch(/^belflow-proof-v1\|[0-9a-f]{64}\|/);
  expect(pkg.txKey).toMatch(/^[0-9a-f]{64}$/);
  expect(verifyPackageIntegrity(pkg)).toBe(true);
  expect(verifyPackageIntegrity({ ...pkg, amountAtomic: '1' })).toBe(false);

  await auditor.getByTestId('tamper-simulator').locator('summary').click();
  await auditor.getByTestId('inspect-proof').click();
  await expect(auditor.getByTestId('inspect-result')).toContainText('Authentic');
  await auditor.getByTestId('tamper-asset').click();
  await auditor.getByTestId('inspect-proof').click();
  const verdict = auditor.getByTestId('inspect-result');
  await expect(verdict).toContainText('Rejected');
  await expect(verdict).toContainText('PACKAGE_TAMPERED');
  await expect(verdict).toContainText('ASSET_MISMATCH');
});
