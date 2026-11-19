'use client';

import { createTimeline, stagger } from 'animejs';
import { Check } from 'lucide-react';
import { useAnimeScope } from '@/components/kinetic/useAnimeScope';

const STEPS = [
  { title: 'Payer shares', body: 'txid + tx_key + recipient address' },
  { title: 'Derive', body: 'D = 8 · r · A (same as the recipient’s view key)' },
  { title: 'Decode', body: 'tx_out_zyphora: unblind the token id, decrypt the amount' },
  { title: 'Check', body: 'C = amount · T + mask · G must match on-chain' },
  { title: 'Verified', body: 'token and amount at CRYPTOGRAPHIC_FULL' },
];

/**
 * How a token payment is proven from a tx_key, step by step: Beldex's
 * check_tx_key (feature-privacy-token) and BelFlow's verifier side by side.
 */
export function ProofSequence() {
  const ref = useAnimeScope<HTMLDivElement>(
    ({ ms, isReduced }) => {
      const timeline = createTimeline({ loop: !isReduced, loopDelay: 1600 });
      timeline
        .add('.proof-step', { opacity: [0.25, 1], translateY: [8, 0], duration: ms(420), delay: stagger(ms(520)) })
        .add('.proof-bar', { scaleX: [0, 1], duration: ms(2600), ease: 'inOutQuad' }, 0)
        .add('.proof-verdict', { scale: [0.8, 1], opacity: [0, 1], duration: ms(500), ease: 'outBack(2)' });
    },
    [],
  );

  return (
    <div ref={ref} className="space-y-8" data-testid="proof-sequence">
      <div className="relative">
        <div className="absolute left-0 right-0 top-5 hidden h-0.5 bg-ink/10 lg:block" aria-hidden>
          <div className="proof-bar h-full origin-left bg-vault" />
        </div>
        <ol className="relative grid gap-4 lg:grid-cols-5">
          {STEPS.map((step, i) => (
            <li key={step.title} className="proof-step">
              <span className="figures grid size-10 place-items-center rounded-full border-2 border-vault bg-paper text-sm font-semibold text-vault">{i + 1}</span>
              <p className="mt-3 font-semibold text-ink">{step.title}</p>
              <p className="mt-1 text-sm leading-snug text-ink-2">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-[12px] border border-rule bg-paper-2 p-5">
          <p className="figures text-[0.65rem] uppercase tracking-[0.18em] text-ink-3">check_tx_key · Beldex feature-privacy-token</p>
          <p className="mt-3 flex items-center gap-2 font-semibold text-ink">
            <Check className="size-5 text-verified" aria-hidden /> reports token_received
          </p>
          <p className="mt-1 text-sm text-ink-2">
            Decodes <code className="figures">tx_out_zyphora</code> outputs and returns the token id and amount paid to the address. It runs inside <code className="figures">beldex-wallet-rpc</code>, with a wallet open.
          </p>
        </div>
        <div className="proof-verdict rounded-[12px] border border-verified/50 bg-verified-soft p-5">
          <p className="figures text-[0.65rem] uppercase tracking-[0.18em] text-verified">BelFlow verifier</p>
          <p className="mt-3 flex items-center gap-2 font-semibold text-ink">
            <Check className="size-5 text-verified" aria-hidden /> checks the claim, with or without a wallet
          </p>
          <p className="mt-1 text-sm text-ink-2">
            Exact amount, token and confirmations are checked against <code className="figures">token_received</code>. The same decode runs in TypeScript from daemon data alone, and both must agree. A wrong amount or token is rejected.
          </p>
        </div>
      </div>
    </div>
  );
}
