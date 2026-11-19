// Pure parsing and rendering for docs/QA_AND_SECURITY_AUDIT_REPORT.md. The CLI
// (scripts/generate-qa-report.ts) does all I/O; everything here is testable.

export interface TestCase {
  suite: string;
  title: string;
  status: 'passed' | 'failed' | 'skipped';
}

export interface SuiteResult {
  key: string;
  label: string;
  passed: number;
  failed: number;
  skipped: number;
  startedAt: string | null;
  cases: TestCase[];
}

export interface CoverageRow {
  pkg: string;
  lines: number;
  statements: number;
  functions: number;
  branches: number;
}

/** Subset of the orchestrator's testnet-deployments.json the report reads. */
export interface TestnetEvidence {
  updatedAt?: string;
  preflight?: { height: number; nettype: string };
  presplit?: { txHashes: string[]; outputs: number };
  tokens?: Record<string, { ticker?: string; tokenId?: string; registerTxHash?: string } | undefined>;
  forensic?: {
    splitTxHashes: string[];
    flashTxHash: string;
    checkTxKeyMatchesSent?: boolean;
    belflowDecoder?: { status: string; detail?: string };
  };
  aud04?: {
    txHash: string;
    claimedToken: string;
    paidToken: string;
    rejected: boolean;
    failures: string[];
    level: string | null;
    diagnosis?: string;
  };
  x402?: { txHash: string; status: number; settledFromMempool: boolean | null; assetVerificationLevel: string | null };
  links?: Record<string, string>;
}

export interface ReportInput {
  generatedAt: string;
  commit: string;
  isDirty: boolean;
  suites: SuiteResult[];
  /** Expected suites with no cached results. */
  missing: string[];
  coverage: CoverageRow[];
  testnet: TestnetEvidence | null;
}

interface VitestJson {
  startTime?: number;
  testResults?: Array<{ assertionResults?: Array<{ ancestorTitles?: string[]; title: string; status: string }> }>;
}

interface PlaywrightSpec {
  title: string;
  tests?: Array<{ results?: Array<{ status?: string }> }>;
  ok?: boolean;
}

interface PlaywrightSuite {
  title: string;
  specs?: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

interface PlaywrightJson {
  stats?: { startTime?: string };
  suites?: PlaywrightSuite[];
}

const toStatus = (status: string | undefined): TestCase['status'] =>
  status === 'passed' || status === 'expected' ? 'passed' : status === 'failed' || status === 'unexpected' || status === 'timedOut' ? 'failed' : 'skipped';

function summarize(key: string, label: string, startedAt: string | null, cases: TestCase[]): SuiteResult {
  const count = (status: TestCase['status']) => cases.filter((c) => c.status === status).length;
  return { key, label, passed: count('passed'), failed: count('failed'), skipped: count('skipped'), startedAt, cases };
}

export function parseVitest(key: string, label: string, json: VitestJson): SuiteResult {
  const cases = (json.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? []).map((test) => ({ suite: test.ancestorTitles?.[0] ?? '', title: test.title, status: toStatus(test.status) })),
  );
  return summarize(key, label, json.startTime ? new Date(json.startTime).toISOString() : null, cases);
}

export function parsePlaywright(json: PlaywrightJson): SuiteResult {
  const cases: TestCase[] = [];
  const walk = (suite: PlaywrightSuite, file: string) => {
    for (const spec of suite.specs ?? []) {
      const last = spec.tests?.at(-1)?.results?.at(-1)?.status;
      cases.push({ suite: file, title: spec.title, status: spec.ok === false ? 'failed' : toStatus(last ?? (spec.ok ? 'passed' : undefined)) });
    }
    for (const child of suite.suites ?? []) walk(child, file);
  };
  for (const suite of json.suites ?? []) walk(suite, suite.title);
  return summarize('playwright', 'E2E (Playwright, mock devnet)', json.stats?.startTime ?? null, cases);
}

export function parseCoverage(pkg: string, json: { total?: Record<string, { pct?: number }> }): CoverageRow | null {
  const total = json.total;
  if (!total) return null;
  const pct = (name: string) => total[name]?.pct ?? 0;
  return { pkg, lines: pct('lines'), statements: pct('statements'), functions: pct('functions'), branches: pct('branches') };
}

/** The five adversarial audits and what each one proves. */
export const AUDITS = [
  { id: 'AUD-01', threat: 'Precision loss in amounts (9-decimal BDX vs 6-decimal tokens, u64 overflow)' },
  { id: 'AUD-02', threat: 'Token confusion: paying one token (or BDX) and claiming another (invoices, x402, audit proofs)' },
  { id: 'AUD-03', threat: 'Races: replayed x402 nonces and tx hashes, duplicate payroll submissions' },
  { id: 'AUD-04', threat: 'Broadcast then timeout mid-payroll: no blind resend, reconciliation from wallet history' },
  { id: 'AUD-05', threat: 'Leakage: caching headers, stack traces, RPC URLs, raw client IPs' },
] as const;

const auditCases = (suites: SuiteResult[], id: string) =>
  suites.filter((s) => s.key.startsWith('vitest-audit')).flatMap((s) => s.cases.filter((c) => c.suite.startsWith(id)).map((c) => ({ ...c, pkg: s.label })));

const verdict = (passed: number, failed: number, total: number) => (total === 0 ? 'NOT RUN' : failed > 0 ? `FAIL (${failed})` : passed === total ? 'PASS' : 'PARTIAL');
const cell = (value: string) => value.replace(/\|/g, '\\|');
const pct = (value: number) => `${value.toFixed(1)}%`;

function renderSummary(input: ReportInput): string[] {
  const rows = input.suites.map((s) => {
    const total = s.passed + s.failed + s.skipped;
    return `| ${s.label} | ${s.passed} | ${s.failed} | ${s.skipped} | ${total} | ${s.startedAt ?? 'unknown'} | ${verdict(s.passed, s.failed, total)} |`;
  });
  const missing = input.missing.map((label) => `| ${label} | – | – | – | – | – | NOT RUN |`);
  const totals = input.suites.reduce((acc, s) => ({ passed: acc.passed + s.passed, failed: acc.failed + s.failed }), { passed: 0, failed: 0 });
  return [
    '## Summary',
    '',
    `**${totals.passed} passed, ${totals.failed} failed** across ${input.suites.length} cached suites${input.missing.length ? `; ${input.missing.length} suite(s) not run` : ''}.`,
    '',
    '| Suite | Passed | Failed | Skipped | Total | Run at (UTC) | Result |',
    '|---|---:|---:|---:|---:|---|---|',
    ...rows,
    ...missing,
  ];
}

function renderAudits(input: ReportInput): string[] {
  const lines = ['## Adversarial audit suite (AUD-01 to AUD-05)', '', '| ID | Threat | Tests | Result |', '|---|---|---:|---|'];
  for (const audit of AUDITS) {
    const cases = auditCases(input.suites, audit.id);
    const passed = cases.filter((c) => c.status === 'passed').length;
    const failed = cases.filter((c) => c.status === 'failed').length;
    lines.push(`| ${audit.id} | ${audit.threat} | ${cases.length} | ${verdict(passed, failed, cases.length)} |`);
  }
  for (const audit of AUDITS) {
    const cases = auditCases(input.suites, audit.id);
    if (cases.length === 0) continue;
    lines.push('', `### ${audit.id}`, '');
    for (const c of cases) lines.push(`- ${c.status === 'passed' ? '✅' : c.status === 'failed' ? '❌' : '⏭️'} ${cell(c.title)} _(${c.pkg})_`);
  }
  return lines;
}

function renderCoverage(rows: CoverageRow[]): string[] {
  if (rows.length === 0) return ['## Coverage', '', 'No coverage summary cached. Run `pnpm test:coverage`, then `pnpm report:qa`.'];
  return [
    '## Coverage',
    '',
    '| Package | Lines | Statements | Functions | Branches |',
    '|---|---:|---:|---:|---:|',
    ...rows.map((r) => `| ${r.pkg} | ${pct(r.lines)} | ${pct(r.statements)} | ${pct(r.functions)} | ${pct(r.branches)} |`),
  ];
}

function renderE2e(suites: SuiteResult[]): string[] {
  const e2e = suites.find((s) => s.key === 'playwright');
  if (!e2e) return ['## End-to-end (Playwright)', '', 'Not run. Run `pnpm e2e`, then `pnpm report:qa`.'];
  return ['## End-to-end (Playwright)', '', ...e2e.cases.map((c) => `- ${c.status === 'passed' ? '✅' : c.status === 'failed' ? '❌' : '⏭️'} ${cell(c.title)} _(${c.suite})_`)];
}

function txLink(links: Record<string, string>, hash: string | undefined): string {
  if (!hash) return '–';
  const url = Object.values(links).find((link) => link.endsWith(hash));
  return url ? `[\`${hash.slice(0, 12)}…\`](${url})` : `\`${hash.slice(0, 12)}…\``;
}

function renderTestnet(evidence: TestnetEvidence | null): string[] {
  const head = ['## Beldex Testnet evidence', ''];
  if (!evidence) {
    return [
      ...head,
      '**Pending.** No `docs/artifacts/testnet-deployments.json` yet. Run `pnpm testnet:deploy` against a funded `beldex-wallet-rpc` built from `feature-privacy-token` (see `docs/testnet-setup.md`), then `pnpm report:qa`.',
      '',
      'Until then, every result above comes from the deterministic mock devnet and from wallet-rpc/daemon emulators. None of it is on-chain evidence.',
    ];
  }
  const links = evidence.links ?? {};
  const rows: string[] = ['| Step | Result | Transaction |', '|---|---|---|'];
  if (evidence.preflight) rows.push(`| Pre-flight | ${evidence.preflight.nettype} at height ${evidence.preflight.height.toLocaleString('en-US')} | – |`);
  if (evidence.presplit) rows.push(`| UTXO pre-split | ${evidence.presplit.outputs} outputs | ${txLink(links, evidence.presplit.txHashes[0])} |`);
  for (const [key, token] of Object.entries(evidence.tokens ?? {})) {
    if (token) rows.push(`| Register ${token.ticker ?? key} | token_id \`${(token.tokenId ?? '?').slice(0, 16)}…\` | ${txLink(links, token.registerTxHash)} |`);
  }
  if (evidence.forensic) {
    rows.push(`| Multi-output transfer_split | ${evidence.forensic.splitTxHashes.length} tx | ${txLink(links, evidence.forensic.splitTxHashes[0])} |`);
    rows.push(`| Flash payment | sent | ${txLink(links, evidence.forensic.flashTxHash)} |`);
    if (evidence.forensic.checkTxKeyMatchesSent !== undefined) {
      rows.push(
        `| check_tx_key token_received | ${evidence.forensic.checkTxKeyMatchesSent ? '**matched every sent amount and token**' : '**did not match the sent amounts**'} | – |`,
      );
    }
    if (evidence.forensic.belflowDecoder) {
      const { status, detail } = evidence.forensic.belflowDecoder;
      const text = status === 'matched' ? '**matched every sent amount and token**' : status === 'mismatch' || status === 'error' ? `**${status}**: ${cell(detail ?? '')}` : status;
      rows.push(`| BelFlow wallet-free decoder (zyphora) | ${text} | – |`);
    }
  }
  if (evidence.aud04) {
    const a = evidence.aud04;
    rows.push(`| Live AUD-04 (paid ${a.paidToken.slice(0, 8)}…, claimed ${a.claimedToken.slice(0, 8)}…) | ${a.rejected ? `rejected: ${a.failures.join(', ')}` : '**ACCEPTED: BelFlow did not catch the wrong token. Investigate before citing this run.**'} | ${txLink(links, a.txHash)} |`);
    if (a.diagnosis) rows.push(`| AUD-04 diagnosis | \`${a.diagnosis}\` | – |`);
  }
  if (evidence.x402) {
    const x = evidence.x402;
    rows.push(`| x402 with Flash | HTTP ${x.status}${x.settledFromMempool ? ', settled from mempool' : ''}${x.assetVerificationLevel ? `, ${x.assetVerificationLevel}` : ''} | ${txLink(links, x.txHash)} |`);
  }
  return [...head, `Run recorded at ${evidence.updatedAt ?? 'unknown time'}.`, '', ...rows];
}

const LIMITS = [
  '## Scope and limits',
  '',
  '- The unit, audit and E2E suites run against the deterministic mock devnet and wallet-rpc/daemon emulators, not against Beldex nodes.',
  '- Target: `Beldex-Coin/beldex` `feature-privacy-token` at `4d89104`. There, `check_tx_key` decodes `tx_out_zyphora` outputs and returns `token_received` (token id and amount); BelFlow uses it as the primary token proof (`CRYPTOGRAPHIC_FULL`).',
  '- The wallet-free zyphora decoder and the wallet-rpc request/response shapes are checked against the C++ source and round-trip tests, not yet against live transactions. The testnet run (`pnpm testnet:deploy`) is the end-to-end check.',
  '- A daemon cannot attribute a token: token ids are blinded per output (`docs/token-privacy.md` upstream). Decoded transactions are only used for flash and pool status.',
  '- AUD-02 also models a backend that cannot attribute tokens (an unattributed amount) and shows BelFlow still never accepts the wrong token.',
];

export function renderReport(input: ReportInput): string {
  return [
    '# BelFlow QA and Security Audit Report',
    '',
    `> Generated by \`pnpm report:qa\` at ${input.generatedAt} from commit \`${input.commit}\`${input.isDirty ? ' (working tree had uncommitted changes)' : ''}. It reads cached results from \`.qa-results/\`; do not edit it by hand.`,
    '',
    ...renderSummary(input),
    '',
    ...renderAudits(input),
    '',
    ...renderCoverage(input.coverage),
    '',
    ...renderE2e(input.suites),
    '',
    ...renderTestnet(input.testnet),
    '',
    ...LIMITS,
    '',
  ].join('\n');
}
