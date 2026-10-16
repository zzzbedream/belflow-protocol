'use client';

import { MAX_RECIPIENTS_PER_TX, RING_SIZE } from '@belflow/sdk';
import { animate, createTimeline, stagger } from 'animejs';
import { cn } from '@/components/ui/cn';
import { useAnimeScope } from './useAnimeScope';

export type MixerPhase = 'preview' | 'broadcasting' | 'locked' | 'confirmed';

/** Ring size 10: the real input plus 9 decoys. */
const DECOYS = RING_SIZE - 1;
/** Bulletproofs+ allow 16 outputs: 15 recipients plus change. */
const OUTPUTS_PER_TX = MAX_RECIPIENTS_PER_TX;
const MAX_CLUSTERS = 4;
const CLUSTER_W = 220;
const HEIGHT = 240;
const CLUSTER_R = 78;
const DECOY_R = 11;
const LOCK_BLOCKS = 2;

const PHASE_LABEL: Record<MixerPhase, string> = {
  preview: 'ring size 10 · stealth outputs',
  broadcasting: 'mixing with decoys…',
  locked: 'change locked · 2 blocks',
  confirmed: 'settled',
};

interface RingMixerProps {
  /** One label per recipient (a .bdx name, an address or a ticker). */
  labels: string[];
  phase: MixerPhase;
  className?: string;
}

function clusterNodes(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / Math.max(count, 1) - Math.PI / 2;
    const radius = count === 1 ? 0 : CLUSTER_R;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
}

/**
 * Each recipient is a node orbited by its 9 ring decoys; nodes group into one
 * cluster per transaction (15 outputs). The phase drives the motion: idle
 * orbit, fast mixing while broadcasting, a 2-block lock pulse, then settle.
 */
export function RingMixer({ labels, phase, className }: RingMixerProps) {
  const clusters: string[][] = [];
  for (let i = 0; i < labels.length && clusters.length < MAX_CLUSTERS; i += OUTPUTS_PER_TX) clusters.push(labels.slice(i, i + OUTPUTS_PER_TX));
  const width = Math.max(1, clusters.length) * CLUSTER_W;

  const ref = useAnimeScope<HTMLDivElement>(
    ({ ms, isReduced }) => {
      animate('.mix-node', { scale: [0, 1], opacity: [0, 1], duration: ms(700), delay: stagger(35), ease: 'outBack(2)' });
      if (isReduced) return;
      const speed = phase === 'broadcasting' ? 1600 : 9000;
      animate('.mix-orbit', { rotate: '1turn', duration: (_?: unknown, i = 0) => speed + (i % 5) * 400, ease: 'linear', loop: true });
      if (phase === 'broadcasting') {
        animate('.mix-decoy', { r: [1.6, 3, 1.6], duration: 500, delay: stagger(8), loop: true, ease: 'inOutSine' });
      }
      if (phase === 'locked') {
        createTimeline({ loop: true })
          .add('.mix-lock-block', { opacity: [0.25, 1], duration: 600, delay: stagger(600) })
          .add('.mix-lock-ring', { strokeWidth: [2, 6, 2], opacity: [1, 0.4, 1], duration: 900, ease: 'inOutSine' });
      }
      if (phase === 'confirmed') {
        animate('.mix-cluster-ring', { strokeDashoffset: [600, 0], duration: ms(1200), ease: 'outExpo' });
      }
    },
    [labels.length, phase],
  );

  const tone = phase === 'confirmed' ? 'var(--verified)' : phase === 'locked' ? 'var(--flash)' : 'var(--vault)';

  return (
    <div ref={ref} className={cn('relative overflow-hidden rounded-[12px] bg-ink text-paper', className)} data-testid="ring-mixer" data-phase={phase}>
      <div className="kinetic-grid pointer-events-none absolute inset-0 opacity-40" aria-hidden />
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} className="relative block h-auto w-full" role="img" aria-label={`${labels.length} outputs, each hidden among ${DECOYS} decoys, in ${clusters.length} transaction(s)`}>
        {clusters.map((cluster, c) => {
          const cx = CLUSTER_W * c + CLUSTER_W / 2;
          const cy = HEIGHT / 2 - 6;
          return (
            <g key={c} transform={`translate(${cx} ${cy})`}>
              <circle className="mix-cluster-ring mix-lock-ring" r={CLUSTER_R + 22} fill="none" stroke={tone} strokeOpacity={0.55} strokeWidth={2} strokeDasharray={phase === 'confirmed' ? '600' : '3 7'} />
              {clusterNodes(cluster.length).map((node, n) => (
                <g key={n} transform={`translate(${node.x} ${node.y})`}>
                  <g className="mix-orbit" style={{ transformOrigin: '0px 0px' }}>
                    {Array.from({ length: DECOYS }, (_, d) => {
                      const angle = (2 * Math.PI * d) / DECOYS;
                      return <circle key={d} className="mix-decoy" cx={DECOY_R * Math.cos(angle)} cy={DECOY_R * Math.sin(angle)} r={1.6} fill="currentColor" opacity={0.45} />;
                    })}
                  </g>
                  <circle className="mix-node kinetic-svg-origin" r={4.5} fill={tone}>
                    <title>{cluster[n]}</title>
                  </circle>
                </g>
              ))}
              <text y={CLUSTER_R + 44} textAnchor="middle" className="figures" fontSize={11} fill="currentColor" opacity={0.6}>
                tx {c + 1} · {cluster.length}/{OUTPUTS_PER_TX}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="relative flex items-center justify-between gap-3 border-t border-paper/10 px-4 py-2 text-xs">
        <span className="figures uppercase tracking-[0.14em] text-paper/70">{PHASE_LABEL[phase]}</span>
        <span className="flex items-center gap-1" aria-label={`${LOCK_BLOCKS}-block change lock`}>
          {Array.from({ length: LOCK_BLOCKS }, (_, b) => (
            <span key={b} className={cn('mix-lock-block h-2.5 w-5 rounded-[2px]', phase === 'locked' ? 'bg-flash' : phase === 'confirmed' ? 'bg-verified' : 'bg-paper/20')} />
          ))}
          {labels.length > MAX_CLUSTERS * OUTPUTS_PER_TX && <span className="figures ml-2 text-paper/50">+{labels.length - MAX_CLUSTERS * OUTPUTS_PER_TX} more</span>}
        </span>
      </div>
    </div>
  );
}
