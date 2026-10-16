'use client';

import { animate, stagger, svg } from 'animejs';
import { cn } from '@/components/ui/cn';
import { useAnimeScope } from './useAnimeScope';

export type DispenserState = 'idle' | 'dispensing' | 'sent' | 'cooldown';

interface VaultDispenserProps {
  state: DispenserState;
  grants: Array<{ ticker: string; amount: string }>;
  windowHours: number;
}

const PARTICLES = 14;
const ARC = 'M 92 120 C 170 10, 290 10, 368 120';

/**
 * The faucet as a vault: a claim fires a stream of particles into the
 * wallet, then a cooldown ring closes over the 24 h window.
 */
export function VaultDispenser({ state, grants, windowHours }: VaultDispenserProps) {
  const ref = useAnimeScope<HTMLDivElement>(
    ({ ms, isReduced }) => {
      if (state === 'dispensing' && !isReduced) {
        animate('.vd-particle', { ...svg.createMotionPath('.vd-arc'), opacity: [0, 1, 0], duration: 1100, delay: stagger(70), loop: true, ease: 'inOutQuad' });
        animate('.vd-vault', { rotate: [0, 60], duration: 900, loop: true, ease: 'inOutSine' });
      }
      if (state === 'sent') {
        if (!isReduced) animate('.vd-particle', { ...svg.createMotionPath('.vd-arc'), opacity: [0, 1, 0], duration: 900, delay: stagger(50), ease: 'outQuad' });
        animate('.vd-wallet', { scale: [1, 1.18, 1], duration: ms(600), delay: ms(700), ease: 'outElastic(1, .5)' });
        animate(svg.createDrawable('.vd-cooldown'), { draw: ['0 0', '0 1'], duration: ms(1600), delay: ms(900), ease: 'outExpo' });
      }
      if (state === 'cooldown') {
        animate('.vd-wallet', { translateX: [0, -6, 6, -3, 0], duration: ms(420), ease: 'inOutSine' });
        animate(svg.createDrawable('.vd-cooldown'), { draw: ['0 0', '0 1'], duration: ms(900), ease: 'outExpo' });
      }
    },
    [state],
  );

  const isLocked = state === 'sent' || state === 'cooldown';

  return (
    <div ref={ref} className="relative overflow-hidden rounded-[12px] bg-ink text-paper" data-testid="vault-dispenser" data-state={state}>
      <div className="kinetic-grid pointer-events-none absolute inset-0 opacity-40" aria-hidden />
      <svg viewBox="0 0 460 170" className="relative block h-auto w-full" role="img" aria-label={`Faucet vault sending ${grants.map((g) => `${g.amount} ${g.ticker}`).join(' and ')}`}>
        <path className="vd-arc" d={ARC} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeDasharray="2 6" />
        <g transform="translate(70 120)">
          <polygon className="vd-vault kinetic-svg-origin" points="0,-30 26,-15 26,15 0,30 -26,15 -26,-15" fill="var(--vault)" fillOpacity={0.25} stroke="var(--vault)" strokeWidth={2} />
          <text y={50} textAnchor="middle" fontSize={11} fill="currentColor" opacity={0.6} className="figures">
            vault
          </text>
        </g>
        <g transform="translate(390 120)">
          <circle className="vd-cooldown" r={34} fill="none" stroke={state === 'cooldown' ? 'var(--danger)' : 'var(--flash)'} strokeWidth={3} strokeLinecap="round" opacity={isLocked ? 1 : 0} transform="rotate(-90)" />
          <rect className="vd-wallet kinetic-svg-origin" x={-22} y={-16} width={44} height={32} rx={6} fill="var(--verified)" fillOpacity={state === 'sent' ? 0.35 : 0.15} stroke="var(--verified)" strokeWidth={2} />
          <text y={52} textAnchor="middle" fontSize={11} fill="currentColor" opacity={0.6} className="figures">
            {isLocked ? `${windowHours} h cooldown` : 'your wallet'}
          </text>
        </g>
        {Array.from({ length: PARTICLES }, (_, i) => (
          <circle key={i} className="vd-particle" r={i % 3 === 0 ? 4 : 2.5} fill={i % 3 === 0 ? 'var(--flash)' : 'var(--vault)'} opacity={0} />
        ))}
      </svg>
      <ul className="relative flex flex-wrap gap-2 border-t border-paper/10 px-4 py-2" aria-label="Test package">
        {grants.map((grant) => (
          <li key={grant.ticker} className={cn('figures rounded-full border px-2.5 py-0.5 text-xs', state === 'sent' ? 'border-verified/60 text-verified' : 'border-paper/20 text-paper/80')}>
            {grant.amount} {grant.ticker}
          </li>
        ))}
      </ul>
    </div>
  );
}
