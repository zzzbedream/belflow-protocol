// pnpm report:qa [--run-all]
//
// Builds docs/QA_AND_SECURITY_AUDIT_REPORT.md from the JSON that `pnpm test`,
// `pnpm test:audit`, `pnpm test:coverage` and `pnpm e2e` cache in .qa-results/
// and from docs/artifacts/testnet-deployments.json (written by a real
// `pnpm testnet:deploy`; emulated runs never write there).
//
// --run-all runs only the suites whose cache is missing. It never starts the
// Playwright server when port 3100 is already taken.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { parseCoverage, parsePlaywright, parseVitest, renderReport, type CoverageRow, type SuiteResult, type TestnetEvidence } from './qa/report';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const RESULTS = path.join(REPO_ROOT, '.qa-results');
const REPORT = path.join(REPO_ROOT, 'docs', 'QA_AND_SECURITY_AUDIT_REPORT.md');
const TESTNET_STATE = path.join(REPO_ROOT, 'docs', 'artifacts', 'testnet-deployments.json');
const E2E_PORT = 3100;

interface VitestSuite {
  key: string;
  label: string;
  filter: string;
  script: 'test' | 'test:audit';
}

const PACKAGES = [
  { short: 'sdk', name: '@belflow/sdk', dir: 'packages/beldex-sdk' },
  { short: 'x402', name: '@belflow/x402', dir: 'packages/x402-beldex' },
  { short: 'web', name: '@belflow/web', dir: 'apps/web' },
] as const;

const VITEST_SUITES: VitestSuite[] = PACKAGES.flatMap((pkg) => [
  { key: `vitest-${pkg.short}`, label: `Unit + integration (${pkg.name})`, filter: pkg.name, script: 'test' as const },
  { key: `vitest-audit-${pkg.short}`, label: `Adversarial audit (${pkg.name})`, filter: pkg.name, script: 'test:audit' as const },
]);

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (error) {
    console.warn(`[report:qa] ignoring unreadable ${path.relative(REPO_ROOT, file)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function pnpm(args: string[]): void {
  // Test failures are part of the report, not a reason to stop.
  try {
    execFileSync('pnpm', args, { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  } catch {
    console.warn(`[report:qa] pnpm ${args.join(' ')} exited non-zero; its results are still reported.`);
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

async function runMissing(): Promise<void> {
  for (const suite of VITEST_SUITES) {
    if (existsSync(path.join(RESULTS, `${suite.key}.json`))) continue;
    pnpm(['--filter', suite.filter, suite.script === 'test' ? 'test:coverage' : 'test:audit']);
  }
  if (existsSync(path.join(RESULTS, 'playwright.json'))) return;
  if (await isPortFree(E2E_PORT)) pnpm(['--filter', '@belflow/web', 'e2e']);
  else console.warn(`[report:qa] port ${E2E_PORT} is busy; skipping Playwright. Free it or run \`pnpm e2e\` yourself.`);
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function collect(): { suites: SuiteResult[]; missing: string[]; coverage: CoverageRow[] } {
  const suites: SuiteResult[] = [];
  const missing: string[] = [];
  for (const suite of VITEST_SUITES) {
    const json = readJson<Parameters<typeof parseVitest>[2]>(path.join(RESULTS, `${suite.key}.json`));
    if (json) suites.push(parseVitest(suite.key, suite.label, json));
    else missing.push(suite.label);
  }
  const playwright = readJson<Parameters<typeof parsePlaywright>[0]>(path.join(RESULTS, 'playwright.json'));
  if (playwright) suites.push(parsePlaywright(playwright));
  else missing.push('E2E (Playwright, mock devnet)');
  const coverage = PACKAGES.flatMap((pkg) => {
    const json = readJson<Parameters<typeof parseCoverage>[1]>(path.join(REPO_ROOT, pkg.dir, 'coverage', 'coverage-summary.json'));
    const row = json ? parseCoverage(pkg.name, json) : null;
    return row ? [row] : [];
  });
  return { suites, missing, coverage };
}

async function main(): Promise<void> {
  if (process.argv.includes('--run-all')) await runMissing();
  const { suites, missing, coverage } = collect();
  const markdown = renderReport({
    generatedAt: new Date().toISOString(),
    commit: git(['rev-parse', '--short', 'HEAD']) || 'unknown',
    // The report itself does not count as a change to the code under test.
    isDirty: git(['status', '--porcelain', '--', '.', `:(exclude)${path.relative(REPO_ROOT, REPORT).replace(/\\/g, '/')}`]).length > 0,
    suites,
    missing,
    coverage,
    testnet: readJson<TestnetEvidence>(TESTNET_STATE),
  });
  writeFileSync(REPORT, markdown, 'utf8');
  console.log(`[report:qa] wrote ${path.relative(REPO_ROOT, REPORT)} (${suites.length} suites, ${missing.length} missing)`);
}

main().catch((error: unknown) => {
  console.error('[report:qa]', error instanceof Error ? error.message : error);
  process.exit(1);
});
