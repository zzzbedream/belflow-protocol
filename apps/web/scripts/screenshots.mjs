// Captures key screens for visual review: node scripts/screenshots.mjs <outDir> [baseUrl]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const outDir = path.resolve(process.argv[2] ?? 'screenshots');
const base = process.argv[3] ?? 'http://localhost:3000';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
for (const [label, viewport] of [
  ['desktop', { width: 1440, height: 1000 }],
  ['mobile', { width: 390, height: 900 }],
]) {
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport, colorScheme: scheme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
    for (const route of ['/', '/tokens', '/payroll', '/invoices']) {
      await page.goto(`${base}${route}`, { waitUntil: 'load' });
      await page.waitForTimeout(1800);
      if (route === '/payroll') {
        await page.getByTestId('load-sample').click();
        await page.waitForTimeout(1500);
      }
      const name = `${label}-${scheme}${route === '/' ? '-treasury' : route.replace('/', '-')}.png`;
      await page.screenshot({ path: path.join(outDir, name), fullPage: true });
    }
    if (errors.length) console.log(`[${label}/${scheme}] errors:`, errors.slice(0, 5));
    await page.close();
  }
}
await browser.close();
console.log('saved to', outDir);
