'use client';

import { animate, createTimeline, stagger } from 'animejs';
import { Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { useAnimeScope } from './useAnimeScope';

export type ScanState = 'sealed' | 'scanning' | 'revealed' | 'mismatch' | 'rejected';

interface XRayScannerProps {
  txHash: string;
  state: ScanState;
  /** What the disclosed output decrypts to, e.g. "1,250.5 bUSD". */
  disclosed?: string;
  /** For `mismatch`: the asset claimed vs the asset actually paid. */
  claimed?: string;
  paid?: string;
  className?: string;
}

const CELLS = 8;
const HEX = '0123456789abcdef';

function randomHex(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += HEX[Math.floor(Math.random() * 16)];
  return out;
}

/** Which cell holds the disclosed output: stable per tx so it never jumps. */
function targetCell(txHash: string): number {
  return parseInt(txHash.slice(-2) || '0', 16) % CELLS;
}

/**
 * The transaction as a block of sealed outputs. Verifying with the tx_key
 * sweeps a scan line and decrypts only the disclosed output; every other
 * output stays locked. A wrong-asset claim ends in a red collision.
 */
export function XRayScanner({ txHash, state, disclosed, claimed, paid, className }: XRayScannerProps) {
  const target = targetCell(txHash);

  const ref = useAnimeScope<HTMLDivElement>(
    ({ root, ms, isReduced }) => {
      const scramblers = Array.from(root.querySelectorAll<HTMLElement>('.xray-hex'));
      const ticker = { t: 0 };
      if (!isReduced) {
        animate(ticker, {
          t: 1,
          duration: 90,
          loop: true,
          onLoop: () => {
            for (const el of scramblers) {
              if (el.dataset.open === 'true') continue;
              el.textContent = randomHex(el.textContent?.length || 8);
            }
          },
        });
      }
      animate('.xray-cell', { opacity: [0, 1], translateY: [8, 0], duration: ms(500), delay: stagger(40) });
      if (state === 'scanning' && !isReduced) {
        animate('.xray-beam', { left: ['0%', '100%'], duration: 900, ease: 'inOutSine', alternate: true, loop: true });
      }
      if (state === 'revealed') {
        createTimeline()
          .add('.xray-beam', { left: ['0%', '100%'], opacity: [1, 0], duration: ms(900), ease: 'inOutQuad' })
          .add('.xray-target', { scale: [0.92, 1], duration: ms(500), ease: 'outBack(2)' }, '-=300');
      }
      if (state === 'mismatch') {
        createTimeline()
          .add('.xray-claim', { translateX: [-80, 0], duration: ms(420), ease: 'inQuad' })
          .add('.xray-paid', { translateX: [80, 0], duration: ms(420), ease: 'inQuad' }, '<<')
          .add('.xray-clash', { scale: [0.4, 1], opacity: [0, 1], duration: ms(900), ease: 'outElastic(1, .45)' })
          .add('.xray-cell', { translateX: [0, -6, 6, -3, 0], duration: ms(420), ease: 'inOutSine' }, '<<');
      }
    },
    [state, txHash],
  );

  const isOpen = state === 'revealed';
  const isBad = state === 'mismatch' || state === 'rejected';

  return (
    <div ref={ref} className={cn('relative overflow-hidden rounded-[12px] bg-ink p-4 text-paper', className)} data-testid="xray-scanner" data-state={state}>
      <div className="kinetic-grid pointer-events-none absolute inset-0 opacity-40" aria-hidden />
      <div className="relative grid grid-cols-4 gap-2" aria-label={isOpen ? 'One output disclosed, the rest stay sealed' : 'Transaction outputs, sealed'}>
        {Array.from({ length: CELLS }, (_, i) => {
          const isTarget = i === target;
          const reveal = isTarget && isOpen;
          return (
            <div
              key={i}
              className={cn(
                'xray-cell flex min-h-14 flex-col justify-between rounded-[6px] border px-2 py-1.5',
                reveal ? 'xray-target border-verified bg-verified/15' : isTarget && isBad ? 'border-danger bg-danger/15' : 'border-paper/15 bg-paper/5',
              )}
            >
              <span className="flex items-center justify-between text-[0.6rem] text-paper/50">
                <span className="figures">out {String(i).padStart(2, '0')}</span>
                {reveal ? <ShieldCheck className="size-3 text-verified" aria-hidden /> : <Lock className="size-3" aria-hidden />}
              </span>
              {reveal ? (
                <span className="figures text-xs font-medium text-paper" data-testid="xray-disclosed">
                  {disclosed ?? 'disclosed'}
                </span>
              ) : (
                <span className="xray-hex figures text-xs text-paper/40" aria-hidden data-open="false">
                  {txHash.slice((i * 8) % 56, ((i * 8) % 56) + 8) || '00000000'}
                </span>
              )}
            </div>
          );
        })}
        <span className="xray-beam pointer-events-none absolute -inset-y-1 left-0 w-1 rounded-full bg-vault shadow-[0_0_24px_6px_var(--vault)]" style={{ opacity: state === 'scanning' || state === 'revealed' ? 1 : 0 }} aria-hidden />
      </div>
      {state === 'mismatch' && (
        <div className="relative mt-3 flex items-center justify-center gap-2 text-sm" role="status">
          <span className="xray-claim figures rounded-full border border-danger/60 bg-danger/20 px-3 py-1">claimed {claimed ?? '?'}</span>
          <span className="xray-clash figures flex items-center gap-1 rounded-full bg-danger px-3 py-1 font-semibold text-paper">
            <ShieldAlert className="size-4" aria-hidden /> ASSET_MISMATCH
          </span>
          <span className="xray-paid figures rounded-full border border-paper/30 bg-paper/10 px-3 py-1">paid {paid ?? '?'}</span>
        </div>
      )}
      <p className="figures relative mt-3 text-[0.62rem] uppercase tracking-[0.16em] text-paper/60">
        {state === 'sealed' && 'sealed · tx_key required'}
        {state === 'scanning' && 'check_tx_key · scanning'}
        {state === 'revealed' && '1 output disclosed · others sealed'}
        {state === 'mismatch' && 'asset claim contradicts the chain'}
        {state === 'rejected' && 'verification failed'}
      </p>
    </div>
  );
}
