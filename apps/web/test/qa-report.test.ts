import { describe, expect, it } from 'vitest';
import { parseCoverage, parsePlaywright, parseVitest, renderReport, type ReportInput } from '../scripts/qa/report';

const vitestAudit = {
  startTime: Date.UTC(2026, 9, 15, 12),
  testResults: [
    {
      assertionResults: [
        { ancestorTitles: ['AUD-02 asset confusion'], title: 'rejects bAUDIT for bUSD', status: 'passed' },
        { ancestorTitles: ['AUD-03 races'], title: 'one of 20 wins', status: 'failed' },
        { ancestorTitles: ['helpers'], title: 'skipped helper', status: 'skipped' },
      ],
    },
  ],
};

const playwright = {
  stats: { startTime: '2026-10-15T12:00:00.000Z' },
  suites: [
    {
      title: 'full-qa-matrix.spec.ts',
      specs: [{ title: 'faucet limit', ok: true, tests: [{ results: [{ status: 'passed' }] }] }],
      suites: [{ title: 'nested', specs: [{ title: 'tamper simulator', ok: false, tests: [{ results: [{ status: 'failed' }] }] }] }],
    },
  ],
};

const base = (overrides: Partial<ReportInput> = {}): ReportInput => ({
  generatedAt: '2026-10-15T12:30:00.000Z',
  commit: 'abc1234',
  isDirty: false,
  suites: [parseVitest('vitest-audit-sdk', 'Adversarial audit (@belflow/sdk)', vitestAudit), parsePlaywright(playwright)],
  missing: [],
  coverage: [],
  testnet: null,
  ...overrides,
});

describe('QA report', () => {
  it('parses vitest and playwright JSON into pass/fail counts', () => {
    const audit = parseVitest('vitest-audit-sdk', 'audit', vitestAudit);
    expect(audit).toMatchObject({ passed: 1, failed: 1, skipped: 1, startedAt: '2026-10-15T12:00:00.000Z' });
    const e2e = parsePlaywright(playwright);
    expect(e2e.cases.map((c) => [c.title, c.status])).toEqual([
      ['faucet limit', 'passed'],
      ['tamper simulator', 'failed'],
    ]);
    expect(parseCoverage('@belflow/sdk', { total: { lines: { pct: 91.2 }, branches: { pct: 80 } } })).toMatchObject({ lines: 91.2, branches: 80, functions: 0 });
    expect(parseCoverage('x', {})).toBeNull();
  });

  it('maps tests to AUD ids, reports failures and missing suites honestly', () => {
    const report = renderReport(base({ missing: ['Unit + integration (@belflow/web)'], isDirty: true }));
    expect(report).toContain('`abc1234` (working tree had uncommitted changes)');
    expect(report).toMatch(/\| AUD-02 \| .* \| 1 \| PASS \|/);
    expect(report).toMatch(/\| AUD-03 \| .* \| 1 \| FAIL \(1\) \|/);
    expect(report).toMatch(/\| AUD-05 \| .* \| 0 \| NOT RUN \|/);
    expect(report).toContain('| Unit + integration (@belflow/web) | – | – | – | – | – | NOT RUN |');
    expect(report).toContain('❌ tamper simulator');
    expect(report).toContain('No coverage summary cached');
  });

  it('marks testnet evidence pending without a real run and never claims on-chain results', () => {
    const report = renderReport(base());
    expect(report).toContain('**Pending.**');
    expect(report).toContain('None of it is on-chain evidence.');
    expect(report).toContain('`feature-privacy-token` at `4d89104`');
    expect(report).toContain('token ids are blinded per output');
    expect(report).not.toMatch(/zarcanum|feature-confidential-asset|DAEMON_EXTRACTED/);
    expect(report).not.toMatch(/first (ever|in history)/i);
    expect(report).not.toContain('view key');
  });

  it('renders recorded testnet evidence with explorer links and flags an accepted wrong-token payment', () => {
    const hash = 'a'.repeat(64);
    const report = renderReport(
      base({
        testnet: {
          updatedAt: '2026-10-16T09:00:00.000Z',
          preflight: { height: 4_290_000, nettype: 'testnet' },
          tokens: { bUSD: { ticker: 'bUSD', tokenId: 'b'.repeat(64), registerTxHash: hash } },
          forensic: { splitTxHashes: [hash], flashTxHash: hash, checkTxKeyMatchesSent: true, belflowDecoder: { status: 'matched' } },
          aud04: { txHash: hash, claimedToken: 'd'.repeat(64), paidToken: 'b'.repeat(64), rejected: false, failures: [], level: null, diagnosis: 'ACCEPTED' },
          links: { register_bUSD: `https://testnet.beldex.dev/tx/${hash}` },
        },
      }),
    );
    expect(report).toContain('testnet at height 4,290,000');
    expect(report).toContain(`(https://testnet.beldex.dev/tx/${hash})`);
    expect(report).toContain('**ACCEPTED: BelFlow did not catch the wrong token. Investigate before citing this run.**');
    expect(report).not.toContain('**Pending.**');
    expect(report).toContain('| Register bUSD | token_id `bbbbbbbbbbbbbbbb…` |');
    expect(report).toContain('| check_tx_key token_received | **matched every sent amount and token** | – |');
    expect(report).toContain('| AUD-04 diagnosis | `ACCEPTED` | – |');
    expect(report).toContain('| BelFlow wallet-free decoder (zyphora) | **matched every sent amount and token** | – |');
  });
});
