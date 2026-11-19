import { ArrowRight, BookOpen, Code } from 'lucide-react';
import Link from 'next/link';
import { ArchitectureMap } from '@/components/landing/ArchitectureMap';
import { ProofSequence } from '@/components/landing/ProofSequence';

const REPO = 'https://github.com/zzzbedream/belflow-protocol';
const QA_REPORT = `${REPO}/blob/main/docs/QA_AND_SECURITY_AUDIT_REPORT.md`;

// Every figure here comes from the repository: test counts from the QA report,
// vectors from packages/beldex-sdk/test/fixtures. Testnet stays "pending".
const EVIDENCE = [
  { value: '192', label: 'unit and integration tests', href: QA_REPORT },
  { value: '31', label: 'adversarial audit tests (AUD-01 to 05)', href: QA_REPORT },
  { value: '9/9', label: 'end-to-end flows on a production build', href: QA_REPORT },
  { value: '200', label: 'Monero crypto test vectors for the ported primitives', href: `${REPO}/tree/main/packages/beldex-sdk/test` },
];

const STATUS = [
  { label: 'SDK, verifier, x402 rails, demo app', state: 'Built and tested', tone: 'text-verified' },
  { label: 'Wallet-free zyphora tx_key decoder', state: 'Round-trip tests · live check pending', tone: 'text-flash' },
  { label: 'Wallet-rpc flows on feature-privacy-token', state: 'Ported · live testnet run pending', tone: 'text-flash' },
];

export default function LandingPage() {
  return (
    <main className="min-h-dvh bg-paper text-ink">
      <section className="relative overflow-hidden bg-ink text-paper">
        <div className="kinetic-grid pointer-events-none absolute inset-0 opacity-50" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
          <nav className="flex items-center justify-between" aria-label="Site">
            <p className="text-[1.35rem] font-semibold tracking-[-0.04em]">
              Bel<span className="text-vault">Flow</span>
            </p>
            <div className="flex items-center gap-4 text-sm">
              <a href={REPO} className="flex items-center gap-1.5 text-paper/75 hover:text-paper" target="_blank" rel="noopener noreferrer">
                <Code className="size-4" aria-hidden /> GitHub
              </a>
              <Link href="/treasury" className="rounded-[8px] bg-paper px-3 py-1.5 font-medium text-ink hover:bg-paper/90">
                Launch app
              </Link>
            </div>
          </nav>

          <div className="mt-16 max-w-3xl">
            <p className="figures text-[0.7rem] uppercase tracking-[0.24em] text-vault">Beldex Privacy Tokens · open source · non-custodial</p>
            <h1 className="mt-4 text-[clamp(2.4rem,1.4rem+4vw,4.6rem)] font-semibold leading-[0.98] tracking-[-0.045em]">
              Prove one token payment. Reveal nothing else.
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-paper/75">
              BelFlow is a TypeScript SDK and verifier for Beldex Privacy Tokens. It connects the browser wallet to <code className="figures text-base">beldex-wallet-rpc</code>, sends multi-output batches, and lets an auditor check a single payment from its <code className="figures text-base">tx_key</code>.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/treasury" className="group flex items-center gap-2 rounded-[10px] bg-vault px-5 py-3 font-medium text-paper hover:brightness-110" data-testid="launch-app">
                Launch the demo <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
              <a href={`${REPO}#readme`} className="flex items-center gap-2 rounded-[10px] border border-paper/30 px-5 py-3 font-medium text-paper hover:bg-paper/10" target="_blank" rel="noopener noreferrer">
                <BookOpen className="size-4" aria-hidden /> Read the docs
              </a>
            </div>
            <p className="mt-3 text-sm text-paper/55">The demo runs on a simulated chain: no wallet, no real funds.</p>
          </div>

          <div className="mt-16">
            <ArchitectureMap />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6" aria-labelledby="proof-heading">
        <p className="figures text-[0.7rem] uppercase tracking-[0.24em] text-vault">How it works</p>
        <h2 id="proof-heading" className="mt-3 max-w-3xl text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
          Proving a Privacy Token payment from its tx_key
        </h2>
        <p className="mt-3 max-w-3xl text-ink-2">
          On Beldex’s <code className="figures text-sm">feature-privacy-token</code> branch, tokens are paid as <code className="figures text-sm">tx_out_zyphora</code> outputs and <code className="figures text-sm">check_tx_key</code> reports them in <code className="figures text-sm">token_received</code>. BelFlow turns that into a receipt an auditor can check, and can run the same decode without a wallet.
        </p>
        <div className="mt-10">
          <ProofSequence />
        </div>
      </section>

      <section className="border-y border-rule bg-paper-2" aria-labelledby="evidence-heading">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 id="evidence-heading" className="figures text-[0.7rem] uppercase tracking-[0.24em] text-ink-3">
            Evidence, not promises
          </h2>
          <ul className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {EVIDENCE.map((item) => (
              <li key={item.label}>
                <a href={item.href} target="_blank" rel="noopener noreferrer" className="group block">
                  <p className="figures text-4xl font-medium tracking-tight text-ink group-hover:text-vault">{item.value}</p>
                  <p className="mt-1 text-sm text-ink-2">{item.label}</p>
                </a>
              </li>
            ))}
          </ul>
          <ul className="mt-10 divide-y divide-rule rounded-[12px] border border-rule bg-paper" aria-label="Status">
            {STATUS.map((row) => (
              <li key={row.label} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span className="text-ink">{row.label}</span>
                <span className={`figures text-xs uppercase tracking-[0.12em] ${row.tone}`}>{row.state}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6">
        <h2 className="text-3xl font-semibold tracking-[-0.03em]">See it working</h2>
        <p className="mx-auto mt-3 max-w-xl text-ink-2">
          Deploy a token, pay a batch, issue a receipt and verify it as the auditor. Then try the wrong-asset attack and watch it fail.
        </p>
        <Link href="/treasury" className="mt-6 inline-flex items-center gap-2 rounded-[10px] bg-ink px-5 py-3 font-medium text-paper hover:bg-ink/90">
          Launch the demo <ArrowRight className="size-4" aria-hidden />
        </Link>
      </section>

      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-ink-3 sm:px-6">
          <p>BelFlow Protocol · MIT licence</p>
          <div className="flex gap-4">
            <a href={REPO} target="_blank" rel="noopener noreferrer" className="hover:text-ink">GitHub</a>
            <a href={QA_REPORT} target="_blank" rel="noopener noreferrer" className="hover:text-ink">QA report</a>
            <a href={`${REPO}/blob/main/docs/BELDEX_CORE_RECOMMENDATIONS.md`} target="_blank" rel="noopener noreferrer" className="hover:text-ink">Notes for Beldex core</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
